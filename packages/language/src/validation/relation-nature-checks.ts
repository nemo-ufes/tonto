import type { ValidationAcceptor } from 'langium';
import type {
    ClassDeclaration, Relation, RelationEndMetaAttributes, RelationEndTarget
} from '../generated/ast.js';
import { isClassDeclaration } from '../generated/ast.js';
import { getAssumedNatures } from '../utils/natures.js';
import { classifiesOnly, possibleNaturesOf } from '../utils/nature-reasoning.js';
import { getRelationSource, isParthood, wholeEndOf } from '../utils/relations.js';
import { collectAncestors } from '../utils/generalizations.js';
import { cannotShareInstances } from '../utils/disjointness.js';
import { formatBounds, getBounds } from './cardinality-checks.js';
import type { ReverseLookup } from './incoming-relations.js';
import { IMMUTABLE_NATURES } from './natures.js';
import { isAntiRigid, isSemiRigid } from './stereotype-model.js';
import {
    naturesFor, PART_WHOLE_STEREOTYPES, PARTHOOD_NATURE_PAIRS, signatureOf, TABLE_NATURE_NAMES
} from './relation-nature-table.js';

/**
 * The natures of whatever a relation end names.
 *
 * A relation end may name a datatype or an enumeration as well as a class,
 * and those classify abstract individuals -- values, which are outside time
 * and outside the nature lattice's concrete half. Reading only classes left
 * every nature check silent about them, so `collective C { @membership [*]
 * <>-- [2..*] date }` had a plurality of dates in it and nothing to say.
 */
function endNatures(end: RelationEndTarget): string[] | undefined {
    return isClassDeclaration(end)
        ? tableNatures(end)
        : [TABLE_NATURE_NAMES['abstract-individuals']];
}


/** The natures a class's instances can have, in the table's vocabulary. */
function tableNatures(classDeclaration: ClassDeclaration): string[] | undefined {
    const assumed = getAssumedNatures(classDeclaration);
    if (!assumed) {
        return undefined;
    }
    const names = [...assumed]
        .map(nature => TABLE_NATURE_NAMES[nature])
        .filter((name): name is string => !!name);
    return names.length > 0 ? names : undefined;
}

interface Ends {
    /** What the table expects first. */
    first: RelationEndTarget;
    /** What the table expects second. */
    second: RelationEndTarget;
    /** How to describe the orientation in a diagnostic. */
    firstRole: string;
    secondRole: string;
}

/**
 * The pair of classes to look up, in the order the table expects.
 *
 * For most stereotypes that is simply (source, target). For parthood it is
 * (whole, part), and which end is the whole is told by the aggregation
 * diamond -- `<>--`/`<>--` put the whole at the source, `--<>`/`--<>` at
 * the target -- not by the writing order.
 */
function relationNaturePair(relation: Relation, source: RelationEndTarget, target: RelationEndTarget): Ends {
    if (!PART_WHOLE_STEREOTYPES.has(relation.stereotype ?? '')) {
        return { first: source, second: target, firstRole: 'source', secondRole: 'target' };
    }
    // The table reads (whole, part), which is the order written when the
    // diamond is at the source -- or absent, which means the same.
    return wholeEndOf(relation) === 'source'
        ? { first: source, second: target, firstRole: 'whole', secondRole: 'part' }
        : { first: target, second: source, firstRole: 'whole', secondRole: 'part' };
}

function permits(stereotype: string, firsts: string[], seconds: string[]): boolean {
    const allowed = naturesFor(stereotype) ?? [];
    return firsts.some(first => seconds.some(second => allowed.includes(`${first}:${second}`)));
}

/**
 * Whether a relation's ends would still be admissible if this class's
 * instances could only have these natures -- what a repair that narrows a
 * class asks before offering to. A relation already inadmissible stays
 * whatever it was, so only one the narrowing would break answers no.
 */
export function stillAdmitsWhenNarrowed(
    relation: Relation, classDeclaration: ClassDeclaration, natures: ReadonlySet<string>
): boolean {
    const stereotype = relation.stereotype;
    const source = getRelationSource(relation);
    const target = relation.target?.ref;
    if (!stereotype || !naturesFor(stereotype) || !source || !target) {
        return true;
    }
    const ends = relationNaturePair(relation, source, target);
    const narrowed = [...natures].map(nature => TABLE_NATURE_NAMES[nature]).filter((name): name is string => !!name);
    const naturesAt = (end: RelationEndTarget, narrow: boolean): string[] | undefined =>
        narrow && end === classDeclaration ? narrowed : endNatures(end);
    const now = [naturesAt(ends.first, false), naturesAt(ends.second, false)];
    const after = [naturesAt(ends.first, true), naturesAt(ends.second, true)];
    if (!now[0] || !now[1] || !after[0] || !after[1]) {
        return true;
    }
    return !permits(stereotype, now[0], now[1]) || permits(stereotype, after[0], after[1]);
}

