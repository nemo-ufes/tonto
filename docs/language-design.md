# Language design notes

This document explains decisions behind the current tonto language. For the
vocabulary and admissible combinations, use the language guide
(**Tonto: Open Language Guide** or `npx tonto guide`). Its catalogs are
printed from the validator's tables; the principles beside them are prose.
This document is about the reasons for particular shapes, not a second
specification.

If you are coming from OWL or Protégé, [From OWL and Protégé to
tonto](from-owl-and-protege.md) introduces the modeling workflow before these
design notes.

tonto models OntoUML/UFO in its own textual form. An ontology consists of an
`ontology` header and declarations, optionally organized into packages. OWL
and gUFO are export targets, not prerequisites for authoring a tonto model.
The details of packages, imports, and publication are in
[ontology-publication.md](ontology-publication.md); the optional gUFO mapping is
in [gufo-mapping.md](gufo-mapping.md). Changes from earlier tonto versions are
documented separately in [From legacy tonto](legacy-tonto-changes.md).

## Association readings

`@structural`, `@temporal`, and `@participational` distinguish *why* one event
is a part of another. A structural part belongs to the definition of the whole
event. A temporal part is a maximal segment projected by an external temporal
scheme. A participational part is projected by exclusive dependence on one
participant. Occupying only part of the whole's duration does not by itself
make an event part temporal. `@presence` expresses a situation's relation to
something it exemplifies.

## End names, bounds, and change

An association and its ends can each have a name. Both names may be qualified
by the source classifier, but they identify different model elements:

```tonto
kind Person
collective Team {
    @membership [*] <>-- hasMember -- [2..*] (members) Person
}
```

`Team.hasMember` names the **association**: `hasMember` is the relation name
written between the dashes and scoped by its source, `Team`. `Team.members`
names an **association end**: `(members)` is the role name beside `Person`.
That end has type `Person`: it names the people who are members of a team. Its
qualifier is `Team`, the classifier at the opposite end of the association. A
name beside `Team` would name the teams of which a person is a member, and
its qualifier would be `Person`.

This distinction matters for references. `subsets` and `redefines` target
named ends such as `Team.members`; naming the association `Team.hasMember`
does not identify an end. A relation written inside a class and one written
at package level express the same association; the parser keeps their source
forms distinct.

The diamond marks the whole in a parthood association. Thus `Wheel --<> [1] Car`
reads “a wheel is part of one car.” A bound at either end counts instances of
that end's type for each instance at the opposite end: the bound beside the
whole counts how many wholes each part belongs to, and the bound beside the
part counts how many parts each whole has. So `[0..1]` at the whole end allows
a part to have no whole or one whole; a bound above one allows sharing. A
second diamond does not express sharing. Omitted multiplicity means `[1]`.

Write `[n]` for exactly `n`, or `[lower..upper]` for a range; `*` is an
unbounded upper bound, and `[*]` is shorthand for `[0..*]`.

End modifiers sit in parentheses before the name: `(const father)`,
`(addOnly children)`, `(staff subsets Team.members)`. `const` says a link does
not change. On a multi-valued end, `addOnly` says links may be added but never
removed or replaced. Attributes put modifiers before the type:
`nicknames: ordered string [*]`. `const` and `addOnly` are alternatives.

The event and process distinction affects these claims. An event has
occurred, so its intrinsic properties are fixed. A process may still be
unfolding and its constituting events can accumulate. An end or attribute
marked `addOnly` can express that accumulation. An event participation should
be named in the past (`delivered`, `participatedIn`); a participation in an
ongoing process may use the present.

## Relationships and their grounds

A role is anti-rigid: an individual can cease to play it. A relator can found
the role by mediating its bearer and another participant. Read mediation
bounds in both directions. For
`@mediation [1..*] -- [1] (const) Employee`, one employment binds exactly
one employee, while each employee participates in one or more employments.
Run `npx tonto patterns role-and-relator` to see both participants in a
validated model.

A material relation holds because a relator or extrinsic mode binds its ends.
A comparative relation is read from qualities or intrinsic modes. The
`derivedFrom` clause identifies that ground on the relation itself:

```tonto
@material relation Employee [1..*] -- worksFor -- [1..*] Employer derivedFrom Employment
```

Only material and comparative relations take this clause. The declaration
must name its ground; two different relators may bind the same pair. The gUFO
export maps this to `gufo:isDerivedFrom`.

`@begin` and `@end` attributes state when a concrete individual began and
ceased to exist. Both are `const`. `@end` is `[0..1]` on anything that may
still be going on -- an endurant, a process, or a situation -- and `[1]` on
an event, which has ended. Neither attribute is required. Reified qualities and modes
need a bearer with a life, such as an endurant or process. For an event or
situation, write the corresponding fixed property as an attribute instead.

## Documentation belongs to the declaration

`//` is an ordinary comment. Consecutive `///` lines immediately above a
declaration are its documentation. The language server shows it on hover and
with completion proposals. A blank line ends the run. Documentation can
include `@label`, translated labels such as `@label:pt-br`, and translated
prose such as `@pt-br`. Older `label { }` and `description { }` blocks still
parse and have a conversion repair, described in
[From legacy tonto](legacy-tonto-changes.md#documentation-and-modifiers).

Write the meaning of an individual or relationship in domain language.
“A person's contribution as an author” describes the model; “the record
storing authorship” describes a database representation that may not exist.

The guide's catalogs, the rules, the patterns, and the tests are the places
to check whether a design decision still matches the implementation. The
principles in the guide are prose, so cross-check them against the checks.
The current AST
and grammar layout are described in [development.md](development.md#grammar-and-ast).
