import type { ClassStereotype } from '../generated/ast.js';
import { a } from './wording.js';
import {
    atomsOf, CHANGEABLE_INSTANCE_NATURES, ENDURANT_NATURES, EVERY_NATURE as EVERY_NATURE_NAME
} from './natures.js';

/**
 * What each class stereotype means, as one table.
 *
 * Everything the checks need to know about a stereotype is stated here, once:
 * where it sits in UFO's sortality and rigidity taxonomies, which ontological
 * natures its instances may have, and which stereotypes it may specialize.
 * Nine separate lists used to carry this between them, and nothing held them
 * to each other -- `process` reached the grammar without appearing in any of
 * them, so no rule knew anything about it.
 *
 * The table is keyed by `ClassStereotype`, the union the grammar generates, so
 * a stereotype added to the grammar fails to compile until it is described
 * here. That is the point: the language definition and its rules cannot drift.
 */

// --- Ontological natures ----------------------------------------------------

// Every fact about a nature lives in `natures.ts`; these are the readings of
// it the stereotype table needs. They used to be written out here, and the
// copy went out of step with the language the day `processes` was added.

/**
 * Every nature there is, which any *rigid* type may span.
 *
 * A `category` says nothing about how its instances change, so an unrestricted
 * one has no reason to exclude anything: a situation and an abstract
 * individual are as much individuals as an event is.
 *
 * Anti-rigidity is what narrows the rest -- `role`, `phase`, `historicalRole`
 * and the three anti-rigid mixins alike. Each holds of an individual for part
 * of its life and not the rest, which requires an individual that can change:
 * an event does not stop being that event, a situation cannot change and stay
 * the same situation -- a change is a succession of situations, not one
 * situation altered -- and an abstract individual has no life to divide. They
 * take
 * `CHANGEABLE_INSTANCE_NATURES` and, for the same reason, do not appear
 * beneath an `event` or a `situation` in the taxonomy either.
 *
 * A `mixin` is semi-rigid, so it needs the anti-rigid half somewhere among its
 * natures but not everywhere: it spans all of them, provided at least one can
 * change, which `checkMixinSpansAnEndurant` enforces.
 */
const EVERY_NATURE = EVERY_NATURE_NAME;

/** Every word the grammar accepts in an `of` clause. */
export const NATURE_KEYWORDS: readonly string[] = EVERY_NATURE_NAME;

const ENDURANT_ATOMS = new Set(ENDURANT_NATURES.flatMap(atomsOf));
const CHANGEABLE_INSTANCE_ATOMS = new Set(CHANGEABLE_INSTANCE_NATURES.flatMap(atomsOf));

/** Whether individuals of this nature endure: continuants, no temporal parts. */
export function isEndurantNature(nature: string): boolean {
    return ENDURANT_ATOMS.has(nature);
}

/**
 * Whether an individual of this nature can change: can have a property now and
 * lack it later. Anti-rigidity is available over exactly these, and so is
 * everything else that turns on something being able to stop being the case.
 *
 * Named for the instances, not the nature: it is a person that changes, not
 * `functional-complexes` -- and not "individuals" either, since a high-order
 * type is no individual and changes all the same.
 */
export function instancesCanChange(nature: string): boolean {
    return CHANGEABLE_INSTANCE_ATOMS.has(nature);
}

/** The set of atomic natures a declared nature stands for. */
export function expandNature(nature: string): readonly string[] {
    return atomsOf(nature);
}

export function expandNatures(natures: readonly string[]): Set<string> {
    const result = new Set<string>();
    for (const nature of natures) {
        for (const atomic of expandNature(nature)) {
            result.add(atomic);
        }
    }
    return result;
}

/**
 * Whether every nature in `subject` is permitted by `allowed`, comparing
 * atomic natures. Returns the offending (unexpanded) natures, empty if fine.
 */
export function naturesNotPermittedBy(subject: readonly string[], allowed: readonly string[]): string[] {
    const permitted = expandNatures(allowed);
    return subject.filter(nature => !expandNature(nature).every(atomic => permitted.has(atomic)));
}

// --- The stereotype table ---------------------------------------------------

/**
 * Where a stereotype sits in UFO's taxonomy of endurant types.
 *
 * `ultimate-sortal` supplies a principle of identity, `base-sortal` inherits
 * one, `non-sortal` supplies none and classifies across kinds. `none` is for
 * the stereotypes outside that taxonomy: the bare `class`, which commits to
 * nothing, and the perdurant and high-order stereotypes, which UFO's endurant
 * taxonomy does not reach.
 */
type Sortality = 'ultimate-sortal' | 'base-sortal' | 'non-sortal' | 'none';

/**
 * Whether instances keep the type in every situation they exist in.
 *
 * `semi-rigid` is rigid for some instances and anti-rigid for others; only
 * `mixin` is one, and for the "cannot specialize an anti-rigid type" rule it
 * is constrained exactly like a rigid type.
 */
