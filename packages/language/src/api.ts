import {
    existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CodeAction, Diagnostic, TextEdit } from 'vscode-languageserver';
import { CodeActionKind } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { isAstNode } from 'langium';
import type { TontoDocumentationProvider } from './documentation/tonto-documentation-provider.js';
import type { LangiumDocument } from 'langium';
import { AstUtils, DocumentState, URI } from 'langium';
import { NodeFileSystem } from 'langium/node';
import { createTontoServices } from './tonto-module.js';
import { claimLines, isBatchSafe } from './lsp/edit-batch.js';
import type { ClassDeclaration, Model, Relation } from './generated/ast.js';
import {
    isClassDeclaration, isDatatype, isEnumeration, isExternalRelation, isGeneralizationSet, isModel, isOntologyBody, isPackage
} from './generated/ast.js';
import { collectAncestors } from './utils/generalizations.js';
import { getRelationSource, isParthood } from './utils/relations.js';
import { classifiesOnly } from './utils/nature-reasoning.js';
import { isUltimateSortal } from './validation/stereotype-model.js';
import { generateGufo } from './gufo.js';
import type { GufoDiagnostic, GufoOptions, GufoResult, GufoSeverity } from './gufo.js';
import { publicationWorkspace, closureOf } from './publication/workspace.js';
import { declaredNamespace } from './utils/namespaces.js';
import type { FetchResult } from './publication/workspace.js';
import { resetDerivedCaches } from './utils/derived-cache.js';
import { canonicalPath } from './utils/paths.js';
import { writeWorkspaceFiles } from './exports.js';
import { splitOneFileOntologyFiles } from './lsp/ontology-actions.js';

/** LSP completion kinds, named rather than numbered, since a reader is reading. */
const KINDS: Record<number, string> = {
    14: 'keyword', 15: 'snippet', 18: 'reference', 20: 'enum member'
};

/**
 * Validation as a library: the same checks and repairs the editor runs, over
 * text or over files.
 *
 * A caller that has a model in hand and no file for it -- something drafting
 * one, rather than editing a repository -- is the common case for everything
 * except the editor, and it is the one the language server cannot serve. The
 * session keeps a workspace open so imports resolve and so the built-in
 * datatypes are parsed once.
 */

const SEVERITY = ['', 'error', 'warning', 'information', 'hint'] as const;

export interface Reported {
    file: string;
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
    severity: string;
    code: string;
    message: string;
    /**
     * The repairs offered.
     *
     * `batchSafe` says whether applying one without reading the diagnostic
     * decides nothing: `--fix` applies those and leaves the rest, which are
     * one click away in an editor instead.
     *
     * `changes` is every file the repair writes to, and they go together or
     * not at all -- renaming a class edits its declaration and each reference
     * to it, wherever those are written. It was one entry per file once, which
     * made a rename look like two repairs with the same title and no way to
     * tell they were one.
     */
    fixes: Array<{
        title: string;
        batchSafe: boolean;
        changes: Array<{ file: string; edits: TextEdit[] }>;
    }>;
}

export interface SessionOptions {
    /** Directories whose `.tonto` files are loaded, so imports resolve. */
    workspace?: string | string[];
    /** The advisory anti-pattern rules, off unless asked for. */
    antiPatterns?: boolean;
    locations?: Record<string, string>;
    publication?: boolean;
}

export interface SplitOntologyResult {
    ontology: string;
    packageName: string;
    ontologyFile: string;
    packageFile: string;
}

/** Every `.tonto` file under the given paths; files are taken as given. */
/**
 * The directory to load as the workspace for a given path.
 *
 * A model is a set of files that import one another by package name, and the
 * checks that read what points *at* a class need all of them: check one file
 * of a model on its own and a relator two directories up is not there to be
 * found. So the root is the highest ancestor still holding `.tonto` files --
 * walked up from the file, stopping at the first directory that holds none,
 * which is the boundary of the model as laid out on disk. A `tonto.json`
 * overrides that walk: the nearest ancestor holding one is the workspace its
 * author configured, whether or not the directories between hold models. A
 * caller that already knows its workspace supplies `boundary`: an unrelated
 * `.tonto` file beside that workspace must not make discovery walk into the
 * parent.
 */
export function workspaceRootOf(path: string, boundary?: string): string {
    let directory = canonicalPath(statSync(path).isDirectory() ? path : dirname(canonicalPath(path)));
    const limit = boundary === undefined ? undefined : canonicalPath(boundary);
    if (limit !== undefined && directory !== limit && !directory.startsWith(`${limit}${sep}`)) {
        throw new Error(`Model path "${path}" is outside workspace boundary "${boundary}".`);
    }
    for (let configured = directory; ; configured = dirname(configured)) {
        if (existsSync(join(configured, 'tonto.json'))) return configured;
        if (configured === limit || dirname(configured) === configured) break;
    }
    for (;;) {
        if (directory === limit) return directory;
        const parent = dirname(directory);
        if (parent === directory || (limit !== undefined && parent !== limit && !parent.startsWith(`${limit}${sep}`))
            || !holdsModels(parent)) {
            return directory;
        }
        directory = parent;
    }
}

/** Whether a directory holds `.tonto` files of its own, ignoring what is below. */
function holdsModels(directory: string): boolean {
    try {
        return readdirSync(directory).some(entry => entry.endsWith('.tonto'));
    } catch {
        return false;
    }
}

export function collectFiles(paths: string[]): string[] {
    const found: string[] = [];
    const walk = (path: string, named: boolean): void => {
        let stats;
        try {
            // Follow paths the caller named, but never follow links discovered
            // while walking a directory: they may leave it or lead back into it.
            stats = named ? statSync(path) : lstatSync(path);
        } catch (error) {
            // A path given on the command line has to be readable, and the
            // caller hears about it. One found while walking need not be:
            // a directory with no permission, or a link to nothing, is not a
            // reason to answer nothing about the files that are there.
            if (named) {
                throw error;
            }
            return;
        }
        if (stats.isSymbolicLink()) return;
        if (stats.isDirectory()) {
            let entries: string[];
            try {
                entries = readdirSync(path);
            } catch (error) {
                if (named) {
                    throw error;
                }
                return;
            }
            for (const entry of entries) {
                if (entry !== 'node_modules' && !entry.startsWith('.')) {
                    walk(join(path, entry), false);
                }
            }
        } else if (path.endsWith('.tonto')) {
            found.push(canonicalPath(path));
        }
    };
    paths.forEach(path => walk(path, true));
    return [...new Set(found)].sort();
}

/**
 * Whether this repair may be written without anyone choosing it.
 *
 * Mechanical by its own account, or named: `--fix=lone-phase` is somebody
 * saying which decision they want made, and a rule asked for by name is not
 * being applied behind their back.
 */
function mayApply(only: ReadonlySet<string> | undefined, diagnostic: Diagnostic, action: CodeAction): boolean {
    return isBatchSafe(action) || only?.has(String(diagnostic.code)) === true;
}

/**
 * Whether a diagnostic is one the caller asked to repair.
 *
 * A repair is a change to someone's model, and a caller fixing one thing
 * rarely means "and everything else you can reach": `--fix legacy-text-block`
 * converts the documentation and leaves the modeling decisions alone.
 */