/** The natures of moments, which inhere in exactly one bearer. */
const MOMENT_NATURES = new Set(['intrinsic-mode', 'extrinsic-mode', 'quality', 'relator']);

/**
 * A characterized moment inheres in exactly one bearer, so the bearer end of
 * a `@characterization` must be `[1]`.
 *
 * The bearer is the target, matching the table's `moment:bearer` orientation.
 * When the source is not moment-natured the relation is written the wrong way
 * round -- reported by `checkRelationStereotypeNatures` -- and this stays
 * quiet rather than adding a second, confusing complaint about the end that
 * is not actually the bearer.
 */
export function checkCharacterizationBearerCardinality(relation: Relation, accept: ValidationAcceptor): void {
    if (relation.stereotype !== 'characterization') {
        return;
    }
    const cardinality = relation.targetCardinality;
    if (!cardinality) {
        // An omitted multiplicity already means exactly one.
        return;
    }
    const source = getRelationSource(relation);
    if (!source || !isClassDeclaration(source)) {
        return;
    }
    const sourceNatures = tableNatures(source);
    if (!sourceNatures || !sourceNatures.some(nature => MOMENT_NATURES.has(nature))) {
        return;
    }
    const bounds = getBounds(cardinality);
    if (bounds && (bounds.lower !== 1 || bounds.upper !== 1)) {
        accept(
            'error',
            `A characterized moment inheres in exactly one bearer, so the bearer end must be [1], not ${formatBounds(cardinality)}.`,
            { node: cardinality, code: 'characterization-bearer-multiplicity' }
        );
    }
}

/** The part end of a parthood, which the diamond decides rather than the writing order. */
function partOf(relation: Relation): RelationEndTarget | undefined {
    return wholeEndOf(relation) === 'source' ? relation.target?.ref : getRelationSource(relation);
}

/** The whole end of a parthood. */
export function wholeOf(relation: Relation): RelationEndTarget | undefined {
    return wholeEndOf(relation) === 'source' ? getRelationSource(relation) : relation.target?.ref;
}

/**
 * The `@participational` parthoods that make this event type a portion: those
 * naming it, or a type above it, as the part.
 */
export function participationalParthoods(lookup: ReverseLookup, event: ClassDeclaration): Relation[] {
    return [event, ...collectAncestors(event)].flatMap(candidate =>
        lookup.touching(candidate).filter(relation =>
            relation.stereotype === 'participational' && partOf(relation) === candidate));
}

/** Whether this event type, or an event type above it, is a participational portion. */
export function isParticipationalPortion(lookup: ReverseLookup, event: ClassDeclaration): boolean {
    return participationalParthoods(lookup, event).length > 0;
}

/** A `@participation` that every instance of an event type has to have. */
export interface RequiredParticipation {
    relation: Relation;
    participant: ClassDeclaration;
}

export interface PortionParticipantConflict {
    /**
     * `error` where two of the required participants cannot be one
     * individual; `warning` where they can, so the model forces them to be.
     */
    severity: 'error' | 'warning';
    /** The two participations the diagnostic names. */
    pair: [RequiredParticipation, RequiredParticipation];
    required: RequiredParticipation[];
}

/**
 * The participations an instance of this event type must have: every
 * `@participation` into it or into a type above it -- an instance of the type
 * is an instance of each of those -- whose participant end requires at least
 * one. An omitted multiplicity is exactly one, here as everywhere else.
 *
 * A participation into a type *below* is not counted: it constrains only the
 * instances of that subtype, which is checked as a portion in its own right.
 */
export function requiredParticipations(lookup: ReverseLookup, event: ClassDeclaration): RequiredParticipation[] {
    const found: RequiredParticipation[] = [];
    const seen = new Set<Relation>();
    for (const candidate of [event, ...collectAncestors(event)]) {
        for (const relation of lookup.touching(candidate)) {
            if (seen.has(relation) || relation.stereotype !== 'participation' || relation.target?.ref !== candidate) {
                continue;
            }
            seen.add(relation);
            const participant = getRelationSource(relation);
            const bounds = relation.sourceCardinality ? getBounds(relation.sourceCardinality) : { lower: 1, upper: 1 };
            if (participant && isClassDeclaration(participant) && bounds && bounds.lower >= 1) {
                found.push({ relation, participant });
            }
        }
    }
    return found;
}

