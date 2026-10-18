import type { ClassDeclaration } from '../generated/ast.js';
import { isClassDeclaration, isGeneralizationSet } from '../generated/ast.js';
import type { ReverseLookup } from '../validation/incoming-relations.js';
import { collectAncestors, getDirectGeneralizations } from '../utils/generalizations.js';
import { admitsStereotype, possibleNatures, possibleNaturesOf } from '../utils/nature-reasoning.js';
import {
    allowedNaturesFor, canSpecializeByStereotype, isBaseSortal, isUltimateSortal,
    SUGGESTED_CLASS_STEREOTYPES, expandNatures
} from '../validation/stereotype-model.js';

/**
 * Whether a candidate stereotype would leave the class needing an identity
 * principle it has not got.
 *
 * A base sortal draws identity from exactly one ultimate sortal above it, so
 * proposing `subkind` for a class with none answers one diagnostic with
 * another: `sortal-without-ultimate-sortal`, which
 * `checkSortalSpecializesUniqueUltimateSortal` then reports. A repair that
 * leaves an error is not offered, and neither is a completion proposal that
 * would produce one.
 *
 * Only the natures were asked before, which is a different question -- a
 * `subkind of relators` has instances it could classify and still no answer
 * to what individuates them.
 */
export function identityWouldHold(node: ClassDeclaration, candidate: string): boolean {
    if (!isBaseSortal(candidate)) {
        return true;
    }
    return [...collectAncestors(node)].some(ancestor => isUltimateSortal(ancestor.stereotype));
}

/**
 * The same question of dropping a supertype rather than of changing the
 * stereotype: would an ultimate sortal still be above this class afterward.
 *
 * A base sortal draws identity from exactly one, and the supertype offered
 * for removal is sometimes the only one supplying it. Removing it then trades
 * `incompatible-supertype-natures` for `sortal-without-ultimate-sortal`,
 * which is moving the problem rather than repairing it -- and where the other
 * supertype is the one to drop, the choice was being put to the reader with
 * one of the two options quietly wrong.
 */
export function identityWouldSurvive(node: ClassDeclaration, dropped: ClassDeclaration): boolean {
    if (!isBaseSortal(node.stereotype)) {
        return true;
    }
    return getDirectGeneralizations(node)
        .filter(parent => parent !== dropped)
        .some(parent => isUltimateSortal(parent.stereotype)
            || [...collectAncestors(parent)].some(above => isUltimateSortal(above.stereotype)));
}

/**
 * Stereotypes a bare `class` could plausibly be given, narrowed by everything
 * the surrounding model already says about it.
 *
 * A `class` states nothing, but its neighbors usually do: what it
 * specializes bounds it from above, what specializes *it* bounds it from
 * below, and any nature -- declared or inherited -- rules out the stereotypes
 * that cannot have instances of that nature. `class X specializes SomeKind`
 * can only sensibly be a base sortal; `class X of relators` can only be
 * relator-natured.
 *
 * Returns the empty list when nothing constrains the choice, so the caller can
 * decline to guess rather than offer all twenty.
 */
export function suggestedStereotypes(node: ClassDeclaration, lookup: ReverseLookup): string[] {
    const parents = getDirectGeneralizations(node);
    const children = subtypesOf(node, lookup);
    const inherited = inheritedNatures(parents);
    const hasContext = parents.length > 0 || children.length > 0 || node.natures.length > 0;
    if (!hasContext) {
        return [];
    }

    const viable = SUGGESTED_CLASS_STEREOTYPES.filter(candidate => {
        if (candidate === 'class') {
            return false;
        }
        // Bounded from above by what it specializes...
        if (!parents.every(parent => canSpecializeByStereotype(candidate, parent.stereotype))) {
            return false;
        }
        // ...and from below by what specializes it.
        if (!children.every(child => canSpecializeByStereotype(child.stereotype, candidate))) {
            return false;
        }
        // The nature side is one question: would this stereotype leave the
        // class with instances, given its `of` clause and everything above it.
        return admitsStereotype(node, candidate) && identityWouldHold(node, candidate);
    });

    return rankByNatureFit(viable, inherited);
}

/**
 * Puts stereotypes whose natures fall *entirely* within the inherited ones
 * first.
 *
 * Both kinds are viable, but the tighter fit is what was meant: under a
 * category restricted to relators, `relator` is the obvious answer while
 * `subkind` and `role` merely happen to permit relators among many natures.
 * Ordering by familiarity alone buried `relator` below five looser matches.
 */
export function rankByNatureFit(candidates: string[], inherited: Set<string> | undefined): string[] {
    if (!inherited || inherited.size === 0) {
        return candidates;
    }
    const exact: string[] = [];
    const looser: string[] = [];
    for (const candidate of candidates) {
        const allowed = allowedNaturesFor(candidate);
        const own = allowed ? [...expandNatures(allowed)] : [];
        (own.length > 0 && own.every(nature => inherited.has(nature)) ? exact : looser).push(candidate);
    }
    return [...exact, ...looser];
}

/** Specializations constrain a repair wherever the child or its set is written. */
function subtypesOf(node: ClassDeclaration, lookup: ReverseLookup): ClassDeclaration[] {
    const candidates = lookup.referrers(node).flatMap(referrer => isGeneralizationSet(referrer)
        ? referrer.specifics.map(specific => specific.ref) : [referrer]);
    return [...new Set(candidates.filter((candidate): candidate is ClassDeclaration =>
        isClassDeclaration(candidate) && getDirectGeneralizations(candidate).includes(node)))];
}

/** What the supertypes jointly allow -- the yardstick for ranking. */
function inheritedNatures(parents: readonly ClassDeclaration[]): Set<string> | undefined {
    return possibleNatures(parents
        .map(parent => possibleNaturesOf(parent))
        .filter((natures): natures is Set<string> => !!natures)
        .map(natures => ({ kind: 'supertype' as const, natures })));
}
