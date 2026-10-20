import { existsSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { AstUtils, CstUtils, GrammarUtils, URI } from 'langium';
import type { AstNode, LangiumDocument, LangiumSharedCoreServices } from 'langium';
import type { CodeAction, Diagnostic, Location, Position, Range, TextEdit, WorkspaceEdit } from 'vscode-languageserver';
import { CodeActionKind } from 'vscode-languageserver';
import type { Model, Ontology, OntologyBody, Package } from '../generated/ast.js';
import { isBundleEntry, isImport, isOntology, isOntologyBody, isPackage } from '../generated/ast.js';
import { docLinesAbove } from '../documentation/doc-comment.js';
import { bundleTargets, ownerOf, relativeBundleLocation } from '../publication/workspace.js';
import type { OntologyUnit, PublicationWorkspace } from '../publication/workspace.js';

/**
 * Repairs for how a document says which ontology it belongs to, and the
 * refactoring that grows a one-file ontology into an ontology file and a package file.
 *
 * They read the ownership the publication workspace established, which is
 * the same that reported the diagnostic: a repair that worked out membership
 * again for itself could disagree with the check it answers.
 */

/** The node of the given kind that a diagnostic starts in. */
function nodeAt<T extends AstNode>(document: LangiumDocument, diagnostic: Diagnostic, predicate: (node: unknown) => node is T): T | undefined {
    const root = document.parseResult.value.$cstNode;
    const leaf = root && CstUtils.findLeafNodeAtOffset(root, document.textDocument.offsetAt(diagnostic.range.start));
    return leaf && AstUtils.getContainerOfType(leaf.astNode, predicate);
}

function fix(document: LangiumDocument, diagnostic: Diagnostic, title: string, edits: TextEdit[], batchSafe?: boolean): CodeAction {
    return {
        title, kind: CodeActionKind.QuickFix, diagnostics: [diagnostic], isPreferred: true,
        edit: { changes: { [document.textDocument.uri]: edits } },
        ...batchSafe === undefined ? {} : { data: { batchSafe } }
    };
}

function newline(document: LangiumDocument): string {
    return document.textDocument.getText().includes('\r\n') ? '\r\n' : '\n';
}

/** `import core` → `use core`: the keyword, and nothing else. */
export function useKeyword(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
    const imp = nodeAt(document, diagnostic, isImport);
    const keyword = imp && GrammarUtils.findNodeForKeyword(imp.$cstNode, 'import');
    if (!imp?.package || !keyword) return undefined;
    return fix(document, diagnostic, `Write "use ${imp.package.$refText}"`, [{ range: keyword.range, newText: 'use' }]);
}

/** The ontology a package is a member of by its ontology file's say-so. */
function entryOntology(pkg: Package): Ontology | undefined {
    return ownerOf(pkg)?.declaration;
}

/** `package core` → `package core in shop`, or a wrong owner corrected. */
export function declareOwner(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
    const pkg = nodeAt(document, diagnostic, isPackage);
    const ontology = pkg && entryOntology(pkg);
    if (!pkg || !ontology?.name) return undefined;
    const owner = GrammarUtils.findNodeForProperty(pkg.$cstNode, 'owner');
    if (owner) {
        return fix(document, diagnostic, `Change to "in ${ontology.name}"`, [{ range: owner.range, newText: ontology.name }]);
    }
    const name = GrammarUtils.findNodeForProperty(pkg.$cstNode, 'name');
    if (!name) return undefined;
    return fix(document, diagnostic, `Write "package ${pkg.name} in ${ontology.name}"`,
        [{ range: { start: name.range.end, end: name.range.end }, newText: ` in ${ontology.name}` }]);
}

/** `package core in shop` under `ontology shop` → `package core`. */
export function removeOwner(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
    const pkg = nodeAt(document, diagnostic, isPackage);
    const name = pkg && GrammarUtils.findNodeForProperty(pkg.$cstNode, 'name');
    const owner = pkg && GrammarUtils.findNodeForProperty(pkg.$cstNode, 'owner');
    if (!name || !owner) return undefined;
    return fix(document, diagnostic, `Remove "in ${pkg!.owner}"`, [{ range: { start: name.range.end, end: owner.range.end }, newText: '' }]);
}

/**
 * Adds a package that says it is `in shop` to the bundles of `shop`'s entry.
 * Membership is the author's decision, which `in` has stated and the entry
 * has not; offered, never applied unread.
 */
export function bundleMember(document: LangiumDocument, diagnostic: Diagnostic, workspace: PublicationWorkspace): CodeAction | undefined {
    const pkg = nodeAt(document, diagnostic, isPackage);
    if (!pkg?.name || !pkg.owner || document.uri.scheme !== 'file') return undefined;
    const entries = bundlingEntries(workspace).filter(unit => unit.declaration!.name === pkg.owner);
    const entry = entries.length === 1 ? entries[0] : undefined;
    const existing = entry?.declaration!.bundles.filter(bundle => bundle.name === pkg.name) ?? [];
    // A moved source may leave its selector behind. Repoint that selector
    // rather than adding a second bundle for the same package.
    if (existing.length > 1 || existing.some(bundle => bundleTargets.has(bundle))) return undefined;
    const oldLocation = existing[0] && GrammarUtils.findNodeForProperty(existing[0].$cstNode, 'location');
    const location = entry && relative(dirname(entry.root!.uri.fsPath), document.uri.fsPath).split(sep).join('/');
    const edit = oldLocation && location
        ? { range: oldLocation.range, newText: `<${location}>` }
        : existing.length ? undefined : entry && bundleEdit(entry, pkg.name, document);
    if (!entry || !edit) return undefined;
    return {
        title: `${existing.length ? 'Update bundle for' : 'Bundle'} "${pkg.name}" ${existing.length ? 'in' : 'into'} ontology "${entry.declaration!.name}" (${basename(entry.root!.uri.path)})`,
        kind: CodeActionKind.QuickFix, diagnostics: [diagnostic],
        edit: { changes: { [entry.root!.textDocument.uri]: [edit] } },
        data: { batchSafe: false }
    };
}

/** The authored entries that bundle packages, and so could bundle one more. */
function bundlingEntries(workspace: PublicationWorkspace): OntologyUnit[] {
    return workspace.units.filter(unit => unit.declaration?.$cstNode && unit.root?.uri.scheme === 'file'
        && !workspace.isReadOnly(unit.root) && !unit.packages.some(isOntologyBody));
}

/** The bundle entry for a package of `member`, added after the ontology file's last. */
function bundleEdit(entry: OntologyUnit, name: string, member: LangiumDocument): TextEdit | undefined {
    const ontology = entry.declaration!;
    const ontologyFile = entry.root!;
    const location = relative(dirname(ontologyFile.uri.fsPath), member.uri.fsPath).split(sep).join('/');
    const eol = newline(ontologyFile);
    const line = `${name} from <${location}>`;
    const last = ontology.bundles.at(-1)?.$cstNode ?? (ontology.bundled ? GrammarUtils.findNodeForKeyword(ontology.$cstNode, 'bundles') : undefined);
    const after = last ?? GrammarUtils.findNodeForProperty(ontology.$cstNode, 'name');
    if (!after) return undefined;
    return { range: { start: after.range.end, end: after.range.end }, newText: last ? `${eol}    ${line}` : ` bundles${eol}    ${line}` };
}

/**
 * The repairs for a package of no ontology. Each says which ontology it
 * belongs to, which is the author's to decide, so none is batch-safe:
 *
 * - a document with one package becomes a one-file ontology of that name;
 * - a header written above a document's packages makes them inline packages;
 * - for each authored entry that bundles packages, the package joins it: its
 *   `in` and the ontology file's bundle entry, written together.
 */
export function ontologyForPackage(document: LangiumDocument, diagnostic: Diagnostic, workspace: PublicationWorkspace): CodeAction[] {
    const pkg = nodeAt(document, diagnostic, isPackage);
    const model = document.parseResult.value as Model;
    if (!pkg?.name || pkg.owner || model.ontologies.length) return [];
    const actions: CodeAction[] = [];
    const keyword = GrammarUtils.findNodeForKeyword(pkg.$cstNode, 'package');
    // A `use` would name a package of an ontology that no longer has packages.
    if (keyword && model.packages.length === 1 && !pkg.name.includes('.')
        && ![...model.imports, ...pkg.imports].some(imp => !imp.location)) {
        actions.push(fix(document, diagnostic, `Make "${pkg.name}" a one-file ontology`, [{ range: keyword.range, newText: 'ontology' }], false));
    }
    const first = model.packages[0];
    if (first?.$cstNode) {
        const taken = new Set(model.packages.map(one => one.name));
        const stem = basename(document.uri.path, '.tonto').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+|_+$/g, '') || 'model';
        let name = stem;
        for (let suffix = 2; taken.has(name); suffix++) name = `${stem}${suffix}`;
        const eol = newline(document);
        const at = { line: docLinesAbove(first)[0]?.line ?? first.$cstNode.range.start.line, character: 0 };
        actions.push(fix(document, diagnostic, `Write "ontology ${name}" above ${model.packages.length === 1 ? 'the package' : 'its packages'}`,
            [{ range: { start: at, end: at }, newText: `ontology ${name}${eol}${eol}` }], false));
    }
    const named = GrammarUtils.findNodeForProperty(pkg.$cstNode, 'name');
    if (named && document.uri.scheme === 'file' && !workspace.isReadOnly(document)) {
        for (const entry of bundlingEntries(workspace)) {
            const edit = bundleEdit(entry, pkg.name, document);
            if (!edit || entry.root === document) continue;
            const ontology = entry.declaration!.name;
            actions.push({
                title: `Bundle "${pkg.name}" into ontology "${ontology}" (${basename(entry.root!.uri.path)})`,
                kind: CodeActionKind.QuickFix, diagnostics: [diagnostic],
                edit: { changes: {
                    [document.textDocument.uri]: [{ range: { start: named.range.end, end: named.range.end }, newText: ` in ${ontology}` }],
                    [entry.root!.textDocument.uri]: [edit]
                } },
                data: { batchSafe: false }
            });
        }
    }
    return actions;
}

