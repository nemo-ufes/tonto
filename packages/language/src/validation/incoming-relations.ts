import type { AstNode, AstNodeLocator, IndexManager, LangiumDocuments } from 'langium';
import type { ClassDeclaration, Relation } from '../generated/ast.js';
import { isRelation } from '../generated/ast.js';
import { getRelationSource } from '../utils/relations.js';
import { canSee, validationOntology, ownerOf } from '../publication/workspace.js';
import type { OntologyUnit } from '../publication/workspace.js';

export interface ReverseLookup {
    /** Every relation in the workspace with this class at either end. */
    touching(classDeclaration: ClassDeclaration): Relation[];
    /** Every node in the workspace that names this one, of any kind. */
    referrers(node: AstNode): AstNode[];
    /**
     * Forgets what it has answered. The owner calls this whenever a document
     * changes: a lookup registered in the module-level reset registry instead
     * would be a lookup no session ever lets go of, and its closure holds that
     * session's whole index.
     */
    reset(): void;
}

/**
 * Finds the relations that point *at* a class, across every loaded document.
 *
 * Several UFO rules are about what refers to a type rather than what it
 * declares -- a relator has to mediate at least two things, a quality has to
 * characterize a bearer -- and the relation carrying that dependency is
 * usually written in the file that needs it, not in the file declaring the
 * type. Walking the local AST would report a false positive on every model
 * split across more than one file, which is why these checks waited for the
 * workspace index.
 *
 * Only loaded documents are searched, so what counts as loaded matters: the
 * CLI loads the model a file belongs to rather than the file alone, and
 * `TontoDocumentBuilder` re-validates this file when one of the documents it
 * points at changes -- without which a mediation deleted in another file left
 * the answer here as it was. A workspace still opening can still under-report,
 * which for these checks means staying quiet: the safe direction.
 */
export function createReverseLookup(
    indexManager: IndexManager, documents: LangiumDocuments, locator: AstNodeLocator
): ReverseLookup {
    let cache = new WeakMap<AstNode, Map<OntologyUnit | undefined, AstNode[]>>();

    const referrers = (node: AstNode): AstNode[] => {
        const context = validationOntology.getStore() ?? ownerOf(node);
        const cached = cache.get(node)?.get(context);
        if (cached) {
            return cached;
        }
        const found: AstNode[] = [];
        for (const reference of indexManager.findAllReferences(node, locator.getAstNodePath(node))) {
            const document = documents.getDocument(reference.sourceUri);
            if (!document) {
                continue;
            }
            const referrer = locator.getAstNode(document.parseResult.value, reference.sourcePath);
            if (referrer && canSee(node, referrer)) {
                found.push(referrer);
            }
        }
        const contexts = cache.get(node) ?? new Map();
        contexts.set(context, found);
        cache.set(node, contexts);
        return found;
    };

    return {
        referrers,
        reset(): void {
            cache = new WeakMap();
        },
        touching(classDeclaration: ClassDeclaration): Relation[] {
            // A relation written inside the class body names the class only at
            // its far end, so the index never lists it against this class.
            return [...referrers(classDeclaration).filter(isRelation), ...classDeclaration.relations];
        }
    };
}

/** The relations of a given stereotype that start from this class. */
export function outgoingByStereotype(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, stereotype: string
): Relation[] {
    return lookup.touching(classDeclaration)
        .filter(relation => relation.stereotype === stereotype && getRelationSource(relation) === classDeclaration);
}