/**
 * Two participations that each require a participant, in a portion that has
 * exactly one.
 *
 * Reading the relations one at a time cannot see it: each says one, and the
 * portion has two. Where the two participants cannot be one individual --
 * distinct kinds, a disjoint set between them, natures with nothing in
 * common -- no portion satisfies the model. Where they can, every portion
 * does, but only by the two being the same individual every time.
 */
export function portionParticipantConflict(
    lookup: ReverseLookup, event: ClassDeclaration
): PortionParticipantConflict | undefined {
    if (!isParticipationalPortion(lookup, event)) {
        return undefined;
    }
    const required = requiredParticipations(lookup, event);
    if (required.length < 2) {
        // One relation requiring two is the per-relation rule's to report.
        return undefined;
    }
    for (let i = 0; i < required.length; i++) {
        for (let j = i + 1; j < required.length; j++) {
            if (cannotShareInstances(required[i].participant, required[j].participant)) {
                return { severity: 'error', pair: [required[i], required[j]], required };
            }
        }
    }
    return { severity: 'warning', pair: [required[0], required[1]], required };
}

function describeParticipation({ relation, participant }: RequiredParticipation): string {
    return relation.name ? `"${participant.name}" (${relation.name})` : `"${participant.name}"`;
}

/**
 * A participational portion is projected by exclusive dependence on one
 * endurant (UFO-B), so it has exactly one participant -- which is what gUFO
 * axiomatizes as `gufo:Participation`'s single participant, and how a reasoner
 * found it in a model this check passed. Two participations that each require
 * one, into the portion or a type above it, contradict that.
 *
 * Reported on the portion, where the two meet, and once: a subtype that only
 * inherits its supertype's conflict is not reported again.
 */
export function checkParticipationalPortionParticipantsAgree(
    lookup: ReverseLookup, event: ClassDeclaration, accept: ValidationAcceptor
): void {
    const conflict = portionParticipantConflict(lookup, event);
    if (!conflict) {
        return;
    }
    const inherited = [...collectAncestors(event)]
        .some(ancestor => portionParticipantConflict(lookup, ancestor)?.severity === conflict.severity);
    if (inherited) {
        return;
    }
    const [first, second] = conflict.pair.map(describeParticipation);
    if (conflict.severity === 'error') {
        accept(
            'error',
            `"${event.name}" is a participational portion, which depends on exactly one endurant, but ${first} and ${second} must each take part in every one, and nothing is both. Make the parthood "@structural" if the part is not one participant's, or move one participation to the whole event.`,
            { node: event, property: 'name', code: 'participational-portion-two-participants' }
        );
        return;
    }
    accept(
        'warning',
        `"${event.name}" is a participational portion, which depends on exactly one endurant, and ${first} and ${second} must each take part in every one -- so they are always the same individual. If they need not be, make the parthood "@structural", or move one participation to the whole event.`,
        { node: event, property: 'name', code: 'participational-portion-participants-coincide' }
    );
}

/**
 * A participational portion is projected by exclusive dependence on one
 * endurant.  A meeting may have many participants; John's participation in
 * it may not.  The source end of `@participation` is the end typed by that
 * participant, so its upper bound is the constraint to read.
 */
export function checkParticipationalPortionHasOneParticipant(
    lookup: ReverseLookup, relation: Relation, accept: ValidationAcceptor
): void {
    if (relation.stereotype !== 'participation') {
        return;
    }
    const event = relation.target?.ref;
    if (!event || !isClassDeclaration(event) || !isParticipationalPortion(lookup, event)) {
        return;
    }
    const cardinality = relation.sourceCardinality;
    const bounds = cardinality ? getBounds(cardinality) : { lower: 1, upper: 1 };
    if (!cardinality || !bounds || bounds.upper <= 1) {
        return;
    }
    accept(
        'error',
        `A participational portion depends exclusively on one endurant, so the participant end's maximum must be 1, not ${formatBounds(cardinality)}.`,
        { node: cardinality, code: 'participational-portion-multiple-participants' }
    );
}

/**
 * Checks a relation's stereotype against the ontological natures of the
 * classes at its ends -- that `@mediation` starts from a relator, that
 * `@membership` has a collective for its whole, that `@instantiation` targets a
 * high-order type, and so on.
 *
 * A class whose nature cannot be determined, and a stereotype the table does
 * not cover, are both left alone. Following the reference implementation
 * (`OntoUMLConstraintsManager.isStereotypeAllowed`), a class restricted to
 * several natures only needs *one* combination to be admissible.
 */
