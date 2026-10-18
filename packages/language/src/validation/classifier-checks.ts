import type { ValidationAcceptor } from 'langium';
import type { ClassDeclaration } from '../generated/ast.js';
import { findDisjointConflict } from '../utils/disjointness.js';
import { collectAncestors } from '../utils/generalizations.js';
import { a, capitalize } from './wording.js';
import { classifiesTypes, constraintsOn, isWidening, possibleNatures, violationOf } from '../utils/nature-reasoning.js';
import {
    allowedNaturesFor, canSpecializeByStereotype, DEPRECATED_STEREOTYPES, instancesCanChange,
    isBaseSortal, isNonSortal, isUltimateSortal, naturesNotPermittedBy, expandNatures, whyNotSpecialize
} from './stereotype-model.js';

// Ancestry lives in ../utils/generalizations.ts, since it must follow
// generalization-set edges as well as `specializes` clauses and is needed by
// the relation checks too.
const collectSpecializationAncestors = collectAncestors;

export function checkStereotypeGiven(classDeclaration: ClassDeclaration, accept: ValidationAcceptor): void {
    if (classDeclaration.stereotype === 'class' && classDeclaration.natures.length === 0) {
        accept('warning', `"${classDeclaration.name}" is a bare "class", which says nothing about identity or rigidity. `+ 'Use a stereotype that does, or say what it classifies with "of ...".', {
            node: classDeclaration,
            property: 'stereotype',
            code: 'unspecific-stereotype'
        });
    }
}

/**
 * `mode` says a type's instances may be intrinsic or extrinsic modes, and
 * supplies an identity principle for neither.
 *
 * The two differ in what they depend on -- an intrinsic mode on its bearer
 * alone, an extrinsic one on a further individual (UFO a69-a70) -- and an
 * ultimate sortal is what says how instances are individuated. A word
 * covering both says it of neither. What is meant is `intrinsicMode`,
 * `extrinsicMode`, or a `category of intrinsic-modes` / `of extrinsic-modes`
 * where the point is to speak across the two, which is what a non-sortal is
 * for.
 *
 * A warning: the model reads, and every repair is a choice about what it
 * meant.
 */
export function checkStereotypeIsCurrent(classDeclaration: ClassDeclaration, accept: ValidationAcceptor): void {
    if (!DEPRECATED_STEREOTYPES.has(classDeclaration.stereotype)) {
        return;
    }
    accept(
        'warning',
        `"${classDeclaration.stereotype}" is deprecated: it classifies intrinsic and extrinsic modes together, and an ultimate sortal has to say how its instances are individuated. Write "intrinsicMode" or "extrinsicMode", or a "category of intrinsic-modes" or "of extrinsic-modes" to speak across the two.`,
        { node: classDeclaration, property: 'stereotype', code: 'deprecated-stereotype' }
    );
}

export function checkCompatibleNatures(classDeclaration: ClassDeclaration, accept: ValidationAcceptor): void {
    const allowed = allowedNaturesFor(classDeclaration.stereotype);
    if (!allowed) {
        return;
    }
    const incompatible = naturesNotPermittedBy(classDeclaration.natures, allowed);
    if (incompatible.length > 0) {
        accept('error', `${capitalize(a(classDeclaration.stereotype))} cannot classify ${incompatible.join(', ')} -- drop that from the "of" clause, or use a stereotype whose instances may be one.`, {
            node: classDeclaration,
            property: 'natures',
            code: 'stereotype-nature-mismatch'
        });
    }
}

/**
 * Checks that a class's instances can exist at all, given everything that
 * constrains their ontological nature: each supertype, the class's own `of`
 * clause, and the identity principle implied by its stereotype.
 *
 * All three are compared as *effective* natures (declared, else inherited,
 * else implied by the stereotype -- see `getEffectiveNatures`) and expanded to
 * atomic natures so `objects` subsumes its members. Comparing only the
 * natures each side *declares* -- as this check originally did -- misses
 * almost everything in practice, because a `kind` seldom writes
 * `of functional-complexes` and a `role` seldom writes anything at all.
 */
