import "./terminals";
import "./common";
import "./classifiers";
import "./datatypes";

/**
 * Common shape of every relation end-to-end declaration, whether written
 * inside a class body (`InternalRelation`) or at package level with an
 * explicit `relation` keyword (`ExternalRelation`).
 *
 * Legacy tonto parsed both forms with `infers ElementRelation`, so the
 * generated AST used the *same* type for both, leaving `firstEnd` optional
 * and undefined on internal relations -- callers had to know to fall back to
 * `$container` to find the implicit source, with no field or `$type` telling
 * them which situation they were in. Splitting `Relation` into two real
 * subtypes fixes that: `InternalRelation` and `ExternalRelation` are
 * distinguishable by `$type`, and only `ExternalRelation` declares `source`
 * at all -- see `getRelationSource()` in ../utils/relations.ts for the single
 * place that still needs to know about the difference.
 */
interface Relation {
    name?: string
    stereotype?: string
    target?: @RelationEndTarget
    sourceCardinality?: Cardinality
    targetCardinality?: Cardinality
    sourceMeta?: RelationEndMetaAttributes
    targetMeta?: RelationEndMetaAttributes
    isAssociation: boolean
    isAggregation: boolean
    isAggregationInverted: boolean
    specializes?: @Relation
    inverseOf?: @Relation
    derivedFrom: @ClassDeclaration[]
}

/** A relation declared inside a class body; its source is the enclosing `ClassDeclaration`. */
interface InternalRelation extends Relation {
}

/** A relation declared at package level with an explicit `relation` keyword and source. */
interface ExternalRelation extends Relation {
    source: @RelationEndTarget
}

/**
 * What either end of a relation may reference: something that classifies
 * individuals, or a datatype, which is how an end reaches a value.
 *
 * Not a relation. `Relation` was in this union, and nothing needed it there --
 * `specializes` and `inverseOf` name a relation directly, with their own
 * types -- so all it did was let an end point at one:
 * `relation A [1] -- odd -- [1] knows` parsed, linked and validated in
 * silence, describing nothing. An end relates individuals, and a relation is
 * not one of those.
 */
type RelationEndTarget = ClassDeclaration | Datatype | Enumeration;


fragment RelationStereotypeMarker:
    ('@' stereotype=RelationStereotype)?
;

InternalRelation returns InternalRelation:
    RelationStereotypeMarker
    RelationEnds
;

ExternalRelation returns ExternalRelation:
    RelationStereotypeMarker
    'relation' source=[RelationEndTarget:QualifiedName]
    RelationEnds
;

fragment RelationEnds:
    sourceMeta=RelationEndMetaAttributes?
    sourceCardinality=Cardinality?
    RelationNotation
    targetCardinality=Cardinality?
    targetMeta=RelationEndMetaAttributes?
    // Optional so that a half-written relation still parses. A missing target
    // is reported by `checkRelationHasTarget`, which can say what is missing
    // and where; the parser's own recovery discarded the whole declaration and
    // answered with "Expecting token of type 'EOF'". Nothing else can be
    // mistaken for the target: a class stereotype is not admissible as a name
    // (see `SoftKeyword`), so the next declaration is never swallowed.
    target=[RelationEndTarget:QualifiedName]?
    ('specializes' specializes=[Relation:QualifiedName])?
    ('inverseOf' inverseOf=[Relation:QualifiedName])?
    // What makes a derived relation hold: the relator a `@material` relation
    // is read off, or the qualities a `@comparative` one compares. A clause
    // rather than a relation of its own, which is what `@derivation` was: the
    // derivation is a fact about this relation, and a line elsewhere could be
    // deleted, or left behind when this one was.
    ('derivedFrom' derivedFrom+=[ClassDeclaration:QualifiedName]
        (',' derivedFrom+=[ClassDeclaration:QualifiedName])*)?
;

/**
 * The `--` / `<>--` / `--<>` notation, with an optional name between the two
 * dashes:
 *
 * - `--`      isAssociation
 * - `<>--`    isAggregation         (whole-part marker on the source end)
 * - `--<>`    isAggregationInverted (whole-part marker on the target end)
 *
 * Legacy tonto and UML also have a filled diamond -- `<o>--`, composite
 * aggregation -- and this language dropped it. The diamond says which end is
 * the whole, which no multiplicity can say; the *fill* said the whole end
 * holds at most one, which is what writing `[0..1]` or `[1]` there says. The
 * two could disagree, so a rule existed to stop them, and a sub-quantity that
 * said "one and no other" with its multiplicity was rejected for not saying it
 * with the glyph. Every model that validated with a filled diamond means
 * exactly what it means with the `o` deleted.
 *
 * One of the three alternatives always matches something. The last used to be
 * optional as a whole, which made a relation with no notation at all
 * grammatical; the mandatory target hid that, and making the target optional
 * turned it into an `InternalRelation` that could match the empty string --
 * which a class body repeats, so the parser's lookahead never terminated.
 *
 * The middle alternative also accepts a closing `--<>` where an ordinary
 * named aggregation would close with a plain `--`, so `<>-- name --<>` (or
 * bare, `<>-- --<>`) parses as one relation with *both* whole-part flags set,
 * rather than the parser matching `<>--` alone -- a legal relation with no
 * target, since everything after the marker is optional -- and starting a
 * second, unrelated one from whatever followed. Marking both ends the whole
 * of a parthood is nonsense, but it is nonsense a check can name; splitting
 * the input into two relations neither of which was written left a linking
 * error blaming a class named after whatever role name came between the two
 * markers. `checkDiamondMarksOneEndOnly` reports the real problem instead.
 */