export function checkRelationStereotypeNatures(relation: Relation, accept: ValidationAcceptor): void {
    const stereotype = relation.stereotype;
    if (!stereotype || !naturesFor(stereotype)) {
        return;
    }
    const source = getRelationSource(relation);
    const target = relation.target?.ref;
    if (!source || !target) {
        return;
    }

    const ends = relationNaturePair(relation, source, target);
    const firsts = endNatures(ends.first);
    const seconds = endNatures(ends.second);
    if (!firsts || !seconds) {
        return;
    }
    if (permits(stereotype, firsts, seconds)) {
        return;
    }

    if (characterizedPerdurant(relation)) {
        // Said better, and with what to write instead, by
        // `checkCharacterizationIsReified`.
        return;
    }
    // Reversing the ends is the single most common cause, so say so rather
    // than only reporting that the combination is wrong.
    const reversed = permits(stereotype, seconds, firsts);
    // What it *does* relate, where that can be said in a phrase. Several
    // stereotypes close over a category rather than crossing two, and their
    // signature reads as a sentence about the table rather than as an answer;
    // `tonto explain` is the place for those.
    const signature = signatureOf(stereotype);
    const runs = signature.includes('→') && !signature.includes('/') ? ` It runs ${signature}.` : '';
    const detail = reversed
        ? ` The reverse direction is allowed, so the ends may be the wrong way round.`
        : runs;
    accept(
        'error',
        `"@${stereotype}" cannot relate ${ends.firstRole} "${ends.first.name}" (${firsts.join(', ')}) to ${ends.secondRole} "${ends.second.name}" (${seconds.join(', ')}).${detail}`,
        {
            node: relation,
            ...(relation.stereotype ? { property: 'stereotype' as const } : {}),
            // Only the reversible case has a mechanical repair, and it gets
            // its own code for that reason -- but both need one, or the
            // plain mismatch reaches a reader with no code at all.
            code: reversed ? 'relation-ends-reversed' : 'relation-end-nature-mismatch'
        }
    );
}

/**
 * Parthood admits only its defined pairs of ontological natures.
 *
 * A diamond states parthood whether or not a stereotype is written, and an
 * unstereotyped one used to say anything at all: `event Wedding { <>-- Guest }`
 * with `Guest` a functional complex was accepted, making an object part of an
 * event. Most parts share the whole's nature -- an event has events as parts,
 * a situation situations, a quality qualities. A relator can also have
 * extrinsic modes as parts. `PARTHOOD_NATURE_PAIRS` carries these alongside
 * the crossings the substantial stereotypes allow.
 *
 * Stereotyped parthood is left to `checkRelationStereotypeNatures`, which
 * tests the stereotype's own row and is stricter than this.
 */
export function checkParthoodNatures(relation: Relation, accept: ValidationAcceptor): void {
    if ((relation.stereotype && naturesFor(relation.stereotype)) || !isParthood(relation)) {
        return;
    }
    const source = getRelationSource(relation);
    const target = relation.target?.ref;
    if (!source || !target) {
        return;
    }
    const wholeIsSource = wholeEndOf(relation) === 'source';
    const whole = wholeIsSource ? source : target;
    const part = wholeIsSource ? target : source;
    const wholes = endNatures(whole);
    const parts = endNatures(part);
    if (!wholes || !parts || admitsParthood(wholes, parts)) {
        return;
    }
    // Putting the diamond on the wrong end is the common slip, and the only
    // one with a mechanical repair.
    const reversed = admitsParthood(parts, wholes);
    const detail = reversed ? ' The diamond may be at the wrong end.' : '';
    accept(
        'error',
        `Parthood does not admit whole "${whole.name}" (${wholes.join(', ')}) with part "${part.name}" (${parts.join(', ')}).${detail}`,
        { node: relation, code: 'parthood-crosses-natures', data: { reversed } }
    );
}

function admitsParthood(wholes: string[], parts: string[]): boolean {
    return wholes.some(whole => parts.some(part => PARTHOOD_NATURE_PAIRS.has(`${whole}:${part}`)));
}

