import type { ValidationAcceptor } from 'langium';
import { AstUtils } from 'langium';
import type { ClassDeclaration, GeneralizationSet, Model, Relation } from '../generated/ast.js';
import { isClassDeclaration, isGeneralizationSet, isRelation } from '../generated/ast.js';
import { cannotShareInstances } from '../utils/disjointness.js';
import {
    collectAncestors, getDirectGeneralizations, isSameOrSpecializes, referringGeneralizationSets
} from '../utils/generalizations.js';
import {
    findCycle, mandatoryPartsOf, mandatoryWholesOf, parthoodsWholedBy, targetsOf, ultimateSortalOf
} from '../utils/relation-graph.js';
import type { ReverseLookup } from './incoming-relations.js';
import { outgoingByStereotype } from './incoming-relations.js';
import { getRelationSource, isParthood, wholeEndOf } from '../utils/relations.js';
import {
    foundedAbove, foundingCandidatesInto, foundingOf, foundingRelations, foundingSide, foundsHistorically
} from '../utils/founding.js';
import { possibleNaturesOf } from '../utils/nature-reasoning.js';
import { UNFOLDING_STEREOTYPES } from './relation-nature-table.js';
import { a, chain } from './wording.js';
import { getBounds } from './cardinality-checks.js';
import { isParticipationalPortion } from './relation-nature-checks.js';
import {
    allowedNaturesFor, expandNatures, isAntiRigid, isNonSortal, isSortal, isUltimateSortal
} from './stereotype-model.js';
import { ofClauseNatures } from './natures.js';

/**
 * A non-sortal classifies individuals of more than one kind but supplies no
 * identity principle, so its instances must get one from somewhere: every
 * non-sortal has to generalize at least one sortal.
 *
 * A non-sortal with no sortal beneath it describes things nothing can be.
 *
 * Reported only when the class has subtypes and none of them is a sortal --
 * a category whose specializations live in a file nobody has opened yet is a
 * normal state, and reporting on it would make the check unusable on a model
 * split across files.
 *
 * And reported as a hint, because of what the rule meets in practice. A
 * foundational or core ontology is mostly non-sortals: gUFO's `Endurant`,
 * `Object`, `Event` and the rest exist so that domain ontologies can put
 * sortals under them, and until one does, every layer above is a non-sortal
 * over non-sortals. That is the intended shape of such a model, not a defect
 * in it, and a warning on every class of it drowns the diagnostics that are
 * about something. The hint still says it where a domain model has forgotten
 * its kinds.
 */
export function checkNonSortalGeneralizesASortal(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    if (!isNonSortal(classDeclaration.stereotype)) {
        return;
    }
    const descendants = subtypesOf(lookup, classDeclaration);
    if (descendants.length === 0) {
        return;
    }
    if (descendants.some(descendant => isSortal(descendant.stereotype) || descendant.stereotype === 'class')) {
        return;
    }
    accept(
        'hint',
        `Non-sortal "${classDeclaration.name}" supplies no identity principle, so it must generalize at least one sortal -- and ${descendants.length === 1 ? 'the one type beneath it is not' : `none of the ${descendants.length} types beneath it is`} one.`,
        { node: classDeclaration, property: 'name', code: 'non-sortal-without-sortal-subtype' }
    );
}

/** Whether this class, or a class above it, says with "of" which natures its instances have. */
function naturesStated(classDeclaration: ClassDeclaration): boolean {
    return [classDeclaration, ...collectAncestors(classDeclaration)].some(member => member.natures.length > 0);
}

/**
 * The natures of what the model puts beneath a non-sortal, spelled as an
 * `of` clause would spell them: every sortal under it that draws its identity
 * from an ultimate sortal, and every type under it that already says what it
 * classifies. Every instance of a non-sortal is an instance of some sortal,
 * so this is what the model, as written, has it classify.
 *
 * Nothing is returned where nothing beneath answers, or where the answer is
 * one the stereotype itself refuses -- that is another rule's error, and an
 * `of` clause would only repeat it.
 */
export function naturesBeneath(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, stereotype: string = classDeclaration.stereotype
): string[] | undefined {
    const found = new Set<string>();
    for (const descendant of subtypesOf(lookup, classDeclaration)) {
        const lineage = [descendant, ...collectAncestors(descendant)];
        const answers = lineage.some(member => isUltimateSortal(member.stereotype))
            || (isNonSortal(descendant.stereotype) && descendant.natures.length > 0);
        const natures = answers ? possibleNaturesOf(descendant) : undefined;
        natures?.forEach(nature => found.add(nature));
    }
    // Asked of the stereotype the class has, or of one a repair would give it.
    const admitted = expandNatures(allowedNaturesFor(stereotype) ?? []);
    if (found.size === 0 || [...found].some(nature => !admitted.has(nature))) {
        return undefined;
    }
    return ofClauseNatures(found);
}

/**
 * A non-sortal that never says what it classifies.
 *
 * A non-sortal supplies no identity of its own, so its stereotype admits
 * nearly every nature, and with no `of` clause anywhere in its lineage that
 * is what it is read as: a `category Agent` may classify events, qualities
 * and values as readily as people. Every check that reads natures then has
 * nothing to rule out -- a relation from it to anything passes -- and the
 * gUFO export can only write the union of everything. A non-sortal that
 * really spans natures is rare, so the likelier reading is that the clause
 * was not written.
 *
 * A warning, as a bare `class` is: the model is not contradictory, it has
 * left unsaid what it almost certainly means. Spanning stays allowed --
 * `of functional-complexes, events` is a statement like any other, and an
 * upper ontology writes one. What the rule asks is that it be said, once, at
 * the top: a non-sortal under another unstated one inherits whatever that one
 * comes to say, so only the topmost is reported.
 */
export function checkNonSortalStatesNatures(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    if (!isNonSortal(classDeclaration.stereotype) || naturesStated(classDeclaration)) {
        return;
    }
    if ([...collectAncestors(classDeclaration)].some(ancestor => isNonSortal(ancestor.stereotype))) {
        return;
    }
    // The examples are the model's own where it has one: what is beneath the
    // type, in the slot -- one nature or several -- that it fills.
    const beneath = naturesBeneath(lookup, classDeclaration);
    const one = beneath?.length === 1 ? beneath[0] : 'functional-complexes';
    const several = beneath && beneath.length > 1 ? beneath.join(', ') : 'relators, events';
    accept(
        'warning',
        `"${classDeclaration.name}" says nothing about the ontological nature of its instances (are they functional complexes, events, types, \u2026?). Use "of" to name the nature it is meant to classify (e.g., "of ${one}") or the natures it spans ("of ${several}").`,
        { node: classDeclaration, property: 'name', code: 'non-sortal-natures-unstated' }
    );
}

/**
 * Proper parthood is irreflexive and transitive on individuals, so no
 * individual is a part of itself.
 *
 * A recursive parthood *type* is not that. `kind Part { @componenthood
 * [0..1] <>-- [*] Part }` is a tree: it stops at a leaf, which has no parts,
 * and at a root, which has no whole. Reporting it would rule out the ordinary
 * case.
 *
 * The unsatisfiable shape is a cycle every step of which is required, and
 * there are two of those, one per end. Descending, each whole requires a part
 * that requires a part, and the parts never bottom out. Climbing, each part
 * belongs to a whole that belongs to a whole, and the wholes never top out.
 * They are separate claims made by separate multiplicities, so they are
 * reported separately and repaired separately -- a model may make both, and
 * `@componenthood <>-- Node` does, since an omitted bound is exactly one at
 * either end.
 *
 * Cycles with an optional step are left to the AssocCyc anti-pattern, which
 * raises them as a question rather than an error.
 */
/**
 * Whether something above this class is already in the same cycle.
 *
 * The relation is written there, and reporting it again of every subtype says
 * one thing many times -- `checkRelatorHasMediation` keeps quiet for the same
 * reason.
 *
 * *The same* cycle, though, and not merely some cycle: an ancestor with a
 * recursion of its own answers for that one, not for a separate recursion
 * written here. Asking only whether an ancestor was in any cycle at all let
 * one defect hide another -- `kind A { <>-- [1..*] A }` silenced the
 * identically unsatisfiable `subkind B specializes A { <>-- [1..*] B }`, so
 * B's own claim went unreported until A's was repaired.
 */
