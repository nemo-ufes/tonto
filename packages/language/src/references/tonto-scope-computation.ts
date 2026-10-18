import type { AstNode, AstNodeDescription, LangiumDocument } from 'langium';
import { DefaultScopeComputation } from 'langium';
import { CancellationToken } from 'vscode-languageserver';
import { isClassDeclaration, isExternalRelation } from '../generated/ast.js';
import type { Declaration, Model, Package, Relation } from '../generated/ast.js';
import { getNamedEnds, getRelationSourceName } from '../utils/relations.js';
import { BUILTIN_DATATYPES_URI } from '../workspace/builtin-datatypes.js';

/**
 * Exports declarations into the *global* index.
 *
 * Every `Package` is always exported under its own (possibly dotted) name,
 * so `use x.y` can find it. A package's own declarations are only
 * exported as a base scope only for the virtual compiler prelude. Authored
 * declarations are made visible by `TontoScopeProvider` through applicable
 * imports and ontology ownership, not by exposing the workspace index.
 */
export class TontoScopeComputation extends DefaultScopeComputation {

    override async collectExportedSymbols(
        document: LangiumDocument,
        _cancelToken: CancellationToken = CancellationToken.None
    ): Promise<AstNodeDescription[]> {
        const exports: AstNodeDescription[] = [];
        const model = document.parseResult.value as Model;
        for (const pkg of model.packages) {
            // A half-written `package` has no name yet. Nothing can import it
            // and nothing can qualify against it, so it is exported as
            // nothing -- rather than as `undefined`, which is what
            // `createDescription` was handed, and it throws on that: the
            // document then had no index entry, no scope and no diagnostics,
            // and the editor reported an internal error instead of the
            // missing name.
            if (pkg.name) {
                exports.push(this.descriptions.createDescription(pkg, pkg.name, document));
            }
            if (document.uri.toString() === BUILTIN_DATATYPES_URI) {
                for (const declaration of pkg.declarations) {
                    this.exportDeclaration(pkg, declaration, document, exports);
                }
            }
        }
        return exports;
    }

    private exportDeclaration(pkg: Package, declaration: Declaration, document: LangiumDocument, exports: AstNodeDescription[]): void {
        if (declaration.name) {
            exports.push(this.descriptions.createDescription(declaration, declaration.name, document));
            if (pkg.name) {
                exports.push(this.descriptions.createDescription(declaration, `${pkg.name}.${declaration.name}`, document));
            }
        }
        if (isExternalRelation(declaration)) {
            this.exportRelation(pkg, declaration, document, exports);
        }
        if (isClassDeclaration(declaration)) {
            for (const relation of declaration.relations) {
                this.exportRelation(pkg, relation, document, exports);
            }
        }
    }

    /**
     * Exports a relation's own qualified name (`Source.relName`) and, separately,
     * each of its named ends (`Owner.endName`) -- both bare and package-qualified,
     * mirroring how ordinary declarations are exported.
     */
    private exportRelation(pkg: Package, relation: Relation, document: LangiumDocument, exports: AstNodeDescription[]): void {
        const add = (node: AstNode, name: string): void => {
            exports.push(this.descriptions.createDescription(node, name, document));
            if (pkg.name) {
                exports.push(this.descriptions.createDescription(node, `${pkg.name}.${name}`, document));
            }
        };
        const source = getRelationSourceName(relation);
        if (source && relation.name) {
            add(relation, `${source}.${relation.name}`);
        }
        for (const end of getNamedEnds(relation)) {
            if (end.ownerName) {
                add(end.node, `${end.ownerName}.${end.name}`);
            }
        }
    }
}
