import type { AstNode, LangiumDocuments, Reference } from 'langium';
import { AstUtils, CstUtils, GrammarUtils, URI, isReference } from 'langium';
import type { CancellationToken } from 'vscode-languageserver';
import type { RenameParams, TextEdit, WorkspaceEdit } from 'vscode-languageserver';
import type { LangiumServices } from 'langium/lsp';
import { DefaultRenameProvider } from 'langium/lsp';
import type { LangiumDocument } from 'langium';
import type { ClassDeclaration, Package, Model } from '../generated/ast.js';
import { isClassDeclaration, isOntology, isPackage, isRelation, isRelationEndMetaAttributes } from '../generated/ast.js';
import { ownerRenames } from './ontology-actions.js';
import { getRelationSource } from '../utils/relations.js';
import { bundleTargets, ownerOf, publicationWorkspace } from '../publication/workspace.js';

/**
 * Renames in a language whose references are often qualified.
 *
 * A relation is named through the class it is read from, `Meeting.joinedBy`,
 * an end through the class that owns it, `Team.members`, and anything through
 * its package, `p.Person`. Langium's own rename replaces each reference to
 * the renamed node with the new name whole, so it left two kinds of damage:
 *
 * - a qualified reference to the renamed node lost its qualifier --
 *   `Meeting.joinedBy` renamed became `attendedBy`, which nothing resolves;
 * - a reference *through* it was not touched at all -- renaming `Meeting`
 *   left `Meeting.joinedBy` naming a class that no longer exists.
 *
 * Both are answered here, by rewriting one segment of the reference text and
 * leaving the rest as written.
 */
export class TontoRenameProvider extends DefaultRenameProvider {
    private readonly documents: LangiumDocuments;
    private readonly publication;

    constructor(services: LangiumServices) {
        super(services);
        this.documents = services.shared.workspace.LangiumDocuments;
        this.publication = publicationWorkspace(services.shared);
    }

    override async rename(
        document: LangiumDocument, params: RenameParams, _cancelToken?: CancellationToken
    ): Promise<WorkspaceEdit | undefined> {
        const root = document.parseResult.value.$cstNode;
        const leaf = root && CstUtils.findDeclarationNodeAtOffset(
            root, document.textDocument.offsetAt(params.position), this.grammarConfig.nameRegexp);
        const target = leaf && this.references.findDeclarations(leaf)[0];
        const oldName = target && this.nameProvider.getName(target);
        if (!target || !oldName) {
            return undefined;
        }
        const changes: Record<string, TextEdit[]> = {};
        const add = (uri: string, edit: TextEdit): void => {
            (changes[uri] ??= []).push(edit);
        };

        // The renamed node itself, and every reference to it: the last
        // segment is its name, and whatever qualifies it stays.
        for (const reference of this.references.findReferences(target, { includeDeclaration: true })) {
            const source = this.documents.getDocument(reference.sourceUri);
            const written = source?.textDocument.getText(reference.segment.range) ?? oldName;
            const dot = written.lastIndexOf('.');
            add(reference.sourceUri.toString(), {
                range: reference.segment.range,
                newText: dot >= 0 && written.slice(dot + 1) === oldName
                    ? `${written.slice(0, dot + 1)}${params.newName}`
                    : params.newName
            });
        }

        // References that pass *through* it: to a relation read from a
        // renamed class or an end it owns, or to anything in a renamed package.
        if (isClassDeclaration(target) || isPackage(target)) {
            for (const each of this.documents.all) {
                for (const node of AstUtils.streamAst(each.parseResult.value)) {
                    for (const reference of referencesOf(node)) {
                        const edit = this.throughRenamed(reference, target, oldName, params.newName);
                        if (edit) {
                            add(each.textDocument.uri, edit);
                        }
                    }
                }
            }
        }
        // Members name their ontology in `in`, a name rather than a reference.
        if (isOntology(target)) {
            for (const [uri, edits] of Object.entries(ownerRenames(target, params.newName, this.documents.all))) edits.forEach(edit => add(uri, edit));
        }
        if (isPackage(target)) for (const source of this.documents.all) {
            for (const ontology of (source.parseResult.value as Model).ontologies ?? []) for (const bundle of ontology.bundles) {
                const name = bundleTargets.get(bundle) === target && GrammarUtils.findNodeForProperty(bundle.$cstNode, 'name');
                if (name) add(source.uri.toString(), { range: name.range, newText: params.newName });
            }
        }
        if (Object.keys(changes).some(uri => {
            const source = this.documents.getDocument(URI.parse(uri));
            return source && this.publication.isReadOnly(source);
        })) return undefined;
        return { changes };
    }

    /**
     * The edit for a qualified reference that names the renamed class or
     * package as one of its segments, where it really is that class or
     * package the segment means.
     */
    private throughRenamed(
        reference: Reference, renamed: ClassDeclaration | Package, oldName: string, newName: string
    ): TextEdit | undefined {
        const named = reference.ref;
        const range = reference.$refNode?.range;
        const segments = reference.$refText.split('.');
        if (!named || !range || segments.length < 2) {
            return undefined;
        }
        if (isClassDeclaration(renamed)) {
            const owner = isRelation(named) ? getRelationSource(named)
                : isRelationEndMetaAttributes(named) ? endOwner(named)
                    : undefined;
            const at = segments.length - 2;
            if (owner !== renamed || segments[at] !== oldName) {
                return undefined;
            }
            segments[at] = newName;
            return { range, newText: segments.join('.') };
        }
        // A package name may itself be dotted, so it is matched as a prefix.
        if (AstUtils.getContainerOfType(named, isPackage) !== renamed
            || !((AstUtils.getDocument(reference.$refNode!.astNode).parseResult.value as Model).packages ?? [])
                .some(pkg => ownerOf(pkg) === ownerOf(renamed))
            || !reference.$refText.startsWith(`${oldName}.`)) {
            return undefined;
        }
        return { range, newText: `${newName}${reference.$refText.slice(oldName.length)}` };
    }
}

/** The class an end is a property of: the source owns the target end, and the target the source end. */
function endOwner(end: AstNode): AstNode | undefined {
    if (!isRelationEndMetaAttributes(end)) {
        return undefined;
    }
    const relation = end.$container;
    return relation.targetMeta === end ? getRelationSource(relation) : relation.target?.ref;
}

/** Every reference a node holds, in any property. */
function referencesOf(node: AstNode): Reference[] {
    return Object.entries(node)
        .filter(([property]) => !property.startsWith('$'))
        .flatMap(([, value]) => Array.isArray(value) ? value : [value])
        .filter((value): value is Reference => isReference(value));
}