/** A missing local bundle source can start as an empty member package. */
export function createBundledPackage(document: LangiumDocument, diagnostic: Diagnostic, workspace: PublicationWorkspace,
    fileSystem: LangiumSharedCoreServices['workspace']['FileSystemProvider']): CodeAction | undefined {
    const bundle = nodeAt(document, diagnostic, isBundleEntry);
    const ontology = bundle && AstUtils.getContainerOfType(bundle, isOntology);
    if (!bundle?.name || !ontology?.name || document.uri.scheme !== 'file'
        || !relativeBundleLocation(bundle.location) || workspace.isReadOnly(document)) return undefined;
    const target = URI.parse(new URL(bundle.location.slice(1, -1), document.uri.toString()).href);
    if (target.scheme !== 'file' || existsSync(target.fsPath)) return undefined;
    try {
        fileSystem.readFileSync(target);
        return undefined;
    } catch { /* The source is absent from the configured file system. */ }
    const uri = target.toString();
    const origin = { line: 0, character: 0 };
    return {
        title: `Create package "${bundle.name}" in ${basename(target.fsPath)}`,
        kind: CodeActionKind.QuickFix, diagnostics: [diagnostic],
        edit: { documentChanges: [
            { kind: 'create', uri, options: { overwrite: false, ignoreIfExists: false } },
            { textDocument: { uri, version: null }, edits: [{ range: { start: origin, end: origin },
                newText: `package ${bundle.name} in ${ontology.name}\n` }] }
        ] },
        data: { batchSafe: false }
    };
}