type Rigidity = 'rigid' | 'semi-rigid' | 'anti-rigid' | 'none';

export interface StereotypeFacts {
    sortality: Sortality;
    rigidity: Rigidity;
    /** Natures its instances may have; `null` where nothing is enforced. */
    natures: readonly string[] | null;
}

/**
 * What each stereotype *is*: how it carries identity, how it behaves under
 * change, and what its instances may be.
 *
 * Nothing here says which stereotype may specialize which. That used to be a
 * fourth column of 112 transcribed edges; every one of them follows from
 * these three facts plus how an anti-rigid type is founded, so
 * `whyNotSpecialize` computes it and `test/taxonomy.test.ts` holds the
 * transcription as the fixture that proves the computation reproduces it.
 *
 * Declared in rough order of how often each is used, since that order is also
 * how suggestions are offered -- see `CLASS_STEREOTYPES_BY_FAMILIARITY`.
 */
export const STEREOTYPES: Record<ClassStereotype, StereotypeFacts> = {
    kind: {
        sortality: 'ultimate-sortal', rigidity: 'rigid',
        natures: ['functional-complexes']
    },
    subkind: {
        sortality: 'base-sortal', rigidity: 'rigid',
        natures: EVERY_NATURE
    },
    role: {
        sortality: 'base-sortal', rigidity: 'anti-rigid',
        natures: CHANGEABLE_INSTANCE_NATURES
    },
    phase: {
        sortality: 'base-sortal', rigidity: 'anti-rigid',
        natures: CHANGEABLE_INSTANCE_NATURES
    },
    category: {
        sortality: 'non-sortal', rigidity: 'rigid',
        natures: EVERY_NATURE
    },
    mixin: {
        sortality: 'non-sortal', rigidity: 'semi-rigid',
        natures: EVERY_NATURE
    },
    collective: {
        sortality: 'ultimate-sortal', rigidity: 'rigid',
        natures: ['collectives']
    },
    quantity: {
        sortality: 'ultimate-sortal', rigidity: 'rigid',
        natures: ['quantities']
    },
    relator: {
        sortality: 'ultimate-sortal', rigidity: 'rigid',
        natures: ['relators']
    },
    quality: {
        sortality: 'ultimate-sortal', rigidity: 'rigid',
        natures: ['qualities']
    },
    // A bare `mode` does not say which it is; the two refinements below do, and
    // they are disjoint. An intrinsic mode depends on nothing beyond its
    // bearer, while an extrinsic one is existentially dependent on a further
    // individual (UFO a69-a70) -- which is what lets `@externalDependence`
    // start at one and not the other.
    mode: {
        sortality: 'ultimate-sortal', rigidity: 'rigid',
        natures: ['intrinsic-modes', 'extrinsic-modes']
    },
    intrinsicMode: {
        sortality: 'ultimate-sortal', rigidity: 'rigid',
        natures: ['intrinsic-modes']
    },
    extrinsicMode: {
        sortality: 'ultimate-sortal', rigidity: 'rigid',
        natures: ['extrinsic-modes']
    },
    roleMixin: {
        sortality: 'non-sortal', rigidity: 'anti-rigid',
        natures: CHANGEABLE_INSTANCE_NATURES
    },
    phaseMixin: {
        sortality: 'non-sortal', rigidity: 'anti-rigid',
        natures: CHANGEABLE_INSTANCE_NATURES
    },
    historicalRole: {
        sortality: 'base-sortal', rigidity: 'anti-rigid',
        natures: CHANGEABLE_INSTANCE_NATURES
    },
    historicalRoleMixin: {
        sortality: 'non-sortal', rigidity: 'anti-rigid',
        natures: CHANGEABLE_INSTANCE_NATURES
    },
    // Perdurants and high-order types are ultimate sortals: they supply a
    // principle of identity, and their
    // specializations are `subkind`s exactly as a kind's are. Classifying them
    // otherwise is what made a `subkind` of an `event` impossible -- it had
    // nowhere to draw identity from.
    // An event specializes only a `category` or a `mixin`, and is
    // specialized only by a `subkind` -- so events form no
    // taxonomy among themselves, exactly as kinds do not. `event E2 specializes
    // E1` is therefore an error now; write `subkind E2 specializes E1`.
    event: {
        sortality: 'ultimate-sortal', rigidity: 'rigid',
        natures: ['events']
    },
    situation: {
        sortality: 'ultimate-sortal', rigidity: 'rigid',
        // As for `event`, the two rigid non-sortals may sit above it: a
        // `category` admits situations, so a situation must be
        // able to sit beneath one, or the nature would be unreachable. And
        // `situation` is gone from its own list: ultimate sortals are
        // pairwise disjoint, so no situation type sits under another.
        natures: ['situations']
    },
    // A process is a perdurant, like an event, and the grammar groups the two.
    // Until this table it appeared in none of the lists, so nothing constrained
    // it at all.
    process: {
        sortality: 'ultimate-sortal', rigidity: 'rigid',
        natures: ['processes']
    },
    type: {
        sortality: 'ultimate-sortal', rigidity: 'rigid',
        natures: ['types']
    },
    // An abstract individual is outside time: it neither endures nor happens,
    // so nothing about it can lapse. Only a `subkind` sits beneath one -- the
    // anti-rigid sortals are confined to what can change, and share no nature
    // with it, which is what refuses them.
    abstractum: {
        sortality: 'ultimate-sortal', rigidity: 'rigid',
        natures: ['abstract-individuals']
    },
    // Deliberately unspecific: `class` states nothing, so nothing is enforced
    // for it in either direction.
    class: {
        sortality: 'none', rigidity: 'none',
        natures: null
    }
};

