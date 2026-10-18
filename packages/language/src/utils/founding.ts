import type { ClassDeclaration, Relation } from '../generated/ast.js';
import { isClassDeclaration, isRelation } from '../generated/ast.js';
import { cannotShareInstances } from './disjointness.js';
import { collectAncestors } from './generalizations.js';
import { getRelationSource, isParthood, wholeEndOf } from './relations.js';

/**
 * What an instance of the class is an instance *because of*, for the
 * stereotypes that say it is because of something outside it.
 *
 * A role holds while a relationship does -- a relator that mediates it, or a
 * whole it is part of: a main motor is a motor a boat has as its main one. A
 * historical role holds because an event happened -- one it took part in, or
 * was created or terminated in -- and goes on holding. These are the stereotypes whose relational condition the
 * gUFO export writes (the gUFO paper's Listing 20) and whose founding the
 * checks ask for.
 */
export type Founding = 'relational' | 'historical';

const FOUNDING: Readonly<Record<string, Founding>> = {
    role: 'relational',
    roleMixin: 'relational',
    historicalRole: 'historical',
    historicalRoleMixin: 'historical'
};

export function foundingOf(classDeclaration: ClassDeclaration): Founding | undefined {
    return FOUNDING[classDeclaration.stereotype ?? ''];
}

/**
 * The end of `relation` at which `classDeclaration` sits when the relation is
 * one that founds it, and nothing when it is not.
 *
 * Only the class's *own* relations: a mediation of `Person` founds nothing
 * about being a `Student`, which is a person enrolled, and a person's birth
 * founds no historical role above it. What a role inherits comes from a
 * `role` or `roleMixin` above it, whose own relations found it -- see
 * `foundedAbove`.
 */
export function foundingSide(relation: Relation, classDeclaration: ClassDeclaration): 'source' | 'target' | undefined {
    const founding = foundingOf(classDeclaration);
    const source = getRelationSource(relation);
    const target = relation.target?.ref;
    if (founding === 'historical') {
        return foundsHistorically(relation) && source === classDeclaration ? 'source' : undefined;
    }
    if (founding !== 'relational') {
        return undefined;
    }
    if (relation.stereotype === 'mediation') {
        return target === classDeclaration ? 'target' : undefined;
    }
    if (isParthood(relation)) {
        const partSide = wholeEndOf(relation) === 'source' ? 'target' : 'source';
        return (partSide === 'source' ? source : target) === classDeclaration ? partSide : undefined;
    }
    return undefined;
}

/** The relations among `candidates` that found the class, each with the end it sits at. */
export function foundingRelations(
    classDeclaration: ClassDeclaration, candidates: Iterable<Relation>
): Array<{ relation: Relation; side: 'source' | 'target' }> {
    const found: Array<{ relation: Relation; side: 'source' | 'target' }> = [];
    for (const relation of candidates) {
        const side = foundingSide(relation, classDeclaration);
        if (side && !found.some(each => each.relation === relation)) {
            found.push({ relation, side });
        }
    }
    return found;
}

/**
 * Whether a supertype founded the same way already founds the class: a
 * `PersonalCustomer` under a `Customer` that purchases found is a customer
 * for that reason, whatever else mediates it. Its own relations are then not
 * assumed to be what founds it -- a loyalty card it may hold is not what
 * makes it a customer.
 */
export function foundedAbove(
    classDeclaration: ClassDeclaration, relationsOf: (ancestor: ClassDeclaration) => Iterable<Relation>
): boolean {
    const founding = foundingOf(classDeclaration);
    return !!founding && [...collectAncestors(classDeclaration)].some(ancestor =>
        foundingOf(ancestor) === founding
        && (foundingRelations(ancestor, relationsOf(ancestor)).length > 0 || ancestor.derivedFrom.length > 0));
}

/**
 * The relations an event can found a historical role by: taking part in it,
 * or being created or terminated in it. Being born in Brazil is a historical
 * role founded by the birth, as being a graduate is one founded by the
 * graduation.
 */
export const HISTORICAL_FOUNDING_STEREOTYPES: ReadonlySet<string> = new Set(['participation', 'creation', 'termination']);

/** Whether this relation is one an event founds a historical role by. */
export function foundsHistorically(relation: Relation): boolean {
    return HISTORICAL_FOUNDING_STEREOTYPES.has(relation.stereotype ?? '');
}

/**
 * The relations into an event that could found this historical role: of a
 * founding stereotype, into the event or an event type above it, and from
 * something that can be an instance of the role. What `derivedFrom
 * BirthInBrazil` stands for, when it is one of them: a creation written into
 * `Birth`, read for the births that are births in Brazil.
 */
export function foundingCandidatesInto(
    classDeclaration: ClassDeclaration, event: ClassDeclaration, relationsOf: (node: ClassDeclaration) => Iterable<Relation>
): Relation[] {
    const found = new Set<Relation>();
    for (const eventType of [event, ...collectAncestors(event)]) {
        for (const relation of relationsOf(eventType)) {
            const participant = getRelationSource(relation);
            if (foundsHistorically(relation) && relation.target?.ref === eventType
                && !!participant && isClassDeclaration(participant)
                && !cannotShareInstances(participant, classDeclaration)) {
                found.add(relation);
            }
        }
    }
    return [...found];
}

/** A relation a historical role is derived from, and the event type it is read for. */
export interface Derivation {
    relation: Relation;
    event: ClassDeclaration;
}

/**
 * What a historical role's `derivedFrom` names, as it founds it: each named
 * relation of a founding stereotype, read for the event it reaches, and for
 * each event named, the one relation into it -- or into a type above it --
 * that could be meant, read for that event. Anything else the clause names is
 * reported by the checks and founds nothing here.
 */
export function derivationsOf(
    classDeclaration: ClassDeclaration, relationsOf: (node: ClassDeclaration) => Iterable<Relation>
): Derivation[] {
    const found: Derivation[] = [];
    for (const reference of classDeclaration.derivedFrom) {
        const named = reference.ref;
        if (isRelation(named)) {
            const participant = getRelationSource(named);
            const event = named.target?.ref;
            if (foundsHistorically(named) && participant && isClassDeclaration(participant)
                && !cannotShareInstances(participant, classDeclaration) && event && isClassDeclaration(event)) {
                found.push({ relation: named, event });
            }
        } else if (named && isClassDeclaration(named)) {
            const candidates = foundingCandidatesInto(classDeclaration, named, relationsOf);
            if (candidates.length === 1) {
                found.push({ relation: candidates[0], event: named });
            }
        }
    }
    return found.filter((derivation, index) => found.findIndex(other =>
        other.relation === derivation.relation && other.event === derivation.event) === index);
}
