import type { ValidationAcceptor } from 'langium';
import { AstUtils } from 'langium';
import type { Cardinality, ClassDeclaration, Relation } from '../generated/ast.js';
import { isClassDeclaration, isRelation } from '../generated/ast.js';
import { collectAncestors, isSameOrSpecializes } from '../utils/generalizations.js';
import { targetsOf } from '../utils/relation-graph.js';
import { getRelationSource } from '../utils/relations.js';
import { possibleNaturesOf } from '../utils/nature-reasoning.js';
import { getBounds } from './cardinality-checks.js';
import type { ReverseLookup } from './incoming-relations.js';
import { mediates, mediationCapacity, readable } from './ufo-checks.js';

/**
 * What a derived relation may be derived from, by the stereotype that makes
 * it derived.
 *
 * A material relation is read off an extrinsic aspect: the relator binding
 * both ends -- someone works for a company because there is an employment --
 * or, when only one side is changed by it, an extrinsic mode inhering in one
 * end and depending on the other. A comparative relation is read off
 * intrinsic aspects: one person is taller than another because of their
 * heights. These are gUFO's ranges for `gufo:isDerivedFrom` too.
 */
const DERIVABLE_FROM: Readonly<Record<string, readonly string[]>> = {
    material: ['relators', 'extrinsic-modes'],
    comparative: ['qualities', 'intrinsic-modes']
};

/**
 * `derivedFrom` names what makes a derived relation hold, so only a derived
 * relation may carry it, and only something of the right nature may follow
 * it.
 *
 * The two derived stereotypes are the only relations UFO reads off something
 * else. Every other relation is itself the connection -- a mediation is the
 * relator's own dependence, a parthood is the whole's structure -- so a
 * `derivedFrom` on one of them names a ground for something that has none.
 */
export function checkDerivationIsWellFormed(relation: Relation, accept: ValidationAcceptor): void {
    if (relation.derivedFrom.length === 0) {
        return;
    }
    const admitted = relation.stereotype ? DERIVABLE_FROM[relation.stereotype] : undefined;
    if (!admitted) {
        const written = relation.stereotype ? `A "@${relation.stereotype}" relation` : 'A relation without a stereotype';
        accept(
            'error',
            `${written} is not derived from anything. Only a "@material" relation, read off a relator or extrinsic mode, and a "@comparative" one, read off qualities or intrinsic modes, have a "derivedFrom".`,
            { node: relation, keyword: 'derivedFrom', code: 'derivation-on-underived-relation' }
        );
        return;
    }
    relation.derivedFrom.forEach((reference, index) => {
        const ground = reference.ref;
        if (!ground || admits(relation.stereotype!, ground)) {
            return;
        }
        const natures = possibleNaturesOf(ground);
        const wanted = relation.stereotype === 'material'
            ? 'A material relation is derived from the relator binding its ends, or from an extrinsic mode'
            : 'A comparative relation is derived from the qualities, or intrinsic modes, of what it compares';
        accept(
            'error',
            `${wanted}, and "${ground.name}" classifies ${readable(natures)}.`,
            { node: relation, property: 'derivedFrom', index, code: 'derivation-source-nature' }
        );
    });
    if (relation.stereotype === 'material' && relation.derivedFrom.length > 1) {
        accept(
            'error',
            'A material relation is derived from one extrinsic aspect: a relator binding both ends or an extrinsic mode inhering in one and depending on the other. Write a relation for each distinct ground.',
            { node: relation, property: 'derivedFrom', index: 1, code: 'material-derived-from-many' }
        );
    }
}

/**
 * What a relation is derived from has to reach what it relates.
 *
 * A relator that does not mediate one of the ends cannot be why the two are
 * related, and a quality nothing at one end bears cannot be what compares it.
 * The mediation or characterization counts wherever it is written in the
 * lineage: a mediation of `Person` grounds a relation between two of its
 * roles, and a `Weight` characterizing `PhysicalObject` weighs every car.
 *
 * A material relation explicitly derived from a relator that does not bind
 * its ends is contradictory, and therefore an error. The other grounds stay
 * warnings: a model saying that a mode or quality reaches an end indirectly
 * may simply be unfinished, and which dependency is missing is still the
 * modeler's to say.
 */