function isWanted(only: ReadonlySet<string> | undefined, diagnostic: Diagnostic): boolean {
    return only === undefined || only.has(String(diagnostic.code ?? ''));
}

/** The one document a repair writes into, when it is one this run may write. */
function targets(action: CodeAction, known: ReadonlyMap<string, LangiumDocument>): Array<[string, TextEdit[]]> {
    const changes = Object.entries(action.edit?.changes ?? {}).filter(([, edits]) => edits.length > 0);
    // A repair reported on one file may be an edit to another -- a
    // generalization set restereotyping a class declared elsewhere. It is
    // applied where it belongs, and only where this run is already looking.
    return changes.length > 0 && changes.every(([uri]) => known.has(uri)) ? changes : [];
}

/** Applies edits back to front, skipping any that overlap one already made. */
export function applyEdits(text: string, document: LangiumDocument, edits: TextEdit[]): string {
    const ordered = edits
        .map(edit => ({
            start: document.textDocument.offsetAt(edit.range.start),
            end: document.textDocument.offsetAt(edit.range.end),
            newText: edit.newText
        }))
        .sort((a, b) => b.start - a.start);
    let out = text;
    let barrier = Number.MAX_SAFE_INTEGER;
    for (const edit of ordered) {
        if (edit.end > barrier) {
            continue;
        }
        out = out.slice(0, edit.start) + edit.newText + out.slice(edit.end);
        barrier = edit.start;
    }
    return out;
}

/** One repair, chosen by name, and what applying it left behind. */
/**
 * The code a diagnostic is reported under. Langium leaves `code` unset on what
 * it reports itself and says in `data` whether the parser, the lexer or the
 * linker found it; reading that keeps a syntax error from being reported as an
 * unresolved name.
 */
function diagnosticCode(diagnostic: Diagnostic): string {
    return String(diagnostic.code ?? (diagnostic.data as { code?: string } | undefined)?.code ?? 'linking-error');
}

/** An ontology a workspace authors, as `ontologies()` lists it. */
export interface WorkspaceOntology {
    /** Its authoring name, such as `shop`. */
    name: string;
    /** Its ontology file: the one holding its header, which may bundle packages. */
    file: string;
    /** Every document it is written in, the entry first. */
    files: string[];
    /** The namespace its header declares, if it declares one. */
    namespace?: string;
    /** The errors in it and in what it imports, any one of which stops its export. */
    errors: number;
}

export interface Applied {
    text: string;
    applied: string;
    left: Reported[];
}

/** What an edit did to a model, in the terms a reviewer asks about. */
export interface Difference {
    introduced: Reported[];
    resolved: Reported[];
    left: Reported[];
}

/** What a model declares, read for review rather than for text. */
export interface Digest {
    /**
     * Whether the model parses and validates, and how badly not.
     *
     * A digest of a model with errors read like a digest of a model without
     * them: the tree is partial, the counts are of what survived, and nothing
     * said so. A reviewer reading this needs to know it is reading wreckage.
     */
    errors: number;
    warnings: number;
    packages: string[];
    stereotypes: Record<string, number>;
    ultimateSortals: Array<{ name: string; stereotype: string; under: string[] }>;
    relators: Array<{ name: string; mediates: string[] }>;
    relations: Record<string, number>;
    gensets: Array<{ name: string; general?: string; specifics: string[]; disjoint: boolean; complete: boolean }>;
    values: string[];
    /** What the model leaves unsaid -- the hints, which are the review notes. */
    unsaid: Array<{ code: string; message: string }>;
}

/** A proposal at a position: what may be written there, and what it means. */
export interface Proposal {
    label: string;
    kind?: string;
    detail?: string;
    insertText?: string;
    additionalTextEdits?: TextEdit[];
}

export class TontoSession {

    private readonly services: ReturnType<typeof createTontoServices>;
    private ready: Promise<void> | undefined;
    private scratch = 0;

    constructor(private readonly options: SessionOptions = {}) {
        // Always the real one. This file reads and writes files itself, so
        // there is no browser to keep out; giving a session with no configured
        // workspace an empty file system only meant that `fixFiles` wrote a
        // repair and then threw on re-reading what it had just written.
        this.services = createTontoServices(NodeFileSystem);
        publicationWorkspace(this.services.shared).configure(this.folders(), options);
        if (options.antiPatterns) {
            this.services.shared.workspace.ConfigurationProvider.updateConfiguration(
                { settings: { tonto: { antiPatterns: options.antiPatterns } } });
        }
    }

    /**
     * One question at a time.
     *
     * Every call here works in a document store the whole session shares, and
     * a draft joins the workspace for as long as it takes to answer. Two
     * answered at once are two drafts of the same package in the store
     * together, and each was reported as a duplicate of the other -- an error
     * about a file that exists for a few milliseconds, in a model that has
     * nothing wrong with it. A server holding one session and a client that
     * asks two things at once is the ordinary case, so the calls queue.
     */
    private queue: Promise<unknown> = Promise.resolve();

    private oneAtATime<T>(work: () => Promise<T>): Promise<T> {
        const next = this.queue.then(work, work);
        // The queue must survive a failed call, and must not be the failure.
        this.queue = next.then(() => undefined, () => undefined);
        return next;
    }

    /**
     * Documents the session holds in memory, beside whatever is on disk.
     *
     * A model being drafted is several files before it is finished, and until
     * they exist on disk nothing resolves across them: `use parties` in the
     * draft reaches a package no one has written down. A caller holding a
     * session -- a server, an agent's loop -- can put the neighbors here and
     * have every later question answered against them.
     *
     * They are ordinary workspace documents while they are held: exported,
     * indexed, and reported on if asked about. The scratch draft each call
     * makes still comes and goes; these stay until removed.
     */
    private readonly held = new Map<string, string>();

    async hold(name: string, source: string): Promise<Reported[]> {
        // A name is a file name here, and an empty one leaves `.tonto` with
        // nothing in front of it -- which Langium reads as a file with no
        // extension and no language, and answers with an error about its
        // service registry rather than about the name.
        if (name.trim() === '') {
            throw new Error('A held file needs a name.');
        }
        return this.oneAtATime(async () => {
            await this.open();
            const uri = this.heldUri(name);
            const document = this.services.shared.workspace.LangiumDocumentFactory.fromString(source, uri);
            // Replace rather than add: a second draft of one name is an edit
            // to it, and adding it twice leaves the first in the index.
            await this.forget(uri);
            this.services.shared.workspace.LangiumDocuments.addDocument(document);
            this.held.set(name, source);
            await this.rebuildHeld();
            // Reported from the held document itself -- the one the rebuild
            // left in the store. Validating the same text as a draft would put
            // two copies of its package there, and answer that each is a
            // duplicate of the other.
            const built = this.services.shared.workspace.LangiumDocuments.getDocument(uri) ?? document;
            return this.report([built], name);
        });
    }

