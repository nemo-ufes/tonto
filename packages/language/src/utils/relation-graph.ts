import type { Cardinality, ClassDeclaration, Relation } from '../generated/ast.js';
import { isClassDeclaration } from '../generated/ast.js';
import type { ReverseLookup } from '../validation/incoming-relations.js';
import { getBounds } from '../validation/cardinality-checks.js';
import { collectAncestors } from './generalizations.js';
import { getRelationSource, isParthood, wholeEndOf } from './relations.js';

/**
 * Walking the graph a relation stereotype draws between classes.
 *
 * Several UFO relations are irreflexive and asymmetric -- inherence,
 * constitution, parthood, instantiation -- and each of those forbids a cycle
 * for the same reason: following the relation always moves to something
 * strictly further from where you started, so it cannot lead back. Rather
 * than four hand-written traversals, each check supplies the edges it cares
 * about and shares one search.
 */

/** A path from `start` back to itself, naming the classes along the way. */
export function findCycle(
    start: ClassDeclaration,
    successors: (node: ClassDeclaration) => ClassDeclaration[]
): string[] | undefined {
    const walk = (current: ClassDeclaration, seen: Set<ClassDeclaration>, path: string[]): string[] | undefined => {
        if (seen.has(current)) {
            return undefined;
        }
        seen.add(current);
        for (const next of successors(current)) {
            if (next === start) {
                return [...path, next.name];
            }
            const found = walk(next, seen, [...path, next.name]);
            if (found) {
                return found;
            }
        }
        return undefined;
    };
    return walk(start, new Set(), []);
}

/**
 * The classes a relation of one of these stereotypes points at, source to
 * target. With `mandatoryOnly`, just those the source cannot do without --
 * a lower bound of at least one at the target end.
 *
 * The distinction is what separates a legitimate recursive type from a
 * contradiction. A type diagram says nothing about which *individuals* stand in
 * a relation, so a cycle among types entails nothing on its own. It entails
 * something only when every step is mandatory: then each individual needs
 * another, which needs another, and the chain never terminates.
 */
export function targetsOf(
    lookup: ReverseLookup, source: ClassDeclaration, stereotypes: ReadonlySet<string>,
    mandatoryOnly = false
): ClassDeclaration[] {
    const targets: ClassDeclaration[] = [];
    for (const relation of lookup.touching(source)) {
        if (!relation.stereotype || !stereotypes.has(relation.stereotype)) {
            continue;
        }
        if (getRelationSource(relation) !== source) {
            continue;
        }
        if (mandatoryOnly && !isMandatory(relation.targetCardinality)) {
            continue;
        }
        const target = relation.target?.ref;
        if (target && isClassDeclaration(target)) {
            targets.push(target);
        }
    }
    return targets;
}

/**
 * Whether the model says this end must be filled.
 *
 * An omitted multiplicity means exactly one, here as everywhere else in
 * tonto: `@componenthood <>-- Node` inside `Node` says every node has a node
 * for a part, and that is a claim about individuals however briefly it is
 * written. This used to require the bound to be *written*, on the grounds
 * that an error calling a model unsatisfiable should not rest on a default --
 * but the end it reads is the one at the far side, and the example that
 * worried about (`@componenthood <>-- [*] Part`) has its bound written there.
 * What was left blank in it is the whole's end, which nothing here reads.
 */
function isMandatory(cardinality: Cardinality | undefined): boolean {
    const bounds = cardinality ? getBounds(cardinality) : { lower: 1, upper: 1 };
    return !!bounds && bounds.lower >= 1;
}

/**
 * The parts this class must have -- those whose part end has a lower bound of
 * at least one, so every individual of the whole needs one.
 */
export function mandatoryPartsOf(lookup: ReverseLookup, whole: ClassDeclaration): ClassDeclaration[] {
    // A parthood declared at a supertype holds of everything under it: what a
    // vehicle must contain, a car must contain. Reading only the relations
    // written at the class itself missed every cycle that runs through an
    // inherited one.
    return [whole, ...collectAncestors(whole)]
        .flatMap(member => parthoodsWholedBy(lookup, member))
        .filter(parthood => parthood.mandatory)
        .map(parthood => parthood.part);
}