export function checkDerivationIsGrounded(
    lookup: ReverseLookup, relation: Relation, accept: ValidationAcceptor
): void {
    const source = getRelationSource(relation);
    const target = relation.target?.ref;
    if (!source || !target || !isClassDeclaration(source) || !isClassDeclaration(target)) {
        return;
    }
    const ends = source === target ? [source] : [source, target];
    if (relation.stereotype === 'material') {
        relation.derivedFrom.forEach((reference, index) => {
            const ground = reference.ref;
            if (!ground || !admits('material', ground)) {
                return;
            }
            if (isExtrinsicMode(ground)) {
                if (!modeGrounds(lookup, ground, source, target)) {
                    accept(
                        'warning',
                        `An extrinsic mode grounds a material relation by inhering in one end and depending on the other, and "${ground.name}" does not: characterize one of "${source.name}" and "${target.name}" with it and give it an "@externalDependence" on the other.`,
                        { node: relation, property: 'derivedFrom', index, code: 'derivation-not-grounded' }
                    );
                }
                return;
            }
            if (source === target) {
                const capacity = mediationCapacity(lookup, ground, source);
                if (capacity !== undefined && capacity < 2) {
                    accept(
                        'error',
                        `A self material relation relates two "${source.name}" instances through one relator, but "${ground.name}"'s compatible mediations admit at most ${capacity}. Add another mediation of "${source.name}", make its mediated end multi-valued, or derive the relation from a relator that can bind two.`,
                        { node: relation, property: 'derivedFrom', index, code: 'derivation-not-grounded' }
                    );
                }
                return;
            }
            const unbound = ends.filter(end => !mediates(lookup, ground, end));
            if (unbound.length > 0) {
                const names = unbound.map(end => `"${end.name}"`).join(' or ');
                accept(
                    'error',
                    `A material relation holds because its relator binds both ends, and "${ground.name}" mediates nothing that is ${names}. Add the "@mediation", or derive the relation from the relator that has it.`,
                    { node: relation, property: 'derivedFrom', index, code: 'derivation-not-grounded' }
                );
            }
        });
    } else if (relation.stereotype === 'comparative') {
        const aspects = relation.derivedFrom.flatMap(reference =>
            reference.ref && admits('comparative', reference.ref) ? [reference.ref] : []);
        if (aspects.length === 0) {
            return;
        }
        for (const end of ends.filter(end => !aspects.some(aspect => bearsOrIs(lookup, end, aspect)))) {
            const names = aspects.map(aspect => `"${aspect.name}"`).join(' or ');
            accept(
                'warning',
                `A comparative relation compares what its ends bear, and nothing characterizes "${end.name}" with ${names}. Add the "@characterization", or derive the relation from what "${end.name}" does bear.`,
                { node: relation, keyword: 'derivedFrom', code: 'derivation-not-grounded' }
            );
        }
    }
}

export interface Multiplicity {
    lower: number;
    upper: number;
}

/** An omitted multiplicity is `[1]`; a malformed one is left to its own rule. */
function multiplicityOf(cardinality: Cardinality | undefined): Multiplicity | undefined {
    if (!cardinality) {
        return { lower: 1, upper: 1 };
    }
    const bounds = getBounds(cardinality);
    return bounds && bounds.lower <= bounds.upper && bounds.upper > 0 ? bounds : undefined;
}

/**
 * How many are reached by following two links in a row: `first` to each
 * intermediate, `second` from each. The upper bound multiplies, the most
 * there could be. The lower bound does not: distinct relators may reach the
 * same individual -- two employments with one employer -- so all that is
 * guaranteed is what one intermediate reaches, if there is one.
 */