// --- Reading the table ------------------------------------------------------

/**
 * Every class stereotype, in the order declared above -- roughly how often
 * each is used, which is the order suggestions are offered in.
 */
/**
 * Words the language still reads and no longer offers.
 *
 * `mode` is an ultimate sortal covering both intrinsic and extrinsic modes,
 * and that is not an identity principle: what individuates a headache is not
 * what individuates a commitment, and the two differ in whether they depend
 * on anything beyond their bearer (UFO a69-a70). A type whose instances may
 * be either supplies neither. What was meant is one of the two refinements,
 * or a `category` over both -- which is a non-sortal, and says across kinds
 * exactly what a non-sortal is for.
 *
 * Still parsed, still hovered, still validated: a model that uses it reads,
 * and `deprecated-stereotype` says what to write instead.
 */
export const DEPRECATED_STEREOTYPES: ReadonlySet<string> = new Set(['mode']);

/**
 * Every class stereotype, in the order a modeler meets them. The taxonomy
 * reads this, so a deprecated word still specializes and is specialized
 * exactly as it did: a model that uses one goes on validating.
 */
export const CLASS_STEREOTYPES_BY_FAMILIARITY =
    Object.keys(STEREOTYPES) as readonly ClassStereotype[];

/**
 * The ones a proposal may offer. Everything that suggests a stereotype --
 * completion, the "create the missing class" fixes, the repair for a bare
 * `class` -- reads this instead, so nobody meets a deprecated word for the
 * first time from a list.
 */
export const SUGGESTED_CLASS_STEREOTYPES =
    CLASS_STEREOTYPES_BY_FAMILIARITY.filter(stereotype => !DEPRECATED_STEREOTYPES.has(stereotype));

function facts(stereotype: string): StereotypeFacts | undefined {
    return STEREOTYPES[stereotype as ClassStereotype];
}

/** Natures a class of this stereotype may be restricted to, if constrained. */
export function allowedNaturesFor(stereotype: string): readonly string[] | undefined {
    return facts(stereotype)?.natures ?? undefined;
}

/**
 * The stereotypes a class of this stereotype may specialize, in the order
 * suggestions are offered. `undefined` for a bare `class`, which constrains
 * nothing.
 */
export function allowedSupertypeStereotypes(stereotype: string): readonly ClassStereotype[] | undefined {
    if (stereotype === 'class' || !facts(stereotype)) {
        return undefined;
    }
    return CLASS_STEREOTYPES_BY_FAMILIARITY
        .filter(candidate => candidate !== 'class' && canSpecializeByStereotype(stereotype, candidate));
}

export function isRigid(stereotype: string): boolean {
    return facts(stereotype)?.rigidity === 'rigid';
}

export function isSemiRigid(stereotype: string): boolean {
    return facts(stereotype)?.rigidity === 'semi-rigid';
}

/** The subject of UFO's "cannot specialize an anti-rigid type" rule. */
export function isRigidOrSemiRigid(stereotype: string): boolean {
    return isRigid(stereotype) || isSemiRigid(stereotype);
}

export function isAntiRigid(stereotype: string): boolean {
    return facts(stereotype)?.rigidity === 'anti-rigid';
}

export function isSortal(stereotype: string): boolean {
    const sortality = facts(stereotype)?.sortality;
    return sortality === 'ultimate-sortal' || sortality === 'base-sortal';
}

/** Whether the stereotype supplies a principle of identity. */
export function isUltimateSortal(stereotype: string): boolean {
    return facts(stereotype)?.sortality === 'ultimate-sortal';
}

export function isBaseSortal(stereotype: string): boolean {
    return facts(stereotype)?.sortality === 'base-sortal';
}

export function isNonSortal(stereotype: string): boolean {
    return facts(stereotype)?.sortality === 'non-sortal';
}