/** One end of a parthood relation, with the multiplicity written at the part. */
export interface Parthood {
    part: ClassDeclaration;
    whole: ClassDeclaration;
    relation: Relation;
    /** Lower bound at the part end; an omitted multiplicity means one. */
    least: number;
    /** Whether the model explicitly requires at least one such part. */
    mandatory: boolean;
}

/**
 * The parthood relations this class is the *whole* of, from anywhere in the
 * workspace.
 *
 * Which end is the whole comes from the aggregation diamond, not the writing
 * order, so the multiplicity that matters is the one beside the other end.
 */
export function parthoodsWholedBy(lookup: ReverseLookup, whole: ClassDeclaration): Parthood[] {
    const found: Parthood[] = [];
    for (const relation of lookup.touching(whole)) {
        if (!isParthood(relation)) {
            continue;
        }
        const source = getRelationSource(relation);
        const target = relation.target?.ref;
        if (!isClassDeclaration(source) || !target || !isClassDeclaration(target)) {
            continue;
        }
        const wholeIsSource = wholeEndOf(relation) === 'source';
        const wholeEnd = wholeIsSource ? source : target;
        const partEnd = wholeIsSource ? target : source;
        // Self-parthood is kept: `Part <>-- [1..*] Part` is exactly the
        // shape that forces an unending chain, and the caller decides.
        if (wholeEnd !== whole) {
            continue;
        }
        const cardinality = wholeIsSource ? relation.targetCardinality : relation.sourceCardinality;
        const bounds = cardinality ? getBounds(cardinality) : { lower: 1, upper: 1 };
        found.push({
            part: partEnd, whole, relation,
            least: bounds ? bounds.lower : 1,
            mandatory: isMandatory(cardinality)
        });
    }
    return found;
}

/**
 * The classes this one must be a *part of* -- those whose whole end has a
 * lower bound of at least one, so every individual of the part belongs to one.
 *
 * The mirror of `mandatoryPartsOf`, and unsatisfiable for the mirror reason:
 * where the parts of a required decomposition never bottom out, the wholes of
 * a required one never top out.
 *
 * Both ends are read the same way, written or not: a diamond with nothing
 * beside it says exactly one whole, which is what makes `<>--` the whole of
 * the notation -- `<o>--` was dropped because it said no more than `[1] <>--`
 * already does. So `kind Node { @componenthood <>-- [0..1] Node }` is a
 * claim that every node is a component of exactly one node, and a tree is
 * written `[0..1] <>--`.
 */
export function mandatoryWholesOf(lookup: ReverseLookup, part: ClassDeclaration): ClassDeclaration[] {
    // Inherited the same way, and for the same reason: if every node belongs
    // to a complex node, so does every complex node.
    return [part, ...collectAncestors(part)].flatMap(member => wholesRequiring(lookup, member));
}

/** The wholes an individual of this class must belong to, by the relations written at it. */
function wholesRequiring(lookup: ReverseLookup, member: ClassDeclaration): ClassDeclaration[] {
    const found: ClassDeclaration[] = [];
    for (const relation of lookup.touching(member)) {
        if (!isParthood(relation)) {
            continue;
        }
        const source = getRelationSource(relation);
        const target = relation.target?.ref;
        if (!isClassDeclaration(source) || !target || !isClassDeclaration(target)) {
            continue;
        }
        const wholeIsSource = wholeEndOf(relation) === 'source';
        const whole = wholeIsSource ? source : target;
        const partEnd = wholeIsSource ? target : source;
        // The multiplicity beside the whole says how many wholes each part
        // belongs to, which is the one this reads.
        const cardinality = wholeIsSource ? relation.sourceCardinality : relation.targetCardinality;
        if (partEnd === member && isMandatory(cardinality)) {
            found.push(whole);
        }
    }
    return found;
}

/** The ultimate sortal a class draws identity from, if one is reachable. */
export function ultimateSortalOf(
    classDeclaration: ClassDeclaration, isUltimate: (stereotype: string) => boolean
): ClassDeclaration | undefined {
    for (const member of [classDeclaration, ...collectAncestors(classDeclaration)]) {
        if (isUltimate(member.stereotype)) {
            return member;
        }
    }
    return undefined;
}