function compose(first: Multiplicity, second: Multiplicity): Multiplicity {
    return {
        lower: first.lower > 0 ? second.lower : 0,
        upper: first.upper === Infinity || second.upper === Infinity
            ? Infinity
            : first.upper * second.upper
    };
}

export function writeMultiplicity(bounds: Multiplicity): string {
    const write = (value: number): string => value === Infinity ? '*' : String(value);
    return bounds.lower === bounds.upper
        ? `[${write(bounds.lower)}]`
        : `[${write(bounds.lower)}..${write(bounds.upper)}]`;
}

export interface DerivedMaterialCardinalities {
    source: Multiplicity;
    target: Multiplicity;
}

/**
 * The material multiplicities obtained by reading two mediations as a path.
 * `sourceMediation` reaches the material source and `targetMediation` reaches
 * its target. Nothing is returned while either mediation has malformed
 * bounds; its cardinality rule owns that error.
 */
export function derivedMaterialCardinalities(
    sourceMediation: Relation, targetMediation: Relation
): DerivedMaterialCardinalities | undefined {
    const relatorsPerSource = multiplicityOf(sourceMediation.sourceCardinality);
    const sourcesPerRelator = multiplicityOf(sourceMediation.targetCardinality);
    const relatorsPerTarget = multiplicityOf(targetMediation.sourceCardinality);
    const targetsPerRelator = multiplicityOf(targetMediation.targetCardinality);
    if (!relatorsPerSource || !sourcesPerRelator || !relatorsPerTarget || !targetsPerRelator) {
        return undefined;
    }
    return {
        source: compose(relatorsPerTarget, sourcesPerRelator),
        target: compose(relatorsPerSource, targetsPerRelator)
    };
}

/**
 * Mediations in the order they are written, when one file supplies that
 * order. A cross-file set has no earlier declaration and is left unresolved.
 */
export function mediationsInDocumentOrder(mediations: readonly Relation[]): Relation[] | undefined {
    if (mediations.length === 0) {
        return [];
    }
    const document = AstUtils.getDocument(mediations[0]).uri.toString();
    if (mediations.some(mediation =>
        !mediation.$cstNode || AstUtils.getDocument(mediation).uri.toString() !== document)) {
        return undefined;
    }
    return [...mediations].sort((left, right) => left.$cstNode!.offset - right.$cstNode!.offset);
}

/** The ground's own mediations whose mediated type is exactly `end`. */
function exactMediations(
    lookup: ReverseLookup, ground: ClassDeclaration, end: ClassDeclaration
): Relation[] {
    return [...new Set(lookup.touching(ground))].filter(candidate =>
        candidate.stereotype === 'mediation'
        && getRelationSource(candidate) === ground
        && candidate.target?.ref === end);
}

/** Whether this ground is known to classify relators, rather than modes or an unresolved nature. */
function isRelator(ground: ClassDeclaration): boolean {
    const natures = possibleNaturesOf(ground);
    return !!natures && natures.size > 0 && [...natures].every(nature => nature === 'relators');
}

/**
 * The multiplicities of a material relation follow from the two mediation
 * paths through its relator.
 *
 * For `R [rPerS] -- [sPerR] S` and `R [rPerT] -- [tPerR] T`, the `S`s per `T`
 * are at most `rPerT * sPerR`, and at least `sPerR`'s lower bound wherever a
 * `T` has a relator at all -- two relators may bind the same pair, so lower
 * bounds do not multiply. The other end is derived the same way. This is
 * calculated only from one exact mediation to each distinct end. For a self
 * relation, exactly two same-typed mediations in one file are ordered: the
 * earlier one supplies the source role and the later one the target role --
 * and of two inverse declarations both derived from the relator, the later
 * one is the same association read backwards, so it reads them crossed. A
 * mediation inherited from a supertype establishes that the derivation is
 * grounded, but does not determine how many instances of a subtype take part.
 *
 * What is written is compared with what is derived. A multiplicity no count
 * could satisfy alongside the derivation contradicts it, an error. One that
 * admits counts the derivation rules out says less than the model already
 * does, a warning narrowed to what both allow. One that is narrower is a
 * further constraint, which a derived relation may state -- someone with two
 * employments may still work for one employer -- so it is only pointed out.
 */
