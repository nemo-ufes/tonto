<!-- tonto-model-instructions -->
# tonto model instructions

This workspace contains an ontology model written in tonto, an OntoUML/UFO
textual language. Files ending in `.tonto` are model source files, not
TypeScript, JSON, Turtle, or free-form text.

## Before changing a model

- For ongoing modeling, recommend keeping the workspace in a Git repository
  so changes can be reviewed and recovered. If it is not under Git, suggest
  initialization once; do not initialize a repository or make commits unless
  the user asks. Git is optional and does not affect tonto validation.
- Read the target file, its ontology header or `package ... in` line, its
  `use` and `import` declarations, and the other `.tonto` files in the
  workspace. Validation often depends on declarations in more than one file.
- Preserve the modeler's ontological choices. A diagnostic that offers
  multiple repairs requires a modeling decision; ask rather than choosing
  silently.
- Give every `category`, `mixin`, `roleMixin`, `phaseMixin` and
  `historicalRoleMixin` an `of` clause naming the natures it classifies, such
  as `category Agent of functional-complexes`. List several natures only when
  it really spans them.
- Derive a `historicalRole` from what happened, written where it happened:
  `historicalRole Graduate specializes Person derivedFrom Person.graduatedIn`.
  A `@participation`, `@creation` or `@termination` can found one.
- Name an `@participation` from an object to an `event` in the past, because a
  modeled event has occurred: `delivered`, `attended`, `participatedIn`, not
  `delivers`, `attends`, `participatesIn`. A possibly ongoing `process` may
  still take a present-tense name such as `performs`. Source a lasting event
  link from a rigid type: a person remains a graduation participant after
  ceasing to be a student.
- Distinguish event decompositions by their criterion. Use `@structural` for
  parts that belong to the definition of the whole. Use `@temporal` only for
  maximal segments projected by an external temporal scheme, such as the
  portions of a meeting before and after noon. Use `@participational` for the
  maximal portion depending exclusively on one endurant; the participant end
  of that portion's `@participation` has maximum cardinality `1`, and only one
  participation into the portion may require a participant at all.
- Use `///` immediately above a declaration for documentation and `//` for an
  ordinary comment.
- Write comments and documentation in the language of the modeled domain: say
  what an individual is, what a relationship means, or what happened. Do not
  say that a declaration stores, tracks, captures, or records facts. Use such
  verbs only when they name an action or concept in the domain itself, as when
  a civil register records a birth.
- Treat a relation name as a member of its source class, whether the relation
  is written inside that class or at package level. `Person.worksFor` and
  `Company.worksFor` may coexist. Within one source class, do not reuse a
  relation name for another relation, an attribute, or a named end owned by
  that class. Qualify an ambiguous bare relation reference with its source
  class (and package when needed).
- Do not invent syntax or silently translate the model into another ontology
  language.

## Ontologies, packages and files

- An ontology is what is published and imported. Its ontology file holds its
  header, `ontology shop`; every ontology has exactly one. A small ontology is
  a one-file ontology: the header, then its declarations.
- A larger ontology lists its packages after `bundles` in its ontology file,
  and each package file starts `package sales in shop`. A package with no
  ontology header above it and no `in` is an error.
- Packages are used, within one ontology: `use core`. Ontologies are
  imported, by the location of their ontology file:
  `import shop from <shop.tonto>`, then `shop.Customer`. Never `use` a
  package of another ontology, and never import a package file.
- `tonto.json` is the workspace's optional settings file and maps import
  locations. Ontology headers and package declarations identify the members
  of each ontology.
- Start a new model as a one-file ontology, and split it with the editor's
  "Split into an ontology file and package" refactoring rather than by hand.

## Use the tonto support that is actually available

The tonto VS Code extension supplies completion, hover, formatting, the
Problems panel and quick fixes, tonto tools for VS Code agents, and a local
`tonto-vscode` MCP server for Codex and Claude Code. Copilot CLI needs the MCP
server configured on its own.

Read `tonto_guide` before writing, and settle syntax with `tonto_patterns`.
When an edit has finished -- never in the same parallel batch as the write --
run `tonto_validate` on the saved workspace, and resolve every diagnostic,
warnings included, before calling the model valid. In Claude Code a hook also
validates each `.tonto` file you edit: repair what it reports before editing
further. The host may show a server prefix before these tool names.

If the tools are missing, run **Tonto: Set Up Codex and Claude in Workspace**
in Codex or Claude Code, trust the project MCP server and start a new chat; in
VS Code, check that the extension is enabled and start a new chat. Meanwhile
use a tonto CLI the workspace already has (`command -v tonto` or
`./node_modules/.bin/tonto`; never let `npx` fetch one): `tonto guide` before
writing, and `tonto check <file> --json` after each edit, which loads the
file's workspace and lists the warnings a clean exit hides. `--fix` writes
files; `tonto --help` has the rest. With neither, make small edits, ask the
user to check the Problems panel, and never claim the model validates.

For gUFO/OWL output, edit and validate the `.tonto` source, then call
`tonto_gufo` with the saved file path and `write` to regenerate each
ontology's `.ttl` beside its ontology file, where the editor's export also
writes it. Omit `write` when only a preview is wanted. Do not hand-edit
generated Turtle as a substitute for changing the source model.
<!-- /tonto-model-instructions -->
