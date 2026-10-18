import { AstUtils, CstUtils } from 'langium';
import type { LangiumDocument } from 'langium';
import { DefaultDefinitionProvider } from 'langium/lsp';
import type { LangiumServices } from 'langium/lsp';
import type { DefinitionParams, LocationLink } from 'vscode-languageserver';
import { isBundleEntry, isImport } from '../generated/ast.js';
import { bundleTargets, publicationWorkspace } from './workspace.js';
import { ontologiesNamed, ownerAt } from '../lsp/ontology-actions.js';

export class PublicationDefinitionProvider extends DefaultDefinitionProvider {
    private readonly publication;
    private readonly virtualSources: boolean;
    private readonly documents;
    constructor(services: LangiumServices) {
        super(services);
        this.documents = services.shared.workspace.LangiumDocuments;
        this.publication = publicationWorkspace(services.shared);
        this.virtualSources = !!services.shared.lsp.Connection;
    }

    override async getDefinition(document: LangiumDocument, params: DefinitionParams): Promise<LocationLink[] | undefined> {
        const root = document.parseResult.value.$cstNode;
        const leaf = root && CstUtils.findLeafNodeAtOffset(root, document.textDocument.offsetAt(params.position));
        const node = leaf?.astNode;
        const member = ownerAt(document, document.textDocument.offsetAt(params.position));
        const target = member ? ontologiesNamed(member.owner!, this.documents.all)[0]
            : node && isBundleEntry(node) ? bundleTargets.get(node)
            : node && isImport(node) ? this.publication.imported.get(node)?.declaration
                ?? this.publication.imported.get(node)?.packages[0] : undefined;
        const links = target?.$cstNode ? [{
            targetUri: AstUtils.getDocument(target).uri.toString(), targetRange: target.$cstNode.range,
            targetSelectionRange: this.nameProvider.getNameNode(target)?.range ?? target.$cstNode.range,
            originSelectionRange: leaf?.range
        }] : await super.getDefinition(document, params);
        return links?.map(link => this.virtualSources && /^https?:/.test(link.targetUri)
            ? { ...link, targetUri: `tonto-cache:/source.tonto?${encodeURIComponent(link.targetUri)}` } : link);
    }
}