    async release(name?: string): Promise<boolean> {
        return this.oneAtATime(async () => {
            const going = name === undefined ? [...this.held.keys()] : [name];
            // Whether anything went. Releasing a name never held said
            // "released" and meant nothing, which reads as a typo repaired.
            const held = going.filter(one => this.held.has(one));
            for (const one of held) {
                await this.forget(this.heldUri(one));
                this.held.delete(one);
            }
            await this.rebuildHeld();
            return held.length > 0;
        });
    }

    /**
     * Every held document, relinked and revalidated together.
     *
     * Building only the one just held made the order matter: hold `Billing`,
     * which imports a `Parties` nobody has written yet, and its references
     * fail; hold `Parties` after it, and nothing tells `Billing` to look
     * again. Langium rebuilds the documents that *reference* a changed one,
     * and a reference that failed to resolve is not one -- so the dependent
     * kept its failed links, and every later question about it was answered
     * from them.
     *
     * Passing all of them as changed relinks each. They are a draft's
     * neighbors, so there are a handful; the workspace on disk is not
     * touched.
     */
    private async rebuildHeld(): Promise<void> {
        if (this.held.size === 0) {
            return;
        }
        // Reset rather than re-read: `DocumentBuilder.update` goes to disk for
        // the files it is told changed, and a held document has none. Back to
        // `Parsed`, which keeps the tree and drops everything derived from it
        // -- exports, scopes, links, diagnostics -- so building them together
        // links every one against the whole set. `Changed` would be one state
        // too far: it means the text itself is stale, and the builder goes
        // looking for the file to read it again.
        const documents: LangiumDocument[] = [];
        for (const name of this.held.keys()) {
            const document = this.services.shared.workspace.LangiumDocuments
                .getDocument(this.heldUri(name));
            if (document) {
                this.services.shared.workspace.DocumentBuilder.resetToState(document, DocumentState.Parsed);
                documents.push(document);
            }
        }
        await this.services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
    }

    /** What is held, and how long each is -- enough to see what a session has. */
    holding(): Array<{ name: string; lines: number }> {
        return [...this.held].map(([name, source]) => ({ name, lines: source.split('\n').length }));
    }

    /** Held drafts whose ontology or package identity is already saved. */
    async heldSavedCollisions(): Promise<Array<{ name: string; file: string }>> {
        return this.oneAtATime(async () => {
            await this.open();
            await this.syncWorkspace(new Set());
            return [...this.held].flatMap(([name, source]) => {
                const saved = this.standsFor(source);
                return saved ? [{ name, file: saved.fsPath }] : [];
            });
        });
    }

    /**
     * A file name for a held document that no two names share.
     *
     * Replacing everything unsafe with `_` gave `a/b` and `a?b` one URI, so
     * holding both left one document under two names and releasing either
     * took the other with it. Each unsafe character is written as its code
     * instead -- `_` included, or the escape would collide with a literal
     * one.
     *
     * A `/` is kept, as a folder: an ontology file bundles `sales/orders.tonto`, and
     * the member held as `sales/orders` is that file. A segment that would
     * move between folders, `.` or `..`, is written as its codes.
     */
    private heldUri(name: string): URI {
        const escape = (character: string): string => `_${character.codePointAt(0)!.toString(16)}_`;
        const encoded = name.split('/')
            .map(segment => segment === '.' || segment === '..' ? [...segment].map(escape).join('')
                : [...segment].map(character => /[A-Za-z0-9.-]/.test(character) ? character : escape(character)).join(''))
            .join('/');
        return URI.parse(`file:///held/${encoded}.tonto`);
    }

    /** Loads the workspace once, whatever asks for it first. */
    private async open(): Promise<void> {
        const folders = this.folders();
        this.ready ??= this.services.shared.workspace.WorkspaceManager.initializeWorkspace(
            folders.map(folder => ({ name: folder, uri: URI.file(folder).toString() })));
        return this.ready;
    }

    /** The workspace directories, resolved. */
    private folders(): string[] {
        return this.options.workspace === undefined ? []
            : [this.options.workspace].flat().map(folder => canonicalPath(folder));
    }

    private draftUri(name: string): URI {
        return URI.file(resolve(this.folders()[0] ?? '/', `${name}-${++this.scratch}.tonto`));
    }

    /**
     * Puts unsaved text into the workspace, and says how to take it out again.
     *
     * Text is usually a file of the workspace as it is being edited, and was
     * added beside that file: `ontology hiring` twice, and an
     * `ontology-name-clash` with itself -- an error in every draft of every
     * saved ontology file, which a model as it stands does not have. So text
     * that declares the same ontology, or the same package in the same
     * ontology, as exactly one saved file takes that file's place for as long
     * as it is asked about: its siblings link to it rather than to the saved
     * text, and its locations resolve from the file's folder. The file is
     * read back from disk afterward. Text that is no saved file -- a new
     * package, a model with no header -- joins under a scratch name, as
     * before.
     */
    private async enter(source: string, name: string): Promise<{ document: LangiumDocument; leave(): Promise<void> }> {
        await this.open();
        await this.syncWorkspace(new Set());
        const workspace = this.services.shared.workspace;
        const saved = this.standsFor(source);
        if (!saved || !workspace.TextDocuments) {
            const uri = this.draftUri(name);
            const document = workspace.LangiumDocumentFactory.fromString(source, uri);
            workspace.LangiumDocuments.addDocument(document);
            return { document, leave: () => this.forget(uri) };
        }
        const texts = workspace.TextDocuments;
        texts.set(TextDocument.create(saved.toString(), 'tonto', 0, source));
        await workspace.DocumentBuilder.update([saved], []);
        return {
            document: workspace.LangiumDocuments.getDocument(saved)!,
            leave: async () => {
                texts.delete(saved);
                await workspace.DocumentBuilder.update([saved], []);
            }
        };
    }

    /** The one saved file the text is a version of, by the ontology or package it declares. */
    private standsFor(source: string): URI | undefined {
        const identity = (model: Model): string | undefined => {
            const ontology = model.ontologies[0]?.name;
            if (ontology) return `ontology ${ontology}`;
            const pkg = model.packages.find(one => isPackage(one) && one.name);
            return pkg && isPackage(pkg) ? `package ${pkg.name} in ${pkg.owner ?? ''}` : undefined;
        };
        const wanted = identity(this.services.Tonto.parser.LangiumParser.parse<Model>(source).value);
        if (!wanted) return undefined;
        const publication = publicationWorkspace(this.services.shared);
        const matches = this.services.shared.workspace.LangiumDocuments.all
            .filter(document => document.uri.scheme === 'file' && existsSync(document.uri.fsPath)
                && !publication.isReadOnly(document)
                && identity(document.parseResult.value as Model) === wanted)
            .toArray();
        return matches.length === 1 ? matches[0].uri : undefined;
    }

    /**
     * Validates a model held as text. It joins the workspace for as long as it
     * takes to answer, so its imports resolve, and leaves no trace after --
     * two drafts of the same package must not collide with each other.
     */
    async validateText(source: string, name = 'draft'): Promise<Reported[]> {
        return this.oneAtATime(() => this.readText(source, name));
    }