/**
 * The natures whose instances cannot change: an event is over, a situation is
 * fact-like -- its constituents and their properties are what it is, so
 * altering them would be a different situation, and what we call a situation
 * changing is a later one obtaining in place of an earlier -- and an abstract
 * individual is outside time.
 *
 * A situation has a mereological exception: it may accumulate parts. An
 * immutable individual may also acquire an outward history without itself
 * changing -- what later stands in a situation, what a situation triggers,
 * or what an event brings about belongs to the changing world around it.
 */
// The natures whose instances cannot change, which is the complement of what
// anti-rigidity needs -- so it is read off the nature table rather than
// written out again beside it.
export { IMMUTABLE_NATURES };

/** Whether nothing about this class's instances can change, ever. */
export function hasImmutableInstances(classDeclaration: ClassDeclaration): boolean {
    const natures = possibleNaturesOf(classDeclaration);
    return !!natures && natures.size > 0 && [...natures].every(nature => IMMUTABLE_NATURES.has(nature));
}

function isConst(end: RelationEndMetaAttributes | undefined): boolean {
    return !!end?.isConst;
}

/**
 * The end of a historical dependence that holds the dependents.
 *
 * What it points at is over -- that is what makes the dependence historical --
 * so the immutability rules would have this end `(const)` like any other
 * property of an event. They are wrong about this one: the past thing does
 * not change when something new comes to depend on it, the world around it
 * does, and the set of former students of a graduation or of bakings in an
 * oven goes on growing for as long as there are more of them. `(addOnly)` is
 * the word, and `checkAccumulates` asks for it.
 */
export function holdsDependents(relation: Relation, side: 'source' | 'target'): boolean {
    return side === 'source' && relation.stereotype === 'historicalDependence';
}

/**
 * A history may grow without the individual whose history it is changing.
 *
 * Besides historical dependents, an entity may stand in further situations,
 * a situation may eventually trigger an event, and an event or process may
 * eventually bring a situation about. These ends describe what accrued
 * around an otherwise settled individual, so `addOnly` is a legitimate
 * alternative to closing the history with `const`.
 */
export function holdsAccumulatingHistory(relation: Relation, side: 'source' | 'target'): boolean {
    return holdsDependents(relation, side)
        || (side === 'source' && relation.stereotype === 'presence')
        || (side === 'target' && (relation.stereotype === 'triggering' || relation.stereotype === 'bringingAbout'));
}

/**
 * A past event keeps its participants and the links to them. A source type
 * whose membership can lapse cannot describe those same individuals for the
 * lifetime of the historical link: a graduate remains the participant after
 * ceasing to be a student. The temporal role at the event is a separate claim.
 */
export function checkHistoricalEventSourceCanLapse(relation: Relation, accept: ValidationAcceptor): void {
    if (!['participation', 'creation', 'termination', 'change'].includes(relation.stereotype ?? '')) {
        return;
    }
    const source = getRelationSource(relation);
    const target = relation.target?.ref;
    if (!source || !isClassDeclaration(source) || !target || !isClassDeclaration(target)) {
        return;
    }
    const targetNatures = possibleNaturesOf(target);
    if (!targetNatures || targetNatures.size !== 1 || !targetNatures.has('events')) {
        return;
    }
    const stereotype = source.stereotype;
    if ((!isAntiRigid(stereotype) || stereotype.startsWith('historical')) && !isSemiRigid(stereotype)) {
        return;
    }
    accept('warning',
        `Membership in "${source.name}" can lapse, but the link to a past "${target.name}" event remains. This "@${relation.stereotype}" may then imply membership in "${source.name}" after it ended. Use a rigid source type for the historical link and state the participant's role at the event separately.`,
        { node: relation, code: 'historical-event-source-can-lapse' });
}

/**
 * A property of something immutable cannot vary.
 *
 * An end is a property of the classifier at the *opposite* end, so in
 * `event Wedding { -- [1] (venue) Place }` the end `Wedding::venue` belongs to
 * the wedding. A wedding is over: nothing about it changes afterward, that
 * link included. The same holds of an abstract individual, which is outside
 * time altogether. A situation is fact-like while it obtains, which is why an
 * end of one is `(const)` too -- what varies about a situation is whether it
 * obtains, not what it is. Histories accumulated around it are the exception,
 * as are its parts. Processes are the ones that are not immutable: gaining
 * parts is what they do.
 *
 * Reported as a warning: the model is not contradictory, it has left something
 * unsaid that its own natures already settle.
 */