function ancestorsAlreadyIn(
    classDeclaration: ClassDeclaration,
    successors: (node: ClassDeclaration) => ClassDeclaration[],
    own: readonly string[]
): boolean {
    const mine = new Set(own);
    return [...collectAncestors(classDeclaration)].some(member => {
        const theirs = findCycle(member, successors);
        // Theirs covers mine when every type it runs through is one mine runs
        // through: the same loop, reached from higher up.
        return !!theirs && theirs.every(name => mine.has(name));
    });
}

export function checkParthoodIsAcyclic(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    // A cycle an ancestor is already in is that ancestor's to answer: the
    // relation is written there, and reporting it again of everything below
    // says the same thing once per subtype. `checkRelatorHasMediation` keeps
    // quiet for the same reason.
    const descending = (node: ClassDeclaration): ClassDeclaration[] => mandatoryPartsOf(lookup, node);
    const climbing = (node: ClassDeclaration): ClassDeclaration[] => mandatoryWholesOf(lookup, node);
    const descent = findCycle(classDeclaration, descending);
    const downward = descent && !ancestorsAlreadyIn(classDeclaration, descending, descent)
        ? descent
        : undefined;
    if (downward) {
        accept(
            'error',
            `Every ${chain([classDeclaration.name, ...downward], 'must contain')}, so the parts never bottom out. Parthood is irreflexive on individuals, so no individual can satisfy this: let a part end hold none, by dropping its lower bound to zero.`,
            { node: classDeclaration, property: 'name', code: 'parthood-descends-forever' }
        );
    }
    const climb = findCycle(classDeclaration, climbing);
    const upward = climb && !ancestorsAlreadyIn(classDeclaration, climbing, climb)
        ? climb
        : undefined;
    if (upward) {
        accept(
            'error',
            `Every ${chain([classDeclaration.name, ...upward], 'must be part of')}, so the wholes never top out. Parthood is irreflexive on individuals, so no individual can satisfy this: let a whole end stand alone, by dropping its lower bound to zero -- an omitted bound is exactly one, and that is what says every part belongs to a whole.`,
            { node: classDeclaration, property: 'name', code: 'parthood-climbs-forever' }
        );
    }
}


/**
 * A relator is an existentially dependent bundle binding several individuals
 * together, so it has to mediate at least two of them -- a marriage with one
 * participant is not a relationship.
 *
 * What is counted is *individuals*, not mediations: a single
 * `@mediation [1] -- [2] Spouse` binds two, and is the usual way to write a
 * symmetric relator. So the lower bounds of the mediated ends are summed, an
 * omitted multiplicity counting as the one it means.
 *
 * Counted across the workspace, since mediations are often written beside the
 * participants rather than the relator. Silent when the relator mediates
 * nothing at all -- a relator not yet connected is what every model under
 * construction is full of.
 */
export function checkRelatorMediatesTwo(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    if (classDeclaration.stereotype !== 'relator') {
        return;
    }
    const mediations = outgoingByStereotype(lookup, classDeclaration, 'mediation');
    if (mediations.length === 0) {
        return;
    }
    let mediated = 0;
    for (const mediation of mediations) {
        const bounds = mediation.targetCardinality ? getBounds(mediation.targetCardinality) : { lower: 1, upper: 1 };
        // A malformed multiplicity is reported elsewhere; assume it is fine.
        mediated += bounds ? bounds.lower : 2;
    }
    if (mediated >= 2) {
        return;
    }
    accept(
        'warning',
        `Relator "${classDeclaration.name}" mediates ${mediated === 1 ? 'a single individual' : 'none'}, so it binds nothing together. A relator existentially depends on at least two -- widen a mediated end to "[2]" or add another "@mediation".`,
        { node: classDeclaration, property: 'name', code: 'relator-mediates-one' }
    );
}

/**
 * A historical role under an anti-rigid type makes that type permanent.
 *
 * A historical role holds because of a past event, and the past does not stop
 * having happened: once an individual is an ex-president it is one forever.
 * Every other anti-rigid condition may lapse -- a relator ceases, a phase ends.
 * Put the historical one beneath such a type and the two claims meet: every
 * instance of the historical role is an instance of the supertype *at every
 * moment the historical role holds*, which is always. So the condition above it
 * can never lapse for those individuals either.
 *
 * That is coherent and sometimes intended, so it is not an error. It is worth
 * saying out loud because the consequence lands somewhere else -- on the
 * relator that founds the role, or on whatever ends the phase.
 */
export function checkHistoricalRoleUnderAntiRigid(
    classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    if (classDeclaration.stereotype !== 'historicalRole' && classDeclaration.stereotype !== 'historicalRoleMixin') {
        return;
    }
    for (const supertype of getDirectGeneralizations(classDeclaration)) {
        if (!isAntiRigid(supertype.stereotype) || supertype.stereotype.startsWith('historical')) {
            continue;
        }
        const founds = supertype.stereotype === 'role' || supertype.stereotype === 'roleMixin'
            ? `the relator that founds "${supertype.name}"`
            : `whatever ends "${supertype.name}"`;
        accept(
            'warning',
            `"${classDeclaration.name}" holds forever once it holds, so specializing "${supertype.name}" makes ${founds} historical too: it can never lapse without contradiction.`,
            { node: classDeclaration, property: 'name', code: 'historical-role-specializes-anti-rigid' }
        );
        return;
    }
}

/**
 * A relator that mediates nothing.
 *
 * A relator is a moment like any other -- it exists in the individuals it
 * binds -- and `@mediation` is how that dependence is written. Without one the
 * relator floats free, which is the same omission `checkMomentHasBearer`
 * reports for qualities and modes, and is now reported the same way in every
 * respect: judged by nature, not by stereotype. The stereotype `relator`
 * implies the nature, but so does a `role` under one, a `subkind` of one and a
 * `category of relators`, and each floats just as freely.
 *
 * `checkRelatorMediatesTwo` takes over once there is at least one mediation,
 * where the question becomes how many individuals are bound rather than
 * whether any are.
 */
export function checkRelatorHasMediation(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    if (!needsAMediation(classDeclaration)) {
        return;
    }
    const ancestors = [...collectAncestors(classDeclaration)];
    const declares = declaresRelation(lookup, 'mediation');
    // A relator-natured ancestor is reported instead; it is the same omission.
    if (declares(classDeclaration) || ancestors.some(needsAMediation)
        || coveredBySubtypes(classDeclaration, declares)) {
        return;
    }
    accept(
        'warning',
        `"${classDeclaration.name}" classifies relators, which exist by binding the individuals they relate, but it mediates nothing. Add a "@mediation" to each mediated individual.`,
        { node: classDeclaration, property: 'name', code: 'relator-without-mediation' }
    );
}

/**
 * Whether everything this class classifies is a relator, judged by nature.
 *
 * The empty set means the class is already contradictory, and `every` would be
 * vacuously true of it -- asking for a mediation on something that cannot
 * exist at all. Same reasoning as `needsABearer` below, and the same guard.
 */
function needsAMediation(classDeclaration: ClassDeclaration): boolean {
    const natures = possibleNaturesOf(classDeclaration);
    return !!natures && natures.size > 0 && [...natures].every(nature => nature === 'relators');
}

/**
 * The natures whose individuals inhere in a bearer.
 *
 * Relators are moments too, but their bearer is the sum of the individuals
 * they mediate rather than a separate characterization, so they answer to
 * `checkRelatorMediatesTwo` instead.
 */
const INHERING_NATURES = new Set(['qualities', 'intrinsic-modes', 'extrinsic-modes']);

/**
 * Whether this class's instances inhere in something, judged by nature rather
 * than by stereotype.
 *
 * `phase ActiveHeadache specializes Headache` is a moment: its stereotype says
 * nothing about inherence, but everything it classifies is an intrinsic mode.
 * Reading the stereotype alone missed exactly that, and a `phase` under a
 * moment is an ordinary way to model one that comes and goes.
 */
function needsABearer(classDeclaration: ClassDeclaration): boolean {
    const natures = possibleNaturesOf(classDeclaration);
    // An empty set means the class is already contradictory, and `every` would
    // be vacuously true of it -- reporting a missing bearer for something that
    // cannot exist at all.
    return !!natures && natures.size > 0 && [...natures].every(nature => INHERING_NATURES.has(nature));
}