    private async readText(source: string, name: string): Promise<Reported[]> {
        const { document, leave } = await this.enter(source, name);
        try {
            await this.services.shared.workspace.DocumentBuilder.build([document], { validation: true });
            const selected = publicationWorkspace(this.services.shared).selected([document]);
            return await this.report(selected.documents, name,
                new Set([...selected.units].flatMap(unit => [...closureOf(unit)].map(unit => unit.id))));
        } finally {
            await leave();
        }
    }

    /**
     * Removes a scratch document from the index as well as from the document
     * store. Dropping it from the store alone leaves its exported symbols
     * behind, and the next draft of the same package is then reported as a
     * duplicate of a document that no longer exists.
     */
    private async forget(uri: URI): Promise<void> {
        await this.services.shared.workspace.DocumentBuilder.update([], [uri]);
    }

    /** Validates files on disk, which is what the command line does. */
    async validateFiles(paths: string[]): Promise<Reported[]> {
        return this.oneAtATime(() => this.readFiles(paths));
    }

    /** Split a saved one-file ontology into its ontology file and package file. */
    async splitOntologyFile(path: string): Promise<SplitOntologyResult> {
        return this.oneAtATime(async () => {
            await this.open();
            const file = canonicalPath(path);
            const root = this.folders().find(folder => {
                const fromRoot = relative(folder, file);
                return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
            });
            if (!root) throw new Error(`The ontology file "${path}" is outside the configured workspace.`);
            await this.syncWorkspace(new Set([file]));
            const document = this.documents(new Set([file]))[0];
            if (!document) throw new Error(`Could not read ontology file "${path}".`);
            const split = splitOneFileOntologyFiles(document);
            if (!split) throw new Error(`"${path}" is not a saved one-file ontology that can be split.`);
            writeWorkspaceFiles(root, [
                { path: relative(root, split.packageFile), content: split.packageText, createOnly: true },
                { path: relative(root, split.ontologyFile), content: split.ontologyText, mustExist: true }
            ]);
            await this.services.shared.workspace.DocumentBuilder.update([
                URI.file(split.ontologyFile), URI.file(split.packageFile)
            ], []);
            return {
                ontology: split.ontology,
                packageName: split.packageName,
                ontologyFile: split.ontologyFile,
                packageFile: split.packageFile
            };
        });
    }

    /**
     * The ontologies the workspace authors, which an export can be asked for:
     * each declared by an `ontology` header in a file of the workspace.
     * Dependencies are someone else's, and unbundled packages cannot be published, so
     * neither is listed. Each says what would stop its export.
     */
    async ontologies(): Promise<WorkspaceOntology[]> {
        return this.oneAtATime(async () => {
            await this.open();
            const wanted = new Set(this.folders().flatMap(folder => collectFiles([folder])));
            await this.syncWorkspace(wanted);
            await this.services.shared.workspace.DocumentBuilder.build(this.documents(wanted), { validation: true });
            const workspace = publicationWorkspace(this.services.shared);
            return workspace.units
                .filter(unit => unit.declaration && unit.root?.uri.scheme === 'file' && !unit.unbundled
                    && wanted.has(unit.root.uri.fsPath) && !workspace.isReadOnly(unit.root))
                .map(unit => {
                    const closure = new Set([...closureOf(unit)].map(one => one.id));
                    const { documents } = workspace.selected([unit.root!]);
                    // Counted, not reported: what stops an export is any error
                    // its closure has, and the repairs for each are not asked.
                    const errors = documents.flatMap(document => document.diagnostics ?? []).filter(diagnostic => {
                        const ontology = (diagnostic.data as { ontology?: string } | undefined)?.ontology;
                        return diagnostic.severity === 1 && (!ontology || closure.has(ontology));
                    }).length;
                    const files = [...new Set([unit.root!, ...unit.packages.map(pkg => AstUtils.getDocument(pkg))]
                        .map(document => document.uri.fsPath))];
                    return { name: unit.declaration!.name, file: unit.root!.uri.fsPath, files,
                        namespace: declaredNamespace(unit.declaration!), errors };
                })
                .sort((one, two) => one.name.localeCompare(two.name));
        });
    }

    /** Imported ontology locations replaced by workspace mappings for these files. */
    async substitutedImports(paths: string[]): Promise<string[]> {
        return this.oneAtATime(async () => {
            await this.open();
            const wanted = new Set(collectFiles(paths));
            await this.syncWorkspace(wanted);
            const primary = this.documents(wanted);
            await this.services.shared.workspace.DocumentBuilder.build(primary, { validation: false });
            const publication = publicationWorkspace(this.services.shared);
            return publication.substitutedImports(publication.selected(primary).units);
        });
    }

    /** Explicit, atomic retrieval; validation and export themselves never fetch. */
    async fetch(paths: string[], options: { refresh?: boolean } = {}): Promise<FetchResult> {
        return this.oneAtATime(async () => {
            await this.open();
            return publicationWorkspace(this.services.shared).fetch(collectFiles(paths), options.refresh);
        });
    }

    /** Exports a checked draft and every configured/held file in its model. */
    async gufoText(source: string, options: GufoOptions = {}, name = 'draft'): Promise<GufoResult> {
        return this.oneAtATime(async () => {
            const { document, leave } = await this.enter(source, name);
            try {
                const documents = this.generationDocuments([document]);
                publicationWorkspace(this.services.shared).supplyNamespace(options.namespaceIri, [document]);
                await this.services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
                const result = await this.gufoFrom([document], options, new Map([[document.uri.fsPath, name]]));
                // Unsaved text has no file beside which its export could go.
                const unsaved = document.uri.fsPath;
                return { ...result, files: result.files.map(file => file.source === unsaved ? { ...file, source: undefined } : file) };
            } finally {
                publicationWorkspace(this.services.shared).supplyNamespace(undefined);
                await leave();
            }
        });
    }

    /** Exports checked files and the model loaded beside them. */
    async gufoFiles(paths: string[], options: GufoOptions = {}): Promise<GufoResult> {
        return this.oneAtATime(async () => {
            await this.open();
            const wanted = new Set(collectFiles(paths));
            await this.syncWorkspace(wanted);
            const primary = this.documents(wanted);
            const documents = this.generationDocuments(primary);
            publicationWorkspace(this.services.shared).supplyNamespace(options.namespaceIri, primary);
            try {
                await this.services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
                return await this.gufoFrom(primary, options);
            } finally {
                publicationWorkspace(this.services.shared).supplyNamespace(undefined);
            }
        });
    }

    private generationDocuments(primary: LangiumDocument[]): LangiumDocument[] {
        const selected = new Map(primary.map(document => [document.uri.toString(), document]));
        const folders = this.folders();
        for (const document of this.services.shared.workspace.LangiumDocuments.all) {
            if (!isModel(document.parseResult.value)) continue;
            const path = document.uri.fsPath;
            const configured = document.uri.scheme === 'file'
                && folders.some(folder => path === folder || path.startsWith(`${folder}${sep}`));
            if (configured || this.knownAs(document.uri.toString()) !== undefined) {
                selected.set(document.uri.toString(), document);
            }
        }
        return [...selected.values()].sort((one, two) => {
            const first = one.uri.toString();
            const second = two.uri.toString();
            return first < second ? -1 : first > second ? 1 : 0;
        });
    }

