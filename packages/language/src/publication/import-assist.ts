import { AstUtils, GrammarUtils, EmptyFileSystem, isReference } from 'langium';
import type { AstNodeDescription, FileSystemProvider, LangiumCoreServices, LangiumDocument, ReferenceInfo } from 'langium';
import type { TextEdit } from 'vscode-languageserver';
import { isPackage } from '../generated/ast.js';
import type { Package } from '../generated/ast.js';
import type { TontoScopeProvider } from '../references/tonto-scope-provider.js';
import { applicableImports, ownerOf, publicationWorkspace } from './workspace.js';
import { TextDocument } from 'vscode-languageserver-textdocument';

export interface ImportCandidate { pkg: Package; description: AstNodeDescription }

/** Hidden symbols are discoverable for assistance, never added to the binding scope. */
export function importCandidates(services: LangiumCoreServices, reference: ReferenceInfo, exact?: string): ImportCandidate[] {
    const pkg = AstUtils.getContainerOfType(reference.container, isPackage);
    const unit = pkg && ownerOf(pkg);
    if (!pkg || !unit) return [];
    const imports = applicableImports(pkg);
    const imported = new Set(imports.map(imp => imp.package?.ref));
    const qualifiers = new Set([pkg.name, ...imports.flatMap(imp => [imp.alias, imp.package?.ref?.name])].filter(Boolean));
    let type: string;
    try { type = services.shared.AstReflection.getReferenceType(reference); } catch { return []; }
    if (type === 'Package') return [];
    const provider = services.references.ScopeProvider as TontoScopeProvider;
    const candidates: ImportCandidate[] = [];
    for (const other of unit.packages) {
        if (other === pkg || imported.has(other) || !other.name || qualifiers.has(other.name)) continue;
        for (const description of provider.packageDescriptions(other, other.name)) {
            if (!services.shared.AstReflection.isSubtype(description.type, type) || (exact && description.name !== exact)) continue;
            // Prefer the qualified spelling for completion; exact diagnostics
            // still recognize an unqualified name without silently binding it.
            if (!exact && !description.name.startsWith(`${other.name}.`)) continue;
            candidates.push({ pkg: other, description });
        }
    }
    return candidates;
}

export function importEdit(document: LangiumDocument, pkg: Package, target: Package): TextEdit | undefined {
    // After the whole header: `package details in model` ends at its owner.
    const header = GrammarUtils.findNodeForProperty(pkg.$cstNode, 'owner') ?? GrammarUtils.findNodeForProperty(pkg.$cstNode, 'name');
    if (!header || !target.name) return undefined;
    const position = document.textDocument.positionAt(header.end);
    const newline = document.textDocument.getText().includes('\r\n') ? '\r\n' : '\n';
    return { range: { start: position, end: position }, newText: `${newline}${newline}use ${target.name}${newline}` };
}

/**
 * Repairs are checked in an isolated service graph, never by mutating the live
 * model. `edits` are the document's own, or every document's, by URI.
 */
export async function importRepairIsValid(
    services: LangiumCoreServices, document: LangiumDocument, edits: TextEdit[] | Record<string, TextEdit[]>, expected?: AstNodeDescription
): Promise<boolean> {
    const { createTontoServices } = await import('../tonto-module.js');
    const documents = services.shared.workspace.LangiumDocuments.all.toArray();
    const byDocument = Array.isArray(edits) ? { [document.uri.toString()]: edits } : edits;
    const sources = new Map(documents.map(doc => [doc.uri.toString(), byDocument[doc.uri.toString()]
        ? TextDocument.applyEdits(doc.textDocument, byDocument[doc.uri.toString()]) : doc.textDocument.getText()]));
    // Dependency refresh must read the same snapshot as the repair, including
    // unsaved text. An empty filesystem makes loaded local imports disappear.
    const fileSystem: FileSystemProvider = EmptyFileSystem.fileSystemProvider();
    fileSystem.readFileSync = uri => {
        const source = sources.get(uri.toString());
        if (source === undefined) throw new Error(`Document <${uri}> is not part of the repair snapshot.`);
        return source;
    };
    fileSystem.readFile = async uri => fileSystem.readFileSync(uri);
    const clone = createTontoServices({ fileSystemProvider: () => fileSystem });
    publicationWorkspace(services.shared).copyConfigurationTo(publicationWorkspace(clone.shared));
    const baseline = new Map<string, number>();
    for (const doc of documents) for (const diag of doc.diagnostics ?? []) {
        if (diag.severity !== 1) continue;
        const key = `${doc.uri}:${diag.code}:${diag.message}`;
        baseline.set(key, (baseline.get(key) ?? 0) + 1);
    }
    const copies = documents.map(doc => {
        const source = sources.get(doc.uri.toString())!;
        const copy = clone.shared.workspace.LangiumDocumentFactory.fromString(source, doc.uri);
        clone.shared.workspace.LangiumDocuments.addDocument(copy);
        return copy;
    });
    await clone.shared.workspace.DocumentBuilder.build(copies, { validation: true });
    if (expected) {
        const edited = copies.find(doc => doc.uri.toString() === document.uri.toString());
        const target = edited?.references.some(reference => {
            const node = isReference(reference) ? reference.ref : undefined;
            return !!node && AstUtils.getDocument(node).uri.toString() === expected.documentUri.toString()
                && clone.Tonto.workspace.AstNodeLocator.getAstNodePath(node) === expected.path;
        });
        if (!target) return false;
    }
    return copies.every(doc => (doc.diagnostics ?? []).filter(diag => diag.severity === 1).every(diag => {
        const key = `${doc.uri}:${diag.code}:${diag.message}`;
        const remaining = baseline.get(key) ?? 0;
        baseline.set(key, remaining - 1);
        return remaining > 0;
    }));
}