/**
 * a65/a66 -- a moment is existentially dependent on the individual it inheres
 * in, so something has to bear it: a `@characterization` reaching a bearer.
 *
 * Satisfied by a characterization anywhere in the lineage, since a subtype
 * inherits its supertype's bearer.
 *
 * Reported on the *highest* moment in the chain that lacks one, which is where
 * the omission is. An earlier version skipped any type that had subtypes, on
 * the theory that a specialization would carry the characterization; that
 * pointed the message at the subtype when both lacked a bearer, and silenced
 * it altogether when the subtype was stereotyped something other than a
 * moment.
 */
export function checkMomentHasBearer(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    if (!needsABearer(classDeclaration)) {
        return;
    }
    const ancestors = [...collectAncestors(classDeclaration)];
    const declares = declaresRelation(lookup, 'characterization');
    if (declares(classDeclaration) || coveredBySubtypes(classDeclaration, declares)) {
        return;
    }
    // A moment-natured ancestor is reported instead; it is the same omission.
    if (ancestors.some(needsABearer)) {
        return;
    }
    accept(
        'warning',
        `"${classDeclaration.name}" classifies ${readable(possibleNaturesOf(classDeclaration))}, which inhere in something, but nothing bears it. Add a "@characterization" to its bearer.`,
        { node: classDeclaration, property: 'name', code: 'moment-without-bearer' }
    );
}

/**
 * An extrinsic mode depends on something beyond its bearer, and that is what
 * distinguishes it from an intrinsic one, so the model has to say what.
 *
 * The same omission `checkMomentHasBearer` reports, one dependence over: a
 * commitment inheres in the person committed and depends on the one committed
 * to, and an extrinsic mode with only the first written is an intrinsic mode
 * that has been given the wrong stereotype.
 */
export function checkExtrinsicModeDependsOnSomething(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    if (!isExtrinsic(classDeclaration)) {
        return;
    }
    const ancestors = [...collectAncestors(classDeclaration)];
    const declares = declaresRelation(lookup, 'externalDependence');
    if (declares(classDeclaration) || ancestors.some(isExtrinsic)
        || coveredBySubtypes(classDeclaration, declares)) {
        return;
    }
    accept(
        'warning',
        `"${classDeclaration.name}" classifies extrinsic modes, which depend on something beyond their bearer, but nothing is named. Add an "@externalDependence" -- or make it an "intrinsicMode".`,
        { node: classDeclaration, property: 'name', code: 'extrinsic-mode-without-dependence' }
    );
}

function isExtrinsic(classDeclaration: ClassDeclaration): boolean {
    const natures = possibleNaturesOf(classDeclaration);
    return !!natures && natures.size > 0 && [...natures].every(nature => nature === 'extrinsic-modes');
}

/**
 * "At each time, a process is constituted by a certain series of events"
 * (Guarino & Guizzardi 2024, §3.1, axiom A5), and nothing else constitutes
 * one. A process with no events behind it says only that something is going
 * on, not what happens in it.
 */
export function checkProcessIsConstituted(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    if (!isProcess(classDeclaration)) {
        return;
    }
    const ancestors = [...collectAncestors(classDeclaration)];
    const declares = declaresRelation(lookup, 'constitution');
    if (declares(classDeclaration) || ancestors.some(isProcess)
        || coveredBySubtypes(classDeclaration, declares)) {
        return;
    }
    accept(
        'warning',
        `"${classDeclaration.name}" classifies processes, which are constituted by the events that happen in them, but no event is named. Add a "@constitution" to them.`,
        { node: classDeclaration, property: 'name', code: 'process-without-constitution' }
    );
}

function isProcess(classDeclaration: ClassDeclaration): boolean {
    const natures = possibleNaturesOf(classDeclaration);
    return !!natures && natures.size > 0 && [...natures].every(nature => nature === 'processes');
}

/**
 * An event is an unfolding of something, so something has to unfold in it.
 *
 * Events are existentially dependent on their participants: what a wedding is
 * depends on the two who marry, and an event type with nothing taking part in
 * it names an occurrence with nobody in it. This is the same omission
 * `checkRelatorHasMediation` reports of a relator, `checkMomentHasBearer` of a
 * moment and `checkProcessIsConstituted` of a process, and it is reported the
 * same way: judged by nature, satisfied anywhere in the lineage, and satisfied
 * by a complete partition whose specifics each say it.
 *
 * What counts is any relation that runs from something that *endures* to
 * something that *happens* -- taking part in it, being created or terminated
 * by it, changing in it, being manifested in it -- which is read off the
 * signatures rather than listed, so a stereotype added with that shape counts
 * from the day it exists. Causation does not count: a situation triggering an
 * event says what brought it about, not who was in it.
 */
export function checkEventHasParticipation(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    if (!isEvent(classDeclaration)) {
        return;
    }
    const seen = new Set<ClassDeclaration>();
    const declares = (candidate: ClassDeclaration): boolean => {
        if (seen.has(candidate)) {
            return false;
        }
        seen.add(candidate);
        return [candidate, ...collectAncestors(candidate)].some(ancestor =>
            takesPart(lookup, ancestor) || throughSomethingElse(lookup, ancestor, declares));
    };
    const ancestors = [...collectAncestors(classDeclaration)];
    if (declares(classDeclaration) || ancestors.some(isEvent)
        || coveredBySubtypes(classDeclaration, declares)) {
        return;
    }
    // A participational portion is the exception: it is projected by
    // dependence on one endurant, so the participant is what the type *is*,
    // as it is for a relator or a moment, and leaving it out is a warning
    // for the same reason theirs is.
    if (isParticipationalPortion(lookup, classDeclaration)) {
        accept(
            'warning',
            `"${classDeclaration.name}" is a participational portion, which depends on exactly one endurant, but nothing takes part in it. Add the "@participation" of the endurant it depends on.`,
            { node: classDeclaration, property: 'name', code: 'event-without-participation' }
        );
        return;
    }
    // A hint, where the other four members of the family are warnings. What a
    // relator binds and what a moment inheres in are what those types *are*,
    // and a model that leaves them out has left out the definition. Who took
    // part in an event is ordinarily worth saying and ordinarily elsewhere --
    // in the file about the participants, or in no file at all when the model
    // is about classifying occurrences rather than about who was in them.
    accept(
        'hint',
        `"${classDeclaration.name}" classifies events, which are what their participants are doing, but nothing takes part in it. Add a "@participation" from what does.`,
        { node: classDeclaration, property: 'name', code: 'event-without-participation' }
    );
}

/**
 * A collective is a plurality, so the model should say what it is a plurality
 * *of*: a `@membership` reaching the type of its members.
 *
 * The same shape as the four checks above -- judged by nature, satisfied
 * anywhere in the lineage, and satisfied by a complete partition whose
 * specifics each say it -- with one path of its own. The members of a
 * sub-collection are members of the collection it is part of, so a choir whose
 * sections have singers in them has singers in it, and the `@membership` is
 * rightly written once, at the section.
 *
 * A hint rather than a warning. What a relator mediates is what a relator *is*
 * and a model that leaves it out has left out the definition; a collective is
 * a plurality whether or not the model has got round to naming what it is a
 * plurality of, and `collective Deck` in a model that never mentions cards is
 * an ordinary thing to write. It is still worth asking about, because a
 * collective whose members are nowhere is very often a `kind`.
 */
export function checkCollectiveHasMembers(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    if (!isAPlurality(classDeclaration)) {
        return;
    }
    const seen = new Set<ClassDeclaration>();
    const declares = (candidate: ClassDeclaration): boolean => {
        if (seen.has(candidate)) {
            return false;
        }
        seen.add(candidate);
        return [candidate, ...collectAncestors(candidate)].some(ancestor =>
            hasMembers(lookup, ancestor) || throughASubCollection(lookup, ancestor, declares));
    };
    const ancestors = [...collectAncestors(classDeclaration)];
    // A collective-natured ancestor is reported instead; it is the same omission.
    if (declares(classDeclaration) || ancestors.some(isAPlurality)
        || coveredBySubtypes(classDeclaration, declares)) {
        return;
    }
    accept(
        'hint',
        `"${classDeclaration.name}" classifies collectives, which are pluralities of members, but nothing is a member of it. Add a "@membership" to the type of its members.`,
        { node: classDeclaration, property: 'name', code: 'collective-without-members' }
    );
}

/**
 * Whether everything this class classifies is a collective, judged by nature
 * rather than by stereotype -- so a `category of collectives` and a `role`
 * played by one are asked the same question, and a class whose natures are
 * already contradictory is asked nothing.
 */