    private async gufoFrom(
        documents: LangiumDocument[], options: GufoOptions, names = new Map<string, string>()
    ): Promise<GufoResult> {
        const selected = publicationWorkspace(this.services.shared).selected(documents);
        documents = selected.documents;
        const reported = await this.report(documents, undefined, new Set([...selected.units].flatMap(unit => [...closureOf(unit)].map(unit => unit.id))));
        if (reported.some(entry => entry.severity === 'error')) {
            const converted = reported.map(entry => ({
                ...entry,
                file: names.get(entry.file) ?? entry.file,
                severity: entry.severity as GufoSeverity,
                fixes: [] as []
            }));
            const first = converted.find(entry => entry.severity === 'error');
            const stopped: GufoDiagnostic = {
                file: first?.file ?? '', line: first?.line ?? 1, column: first?.column ?? 1,
                endLine: first?.endLine ?? 1, endColumn: first?.endColumn ?? 1,
                severity: 'error', code: 'gufo-model-has-errors',
                message: 'The tonto model has errors; no ontology was written.', fixes: []
            };
            return { turtle: '', files: [], diagnostics: [stopped, ...converted] };
        }
        const documentation = this.services.Tonto.documentation.DocumentationProvider as TontoDocumentationProvider;
        resetDerivedCaches();
        const generated = generateGufo(
            documents.map(document => document.parseResult.value).filter(isModel) as Model[],
            { ...options, selectedOntologies: selected.units,
                ownedPackages: new Set([...selected.units].flatMap(unit => [...closureOf(unit)].flatMap(unit => unit.packages))),
                documentation: node => documentation.getFromComments(node) });
        generated.diagnostics = generated.diagnostics.map(entry => ({
            ...entry,
            file: names.get(entry.file) ?? entry.file
        }));
        generated.publicationVerified = this.options.publication === true && !generated.diagnostics.some(entry => entry.severity === 'error');
        return generated;
    }

    private async readFiles(paths: string[]): Promise<Reported[]> {
        await this.open();
        const wanted = new Set(collectFiles(paths));
        await this.syncWorkspace(wanted);
        const documents = this.documents(wanted);
        await this.services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
        const selected = publicationWorkspace(this.services.shared).selected(documents);
        return this.report(selected.documents, undefined, new Set([...selected.units].flatMap(unit => [...closureOf(unit)].map(unit => unit.id))));
    }

    /**
     * Brings the session's whole view of the workspace in line with the disk.
     *
     * A session outlives the answer it gave. Asked twice with an edit in
     * between -- a server, an agent's loop, anything holding one open -- it
     * answered the second time about the text it had read the first time.
     * Re-reading the files asked about was not enough: half the checks read
     * what points *at* a class, so a mediation written in a sibling file
     * changes the answer about a role without that role's file changing at
     * all. Whatever the workspace holds is what the question is about, so the
     * whole of it is checked: files edited, files that have appeared, files
     * that have gone.
     *
     * `mtime` first and contents only where that differs, so asking again
     * about an unchanged workspace costs a stat per file.
     */
    private async syncWorkspace(wanted: Set<string>): Promise<void> {
        const folders = this.folders();
        const onDisk = new Set([...folders.flatMap(folder => collectFiles([folder])), ...wanted]);
        const mine = (path: string): boolean =>
            onDisk.has(path) || folders.some(folder => path.startsWith(`${folder}${sep}`));

        const changed: URI[] = [];
        const deleted: URI[] = [];
        const loaded = new Set<string>();
        for (const document of this.services.shared.workspace.LangiumDocuments.all) {
            const path = document.uri.fsPath;
            // A draft joins the store under a `file:` URI of its own and is
            // backed by nothing; the built-in datatypes are not `file:` at
            // all. Neither is the workspace's to reconcile.
            if (document.uri.scheme !== 'file' || !mine(path)) {
                continue;
            }
            loaded.add(path);
            if (!onDisk.has(path)) {
                deleted.push(document.uri);
            } else if (this.differs(document)) {
                changed.push(document.uri);
            }
        }
        for (const path of onDisk) {
            if (!loaded.has(path)) {
                // A file that has appeared since the workspace was read.
                changed.push(URI.file(path));
            }
        }
        if (changed.length > 0 || deleted.length > 0) {
            await this.services.shared.workspace.DocumentBuilder.update(changed, deleted);
        }
    }

    /** Whether what is on disk is no longer what was parsed. */
    private differs(document: LangiumDocument): boolean {
        const path = document.uri.fsPath;
        try {
            // Size as well as time, both off the one stat. An edit that
            // leaves the timestamp alone is not exotic: `cp -p`, `rsync
            // --times` and `tar -x` all restore it, and a filesystem whose
            // mtime is coarser than the gap between two writes reports the
            // same instant for both. On the time alone such a file was never
            // re-read, and the session went on answering about text that was
            // no longer there.
            const { mtimeMs, size } = statSync(path);
            const stamp = `${mtimeMs}:${size}`;
            if (this.stamped.get(path) === stamp) {
                return false;
            }
            this.stamped.set(path, stamp);
            return readFileSync(path, 'utf8') !== document.textDocument.getText();
        } catch {
            // Unreadable now: leave it as parsed rather than guess.
            return false;
        }
    }

    /** What each file looked like when last read, so an unchanged one is not. */
    private readonly stamped = new Map<string, string>();

    /**
     * The text with every unambiguous repair applied. Where a rule offers a
     * choice, nothing is written: picking one would be guessing, and the
     * choice belongs to whoever asked.
     */
    async fixText(
        source: string, name = 'draft', only?: ReadonlySet<string>
    ): Promise<{ text: string; applied: string[]; left: Reported[] }> {
        return this.oneAtATime(() => this.repairText(source, name, only));
    }

    private async repairText(
        source: string, name: string, only?: ReadonlySet<string>
    ): Promise<{ text: string; applied: string[]; left: Reported[] }> {
        let text = source;
        const applied: string[] = [];
        for (let round = 0; round < 20; round++) {
            const { document, leave } = await this.enter(text, name);
            let next = text;
            try {
                await this.services.shared.workspace.DocumentBuilder.build([document], { validation: true });
                const edits: TextEdit[] = [];
                const taken = new Map<string, Set<number>>();
                // The draft and nothing else: a repair to a workspace file is
                // not this call's to make, and applying it here would write
                // one file's coordinates into the text being repaired.
                const known = new Map([[document.textDocument.uri, document]]);
                for (const diagnostic of document.diagnostics ?? []) {
                    if (!isWanted(only, diagnostic)) {
                        continue;
                    }
                    const actions = await this.actions(document, diagnostic);
                    const repair = actions.length === 1 && mayApply(only, diagnostic, actions[0])
                        ? targets(actions[0], known)
                        : [];
                    if (repair.length > 0 && claimLines(taken, repair)) {
                        edits.push(...repair.flatMap(([, written]) => written));
                        applied.push(actions[0].title);
                    }
                }
                next = edits.length > 0 ? applyEdits(text, document, edits) : text;
            } finally {
                await leave();
            }
            if (next === text) {
                break;
            }
            text = next;
        }
        return { text, applied, left: await this.readText(text, name) };
    }