export function checkImmutableEndIsConst(relation: Relation, accept: ValidationAcceptor): void {
    const source = getRelationSource(relation);
    const target = relation.target?.ref;
    for (const side of ['source', 'target'] as const) {
        // The end at one side is owned by the classifier at the other.
        const owner = side === 'target' ? source : target;
        const end = side === 'target' ? relation.targetMeta : relation.sourceMeta;
        // An `addOnly` end here is answered by `checkAddOnlyOnImmutableEnd`,
        // which says the same thing about the word actually written -- except
        // between situations, where accumulating parts is exactly what may
        // happen and `checkAccumulates` asks for `(addOnly)` instead.
        if (!owner || !isClassDeclaration(owner) || !hasImmutableInstances(owner) || isConst(end)
            || end?.isAddOnly
            || isSituationParthood(relation)
            // Nor about what has come to depend on something past, which
            // accumulates however settled the past is.
            || holdsAccumulatingHistory(relation, side)
            // A characterization of an event or a situation is answered in
            // full by `checkCharacterizationIsReified`; a second word about
            // the end's mutability is noise on a relation that should not be
            // written at all.
            || characterizedPerdurant(relation)) {
            continue;
        }
        accept(
            'warning',
            `This end is a property of "${owner.name}", whose instances cannot change, so it cannot change either. Mark it "(const)".`,
            { node: relation, code: 'immutable-end-not-const', data: { side } }
        );
    }
}

/**
 * What an individual came into existence in is settled the moment it exists.
 *
 * A `@creation` runs from an endurant to the event it began in, and there is
 * exactly one of those: an individual cannot later have come into existence in
 * a different event, since the event it did come into existence in is over and
 * events do not change. So the end at the event side cannot vary, and it is
 * `(const)` for the whole of the individual's life.
 *
 * The end at the *other* side is asked for by `immutable-end-not-const`: it is
 * a property of the event, and an event is over. That is why this one was
 * missed -- the endurant that owns the event end is perfectly mutable, and
 * every rule about `(const)` was reading the owner's nature. This one is not
 * about the owner but about the relation: however much the individual changes,
 * where it began does not.
 *
 * `@termination` is not the same shape. Its event end is `[0..1]` -- an
 * individual that still exists has no termination event yet -- so the link is
 * made once and never broken, which is `(addOnly)`, the word
 * `add-only-with-nothing-to-add` reserves for exactly this.
 */
export function checkCreationEndIsConst(relation: Relation, accept: ValidationAcceptor): void {
    if (relation.stereotype !== 'creation' || isConst(relation.targetMeta)) {
        return;
    }
    accept(
        'warning',
        'An individual comes into existence once, and the event it came into existence in is over, so this end cannot be re-pointed. Mark it "(const)".',
        { node: relation, code: 'creation-end-not-const', data: { side: 'target' } }
    );
}

/**
 * The stereotypes that write dependence down, and what each one's target end
 * names.
 *
 * A quality inheres in one individual, a relator in those it binds, an
 * extrinsic mode in something beyond its bearer: none of the three survives
 * losing what it depends on. `@historicalDependence` is settled for a
 * different reason -- what it names is in the past, and the past does not stop
 * having happened -- but it fixes the link just as firmly.
 */
export const DEPENDENCE_ENDS: Readonly<Record<string, string>> = {
    characterization: 'bearer',
    mediation: 'individuals it mediates',
    externalDependence: 'individual it depends on',
    historicalDependence: 'past it depends on'
};

/**
 * What something is by depending on, it must have.
 *
 * Two of the four dependences are constitutive of what stands at the near end:
 * a relator that binds nothing is not a relator, and an extrinsic mode with
 * nothing beyond its bearer to depend on is an intrinsic one. There the link
 * is not optional, and `[0..1]` or `[0..*]` at the far end says the dependent
 * may exist without what makes it what it is.
 *
 * The other two are not, for opposite reasons. `@characterization` is stronger
 * -- a moment inheres in exactly one bearer, which
 * `checkCharacterizationBearerCardinality` asks for as `[1]`. And
 * `@historicalDependence` is weaker: standing in it is not what makes anything
 * what it is, so a thing may historically depend on nothing at all. gUFO's own
 * `historicallyDependsOn` runs `[*]` to `[*]` between concrete individuals,
 * and this rule reported that port until it read the difference.
 *
 * Per mediation, not per relator: `checkRelatorMediatesTwo` counts what a
 * relator binds across all of them, while each one of them is a dependence in
 * its own right.
 */
const CONSTITUTIVE_DEPENDENCE = new Set(['mediation', 'externalDependence']);