/**
 * Loose declarations beside packages, wrapped in a package of their own. It
 * is named after the ontology, which the author may rename: a name has to be
 * written for the result to parse, and the ontology's says where they came
 * from.
 */
export function wrapLooseDeclarations(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
    const body = nodeAt(document, diagnostic, isOntologyBody);
    const model = document.parseResult.value as Model;
    const ontology = model.ontologies[0];
    if (!body?.$cstNode || !ontology?.name) return undefined;
    const taken = new Set(model.packages.map(pkg => pkg.name));
    let name = ontology.name;
    for (let suffix = 2; taken.has(name); suffix++) name = `${ontology.name}${suffix}`;
    const eol = newline(document);
    const at = startOfBody(body);
    return fix(document, diagnostic, `Put them in "package ${name}"`, [{ range: { start: at, end: at }, newText: `package ${name}${eol}${eol}` }], false);
}

/** Where the body begins, documentation of its first declaration included. */
function startOfBody(body: OntologyBody): Position {
    const first = [...body.imports, ...body.declarations].sort((a, b) => a.$cstNode!.offset - b.$cstNode!.offset)[0];
    const documented = docLinesAbove(first)[0]?.line;
    return { line: documented ?? first.$cstNode!.range.start.line, character: 0 };
}

/**
 * An ontology tag written where it says nothing: its line removed, or, on a
 * package of an ontology whose header does not say it yet, moved there. Where
 * the header already gives another value, the header has the last word and
 * the line is only removed.
 */