    /**
     * Repairs files in place, in rounds: a repair may expose another, and the
     * documents are rebuilt between rounds so the next one sees the new text.
     */
    async fixFiles(paths: string[], only?: ReadonlySet<string>): Promise<string[]> {
        return this.oneAtATime(() => this.repairFiles(paths, only));
    }

    private async repairFiles(paths: string[], only?: ReadonlySet<string>): Promise<string[]> {
        await this.open();
        const wanted = new Set(collectFiles(paths));
        const applied: string[] = [];
        for (let round = 0; round < 20; round++) {
            await this.syncWorkspace(wanted);
            const documents = this.documents(wanted);
            await this.services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
            const known = new Map(documents.map(document => [document.textDocument.uri, document]));
            const edits = new Map<string, TextEdit[]>();
            const titles: string[] = [];
            const taken = new Map<string, Set<number>>();
            for (const document of documents) {
                for (const diagnostic of document.diagnostics ?? []) {
                    if (!isWanted(only, diagnostic)) {
                        continue;
                    }
                    const actions = await this.actions(document, diagnostic);
                    const repair = actions.length === 1 && mayApply(only, diagnostic, actions[0])
                        ? targets(actions[0], known)
                        : [];
                    if (repair.length > 0 && claimLines(taken, repair)) {
                        for (const [uri, written] of repair) {
                            edits.set(uri, [...edits.get(uri) ?? [], ...written]);
                        }
                        titles.push(actions[0].title);
                    }
                }
            }
            let changed = false;
            for (const [uri, written] of edits) {
                const document = known.get(uri) as LangiumDocument;
                const before = document.textDocument.getText();
                const after = applyEdits(before, document, written);
                if (after !== before) {
                    writeFileSync(document.uri.fsPath, after);
                    changed = true;
                }
            }
            if (!changed) {
                return applied;
            }
            applied.push(...titles);
            await this.services.shared.workspace.DocumentBuilder.update(
                this.documents(wanted).map(document => document.uri), []);
        }
        return applied;
    }

    /**
     * One repair, chosen by name.
     *
     * `fixText` applies what a rule forces and leaves what it does not, which
     * is right for a batch and useless for a caller that has read the
     * diagnostic and decided. A rule with two readings -- drop the flag or
     * widen the bound, move the multiplicity or drop the word -- offers both
     * and applies neither, so anything wanting the second one had to apply
     * the edits itself: offsets, reverse order, overlaps. That is where an
     * agent corrupts a file.
     *
     * The repair is named by its code and, where the rule offers more than
     * one, by its title. A line and column distinguish repeated occurrences.
     * Only edits to the draft itself are applied: a repair reaching into
     * another file is refused here rather than half-applied.
     */
    async applyFix(source: string, code: string, title?: string, line?: number, name?: string): Promise<Applied>;
    async applyFix(
        source: string, code: string, title: string | undefined, line: number | undefined,
        column: number | undefined, name?: string
    ): Promise<Applied>;
    async applyFix(
        source: string, code: string, title?: string, line?: number,
        columnOrName?: number | string, name = 'draft'
    ): Promise<Applied> {
        // `name` was the fifth argument before positions included a column.
        // Keep that call valid while a numeric fifth argument names a column;
        // callers needing both use the sixth argument for the document name.
        const column = typeof columnOrName === 'number' ? columnOrName : undefined;
        const documentName = typeof columnOrName === 'string' ? columnOrName : name;
        return this.oneAtATime(async () => {
            const before = await this.readText(source, documentName);
            const all = before.filter(one => one.code === code);
            if (all.length === 0) {
                throw new Error(`Nothing reports "${code}" in this model.`);
            }
            if (column !== undefined && line === undefined) {
                throw new Error('A repair column needs its line too.');
            }
            // One line may hold two occurrences -- the two bounds of one
            // relation, for example -- and each has repairs of its own. A line
            // picks the common case; a column distinguishes two on that line.
            // Without enough position, a repeated code is as much a choice as
            // a rule offering two readings, and is refused rather than
            // answered with whichever came first.
            const reported = all.filter(one =>
                (line === undefined || one.line === line)
                && (column === undefined || one.column === column));
            if (reported.length === 0) {
                const position = column === undefined ? `line ${line}` : `${line}:${column}`;
                throw new Error(`"${code}" is not reported at ${position}. It is reported at ${
                    all.map(one => `${one.line}:${one.column}`).join(', ')}.`);
            }
            const offered = reported.flatMap(one => one.fixes.map(fix => ({
                ...fix, line: one.line, column: one.column
            })));
            const wanted = title === undefined ? offered : offered.filter(fix => fix.title === title);
            if (wanted.length === 0) {
                throw new Error(title === undefined
                    ? `"${code}" offers no repair here.`
                    : `"${code}" offers no repair called "${title}". It offers: ${
                        offered.map(fix => `"${fix.title}"`).join(', ') || 'none'}.`);
            }
            if (new Set(wanted.map(fix => fix.title)).size > 1) {
                throw new Error(`"${code}" offers ${wanted.length} repairs here; name one: ${
                    [...new Set(wanted.map(fix => `"${fix.title}"`))].join(', ')}.`);
            }
            if (wanted.length > 1) {
                throw new Error(`"${code}" is reported ${wanted.length} times here, at ${
                    wanted.map(fix => `${fix.line}:${fix.column}`).join(', ')
                }; say which line and column to repair.`);
            }
            const chosen = wanted[0];
            const mine = chosen.changes.filter(change => change.file === documentName);
            if (mine.length !== chosen.changes.length) {
                throw new Error(`"${chosen.title}" edits ${
                    chosen.changes.filter(change => change.file !== documentName).map(c => c.file).join(', ')
                }, which is not this model.`);
            }
            const edits = mine.flatMap(change => change.edits);
            const text = await this.withDocument(
                source, documentName, document => applyEdits(source, document, edits));
            return { text, applied: chosen.title, left: await this.readText(text, documentName) };
        });
    }

    /**
     * What an edit did: the diagnostics it introduced, the ones it resolved,
     * and the ones it left alone.
     *
     * The question anything editing a model has to answer about itself, and
     * the one the repair tests ask internally -- a repair may leave a model
     * that parses and still be a step backwards. Matched by code and message,
     * not by position, since an edit moves everything below it.
     */
    async compareText(before: string, after: string, name = 'draft'): Promise<Difference> {
        return this.oneAtATime(async () => {
            const was = await this.readText(before, name);
            const is = await this.readText(after, name);
            // Counted, not matched by membership. A model with the same
            // complaint about two attributes has it twice, and repairing one
            // resolves one: sets said the code was still there and nothing had
            // happened. Matched by code and message rather than by position,
            // since an edit moves everything below it.
            const key = (one: Reported): string => `${one.code}\u0000${one.message}`;
            const tally = (reported: Reported[]): Map<string, number> => {
                const counts = new Map<string, number>();
                for (const one of reported) {
                    counts.set(key(one), (counts.get(key(one)) ?? 0) + 1);
                }
                return counts;
            };
            const had = tally(was);
            const has = tally(is);
            // Each occurrence beyond what the other side has is the new or the
            // gone one; the rest were there before and are there still.
            const takeExtra = (reported: Reported[], other: Map<string, number>): Reported[] => {
                const spare = new Map(other);
                const extra: Reported[] = [];
                for (const one of reported) {
                    const left = spare.get(key(one)) ?? 0;
                    if (left > 0) {
                        spare.set(key(one), left - 1);
                    } else {
                        extra.push(one);
                    }
                }
                return extra;
            };
            const introduced = takeExtra(is, had);
            return {
                introduced,
                resolved: takeExtra(was, has),
                left: is.filter(one => !introduced.includes(one))
            };
        });
    }

