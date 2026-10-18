import type { ClassDeclaration } from '../generated/ast.js';
import { registerDerivedCacheReset } from './derived-cache.js';
import { getDirectGeneralizations } from './generalizations.js';
import { allowedNaturesFor, expandNatures } from '../validation/stereotype-model.js';

/**
 * Where a restriction on a class's instances comes from.
 *
 * Three sources, and every rule in this file treats them alike -- which is the
 * point. Reasoning that special-cases one of them ends up needing a separate
 * rule for each combination, and those rules drift apart.
 */
export type ConstraintKind = 'stereotype' | 'declared' | 'supertype';

export interface NatureConstraint {
    kind: ConstraintKind;
    /** The atomic natures this constraint permits. */
    natures: ReadonlySet<string>;
    /** The supertype it came from, when `kind` is `supertype`. */
    parent?: ClassDeclaration;
}

/**
 * How a set of constraints can be wrong.
 *
 * `unsatisfiable` -- nothing satisfies all of them at once, so the class can
 * have no instances. `widening` -- an explicit `of` clause names a nature its
 * supertypes do not allow; the intersection may still be non-empty, but a
 * subtype cannot admit what its supertype excludes.
 */
export type NatureViolation = 'unsatisfiable' | 'widening';

/** Every restriction bearing on the instances of a class. */
export function constraintsOn(classDeclaration: ClassDeclaration): NatureConstraint[] {
    const constraints: NatureConstraint[] = [];

    const byStereotype = allowedNaturesFor(classDeclaration.stereotype);
    if (byStereotype && byStereotype.length > 0) {
        constraints.push({ kind: 'stereotype', natures: expandNatures(byStereotype) });
    }
    if (classDeclaration.natures.length > 0) {
        constraints.push({ kind: 'declared', natures: expandNatures(classDeclaration.natures) });
    }
    for (const parent of getDirectGeneralizations(classDeclaration)) {
        const natures = possibleNaturesOf(parent);
        // A parent that restricts nothing constrains nothing.
        if (natures) {
            constraints.push({ kind: 'supertype', natures, parent });
        }
    }
    return constraints;
}

/** The natures an instance could have: everything all the constraints allow. */
export function possibleNatures(constraints: readonly NatureConstraint[]): Set<string> | undefined {
    let result: Set<string> | undefined;
    for (const constraint of constraints) {
        result = result === undefined
            ? new Set(constraint.natures)
            : new Set([...result].filter(nature => constraint.natures.has(nature)));
    }
    return result;
}

/**
 * The natures a class's instances could have, following generalizations all
 * the way up. `undefined` when nothing anywhere restricts them.
 */
export function possibleNaturesOf(classDeclaration: ClassDeclaration): Set<string> | undefined {
    const cached = natureCache.get(classDeclaration);
    if (cached !== undefined) {
        return cached.natures;
    }
    // A class reached again while it is still being computed is a
    // generalization cycle. It answers "unrestricted", which terminates the
    // walk and can only widen, never invent a conflict.
    if (underway.has(classDeclaration)) {
        cycleHits++;
        return undefined;
    }
    underway.add(classDeclaration);
    const before = cycleHits;
    const natures = possibleNatures(constraintsOn(classDeclaration));
    underway.delete(classDeclaration);
    // Answered with, but not kept, if a cycle was open while it was computed:
    // the answer was folded from that "unrestricted" stand-in, so it is as
    // wide as the walk happened to stop, not as wide as the model says.
    // Keeping it made every later question read the widest of the two, and
    // which one that was depended on which class the validator reached first
    // -- so swapping two lines of a model changed what was reported about a
    // third class hanging off them.
    if (cycleHits === before) {
        natureCache.set(classDeclaration, { natures });
    }
    return natures;
}

/** Whether nothing at all satisfies these constraints together. */
export function isUnsatisfiable(constraints: readonly NatureConstraint[]): boolean {
    const possible = possibleNatures(constraints);
    return !!possible && possible.size === 0;
}

/**
 * Whether an `of` clause names a nature its supertypes do not allow. An `of`
 * clause may narrow what is inherited, never diverge from it.
 */
export function isWidening(constraints: readonly NatureConstraint[]): boolean {
    const declared = constraints.find(constraint => constraint.kind === 'declared');
    const inherited = possibleNatures(constraints.filter(constraint => constraint.kind === 'supertype'));
    return !!declared && !!inherited && [...declared.natures].some(nature => !inherited.has(nature));
}