export function checkDependenceEndIsMandatory(relation: Relation, accept: ValidationAcceptor): void {
    const depends = relation.stereotype && DEPENDENCE_ENDS[relation.stereotype];
    if (!depends || !CONSTITUTIVE_DEPENDENCE.has(relation.stereotype ?? '')) {
        return;
    }
    const bounds = relation.targetCardinality ? getBounds(relation.targetCardinality) : { lower: 1, upper: 1 };
    if (!bounds || bounds.lower >= 1) {
        return;
    }
    accept(
        'error',
        `"@${relation.stereotype}" is existential dependence, so the ${depends} must be there: this end cannot start at zero.`,
        { node: relation.targetCardinality ?? relation, code: 'dependence-end-not-mandatory' }
    );
}

/**
 * What something depends on, it cannot lose.
 *
 * Existential dependence cannot be re-pointed -- what depends would have to
 * stop existing on the way -- and historical dependence cannot be re-pointed
 * either, since it names something that has already happened. A plural end
 * may nevertheless gain dependencies. `const` closes the set; `addOnly`
 * leaves it open without permitting anything already depended on to be lost.
 *
 * `checkMomentMigratesBetweenKinds` says the same thing about *types*, a
 * moment characterizing two unrelated kinds, where this says it about the
 * link.
 */
export function checkDependenceEndIsConst(relation: Relation, accept: ValidationAcceptor): void {
    const depends = relation.stereotype && DEPENDENCE_ENDS[relation.stereotype];
    const bounds = relation.targetCardinality ? getBounds(relation.targetCardinality) : { lower: 1, upper: 1 };
    const mayGrow = !!bounds && bounds.lower !== bounds.upper;
    if (!depends || isConst(relation.targetMeta) || (mayGrow && relation.targetMeta?.isAddOnly)) {
        return;
    }
    const choice = mayGrow
        ? ' Mark this end "(const)", or "(addOnly)" if it may acquire further links.'
        : ' Mark this end "(const)".';
    accept(
        'warning',
        `"@${relation.stereotype}" is dependence, so what depends cannot lose or replace the ${depends}.${choice}`,
        { node: relation, code: 'dependence-end-not-const', data: { side: 'target', mayGrow } }
    );
}

/**
 * A quality or intrinsic mode reached for where tonto does not reify one.
 *
 * Aspects are reified for things with a life to bear them -- the endurants,
 * and processes. An event is over, and a situation, insofar as it obtains, is
 * fact-like: neither has a life over which an aspect could vary, so what would
 * have been an aspect of one is recorded as a property of it, `(const)`. Answered here rather than by the
 * nature table's flat refusal, since what to write instead is the whole of the
 * advice.
 */
export function characterizedPerdurant(relation: Relation): ClassDeclaration | undefined {
    if (relation.stereotype !== 'characterization') {
        return undefined;
    }
    const source = getRelationSource(relation);
    const bearer = relation.target?.ref;
    if (!source || !isClassDeclaration(source) || !bearer || !isClassDeclaration(bearer)) {
        return undefined;
    }
    const aspect = possibleNaturesOf(source);
    const reified = !!aspect && aspect.size > 0
        && [...aspect].every(nature => nature === 'intrinsic-modes' || nature === 'qualities');
    const settled = classifiesOnly(bearer, 'events') || classifiesOnly(bearer, 'situations');
    return reified && settled ? bearer : undefined;
}

export function checkCharacterizationIsReified(relation: Relation, accept: ValidationAcceptor): void {
    const bearer = characterizedPerdurant(relation);
    const aspect = getRelationSource(relation);
    if (!bearer || !aspect || !isClassDeclaration(aspect)) {
        return;
    }
    const what = classifiesOnly(bearer, 'events')
        ? 'An event is over'
        : 'A situation is fact-like while it obtains';
    accept('error',
        `${what}, so "${bearer.name}" bears no reified aspect. Record "${aspect.name}" as a "const" property of "${bearer.name}" instead.`,
        { node: relation, property: 'stereotype', code: 'characterization-bearer-not-reifiable' });
}

/**
 * Parthood between situations, which is the one thing a situation may gain.
 */
export function isSituationParthood(relation: Relation): boolean {
    const source = getRelationSource(relation);
    const target = relation.target?.ref;
    return isParthood(relation)
        && !!source && isClassDeclaration(source) && classifiesOnly(source, 'situations')
        && !!target && isClassDeclaration(target) && classifiesOnly(target, 'situations');
}

