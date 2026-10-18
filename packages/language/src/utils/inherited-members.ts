import type { ClassDeclaration, Relation, RelationEndMetaAttributes } from '../generated/ast.js';
import { collectAncestors, isSameOrSpecializes } from './generalizations.js';
import { getNamedEnds, getRelationSourceName } from './relations.js';

/**
 * What a class may name without saying where it came from.
 *
 * `subsets ComplexPhysicalObject.parts` inside a `kind Lion specializes
 * ComplexPhysicalObject` says where to look for something the specialization
 * has already settled: the end is reachable, and which class declares it is
 * not in question. So the simple name resolves, here and in the scope
 * provider that offers it.
 *
 * Collected nearest first, which is what a redefinition expects: a `parts`
 * declared closer refines the one above it and is the one meant.
 */
export interface InheritedMember<T> {
    node: T;
    /** The class the member is declared in, for saying which when two disagree. */
    owner: ClassDeclaration;
}

export interface InheritedMembers {
    relations: Map<string, InheritedMember<Relation>[]>;
    ends: Map<string, InheritedMember<RelationEndMetaAttributes>[]>;
}

/**
 * `relationsFor`, when given, is what makes this wider than own-body-only. A
 * named end's true owner is not always the class whose body holds the
 * relation -- a *source*-side name (`(wholes)` in
 * `kind Part { (wholes) [0..*] <>-- [1..*] Whole }`) is a property of the
 * *target*, per `getNamedEnds`, and an `ExternalRelation` naming an ancestor
 * as its source or target is not in that ancestor's own `relations` field at
 * all (only `InternalRelation`s are, and only the ones written inside its own
 * body). The default only searches a member's own body, which finds every
 * target-side name and named `InternalRelation` -- the common case, and the
 * only one a caller with nothing wider to search (mid-draft text with no
 * document yet) can offer. A caller that can search further -- the workspace
 * index for a validation check already past linking, a package's own
 * declarations for the scope provider computing linking itself -- passes a
 * function returning every relation worth checking against a given ancestor;
 * ownership is still decided per end and per relation, so a wider search only
 * ever adds entries, never misattributes one already found correctly.
 */
export function membersInScopeOf(
    classDeclaration: ClassDeclaration,
    relationsFor: (member: ClassDeclaration) => Iterable<Relation> = member => member.relations
): InheritedMembers {
    const relations = new Map<string, InheritedMember<Relation>[]>();
    const ends = new Map<string, InheritedMember<RelationEndMetaAttributes>[]>();
    const add = <T>(into: Map<string, InheritedMember<T>[]>, name: string, node: T, owner: ClassDeclaration): void => {
        into.set(name, [...into.get(name) ?? [], { node, owner }]);
    };
    for (const member of [classDeclaration, ...collectAncestors(classDeclaration)]) {
        for (const relation of relationsFor(member)) {
            if (relation.name && getRelationSourceName(relation) === member.name) {
                add(relations, relation.name, relation, member);
            }
            // Attributed to whichever end this one's own ownership rule
            // names -- which, for a relation only reachable this way because
            // `member` is its target, is `member` itself and not whatever
            // class happens to hold the relation's text.
            for (const end of getNamedEnds(relation)) {
                if (end.ownerName === member.name) {
                    add(ends, end.name, end.node, member);
                }
            }
        }
    }
    return { relations, ends };
}

/**
 * Whether a simple name reaches more than one thing, from branches of the
 * lineage that say nothing about each other.
 *
 * Two declarations of `parts` where one class specializes the other are one
 * property refined, and the nearer is the answer. Two under unrelated mixins
 * are two properties, and nothing in the model says which was meant.
 */
export function fromUnrelatedBranches(found: ReadonlyArray<InheritedMember<unknown>>): ClassDeclaration[] {
    const owners: ClassDeclaration[] = [];
    for (const { owner } of found) {
        const related = owners.some(other =>
            other === owner || isSameOrSpecializes(other, owner) || isSameOrSpecializes(owner, other));
        if (!related) {
            owners.push(owner);
        }
    }
    return owners.length > 1 ? owners : [];
}