/**
 * Whether these constraints contradict each other, and how.
 *
 * The two conditions are independent, and both are checked: an unsatisfiable
 * set can also be a widening one, and reporting only the first would hide the
 * clause a modeler most likely wants to hear about.
 */
export function violationOf(constraints: readonly NatureConstraint[]): NatureViolation | undefined {
    if (isUnsatisfiable(constraints)) {
        return 'unsatisfiable';
    }
    return isWidening(constraints) ? 'widening' : undefined;
}

/**
 * The constraints that are individually to blame: those whose removal leaves
 * a consistent set.
 *
 * This is the one definition of culpability. Asking it per diagnostic -- "does
 * this supertype share a nature?", "does it permit every declared one?" --
 * needs a different rule for each violation, and getting one of them subtly
 * wrong is invisible until a model happens to hit it.
 *
 * It also declines to blame anyone when no single removal helps: two
 * object-natured supertypes under an `event` are not individually at fault,
 * since dropping either leaves the other contradicting the stereotype just as
 * flatly. `sufficientRemovals` covers that case.
 */
export function culprits(classDeclaration: ClassDeclaration): NatureConstraint[] {
    const constraints = constraintsOn(classDeclaration);
    if (!violationOf(constraints)) {
        return [];
    }
    return constraints.filter(candidate =>
        !violationOf(constraints.filter(constraint => constraint !== candidate)));
}

/**
 * Whether dropping every supertype at once would settle it -- the repair to
 * offer when no single one is to blame.
 */
export function removingAllSupertypesHelps(classDeclaration: ClassDeclaration): boolean {
    const constraints = constraintsOn(classDeclaration);
    if (!violationOf(constraints)) {
        return false;
    }
    return !violationOf(constraints.filter(constraint => constraint.kind !== 'supertype'));
}

/**
 * Whether `candidate` could stand as a supertype of `subject` without making
 * it uninstantiable -- the same question the validator asks, put to a
 * hierarchy that does not exist yet.
 */
export function admitsSupertype(subject: ClassDeclaration, candidate: ClassDeclaration): boolean {
    const natures = possibleNaturesOf(candidate);
    if (!natures) {
        return true;
    }
    return !violationOf([...constraintsOn(subject), { kind: 'supertype', natures, parent: candidate }]);
}

/**
 * Whether `stereotype` could be given to this class -- again the validator's
 * question, asked of a stereotype it does not currently have.
 */
export function admitsStereotype(classDeclaration: ClassDeclaration, stereotype: string): boolean {
    const allowed = allowedNaturesFor(stereotype);
    const others = constraintsOn(classDeclaration).filter(constraint => constraint.kind !== 'stereotype');
    const proposed: NatureConstraint[] = allowed && allowed.length > 0
        ? [...others, { kind: 'stereotype', natures: expandNatures(allowed) }]
        : others;
    return !violationOf(proposed);
}

/** Holds resolved references, so it is dropped whenever documents relink. */
let natureCache = new WeakMap<ClassDeclaration, { natures: Set<string> | undefined }>();

/**
 * The classes whose natures are being computed right now, and a count of how
 * often that set has been consulted -- which is how a result computed across
 * a generalization cycle is told from one that stands on its own.
 */
const underway = new Set<ClassDeclaration>();
let cycleHits = 0;

registerDerivedCacheReset(() => {
    natureCache = new WeakMap();
    underway.clear();
    cycleHits = 0;
});

/** The natures that remain once one kind of constraint is set aside. */
export function naturesWithout(
    classDeclaration: ClassDeclaration, kind: ConstraintKind
): Set<string> | undefined {
    return possibleNatures(constraintsOn(classDeclaration).filter(constraint => constraint.kind !== kind));
}

/**
 * Whether everything this class classifies is itself a type.
 *
 * The high-order question is about natures, not stereotypes: `type PersonType`
 * is one, and so is `category PersonType of types`. Asking through the
 * stereotype missed the second, which is exactly the class the `isPowerType`
 * modifier exists to let people write.
 */
export function classifiesTypes(classDeclaration: ClassDeclaration): boolean {
    return classifiesOnly(classDeclaration, 'types');
}

/** Whether everything this class classifies has that one nature. */
export function classifiesOnly(classDeclaration: ClassDeclaration, nature: string): boolean {
    const natures = possibleNaturesOf(classDeclaration);
    return !!natures && natures.size > 0 && [...natures].every(each => each === nature);
}