export function checkNatureConsistency(classDeclaration: ClassDeclaration, accept: ValidationAcceptor): void {
    const constraints = constraintsOn(classDeclaration);
    if (!violationOf(constraints)) {
        return;
    }

    const report = (message: string, code: string): void => accept('error', message, {
        node: classDeclaration,
        ...(classDeclaration.specializes.length > 0 ? { property: 'specializes' as const } : {}),
        code
    });
    const supertypes = constraints.filter(constraint => constraint.kind === 'supertype');
    const from = supertypes.map(entry => `"${entry.parent?.name}"`).join(', ');

    // 1. Supertypes must agree with each other: an instance is an instance of
    //    all of them at once, so a pair sharing nothing can never exist.
    for (let i = 0; i < supertypes.length; i++) {
        for (let j = i + 1; j < supertypes.length; j++) {
            const left = supertypes[i];
            const right = supertypes[j];
            if (![...left.natures].some(nature => right.natures.has(nature))) {
                report(
                    `"${classDeclaration.name}" cannot specialize both "${left.parent?.name}" (${[...left.natures].join(', ')}) and "${right.parent?.name}" (${[...right.natures].join(', ')}): their ontological natures have nothing in common, so no individual could be an instance of both.`,
                    'incompatible-supertype-natures'
                );
                return;
            }
        }
    }

    const inherited = possibleNatures(supertypes);
    const stereotype = constraints.find(constraint => constraint.kind === 'stereotype');
    const declared = constraints.find(constraint => constraint.kind === 'declared');

    // 1.5. Three or more supertypes can each share a nature with every other
    // one, pairwise, while having nothing in common once all of them are
    // considered together -- the pairwise loop above cannot see that, since
    // no single pair conflicts. Reported against the supertypes, not the
    // stereotype: even the most permissive stereotype there is has nothing
    // to work with once its supertypes leave it nothing to inherit.
    if (supertypes.length > 2 && inherited && inherited.size === 0) {
        const detailed = supertypes.map(entry => `"${entry.parent?.name}" (${[...entry.natures].join(', ')})`).join(', ');
        report(
            `"${classDeclaration.name}" cannot specialize ${detailed} together: no ontological nature is common to all of them, even though every pair shares one, so no individual could be an instance of every one.`,
            'incompatible-supertype-natures'
        );
        return;
    }

    // 2. The stereotype's own identity principle must survive what is inherited.
    if (stereotype && inherited && ![...inherited].some(nature => stereotype.natures.has(nature))) {
        report(
            `"${classDeclaration.name}" inherits ${[...inherited].join(', ')} from ${from}, and ${a(classDeclaration.stereotype)} classifies ${[...stereotype.natures].join(', ')} -- so nothing could be an instance of it.`,
            'stereotype-nature-unreachable'
        );
        return;
    }

    // 3. An explicit `of` clause may narrow what is inherited, never diverge.
    // Checked in its own right, not as an alternative to the branches above:
    // a class can be both unsatisfiable and widening, and the `of` clause is
    // the more actionable of the two things to say.
    if (declared && inherited && isWidening(constraints)) {
        report(
            `"${classDeclaration.name}" restricts its instances to ${naturesNotPermittedBy(classDeclaration.natures, [...inherited]).join(', ')}, which is not compatible with ${[...inherited].join(', ')} inherited from ${from}.`,
            'declared-nature-incompatible-with-inherited'
        );
    }
}

/** The same supertype listed twice adds nothing and is almost always a slip. */
export function checkNoDuplicateGeneralization(classDeclaration: ClassDeclaration, accept: ValidationAcceptor): void {
    const seen = new Set<ClassDeclaration>();
    classDeclaration.specializes.forEach((ref, index) => {
        const target = ref.ref;
        if (!target) {
            return;
        }
        if (seen.has(target)) {
            accept('warning', `"${target.name}" is already listed as a supertype of "${classDeclaration.name}".`, {
                node: classDeclaration,
                property: 'specializes',
                index,
                code: 'duplicate-supertype'
            });
        } else {
            seen.add(target);
        }
    });
}

/**
 * A class cannot end up below two classes that a `disjoint` generalization
 * set says share no instances -- every instance of it would have to be an
 * instance of both.
 *
 * Checked over the whole ancestry, not just the direct supertypes, since the
 * contradiction is the same however far up the two disjoint classes sit. The
 * class itself is included: a class listed in a disjoint set may not also
 * specialize one of its co-specifics.
 */
export function checkNoDisjointSupertypes(classDeclaration: ClassDeclaration, accept: ValidationAcceptor): void {
    const conflict = findDisjointConflict(classDeclaration);
    if (!conflict) {
        return;
    }
    const { first, second } = conflict;
    const involvesSelf = first === classDeclaration || second === classDeclaration;
    const other = first === classDeclaration ? second : first;
    const message = involvesSelf
        ? `"${classDeclaration.name}" is declared disjoint from "${other.name}", which it also specializes.`
        : `"${classDeclaration.name}" specializes both "${first.name}" and "${second.name}", which a disjoint generalization set declares cannot share an instance.`;
    accept('error', message, {
        node: classDeclaration,
        ...(classDeclaration.specializes.length > 0 ? { property: 'specializes' as const } : {}),
        code: 'disjoint-supertypes'
    });
}

/**
 * The stereotype table, over what the class itself writes.
 *
 * An edge a generalization set declares is not checked here. It has no
 * `specializes` entry to point at, and `checkGeneralizationSetSortalityAndRigidity`
 * asks the same table of the same pair against the set, where the edge is
 * written and where the repairs are. Checking it in both places reported one
 * mistake twice, once with the useful fixes and once with a code no rule
 * cataloged.
 */