    /** The model laid out canonically, so two agents writing it agree. */
    async formatText(source: string, name = 'draft'): Promise<string> {
        return this.oneAtATime(() => this.withDocument(source, name, async document => {
            const edits = await this.services.Tonto.lsp.Formatter?.formatDocument(document, {
                textDocument: { uri: document.textDocument.uri },
                options: { tabSize: 4, insertSpaces: true }
            });
            return edits && edits.length > 0 ? applyEdits(source, document, edits) : source;
        }));
    }

    /**
     * What may be written at a position.
     *
     * The largest thing this language knows that a caller without an editor
     * cannot ask: which classes may stand at *this* end, given the stereotype
     * and the nature at the other one; which ends this class may subset;
     * which stereotypes it could take. All of it is in the completion
     * provider, and all of it was reachable only by opening the file in an
     * editor. Writing then validating is the alternative, and it is slower
     * and teaches nothing.
     *
     * Line and character are zero-based, as LSP counts them.
     */
    async completionsAt(source: string, line: number, character: number, name = 'draft'): Promise<Proposal[]> {
        const lines = source.split(/\r\n|\r|\n/);
        if (line < 0 || line >= lines.length) {
            throw new Error(`Line ${line} is outside the source; positions are zero-based and it has ${lines.length} line(s).`);
        }
        if (character < 0 || character > lines[line].length) {
            throw new Error(`Character ${character} is outside line ${line}, whose length is ${lines[line].length}.`);
        }
        return this.oneAtATime(() => this.withDocument(source, name, async document => {
            const list = await this.services.Tonto.lsp.CompletionProvider?.getCompletion(document, {
                textDocument: { uri: document.textDocument.uri },
                position: { line, character }
            });
            return (list?.items ?? []).map(item => ({
                label: String(item.label),
                ...(item.kind ? { kind: KINDS[item.kind] ?? String(item.kind) } : {}),
                ...(item.detail ? { detail: item.detail } : {}),
                ...(item.insertText && item.insertText !== item.label ? { insertText: item.insertText } : {}),
                ...(item.additionalTextEdits ? { additionalTextEdits: item.additionalTextEdits } : {})
            }));
        }));
    }

    /**
     * What a model declares, for a reader rather than a parser.
     *
     * `astOf` is faithful and unreadable past a few dozen declarations. This
     * is the page a reviewer wants: what the ultimate sortals are and what
     * hangs off them, what each relator binds, how the relations divide by
     * stereotype, what the generalization sets say -- and the hints, which
     * are exactly the model's own list of what it has not said yet.
     */
    async digestOf(source: string, name = 'draft'): Promise<Digest> {
        return this.oneAtATime(() => this.withDocument(source, name, async document => {
            const documents = this.modelDocuments(document);
            // A digest describes one model, so relink all of its files as
            // one unit. In particular, a held document that could not
            // resolve a later-held neighbor has to be reconsidered here.
            for (const one of documents) {
                this.services.shared.workspace.DocumentBuilder.resetToState(one, DocumentState.Parsed);
            }
            await this.services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
            const diagnostics = documents.flatMap(one => one.diagnostics ?? []);
            const unsaid = diagnostics
                .filter(one => SEVERITY[one.severity ?? 1] === 'hint')
                .map(one => ({
                    code: diagnosticCode(one),
                    message: this.byName(String(one.message))
                }));
            const classes: ClassDeclaration[] = [];
            const relations: Relation[] = [];
            const digest: Digest = {
                errors: diagnostics.filter(one => SEVERITY[one.severity ?? 1] === 'error').length,
                warnings: diagnostics.filter(one => SEVERITY[one.severity ?? 1] === 'warning').length,
                packages: [], stereotypes: {}, ultimateSortals: [], relators: [],
                relations: {}, gensets: [], values: [], unsaid
            };
            for (const one of documents) {
                const model = one.parseResult.value;
                if (!isModel(model)) {
                    continue;
                }
                for (const pkg of model.packages) {
                    // A one-file ontology's declarations are in no package.
                    digest.packages.push(isOntologyBody(pkg) ? `ontology ${model.ontologies[0]?.name ?? ''}`.trim()
                        : pkg.name ?? '<unnamed>');
                    for (const declaration of pkg.declarations) {
                        if (isClassDeclaration(declaration)) {
                            classes.push(declaration);
                            relations.push(...declaration.relations);
                            digest.stereotypes[declaration.stereotype] =
                                (digest.stereotypes[declaration.stereotype] ?? 0) + 1;
                        } else if (isExternalRelation(declaration)) {
                            relations.push(declaration);
                        } else if (isDatatype(declaration) || isEnumeration(declaration)) {
                            digest.values.push(declaration.name);
                        } else if (isGeneralizationSet(declaration)) {
                            digest.gensets.push({
                                name: declaration.name,
                                ...(declaration.general?.$refText ? { general: declaration.general.$refText } : {}),
                                specifics: declaration.specifics.map(specific => specific.$refText),
                                disjoint: declaration.disjoint,
                                complete: declaration.complete
                            });
                        }
                    }
                }
            }
            for (const relation of relations) {
                const stereotype = relation.stereotype ?? (isParthood(relation) ? 'parthood' : 'unstereotyped');
                digest.relations[stereotype] = (digest.relations[stereotype] ?? 0) + 1;
            }
            for (const classDeclaration of classes) {
                if (isUltimateSortal(classDeclaration.stereotype)) {
                    digest.ultimateSortals.push({
                        name: classDeclaration.name,
                        stereotype: classDeclaration.stereotype,
                        under: classes
                            .filter(other => collectAncestors(other).has(classDeclaration))
                            .map(other => other.name)
                    });
                }
                if (classifiesOnly(classDeclaration, 'relators')) {
                    digest.relators.push({
                        name: classDeclaration.name,
                        mediates: relations
                            .filter(relation => relation.stereotype === 'mediation'
                                && getRelationSource(relation) === classDeclaration)
                            .map(relation => relation.target?.ref?.name ?? relation.target?.$refText ?? '?')
                    });
                }
            }
            return digest;
        }));
    }

