# From OWL and Protégé to tonto

If you use Protégé to author OWL ontologies, tonto gives you a different way
to author a conceptual model. You write `.tonto` source in an editor, and
the language checks choices about identity, dependence, change, and relations
as you work. You can share and import the tonto ontology itself. A
gUFO-aligned OWL export is available when another tool needs OWL.

This guide helps you decide what to write in tonto. For the complete syntax
and admissible combinations, open **Tonto: Open Language Guide** in VS Code or
run `npx tonto guide` from a source checkout.

## Begin with the domain question

An OWL class declaration does not say which tonto class stereotype fits. Ask
what its instances are and why they belong to the class:

| If you are modeling... | Ask in tonto... | A possible declaration |
|---|---|---|
| People as individuals with their own identity | Does the class supply their identity? | `kind Person` |
| People while they hold a job | Does a relationship found their membership? | `role Employee specializes Person` |
| The employment that binds an employee and an employer | Is the relationship itself an individual? | `relator Employment` |
| People during a stage of life | Is membership a temporary condition of the same individuals? | `phase YoungPerson specializes Person` |

These are questions about the domain, not a conversion table for OWL classes.
In particular, an OWL subclass axiom alone does not tell you whether its
specialization should be a `subkind`, `role`, or `phase`. The generated guide
explains each stereotype and the combinations tonto admits.

If you usually begin in Protégé by adding classes and object properties,
begin here by naming the individuals and relationships in the domain. Then
choose stereotypes and bounds that express what can change, what depends on
what, and what gives an individual its identity. Labels and descriptions go
in `///` documentation above a declaration, with `@label` for a display
name; the [language design notes](language-design.md#documentation-belongs-to-the-declaration)
show the form.

## Work through a relationship

Here is a one-file ontology. The `ontology` header declares what can be
shared and imported; the declarations follow it directly.

```tonto
/// People and their employment.
ontology people

/// A person, in the everyday sense.
kind Person

/// A person while employed by an organization.
role Employee specializes Person

/// An organization of people.
kind Organization

/// An organization while it employs people.
role Employer specializes Organization

/// The employment binding an employee and an employer.
relator Employment {
    @mediation [1..*] -- [1] (const) Employee
    @mediation [1..*] -- [1] (const) Employer
}

@material relation Employee [1..*] -- worksFor -- [1..*] Employer derivedFrom Employment
```

`Person` and `Organization` supply identity. `Employee` and `Employer` are
roles: the same person or organization can cease to play them. Each
`Employment` binds exactly one employee and one employer. The `[1]` beside
each role states how many participants one employment binds; `(const)` says
an existing employment cannot switch to another participant. The `[1..*]`
beside `Employment` states that each employee or employer participates in at
least one employment and may participate in several. It does not impose a
one-job limit.

The material relation `worksFor` says which employees and employers stand in
that relation; `derivedFrom Employment` names the relationship that grounds
it. When an OWL model starts with an object property, this is the additional
question tonto asks: *what makes the relation hold?* For a material relation,
the answer may be a relator such as `Employment`. The association and its
ends have distinct meanings and may each be named; see the
[language design notes](language-design.md#end-names-bounds-and-change).

To try another validated shape, run **Tonto: Insert Modeling Pattern...** in
the editor or `npx tonto patterns` in a source checkout. The
`role-and-relator` pattern is the shorter form of this example.

## Understand what is being checked

The tonto validator checks the model's syntax and ontological claims. For
example, it can report a role without a founding relationship or a relator
that mediates too few participants. Problems include a rule code, an
explanation, and, when a concrete repair is available, an edit. A repair
that requires a choice between interpretations remains yours to make.

This differs from checking a set of individual assertions. A `.tonto` model
declares types and relations; it is not an editor for an OWL ABox. OWL
reasoning over exported axioms and checking a graph of current data answer
different questions.

## Time and change

An ordinary OWL class assertion or object-property assertion has no time
attached to it: `:ana a :Employee` and `:ana :worksFor :acme` do not say
*when* either claim holds. OWL can describe change when events, situations,
or times are modeled explicitly, but it does not give changing class
membership or relationships a built-in temporal meaning.

The gUFO export therefore reads a class membership or link as holding
if it holds **at some time** during an individual's existence. A person can
be a child and later an adult, or work for different organizations in
succession. Under this reading, an OWL disjointness axiom for the two life
stages, or an upper bound intended to mean "one employer at a time," would
make a false claim about the person's whole life. The gUFO export omits such
axioms when they are not sound. A tonto bound still expresses the intended
constraint on the modeled relation; see the [mapping's account of time](gufo-mapping.md#3-the-reading-of-time)
and [multiplicities](gufo-mapping.md#10-multiplicities) for the precise rules.

gUFO also offers explicit [event](https://nemo-ufes.github.io/gufo/examples/05-events/index.html)
and [situation](https://nemo-ufes.github.io/gufo/examples/06-situations/index.html)
patterns for change. Events can bring about situations, and temporary
situations can qualify a classification or relationship over time through
`TemporaryInstantiationSituation` and `TemporaryRelationshipSituation`.
The current tonto export maps declared events and situations, but does not
create those temporary situations automatically for changing memberships
or links. For a graph representing one instant, the optional
[snapshot layer](gufo-mapping.md#18-the-snapshot-layer) supplies separate
OWL axioms and SHACL shapes for constraints that hold at that instant.

## Organize, import, and export

Start with one `.tonto` file. When it grows, the editor can split it into an
ontology file and package files. `use` reaches a package of the same
ontology; `import` names another ontology by the location of its ontology
file. A workspace folder may contain several ontologies. The
[publication guide](ontology-publication.md#2-concepts-and-names) defines
these terms and the import workflow.

You can share the `.tonto` ontology without generating OWL. When an OWL
representation is needed, **Tonto: Export to gUFO...** checks the ontology
and writes Turtle beside its ontology file. This export is a mapping to
gUFO, with stated limits; tonto does not require OWL or gUFO to be authored
or imported. Read the [gUFO mapping](gufo-mapping.md) when exact output
matters.

## A first session in VS Code

1. Run **Tonto: New Ontology...** and write a few domain declarations.
2. Open the language guide before choosing a stereotype or relation.
3. Use completion and the pattern catalog to explore admissible shapes.
4. Read Problems and apply only repairs that express what you mean.
5. Format the model and check that it has no remaining errors.
6. Export to gUFO only if an OWL consumer needs that representation.

The [installation guide](installation.md) covers the VSIX and workspace
setup; [editor and tooling](editor-and-tooling.md) details validation,
navigation, repairs, and command-line use.