fragment RelationNotation:
    (isAssociation?='--' (name=DelimitedName '--')?) |
    (isAggregation?='<>--'
        ( (name=DelimitedName (isAggregationInverted?='--<>' | '--'))
        | isAggregationInverted?='--<>'
        )?
    ) |
    (('--' name=DelimitedName)? isAggregationInverted?='--<>')
;

/**
 * The parenthesized end decorator: `(const father)`, `(addOnly children)`,
 * `(staff subsets Team.members)`, or just `(members)`.
 *
 * A named end (`endName`, i.e. this node's `name`) is a UML `Property`: the
 * thing a *different* end's `subsets`/`redefines` can point back at via
 * `Owner.endName`, or by the plain name where the class inherits it. An end
 * without a name
 * simply can't be subset or redefined -- there is nothing to reference,
 * which is the correct UML rule (subsetting/redefinition are always
 * relative to a named association end, never to the association as a
 * whole) and is now enforced structurally by the grammar rather than by a
 * runtime check: `subsets`/`redefines` can only resolve to a
 * `RelationEndMetaAttributes` node, so there is no way to write a reference
 * that means "the whole relation".
 */
interface RelationEndMetaAttributes {
    isConst: boolean
    /**
     * `addOnly`: links may be added and never removed, so the set of what sits
     * at this end only grows. `const` is the stronger of the two -- nothing
     * changes at all -- and the pair is UML 1.x's `frozen` and `addOnly`.
     */
    isAddOnly: boolean
    name?: string
    subsets?: @RelationEndMetaAttributes
    redefines?: @RelationEndMetaAttributes
}

/**
 * `(const father)`, `(addOnly children)`, `(staff subsets Team.members)`.
 *
 * Position rather than punctuation: the flags, then the name, then what the
 * end draws from. They used to sit in braces of their own --
 * `({const, subsets Team.members} staff)` -- which put a decorator two
 * brackets deep to say two things, and made every flag a list element in the
 * AST rather than a property of the end.
 *
 * Two flags, written in that order and each at most once, which is the
 * parser's business now -- `duplicate-end-modifier` was a rule that existed
 * because a comma-separated list could repeat itself.
 *
 * `ordered` and `derived` are attribute flags and not end flags. An end that
 * holds a sequence rather than a set is a claim no rule here read, and a
 * derived end said "computed" without saying from what -- which is what a
 * `@material` relation's relator would say, if the language had a way to name
 * it.
 *
 * The cost is that `const`, `addOnly`, `ordered`, `derived`, `subsets` and
 * `redefines` are no longer writable as end *names*, which the braces used to
 * allow. A deliberate exception to the rule that every word-shaped keyword is
 * nameable somewhere (see `HardKeyword`): none of the six is a plausible role
 * name, and the word that rule was really built for -- `of`, as in a
 * characterization's `(of)` end -- is untouched.
 */
RelationEndMetaAttributes returns RelationEndMetaAttributes:
    '('
    ((isConst?='const') | (isAddOnly?='addOnly'))?
    (name=EndName)?
    ('subsets' subsets=[RelationEndMetaAttributes:DelimitedQualifiedName])?
    ('redefines' redefines=[RelationEndMetaAttributes:DelimitedQualifiedName])?
    ')'
;

/**
 * `subsets`/`redefines` reference another relation *end*, matching UML:
 * subsetting and redefinition apply to an association end (a `Property`),
 * never to the association as a whole. Since the only possible target type
 * is `RelationEndMetaAttributes`, a reference that names a whole relation
 * cannot resolve -- the rule is structural, not a runtime check.
 *
 * An end is referenced as `Owner.endName`, where `Owner` is the classifier
 * the end is a property *of* -- which, per UML, is the classifier at the
 * *opposite* end of the association. So in
 * `kind Staff { <>-- [2..*] (members) Employee }` the named end is written
 * `Staff.members`. The qualified form is the only one: indexing bare end
 * names would make two classes with a `members` end resolve to whichever the
 * scope happened to hold first.
 */

RelationStereotype returns string:
    'material' |
    'characterization' |
    'mediation' |
    'externalDependence' |
    'comparative' |
    'componenthood' |
    'membership' |
    'subCollection' |
    'subQuantity' |
    'constitution' |
    'historicalDependence' |
    'participation' |
    'creation' |
    'change' |
    'termination' |
    'manifestation' |
    'structural' |
    'temporal' |
    'participational' |
    'triggering' |
    'bringingAbout' |
    'presence' |
    'instantiation' |
    ID |
    STRING
;