    /** The scratch document and every held or configured-workspace neighbor. */
    private modelDocuments(current: LangiumDocument): LangiumDocument[] {
        const documents = [current];
        const seen = new Set([current.textDocument.uri]);
        const folders = this.folders();
        for (const candidate of this.services.shared.workspace.LangiumDocuments.all) {
            const uri = candidate.textDocument.uri;
            if (seen.has(uri) || !isModel(candidate.parseResult.value)) {
                continue;
            }
            const path = candidate.uri.fsPath;
            const inWorkspace = folders.some(folder => path === folder || path.startsWith(`${folder}${sep}`));
            if (this.knownAs(uri) !== undefined || inWorkspace) {
                seen.add(uri);
                documents.push(candidate);
            }
        }
        return documents;
    }

    /**
     * The parsed model as JSON: what a consumer reading structure rather than
     * text should look at. Cross-references are written as the text that
     * resolved them, so the tree stays finite.
     *
     * A declaration's documentation comes with it, as `$documentation`:
     * `{ text?, descriptions, labels }`, the prose in no declared language
     * and whatever was written in a named one. Comments are hidden tokens, so
     * without this a reader of the JSON sees the whole model except what it
     * was written to say -- which is the half that says what the names mean.
     * A `label { }` or `description { }` block reads out here too, in the
     * same shape as the comments that replace it.
     */
    async astOf(source: string, name = 'draft'): Promise<unknown> {
        const documentation = this.services.Tonto.documentation.DocumentationProvider as TontoDocumentationProvider;
        return this.oneAtATime(() => this.withDocument(source, name, document => JSON.parse(
            this.services.Tonto.serializer.JsonSerializer.serialize(document.parseResult.value, {
                space: 0,
                replacer: (_key, value, defaultReplacer) => {
                    const replaced = defaultReplacer(_key, value);
                    if (!isAstNode(value) || replaced !== value) {
                        // A replaced value is a reference or a primitive; only
                        // a node passed through unchanged is one to document.
                        return replaced;
                    }
                    const docs = documentation.getStructured(value);
                    if (!docs) {
                        return value;
                    }
                    // Copied rather than assigned: `value` is the live AST
                    // node, and serializing must not write to it. `entries`
                    // and `unknownTags` stay behind -- they are how the run
                    // was read, not what it says.
                    const { text, descriptions, labels } = docs;
                    return {
                        ...value,
                        $documentation: {
                            ...(text ? { text } : {}),
                            ...(Object.keys(descriptions).length > 0 ? { descriptions } : {}),
                            ...(Object.keys(labels).length > 0 ? { labels } : {})
                        }
                    };
                }
            }))));
    }

    /** Builds a scratch document, hands it over, and forgets it afterward. */
    private async withDocument<T>(
        source: string, name: string, use: (document: LangiumDocument) => T | Promise<T>
    ): Promise<T> {
        const { document, leave } = await this.enter(source, name);
        try {
            await this.services.shared.workspace.DocumentBuilder.build([document], { validation: false });
            return await use(document);
        } finally {
            await leave();
        }
    }

    /**
     * The documents for the files asked about, reading any the workspace did
     * not.
     *
     * Selecting from what is loaded is right for a file inside the workspace
     * -- it is already parsed, and its links are the workspace's. It is wrong
     * for everything else: a session with no workspace configured, or a file
     * outside the one it has, would find nothing loaded and answer with an
     * empty list, which reads exactly like a model that holds. A file named to
     * `validateFiles` is a file to validate, so one that is not there yet is
     * read here.
     */
    private documents(wanted: Set<string>): LangiumDocument[] {
        const store = this.services.shared.workspace.LangiumDocuments;
        const found = new Map(store.all
            .filter(document => wanted.has(document.uri.fsPath))
            .map(document => [document.uri.fsPath, document] as const)
            .toArray());
        for (const path of wanted) {
            if (!found.has(path)) {
                const document = this.services.shared.workspace.LangiumDocumentFactory
                    .fromString(readFileSync(path, 'utf8'), URI.file(path));
                store.addDocument(document);
                found.set(path, document);
            }
        }
        return [...found.values()];
    }

    private async actions(document: LangiumDocument, diagnostic: Diagnostic): Promise<CodeAction[]> {
        const found = await this.services.Tonto.lsp.CodeActionProvider?.getCodeActions(document, {
            textDocument: { uri: document.textDocument.uri },
            range: diagnostic.range,
            // The repairs for this diagnostic and nothing else. Asking for
            // everything is answered with the file's source actions too, and
            // `fixText` reads "one action offered" as "nothing to choose
            // between" -- so a second entry in the list stopped every repair
            // it makes.
            context: { diagnostics: [diagnostic], only: [CodeActionKind.QuickFix] }
        });
        return (found ?? []).filter((action): action is CodeAction =>
            typeof action !== 'string' && 'title' in action);
    }

    /**
     * The name a caller knows a document by.
     *
     * A held document has a URI this file invented -- `/held/a_2f_b.tonto` --
     * and a diagnostic about two files naming one package quoted it back.
     * Nothing outside ever saw that path, so it is answered with the name the
     * caller held it under.
     */
    private knownAs(uri: string): string | undefined {
        for (const name of this.held.keys()) {
            if (this.heldUri(name).toString() === uri) {
                return name;
            }
        }
        return undefined;
    }

    /** The same, for a path quoted inside a message rather than reported beside it. */
    private byName(message: string): string {
        let said = message;
        for (const name of this.held.keys()) {
            said = said.split(this.heldUri(name).toString()).join(name).split(this.heldUri(name).fsPath).join(name);
        }
        return said;
    }

    private async report(documents: LangiumDocument[], name?: string, units?: ReadonlySet<string>): Promise<Reported[]> {
        const reported: Reported[] = [];
        for (const document of documents) {
            const localName = document === documents[0] ? name : undefined;
            for (const diagnostic of document.diagnostics ?? []) {
                const ontology = (diagnostic.data as { ontology?: string } | undefined)?.ontology;
                if (ontology && units && !units.has(ontology)) continue;
                reported.push({
                    file: localName ?? this.knownAs(document.textDocument.uri) ?? (document.uri.scheme === 'file' ? document.uri.fsPath : document.uri.toString()),
                    line: diagnostic.range.start.line + 1,
                    column: diagnostic.range.start.character + 1,
                    endLine: diagnostic.range.end.line + 1,
                    endColumn: diagnostic.range.end.character + 1,
                    severity: SEVERITY[diagnostic.severity ?? 1],
                    code: diagnosticCode(diagnostic),
                    message: this.byName(String(diagnostic.message)),
                    fixes: (await this.actions(document, diagnostic)).map(action => ({
                        title: action.title,
                        batchSafe: isBatchSafe(action),
                        changes: Object.entries(action.edit?.changes ?? {})
                            .filter(([, edits]) => edits.length > 0)
                            // The draft is one file among the loaded ones. Its
                            // name belongs to its own URI and not to the
                            // others: a draft naming a workspace class gets
                            // repairs that edit *that* file, and calling them
                            // all "draft" pointed one file's coordinates at
                            // another.
                            .map(([uri, edits]) => ({
                                file: localName !== undefined && uri === document.textDocument.uri
                                    ? localName
                                    : this.knownAs(uri) ?? URI.parse(uri).fsPath,
                                edits
                            }))
                    })).filter(fix => fix.changes.length > 0)
                });
            }
        }
        return reported.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
    }
}
