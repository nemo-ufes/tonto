# Editor and tooling

The VS Code extension is the main editing surface for tonto. It bundles the
language server, validator, formatter, gUFO export, and agent tools; a modeler
installing the VSIX does not need a separate Node.js installation. See
[installation.md](installation.md) for installation and workspace setup.

## Editing a model

| Feature | Behavior |
|---|---|
| Problems | Reports syntax and ontology diagnostics with stable codes and source positions. Optional anti-pattern diagnostics are advisory. |
| Quick Fix | Offers concrete edits: correcting keywords or references, repairing cardinalities, imports, natures, and specializations, or choosing among alternative modeling repairs. |
| Completion | Narrows stereotypes, `of` natures, supertypes, relation ends, and references to what is admissible at the cursor. It also proposes declaration snippets and documentation tags. |
| Hover | Explains a declaration's stereotype, effective natures, inheritance, ultimate sortal, members, relation ends, and implicit `[1]` bounds. It includes `///` documentation. |
| Navigation | Supports definitions, references, rename, document and workspace symbols, and folding across files. |
| Highlighting | Distinguishes stereotypes, types, attributes, relations, end names, natures, and cardinalities using semantic tokens. |
| Formatting | Normalizes spacing and indentation while preserving blank lines used for grouping; it does not change the parsed model. |

On a blank package-level line, **Tonto: Insert Modeling Pattern...** opens
the validated pattern catalog. The inserted domain names are linked: changing
a declaration updates its references in the inserted model. **Tonto: Open
Language Guide** displays the guide generated from the validator's tables.

Quick fixes distinguish a rule-forced edit from a modeling choice. A duplicate
token or an impossible bound can be repaired automatically. A phase with no
sibling, or an association with two plausible readings, needs the modeler to
choose. Each proposed repair names its edits; a repair that would leave an
error is not offered.

Three refactorings are available at the cursor rather than as diagnostics:
write the relator from which a material relation derives, move a relation
between its package-level and class-body forms, and split a one-file ontology
into an ontology file and package. The two written forms of a relation keep
the same meaning when moved.

## What validation sees

Some checks need incoming relations. Whether a role has a founding relator,
whether a relator mediates enough participants, and whether a moment has a
bearer can depend on declarations in other files. The extension validates the
workspace together and revalidates documents that a changed file points at,
as well as documents that refer to it.

The command line uses the nearest ancestor with `tonto.json` as a workspace
root, or otherwise the highest ancestor that still contains `.tonto` files.
`--workspace=<dir>` sets the root explicitly; `--isolated` checks only the
named files. Ontology membership comes from headers and package declarations,
not from a folder layout. A workspace can hold several ontologies.

The optional `tonto.antiPatterns` setting enables advisory checks such as
`RelOver`, `RepRel`, `DepPhase`, `MixIden`, and `HetColl`. They are off by
default because a large model can produce many advisory findings. Use them
when reviewing an ontology.

## Working from a terminal

From a source checkout with Node.js 22 or later, `npx tonto` exposes the same
language implementation:

```sh
npx tonto guide
npx tonto patterns role-and-relator
npx tonto check model.tonto --json
npx tonto rules material-cardinality-weaker
npx tonto format model.tonto
npx tonto ast model.tonto
npx tonto ontologies
```

`check` returns status 1 for errors. Its JSON diagnostics include a stable
code, position, message, and available repairs with edits. With `--fix`, it
applies repairs forced by their rule; `--fix=<code>` selects specific rules,
including a repair that needs a deliberate choice. Standard input (`-`)
supports an unsaved draft. `rules` explains each diagnostic with a minimal
example; `patterns` shows validated models to write instead; `explain` asks
whether a stereotype or relation-end combination is admissible.

`npx tonto gufo model.tonto` previews the optional gUFO/Turtle export.
`--write` writes the ontology's Turtle beside its ontology file. The editor
provides **Tonto: Export to gUFO...** and **Tonto: Export to gUFO with Snapshot
Layer...**. Export checks the complete ontology first. The
[gUFO mapping](gufo-mapping.md) specifies the output; the tonto source remains
the authored model.

## Agent tools

`packages/language/src/tools.ts` defines eighteen tools once. The extension
exposes them as VS Code language-model tools and through its bundled local MCP
server for Codex and Claude Code. They cover the guide, validation, rules,
patterns, completion, repairs, formatting, AST, structural review, edit
comparison, held draft files, dependency retrieval, and gUFO export. Four
resources and two prompts provide the reading and draft/review workflows over
MCP.

Run **Tonto: Set Up Codex and Claude in Workspace** to install project
instructions and configure the bundled server. The extension also installs
a Claude Code hook that checks each edited `.tonto` file immediately. See
[installation.md](installation.md#3-use-the-codex-or-claude-code-extension)
for the generated files and connection steps.

Modeling tools return proposed source or edits; they do not silently rewrite
`.tonto` files. The gUFO export tool can write generated Turtle when explicitly
asked to do so. The shared tool definitions keep the editor and MCP answers
consistent.
