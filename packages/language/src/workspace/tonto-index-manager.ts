import { AstUtils, DefaultIndexManager, stream } from 'langium';
import type { AstNode, LangiumDocument, ReferenceDescription, Stream, URI } from 'langium';
import type { CancellationToken } from 'vscode-languageserver-protocol';

/**
 * Answers "what points at this node" from an index keyed by target.
 *
 * The default answer walks every reference in the workspace, and the checks
 * that read what points *at* a class -- a role's relator, a moment's bearer --
 * ask it for every class they validate: a pass over the whole model per class.
 * The target index is rebuilt lazily, once after any change to the references.
 */
export class TontoIndexManager extends DefaultIndexManager {

    private byTarget?: Map<string, ReferenceDescription[]>;

    override findAllReferences(targetNode: AstNode, astNodePath: string): Stream<ReferenceDescription> {
        if (!this.byTarget) {
            this.byTarget = new Map();
            for (const references of this.referenceIndex.values()) {
                for (const reference of references) {
                    const key = `${reference.targetUri.toString()}#${reference.targetPath}`;
                    const known = this.byTarget.get(key);
                    if (known) known.push(reference); else this.byTarget.set(key, [reference]);
                }
            }
        }
        return stream(this.byTarget.get(`${AstUtils.getDocument(targetNode).uri.toString()}#${astNodePath}`) ?? []);
    }

    override removeReferences(uri: URI): void {
        this.byTarget = undefined;
        super.removeReferences(uri);
    }

    override async updateReferences(document: LangiumDocument, cancelToken?: CancellationToken): Promise<void> {
        this.byTarget = undefined;
        await super.updateReferences(document, cancelToken);
    }
}
