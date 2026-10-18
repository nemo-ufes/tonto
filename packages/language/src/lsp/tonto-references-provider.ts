import { AstUtils, CstUtils, GrammarUtils } from 'langium';
import type { LangiumDocument, LangiumDocuments, MaybePromise } from 'langium';
import { DefaultReferencesProvider } from 'langium/lsp';
import type { LangiumServices } from 'langium/lsp';
import type { CancellationToken, Location, ReferenceParams } from 'vscode-languageserver';
import type { Ontology } from '../generated/ast.js';
import { isOntology } from '../generated/ast.js';
import { ontologiesNamed, ownerAt, ownerMentions } from './ontology-actions.js';

/**
 * An ontology is referred to by its members' `in`, which is a name and not a
 * cross-reference, so the default search -- which reads the reference index
 * -- finds none of them. Asked on an ontology's name, or on an `in` naming
 * one, the references are the packages that say they belong to it.
 */
export class TontoReferencesProvider extends DefaultReferencesProvider {
    private readonly documents: LangiumDocuments;

    constructor(services: LangiumServices) {
        super(services);
        this.documents = services.shared.workspace.LangiumDocuments;
    }

    override findReferences(document: LangiumDocument, params: ReferenceParams, cancelToken?: CancellationToken): MaybePromise<Location[]> {
        const name = this.ontologyNameAt(document, document.textDocument.offsetAt(params.position));
        if (!name) return super.findReferences(document, params, cancelToken);
        const declarations = params.context.includeDeclaration ? ontologiesNamed(name, this.documents.all).flatMap(ontology => {
            const node = GrammarUtils.findNodeForProperty(ontology.$cstNode, 'name');
            return node ? [{ uri: AstUtils.getDocument(ontology).uri.toString(), range: node.range }] : [];
        }) : [];
        return [...declarations, ...ownerMentions(name, this.documents.all)];
    }

    private ontologyNameAt(document: LangiumDocument, offset: number): string | undefined {
        const member = ownerAt(document, offset);
        if (member) return member.owner;
        const root = document.parseResult.value.$cstNode;
        const leaf = root && CstUtils.findLeafNodeAtOffset(root, offset);
        const ontology = leaf?.astNode;
        const name = isOntology(ontology) ? GrammarUtils.findNodeForProperty(ontology.$cstNode, 'name') : undefined;
        return name && name.offset <= offset && offset <= name.end ? (ontology as Ontology).name : undefined;
    }
}