/**
 * What a process accumulates, and what a past never gives back.
 *
 * "The life of a process accumulates as the process goes on": the events
 * constituting it at a later time have those constituting it earlier as a
 * starting part, and the same holds of its temporal parts (Guarino &
 * Guizzardi, *Processes as variable embodiments*, Synthese 203:104, 2024,
 * axiom A7). Nothing is ever taken back, which is what `addOnly` says -- and
 * The axiom says the stronger thing -- that the earlier constitution is a
 * *prefix* of the later -- which the language no longer has a word for: an
 * end's `ordered` went with the attribute flags. `addOnly` says what is left
 * of it, that nothing is taken back.
 *
 * Historical dependence is the fourth, and the only one read at the *source*
 * end. `@historicalDependence` runs from what depends to what it depends on,
 * so the source end is the one holding the dependents -- the bakings that
 * took place in this oven, the former students of this graduation. What has
 * come to depend on something past never stops depending on it, since the
 * past does not change, so that end gains and never loses. (The other end is
 * `(const)` for the same reason, which `dependence-end-not-const` says.)
 *
 * A hint where a model may be indifferent to how its processes unfold, and
 * saying nothing about it is not saying something wrong. A warning for
 * historical dependence, which is not a matter of interest: the far end of the
 * same relation is `(const)` for the same reason, and
 * `dependence-end-not-const` says so as a warning.
 */
export function checkAccumulates(relation: Relation, accept: ValidationAcceptor): void {
    const source = getRelationSource(relation);
    const target = relation.target?.ref;
    if (!source || !isClassDeclaration(source) || !target || !isClassDeclaration(target)) {
        return;
    }
    // Processes accumulate what constitutes or composes them, a situation
    // accumulates parts, historical dependence accumulates dependents, and an
    // endurant's history accumulates completed participation and termination
    // events.
    const whole = isParthood(relation) && wholeEndOf(relation) === 'source';
    const constituted = relation.stereotype === 'constitution'
        && classifiesOnly(source, 'processes') && classifiesOnly(target, 'events');
    const composed = whole
        && classifiesOnly(source, 'processes') && classifiesOnly(target, 'processes');
    const obtaining = whole && isSituationParthood(relation);
    const historical = relation.stereotype === 'historicalDependence';
    // A completed event keeps its participants. On the target end this is
    // each participant's history of such events, which may grow but never
    // lose a link once the event has happened.
    const completedParticipation = relation.stereotype === 'participation'
        && classifiesOnly(target, 'events');
    const completedTermination = relation.stereotype === 'termination'
        && classifiesOnly(target, 'events');
    if (!constituted && !composed && !obtaining && !historical && !completedParticipation && !completedTermination) {
        return;
    }
    // The accumulated set is at the target end, except historical dependence,
    // which holds its dependents at the source.
    const side = historical ? 'source' : 'target';
    const end = historical ? relation.sourceMeta : relation.targetMeta;
    if ((end?.isAddOnly || end?.isConst)) {
        return;
    }
    // Read from the relation, not from the end decorator: an end that says
    // nothing has no decorator to carry its multiplicity.
    const written = historical ? relation.sourceCardinality : relation.targetCardinality;
    const bounds = written ? getBounds(written) : { lower: 1, upper: 1 };
    // A fixed count leaves nothing to add. That skips the process and
    // situation hints, but a completed-event link still needs `const` there:
    // without it, a link could be replaced while the count stayed the same.
    // `[0..1]` is not fixed -- going from none to one is an addition.
    const completedEventHistory = completedParticipation || completedTermination;
    if (!completedEventHistory && bounds && bounds.lower === bounds.upper) {
        return;
    }
    const subject = historical
        ? 'Historical dependence never lapses, since what it names has already happened'
        : completedParticipation
            ? 'Participation in a completed event never lapses'
            : completedTermination
                ? 'A termination event remains in the endurant\'s history'
                : obtaining
                    ? 'A situation changes in no other way, but it accumulates parts'
                    : `A process accumulates what ${constituted ? 'constitutes' : 'makes up'} it`;
    // A warning where the natures settle it and a hint where the model may
    // reasonably be indifferent. Historical dependence and links to completed
    // events never lapse; how a process unfolds is the latter kind, where a
    // model that says nothing about it has not said anything wrong.
    const fixed = bounds && bounds.lower === bounds.upper;
    const advice = fixed
        ? 'mark this end "const"; "addOnly" has nothing to add at this fixed cardinality.'
        : 'nothing here is ever taken back, which is "addOnly".';
    accept(historical || completedEventHistory ? 'warning' : 'hint',
        `${subject}: ${advice}`,
        { node: relation, code: 'accumulating-end-not-add-only', data: { side } });
}
