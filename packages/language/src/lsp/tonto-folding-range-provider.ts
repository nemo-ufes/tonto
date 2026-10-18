import type { AstNode } from 'langium';
import { DefaultFoldingRangeProvider } from 'langium/lsp';
import { isOntologyBody } from '../generated/ast.js';

/**
 * A one-file ontology's body has no line of its own: it begins on the line
 * of its first declaration. Folded, it would claim that line from the
 * declaration, so the fold a modeler reaches for on `kind Person {` would
 * hide the whole ontology instead. Its declarations fold as they always do.
 */
export class TontoFoldingRangeProvider extends DefaultFoldingRangeProvider {
    protected override shouldProcess(node: AstNode): boolean {
        return !isOntologyBody(node);
    }
}