export function checkMaterialCardinalitiesAreDerived(
    lookup: ReverseLookup, relation: Relation, accept: ValidationAcceptor
): void {
    if (relation.stereotype !== 'material' || relation.derivedFrom.length !== 1) {
        return;
    }
    const source = getRelationSource(relation);
    const target = relation.target?.ref;
    const ground = relation.derivedFrom[0].ref;
    if (!source || !target || !isClassDeclaration(source) || !isClassDeclaration(target)
        || !ground || !isRelator(ground)) {
        return;
    }

    const sourceMediations = exactMediations(lookup, ground, source);
    const targetMediations = exactMediations(lookup, ground, target);
    let sourceMediation: Relation | undefined;
    let targetMediation: Relation | undefined;
    if (source === target && sourceMediations.length === 2) {
        const ordered = mediationsInDocumentOrder(sourceMediations);
        if (ordered) {
            [sourceMediation, targetMediation] = readsBackwards(lookup, relation, ground)
                ? [ordered[1], ordered[0]]
                : ordered;
        }
    } else if (source !== target && sourceMediations.length === 1 && targetMediations.length === 1) {
        [sourceMediation] = sourceMediations;
        [targetMediation] = targetMediations;
    }
    if (!sourceMediation || !targetMediation) {
        const selfAcrossFiles = source === target && sourceMediations.length === 2;
        const ambiguousSource = sourceMediations.length > (source === target ? 2 : 1);
        const ambiguousTarget = source !== target && targetMediations.length > 1;
        if (!selfAcrossFiles && !ambiguousSource && !ambiguousTarget) {
            return;
        }
        const ambiguous = [
            sourceMediations.length > 1 ? `"${source.name}" (${sourceMediations.length})` : undefined,
            source !== target && targetMediations.length > 1
                ? `"${target.name}" (${targetMediations.length})`
                : undefined
        ].filter((name): name is string => !!name).join(' and ');
        accept(
            'warning',
            selfAcrossFiles
                ? `A self material relation reads its source from the earlier mediation and its target from the later one, but "${ground.name}"'s two mediations of "${source.name}" are written in different files and have no such order.`
                : `The cardinalities of a material relation come from one mediation to each end, but "${ground.name}" has several exact mediations to ${ambiguous}. The model does not say which mediation roles this relation reads.`,
            { node: relation, property: 'derivedFrom', index: 0, code: 'material-cardinality-ambiguous' }
        );
        return;
    }
    const expected = derivedMaterialCardinalities(sourceMediation, targetMediation);
    if (!expected) {
        return;
    }
    for (const side of ['source', 'target'] as const) {
        const cardinality = side === 'source' ? relation.sourceCardinality : relation.targetCardinality;
        const actual = multiplicityOf(cardinality);
        const derived = expected[side];
        if (!actual || (actual.lower === derived.lower && actual.upper === derived.upper)) {
            continue;
        }
        const written = writeMultiplicity(actual);
        const derives = writeMultiplicity(derived);
        const where = {
            node: cardinality ?? relation,
            ...(cardinality ? {} : { property: side === 'source' ? 'sourceCardinality' : 'targetCardinality' })
        } as const;
        if (actual.lower > derived.upper || actual.upper < derived.lower) {
            accept(
                'error',
                `The material relation's ${side} end is ${written}, but the two mediations through "${ground.name}" derive ${derives}, and no number satisfies both.`,
                { ...where, code: 'material-cardinality-mismatch', data: { side, replacement: derives } }
            );
        } else if (actual.lower < derived.lower || actual.upper > derived.upper) {
            const both = writeMultiplicity({
                lower: Math.max(actual.lower, derived.lower),
                upper: Math.min(actual.upper, derived.upper)
            });
            accept(
                'warning',
                `The material relation's ${side} end is ${written}, but the two mediations through "${ground.name}" derive ${derives}: it allows what they rule out. Write ${both}.`,
                { ...where, code: 'material-cardinality-weaker', data: { side, replacement: both } }
            );
        } else {
            accept(
                'hint',
                `The material relation's ${side} end is ${written}, narrower than the ${derives} the two mediations through "${ground.name}" derive -- a constraint of its own, which the relator does not impose.`,
                { ...where, code: 'material-cardinality-narrower', data: { side, replacement: derives } }
            );
        }
    }
}