export function placeOntologyTag(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
    const at = diagnostic.range.start.line;
    const model = document.parseResult.value as Model;
    const node = AstUtils.streamAllContents(model).find(candidate => docLinesAbove(candidate).some(line => line.line === at));
    const written = node && docLinesAbove(node).find(line => line.line === at);
    const match = written && /^@(namespace|version|license|creator)\s+(.*)$/.exec(written.text.trim());
    if (!match) return [];
    const [, tag, text] = match;
    const remove: TextEdit = { range: { start: { line: at, character: 0 }, end: { line: at + 1, character: 0 } }, newText: '' };
    const header = isPackage(node) ? entryOntology(node) : undefined;
    const keyword = header && GrammarUtils.findNodeForKeyword(header.$cstNode, 'ontology');
    if (!header || !keyword) return [fix(document, diagnostic, `Remove "@${tag}"`, [remove], false)];
    const given = docLinesAbove(header).map(line => /^@(\w+)\s+(.*)$/.exec(line.text.trim())).filter(found => found?.[1] === tag).map(found => found![2]);
    if (given.includes(text) || (tag !== 'creator' && given.length)) {
        const title = given.includes(text) ? `Remove "@${tag}", which the header of "${header.name}" already gives`
            : `Remove "@${tag}"; the header of "${header.name}" gives ${given[0]}`;
        return [fix(document, diagnostic, title, [remove], given.includes(text))];
    }
    const headerDocument = AstUtils.getDocument(header);
    const insert: TextEdit = { range: { start: { line: keyword.range.start.line, character: 0 }, end: { line: keyword.range.start.line, character: 0 } }, newText: `/// @${tag} ${text}${newline(headerDocument)}` };
    const changes: Record<string, TextEdit[]> = { [document.textDocument.uri]: [remove] };
    changes[headerDocument.textDocument.uri] = [...changes[headerDocument.textDocument.uri] ?? [], insert];
    return [
        { title: `Move "@${tag}" to the header of ontology "${header.name}"`, kind: CodeActionKind.QuickFix, diagnostics: [diagnostic], isPreferred: true, edit: { changes }, data: { batchSafe: false } },
        fix(document, diagnostic, `Remove "@${tag}"`, [remove], false)
    ];
}

/**
 * The package whose `in` the offset is on. `in shop` names an ontology by a
 * plain name rather than a reference -- the entry decides membership, so a
 * link resolved from the member would be a second answer -- and the
 * navigation a reference gets is given to it here.
 */
export function ownerAt(document: LangiumDocument, offset: number): Package | undefined {
    const root = document.parseResult.value.$cstNode;
    const leaf = root && CstUtils.findLeafNodeAtOffset(root, offset);
    const pkg = leaf && AstUtils.getContainerOfType(leaf.astNode, isPackage);
    const owner = pkg?.owner && GrammarUtils.findNodeForProperty(pkg.$cstNode, 'owner');
    return owner && owner.offset <= offset && offset <= owner.end ? pkg : undefined;
}

/** The ontologies declared under a name; one, unless the workspace has a clash. */
export function ontologiesNamed(name: string, documents: Iterable<LangiumDocument>): Ontology[] {
    return [...documents].flatMap(document => (document.parseResult.value as Model).ontologies ?? [])
        .filter(ontology => ontology.name === name);
}

/** Where packages say they belong to the named ontology: each `in` naming it. */
export function ownerMentions(name: string, documents: Iterable<LangiumDocument>): Location[] {
    return [...documents].flatMap(document => ((document.parseResult.value as Model).packages ?? [])
        .filter(pkg => pkg.owner === name)
        .flatMap(pkg => {
            const owner = GrammarUtils.findNodeForProperty(pkg.$cstNode, 'owner');
            return owner ? [{ uri: document.uri.toString(), range: owner.range }] : [];
        }));
}

/**
 * Renaming an ontology renames what refers to it by name: the `in` of every
 * package that says it belongs. The ontologies of one workspace have distinct
 * names, so the name is enough to find them.
 */
