# tonto: a textual ontology modeling language

**tonto** is a textual ontology modeling language. It was designed to bring the way development feels today — textual, direct, tool-friendly, and iterative — to ontology-based conceptual modeling. Models are plain text and require no special tools to view, edit and publish, while dedicated tooling adds editor support, immediate feedback, modularity, refactoring, and seamless integration with version control.

tonto brings the ontological distinctions of the Unified Foundational Ontology (UFO) (ISO/IEC DIS 21838-5) directly into the modeling language, guiding the development of well-founded ontology models.

The project includes a VS Code extension for tonto and an accompanying command-line tool. Write a `.tonto` file to describe an ontology using kinds, roles, relators, events, and the relations between them. The tools help you choose valid constructs and explain problems as you model.

tonto and its tools were designed from the outset to support LLM-based agents. Language guidance and formal rules provide agents with the context and constraints needed to create, inspect, and modify ontology models while preserving their structural and semantic integrity. Humans and LLM agents benefit from many of the same properties: explicit textual representation, clear rules, fast feedback, and good tooling.

The name is a backronym for *t*extual *onto*logies. It also means “silly” or “dizzy” in Portuguese. The wordplay is intentional: **serious ontologies, seriously fun.**


## Start modeling in VS Code

Install the tonto VSIX in VS Code 1.95 or later, then run **Tonto: Get Started**. The walkthrough can create your first ontology, open the language guide, show validation, and introduce the optional OWL gUFO-based export. The VSIX includes everything needed to edit models and use that export; it does not require a separate Node.js installation.

A VS Code workspace can start as an ordinary folder with one `.tonto` file and can later hold several ontologies. Run **Tonto: New Ontology...** to create one, or write this as `people.tonto`:

```tonto
/// People and their employment.
ontology people

/// A person, in the everyday sense.
kind Person

/// A person employed by an organization.
role Employee specializes Person

/// An organization of people.
kind Organization

/// An organization that employs people.
role Employer specializes Organization

/// The employment binding an employee and an organization.
relator Employment {
    @mediation [1..*] -- [1] (const) Employee
    @mediation [1..*] -- [1] (const) Employer
}

@material relation Employee [1..*] -- worksFor -- [1..*] Employer derivedFrom Employment
```

The `ontology` header makes this a one-file ontology. `kind` gives `Person` and `Organization` their own identity. `Employee` and `Employer` are roles their instances play while an employment holds. Each `Employment` binds exactly one employee and one employer: the `[1]` at each mediated end says that. The `[1..*]` at each relator end says an employee or employer participates in at least one employment and may participate in several. `worksFor` is the material relation derived from that relator. A `///` line immediately above a declaration documents its domain meaning; VS Code shows that text on hover and in completion proposals.

For the complete vocabulary, run **Tonto: Open Language Guide** in VS Code or `npx tonto guide` in a source checkout. The guide is generated from the same tables used by validation and completion.

## Model with feedback

The extension provides:

| In the editor | What you can do |
|---|---|
| **Problems and Quick Fix** | See errors and warnings with concrete repairs. Where a repair requires a modeling decision, choose from the offered alternatives. |
| **Completion and snippets** | Find admissible stereotypes, types, relation ends, documentation tags, and common declaration shapes. |
| **Hover and navigation** | Read a declaration's meaning, natures, inheritance, and multiplicities; go to definitions, find references, and rename across files. |
| **Formatting and highlighting** | Keep the model consistently laid out and distinguish its semantic elements as you read. |
| **Modeling patterns** | Run **Tonto: Insert Modeling Pattern...** on a blank line to insert a validated example with linked domain names. |

The pattern catalog includes roles and their founding relators, phase partitions, parthood, constitution, causation, and multi-level modeling. Read a pattern when choosing a modeling shape: `npx tonto patterns` lists them in a source checkout, and `npx tonto patterns role-and-relator` shows one.

tonto checks a model as part of its workspace because relations in other files can establish whether a class is well formed. The optional `tonto.antiPatterns` setting adds advisory OntoUML anti-pattern diagnostics when reviewing a model.

## Grow and share an ontology

Start with one file. When the ontology grows, **Tonto: New Package...** creates a package file and updates the ontology file; the *Split into an ontology file and package* refactoring on the `ontology` header performs the initial split. Package files start with `package <name> in <ontology>`. Use `use` to refer to another package of the same ontology, and `import` to refer to an external ontology by the location of its ontology file. The `.tonto` ontology can be shared and imported in its own form.

If the `people.tonto` ontology above is published on the web,
`conference.tonto` can import it from its URL:

```tonto
ontology conference
import people from <https://example.org/people.tonto>

event Conference
@participation relation people.Person (const participants) [0..*] -- attended -- [0..*] Conference
```

`people.Person` refers to `Person` in the imported `people` ontology. Replace
the example URL with the published file's URL. Run `npx tonto fetch
conference.tonto` to retrieve it before checking; checking itself stays
offline. For a file of the imported ontology in the same folder, use
`<people.tonto>` instead.

## Export the ontology

If you also need gUFO-aligned OWL/Turtle, add a namespace above the ontology header and run **Tonto: Export to gUFO...**:

```tonto
/// People and their employment.
/// @label People
/// @namespace https://example.org/people#
ontology people
```

The gUFO export checks the ontology and writes `people.ttl` beside its ontology file. If the header has no namespace, the gUFO export command asks for one and saves it in the header.

## Agents

The extension also exposes the language guide, validation, repairs, patterns, and export as tools to VS Code agents. **Tonto: Set Up Codex and Claude in Workspace** configures the bundled MCP server and project instructions for those agents.

## Acknowledgements

Matheus Lenke Coutinho and João Paulo A. Almeida are the original designers of tonto. This project reimplements the grammar, validation and other features of the [legacy tonto project](https://github.com/nemo-ufes/tonto-legacy), which was mainly authored by Matheus Lenke Coutinho at the [NEMO Ontology & Conceptual Modeling research group](https://nemo.inf.ufes.br) at the Federal University of Espírito Santo (UFES), Brazil.

tonto's language design, concrete syntax, and OntoUML/UFO semantics are the work of the [NEMO Ontology & Conceptual Modeling research group](https://nemo.inf.ufes.br), in cooperation with the [Semantics, Cybersecurity & Services (SCS) group](https://www.utwente.nl/en/eemcs/scs/) throughout various research projects, which have received among others the support of CNPq, CAPES and FAPES over the years.

Giancarlo Guizzardi, Tiago Prince Sales and Claudenir M. Fonseca should be acknowledged for their ongoing contributions, along with the contributors to [OntoUML](https://github.com/OntoUML).

## License

MIT