/**
 * Whether this self material relation is the later of two inverse
 * declarations derived from the same relator, and so reads its mediations
 * crossed. Where only one of the two names the relator, that one reads them
 * in order and the other is held to it by `inverse-ends-differ`.
 */
function readsBackwards(lookup: ReverseLookup, relation: Relation, ground: ClassDeclaration): boolean {
    const partners = new Set<Relation>([
        ...(relation.inverseOf?.ref ? [relation.inverseOf.ref] : []),
        ...lookup.referrers(relation).filter((referrer): referrer is Relation =>
            isRelation(referrer) && referrer.inverseOf?.ref === relation)
    ]);
    return [...partners].some(partner => partner !== relation
        && partner.stereotype === 'material'
        && partner.derivedFrom.length === 1
        && partner.derivedFrom[0].ref === ground
        && writtenBefore(partner, relation));
}

/** Declaration order: by offset within a file, by URI across files. */
function writtenBefore(first: Relation, second: Relation): boolean {
    const one = AstUtils.getDocument(first).uri.toString();
    const other = AstUtils.getDocument(second).uri.toString();
    return one === other
        ? (first.$cstNode?.offset ?? 0) < (second.$cstNode?.offset ?? 0)
        : one < other;
}

/**
 * Whether this may be what a relation of the stereotype is derived from. A
 * class whose natures are unknown is given the benefit of the doubt, as
 * everywhere else natures are read.
 */
export function admits(stereotype: string, ground: ClassDeclaration): boolean {
    const natures = possibleNaturesOf(ground);
    return !natures || natures.size === 0 || [...natures].every(nature => DERIVABLE_FROM[stereotype]?.includes(nature));
}

function isExtrinsicMode(classDeclaration: ClassDeclaration): boolean {
    const natures = possibleNaturesOf(classDeclaration);
    return !!natures && natures.size > 0 && [...natures].every(nature => nature === 'extrinsic-modes');
}

/** The classes a moment reaches by a relation of this stereotype, its supertypes' included. */
function reached(lookup: ReverseLookup, moment: ClassDeclaration, stereotype: string): ClassDeclaration[] {
    return [moment, ...collectAncestors(moment)].flatMap(member => targetsOf(lookup, member, new Set([stereotype])));
}

/** Whether `end` is one of the classes reached, or specializes one: a car is a physical object. */
function reaches(classes: readonly ClassDeclaration[], end: ClassDeclaration): boolean {
    return classes.some(reachedClass => isSameOrSpecializes(end, reachedClass));
}

function modeGrounds(
    lookup: ReverseLookup, mode: ClassDeclaration, source: ClassDeclaration, target: ClassDeclaration
): boolean {
    const bearers = reached(lookup, mode, 'characterization');
    const dependees = reached(lookup, mode, 'externalDependence');
    return (reaches(bearers, source) && reaches(dependees, target))
        || (reaches(bearers, target) && reaches(dependees, source));
}

/**
 * Whether an end bears the aspect, or is it: `greaterThan` between two
 * heights compares the heights themselves.
 */
function bearsOrIs(lookup: ReverseLookup, end: ClassDeclaration, aspect: ClassDeclaration): boolean {
    return isSameOrSpecializes(end, aspect) || reaches(reached(lookup, aspect, 'characterization'), end);
}