/**
 * Whether the stereotypes alone permit `subject` to specialize `candidate`.
 * Ontological natures are checked separately -- this is only the taxonomy.
 *
 * Computed, not looked up. This used to read a list of 112 transcribed edges;
 * every one of them turned out to follow from the six principles below, so the
 * list is now a fixture in `test/taxonomy.test.ts` that asserts these
 * reproduce it. The provenance is kept where provenance belongs, and the
 * implementation is the argument rather than its result.
 */
export function canSpecializeByStereotype(subjectStereotype: string, candidateStereotype: string): boolean {
    return whyNotSpecialize(subjectStereotype, candidateStereotype) === undefined;
}

/**
 * What makes an anti-rigid type hold of an individual, which is the dimension
 * the facts above do not carry.
 *
 * A `role` holds because a relator binds the individual or it bears an
 * extrinsic mode; a `phase` because of how the individual itself is; a
 * `historicalRole` because of an event that has happened and cannot unhappen.
 * Only the intrinsic one is confined to its own sort -- see
 * `whyNotSpecialize`.
 */
const CONDITION: Readonly<Record<string, string>> = {
    role: 'relational', roleMixin: 'relational',
    phase: 'intrinsic', phaseMixin: 'intrinsic',
    historicalRole: 'historical', historicalRoleMixin: 'historical'
};

/**
 * Why the taxonomy refuses a specialization, in the words of the principle
 * that refuses it.
 *
 * The `specializes` lists above say *that* a pair is refused; every one of
 * them follows from one of these principles, which `test/grammar.test.ts`
 * checks across all 441 pairs. Saying which one turns "a type cannot
 * specialize a type" into something a reader can act on.
 */
export function whyNotSpecialize(subject: string, candidate: string): string | undefined {
    // A plain `class` states nothing, in either direction.
    if (subject === 'class' || candidate === 'class' || !facts(subject) || !facts(candidate)) {
        return undefined;
    }
    if (isNonSortal(subject) && isSortal(candidate)) {
        return `${a(subject)} is a non-sortal, and carries no identity principle of its own -- it generalizes sortals rather than specializing them`;
    }
    if (!isAntiRigid(subject) && isAntiRigid(candidate)) {
        return `${a(candidate)} is anti-rigid, so its instances may stop being one; ${a(subject)} is not, so its instances could not follow`;
    }
    if (isUltimateSortal(subject) && isSortal(candidate)) {
        return `${a(subject)} is an ultimate sortal -- it supplies its own principle of identity and so tops its lineage, and what specializes it is a base sortal: a "subkind", "role" or "phase"`;
    }
    const shared = allowedNaturesFor(subject) && allowedNaturesFor(candidate)
        && [...expandNatures(allowedNaturesFor(subject)!)]
            .some(nature => expandNatures(allowedNaturesFor(candidate)!).has(nature));
    if (shared === false) {
        return `${a(subject)} and ${a(candidate)} share no ontological nature, so nothing could instantiate both`;
    }
    // A phase holds for reasons intrinsic to the individual, so it cannot
    // narrow a condition that depends on anything else -- a relator, or an
    // event that has happened. The other two may narrow anything anti-rigid:
    // a role under a phase is a student who is a minor, and a historical role
    // under a role is coherent at a price `checkHistoricalRoleUnderAntiRigid`
    // states.
    const mine = CONDITION[subject];
    const theirs = CONDITION[candidate];
    if (mine === 'intrinsic' && theirs !== undefined && theirs !== 'intrinsic') {
        return `${a(subject)} holds for intrinsic reasons and ${a(candidate)} for ${theirs} ones, and an intrinsic condition cannot narrow one that depends on something else`;
    }
    return undefined;
}

/**
 * Stereotypes whose instances can have at least one of the given natures,
 * best fit first.
 *
 * A stereotype whose natures fall *entirely* within the required set is a
 * better answer than one that merely overlaps. Both qualify -- a `subkind`
 * may be restricted to `types`, so it is not wrong for an `@instantiation`
 * target -- but `type` is what was meant, and ordering by overlap alone
 * buried it beneath every base sortal.
 */
export function stereotypesAdmittingNatures(natures: ReadonlySet<string>): string[] {
    const exact: string[] = [];
    const overlapping: string[] = [];
    for (const stereotype of CLASS_STEREOTYPES_BY_FAMILIARITY) {
        const allowed = allowedNaturesFor(stereotype);
        if (!allowed) {
            // `class` commits to nothing, so it fits anything -- but loosely.
            overlapping.push(stereotype);
            continue;
        }
        const own = [...expandNatures(allowed)];
        if (own.every(nature => natures.has(nature))) {
            exact.push(stereotype);
        } else if (own.some(nature => natures.has(nature))) {
            overlapping.push(stereotype);
        }
    }
    return [...exact, ...overlapping];
}
