# tonto to gUFO: the mapping

A specification for exporting a tonto model as an ontology aligned with
[gUFO](https://nemo-ufes.github.io/gufo/) 1.0.0, using OWL 2 DL constructs.
This mapping is implemented by `tonto gufo`,
`TontoSession.gufoText` / `gufoFiles`, and the MCP tool `tonto_gufo`.

The [ontology publication specification](ontology-publication.md) defines
ownership and visibility: ontology files enumerate their published packages,
`use` declarations state architectural dependencies between packages, and
imports connect ontologies. Identifiers are unique across every owned package
in an ontology, independently of `use` declarations. To verify an export for
publication, the checker uses the import and package locations written in the model. It reads files
already available locally and does not fetch anything from the network. If a
development setting points to a different file, that file cannot be used to
verify the published export.

Here, legacy tonto means tonto before version 1.0.0. This specification uses
the stereotypes, natures and relation vocabulary of `tonto guide`, the tables
under `packages/language/src/validation/`, and the helpers under
`packages/language/src/utils/`. The earlier exporter used a different model
and transformation path, so this mapping was implemented separately. Section
14 compares the outputs, using `tonto-cli@0.4.14 transform` as the earlier
pipeline.

The external source of truth is gUFO's canonical
[`gufo.ttl`](https://github.com/nemo-ufes/gufo/blob/master/gufo.ttl), whose
ontology and version IRIs identify 1.0.0. RDF encodings such as an inverse
property expression in `rdfs:subPropertyOf` follow the W3C
[OWL 2 mapping to RDF](https://www.w3.org/TR/owl2-mapping-to-rdf/), and the
OWL 2 DL datatype and simplicity restrictions follow the W3C
[structural specification](https://www.w3.org/TR/owl2-syntax/). These are
normative for the exporter; prose examples are not a substitute for them.

For minted relation names only, this specification adopts the directional
lexical conventions proposed by gUFO's
[inverse-module commit](https://github.com/nemo-ufes/gufo/pull/1/commits/e7ddf361bd4a0556293e8506c5dc181d17f66282).
That proposal remains outside canonical gUFO: the export neither imports its
`gufoi:` namespace nor refers to its properties. The names are vocabulary for
readable local IRIs; alignment continues to use canonical gUFO properties and
`owl:inverseOf` expressions (section 9).

## Contents

1. [Principles](#1-principles)
2. [When a model is exported](#2-when-a-model-is-exported)
3. [The reading of time](#3-the-reading-of-time)
4. [IRIs](#4-iris)
5. [Classes](#5-classes)
6. [Specialization and generalization sets](#6-specialization-and-generalization-sets)
7. [Types of types](#7-types-of-types)
8. [Attributes](#8-attributes)
9. [Relations](#9-relations)
10. [Multiplicities](#10-multiplicities)
11. [Documentation](#11-documentation)
12. [What the exporter reports](#12-what-the-exporter-reports)
13. [A worked example](#13-a-worked-example)
14. [Observed differences from the earlier gUFO pipeline](#14-observed-differences-from-the-earlier-gufo-pipeline)
15. [Possible mapping refinements](#15-possible-mapping-refinements)
16. [Implementation and verification](#16-implementation-and-verification)
17. [gUFO shapes](#17-gufo-shapes)
18. [The snapshot layer](#18-the-snapshot-layer)

---

## 1. Principles

Six, corresponding to each rule below.

1. **Export what the language says, including what it implies.** A model
   that leaves `(const)` off a mediation end is warned, not refused, and the
   end is still immutable: the language says so. The exporter reads the same
   predicates the checks read -- whole end, effective `const`, possible
   natures -- so an implied fact is exported exactly as a written one.
2. **One reading of time, stated once.** OWL has no time index, so every
   axiom is read the same way (section 3), and an axiom that is not sound
   under that reading is not written.
3. **Preserve the direction the model was written in.** Each tonto relation
   becomes one OWL property, pointing the way the relation was written, under
   its own name. Where gUFO's property points the other way, the alignment is
   to its inverse. The model's reading is never reversed to suit gUFO.
4. **Never knowingly contradict gUFO.** Where tonto admits something gUFO
   excludes -- a high-order type in an endurant's place, a process -- the
   gUFO alignment for that element is left out and reported. Passing tonto's
   checks is necessary, not a proof of OWL satisfiability: the exporter and
   its tests must still check the generated ontology with gUFO imported
   (section 16).
5. **Names decide IRIs.** An IRI is a function of the model's names. A
   classifier uses its declared name; every property and enumeration literal
   uses the structural name `Owner.member`, where an unnamed relation's member
   is its directional semantic stem and target classifier. It does not depend
   on declaration order, package structure, multiplicity, the natures of its
   ends, generated ids or an association-end role name, and a collision that
   owner qualification cannot resolve is an error, never a silent `_1`. An
   association end never has an IRI of its own.
6. **Say what was lost.** Whatever the gUFO-aligned OWL export cannot express
   is reported with a code (section 12), so "the export succeeded" never
   means "and some of it quietly vanished".

## 2. When a model is exported

- **Only a model with no errors.** The exporter runs the same checks as
  `tonto check` over the same scope (the workspace rule, `--workspace`,
  `--isolated`) and stops if any error is reported (`gufo-model-has-errors`),
  listing them. Warnings, information and hints do not stop it. This is what
  lets every rule below assume, for instance, that a relation's end natures
  fit its stereotype, that no member name repeats in a class, that no
  two packages share a name, and that every package is named. Nameless
  packages are a check error; export never sees them. What is only a warning -- a missing `(const)`,
  a missing diamond, a phase without its partition -- the exporter must
  handle itself. Export-specific errors discovered while planning IRIs and
  RDF terms also stop the write, so output is atomic: no partial `.ttl` is
  left behind.
- **The built-in datatypes are never emitted.** `tonto.builtindatatypes`
  maps to XSD (section 8.1). It is a compiler prelude, not an authored package.
- **Views are not a model.** `.tontoview` files are not read. `collectFiles`
  already walks `.tonto` only.
- **One document per ontology.** Each ontology header defines
  one ontology and its packages; a workspace of several ontologies exports
  several documents and nothing that joins them. Package namespaces must agree
  within an ontology. The ontology IRI is
  its namespace without the final `#` (or `/` in generic RDF previews).
  Every ontology imports canonical gUFO 1.0.0 and its directly declared
  ontology dependencies, even if an import is not used. Internal package
  imports create no OWL imports. A dependency is not copied into the
  importer's namespace, nor changed by its downstream importers. Selecting
  one root exports that root rather than republishing its dependencies.
  Snapshot and SHACL outputs use these same ownership boundaries.

- **Deterministic output.** Files in lexicographic order of their absolute
  paths, declarations in source order within a file, the axioms about one
  declaration together, members of `owl:unionOf` / `owl:oneOf` /
  `owl:AllDisjointClasses` / `owl:AllDifferent` in IRI order. Exporting
  twice yields the same bytes, so a diff of two exports is a diff of two
  models.
- **Laid out as a careful author would.** Two comment lines say the file
  was written by `tonto gufo`, from which packages, and that the model is
  what to change; they carry no date or version, which would break the
  sameness above. Then the prefixes the document uses and no others, in a
  fixed order (`owl` `rdf` `rdfs` `xsd` `gufo`, then package prefixes
  sorted by prefix name). Then a block per subject: `a`, then `rdfs:label`,
  `rdfs:comment` and `rdfs:isDefinedBy`, then the axioms. A restriction
  takes a line per part; a list of objects, or a collection, that would run
  past column 100 takes a line per item; short expressions -- an inverse, a
  union -- stay on one line. A statement about a node nothing else names, an
  `owl:AllDisjointClasses` or `owl:AllDifferent`, is written `[] a …`,
  never with a blank-node label. Documentation that runs over lines is
  written in Turtle's long form, `"""…"""`, with its line breaks. So a
  change to a model is a change to the lines about it. CI resolves the import
  against a pinned copy of gUFO 1.0.0 rather than depending on the current
  contents returned by a PURL.

## 3. The reading of time

gUFO represents endurants without temporal indexing: `:ana a :Customer` and
`:p1 :mediates :ana` carry no time. The one reading under which tonto's
anti-rigid types and mutable relations can be written this way at all is:

> An individual instantiates a class, or stands in a relation, if it does so
> **at some time** during its existence.

The earlier exporter also used this reading. Stating it here settles what may
be written:

| Model says | Sound under the reading? | So the exporter writes |
|---|---|---|
| Lower bound *n* at an end | Yes -- at least *n* at every time is at least *n* at some time | a min restriction, always |
| Upper bound *m* at an end | Only if no link, once held, is ever given up for another -- the end is effectively `const` or `addOnly`, including historical links to completed events -- **and** membership in the owner never lapses once acquired (section 10) | a max restriction only then |
| A disjoint pair with one lifetime-wide class, or two never-lapsing classes | Yes -- the memberships must overlap if both ever hold | `owl:disjointWith`, or `owl:AllDisjointClasses` when every pair is sound |
| Two lifetime-variable classes in a `disjoint` set | No -- a child now, an adult later: over a life, both | nothing for that pair; reported |
| A `complete` set | Yes -- at every time in some specific, so at some time | `owl:equivalentClass` with the union |
| Whoever took part in part of an event took part in the event | Yes -- an event's parts and participants never change | class-level restrictions on `gufo:participatedIn`, never the chain (section 10.2) |
| A role is founded by one of the relations that found it | Yes -- an instance is founded whenever it is one, so at some time | `owl:someValuesFrom`, or the union over its founding relations (section 10.1) |
| A historical role is whatever its derivation says happened | Yes, both ways -- whoever took part in, or was created or terminated in, such an event is one from then on, and every one was; the event and the link are never retracted | `owl:equivalentClass`, a definition (section 10.1) |
| A material relation holds wherever its relator binds both ends | Yes -- a relator's mediations, and a mode's inherence and dependence, are fixed for as long as it exists, so what it ever binds it binds at one time | an `owl:propertyChainAxiom` where OWL 2 DL allows it (section 9.2) |
| What a redefining end's owner reaches through the redefined end | Only if every such link is held while the owner is one: the owner is lifetime-wide, or neither owner's membership lapses and the redefined end is effectively immutable (section 9.6) | an `owl:allValuesFrom` restriction only then |
| `rdfs:domain`/`rdfs:range` of an exported property | Yes -- a link held at some time is held by an instance of the ends at that time | both, always |

gUFO's own answer for change in time is reification -- its
`TemporaryRelationshipSituation`, `TemporaryInstantiationSituation` and the
rest of the `standsIn` family. That is an alternative export strategy, not a
refinement of this one; see section 15.

What this reading withholds -- the rows answered "only if" or "no" -- holds
of the world at any one instant. A graph of current state, which retracts
what stops being true, may have it: the snapshot layer of section 18 writes
it in a module of its own, beside and importing each ontology, so that the
ontologies themselves stay true of any graph that only grows.

## 4. IRIs

- **Ownership precedes namespace assignment.** Packages are organized into
  ontologies by the [publication model](ontology-publication.md), not by
  their folder or package names. The ontology file selects the packages to
  publish. Its header owns the namespace
  and ontology metadata; package documentation describes internal
  organization.
- **`@namespace`.** Write an absolute HTTP(S) namespace immediately above
  the `ontology` header. Every package of the ontology is published in it; a
  `@namespace` anywhere else, a package included, is ignored with
  `ontology-tag-not-on-header`. Published and remotely
  imported ontologies require a hash namespace, without a query or an
  internal fragment. Generic local RDF previews may use slash namespaces.
  Reserved RDF/OWL/XSD/gUFO namespaces remain forbidden.
- **An exact namespace override.** `--namespace-iri` (or
  `GufoOptions.namespaceIri`) supplies the exact namespace for one selected
  unannotated ontology, including one containing several packages. It cannot
  replace an existing declaration or ambiguously assign several independent
  ontologies. Malformed overrides stop export.
- **A placeholder, for a preview.** An ontology whose header gives no
  namespace, and for which none is supplied, is exported under
  `https://example.org/<name>#` with a warning, `gufo-placeholder-namespace`,
  at its header. A placeholder preview is not a successfully checked
  publication. The editor's export asks for the namespace instead and writes
  it above the header.
- **Serialization aliases are not identities.** An ontology's name
  supplies its preferred Turtle prefix. Invalid prefix characters are replaced,
  leading nonletters receive a `p`, and reserved or duplicate prefixes get
  deterministic suffixes. Only used prefixes are declared. None of these
  choices changes a term IRI.
- **The namespace is the declaring package's owning ontology.** Attributes necessarily
  share their owner's package. A relation uses the package containing it,
  even when an end's owning classifier is imported: a relation declared in
  `sales` whose source is `core.Customer` is
  `…/sales#Customer.buys`. Association ends mint no RDF resources. The fact
  that `duplicate-member` checks the semantic owner's member namespace does
  not move the declaration into that owner's package.
- **Classifier and structural member names.** A class, datatype or
  enumeration is named as declared (`Person`). Every property and enumeration
  literal is named through its semantic owner as `Owner.member`; the dot is a
  structural separator and cannot occur inside either tonto `Name`:

  | Element | Local name | Example |
  |---|---|---|
  | class, datatype, enumeration | its name | `Person` |
  | attribute | owner + `.` + its name | `Person.name` |
  | enumeration literal | enumeration + `.` + its name | `Color.red` |
  | named relation | source + `.` + its name | `Customer.buys` |
  | unnamed relation | source + `.` + directional stem + target classifier (section 9.1) | `Car.hasComponentEngine` |
  | association end | no IRI; its name remains a tonto reference handle | `(wheels)` |

  In OWL a property is global, and one IRI for two properties would merge
  their domains. tonto attributes and relations are members of classifiers,
  so their qualified tonto names are also their stable OWL names:
  `Person.name` and `Product.name`, never two readings of `name`. Adding a
  second member cannot rename the first. Package names do not enter the IRI:
  a relation whose source is `core.Customer`, declared in a `sales` package,
  is still named from `Customer` and its member name in the namespace of the
  package containing the relation. Moving declarations among packages that
  publish into one namespace therefore changes no IRI.

  An owner-qualified name that still collides -- two unnamed relations from
  one owner with the same stereotype and target, as a team's `(members)` and
  `(captain)` both minting `Team.hasProperPartPerson` -- is
  `namespace-member-clash` during ordinary checking; name one of the relations.
  An end name does not disambiguate the two: role names are nouns, often plural
  because of multiplicity, and are not relation predicates. A similarly rare
  collision between equally named source classifiers from different
  ontologies is also an error rather than a package-dependent name. The
  structural dot keeps member IRIs apart from classifier IRIs.
- **Characters.** tonto identifiers admit `~ $ # @ /` and letters outside
  ASCII. Each package and local-name segment keeps every character
  [RFC 3987](https://www.rfc-editor.org/rfc/rfc3987) lets an IRI carry
  unescaped -- `iunreserved`: ASCII letters and digits, `- . _ ~`, and
  `ucschar` -- so `kind Ação` in package `vendas` is `…/vendas#Ação`, not
  `…/vendas#A%C3%A7%C3%A3o`. Every other character is UTF-8 percent-encoded
  with uppercase hex:
  - the ASCII punctuation identifiers admit and IRIs reserve (`$ # @ /`), so
    none of them can become IRI syntax;
  - the code points tonto's identifier pattern takes from XML's `NameChar`
    but `ucschar` leaves out (U+FFF0–U+FFFD);
  - the bidirectional formatting characters RFC 3987 §4.1 forbids (U+200E,
    U+200F, U+202A–U+202E). The grammar admits none of these today, and
    encoding them keeps this rule true if it ever does.

  No Unicode normalization is applied. IRIs compare character by character
  (RFC 3987 §5.3.1), and normalizing could merge two names tonto keeps apart.
  Encoding is applied to the original segments, before joining them, so the
  mapping is injective. Turtle's `PN_LOCAL` takes these letters and `%XX`
  sequences as they are (`vendas:Ação`, `vendas:a%24b`), but not a bare `~`.
  A local name Turtle cannot abbreviate is written as a full IRI.

## 5. Classes

Every class, and every structured datatype and enumeration, is an `owl:Class`
and is also an individual -- an instance of a gUFO type -- by OWL 2 punning,
as gUFO prescribes. Three decisions per class: its gUFO type, its gUFO
superclass and, for datatypes, its shape.

### 5.1 The gUFO type

Decided by the class's **possible natures** (`possibleNaturesOf`: declared,
stereotype-implied and inherited together) before its stereotype, because
gUFO's endurant types -- `Kind`, `SubKind`, `Role`, `Phase`, `Category`,
`Mixin`, `RoleMixin`, `PhaseMixin` -- all specialize `gufo:EndurantType`, and
using one for a class of events says its instances are endurants.

`possibleNaturesOf` returns atoms, with unions such as `objects` already
expanded, or `undefined` when nothing restricts the class (a bare `class`
with no `of` clause and no restricting ancestor). Treat `undefined` as
unrestricted: it matches the last row, not the first.

**UFO-endurant natures here means substantials and aspects only** --
`functional-complexes`, `collectives`, `quantities`, `relators`,
`intrinsic-modes`, `extrinsic-modes`, `qualities`. That is not
`ENDURANT_NATURES` in `natures.ts`. In this language `types` endure
(Fonseca et al., CAiSE 2022), so that set includes them. A class restricted
to `types` must not match the first row, or a `category of types` would be
typed `gufo:Category` and every `gufo:categorizes` from it would be
inconsistent (section 7). Match the first row that applies, with "only
`types`" above the endurant row so it cannot be swallowed:

| Possible natures | gUFO type |
|---|---|
| only `types` | none -- see section 7 |
| only the seven substantial/aspect natures above | by stereotype, below |
| only `events` and/or `processes` | `gufo:EventType` |
| only `situations` | `gufo:SituationType` |
| only `abstract-individuals` | `gufo:AbstractIndividualType` |
| concrete natures of several sorts (endurants with events, situations or processes; or events with situations) | `gufo:ConcreteIndividualType` |
| unrestricted, or mixing concrete with abstract or types | none |

The perdurant, high-order and abstract stereotypes -- `event`, `process`,
`situation`, `type`, `abstractum` -- never reach the stereotype table. An
`event` and a `category of events` both get `gufo:EventType`; gUFO has no
sortality or rigidity cells for perdurants, nor for `abstractum` versus
`category of abstract-individuals`. That loss is not reported for the
ultimate-sortal case: the nature mapping is the whole of what gUFO can say.
`isPowerType` is a modifier, not a stereotype, and does not appear here.

For substantial/aspect-only classes, by stereotype:

| Stereotype | gUFO type |
|---|---|
| `kind` `collective` `quantity` `relator` `quality` `intrinsicMode` `extrinsicMode` `mode` | `gufo:Kind` |
| `subkind` | `gufo:SubKind` |
| `role` `historicalRole` | `gufo:Role` |
| `phase` | `gufo:Phase` |
| `category` | `gufo:Category` |
| `mixin` | `gufo:Mixin` |
| `roleMixin` `historicalRoleMixin` | `gufo:RoleMixin` |
| `phaseMixin` | `gufo:PhaseMixin` |
| `class` | `gufo:EndurantType` |

A bare `class` restricted to substantial/aspect natures is a
`gufo:EndurantType`. That states only that its instances are endurants; it
does not choose between the disjoint `RigidType` and `NonRigidType` branches,
or between `Sortal` and `NonSortal`. Do not guess a more specific cell such
as `Kind` or `Role`. An unrestricted bare `class` still gets no gUFO type,
because it may classify something other than an endurant.

gUFO has no historical roles, so `historicalRole` and `historicalRoleMixin`
lose "historical" as a type (`gufo-no-counterpart`). They keep sortality:
the earlier exporter mapped `historicalRoleMixin` to `gufo:Role`, a sortal. A
historical role with a `derivedFrom` keeps what made it historical another
way: it is defined by the events it is derived from, which never stop having
happened (section 10.1). The deprecated
`mode` needs nothing of its own, since its natures already say intrinsic or
extrinsic.

An anti-rigid class over processes -- `phase Ongoing specializes Baking` --
gets `gufo:EventType` by the first table, which drops its anti-rigidity:
gUFO's rigidity types are endurant types only (`gufo-no-counterpart`).

### 5.2 The gUFO superclass

Each nature maps to one gUFO class:

| Nature | gUFO class |
|---|---|
| `functional-complexes` | `gufo:FunctionalComplex` |
| `collectives` | `gufo:Collection` |
| `quantities` | `gufo:Quantity` |
| `relators` | `gufo:Relator` |
| `intrinsic-modes` | `gufo:IntrinsicMode` |
| `extrinsic-modes` | `gufo:ExtrinsicMode` |
| `qualities` | `gufo:Quality` |

There is one relation-dependent refinement. A class at the portion end of an
`@participational` decomposition is also `rdfs:subClassOf
gufo:Participation`. The stereotype states that these are maximal event
portions projected by exclusive dependence on one endurant; an explicit
`@participation` to the portion must accordingly have maximum `1` at its
participant end. `@structural` and `@temporal` parts remain subclasses of
`gufo:Event` alone: the latter's external temporal projection has no more
specific gUFO class.
| `events` | `gufo:Event` |
| `processes` | `gufo:Event` (section 15) |
| `situations` | `gufo:Situation` |
| `abstract-individuals` | `gufo:AbstractIndividual` |
| `types` | `gufo:Type` |

The class is a subclass of the image of its possible natures: the one class
when there is one, otherwise the `owl:unionOf` of them --
`category Agent of functional-complexes, collectives` becomes
`rdfs:subClassOf [ owl:unionOf ( gufo:FunctionalComplex gufo:Collection ) ]`.
Collapse equal images first: `events` and `processes` both map to
`gufo:Event`, so a class of both is a subclass of `Event`, not of a
one-member union. Skip the axiom when nothing remains (unrestricted
`possibleNaturesOf`) or when a union would have fewer than two members.
The union is exact: it says what the natures say, not the nearest common
ancestor, which the earlier exporter used. The axiom is written only
where it narrows what the class's declared superclasses already entail, so a
`role` under a `kind` has none -- `Person` already says `FunctionalComplex`.

A mix of `types` with a concrete nature has no gUFO *type* (5.1 last row) but
may still have a superclass: `owl:unionOf ( gufo:Type gufo:FunctionalComplex )`
is a satisfiable class. That is not a gUFO type individual; it is only a
restriction on instances.

`collective` does not choose between `gufo:FixedCollection` and
`gufo:VariableCollection`. tonto records the distinction per membership end
(`const` or not) rather than per class, so the class stays at
`gufo:Collection`.

### 5.3 Datatypes and enumerations

OWL keeps literal datatypes and classes disjoint at the syntax level: an
`rdfs:Datatype` cannot be the subclass of an `owl:Class`, and OWL 2 has no
general sub-datatype axiom corresponding to tonto's `specializes`. The choice
therefore belongs to a datatype's whole specialization component, not to one
declaration in isolation.

- Build the undirected components of user-declared datatypes and enumerations
  connected by `specializes`. A component is **reified** if it contains an
  enumeration, a datatype with an attribute (including an inherited
  attribute), or a specialization edge to a class whose possible natures are
  only `abstract-individuals` -- an `abstractum`, or a `class` /
  `category` / `mixin` `of abstract-individuals`. Every datatype in such a
  component is an `owl:Class`, `a gufo:AbstractIndividualType`, and
  `rdfs:subClassOf gufo:QualityValue`. Its datatype-to-datatype and
  datatype-to-class specializations are ordinary `rdfs:subClassOf` axioms.
- An all-datatype component with no attributes and no class supertype is
  **literal**. OWL 2 DL does not admit an undefined custom datatype: every
  such datatype must have one `DatatypeDefinition`. Because tonto supplies
  no value space, the least-committal legal definition is the top data range:

  ```turtle
  ex:Code a rdfs:Datatype ;
      owl:equivalentClass rdfs:Literal .
  ```

  This deliberately accepts every data value; it does not invent a lexical
  space or facets. OWL 2 cannot express a `specializes` edge inside that
  component, so the edge is omitted and reported as
  `gufo-datatype-specialization-not-expressible`.
- A specialization edge from a user datatype to a built-in XSD-backed tonto
  datatype is also not expressible in general. It is reported and omitted;
  the built-in is never converted into a class merely to preserve the edge.
- **An enumeration** is consequently always an `owl:Class`, `a
  gufo:AbstractIndividualType`,
  `rdfs:subClassOf gufo:QualityValue`, and closed:

  ```turtle
  ex:ColorName owl:equivalentClass [ a owl:Class ;
      owl:oneOf ( ex:ColorName.blue ex:ColorName.green ex:ColorName.red ) ] .
  ex:ColorName.red a owl:NamedIndividual, ex:ColorName ; rdfs:label "red" .
  [] a owl:AllDifferent ;
      owl:distinctMembers ( ex:ColorName.blue ex:ColorName.green ex:ColorName.red ) .
  ```

  Skip `owl:AllDifferent` when fewer than two literals remain. The
  literal's label is the literal's name, as a string. The earlier pipeline
  emitted `rdf:label "[object Object]"` for this case.

This propagation matters for a declaration such as `datatype PostalAddress
specializes Address`: it remains reified even if it declares no attributes of
its own, because it inherits `Address`'s structure. It also prevents the same
IRI from being forced to act as both a data range and a class.

## 6. Specialization and generalization sets

- **Class `specializes`**, and datatype specialization where section 5.3
  represents both ends as classes, is `rdfs:subClassOf`, once per pair. A
  class specialization also listed in a generalization set is still one
  axiom. The earlier pipeline emitted it twice.
- **Ultimate sortals are pairwise disjoint.** "No two share an instance" is
  what an ultimate sortal is, and `cannotShareInstances` already reads it
  pairwise. `isUltimateSortal` takes a *stereotype string*, not a class.
  The export writes one `owl:AllDisjointClasses` over every class whose
  stereotype is an ultimate sortal, members in IRI order, and skips the
  axiom when fewer than two remain. gUFO separates functional complexes
  from relators, but nothing separates two kinds of functional complex
  except this axiom. The earlier pipeline did not emit this disjointness axiom
  (section 14).
- **`disjoint`** is considered pairwise. Define a class as *lifetime-wide*
  when it has a rigid stereotype (`isRigid` -- rigid only; `mixin` is
  semi-rigid and not lifetime-wide) or all its possible natures are in
  `IMMUTABLE_NATURES` (events, situations and abstract individuals -- not
  processes, and not `types`, which can change). A `type` class is still
  lifetime-wide by its rigid stereotype. A class is *never-lapsing* when it
  is lifetime-wide or is a `historicalRole`/`historicalRoleMixin`. A pair
  is sound in the accumulated reading when either member is lifetime-wide, or
  both are never-lapsing: if both ever hold, their memberships must overlap.
  If every pair is sound, write one `owl:AllDisjointClasses` (skip when
  fewer than two members). In a mixed set, write `owl:disjointWith` for each
  sound pair and omit only the unsound pairs. An omitted pair is reported as
  `gufo-disjointness-not-expressible`.
- **`complete`**: the general class `owl:equivalentClass` the union of the
  specifics, or the specific itself when there is one. Skip a union with
  fewer than two members. The equivalent-class axiom is stronger than "at
  some time" -- it says every instance of the general is an instance of a
  specific -- and still follows: a complete set holds at every time, so it
  holds at some time.
- **`categorizer C`**: `C` is always a class that classifies types, and the
  set is always a set of classes. A relation is refused as a categorizer
  (`categorizer-is-relation`), a class that does not classify types is
  refused (`categorizer-not-higher-order`), and so is a categorizer on a set
  of relations (`categorizer-on-relation-set`): its instances would be
  relations, which no class of types has, and gUFO's categorization relates
  classes by `rdfs:subClassOf`. Each specific is an instance of `C` by
  class/individual punning (`ex:Child a ex:AgePhase`), and
  `C gufo:categorizes G` for the general `G` -- or `gufo:partitions`, its
  specialization, when the set is `disjoint complete`.
- **A set of relations** yields `rdfs:subPropertyOf` for each specific. OWL
  has no union of properties, and disjoint properties fail the reading of
  time just as anti-rigid classes do, so `disjoint` and `complete` are not
  written as property axioms (`gufo-no-counterpart`). Such a set has no
  categorizer (above).

## 7. Types of types

gUFO makes `gufo:Individual` and `gufo:Type` disjoint. This language treats a
high-order type as an endurant (`natures.ts`: `types` endures, citing Fonseca
et al., CAiSE 2022), which is why `@begin`, `@mediation` and
`@externalDependence` may reach one. That position cannot be represented
against gUFO without inconsistency, so the gUFO side wins wherever the two
meet:

- A class restricted to `types` is an `owl:Class`, `rdfs:subClassOf
  gufo:Type`, and gets **no** gUFO type. `gufo:categorizes` requires its
  subject to be neither a `ConcreteIndividualType` nor an
  `AbstractIndividualType`, and every gUFO endurant type is the former.
  Typing a high-order class `gufo:Kind`, which its `type` stereotype would
  suggest, makes any `categorizes` from it inconsistent.
- **`(instanceOf H)`** is `rdf:type`: `ex:Sedan a ex:CarModel`. The clause
  carries no multiplicity (`crossLevelsFrom` records no `bounds`), so it
  never satisfies `partitionsBase`. It does not write `categorizes`.
- **`@instantiation`** from a base `B` to a higher type `H` is not an OWL
  property, even when the relation is named. No domain, range or
  multiplicity axiom is written for it. Multiplicities are used only to
  choose `partitions` versus `categorizes`. It is read through
  `crossLevelsFrom` (`mlt-graph.ts`):
  - `H` without `isPowerType` (Odell's reading, MLT *characterizes*):
    `H gufo:categorizes B`, or `H gufo:partitions B` where the higher end is
    `[1]` (`partitionsBase`; an omitted multiplicity is `[1]`).
  - `H isPowerType` (Cardelli's reading, MLT *powertype of*): gUFO has no
    property for it. The exporter writes what can be written: `B a H`, and
    `S a H` for every class `S` in the model that specializes `B`. The rule
    that future specializations are instances too is lost
    (`gufo-no-counterpart`).
- Emit each triple once. A Cardelli powertype already implies `B a H`; an
  extra `(instanceOf H)` on `B` is the same axiom.
- **Relations and attributes that reach a type** where gUFO expects an
  individual lose their gUFO alignment under the guard in section 9.5, and
  are exported as plain properties.

## 8. Attributes

### 8.1 Built-in datatypes

| tonto | XSD | Note |
|---|---|---|
| `string` | `xsd:string` | |
| `number` | `xsd:decimal` | the earlier pipeline emitted an undeclared `:number` |
| `boolean` | `xsd:boolean` | |
| `date` | `xsd:date` | outside the normative OWL 2 datatype map; canonical gUFO already declares and uses it, so importing gUFO brings this profile exception into every import closure |
| `time` | `xsd:time` | also outside the normative map; unlike `date`, this is an additional exception introduced only when the tonto model uses it |
| `datetime` | `xsd:dateTime`, or `xsd:dateTimeStamp` on `@begin`/`@end` | see below and section 15 |

### 8.2 The property

An attribute `a` of owner `O` is a property `O.a` with `rdfs:domain O` and
`rdfs:range` its type. What kind of property, and what it specializes, depend
on the type and on what `O` classifies:

Here **primitive datatype** means a member of a literal component from
section 5.3; **structured datatype** means a member of a reified component.

| Attribute type | Owner classifies | OWL | Specializes |
|---|---|---|---|
| built-in or primitive datatype | concrete individuals | `owl:DatatypeProperty` | `gufo:hasQualityValue` |
| built-in or primitive datatype | a reified datatype (quality value) | `owl:DatatypeProperty` | `gufo:hasValueComponent` |
| structured datatype or enumeration | concrete individuals | `owl:ObjectProperty` | `gufo:hasReifiedQualityValue` |
| structured datatype or enumeration | a reified datatype | `owl:ObjectProperty` | nothing |
| anything | abstract individuals or types | per type | nothing -- gUFO's value properties want a concrete individual (section 7) |

Write a gUFO value superproperty only when every possible nature of the
owner maps to a gUFO class inside that property's domain (`hasQualityValue`
and `hasReifiedQualityValue` want `ConcreteIndividual`;
`hasValueComponent` wants `QualityValue`). An unrestricted owner, or one
that mixes types or abstracts with concrete natures, gets no superproperty
and no diagnostic -- the model claimed no alignment. The same guard as
section 9.5 applies when a counterpart exists but the owner does not fit
(`gufo-alignment-dropped`): `@begin` on a high-order type is this case,
not `gufo-no-counterpart`.

`ordered` and `derived` have no OWL counterpart (`gufo-no-counterpart`).

### 8.3 `@begin` and `@end`

A time-point attribute specializes gUFO's begin or end point property:

| Stereotype | `date` | `datetime` |
|---|---|---|
| `@begin` | `gufo:hasBeginPointInXSDDate` | `gufo:hasBeginPointInXSDDateTimeStamp` |
| `@end` | `gufo:hasEndPointInXSDDate` | `gufo:hasEndPointInXSDDateTimeStamp` |

Both on one attribute (an instantaneous individual) means both
specializations. A `datetime` time point gets range `xsd:dateTimeStamp`: a
value without a time zone has no place on gUFO's timeline. A `time`-typed
time point has no gUFO property to specialize (`gufo-no-counterpart`). One
owned by a high-order type has a counterpart that does not fit -- report
`gufo-alignment-dropped` and leave the attribute as a plain data property
(sections 7, 8.2).

Attribute multiplicities follow section 10, as properties of their owner.
The earlier pipeline did not emit them.

## 9. Relations

### 9.1 One property per relation

Each relation is one property `P` from its source to its target, in the
direction written, with `rdfs:domain` the source and `rdfs:range` the target
-- except `@instantiation`, which is not a property at all (section 7). A
named `@instantiation` still produces no IRI, no domain and no range; its
name is unused (`gufo-no-counterpart`).

A relation between class-represented classifiers is an `owl:ObjectProperty`.
One whose target is a primitive datatype (a member of a literal component
from section 5.3, or a built-in) is an `owl:DatatypeProperty`, like an
attribute. An enumeration is always a class, so a relation to one is an
object property. One whose source is a primitive datatype cannot be written,
since literals are not subjects (`gufo-no-counterpart`). For a data-property
relation, only the target end is navigable in OWL: data properties have no
inverse, and literals cannot own the source end. The source end's
multiplicity, `subsets` or `redefines` are omitted and reported as
`gufo-reverse-data-end-not-expressible`.

Its IRI is section 4's. A named relation's member name is its declared name.
Every unnamed relation's member name is minted as
`<directionalSemanticStem><TargetClassifier>`, whether either end is named
or not, and its complete local name is
`<SourceClassifier>.<memberName>`. Classifier names are copied exactly; the
exporter neither singularizes nor otherwise inflects them. Association-end
names do not enter the relation IRI: they are navigational role nouns, and
multiplicity commonly makes them plural. Thus `(wheels) Wheel` under `Car`
gives `Car.hasComponentWheel`, not `Car.wheels` and not an attempted
singularization of `wheels`. The property's `rdfs:label` is that complete
local name too, `Car.hasComponentWheel`: the member name alone repeats
wherever two sources relate the same way to one target, and two properties
with one label are an error in ROBOT's report.

The stem is read from what is written -- the stereotype, and which end the
diamond marks -- never from the natures of the ends. An unstereotyped
parthood is therefore always `isProperPartOf` or `hasProperPart`, even
where section 9.2 aligns it with the more specific
`gufo:isObjectProperPartOf`: the natures choose the superproperty, and
editing another class's natures never renames a property.

Where section 9.2 aligns the relation with a canonical gUFO property, its
member name uses the stem when the relation is written in the same direction.
When written in the other direction, the member name uses the corresponding
inverse below. These inverse names adopt the lexical conventions of the proposed
gUFO inverse module, but only as strings in model-local IRIs: no `gufoi:`
ontology is imported or referenced.

| Stem in canonical gUFO direction | Stem in the opposite direction |
|---|---|
| `inheresIn` | `bears` |
| `mediates` | `isMediatedBy` |
| `externallyDependsOn` | `hasModeDependee` |
| `isComponentOf` | `hasComponent` |
| `isCollectionMemberOf` | `hasCollectionMember` |
| `isSubCollectionOf` | `hasSubCollection` |
| `isSubQuantityOf` | `hasSubQuantity` |
| `isObjectProperPartOf` | `hasObjectProperPart` |
| `isAspectProperPartOf` | `hasAspectProperPart` |
| `isEventProperPartOf` | `hasEventProperPart` |
| `isSituationProperPartOf` | `hasSituationProperPart` |
| `isProperPartOf` | `hasProperPart` |
| `constitutes` | `isConstitutedBy` |
| `historicallyDependsOn` | `hasHistoricalDependee` |
| `participatedIn` | `hadParticipant` |
| `wasCreatedIn` | `created` |
| `wasTerminatedIn` | `terminated` |
| `manifestedIn` | `manifested` |
| `contributedToTrigger` | `wasTriggeredBy` |
| `broughtAbout` | `wasBroughtAboutBy` |

Three cases have no such canonical pair. An unnamed `@material`,
`@comparative` or plain `--` relation uses `has`; `@change` uses `changedIn`;
and reversed `gufo:standsIn` for `@presence` uses `involves`. These are stable
tonto stems, not claims that a same-named gUFO property exists. Since `has`
states little, a domain name is preferable for a material, comparative or
plain association whenever the modeler has one. Examples of the complete
rule are `Car.hasComponentWheel`, `Purchase.mediatesCustomer`,
`Statue.isConstitutedByPortionOfClay` and `Configuration.involvesPerson`.

### 9.2 Alignment with gUFO

The stereotype selects a gUFO property `G` and says whether `G` runs the way
the relation was written or the other way. Same way: `P rdfs:subPropertyOf
G`. Other way: `P rdfs:subPropertyOf [ owl:inverseOf G ]`, which is OWL 2 DL
(checked with ROBOT's profile validation) and keeps the model's own name and
direction.

| Stereotype | gUFO | Orientation | gUFO's domain → range |
|---|---|---|---|
| `@material` | object property `P a gufo:MaterialRelationshipType`, no superproperty; `P gufo:isDerivedFrom D` for `derivedFrom D` | -- | -- |
| `@comparative` | object property `P a gufo:ComparativeRelationshipType`, no superproperty; `P gufo:isDerivedFrom Q` for each `Q` in `derivedFrom` | -- | -- |
| `@characterization` | `gufo:inheresIn` | as written | Aspect → ConcreteIndividual |
| `@mediation` | `gufo:mediates` | as written | Relator → Endurant |
| `@externalDependence` | `gufo:externallyDependsOn` | as written | ExtrinsicMode → Endurant |
| `@componenthood` | `gufo:isComponentOf` | part → whole (9.3) | Object → FunctionalComplex |
| `@membership` | `gufo:isCollectionMemberOf` | part → whole | Object → Collection |
| `@subCollection` | `gufo:isSubCollectionOf` | part → whole | Collection → Collection |
| `@subQuantity` | `gufo:isSubQuantityOf` | part → whole | Quantity → Quantity |
| `@structural`, `@temporal`, `@participational` | `gufo:isEventProperPartOf` | part → whole | Event → Event |
| parthood, no stereotype | by the gUFO images of both ends: `isObjectProperPartOf`, `isAspectProperPartOf`, `isEventProperPartOf`, `isSituationProperPartOf`, else `isProperPartOf` -- the superproperty only; the name is `isProperPartOf`/`hasProperPart` (9.1) | part → whole | per property |
| `@constitution` | `gufo:constitutes` | reversed: tonto writes constituted → constituent (9.4) | ConcreteIndividual → ConcreteIndividual |
| `@historicalDependence` | `gufo:historicallyDependsOn` | as written | ConcreteIndividual → ConcreteIndividual |
| `@participation` | `gufo:participatedIn` | as written | Object → Event |
| `@creation` | `gufo:wasCreatedIn` | as written | Endurant → Event |
| `@change` | none (`gufo-no-counterpart`) | -- | -- |
| `@termination` | `gufo:wasTerminatedIn` | as written | Endurant → Event |
| `@manifestation` | `gufo:manifestedIn` | as written | Aspect → Event |
| `@triggering` | `gufo:contributedToTrigger` | as written | Situation → Event |
| `@bringingAbout` | `gufo:broughtAbout` | as written | Event → Situation |
| `@presence` | `gufo:standsIn` | reversed: what is present stands in the situation | Thing → Situation |
| `@instantiation` | not a property -- section 7 | -- | -- |
| `--`, no stereotype | none -- a plain object (or data) property | -- | -- |

Unstereotyped `--` claims no UFO relation. `implied-relation-stereotype` is
a hint about what *could* be written, not a fact the export may take: a
hint does not state parthood, mediation or anything else. The diamond does.
Unstereotyped `<>--` is already in the table above, aligned by the gUFO
images of both ends.

`@material` and `@comparative` are typed as relationship types and have no
gUFO superproperty. gUFO recommends `gufo:isDerivedFrom` from those types to
the relator or quality they come from, and tonto says it with a clause on the
relation: `@material relation Employee -- worksFor -- Organization
derivedFrom Employment`, or `derivedFrom Height, Weight` for a comparative.
Each entry becomes `P gufo:isDerivedFrom D`, with `P` and `D` punned as
individuals, as gUFO's own typing of them already does. The checks have made
sure `D` is of the right nature -- an extrinsic aspect for a material
relation, an intrinsic one for a comparative, which is gUFO's recommendation
too -- and warned where it does not reach both ends. Where the clause is
absent nothing is written: the edge is not reconstructed from "the unique
relator that mediates both ends", which is a guess -- two relators may bind
the same pair -- and the checks ask the model to say it instead
(`derivation-unstated`).

The derivation also says when the relation holds: whenever the relator binds
both ends. So a material relation derived from a relator `D` is implied by
the chain through `D`'s two mediations -- `S` back to the relator, and on to
`T`:

```turtle
ex:Employee.worksFor owl:propertyChainAxiom
    ( [ owl:inverseOf ex:Employment.mediatesEmployee ] ex:Employment.mediatesEmployer ) .
```

From an extrinsic mode the chain runs through what it inheres in and what it
externally depends on, whichever reaches which end. Given one employment
binding Ana and Acme, a reasoner concludes that Ana works for Acme. The
axiom states one direction only, as OWL chains do: a `worksFor` link with no
employment behind it is not refuted. It is written only where it adds
without taking anything away, and otherwise withheld with
`gufo-derivation-chain-withheld`:

- Each end is reached by exactly one of `D`'s *own* mediations (or, for a
  mode, its own characterization or external dependence), where "reached"
  counts a mediation of a supertype of the end. A mediation `D` inherits is
  shared with every other specialization of its owner, and the chain would
  relate what those bind as well. Two mediations reaching one end leave the
  pairing unsaid.
- The two differ. `relator Marriage { @mediation -- [2] Spouse }` has one
  mediation for both spouses, and read both ways it relates each spouse to
  themselves.
- OWL 2 DL counts a property implied by a chain as non-simple, together with
  every property above it and every inverse of those, and only a simple
  property may carry a cardinality restriction or be functional. Where the
  export writes such an axiom about any of them -- `[2..*]` at an end, or a
  retained upper bound -- the chain is withheld and the bound kept. So is a
  chain whose property sits under a gUFO property, and one through a
  dependence that is itself under the property, which OWL 2 DL's regularity
  condition forbids.

`@change` is still a property of the model: domain, range and multiplicities
are written, the minted verb is still `changedIn`, and there is no gUFO
alignment (`gufo-no-counterpart`).

The three event-parthood stereotypes all align to the same gUFO property, but
retain different modeling criteria in tonto. `@structural` relates a whole
event to an event that belongs to its definition. `@temporal` is reserved for
a maximal segment projected by an external temporal scheme, such as a fixed
interval, duration, or temporal relation to another event. `@participational`
relates a whole to a maximal portion projected by exclusive dependence on one
endurant; when an explicit `@participation` targets that portion, its
participant end must have maximum cardinality `1`.

Their relation-level distinction is still reported as `gufo-no-counterpart`
because all three relations export as `gufo:isEventProperPartOf`. The class at
the portion end of `@participational` is additionally a
`gufo:Participation`, as specified in section 5.2; the whole-to-part property
itself has no more specific gUFO counterpart.

No property of the model is ever declared transitive, functional,
inverse-functional or asymmetric merely because its gUFO superproperty is. A
property is functional or inverse-functional where its own multiplicities
say so (section 10), never by inheritance.
Cardinality restrictions are placed only on the model's own properties, never
on gUFO's, and only when that property is simple. Several gUFO parthood
properties are transitive, and so is `gufo:historicallyDependsOn`, which
makes them non-simple in OWL 2 DL and therefore unusable in a cardinality
restriction. The model's subproperties of them remain simple, since
simplicity depends on what lies *below* a property, not above it. Functional
does follow from a functional superproperty, so there is nothing extra to
copy onto `P`.

### 9.3 Which end is the whole

Read with `wholeEndOf` (`utils/relations.ts`): the diamond marks the whole,
and with no diamond the whole is the source. So:

- `kind Car { @componenthood [1] <>-- [1] (const engine) Engine }` is
  written whole → part. Its relation property is
  `Car.hasComponentEngine rdfs:subPropertyOf [ owl:inverseOf
  gufo:isComponentOf ]`. The end name `engine` produces no RDF term. A
  reasoner infers `:e1 gufo:isComponentOf :beetle` from
  `:beetle :Car.hasComponentEngine :e1` (section 13).
- `@componenthood relation Engine [1] --<> [1] Car` is written part → whole,
  and its property `isComponentOfCar` is a direct
  `rdfs:subPropertyOf gufo:isComponentOf`.

The earlier tonto → ontouml-js → gUFO path placed the diamond on the whole's
end while ontouml-js interpreted its target end as the whole. That produced
the opposite parthood direction in Turtle. For `@membership`, this can make
a person both a `gufo:Collection` and a `gufo:FunctionalComplex`, which are
disjoint in gUFO. HermiT confirms the inconsistency on the University example
from the earlier project.

### 9.4 Constitution

A tonto `@constitution` runs from what is constituted to what constitutes
it:

```tonto
kind Statue
quantity PortionOfClay
@constitution relation Statue [0..1] -- [1] PortionOfClay
```

This is the direction the relation table fixes for its one crossing, a
process constituted by events, taken for every constitution: the constituted
individual derives its basic properties from what constitutes it. Within one
category no nature tells the two ends apart, so the language cannot enforce
it there. It is the convention the checks read and the `constitution`
pattern writes.

`gufo:constitutes` runs the other way, from constituent to constituted, so
the unnamed relation becomes `isConstitutedByPortionOfClay
rdfs:subPropertyOf [ owl:inverseOf gufo:constitutes ]`, and a reasoner infers
that the portion of clay `gufo:constitutes` the statue.

### 9.5 The guard

Before writing `P rdfs:subPropertyOf G` (or its inverse), the exporter maps
each end's possible natures through section 5.2 and checks that every resulting
gUFO class is within `G`'s declared domain or range (swapped for an inverse).
It also checks the OWL entity kind: an object property is never aligned to a
data property, or conversely. Where tonto admits more than gUFO does, the
axiom is left out and `gufo-alignment-dropped` names the relation, the gUFO
property and the nature that did not fit:

- a high-order type at an end of `@characterization`, `@mediation`,
  `@externalDependence`, `@historicalDependence`, `@creation` or
  `@termination`, which tonto opens to endurants or concrete individuals and
  so to types (section 7), while gUFO wants an individual;
- a process or a situation as the dependee of `@externalDependence`, since
  gUFO wants an endurant;
- a process as the bearer in `@characterization` fits because section 5.2
  maps processes to `gufo:Event`, a `gufo:ConcreteIndividual`; this is a
  deliberate consequence of the open process decision rather than a special
  case in the guard;
- a primitive-valued `@material` or `@comparative` remains a data property but
  is not typed as a gUFO relationship type, since those classify object
  properties.

The same check covers attribute superproperties (section 8.2). Characterization
of an event or a situation is a tonto error; export never sees it. Process as
`@externalDependence` dependee does not fit (range `Endurant`).

`P` itself, its domain, its range and its multiplicities are still written.
Only the claim gUFO would refute is withheld.

### 9.6 Ends, `specializes`, `inverseOf`, `subsets`, `redefines`

- **An association end never mints a property.** Its name is a tonto
  navigation and reference handle for multiplicity, `subsets` and
  `redefines`; it is neither an OWL entity nor a label for `P`. Changing
  `(engine)` to `(engines)` therefore changes no RDF term.
- Let `PE(e)` be the relation as navigated through end `e`: `P` for the
  target end and `[ owl:inverseOf P ]` for the source end of an object
  property. A data-property relation has no source-end expression (section
  9.1). Multiplicities use this expression as section 10 specifies.
- **`specializes R2`**: `P rdfs:subPropertyOf P(R2)`.
- **`inverseOf R2`**: `P owl:inverseOf P(R2)` when both are object
  properties. OWL has no inverse data properties; an inverse involving one is
  omitted with `gufo-reverse-data-end-not-expressible`.
- **`(x subsets Owner.y)`**: `PE(x) rdfs:subPropertyOf PE(Owner.y)`. The
  property expressions, not the end names, enter the axiom.
- **`(x redefines Owner.y)`**: the same property-expression subproperty
  axiom as for `subsets`. UML adds that, for an instance of `x`'s owner `O'`,
  `y` holds `x`'s links and no others -- the two are one end under two
  names. That equality has no OWL form (`gufo-no-counterpart`), but one
  consequence does: whatever `O'` reaches through `y`, it reaches through
  `x`, so it has `x`'s type `T'`:

  ```turtle
  O' rdfs:subClassOf [ a owl:Restriction ;
      owl:onProperty PE(Owner.y) ;
      owl:allValuesFrom T' ] .
  ```

  Under the reading of section 3 this holds only if every link `y` ever
  gives an instance of `O'` is held at a time it is an `O'`. So it is
  written when `O'` is lifetime-wide (section 10's rigid stereotypes and
  immutable natures), or when membership in `O'` and in `y`'s owner never
  lapses and `y` is effectively immutable -- the conditions of an upper
  bound, applied to the redefined end. Otherwise it is withheld, and the
  note says so: a `phase` may have had other links through `y` in an earlier
  spell. Nothing is written when `x` keeps `y`'s type, since the range
  already says it, nor when `T'` is a literal datatype and `y` an object
  property, or the reverse.

## 10. Multiplicities

An end constrains the relation as navigated from the classifier at the
opposite end; it does not mint another property. An attribute is a property
of its owner. For an end or attribute `e`, owned by `O`, typed `T`, with
bounds `[l..u]` (an omitted multiplicity is `[1]`), reached from `O` by the
property expression `PE` -- `P` for a target end or an attribute,
`[ owl:inverseOf P ]` for a source end of an object property:

- **Lower bound.** If `l ≥ 1`, write `O rdfs:subClassOf` a restriction.
  Decide the form from the restriction that is actually written, not from
  the source bounds: after an upper bound is withheld, `[1]` and `[1..*]`
  are the same claim. For an object property, use `owl:someValuesFrom T`
  when the written restriction is lower 1 with no max; otherwise
  `owl:minQualifiedCardinality l` with `owl:onClass T`. For a data property
  -- an attribute or a relation to a primitive datatype -- use unqualified
  `owl:minCardinality l`; the property's global range already fixes the data
  range. No restriction is written for the inverse/source end of a data
  relation (section 9.1).
- **Upper bound.** If `u` is finite, `e` is effectively immutable, and
  membership in `O` never lapses once acquired, write the matching max
  restriction; when `l = u`, write `owl:qualifiedCardinality` for an object
  property or `owl:cardinality` for a data property in place of the pair.
  Otherwise the min and the max are two restrictions: the OWL 2 RDF mapping
  gives each restriction node exactly one constraint, and OWLAPI reads a
  second one on the same node as an annotation, silently dropping the bound.
  - *Effectively immutable* means `const` or `addOnly` as written, or as the
    language implies through a *warning* (or hint) the checks already fire:
    `dependence-end-not-const`, `immutable-end-not-const`,
    `creation-end-not-const`, `immutable-attribute-not-const` (which covers
    the attributes of datatypes as well as those of events, situations and
    abstract individuals: a value with a different component is a different
    value), `time-point-not-const`, `const-not-propagated`,
    `accumulating-end-not-add-only` and `add-only-not-propagated`. Those
    rules do not refuse the model, so a model that validates may still omit
    the word, and the export must not depend on it. An *error* that would
    force the word -- `quantity-part-not-essential` -- is not implied here:
    a model that exports already has `const` written. A relation expressing
    a historical link to a completed event also has effectively `addOnly`
    links at both ends, without requiring the word: `@participation`,
    `@creation`, `@change`, `@termination`, `@manifestation` and
    `@historicalDependence` with an event target. A completed event and who
    took part in it, was created or terminated in it, or historically depends
    on it do not change. If a growing set never exceeds `u` at one time, its
    accumulated set never exceeds `u` either. This does not follow merely
    from the target being an event: a plain association to a past event may
    lapse. Nor does it apply to a process, which may still be unfolding.
  - *Owner membership never lapses* for a rigid stereotype (`isRigid`), a
    `historicalRole`/`historicalRoleMixin`, or a classifier all of whose
    possible natures are in `IMMUTABLE_NATURES` (events, situations and
    abstract individuals, including structured datatypes and enumerations).
    A bare `class` over a changeable nature is not assumed rigid merely
    because it has no explicit anti-rigid stereotype. Under a reversible
    `role`, `phase`, anti-rigid mixin or semi-rigid `mixin`, `const` means
    fixed only while the individual is in it -- the guide says so of parts,
    and it holds of any end -- so a later spell may bring a different link
    and the accumulated count can exceed `u`.
  - Otherwise the bound is withheld and reported as
    `gufo-upper-bound-not-expressible`.
- **Functional.** Where the max written is 1, `P` is also declared
  `owl:FunctionalProperty` for a target end or an attribute, and
  `owl:InverseFunctionalProperty` for a source end. `O` is `P`'s domain (its
  range, from a source end), and each attribute and relation has a property
  of its own (section 4), so a max of one on `O` is a max of one on every
  subject of `P`: the characteristic is entailed already, and adds nothing a
  reasoner does not conclude. It is declared for the readers that do not
  reason -- an editor's "Functional" box, a generator that makes it
  `sh:maxCount 1` or a single-valued field. It follows the written bound,
  not the word `const`: `nomeArtistico: const string [1]` on a `role` is not
  functional, since a second spell as an artist may bring a second name. A
  data property is never inverse-functional, which OWL 2 DL forbids; its
  source end has no restriction to begin with (section 9.1). The properties
  are simple (section 9.2), as OWL 2 DL requires of a functional object
  property.
- **Nothing** for `[0..*]`, `[*]`, `[0..1]` where `e` is mutable.

All counts are typed `xsd:nonNegativeInteger`, as the OWL 2 RDF mapping
requires. So, with `relator Purchase { @mediation [0..*] -- [1] (const)
Customer }`: `Purchase ⊑ =1 Purchase.mediatesCustomer.Customer`, and nothing
at the `[0..*]` end. The same relation without `(const)` exports identically,
because mediation implies it. For these two cases, the earlier pipeline
emitted no bound and `≥1`, respectively.

### 10.1 Relational conditions

A role holds because of something outside it: a relator that mediates it, or
a whole it is part of. A historical role holds because of an event: one it
took part in, or was created or terminated in. The gUFO paper writes this as a
class axiom (its Listing 20):

```turtle
:Student rdfs:subClassOf [ a owl:Restriction ;
    owl:onProperty [ owl:inverseOf :Enrollment.enrollmentInvolvesStudent ] ;
    owl:someValuesFrom :Enrollment ] .
```

The multiplicities above write it whenever one founding relation is
mandatory. The stereotype implies it even when none is, so the export writes
it from the stereotype too:

- **What founds.** For a `role` or `roleMixin`: each `@mediation` whose
  target is the class, and each parthood where the class is the part. For a
  `historicalRole` or `historicalRoleMixin`: each `@participation`,
  `@creation` or `@termination` whose source is the class -- being
  born in Brazil is founded by a birth as being a graduate is by a
  graduation. Only the class's
  own relations count. A mediation of a rigid supertype -- `Enrollment`
  mediating `Person` -- says what any person may have, not what makes one a
  student. `@creation` and `@historicalDependence` found nothing here.
- **What is written.** Nothing if one founding relation is already mandatory,
  since its restriction is stronger, and nothing if there is none. With one
  optional founding relation, `C ⊑ ∃ PE.F`, where `PE` is the relation read
  from `C` (an inverse for a mediation) and `F` the relator, whole or event.
  With several, their union: only one of them has to hold, so a former
  employee retired *or* was dismissed.

  ```turtle
  :FormerEmployee rdfs:subClassOf [ a owl:Class ; owl:unionOf (
      [ a owl:Restriction ; owl:onProperty :FormerEmployee.retiredIn ; owl:someValuesFrom :Retirement ]
      [ a owl:Restriction ; owl:onProperty :FormerEmployee.wasDismissedIn ; owl:someValuesFrom :Dismissal ] ) ] .
  ```
- **What is inherited.** A class under a supertype founded the same way -- a
  `role` under a `roleMixin` that purchases found -- gets that condition by
  subclassing, and its own relations are not taken to be what founds it. A
  loyalty card a personal customer may hold does not make them a customer.
- **What is derived.** A historical role may instead name what founds it
  where that is written: `historicalRole Graduate specializes Person
  derivedFrom Person.graduatedIn`. The lasting participation has the rigid
  `Person` as its source; whether that person was a student at the time is a
  separate temporal claim. The clause names a
  `@participation`, `@creation` or `@termination` -- several, for a
  disjunction -- or an event type, standing for the one such relation into it
  or an event type above it that could be meant, read for the type named. The
  role is then defined by it:

  ```turtle
  :Graduate owl:equivalentClass [ a owl:Class ; owl:intersectionOf (
      :Person
      [ a owl:Restriction ; owl:onProperty :Person.graduatedIn ; owl:someValuesFrom :Graduation ] ) ] .
  ```

  The intersection is with the role's direct supertypes, and the filler is
  the event type named, which may be narrower than the relation's own --
  `derivedFrom BirthInBrazil` over a creation written into `Birth`. This is
  the one equivalence over a relation that is safe in a graph that only
  grows: a role defined by its relator would go on classifying a former
  student as a student, since the ended enrollment stays in the graph, while a
  historical role's members grow exactly as the events it is derived from do.
  `gufo-no-counterpart` says so on the role. With the snapshot layer, the
  founding shape of section 18.1 checks the derived relations too.
- **Why it is sound.** An instance is founded whenever it is one, so at
  some time (section 3). A historical role never lapses, and an event's
  participants never change. `someValuesFrom` and `unionOf` ask nothing of
  the property's simplicity, so the condition fits OWL 2 DL whatever else is
  written about it. A disjunct that could not be written would make the rest
  too strong, so then nothing is written.

The checks agree with this. `role-without-relator` and
`historical-role-without-event` count the same founding relations -- the
latter a derivation as well -- what a derivation names is checked by
`class-derivation-not-historical`, `historical-derivation-not-founding`,
`historical-derivation-participant-disjoint` and
`historical-derivation-ambiguous`, and
`founding-relation-optional` asks a class founded by one optional relation to
make it mandatory. With several founding relations each may stay optional:
only one of them has to hold.

### 10.2 Participation, carried up event parthood

In UFO-B, whoever takes part in part of an event takes part in the event,
and a participational portion is the whole of one participant's part in it:
one portion per participant, so distinct portions have distinct
participants. OWL cannot derive the first for individuals. The chain
`gufo:participatedIn ∘ gufo:isEventProperPartOf ⊑ gufo:participatedIn`, or
one into any property below it, makes `gufo:participatedIn` non-simple, and
gUFO itself restricts it with `gufo:Participation ⊑ =1 [ owl:inverseOf
gufo:participatedIn ].gufo:Object`, which OWL 2 DL allows only on a simple
property (section 9.2). What follows for the classes can be written, on
`gufo:participatedIn` itself, so that no model property has to be picked as
the one meant:

- **Upward.** A participant class that must take part in an event that must
  be part of a whole took part in the whole, up every mandatory step of event
  parthood: `C ⊑ ∃ gufo:participatedIn.W`. Skipped where a mandatory
  participation of `C` already reaches `W` or something narrower.
- **Counted.** A whole with at least `n` participational portions, each of
  which must have an `X` taking part, has at least `n` participants that are
  `X`s: `W ⊑ ≥n [ owl:inverseOf gufo:participatedIn ].X`. A portion has
  exactly one participant, so every such `X` is that one's type, and the
  narrowest are written. Only `@participational` says the portions are one
  per participant; other parthoods get the upward restriction and no count.

```turtle
:Meeting rdfs:subClassOf [ a owl:Restriction ;
    owl:onProperty [ owl:inverseOf gufo:participatedIn ] ;
    owl:onClass :Person ; owl:minQualifiedCardinality 2 ] .
:Attendee rdfs:subClassOf [ a owl:Restriction ;
    owl:onProperty gufo:participatedIn ; owl:someValuesFrom :Meeting ] .
```

Only participations aligned to `gufo:participatedIn` count (section 9.5).
Both restrictions keep `gufo:participatedIn` simple. No check compares a
whole's portions with a whole-level participation the model also declares:
`Person [0..1] -- chaired -- Meeting` is a participation too, and a meeting
with many attendees and one chair contradicts nothing.

## 11. Documentation

Read from the `///` documentation only (`documentation/doc-comment.ts`).
A run documents the outermost declaration beginning on the line below it:
`enum Color { Red, Green }` written on one line under `/// @label Color`
labels the enumeration, and its literals keep their own names.
The legacy `label { }` and `description { }` blocks are never exported: each
classifier that has them is reported as `gufo-legacy-text-ignored`, and
`tonto check --fix=legacy-text-block` rewrites them as `///` documentation,
which is. Attach labels and comments to the RDF resource of the documented
declaration -- a class, a property (including a minted one), a datatype,
an enumeration or a literal. Generalization-set axioms are anonymous, so
documentation on a set is omitted (`gufo-no-counterpart`). A package has no
RDF resource of its own: only the `ontology` header supplies the ontology
header (`<https://example.org/shop> rdfs:comment …`, and its `@label`s as
`rdfs:label`; the ontology name is not added as a label). Package prose and
labels describe the packages, not the ontology.

Three more tags on the header describe the ontology, one line each:

```tonto
/// Who buys what.
/// @label Sales
/// @version 1.2.0
/// @license https://creativecommons.org/licenses/by/4.0/
/// @creator Ana Silva
/// @creator Bruno Costa
ontology sales
```

| tonto | Ontology header |
|---|---|
| `@label` | `rdfs:label` and `dcterms:title` |
| prose | `rdfs:comment` and `dcterms:description` |
| `@version` | `owl:versionInfo` |
| `@license` | `dcterms:license`, an IRI where the value is one and a literal otherwise |
| `@creator` | `dcterms:creator`, one per line, sorted |
| (the export's own choice) | `vann:preferredNamespacePrefix` and `vann:preferredNamespaceUri` |

The Dublin Core terms repeat what the RDFS ones say because catalogs and
quality checks read them -- ROBOT's report asks for `dcterms:title`,
`dcterms:description` and `dcterms:license` -- and the VANN terms say which
prefix and namespace the export chose, so that whoever loads the ontology
writes the same names. They are declared `owl:AnnotationProperty`, at the end
of the file, since OWL 2 DL has no annotation property it was not told of.
No `owl:versionIRI` is invented from the version: an IRI promises a document
at that address. Only the ontology header gives these: on a package, or any
other declaration, they are ignored with `ontology-tag-not-on-header`, whose
repair moves them to the header. A second `@version` or `@license` is
`duplicate-ontology-tag`.
`duplicate-doc-language` is an
error, so export never sees two writings in one language; the parser
keeps the first.

| tonto | RDF |
|---|---|
| untagged `///` prose (`text`) | `rdfs:comment "..."` with no language tag |
| `@<lang>` prose (`descriptions[lang]`) | `rdfs:comment "..."@lang` |
| `@label` (`labels['']`) | `rdfs:label "..."` |
| `@label:<lang>` | `rdfs:label "..."@lang` |
| no `@label` in any language | the declared name, `rdfs:label "<name>"`, untagged |

The declared name is a fallback, not a companion: a declaration documented
with `@label:pt-br Pessoa` and no other label is labeled `"Pessoa"@pt-br`
alone. Write `@label Person` as well to have both. An unnamed relation's minted
member name (section 9.1) is its property's label, as a declared member name
is: `rdfs:label "Car.hasComponentWheel"`. The owner remains in the IRI, not the
fallback label. The label is what a tool that shows terms -- or ROBOT's report,
which asks for one on every term -- would otherwise find missing.

**Every term the export mints is `rdfs:isDefinedBy` the ontology** -- each
class, datatype, enumeration, literal and property, named or minted:
`sales:Person rdfs:isDefinedBy <https://example.org/shop>`. A hash
namespace's ontology is the namespace less its `#`, which a client can guess,
but a slash namespace's term is a document of its own, and the guess
`https://w3id.org/terms` for `https://w3id.org/terms/Person` is only a guess;
this says it. Terms the export only refers to -- gUFO's, XSD's -- are
defined elsewhere and get none; the ontology header gets none either.
`rdfs:isDefinedBy` is an OWL 2 annotation property, so it changes nothing a
reasoner concludes. Nothing is tagged `@en` unless the model tagged it. The
earlier exporter tagged every identifier `@en`; this mapping emits a language
tag only when the model supplies one.

Every non-empty language tag, including one read from a legacy block or an
`@label:<lang>` qualifier, must be a well-formed BCP 47 tag. The documentation
parser deliberately accepts more than that in label qualifiers, so this is an
export-time check: `gufo-invalid-language-tag` stops export rather than
guessing a replacement or emitting invalid Turtle. Labels and comments are
passed as RDF literal values to the serializer; quotes, backslashes, newlines
and control characters are escaped by the serializer, never by interpolating
source text into Turtle.

## 12. What the exporter reports

Diagnostics in `tonto check`'s shape (`code`, severity, message, position) and
under `--json`, so tools that read one read the other.

| Code | Severity | When |
|---|---|---|
| `gufo-model-has-errors` | error | the model has errors; nothing is written |
| `gufo-invalid-namespace-iri` | error | the exact ontology namespace supplied by the caller is malformed |
| `gufo-namespace-iri-ambiguous` | error | a supplied namespace cannot go to exactly one exported ontology whose header has none |
| `gufo-ontology-collision` | error | namespace bases or a term IRI would collide with ontology identities (section 4) |
| `gufo-iri-collision` | error | two elements would get one IRI (section 4) |
| `gufo-invalid-language-tag` | error | documentation uses a language tag that cannot be serialized as an RDF language tag |
| `gufo-legacy-text-ignored` | information | a classifier's `label { }` or `description { }` block is not exported (section 11) |
| `gufo-placeholder-namespace` | warning | an ontology's header gives no namespace and none was supplied, so a placeholder is used (section 4) |
| `gufo-alignment-dropped` | information | a gUFO super-property or superclass left out by the guard (sections 7, 8.2, 9.5) |
| `gufo-upper-bound-not-expressible` | information | a finite upper bound withheld (section 10) |
| `gufo-disjointness-not-expressible` | information | a pair in a `disjoint` set can hold at different times under the accumulated reading (section 6) |
| `gufo-datatype-specialization-not-expressible` | information | a specialization among literal datatypes or to a built-in datatype is omitted (section 5.3) |
| `gufo-derivation-chain-withheld` | information | a material relation's derivation is not written as a property chain, and why (section 9.2) |
| `gufo-snapshot-bound-withheld` | information | the snapshot layer omits an upper bound on a property a chain implies (section 18) |
| `gufo-reverse-data-end-not-expressible` | information | the inverse/source end of a data-property relation is omitted (sections 9.1, 10) |
| `gufo-no-counterpart` | information | something gUFO and OWL cannot say: `@change`, `historical`, the distinction among event-parthood stereotypes, `isPowerType` beyond the model's own classes, `ordered`, `derived`, `redefines`, `disjoint`/`complete` over relations, anti-rigidity over processes, a named `@instantiation`, documentation on a generalization set, a relation whose source is a literal |

Information-level diagnostics are one per element and code, so a large model
gets a list of what was not said, not a flood.

## 13. A worked example

This model validates with no diagnostics from `tonto check`. Export reports
`gufo-upper-bound-not-expressible` on the mutable `name`, the four wheels and
each exclusive whole end, and `gufo-disjointness-not-expressible` on Young
and Old. The Turtle below is still what is written. The exporter does not
repeat gUFO's declaration of `xsd:date`.

```tonto
/// @namespace https://example.org/shop#
ontology sales

/// Someone who buys, or could.
/// @label:pt-br Pessoa
kind Person {
    name: string
    @begin bornOn: const date
}
kind Product
role Customer specializes Person

phase Young specializes Person
phase Old specializes Person
disjoint complete genset AgePhases where Young, Old specializes Person

relator Purchase {
    @mediation [1..*] -- [1] (const) Customer
    @mediation [0..*] -- [1] (const) Product
}

kind Car {
    @componenthood [1] <>-- [1] (const engine) Engine
    @componenthood [1] <>-- [4] (wheels) Wheel
}
kind Engine
kind Wheel
```

It exports as the one ontology `https://example.org/shop`, its namespace
without the `#`, as follows, less its two comment lines and the prefix
declarations for `owl`, `rdfs` and `xsd`. HermiT finds it
consistent with canonical gUFO 1.0.0 and a small data set, and infers `:e1
gufo:isComponentOf :beetle` from
`:beetle :Car.hasComponentEngine :e1`. Profile testing records gUFO's
existing `xsd:date` use as the documented datatype-map exception rather than
claiming strict OWL 2 DL conformance for the import closure.

```turtle
@prefix gufo: <http://purl.org/nemo/gufo#> .
@prefix vann: <http://purl.org/vocab/vann/> .
@prefix sales: <https://example.org/shop#> .

<https://example.org/shop> a owl:Ontology ;
    owl:imports <http://purl.org/nemo/gufo#> ;
    vann:preferredNamespacePrefix "sales" ;
    vann:preferredNamespaceUri "https://example.org/shop#" .

sales:Person a owl:Class, gufo:Kind ;
    rdfs:label "Pessoa"@pt-br ;
    rdfs:comment "Someone who buys, or could." ;
    rdfs:isDefinedBy <https://example.org/shop> ;
    rdfs:subClassOf
        gufo:FunctionalComplex,
        [ a owl:Restriction ;
          owl:onProperty sales:Person.name ;
          owl:minCardinality "1"^^xsd:nonNegativeInteger ],
        [ a owl:Restriction ;
          owl:onProperty sales:Person.bornOn ;
          owl:cardinality "1"^^xsd:nonNegativeInteger ] ;
    owl:equivalentClass [ a owl:Class ; owl:unionOf ( sales:Old sales:Young ) ] .

sales:Product a owl:Class, gufo:Kind ;
    rdfs:label "Product" ;
    rdfs:isDefinedBy <https://example.org/shop> ;
    rdfs:subClassOf gufo:FunctionalComplex .

sales:Customer a owl:Class, gufo:Role ;
    rdfs:label "Customer" ;
    rdfs:isDefinedBy <https://example.org/shop> ;
    rdfs:subClassOf
        sales:Person,
        [ a owl:Restriction ;
          owl:onProperty [ owl:inverseOf sales:Purchase.mediatesCustomer ] ;
          owl:someValuesFrom sales:Purchase ] .

sales:Young a owl:Class, gufo:Phase ;
    rdfs:label "Young" ;
    rdfs:isDefinedBy <https://example.org/shop> ;
    rdfs:subClassOf sales:Person .

sales:Old a owl:Class, gufo:Phase ;
    rdfs:label "Old" ;
    rdfs:isDefinedBy <https://example.org/shop> ;
    rdfs:subClassOf sales:Person .

sales:Purchase a owl:Class, gufo:Kind ;
    rdfs:label "Purchase" ;
    rdfs:isDefinedBy <https://example.org/shop> ;
    rdfs:subClassOf
        gufo:Relator,
        [ a owl:Restriction ;
          owl:onProperty sales:Purchase.mediatesCustomer ;
          owl:onClass sales:Customer ;
          owl:qualifiedCardinality "1"^^xsd:nonNegativeInteger ],
        [ a owl:Restriction ;
          owl:onProperty sales:Purchase.mediatesProduct ;
          owl:onClass sales:Product ;
          owl:qualifiedCardinality "1"^^xsd:nonNegativeInteger ] .

sales:Car a owl:Class, gufo:Kind ;
    rdfs:label "Car" ;
    rdfs:isDefinedBy <https://example.org/shop> ;
    rdfs:subClassOf
        gufo:FunctionalComplex,
        [ a owl:Restriction ;
          owl:onProperty sales:Car.hasComponentEngine ;
          owl:onClass sales:Engine ;
          owl:qualifiedCardinality "1"^^xsd:nonNegativeInteger ],
        [ a owl:Restriction ;
          owl:onProperty sales:Car.hasComponentWheel ;
          owl:onClass sales:Wheel ;
          owl:minQualifiedCardinality "4"^^xsd:nonNegativeInteger ] .

sales:Engine a owl:Class, gufo:Kind ;
    rdfs:label "Engine" ;
    rdfs:isDefinedBy <https://example.org/shop> ;
    rdfs:subClassOf
        gufo:FunctionalComplex,
        [ a owl:Restriction ;
          owl:onProperty [ owl:inverseOf sales:Car.hasComponentEngine ] ;
          owl:someValuesFrom sales:Car ] .

sales:Wheel a owl:Class, gufo:Kind ;
    rdfs:label "Wheel" ;
    rdfs:isDefinedBy <https://example.org/shop> ;
    rdfs:subClassOf
        gufo:FunctionalComplex,
        [ a owl:Restriction ;
          owl:onProperty [ owl:inverseOf sales:Car.hasComponentWheel ] ;
          owl:someValuesFrom sales:Car ] .

sales:Person.name a owl:DatatypeProperty ;
    rdfs:label "name" ;
    rdfs:isDefinedBy <https://example.org/shop> ;
    rdfs:domain sales:Person ;
    rdfs:range xsd:string ;
    rdfs:subPropertyOf gufo:hasQualityValue .

sales:Person.bornOn a owl:DatatypeProperty, owl:FunctionalProperty ;
    rdfs:label "bornOn" ;
    rdfs:isDefinedBy <https://example.org/shop> ;
    rdfs:domain sales:Person ;
    rdfs:range xsd:date ;
    rdfs:subPropertyOf gufo:hasBeginPointInXSDDate .

sales:Purchase.mediatesCustomer a owl:ObjectProperty, owl:FunctionalProperty ;
    rdfs:label "Purchase.mediatesCustomer" ;
    rdfs:isDefinedBy <https://example.org/shop> ;
    rdfs:domain sales:Purchase ;
    rdfs:range sales:Customer ;
    rdfs:subPropertyOf gufo:mediates .

sales:Purchase.mediatesProduct a owl:ObjectProperty, owl:FunctionalProperty ;
    rdfs:label "Purchase.mediatesProduct" ;
    rdfs:isDefinedBy <https://example.org/shop> ;
    rdfs:domain sales:Purchase ;
    rdfs:range sales:Product ;
    rdfs:subPropertyOf gufo:mediates .

sales:Car.hasComponentEngine a owl:ObjectProperty, owl:FunctionalProperty ;
    rdfs:label "Car.hasComponentEngine" ;
    rdfs:isDefinedBy <https://example.org/shop> ;
    rdfs:domain sales:Car ;
    rdfs:range sales:Engine ;
    rdfs:subPropertyOf [ owl:inverseOf gufo:isComponentOf ] .

sales:Car.hasComponentWheel a owl:ObjectProperty ;
    rdfs:label "Car.hasComponentWheel" ;
    rdfs:isDefinedBy <https://example.org/shop> ;
    rdfs:domain sales:Car ;
    rdfs:range sales:Wheel ;
    rdfs:subPropertyOf [ owl:inverseOf gufo:isComponentOf ] .

[] a owl:AllDisjointClasses ;
    owl:members ( sales:Car sales:Engine sales:Person sales:Product sales:Purchase sales:Wheel ) .

vann:preferredNamespacePrefix a owl:AnnotationProperty .

vann:preferredNamespaceUri a owl:AnnotationProperty .
```

Read against the rules:

- `Customer`, `Young` and `Old` get no gUFO superclass, since `Person`
  already entails theirs (5.2). The phases are not disjoint, since they are
  anti-rigid (6), but they are complete.
- `Purchase` gets exact bounds of one. The ends are `const`, the owner is a
  relator and therefore rigid, and the bound is `[1]` (10). The `[1..*]` at
  the relator end gives `Customer` its relational condition -- some purchase
  mediates every customer, the gUFO paper's Listing 20 -- and the `[0..*]`
  at `Product` says nothing. Written `[0..*]`, the condition would be the
  same, since the stereotype implies it (10.1), and `tonto check` would ask
  for `[1..*]` (`founding-relation-optional`).
- `Car.hasComponentEngine` gets exactly one because the part end is `const`
  and `Car` is rigid: an essential part. The end name `engine` produces no
  property. The four wheels get a minimum only, because their end is mutable
  (`gufo-upper-bound-not-expressible`); the plural end name `wheels` likewise
  produces no property and does not alter `Car.hasComponentWheel`. The whole
  ends, `[1]`, give each engine and each wheel some car --
  `owl:someValuesFrom`, because after the upper bound is withheld the
  restriction written is lower 1 with no max (section 10). The upper bound
  there -- that a part is not shared -- is withheld for the same reason.
- `Person.name` is `[1]` but mutable, so a minimum. `Person.bornOn` is
  `const` on a kind, so exactly one.
- Where exactly one is written -- `Person.bornOn`, the two mediations,
  `Car.hasComponentEngine` -- the property is declared `owl:FunctionalProperty`
  (10). `Person.name` and `Car.hasComponentWheel`, whose upper bounds are withheld,
  are not.

## 14. Observed differences from the earlier gUFO pipeline

The earlier behavior below was observed by running `transform` from
`tonto-cli` 0.4.14 with ontouml-js at
`matheuslenke/ontouml-js#feature/include-types-in-build`. TA identifies the
tonto → ontouml-js step; OG identifies the ontouml-js → gUFO step. The table
records output differences relevant to this mapping, not a judgment of the
earlier language as a whole.

| Earlier pipeline output | Stage | Current mapping |
|---|---|---|
| The parthood diamond was interpreted with the opposite orientation; using `@memberOf` could yield an inconsistent graph | TA | 9.3 |
| An unstereotyped `<>--` had no `gufo:isProperPartOf` alignment | TA | 9.2, natures decide |
| Event-to-endurant `@participation` could type the event as `gufo:Object` | Model direction | tonto's table sets substantial → perdurant; 9.5 guards the mapping |
| Immutability implied by mediation, characterization, or external dependence did not contribute cardinality axioms unless written | TA | 10, effective immutability |
| `[2] (const)` emitted a lower bound of 2 without its upper bound | OG | 10, the opposite end supplies the bound |
| A comparison of `stereotype[0]` with `"kind"` emitted no kind-disjointness axiom | OG | 6, one axiom over all ultimate sortals |
| Enumeration literals received `rdf:label "[object Object]"` | OG | 5.3 |
| `«type»`, `«powertype»`, and unstereotyped classes lacked `owl:Class` | OG | 5, every class is one |
| Generalization-set categorizers did not appear in the output | OG | 6 |
| `mixin ... of <natures>` mapped each mixin to `FunctionalComplex` | TA | 5.2, possible natures |
| `historicalRoleMixin` mapped to `gufo:Role`, a sortal | OG | 5.1 |
| Attribute multiplicities did not appear in the output | OG | 10 |
| `number` mapped to an undeclared `:number` | OG | 8.1 |
| Terms shared one namespace; name clashes received `_1` suffixes in sort order | OG | 4 |
| Every label received `@en` | OG | 11 |
| The base IRI was `https://example.com`; transformer issues did not reach the output | TA | 4, 12 |
| The CLI wrote `<outFolder>/<projectName>` without an extension | CLI | 16 |

## 15. Possible mapping refinements

The mapping above states the current behavior. These are possible changes to
the language or to an optional gUFO output mode; none is required to use the
current export.

1. **Processes.** gUFO 1.0 has no processes, and its `ConcreteIndividual` is
   the disjoint union of `Endurant`, `Event` and `Situation`, so a process
   must be one of the three or fall outside gUFO altogether. The default
   maps processes to `gufo:Event`: gUFO's only perdurant, whose
   participation, creation and triggering properties then apply. The cost is
   that the export says a process is an event, which the language denies.
   The alternative is a local `Process` class outside gUFO's individuals,
   which loses every gUFO property that touches a perdurant.
2. **High-order types as endurants.** Section 7 sides with gUFO. If the
   language's position matters to the ontology's consumers, the alternative
   is a local extension, which then cannot import gUFO unchanged.
3. **Temporal reification.** Section 3 exports the atemporal reading.
   gUFO's qualified situations can say more: a mutable relation as a
   `TemporaryRelationshipSituation`, a phase as a
   `TemporaryInstantiationSituation`. That would be a second mode
   (`--temporal`), not a change to this one. The snapshot layer (section
   18) is the other direction, and settled: a module beside each ontology
   rather than a mode, so that the ontologies stay the same whichever
   layers are written.
4. **`datetime`.** `xsd:dateTime` in general and `xsd:dateTimeStamp` on time
   points (8.3). Or `xsd:dateTimeStamp` everywhere, which requires a time
   zone on every value.
5. **Datatypes without attributes.** A component that section 5.3 does not
   force to be reified is defined as equivalent to `rdfs:Literal`, because an
   undefined custom datatype is not legal OWL 2 DL and the model supplies no
   narrower value space. `datatype Money` is as likely an unfinished
   structured datatype as a primitive one, and the language does not
   distinguish the two. An explicit `primitive` or `reified` modifier -- and,
   for a primitive, its base datatype or facets -- would remove this inference
   and turn a mistaken choice into a validation diagnostic.
## 16. Implementation and verification

This section records the implemented API and the checks that guard the
mapping. The verification cases are regression requirements for changes to
the exporter.

- **API and output.** `packages/language/src/gufo.ts` serves the CLI, API,
  editor, and MCP tool. The result includes `{ turtle, files, diagnostics }`
  -- `files` holding one
  `{ ontology, file, turtle, snapshot, shapes }` per ontology, and `turtle` the one
  document when there is only one -- exposed as `tonto gufo [paths...]
  [--namespace-iri=<iri>]
  [--write | --out=<file> | --out-dir=<dir>] [--json]
  [--direct-specializations] [--snapshot]` (sections 17 and 18) with the workspace options of
  `tonto check` (`--workspace`, `--isolated`, and `-` for stdin). Without
  `--out`, one ontology's Turtle goes to stdout and human-readable
  diagnostics to stderr. `--write` writes each ontology atomically beside
  its ontology file, where the editor's export writes it. `--out` writes the named file atomically (write a
  sibling then rename; normally with a `.ttl` suffix). Several ontologies
  need `--write` or `--out-dir`, which writes each atomically. Each file is named after
  its ontology: `sales` becomes `sales.ttl`, wherever its namespace is, and
  however many packages it has. Equal filenames
  receive deterministic `-2`, `-3` suffixes. Without `--out-dir`, the command
  writes nothing and fails, rather than concatenate documents.
  `--json` never mixes JSON
  and Turtle on stdout: without `--out` or `--out-dir` its result contains
  `{ turtle, files, diagnostics }`; with either it contains the output paths
  and diagnostics. Exit status is
  1 if any diagnostic is an error, 0 otherwise -- information and
  `gufo-placeholder-namespace` do not fail the command. The MCP tool is
  `tonto_gufo` and returns the same structured result. With file paths,
  `write` writes every generated `.ttl` file atomically beside its ontology
  file and a workspace-relative `outDir` under that directory; without either
  it is read-only.
  Draft `source` cannot be written, and the output directory cannot leave the
  configured workspace. The repository pins
  gUFO 1.0.0 as `packages/language/test/fixtures/gufo-1.0.0.ttl`; its adjacent
  XML catalog resolves `owl:imports` against that copy for conformance runs,
  never against the live PURL.
- **Reuse the language's reasoning.** The mapping calls existing helpers for
  possible natures, relation ends, disjointness, and stereotype rigidity.
  `gufo.ts` defines the gUFO-specific tests for effective immutability,
  lifetime-wide membership, and membership that never lapses. Changes to
  these tests must stay consistent with the validation rules described in
  sections 6 and 10. Model properties do not inherit gUFO's transitivity or
  functionality merely through alignment.
- **Tests.**
  - Every pattern in `tonto patterns` exports without error, and the result
    merged with a pinned gUFO 1.0.0 is consistent under HermiT (ROBOT
    `reason`). Run `validate-profile --profile DL` too and allow only the
    explicitly identified datatype-map exceptions: gUFO's existing
    `xsd:date`, and `xsd:time` when the model uses it. Assert that every
    exported named class is satisfiable as well: ontology consistency alone
    permits an accidental `owl:Nothing` subclass. This is an allowlist of
    exact findings, not a blanket suppression. Each pattern is exported from
    a documented, licensed package, and ROBOT's `report` must find no error
    in it: labels, the ontology's title, description and license. Its
    warnings are OBO conventions -- an IAO definition on every term -- that a
    gUFO model does not follow. The run needs Java and belongs in a separate
    CI job, not in `vitest`.
  - Golden Turtle for section 13 and for one model per row of the tables in
    sections 5, 8 and 9.
  - Naming cases for every directional pair in section 9.1, in both
    orientations where tonto admits both. Renaming an end, with any tonto
    references to it updated, must leave the RDF unchanged. Two unnamed
    relations with the same source, stem and target must report
    `gufo-iri-collision` until one is explicitly named.
  - One regression per row of section 14.
  - Instance-level checks that direction survives: a component inferred
    `gufo:isComponentOf` its whole, a member inferred into its collection,
    a participant inferred a `gufo:Object`.
  - Boundary cases for mixed rigid/anti-rigid disjoint sets, historical-role
    pairs, datatype specialization components (including a literal component
    with a legal `rdfs:Literal` definition), data-relation reverse ends,
    process and high-order guards, `category of types` (must not be a
    `gufo:Category`), unstereotyped `--` versus `<>--`, a named
    `@instantiation` that mints no property, degenerate
    `AllDisjointClasses` / `AllDifferent` / `unionOf` (skip below two
    members), and identifiers containing every special character accepted
    by the grammar -- including non-ASCII letters, which must come out
    unescaped, and U+FFF0–U+FFFD, which must not.
  - A base IRI with and without a trailing `/`: identical namespaces, and no
    `//` in either.
  - Parse the emitted Turtle independently, load it through OWLAPI, and
    export the same workspace twice byte-for-byte. A golden string alone can
    preserve invalid RDF just as faithfully as valid RDF.

## 17. gUFO shapes

[gUFO shapes](https://github.com/nemo-ufes/gufoshapes) are SHACL constraints on
the use of gUFO that OWL cannot state. They read asserted triples: their
paths are direct `rdfs:subClassOf`, their SPARQL uses `rdfs:subClassOf`
without `+`, and `CategorizationShape` targets written `gufo:categorizes`
subjects only. This section says, shape by shape, what the export guarantees
for a model with no errors, and why. It was established against the seven
shapes of the repository at `b95e14b`, and checked with pySHACL 0.40.1 over
the export of every pattern and of a counterexample for each case below.

| Shape | Holds by construction? |
|---|---|
| `RigidOrSemiRigidShape` | Yes. A class is typed `gufo:Kind`, `SubKind`, `Category` or `Mixin` only when its natures are all substantial or aspect ones (5.1). A direct supertype typed `Role`, `Phase`, `RoleMixin` or `PhaseMixin` is an anti-rigid stereotype, which `stereotype-cannot-specialize` refuses. The gUFO classes of 5.2 are typed only `owl:Class`, so a nature superclass never matches. |
| `NonSortalShape` | Yes, by the same errors: a non-sortal does not specialize a sortal. |
| `BaseSortalShape` | Only with RDFS inference, or with `directSpecializations` (below). A `class` between a base sortal and its kind is typed `gufo:EndurantType`, so the base sortal's own `rdfs:subClassOf` reaches no gUFO sortal. |
| `KindShape` | Yes. Only an ultimate sortal is typed `gufo:Kind`, and it specializes no sortal; a `class` in between is not one the shape lists. |
| `EndurantTypeShape` | Yes. An endurant type's natures are substantial or aspect ones, so its gUFO superclasses are too; the export never writes `rdfs:subClassOf gufo:Event`, `gufo:Situation` or the others on it. |
| `CategorizationShape` | Only with RDFS inference, or with `directSpecializations`: `instance-not-specializing-base` accepts an instance that specializes the base through another class, and the shape wants the triple itself. A set of relations, whose instances would have no `rdfs:subClassOf` at all, cannot have a categorizer (below). |
| `PartitionPairwiseDisjointnessShape` | Not for anti-rigid instances, nor for instances the model leaves undeclared (below). Every other pair is written. |

**Pair-level disjointness.** The instances of a type written with
`gufo:partitions` -- from a `disjoint complete` set with a categorizer, or an
`@instantiation` whose higher end is `[1]` -- are stated disjoint pair by
pair wherever `cannotShareInstances` proves it and section 3 lets it be
written: disjoint through their lineage (`Man` and `Woman` under disjoint
`Male` and `Female`), through different ultimate sortals, or through
natures with nothing in common. When every pair of the instances is, they
are one `owl:AllDisjointClasses`, whose membership has no direction.
Otherwise each such pair gets `owl:disjointWith` in both directions, because
the shape asks for each ordered pair and `owl:disjointWith` is symmetric
only to a reasoner. A pair already in one `owl:AllDisjointClasses` needs
nothing more. None of
this adds meaning; it states for the pair what the model already entails.

**`directSpecializations`, off by default.** `tonto gufo
--direct-specializations`, the `directSpecializations` option of
`gufoText`/`gufoFiles` and of the MCP tool, and the editor setting
`tonto.gufo.directSpecializations` add the two kinds of triple the shapes
read without inference: a base sortal (typed `SubKind`, `Phase` or `Role`)
whose direct supertypes include no gUFO sortal gets `rdfs:subClassOf` its
nearest ancestors typed `Kind`, `SubKind`, `Phase` or `Role`; and an instance
of a categorizer that specializes the categorized base only through another
class gets `rdfs:subClassOf` the base. Both are entailed by triples already
written, which is why they are not written by default: they exist only for a
validator that does not reason.

**Decided: a set of relations has no categorizer.** The smallest model that
would have failed `CategorizationShape` whatever the reasoning:

```tonto
package p
kind Person
relation Person [*] -- owns -- [*] Person
relation Person [*] -- leases -- [*] Person specializes Person.owns
type Tenure
genset byTenure {
    general Person.owns
    categorizer Tenure
    specifics Person.leases
}
```

It would export `p:leases a p:Tenure ; rdfs:subPropertyOf p:owns` and
`p:Tenure gufo:categorizes p:owns`, and the shape asks for
`p:leases rdfs:subClassOf p:owns`, which a property does not have. The
language refuses the model instead (`categorizer-on-relation-set`, repaired
by removing the categorizer), so no export reaches the shape with one.

**Decided: anti-rigid partitions stay undeclared.** A phase partition with a
categorizer -- `AgeGroup` partitioning `Person` over `Child` and `Adult` --
exports `gufo:partitions` and no disjointness between the phases, and fails
`PartitionPairwiseDisjointnessShape`. Section 3 reads membership as "at some
time", and a person is a child at one time and an adult at another, so
`Child owl:disjointWith Adult` would be false of every adult. The shape's
disjointness is a claim about each moment, which an atemporal OWL export
cannot make soundly. The export keeps the partition and withholds the pair,
knowing the shape will report it.

**Decided: undeclared instances stay undeclared.** When a partitioning type's
instances are not disjoint in the model -- `partition-instances-not-disjoint`
is a warning, so the model still exports -- the export does not invent the
disjointness to satisfy the shape. The shape's report says what the warning
said: the model asserts a partition it has not made disjoint.

## 18. The snapshot layer

The reading of section 3 -- whatever a triple says held at some time --
is what makes every exported ontology true of any graph that only grows. It
is also why some of what the model says is withheld: a person with one
employer at a time may have had two over a life, and a child becomes an
adult. At any one instant those constraints hold. A graph that describes the
world at one instant -- current classification, current links, current
values, and nothing that has stopped being true -- may have them.

`--snapshot` (the `snapshot` option of the API and of `tonto_gufo`; in VS Code
the **Export to gUFO with Snapshot Layer...** command, or the
`tonto.gufo.snapshot` setting for every export) writes them, as a **layer** rather
than a mode -- an OWL module, and SHACL shapes that check a graph against it
(section 18.1):

- **One module per ontology.** `sales.ttl` gets `sales.snapshot.ttl`,
  ontology `<…/sales-snapshot>` -- no tonto name has a hyphen, so no term or
  package ontology is called that -- which imports `<…/sales>` and the other
  ontologies whose terms it mentions. Every module retains its ontology's
  ownership boundary; there is no implicit aggregate module.
- **The ontologies are unchanged.** They come out byte for byte the same
  with the layer or without it; the conformance run checks so. A graph that
  only grows keeps the ontologies and leaves the modules out.
- **Only what section 3 withholds**, each in the module of the package that
  declares it:

  | Withheld by section 3 | The snapshot module writes |
  |---|---|
  | an upper bound that is not lifetime-wide (section 10) | the `max` restriction, and `owl:FunctionalProperty` -- `owl:InverseFunctionalProperty` from a source end -- where it is one |
  | disjointness in a `disjoint` set whose members can alternate over a life (section 6) | `owl:AllDisjointClasses` over the set |
  | disjointness among the instances of a partitioning type, for the same reason (section 7) | the same, for those pairs |
  | a redefinition's narrowed type, where the owner can lapse (section 9.6) | its `owl:allValuesFrom` restriction |

  The layer adds a `max` and never rewrites the ontology's `min` into an exact
  count; the two combine through the import. The notes that report each
  withheld axiom say that the layer states it.
- **A chain wins.** A material relation's chain (section 9.2) makes its
  property non-simple, and the properties above it, and OWL 2 DL allows no
  cardinality restriction or functional characteristic on one. The ontology
  keeps its chain whatever layers are written, so the module leaves that
  bound out and says so (`gufo-snapshot-bound-withheld`).
- **The header** names the module after its ontology with "(snapshot)",
  says in a comment what the layer is, and repeats the ontology's version,
  license and creators.

With the worked example of section 13, the module says that no person has
two names, no engine and no wheel is in two cars, no car has more than four
wheels, and nobody is young and old at once -- each at any one instant.

**What a snapshot graph is.** The world at one instant: an endurant's
current classification, links and values; not a relator that has ended, nor
an endurant that has been terminated. Some things are never retracted and so
stay: the events that happened, historical roles, and links that are `const`.
This is what a projection of an event log computes (gUFOevents' `07-snapshot`
query), so a projection is a snapshot graph and the layer is its schema.

### 18.1 Shapes

An upper bound in OWL does not catch an error: with no unique-name
assumption, two employers under `max 1` are concluded to be one employer,
not reported, and a missing link is only an unknown one. Checking a snapshot
graph is SHACL's work, so the layer also writes a shapes graph beside each
ontology: `sales.shapes.ttl`, `<…/sales-shapes>`, its shapes named in
`<…/sales-shapes#>` (prefix `sales-shapes:`). Separate ontologies keep
separate shapes graphs; no aggregate graph is invented.

| The model says | The shapes check, of every instance at the instant the graph describes |
|---|---|
| a multiplicity at an end or on an attribute | `sh:minCount` and `sh:maxCount` on the owner's node shape -- every bound, including the ones the snapshot module leaves to a chain, since SHACL has no rule of simplicity |
| the class at an end | `sh:class`; for a built-in datatype, the literal datatypes its range admits (`number` takes `xsd:decimal` or `xsd:integer`, `datetime` `xsd:dateTime` or `xsd:dateTimeStamp`, and a time point only the latter), since `sh:datatype` compares the IRI exactly; nothing for a literal datatype of the model's own, which is all of `rdfs:Literal` (section 5.3) |
| a subsetting, redefining or specializing property | its values count toward the property above: the path is `sh:alternativePath` over the property and every property of the model below it, so that no inference is needed |
| a `disjoint complete` set | `sh:xone` over the specifics: exactly one |
| a `complete` set | `sh:or`: at least one |
| a `disjoint` set | `sh:xone` over the specifics and "none of them": at most one |
| a role founded by relations none of which is mandatory (section 10.1) | `sh:or` over them, each with `sh:minCount 1` |

A shape that checks a set or a founding says so in `sh:message`; a count or a
value is reported in the processor's own words, with `sh:name` naming the
property. Checking a subclass needs the class hierarchy: validate a graph
together with the ontologies, or with RDFS inference -- `pyshacl -s
sales.shapes.ttl -e sales.ttl -i rdfs data.ttl`.

With the worked example of section 13, a graph in which Ana has two names,
Bob no phase, a car five wheels, a wheel two cars, and a customer no purchase
is reported on each, and nowhere else.

What the shapes leave to the ontologies: the disjointness of ultimate
sortals, which a reasoner reports, and a material relation's derivation.

The conformance run exports every pattern with the layer as well: the module,
with what it imports, is OWL 2 DL, consistent, and leaves no class
unsatisfiable, and each shapes graph loads in pySHACL (when `PYSHACL` names
it). ROBOT's report is run on the ontologies and not on the modules, which
mention terms whose labels the ontologies hold.