function isAPlurality(classDeclaration: ClassDeclaration): boolean {
    const natures = possibleNaturesOf(classDeclaration);
    return !!natures && natures.size > 0 && [...natures].every(nature => nature === 'collectives');
}

/**
 * Whether anything is a member of this class, whichever end the diamond was
 * written on.
 */
function hasMembers(lookup: ReverseLookup, classDeclaration: ClassDeclaration): boolean {
    return parthoodsWholedBy(lookup, classDeclaration)
        .some(parthood => parthood.relation.stereotype === 'membership');
}

/** Members reached through a sub-collection, which is where they often are. */
function throughASubCollection(
    lookup: ReverseLookup,
    classDeclaration: ClassDeclaration,
    declares: (candidate: ClassDeclaration) => boolean
): boolean {
    return parthoodsWholedBy(lookup, classDeclaration)
        .filter(parthood => parthood.relation.stereotype === 'subCollection')
        .some(parthood => declares(parthood.part));
}

/**
 * Two ways an event has participants without a relation of its own.
 *
 * What takes part in a *part* of an event takes part in the event: that is
 * what participational parthood decomposes, so a wedding whose vow exchange
 * has spouses in it has them in the wedding. And what takes part in a process
 * takes part in the events constituting it, since at each time the process is
 * those events (A5) -- a baking performed by a baker is a kneading performed
 * by one.
 *
 * Neither reads downwards. A participant in the whole need not be in every
 * part, which is the whole point of decomposing an event by participant.
 */
function throughSomethingElse(
    lookup: ReverseLookup,
    classDeclaration: ClassDeclaration,
    declares: (candidate: ClassDeclaration) => boolean
): boolean {
    return lookup.touching(classDeclaration).some(relation => {
        const source = getRelationSource(relation);
        const target = relation.target?.ref;
        if (!source || !isClassDeclaration(source) || !isClassDeclaration(target)) {
            return false;
        }
        // A part of this event, whichever end carries the diamond.
        if (isParthood(relation)) {
            const wholeIsSource = wholeEndOf(relation) === 'source';
            const whole = wholeIsSource ? source : target;
            const part = wholeIsSource ? target : source;
            return whole === classDeclaration && declares(part);
        }
        // Or the process this event constitutes.
        return relation.stereotype === 'constitution' && target === classDeclaration && declares(source);
    });
}

/** Whether anything that endures is related to this class by what it does. */
function takesPart(lookup: ReverseLookup, classDeclaration: ClassDeclaration): boolean {
    return lookup.touching(classDeclaration).some(relation =>
        !!relation.stereotype && UNFOLDING_STEREOTYPES.has(relation.stereotype)
        && relation.target?.ref === classDeclaration);
}

/** Whether everything this class classifies is an event. */
function isEvent(classDeclaration: ClassDeclaration): boolean {
    const natures = possibleNaturesOf(classDeclaration);
    return !!natures && natures.size > 0 && [...natures].every(nature => nature === 'events');
}

/**
 * A material relation holds because an extrinsic aspect holds.
 *
 * "Material relations have material structure of their own... their existence
 * is founded on a relator": someone works for a company because there is an
 * employment, and the relation is derived from the mediations that employment
 * has to each of them. A one-sided material relation may instead be derived
 * from an extrinsic mode that inheres in one end and externally depends on the
 * other. A `@material` that names neither states a connection and nothing that
 * makes it true, which is the difference between it and an ordinary
 * association.
 *
 * A hint, for the reasons `role-without-relator` is one: the relator is often
 * in a file the workspace has not opened, and leaving it unmodeled is a
 * defensible simplification. The relator has to reach both ends, though not
 * necessarily the ends themselves -- a mediation to a supertype grounds the
 * relation between the subtypes.
 */