export function ownerRenames(ontology: Ontology, newName: string, documents: Iterable<LangiumDocument>): Record<string, TextEdit[]> {
    const changes: Record<string, TextEdit[]> = {};
    for (const source of documents) {
        for (const pkg of (source.parseResult.value as Model).packages ?? []) {
            const owner = pkg.owner === ontology.name && GrammarUtils.findNodeForProperty(pkg.$cstNode, 'owner');
            if (owner) (changes[source.textDocument.uri] ??= []).push({ range: owner.range, newText: newName });
        }
    }
    return changes;
}

/**
 * The refactoring of a one-file ontology into an ontology file that bundles one
 * package: offered on the header, since it is the ontology that changes form.
 *
 * Everything after the header moves to a new document beside the entry.
 * Imports above the header stay in the entry and apply to the bundled package.
 * The header, its documentation and its metadata stay: the
 * entry still says what the ontology is, and its namespace with it, so no
 * public name changes.
 */
export function splitOneFileOntology(document: LangiumDocument, range: Range): CodeAction | undefined {
    const ontology = (document.parseResult.value as Model).ontologies[0];
    if (!ontology?.$cstNode) return undefined;
    const documented = docLinesAbove(ontology)[0]?.line ?? ontology.$cstNode.range.start.line;
    if (range.end.line < documented || range.start.line > ontology.$cstNode.range.end.line) return undefined;
    const split = splitEdit(document);
    return split && { title: `Split "${ontology.name}" into an ontology file and package "${split.core}" (${split.core}.tonto)`, kind: CodeActionKind.RefactorRewrite, edit: split.edit };
}

/** The same split, as the two complete files written by CLI and MCP. */
export interface SplitOntologyFiles {
    ontology: string;
    packageName: string;
    ontologyFile: string;
    ontologyText: string;
    packageFile: string;
    packageText: string;
}

export function splitOneFileOntologyFiles(document: LangiumDocument): SplitOntologyFiles | undefined {
    const ontology = (document.parseResult.value as Model).ontologies[0];
    if (!ontology?.name || document.uri.scheme !== 'file') return undefined;
    const split = splitEdit(document);
    if (!split) return undefined;
    return {
        ontology: ontology.name,
        packageName: split.core,
        ontologyFile: document.uri.fsPath,
        ontologyText: split.ontologyText,
        packageFile: URI.parse(split.uri).fsPath,
        packageText: split.packageText
    };
}

/**
 * The edit that splits a one-file ontology: its declarations move to a new
 * package file, `core` (or the first free `coreN`), and the header stays
 * behind, bundling it -- and, when a package is being added at the same time,
 * the bundle entries in `more`. Names in `reserved` are not used for `core`.
 */
function splitEdit(
    document: LangiumDocument, more: readonly string[] = [], reserved: readonly string[] = []
): { edit: WorkspaceEdit; core: string; uri: string; ontologyText: string; packageText: string } | undefined {
    const model = document.parseResult.value as Model;
    const ontology = model.ontologies[0];
    const body = model.packages.find(isOntologyBody);
    if (!ontology?.$cstNode || !ontology.name || !body?.$cstNode || model.ontologies.length > 1 || ontology.bundled
        || model.packages.length > 1 || document.uri.scheme !== 'file') return undefined;
    const header = ontology.$cstNode.range;
    const folder = dirname(document.uri.fsPath);
    const taken = (name: string): boolean => existsSync(join(folder, `${name}.tonto`)) || name === ontology.name || reserved.includes(name);
    let name = 'core';
    for (let suffix = 2; taken(name); suffix++) name = `core${suffix}`;
    const target = URI.file(join(folder, `${name}.tonto`)).toString();
    const text = document.textDocument.getText();
    const eol = newline(document);
    const rest = text.slice(ontology.$cstNode.end).replace(/^[ \t]*\r?\n/, '').replace(/^(\s*\r?\n)+/, '').trimEnd();
    const content = [`package ${name} in ${ontology.name}`, rest].join(eol + eol) + eol;
    const bundles = [`${name} from <${name}.tonto>`, ...more].map(line => `${eol}    ${line}`).join('');
    const ontologyText = text.slice(0, document.textDocument.offsetAt(header.end)) + ` bundles${bundles}${eol}`;
    const edit: WorkspaceEdit = {
        documentChanges: [
            { kind: 'create', uri: target, options: { overwrite: false, ignoreIfExists: false } },
            { textDocument: { uri: target, version: null }, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: content }] },
            { textDocument: { uri: document.textDocument.uri, version: document.textDocument.version }, edits: [{
                range: { start: header.end, end: document.textDocument.positionAt(text.length) },
                newText: ` bundles${bundles}${eol}`
            }] }
        ]
    };
    return { edit, core: name, uri: target, ontologyText, packageText: content };
}

