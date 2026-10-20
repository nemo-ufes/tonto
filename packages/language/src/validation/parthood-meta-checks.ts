import type { ValidationAcceptor } from 'langium';
import type { Relation } from '../generated/ast.js';
import { isClassDeclaration } from '../generated/ast.js';
import { classifiesOnly } from '../utils/nature-reasoning.js';
import { isAntiRigid, isSortal, isUltimateSortal } from './stereotype-model.js';
import { ultimateSortalOf } from '../utils/relation-graph.js';
import { getRelationSource, isParthood, wholeEndOf } from '../utils/relations.js';
import { formatBounds, getBounds } from './cardinality-checks.js';

/**
 * The parthood rules that come from the meta-properties rather than from the
 * natures at the ends: essentiality, inseparability, and their de dicto
 * counterparts.
 *
 * Guizzardi, *Ontological Foundations for Structural Conceptual Models* (2005),
 * §5.4 defines them and §8.3 says which stereotypes fix them. tonto writes
 * them with what it already has -- `(const)` on an end, plus that end's lower
 * bound -- since an end is a property of the classifier at the *opposite* end:
 *
 *   `(const)` + `[1..]` at the part end   the whole always has that same part
 *   `(const)` + `[1..]` at the whole end  the part is always in that whole
 *
 * What those amount to is read off the rigidity of the type at the other end,
 * which is what `checkEssentialPartOfAntiRigidWhole` below is about.
 */

/**
 * Whether both ends name a *kind* of quantity rather than quantities at large.
 *
 * The two rules below are per kind, and the thesis's arguments say so: there is
 * exactly one portion of alcohol in a portion of wine, and a portion of wine is
 * the only *portion of wine* a sub-quantity of it belongs to. A relation whose
 * ends are non-sortals -- gUFO's own `hasSubQuantity`, from Quantity to
 * Quantity -- quantifies over every kind at once, and then a portion has many
 * sub-quantities and may well be shared between kinds.
 */
function betweenKinds(whole: unknown, part: unknown): boolean {
    return isClassDeclaration(whole) && isClassDeclaration(part)
        && isSortal(whole.stereotype) && isSortal(part.stereotype);
}

/** The ends of a parthood, as (whole, part), or `undefined` if it is not one. */
function partsOf(relation: Relation): { whole: unknown; part: unknown; wholeIsSource: boolean } | undefined {
    if (!isParthood(relation)) {
        return undefined;
    }
    const source = getRelationSource(relation);
    const target = relation.target?.ref;
    const wholeIsSource = wholeEndOf(relation) === 'source';
    const whole = wholeIsSource ? source : target;
    const part = wholeIsSource ? target : source;
    return whole && part ? { whole, part, wholeIsSource } : undefined;
}

/**
 * Every part of a quantity is essential, so the end holding it is `(const)`.
 *
 * The end is a property of the classifier at the opposite end, so the part end
 * is the whole's: marking it `(const)` says the whole cannot come to have a
 * different part, which -- with the mandatory multiplicity the rule below
 * demands -- is essential parthood.
 */
export function checkQuantityPartsAreEssential(relation: Relation, accept: ValidationAcceptor): void {
    const ends = partsOf(relation);
    // The stereotype says the ends are quantities even where the classes are
    // too general to say so themselves, which is how a taxonomy of quantities
    // is usually written.
    const quantities = !!ends && (relation.stereotype === 'subQuantity'
        || (isClassDeclaration(ends.whole) && classifiesOnly(ends.whole, 'quantities')));
    if (!ends || !quantities || !isClassDeclaration(ends.whole)) {
        return;
    }
    const end = ends.wholeIsSource ? relation.targetMeta : relation.sourceMeta;
    if (end?.isConst) {
        return;
    }
    accept(
        'error',
        `A quantity is extensional: every part of "${ends.whole.name}" is essential to it, so this end is "(const)".`,
        {
            node: relation,
            code: 'quantity-part-not-essential',
            data: { side: ends.wholeIsSource ? 'target' : 'source' }
        }
    );
}

/**
 * "Since every part of a quantity is itself a quantity, Q-parthood must have a
 * cardinality constraint of one and exactly one in the subquantity side"
 * (§8.3): a quantity is maximal, so there is exactly one portion of alcohol in
 * a given portion of wine, not two and not optionally none.
 */
export function checkSubQuantityMultiplicity(relation: Relation, accept: ValidationAcceptor): void {
    const ends = relation.stereotype === 'subQuantity' ? partsOf(relation) : undefined;
    if (!ends || !betweenKinds(ends.whole, ends.part)) {
        return;
    }
    const cardinality = ends.wholeIsSource ? relation.targetCardinality : relation.sourceCardinality;
    if (!cardinality) {
        // An omitted multiplicity means exactly one, which is what is wanted.
        return;
    }
    const bounds = getBounds(cardinality);
    if (bounds && bounds.lower === 1 && bounds.upper === 1) {
        return;
    }
    accept(
        'error',
        `A quantity is maximal, so it has exactly one sub-quantity of a kind: this end is "[1]", not ${formatBounds(cardinality)}.`,
        { node: cardinality, code: 'sub-quantity-multiplicity' }
    );
}