export function checkMaterialHasRelator(
    lookup: ReverseLookup, relation: Relation, accept: ValidationAcceptor
): void {
    // One that names what it is derived from is answered by the derivation
    // checks, which can say whether that relator binds both ends.
    if (relation.stereotype !== 'material' || relation.derivedFrom.length > 0) {
        return;
    }
    // An inverse is the same association read backwards. If either
    // declaration names what makes that association hold, repeating the
    // derivation on the other says nothing more. Read both declaration
    // directions because `inverseOf` is semantically symmetric even when an
    // older model has written the clause on only one of them.
    if (hasDerivedMaterialInverse(lookup, relation)) {
        return;
    }
    const source = getRelationSource(relation);
    const target = relation.target?.ref;
    if (!source || !target || !isClassDeclaration(source) || !isClassDeclaration(target)) {
        return;
    }
    const grounding = groundingRelators(lookup, source, target);
    if (grounding.length > 0) {
        const names = grounding.map(relator => `"${relator.name}"`);
        accept(
            'hint',
            grounding.length === 1
                ? `${names[0]} mediates both ends, so this is presumably what the relation is derived from. Say so with "derivedFrom ${grounding[0].name}": the relation holds because that relator does, and the gUFO export writes it as gufo:isDerivedFrom.`
                : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} each mediate both ends, so the relation is derived from one of them, and the model does not say which. Name it with "derivedFrom".`,
            { node: relation, code: 'derivation-unstated' }
        );
        return;
    }
    accept(
        'hint',
        `A material relation is derived from a relator that mediates both ends, or from an extrinsic mode that inheres in one and externally depends on the other. Nothing mediates both "${source.name}" and "${target.name}", and no extrinsic mode is named. Write the aspect that makes the relation hold -- or use a plain association, which claims nothing about what makes it true.`,
        { node: relation, code: 'material-without-relator' }
    );
}

/** Whether a correctly crossed inverse already names this association's material ground. */
function hasDerivedMaterialInverse(lookup: ReverseLookup, relation: Relation): boolean {
    const direct = relation.inverseOf?.ref;
    const candidates = new Set<Relation>([
        ...(direct ? [direct] : []),
        ...lookup.referrers(relation)
            .filter((referrer): referrer is Relation =>
                isRelation(referrer) && referrer.inverseOf?.ref === relation)
    ]);
    const source = getRelationSource(relation);
    const target = relation.target?.ref;
    return !!source && !!target && [...candidates].some(inverse =>
        inverse !== relation
        && inverse.stereotype === 'material'
        && inverse.derivedFrom.some(reference => !!reference.ref)
        && getRelationSource(inverse) === target
        && inverse.target?.ref === source);
}

/**
 * The relators with a mediation reaching this class or something above it.
 *
 * Searched over the lineage as well as read against it: a mediation written
 * at `Person` does not *touch* `Staff`, and looking only at the relations
 * that do left a material relation between subtypes ungrounded.
 */
export function relatorsMediating(lookup: ReverseLookup, classDeclaration: ClassDeclaration): ClassDeclaration[] {
    const family = new Set<ClassDeclaration>([classDeclaration, ...collectAncestors(classDeclaration)]);
    return [...family].flatMap(member => lookup.touching(member))
        .filter(relation => relation.stereotype === 'mediation')
        .filter(relation => {
            const mediated = relation.target?.ref;
            return !!mediated && isClassDeclaration(mediated) && family.has(mediated);
        })
        .map(relation => getRelationSource(relation))
        .filter((relator): relator is ClassDeclaration => !!relator && isClassDeclaration(relator));
}

/**
 * The relators a material relation between these two could be derived from:
 * each mediates both, or something above each. Several is a real possibility
 * -- an employment and a contract both binding employee and employer -- which
 * is why the derivation has to be written rather than found.
 */
export function groundingRelators(
    lookup: ReverseLookup, source: ClassDeclaration, target: ClassDeclaration
): ClassDeclaration[] {
    return [...new Set(relatorsMediating(lookup, source))].filter(relator => source === target
        ? (mediationCapacity(lookup, relator, target) ?? 0) >= 2
        : mediates(lookup, relator, target));
}

/** Whether this relator mediates that class, or something above it. */
export function mediates(lookup: ReverseLookup, relator: ClassDeclaration, target: ClassDeclaration): boolean {
    const family = new Set<ClassDeclaration>([target, ...collectAncestors(target)]);
    const relators = [relator, ...collectAncestors(relator)];
    return relators.flatMap(member => outgoingByStereotype(lookup, member, 'mediation')).some(relation => {
        const mediated = relation.target?.ref;
        return !!mediated && isClassDeclaration(mediated) && family.has(mediated);
    });
}

/**
 * How many instances compatible with `target` one relator may mediate across
 * all of its compatible mediation roles. A self material relation needs two:
 * either two separately declared roles, or one multi-valued mediation.
 */
export function mediationCapacity(
    lookup: ReverseLookup, relator: ClassDeclaration, target: ClassDeclaration
): number | undefined {
    const family = new Set<ClassDeclaration>([target, ...collectAncestors(target)]);
    const relations = new Set([relator, ...collectAncestors(relator)]
        .flatMap(member => outgoingByStereotype(lookup, member, 'mediation'))
        .filter(relation => {
            const mediated = relation.target?.ref;
            return !!mediated && isClassDeclaration(mediated) && family.has(mediated);
        }));
    let capacity = 0;
    for (const relation of relations) {
        const bounds = relation.targetCardinality
            ? getBounds(relation.targetCardinality)
            : { lower: 1, upper: 1 };
        if (!bounds || bounds.lower > bounds.upper || bounds.upper === 0) {
            return undefined;
        }
        capacity = capacity === Infinity || bounds.upper === Infinity
            ? Infinity
            : capacity + bounds.upper;
    }
    return capacity;
}

/**
 * A role is founded on a relationship, and the relator is that relationship.
 *
 * "A role is anti-rigid because the relator that founds it can cease to
 * exist": what makes someone a student is an enrollment, and if no relator
 * mediates the role then either one is missing or the type is not a role at
 * all -- a phase, if the condition is intrinsic, or a subkind if it is neither.
 *
 * Being part of something founds a role the same way, and needs no relator to
 * do it: a main motor is a motor a boat has as its main one, and the
 * componenthood holding it there is the relational property the role is named
 * for. Only at the part end -- `role Employee { @componenthood <>-- Badge }`
 * says an employee has a badge, which is a consequence of being one and not
 * what makes them one.
 *
 * A hint, not a warning: a role whose relator is genuinely not worth modeling
 * is a defensible, if lossy, simplification. Not because of where the relator
 * lives -- `TontoDocumentBuilder` rebuilds this file when the file holding the
 * relator changes, and the CLI loads the whole model rather than the one file
 * it was asked about.
 */
export function checkRoleHasRelator(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    if (classDeclaration.stereotype !== 'role' && classDeclaration.stereotype !== 'roleMixin') {
        return;
    }
    // Its own mediations and parthoods found it, or those of a role above
    // it. A mediation of a rigid supertype does not: an enrollment mediating
    // `Person` says what persons may have, not what makes one a student.
    if (foundingRelations(classDeclaration, lookup.touching(classDeclaration)).length > 0
        || foundedAbove(classDeclaration, ancestor => lookup.touching(ancestor))) {
        return;
    }
    const above = [...collectAncestors(classDeclaration)].find(ancestor => lookup.touching(ancestor).some(relation =>
        relation.stereotype === 'mediation' && relation.target?.ref === ancestor));
    accept(
        'hint',
        above
            ? `Nothing mediates "${classDeclaration.name}" itself: the mediation of "${above.name}" says what any ${above.name} may have, not what makes one a ${classDeclaration.name}. A role holds while a relationship does, so mediate "${classDeclaration.name}" -- or, if the condition is intrinsic, this is a "phase".`
            : `Nothing mediates "${classDeclaration.name}". A role holds while a relationship does, so name the relator that founds it -- or, if the condition is intrinsic, this is a "phase".`,
        { node: classDeclaration, property: 'name', code: 'role-without-relator' }
    );
}

/**
 * The same evidence read the other way: a rigid subdivision that a relator
 * founds.
 *
 * `checkRoleHasRelator` reads a role with no relator; this reads a relator
 * with no role. Being mediated is what says a type is held in virtue of a
 * relationship -- it is the evidence `DepPhase` reads to tell a phase from a
 * role -- and a `subkind` is *rigid*, so it claims its instances are
 * instances necessarily. Something cannot be necessarily a customer and a
 * customer only while a purchase stands.
 *
 * Stronger than the phase case, which is a choice between two anti-rigid
 * readings: this is a contradiction between what the stereotype claims and
 * what the mediation shows. It is still a hint, because the model may mean
 * the mediation loosely, and because the repair -- `role` -- is a change to
 * what the model says about identity rather than a slip to be corrected.
 *
 * Only the class itself, never an ancestor: a relator mediating the `kind`
 * above is mediating the kind, and a kind mediated is the ordinary
 * simplification of a model that has not named the role yet.
 */
export function checkSubkindIsNotFoundedOnARelator(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    if (classDeclaration.stereotype !== 'subkind') {
        return;
    }
    const relator = lookup.touching(classDeclaration)
        .filter(relation => relation.stereotype === 'mediation'
            && relation.target?.ref === classDeclaration)
        .map(relation => getRelationSource(relation))
        .find((source): source is ClassDeclaration => !!source && isClassDeclaration(source));
    if (!relator) {
        return;
    }
    accept(
        'hint',
        `"${relator.name}" mediates "${classDeclaration.name}", so what makes it hold is a relationship -- but a "subkind" is rigid, and claims its instances are instances necessarily. A "role" is the stereotype for a type founded on a relationship.`,
        { node: classDeclaration, property: 'name', code: 'subkind-founded-on-relator' }
    );
}

/**
 * A role, or a historical role, founded by one relation alone cannot do
 * without it.
 *
 * What founds an instance is the one thing it cannot lack: a student with no
 * enrollment is not a student, and a former employee who took part in no
 * retirement took part in nothing that made them one. So where a single
 * relation founds the class, the multiplicity at its far end says at least
 * one. Where several do, each may be optional, since only one of them has to
 * hold: a former employee retired or was dismissed. Making every one
 * mandatory would require both; the export writes the disjunction instead.
 *
 * Reported at the multiplicity, which is what the repair changes and may be in
 * a file other than the class's. Silent where a supertype founded the same way
 * already founds the class, since then this relation is not assumed to be what
 * does. A hint, like the checks that ask for the founding relation at all.
 */
export function checkFoundingRelationIsRequired(
    lookup: ReverseLookup, relation: Relation, accept: ValidationAcceptor
): void {
    for (const side of ['source', 'target'] as const) {
        const founded = side === 'source' ? getRelationSource(relation) : relation.target?.ref;
        if (!founded || !isClassDeclaration(founded) || foundingSide(relation, founded) !== side) {
            continue;
        }
        // Where a derivation founds it too, this relation is one of several,
        // and each of several may be optional.
        if (foundingRelations(founded, lookup.touching(founded)).length !== 1
            || founded.derivedFrom.length > 0
            || foundedAbove(founded, ancestor => lookup.touching(ancestor))) {
            continue;
        }
        const far = side === 'source' ? relation.targetCardinality : relation.sourceCardinality;
        const bounds = far && getBounds(far);
        if (!far || !bounds || bounds.lower >= 1) {
            continue;
        }
        const other = side === 'source' ? relation.target?.ref : getRelationSource(relation);
        const otherName = other && 'name' in other ? other.name : 'it';
        const written = far.$cstNode?.text ?? '';
        const required = bounds.upper === 1 ? '[1]' : Number.isFinite(bounds.upper) ? `[1..${bounds.upper}]` : '[1..*]';
        const because = foundingOf(founded) === 'historical'
            ? `"${founded.name}" is a historical role, held because of an event, and this "@${relation.stereotype}" in "${otherName}" is the only one named: ${written} lets one hold it with no such event, so the event end needs at least one`
            : relation.stereotype === 'mediation'
                ? `"${founded.name}" is a role, held while a relationship is, and "${otherName}" is the only relator named for it: ${written} lets one be mediated by none`
                : `"${founded.name}" is a role, held while it is part of something, and "${otherName}" is the only whole named for it: ${written} lets one be part of none`;
        accept(
            'hint',
            `${because}. Write ${required} -- or, if something else can found it, name that too.`,
            {
                node: relation,
                property: side === 'source' ? 'targetCardinality' : 'sourceCardinality',
                code: 'founding-relation-optional',
                data: { replacement: required }
            }
        );
    }
}

/**
 * Phases partition the lifecycle of what they specialize: an individual is
 * always in exactly one of them, and moves between them. Two or more phases of
 * the same parent that no `disjoint complete` generalization set covers are
 * therefore under-specified -- nothing says an individual must be in one, nor
 * that it cannot be in both.
 *
 * A class can change along more than one line at once -- a person is a
 * child or an adult, and, independently, ill or healthy -- so the phases need
 * not share one set: each partition is its own, and what is asked is that
 * every phase is in one of them.
 *
 * Reported on the parent, which is where the missing generalization set
 * belongs, and only from two phases up: a lone phase is a partition still
 * being written.
 */
export function checkPhasesFormAPartition(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    checkStagesFormAPartition(lookup, classDeclaration, accept, 'phase');
}

/**
 * The same for phase mixins, which are phases over more than one kind: they
 * come in partitions, whose members are alternative intrinsic conditions for
 * entities that may follow different identity principles -- living and deceased
 * animals, functional and broken devices. Two of them under one non-sortal
 * that no `disjoint complete` set covers leave unsaid that an instance is in
 * exactly one, as two such phases do.
 *
 * Its own code, since what is missing is said of a different stereotype and
 * a model may want to hear about one and not the other; the reading, the
 * one-partition-per-line allowance and the repair are the phases'.
 */
export function checkPhaseMixinsFormAPartition(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    checkStagesFormAPartition(lookup, classDeclaration, accept, 'phaseMixin');
}

/** How each of the two partition rules speaks of what it counts. */
const STAGES = {
    phase: { code: 'phases-without-partition', one: 'Phase', many: 'Phases', why: '' },
    phaseMixin: {
        code: 'phase-mixins-without-partition', one: 'Phase mixin', many: 'Phase mixins',
        why: ' Phase mixins are always defined in partitions.'
    }
} as const;

function checkStagesFormAPartition(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor,
    stereotype: keyof typeof STAGES
): void {
    const phases = phasesOf(lookup, classDeclaration, stereotype);
    if (phases.length < 2) {
        return;
    }
    // Sets from anywhere: one written beside the parent, and one written in a
    // third file that names the phases, say the same thing.
    const covered = new Set(setsOver(classDeclaration).flatMap(set => set.specifics.map(ref => ref.ref)));
    const loose = phases.filter(phase => !covered.has(phase));
    if (loose.length === 0) {
        return;
    }
    const words = STAGES[stereotype];
    const names = loose.map(phase => `"${phase.name}"`).join(', ');
    const message = loose.length === phases.length
        ? `${words.many} ${names} divide "${classDeclaration.name}" but no "disjoint complete" generalization set says so, leaving it unstated that an individual is in exactly one.${words.why}`
        : loose.length === 1
            ? `${words.one} ${names} of "${classDeclaration.name}" is in no "disjoint complete" generalization set, leaving it unstated what it alternates with. Add it to the partition it belongs to, or write the ${words.many.toLowerCase()} it alternates with and partition them.`
            : `${words.many} ${names} of "${classDeclaration.name}" are in no "disjoint complete" generalization set, leaving it unstated that an individual is in exactly one of them.`;
    const document = AstUtils.getDocument(classDeclaration);
    accept('warning', message, {
        node: classDeclaration,
        property: 'name',
        code: words.code,
        // The repair writes a set over the phases no partition holds, naming
        // them; it can only do that for phases this document can name
        // unqualified, and from two of them up.
        data: {
            local: loose.every(phase => AstUtils.getDocument(phase) === document),
            phases: loose.map(phase => phase.name),
            stereotype
        }
    });
}

/** The `disjoint complete` sets over this class, wherever they are written. */
function setsOver(classDeclaration: ClassDeclaration): GeneralizationSet[] {
    return generalizationSetsOver(classDeclaration).filter(set => set.disjoint && set.complete);
}

/** Every generalization set this class is the general of, wherever written. */
function generalizationSetsOver(classDeclaration: ClassDeclaration): GeneralizationSet[] {
    const model = AstUtils.getDocument(classDeclaration).parseResult.value as Model;
    const local = model.packages
        .flatMap(pkg => pkg.declarations)
        .filter(isGeneralizationSet);
    return [...new Set([...local, ...referringGeneralizationSets(classDeclaration)])]
        .filter(set => set.general?.ref === classDeclaration);
}

/**
 * Whether every instance of this class is an instance of something that says
 * what the class itself has left unsaid.
 *
 * A `complete` generalization set says its specifics exhaust the general: an
 * instance of the general is an instance of one of them. So a
 * `category Bond of relators` partitioned into `Marriage` and `Employment`,
 * each mediating what it binds, has nothing missing -- every bond mediates,
 * because every bond is one of those. Reading the class and its ancestors
 * alone reported the abstraction for an omission its subtypes had already
 * made good, which is the ordinary shape of a taxonomy with the general
 * written first.
 *
 * Recursive, since a specific may be exhausted by a complete set of its own,
 * and guarded against a cycle in the sets rather than in the taxonomy, which
 * `specialization-cycle` reports.
 */
function coveredBySubtypes(
    classDeclaration: ClassDeclaration,
    declares: (candidate: ClassDeclaration) => boolean,
    seen: Set<ClassDeclaration> = new Set()
): boolean {
    if (seen.has(classDeclaration)) {
        return false;
    }
    seen.add(classDeclaration);
    return generalizationSetsOver(classDeclaration)
        .filter(set => set.complete)
        .some(set => {
            const specifics = set.specifics
                .map(reference => reference.ref)
                .filter((specific): specific is ClassDeclaration => !!specific && isClassDeclaration(specific));
            return specifics.length > 0 && specifics.every(specific =>
                declares(specific) || coveredBySubtypes(specific, declares, seen));
        });
}

/** Whether this class or anything above it opens a relation of that stereotype. */
function declaresRelation(lookup: ReverseLookup, stereotype: string): (node: ClassDeclaration) => boolean {
    return node => [node, ...collectAncestors(node)]
        .some(ancestor => outgoingByStereotype(lookup, ancestor, stereotype).length > 0);
}

/**
 * A historical role is held because something happened, so the model should
 * say what: an event it took part in, or was created or terminated in, written
 * as its own relation or named by a `derivedFrom` where the relation is
 * written on what took part -- a graduate is whoever, as a student, took part
 * in a graduation.
 *
 * As an error that would be too strong -- an instance is a former student
 * whether or not the model has got round to naming the enrollment -- but as a
 * hint it is the most useful thing the language can say about the stereotype:
 * a historical role with no event behind it is usually a role, or a phase.
 */
export function checkHistoricalRoleParticipatesInAnEvent(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    if (classDeclaration.stereotype !== 'historicalRole' && classDeclaration.stereotype !== 'historicalRoleMixin') {
        return;
    }
    // Its own participations, creations and terminations found it, a
    // derivation from one written elsewhere does, or a historical role above
    // it is founded; a kind's birth founds nothing about the historical roles
    // under it. A derivation that names the wrong thing is its own error.
    if (foundingRelations(classDeclaration, lookup.touching(classDeclaration)).length > 0
        || classDeclaration.derivedFrom.length > 0
        || foundedAbove(classDeclaration, ancestor => lookup.touching(ancestor))) {
        return;
    }
    accept(
        'hint',
        `"${classDeclaration.name}" holds forever because something happened, but no event is named. Add the "@participation", "@creation" or "@termination" that makes it hold, or derive it from one written elsewhere with "derivedFrom" -- or, if nothing did, this is a "role".`,
        { node: classDeclaration, property: 'name', code: 'historical-role-without-event' }
    );
}

/** What an endurant did in an event, for each relation that founds a historical role. */
const FOUNDING_VERB: Readonly<Record<string, string>> = {
    participation: 'took part in', creation: 'was created in', termination: 'was terminated in'
};

/** How a diagnostic names a relation: by its qualified name, or by what it is. */
function relationLabel(relation: Relation): string {
    const source = getRelationSource(relation);
    const sourceName = source && 'name' in source ? source.name : '?';
    return relation.name
        ? `"${sourceName}.${relation.name}"`
        : `the unnamed ${relation.stereotype ? `"@${relation.stereotype}"` : 'association'} from "${sourceName}"`;
}

/** Whether everything this class classifies happens rather than endures. */
function happens(classDeclaration: ClassDeclaration): boolean {
    const natures = possibleNaturesOf(classDeclaration);
    return !!natures && natures.size > 0 && [...natures].every(nature => nature === 'events' || nature === 'processes');
}

/**
 * What a `derivedFrom` on a class names.
 *
 * A historical role is derived from what happened: a graduate is whoever, as
 * a student, took part in a graduation, and once that has happened it stays
 * happened -- which is why the role never lapses. So the clause belongs on a
 * historical role, and what it names is a relation an event founds one by --
 * `@participation`, `@creation` or `@termination` -- from something that can
 * be an instance of the role, or the event itself where exactly one such
 * relation reaches it. Each of those is an error when it fails: a derivation
 * that names something else derives nothing, and the gUFO export writes the
 * derivation as a definition.
 */
export function checkClassDerivation(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    if (classDeclaration.derivedFrom.length === 0) {
        return;
    }
    const stereotype = classDeclaration.stereotype;
    if (stereotype !== 'historicalRole' && stereotype !== 'historicalRoleMixin') {
        const historical = stereotype === 'role' ? 'historicalRole' : stereotype === 'roleMixin' ? 'historicalRoleMixin' : undefined;
        accept(
            'error',
            `Only a historical role is derived from what happened, and "${classDeclaration.name}" is ${a(stereotype)}. Remove "derivedFrom"${historical ? ` -- or, if being one is founded by an event and never lapses, make it a "${historical}"` : ''}.`,
            { node: classDeclaration, keyword: 'derivedFrom', code: 'class-derivation-not-historical' }
        );
        return;
    }
    classDeclaration.derivedFrom.forEach((reference, index) => {
        const named = reference.ref;
        const at = { node: classDeclaration, property: 'derivedFrom' as const, index };
        if (isRelation(named)) {
            const participant = getRelationSource(named);
            if (!foundsHistorically(named)) {
                accept(
                    'error',
                    `${relationLabel(named)} is ${named.stereotype ? `a "@${named.stereotype}"` : 'a plain association'}, and a historical role is founded by an event: a "@participation", "@creation" or "@termination" in one.`,
                    { ...at, code: 'historical-derivation-not-founding' }
                );
            } else if (participant && isClassDeclaration(participant) && cannotShareInstances(participant, classDeclaration)) {
                const event = named.target?.ref;
                accept(
                    'error',
                    `${relationLabel(named)} is how ${a(participant.name)} ${FOUNDING_VERB[named.stereotype ?? '']} "${event?.name ?? '?'}", and no "${participant.name}" can be ${a(classDeclaration.name)}, so it is not what makes one.`,
                    { ...at, code: 'historical-derivation-participant-disjoint' }
                );
            }
            return;
        }
        if (!named || !isClassDeclaration(named)) {
            return;
        }
        if (!happens(named)) {
            accept(
                'error',
                `"${named.name}" is ${a(named.stereotype)}, and a historical role is derived from an event, or from a relation into one.`,
                { ...at, code: 'historical-derivation-not-founding' }
            );
            return;
        }
        const candidates = foundingCandidatesInto(classDeclaration, named, candidate => lookup.touching(candidate));
        if (candidates.length === 0) {
            accept(
                'error',
                `Nothing that can be ${a(classDeclaration.name)} took part in, was created in or was terminated in "${named.name}". Write the relation that makes one ${a(classDeclaration.name)}, and derive it from that.`,
                { ...at, code: 'historical-derivation-not-founding' }
            );
        } else if (candidates.length > 1) {
            const unnamed = candidates.some(candidate => !candidate.name);
            accept(
                'error',
                `More than one relation into "${named.name}" could make something a "${classDeclaration.name}": ${candidates.map(relationLabel).join(', ')}. Name the one meant${unnamed ? ', giving it a name if it has none' : ''}.`,
                { ...at, code: 'historical-derivation-ambiguous' }
            );
        }
    });
}

/**
 * A phase alternates with another; one on its own divides nothing.
 *
 * A partition of phases holds at least two, and a lone phase is the case
 * that leaves standing: `checkPhasesFormAPartition` asks whether the phases are
 * partitioned, and one phase is not a partition to look for. Either the phase
 * it alternates with is missing, or what was meant is a rigid subdivision.
 *
 * A hint: the sibling may be about to be written, and only the modeler knows
 * which of the two answers is right.
 *
 * Not asked of a phase that specializes two phases or more. An `IllChild`
 * under `Child` and `IllPerson` -- one phase from each of two independent
 * partitions of `Person` -- is where the two meet, and what it alternates
 * with is already said by the partitions its parents are in.
 */
export function checkPhaseHasASibling(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    if (classDeclaration.stereotype !== 'phase') {
        return;
    }
    const above = getDirectGeneralizations(classDeclaration);
    if (above.length === 0 || above.some(parent => phasesOf(lookup, parent).length > 1)
        || above.filter(parent => parent.stereotype === 'phase').length > 1) {
        return;
    }
    accept(
        'hint',
        `"${classDeclaration.name}" is the only phase of ${above.map(parent => `"${parent.name}"`).join(', ')}. A phase is one stage of a life, so there is always another -- or what is meant is a "subkind", which divides without any stage passing.`,
        { node: classDeclaration, property: 'name', code: 'lone-phase' }
    );
}

/**
 * A partition of phases holds phases and nothing else.
 *
 * A set mixing a phase with a subkind says that an
 * individual is in exactly one of them, which is two claims at once -- one
 * about a stage that passes and one about a division that does not -- and the
 * partition cannot be both.
 */
export function checkPartitionOfPhasesIsUniform(genset: GeneralizationSet, accept: ValidationAcceptor): void {
    if (!genset.disjoint || !genset.complete) {
        return;
    }
    const specifics = genset.specifics.map(ref => ref.ref).filter((ref): ref is ClassDeclaration => !!ref);
    const phases = specifics.filter(specific => specific.stereotype === 'phase');
    const others = specifics.filter(specific => specific.stereotype !== 'phase');
    if (phases.length === 0 || others.length === 0) {
        return;
    }
    accept(
        'warning',
        `"${genset.name}" partitions ${phases.map(p => `"${p.name}"`).join(', ')} -- stages that pass -- together with ${others.map(o => `"${o.name}" (${o.stereotype})`).join(', ')}, which ${others.length > 1 ? 'do' : 'does'} not. A partition of phases holds phases and nothing else.`,
        { node: genset, property: 'name', code: 'partition-mixes-phases' }
    );
}

/** The phases that directly specialize this class, in any document. */
export function phasesOf(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, stereotype: 'phase' | 'phaseMixin' = 'phase'
): ClassDeclaration[] {
    return subtypesOf(lookup, classDeclaration)
        .filter(subtype => subtype.stereotype === stereotype
            && getDirectGeneralizations(subtype).includes(classDeclaration));
}

/** The phases (or phase mixins) of this class that are written in its own document. */
export function localPhasesOf(
    classDeclaration: ClassDeclaration, stereotype: 'phase' | 'phaseMixin' = 'phase'
): ClassDeclaration[] {
    const document = AstUtils.getDocument(classDeclaration);
    return documentSubtypesOf(classDeclaration)
        .filter(subtype => subtype.stereotype === stereotype
            && getDirectGeneralizations(subtype).includes(classDeclaration))
        .filter(subtype => AstUtils.getDocument(subtype) === document);
}

/**
 * Classes anywhere in the workspace that specialize this one, directly or not.
 *
 * The document alone is not the model. A phase whose sibling is in another
 * file was reported as the only phase of its parent, and a partition written
 * beside the parent was invisible to the phases -- both diagnostics saying
 * that something is missing when it is present, which is the failure a
 * modeler cannot act on.
 *
 * Walking down needs what points *at* a class, so it goes through the same
 * workspace lookup the rest of these checks use, and the local scan stays as
 * its floor: a document not yet indexed still answers about itself.
 */
export function subtypesOf(lookup: ReverseLookup, classDeclaration: ClassDeclaration): ClassDeclaration[] {
    const found = new Set<ClassDeclaration>(documentSubtypesOf(classDeclaration));
    const pending = [classDeclaration, ...found];
    while (pending.length > 0) {
        const current = pending.pop() as ClassDeclaration;
        for (const child of directSubtypesOf(lookup, current)) {
            if (child !== classDeclaration && !found.has(child)) {
                found.add(child);
                pending.push(child);
            }
        }
    }
    return [...found];
}

/** What names this class as a parent: a `specializes` clause or a set. */
function directSubtypesOf(lookup: ReverseLookup, classDeclaration: ClassDeclaration): ClassDeclaration[] {
    const found: ClassDeclaration[] = [];
    for (const referrer of lookup.referrers(classDeclaration)) {
        if (isClassDeclaration(referrer) && getDirectGeneralizations(referrer).includes(classDeclaration)) {
            found.push(referrer);
        } else if (isGeneralizationSet(referrer) && referrer.general?.ref === classDeclaration) {
            for (const specific of referrer.specifics) {
                // A set may generalize relations as well as classes.
                if (specific.ref && isClassDeclaration(specific.ref)) {
                    found.push(specific.ref);
                }
            }
        }
    }
    return found;
}

/** Classes in the document that specialize this one, directly or not. */
function documentSubtypesOf(classDeclaration: ClassDeclaration): ClassDeclaration[] {
    const model = AstUtils.getDocument(classDeclaration).parseResult.value as Model;
    const result: ClassDeclaration[] = [];
    for (const pkg of model.packages) {
        for (const declaration of pkg.declarations) {
            if (isClassDeclaration(declaration) && declaration !== classDeclaration
                && collectAncestors(declaration).has(classDeclaration)) {
                result.push(declaration);
            }
        }
    }
    return result;
}

/**
 * a51 -- supplementation: a whole has more than one part, since otherwise
 * nothing would distinguish it from the single part.
 *
 * Reported at hint severity -- the faintest thing an editor draws, and absent
 * from the Problems panel -- because a diagram does not claim to enumerate
 * every part. `Car <>-- [1] Engine` says a car has an engine, not that the
 * engine is all it has, so a single modeled part is a question about the
 * decomposition rather than a contradiction, and one worth asking quietly.
 *
 * What is counted is how many parts an instance must have -- the lower bounds
 * summed, so one `@componenthood` of `[2..*]` supplies two, exactly as a
 * relator's mediations are counted. A collective's are its members: a
 * `@subCollection` is a portion of it and supplements nothing, which is why
 * it is left out of the sum. Exactly one is the case worth raising: a
 * minimum of zero claims nothing, since `<>-- [0..*]` does not say the whole
 * has any parts at all, so there is no lone part for a second to be missing
 * from.
 */
/** Whether this class, with everything it inherits, must contain exactly one part. */
function onePartOnly(lookup: ReverseLookup, classDeclaration: ClassDeclaration): boolean {
    const parthoods = [classDeclaration, ...collectAncestors(classDeclaration)]
        .flatMap(member => parthoodsWholedBy(lookup, member))
        .filter(parthood => parthood.relation.stereotype !== 'subCollection');
    return parthoods.length > 0
        && parthoods.reduce((sum, parthood) => sum + parthood.least, 0) === 1;
}

export function checkWeakSupplementation(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    const parthoods = [classDeclaration, ...collectAncestors(classDeclaration)]
        .flatMap(member => parthoodsWholedBy(lookup, member))
        // A sub-collection is a portion of the collective, not one of the
        // things it is made of: what supplements a collective is its members,
        // and they supplement each other -- a `@membership` end of `[2..*]`
        // discharges this before any sub-collection is written. Counting a
        // lone sub-collection as the one part reported a choir with a section
        // in it, and offered to widen the end `sub-collection-multiplicity`
        // fixes at one.
        .filter(parthood => parthood.relation.stereotype !== 'subCollection');
    if (parthoods.length === 0) {
        return;
    }
    const least = parthoods.reduce((sum, parthood) => sum + parthood.least, 0);
    // What a supertype must contain, a subtype must contain, so the sum is
    // over the lineage -- a subtype that adds a second part is answered by
    // the one it inherits. And where the count is the supertype's own, the
    // supertype is where it is reported: the same omission, said once.
    const inherited = [...collectAncestors(classDeclaration)]
        .some(member => onePartOnly(lookup, member));
    if (least !== 1 || inherited) {
        return;
    }
    accept(
        'hint',
        `Every "${classDeclaration.name}" has exactly one part, and supplementation requires a whole to have more than one. Either the decomposition is incomplete, or a part end should be widened to "[2..*]".`,
        { node: classDeclaration, property: 'name', code: 'whole-with-one-part' }
    );
}

/** The relations UFO declares irreflexive and asymmetric on individuals. */
const ACYCLIC_STEREOTYPES: ReadonlyArray<{ stereotype: string; noun: string; because: string }> = [
    {
        stereotype: 'characterization',
        noun: 'must inhere in',
        because: 'inherence is irreflexive and asymmetric, so the chain can never close'
    },
    {
        stereotype: 'constitution',
        noun: 'must be constituted by',
        because: 'constitution is asymmetric, so the chain can never close'
    }
];

/**
 * t28, t29 and a61 -- inherence and constitution are irreflexive and
 * asymmetric.
 *
 * Those axioms are about *individuals*, and a type diagram says nothing about
 * which individuals stand in a relation, so a cycle among types entails
 * nothing by itself. `mode Belief { @characterization -- [0..1] Belief }` is a
 * belief that may be about another belief, which is an ordinary thing to
 * model and involves no individual inhering in itself.
 *
 * What does follow is when every step of the cycle is *mandatory*: each
 * individual then needs another, which needs another, and since the relation
 * can never come back round the chain has no end. Only that shape is
 * reported.
 */
export function checkAcyclicDependencies(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    for (const { stereotype, noun, because } of ACYCLIC_STEREOTYPES) {
        const stereotypes = new Set([stereotype]);
        // Through the lineage: a dependence written at a supertype is one
        // every instance of the subtype has, so a chain may run through a
        // class that declares nothing itself.
        const required = (node: ClassDeclaration): ClassDeclaration[] =>
            [node, ...collectAncestors(node)].flatMap(member => targetsOf(lookup, member, stereotypes, true));
        const found = findCycle(classDeclaration, required);
        const path = found && !ancestorsAlreadyIn(classDeclaration, required, found)
            ? found
            : undefined;
        if (path) {
            accept(
                'error',
                `Every ${chain([classDeclaration.name, ...path], noun)}, so no individual could ever be complete -- ${because}.`,
                { node: classDeclaration, property: 'name', code: `${stereotype}-cycle` }
            );
        }
    }
}

/**
 * a67 -- the non-migration principle: a moment inheres in exactly one
 * individual, so a moment type cannot be characterized against two unrelated
 * bearers.
 *
 * Bearers that specialize one another are fine: the narrower one restates the
 * inherence more precisely rather than adding a second bearer.
 */
export function checkMomentHasOneBearer(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    const bearers = [...new Set([classDeclaration, ...collectAncestors(classDeclaration)]
        .flatMap(member => targetsOf(lookup, member, new Set(['characterization']))))];
    for (let i = 0; i < bearers.length; i++) {
        for (let j = i + 1; j < bearers.length; j++) {
            if (isSameOrSpecializes(bearers[i], bearers[j]) || isSameOrSpecializes(bearers[j], bearers[i])) {
                continue;
            }
            accept(
                'error',
                `A moment inheres in exactly one individual, but "${classDeclaration.name}" is characterized against both "${bearers[i].name}" and "${bearers[j].name}", which are unrelated.`,
                { node: classDeclaration, property: 'name', code: 'moment-with-two-bearers' }
            );
            return;
        }
    }
}

/**
 * a57 -- constitution holds between things of different kinds. Constituent and
 * constituted obey different principles of identity, which is what lets the
 * statue and the clay have different persistence conditions in the first
 * place; drawn within one kind, the relation says nothing.
 */
export function checkConstitutionCrossesKinds(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    const own = ultimateSortalOf(classDeclaration, isUltimateSortal);
    if (!own) {
        return;
    }
    for (const constituent of targetsOf(lookup, classDeclaration, new Set(['constitution']))) {
        if (ultimateSortalOf(constituent, isUltimateSortal) === own) {
            accept(
                'error',
                `Constitution holds between things of different kinds, but "${classDeclaration.name}" and "${constituent.name}" both draw identity from "${own.name}".`,
                { node: classDeclaration, property: 'name', code: 'constitution-within-one-kind' }
            );
            return;
        }
    }
}

/**
 * Natures as prose: "extrinsic modes", "qualities and intrinsic modes".
 *
 * The stereotype is the wrong thing to name here. Both this check and
 * `checkRelatorHasMediation` judge by nature, so a `phase` over intrinsic
 * modes is caught -- and "is a phase whose instances inhere in something"
 * would name the one thing the check did not look at.
 */
export function readable(natures: ReadonlySet<string> | undefined): string {
    const names = [...natures ?? []].map(nature => nature.replace(/-/g, ' '));
    if (names.length <= 1) {
        return names[0] ?? 'moments';
    }
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