export function checkSupertypeStereotype(classDeclaration: ClassDeclaration, accept: ValidationAcceptor): void {
    const reportedFor = new Set<ClassDeclaration>();
    const report = (parent: ClassDeclaration, index: number): void => {
        if (reportedFor.has(parent)) {
            return;
        }
        reportedFor.add(parent);
        const why = whyNotSpecialize(classDeclaration.stereotype, parent.stereotype);
        accept(
            'error',
            `"${classDeclaration.name}" cannot specialize "${parent.name}"`
                + (why ? `: ${why}.` : `: ${a(classDeclaration.stereotype)} cannot specialize ${a(parent.stereotype)}.`),
            { node: classDeclaration, property: 'specializes', index, code: 'stereotype-cannot-specialize' }
        );
    };

    classDeclaration.specializes.forEach((ref, index) => {
        const parent = ref.ref;
        if (parent && !canSpecializeByStereotype(classDeclaration.stereotype, parent.stereotype)) {
            report(parent, index);
        }
    });
}

/**
 * Two claims live here, and they are not about the same thing.
 *
 * *At most one* is about the ultimate sortals: they are pairwise disjoint, so
 * a lineage holding two has nothing that could instantiate it. That holds
 * whatever the class below them is stereotyped -- a bare `class` says nothing
 * about identity and inherits the contradiction all the same. Only a
 * non-sortal is left out, and only because it may not specialize a sortal at
 * all, which `checkSupertypeStereotype` already reports.
 *
 * *At least one* is about sortals needing an identity principle, so it asks
 * only of base sortals. High-order base sortals are no exception: `type` is
 * their ultimate sortal, exactly as `kind` is for ordinary subkinds.
 */
export function checkSortalSpecializesUniqueUltimateSortal(classDeclaration: ClassDeclaration, accept: ValidationAcceptor): void {
    const ultimateSortalAncestors = [...collectSpecializationAncestors(classDeclaration)]
        .filter(ancestor => isUltimateSortal(ancestor.stereotype));
    if (ultimateSortalAncestors.length > 1 && !isNonSortal(classDeclaration.stereotype)) {
        accept(
            'error',
            `"${classDeclaration.name}" specializes more than one ultimate sortal: ${ultimateSortalAncestors.map(a => a.name).join(', ')}. Ultimate sortals are pairwise disjoint, so no individual can be an instance of two.`,
            { node: classDeclaration, property: 'specializes', code: 'multiple-ultimate-sortals' }
        );
        return;
    }
    if (!isBaseSortal(classDeclaration.stereotype)) {
        return;
    }
    if (ultimateSortalAncestors.length === 0) {
        accept('error', `"${classDeclaration.name}" is a sortal, so it draws identity from exactly one ultimate sortal -- and none is above it, here or through what it specializes.`, {
            node: classDeclaration,
            property: 'specializes',
            // Carries a quick fix offering every compatible ultimate sortal in
            // scope -- see TontoCodeActionProvider.
            code: 'sortal-without-ultimate-sortal'
        });
    }
}


/**
 * A `mixin` needs at least one nature that can change.
 *
 * Semi-rigidity is the whole point of the stereotype: a mixin is rigid for
 * some of its instances and anti-rigid for others, which is what distinguishes
 * it from a `category`. The anti-rigid half needs an individual that can stop
 * being an instance and go on existing: an endurant, or a process, whose
 * constitution varies in time. An event does not stop being that event; a
 * situation cannot change and stay the same situation, since its constituents
 * and their properties are what it is, so what looks like one changing is a
 * later situation obtaining in place of an earlier; and an abstract individual
 * has no life over which anything could change -- so a mixin restricted to
 * those alone is a `category` written with the wrong word.
 */
export function checkMixinSpansAnEndurant(classDeclaration: ClassDeclaration, accept: ValidationAcceptor): void {
    if (classDeclaration.stereotype !== 'mixin' || classDeclaration.natures.length === 0) {
        return;
    }
    const natures = expandNatures(classDeclaration.natures);
    if ([...natures].some(instancesCanChange)) {
        return;
    }
    accept(
        'error',
        `A "mixin" is semi-rigid -- rigid for some instances and anti-rigid for others -- which nothing restricted to ${[...natures].join(', ')} can be: none of them can cease to be an instance and go on existing. Use a "category".`,
        { node: classDeclaration, property: 'natures', code: 'mixin-without-changeable-instances' }
    );
}

/**
 * `isPowerType` says what a class's instances are, so it needs instances that
 * could be that.
 *
 * A Cardelli power type holds every specialization of its base, and
 * specializations are types -- so the modifier only means anything on a class
 * restricted to types. It is a modifier rather than a stereotype precisely
 * because what the class *is* stays open: `type`, `category of types` and
 * `class of types` may each carry it.
 */
export function checkPowerTypeClassifiesTypes(
    classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    if (!classDeclaration.isPowerType || classifiesTypes(classDeclaration)) {
        return;
    }
    accept(
        'error',
        `"isPowerType" says every specialization of a base type is an instance, so "${classDeclaration.name}" must classify types. Add "of types", or use a stereotype that classifies them.`,
        { node: classDeclaration, property: 'isPowerType', code: 'powertype-does-not-classify-types' }
    );
}
