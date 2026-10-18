import type { Cardinality, Relation, RelationEndMetaAttributes, RelationEndTarget } from '../generated/ast.js';
import { isClassDeclaration, isExternalRelation } from '../generated/ast.js';
import { PART_WHOLE_STEREOTYPES } from '../validation/relation-nature-table.js';

/**
 * The source ("first end") of a relation.
 *
 * For an `ExternalRelation` this is the explicitly written `source`
 * reference. For an `InternalRelation` it is implicit: the `ClassDeclaration`
 * the relation is nested inside. This is the one place callers still need to
 * know the two relation forms differ -- everywhere else, `Relation`'s shared
 * fields (`target`, cardinalities, stereotype, notation flags) are enough.
 */
export function getRelationSource(relation: Relation): RelationEndTarget | undefined {
    if (isExternalRelation(relation)) {
        return relation.source.ref;
    }
    return isClassDeclaration(relation.$container) ? relation.$container : undefined;
}

/**
 * The written name of a relation's source end, used to build the relation's
 * own qualified name (`Source.relationName`). For an `InternalRelation`
 * that's the containing `ClassDeclaration`; for an `ExternalRelation` it's
 * the written `source`, read as raw reference text so this also works during
 * scope computation, before cross-references are linked.
 */
export function getRelationSourceName(relation: Relation): string | undefined {
    if (isExternalRelation(relation)) {
        return relation.source.$refText;
    }
    return relation.$container.name;
}

export interface NamedRelationEnd {
    /** The end's role name, i.e. `RelationEndMetaAttributes.name`. */
    name: string;
    node: RelationEndMetaAttributes;
    /**
     * The classifier this end is a property *of*, as written. Combined with
     * `name` this yields the end's qualified name (`ownerName.name`).
     */
    ownerName: string | undefined;
}

/**
 * The named ends (UML `Property`s) of a relation -- the ones a `subsets`/
 * `redefines` can target via `Owner.endName`. Most relations have zero; an
 * end only becomes referenceable once given a role name with `(endName)`.
 *
 * End *ownership* follows UML: in a binary association, the end adjacent to
 * one classifier is a property of the classifier at the **opposite** end. So
 * in `kind Staff { <>-- [2..*] (members) Employee }`, the named end sits next
 * to `Employee` but is a property of `Staff` -- it is `Staff::members`, the
 * collection of employees -- and is therefore referenced as `Staff.members`.
 * A name on the *source*-side decorator is symmetrically a property of the
 * target classifier.
 */
export function getNamedEnds(relation: Relation): NamedRelationEnd[] {
    const ends: NamedRelationEnd[] = [];
    if (relation.targetMeta?.name) {
        ends.push({
            name: relation.targetMeta.name,
            node: relation.targetMeta,
            ownerName: getRelationSourceName(relation)
        });
    }
    // A source-side end is owned by the classifier at the *other* end, so a
    // relation still being written has nothing to own it yet.
    if (relation.sourceMeta?.name && relation.target) {
        ends.push({
            name: relation.sourceMeta.name,
            node: relation.sourceMeta,
            ownerName: relation.target.$refText
        });
    }
    return ends;
}

export type RelationEndSide = 'source' | 'target';

/** Which side of its relation an end decorator sits on. */
export function getEndSide(end: RelationEndMetaAttributes): RelationEndSide | undefined {
    const relation = end.$container;
    if (relation.sourceMeta === end) {
        return 'source';
    }
    if (relation.targetMeta === end) {
        return 'target';
    }
    return undefined;
}

/**
 * The *type* of an end -- the classifier sitting at that end of the
 * association. Note this is the opposite classifier from the end's owner
 * (see `getNamedEnds`): the end `Staff.members` is owned by `Staff` but is
 * typed by `Employee`.
 */
export function getEndType(end: RelationEndMetaAttributes): RelationEndTarget | undefined {
    const relation = end.$container;
    switch (getEndSide(end)) {
        case 'target':
            return relation.target?.ref;
        case 'source':
            return getRelationSource(relation);
        default:
            return undefined;
    }
}

/**
 * The classifier an end is a property *of* -- the one at the opposite side,
 * per UML. This is the mirror of `getEndType`: for `Staff.members : Employee`
 * the owner is `Staff` and the type is `Employee`.
 */
export function getEndOwner(end: RelationEndMetaAttributes): RelationEndTarget | undefined {
    const relation = end.$container;
    switch (getEndSide(end)) {
        case 'target':
            return getRelationSource(relation);
        case 'source':
            return relation.target?.ref;
        default:
            return undefined;
    }
}

/** The multiplicity written at an end, if any. */
export function getEndCardinality(end: RelationEndMetaAttributes): Cardinality | undefined {
    const relation = end.$container;
    switch (getEndSide(end)) {
        case 'target':
            return relation.targetCardinality;
        case 'source':
            return relation.sourceCardinality;
        default:
            return undefined;
    }
}

/** Human-readable notation kind derived from the five legacy tonto-compatible boolean flags. */
export type RelationNotationKind = 'association' | 'aggregation';

export interface RelationNotation {
    kind: RelationNotationKind;
    /** Which end carries the whole-part "diamond" marker; undefined for a plain association. */
    wholeEnd?: 'source' | 'target';
}

/**
 * Whether the relation asserts parthood.
 *
 * A parthood stereotype says so, and so does the aggregation diamond on its
 * own: `<>--` and `<>--` are UML's notation for the part-whole relation, and
 * a relation carrying one is parthood whether or not it also names which kind
 * of parthood it is.
 *
 * Distinct from `PART_WHOLE_STEREOTYPES`, which answers a different question --
 * how to read an entry of the end-nature table, whose parthood rows are
 * ordered (whole, part). That is settled by the stereotype alone, since an
 * unstereotyped relation has no entry and a `@material` written with a diamond
 * still has a (source, target) one.
 */
/**
 * Whether two relations are one association written twice.
 *
 * `inverseOf` on either of them says so; nothing requires both to declare it,
 * and a model that does is saying the same thing twice rather than something
 * more.
 */
export function areInverses(one: Relation, other: Relation): boolean {
    return one !== other && (one.inverseOf?.ref === other || other.inverseOf?.ref === one);
}

export function isParthood(relation: Relation): boolean {
    return PART_WHOLE_STEREOTYPES.has(relation.stereotype ?? '')
        || getRelationNotation(relation).kind !== 'association';
}

/**
 * Which end of a parthood relation carries the whole.
 *
 * The diamond says so when there is one. With none, the whole is the
 * *source* -- the same orientation `<>--` writes explicitly, so the diamond
 * decorates rather than decides, and `--<>` is how the reading is reversed.
 *
 * This matters most for the internal form, where the enclosing class is the
 * source: `collective Forest { @membership -- [2..*] Tree }` says a forest has
 * trees as members, which is how the relation is normally written. Reading the
 * source as the *part* rejected exactly that, and accepted its opposite --
 * a `kind` as the source of a membership, which no collective can be.
 */
export function wholeEndOf(relation: Relation): 'source' | 'target' {
    return getRelationNotation(relation).wholeEnd ?? 'source';
}

export function getRelationNotation(relation: Relation): RelationNotation {
    if (relation.isAggregation) {
        return { kind: 'aggregation', wholeEnd: 'source' };
    }
    if (relation.isAggregationInverted) {
        return { kind: 'aggregation', wholeEnd: 'target' };
    }
    return { kind: 'association' };
}