/** An ontology the workspace authors, as the commands that add to one list it. */
export interface AuthoredOntology {
    name: string;
    /** Its ontology file. */
    uri: string;
    /** Whether its declarations follow the header, so that a package needs it split first. */
    oneFile: boolean;
}

/** The ontologies of the workspace that a package can be added to: authored, on disk, writable. */
export function authoredOntologies(workspace: PublicationWorkspace): AuthoredOntology[] {
    return workspace.units
        .filter(unit => unit.declaration && unit.root?.uri.scheme === 'file' && !unit.unbundled && !workspace.isReadOnly(unit.root))
        .map(unit => ({ name: unit.declaration!.name, uri: unit.root!.uri.toString(), oneFile: unit.packages.some(isOntologyBody) }))
        .sort((one, two) => one.name < two.name ? -1 : one.name > two.name ? 1 : 0);
}

const PACKAGE_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/**
 * What adding a package to an ontology writes: a package file, `sales.tonto`
 * in `folder`, starting `package sales in shop`, and its bundle entry in the
 * ontology file -- the two statements a package's membership takes, made
 * together so that neither is missing. A one-file ontology bundles nothing,
 * so it is split first (`splitEdit`), in the same edit. What stops it is
 * said instead: a name that is not a package name or is taken in the
 * ontology, or a file already there.
 */
export function newPackageEdit(
    document: LangiumDocument, name: string, folder: string, workspace: PublicationWorkspace,
    open: (uri: URI) => boolean = () => false
): { edit: WorkspaceEdit; uri: string; split?: string } | { problem: string } {
    const ontology = (document.parseResult.value as Model).ontologies[0];
    const unit = workspace.units.find(candidate => candidate.declaration === ontology);
    if (!ontology?.$cstNode || !unit || document.uri.scheme !== 'file') return { problem: 'This file declares no ontology a package can be added to.' };
    if (!PACKAGE_NAME.test(name)) return { problem: `"${name}" is not a package name: write lower-case words, joined by "." if it has several parts, such as "sales" or "commerce.sales".` };
    if (unit.packages.some(pkg => pkg.name === name)) return { problem: `Ontology "${ontology.name}" already has a package "${name}".` };
    const path = join(folder, `${name.split('.').at(-1)}.tonto`);
    if (existsSync(path) || open(URI.file(path))) return { problem: `${relative(dirname(document.uri.fsPath), path).split(sep).join('/')} already exists.` };
    const uri = URI.file(path).toString();
    const location = relative(dirname(document.uri.fsPath), path).split(sep).join('/');
    const eol = newline(document);
    const created: WorkspaceEdit['documentChanges'] = [
        { kind: 'create', uri, options: { overwrite: false, ignoreIfExists: false } },
        { textDocument: { uri, version: null }, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: `package ${name} in ${ontology.name}${eol}${eol}` }] }
    ];
    const entry = `${name} from <${location}>`;
    if (unit.packages.some(isOntologyBody)) {
        const split = splitEdit(document, [entry], [name]);
        if (!split) return { problem: `Ontology "${ontology.name}" cannot be split to bundle a package.` };
        return { edit: { documentChanges: [...created, ...split.edit.documentChanges!] }, uri, split: split.core };
    }
    const last = ontology.bundles.at(-1)?.$cstNode ?? (ontology.bundled ? GrammarUtils.findNodeForKeyword(ontology.$cstNode, 'bundles') : undefined);
    const after = last ?? GrammarUtils.findNodeForProperty(ontology.$cstNode, 'name');
    if (!after) return { problem: `The header of "${ontology.name}" could not be read.` };
    return { edit: { documentChanges: [...created, { textDocument: { uri: document.textDocument.uri, version: document.textDocument.version }, edits: [{
        range: { start: after.range.end, end: after.range.end }, newText: last ? `${eol}    ${entry}` : ` bundles${eol}    ${entry}`
    }] }] }, uri };
}
