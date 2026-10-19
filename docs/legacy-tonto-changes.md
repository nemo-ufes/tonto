# From legacy tonto

Here **legacy tonto** means versions before 1.0.0 of the
[original tonto project](https://github.com/nemo-ufes/tonto-legacy). This is a
history of changes relevant when reading an older model or integrating with
older tooling. The [language guide](../AGENTS.md#read-the-language-first) and
`npx tonto guide` describe the current language; the
[language design notes](language-design.md) explain its present semantics.
tonto is an ontology language in its own right. Its gUFO export is one optional
representation, with a separate [mapping specification](gufo-mapping.md).

## What stayed recognizable

The core textual forms remain: `kind`, `role`, `relator`, `genset`, ordinary
associations (`--`), and the diamond for parthood (`<>--` or `--<>`). The
lexical layer retains the identifier repertoire and the familiar
multiplicity syntax. An older model can therefore often be read directly.
Some forms now produce a diagnostic and a concrete edit instead of retaining
their earlier meaning.

## Association vocabulary

Six association stereotypes were renamed. Parthood uses nouns, and causation
uses gerunds. The earlier words still parse so validation can name the
replacement.

| Earlier spelling | Write now |
|---|---|
| `@componentOf` | `@componenthood` |
| `@memberOf` | `@membership` |
| `@subCollectionOf` | `@subCollection` |
| `@subQuantityOf` | `@subQuantity` |
| `@triggers` | `@triggering` |
| `@bringsAbout` | `@bringingAbout` |

Six other older stereotypes no longer denote separate association kinds:

| Earlier spelling | Current expression |
|---|---|
| `@derivation` | `derivedFrom` on the material or comparative relation itself |
| `@formal` | `@comparative` for a comparison, or an ordinary association |
| `@inherence` | The applicable `@characterization` or `@mediation` relation |
| `@value` | Datatypes and attributes |
| `@composition`, `@aggregation` | A parthood stereotype, a diamond at the whole, and multiplicity at that end |

`@derivation` was a separate relation in older models. A ground could be
deleted while the derived relation remained, or the reverse. With
`derivedFrom`, the relation names the relator or qualities from which it is
read. Validation allows the clause only where it has meaning:
`@material` and `@comparative` relations.

`@structural`, `@temporal`, and `@participational` now distinguish criteria
for event parthood; `@presence` expresses a situation's relation to what it
exemplifies. The [language design notes](language-design.md#association-readings)
give their current readings.

The filled diamond `<o>--` was dropped. The diamond
marks the whole, while the bound at the whole end states whether a part may
be shared. A filled diamond's exclusivity claim is expressed with `[1]` or
`[0..1]` at that end. The two markings could previously contradict each
other.

## Documentation and modifiers

Documentation is now written with `///` lines immediately above a
declaration. The text appears on hover and in completion proposals. Older
`label { }` and `description { }` blocks still parse; the
`legacy-text-block` repair converts them to documentation lines.

Association-end flags and names now appear together in parentheses, with
flags first: `(const father)`, `(addOnly children)`, or
`(staff subsets Team.members)`. Attributes put modifiers before the type,
such as `nicknames: ordered string [*]`. `const` and `addOnly` have distinct
meanings: a fixed value and a collection that can only grow.

`@begin` and `@end` state when a concrete individual began and ceased to
exist. A required birth date can be written `@begin birthDate: const date`;
an end date on an individual that may still exist is
`@end deathDate: const date [0..1]`. Neither attribute has to be declared.

The older `mode` stereotype still parses, but is deprecated because it covers
intrinsic and extrinsic modes without choosing either identity principle.
Write `intrinsicMode` or `extrinsicMode` when that distinction is known. For
a non-sortal over either nature, use a restricted `category`.

## Ontologies and references

An `ontology` header identifies what is shared and imported. A small model
can put declarations directly after the header; a larger one can list package
files after `bundles`. Packages of the same ontology are reached with `use`;
an external ontology is imported by its ontology file location. The older
`import core` spelling for a package is diagnosed with a `use core` repair.
The [publication specification](ontology-publication.md) defines the current
model, and [its stage history](ontology-publication-stages.md) records how
that design was built.

Name resolution is case-sensitive. `Person` and `person` are distinct names,
and references must match the declaration's spelling. This keeps reference
resolution and duplicate-name detection consistent.

An association's name and an association end's name are different
references. The association is scoped by its source classifier, so a relation
named `hasMember` from `Team` is `Team.hasMember`. The end named
`(members)` beside `Person` is `Team.members`, qualified by the classifier
at the opposite end. `subsets` and `redefines` name ends, not associations.
This end name remains usable even when the association has no name.

## Why the generated AST changed

The implementation is still Langium-based. The redesign changed what its
grammar generates, so tools can distinguish concepts without guessing from
missing fields:

| Legacy AST shape | Current AST shape and reason |
|---|---|
| Both relation spellings inferred `ElementRelation`. An internal relation had no `firstEnd`, so consumers inspected its container to learn the source. | `InternalRelation` and `ExternalRelation` are distinct subtypes of `Relation`. `getRelationSource()` handles the one remaining difference. |
| An `enum` and a `datatype` inferred the same `DataType`, distinguished by `isEnum` and an optional list of elements. | `Enumeration` and `Datatype` have separate AST types. |
| Class stereotypes and ontological natures were wrapped in intermediate rule objects. | Both are fields on the declaration. |
| Each top-level item was held in a `Statement` with alternative optional fields. | `Model.imports`, `Model.packages`, and `Model.ontologies` hold the constructs directly. |
| Cross-reference target unions followed the names of types concatenated together. | Names such as `RelationEndTarget` and `AttributeType` state the target's role. |

The grammar now gives class stereotypes a generated union type. A new class
stereotype therefore requires its validation table entry at compile time;
using an unchecked string could previously leave a new stereotype silently
unhandled. The current taxonomy and relation-end signatures are derived from
principles and checked against transcribed fixtures.

Two grammar cases also changed: `powertype` was accepted without an entry in
the nature-compatibility table, and enumeration specialization admitted only
a limited number of targets while other specialization lists allowed more.
The current power-type form is
`isPowerType`.

## Checking an older model

Run `npx tonto check model.tonto --json` to see each diagnostic and the edits
it offers. `npx tonto check model.tonto --fix` applies repairs forced by a
rule; a repair that chooses a modeling interpretation remains an explicit
choice. To convert only the older text blocks, run
`npx tonto check model.tonto --fix=legacy-text-block`. Format and validate the
result again. The [pattern catalog](../AGENTS.md#and-what-to-write-instead)
provides validated models when a shape needs reconsideration.

## Export history

The gUFO mapping was implemented anew for this language model. Its
[comparison with the earlier pipeline](gufo-mapping.md#14-observed-differences-from-the-earlier-gufo-pipeline)
records confirmed differences in relation orientation, cardinalities,
datatypes, and ontology metadata. That account is specific to the gUFO
format; neither the mapping nor its history defines tonto publication.