/**
 * "The subQuantityOf relation is always non-sharable" (§8.3), proved from
 * maximality: if a portion of alcohol were part of two portions of wine, those
 * two would overlap and so would be part of a larger self-connected portion,
 * which contradicts both being maximal.
 *
 * Non-shareable is what the whole end's upper bound says. It used to be what
 * the filled diamond said, and this rule read the glyph -- so a model that
 * wrote `[1]` at the whole end, saying exactly this, was told to say it
 * differently. The diamond is gone and the bound is the claim.
 */
export function checkSubQuantityIsExclusive(relation: Relation, accept: ValidationAcceptor): void {
    const ends = relation.stereotype === 'subQuantity' ? partsOf(relation) : undefined;
    if (!ends || !betweenKinds(ends.whole, ends.part)) {
        return;
    }
    const cardinality = ends.wholeIsSource ? relation.sourceCardinality : relation.targetCardinality;
    // An omitted bound is exactly one, which is the strongest form of this.
    const bounds = cardinality ? getBounds(cardinality) : { lower: 1, upper: 1 };
    if (!bounds || bounds.upper <= 1) {
        return;
    }
    accept(
        'error',
        `A sub-quantity belongs to one quantity and no other, so the end holding the whole cannot be ${formatBounds(cardinality!)}.`,
        { node: cardinality ?? relation, code: 'sub-quantity-shared' }
    );
}

/**
 * "Any collective can have at maximum one subcollection of a given type",
 * and "the cardinality constraints in the association end relative to the part
 * is one and exactly one" (§8.3). Tonto therefore requires `[1]` here, not
 * merely an upper bound of one.
 *
 * A collective is maximal in the same way a quantity is: a sub-collection is
 * obtained by refining the unifying relation, and the refinement picks out one
 * sub-collection, not several. Per kind for the same reason the sub-quantity
 * rules are -- gUFO's `hasSubCollection` runs from Collection to Collection and
 * is many-to-many across kinds.
 */
export function checkSubCollectionMultiplicity(relation: Relation, accept: ValidationAcceptor): void {
    const ends = relation.stereotype === 'subCollection' ? partsOf(relation) : undefined;
    if (!ends || !betweenKinds(ends.whole, ends.part)) {
        return;
    }
    const cardinality = ends.wholeIsSource ? relation.targetCardinality : relation.sourceCardinality;
    if (!cardinality) {
        return;
    }
    const bounds = getBounds(cardinality);
    if (bounds && bounds.lower === 1 && bounds.upper === 1) {
        return;
    }
    accept(
        'error',
        `A collective has exactly one sub-collection of a kind, since a sub-collection refines its unifying relation: this end is "[1]", not ${formatBounds(cardinality)}.`,
        { node: cardinality, code: 'sub-collection-multiplicity' }
    );
}

/**
 * `(const)` at the part end of an anti-rigid whole says less than it looks.
 *
 * "Only rigid universals can participate as wholes in essential parthood
 * relations. In the case of anti-rigid universals, the modal necessity of the
 * parts can only be a case of de dicto necessity. These parts are named
 * immutable parts instead" (§8.3). So `role Employee { <>-- [1] (const)
 * Badge }` fixes the badge for as long as the person is an employee, and says
 * nothing about the person -- who may have been one before, and may be one
 * again with another badge.
 *
 * Reported at hint severity: nothing is wrong, and the modeler may
 * mean exactly this. What they may not have meant is *essential*, and the
 * place to say that is the kind.
 */
export function checkEssentialPartOfAntiRigidWhole(relation: Relation, accept: ValidationAcceptor): void {
    const ends = partsOf(relation);
    if (!ends || !isClassDeclaration(ends.whole) || !isAntiRigid(ends.whole.stereotype)) {
        return;
    }
    const end = ends.wholeIsSource ? relation.targetMeta : relation.sourceMeta;
    if (!end?.isConst) {
        return;
    }
    // The rigid whole is the one above it, not the role itself -- which is
    // what the sentence named, so it read "the ultimate sortal "Employee"
    // specializes" of `Employee`.
    const rigid = ultimateSortalOf(ends.whole, isUltimateSortal);
    const where = rigid && rigid !== ends.whole
        ? `the ultimate sortal "${rigid.name}" it specializes`
        : 'the ultimate sortal it specializes';
    accept(
        'hint',
        `"${ends.whole.name}" is anti-rigid, so this fixes the part only while an instance is one: an immutable part, not an essential one. Essential parthood needs a rigid whole, which is ${where}.`,
        { node: relation, code: 'essential-part-of-anti-rigid-whole' }
    );
}
