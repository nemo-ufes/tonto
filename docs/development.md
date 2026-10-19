# Developing tonto

This guide covers the repository's build, tests, and implementation
boundaries. For a modeler's workflow, start with the [README](../README.md)
and [installation guide](installation.md). The language decisions are in
[language-design.md](language-design.md).

## Repository layout

| Path | Responsibility |
|---|---|
| `packages/language/src/grammar/` | Langium grammar, divided by language concern |
| `packages/language/src/validation/` | Static and ontological checks |
| `packages/language/src/lsp/` | Completion, hover, actions, navigation, tokens, and formatting |
| `packages/language/src/cli/` | `tonto` commands, generated guide, rules, and patterns |
| `packages/language/src/tools.ts` | Shared agent tool definitions and answers |
| `packages/language/src/gufo.ts` and `exports.ts` | gUFO mapping and shared export writing |
| `packages/extension/` | VS Code client, language-server bundle, commands, and agent integration |
| `packages/mcp/` | MCP host for the shared language tools |
| `packages/language/test/fixtures/models/` | Vendored example models for parsing and formatting tests |

The entry grammar is `packages/language/src/tonto.langium`. It imports the
grammar fragments and generates the AST under
`packages/language/src/generated/`. After changing a `.langium` file, build
before testing so the generated AST and parser match the source.

## Grammar and AST

The grammar creates separate `InternalRelation` and `ExternalRelation` nodes
for a relation written inside a class or at package level. They share the
`Relation` interface; `getRelationSource()` resolves the source that is
implicit in the first form and explicit in the second. `Datatype` and
`Enumeration` are also separate types. A model has direct `imports`,
`packages`, and `ontologies` collections, while a class carries its
stereotype and natures without wrapper nodes. Cross-reference unions use
names such as `RelationEndTarget` and `AttributeType`.

Named association ends are qualified by the classifier at the opposite end;
association names are scoped by their source. The generated reference types
keep `subsets` and `redefines` pointed at ends rather than at associations.
The [legacy comparison](legacy-tonto-changes.md#why-the-generated-ast-changed)
explains why these AST boundaries were introduced.

## Build and test

The repository build requires Node.js 22 or later. Installing the VSIX to
model in VS Code does not.

```sh
npm install
npm run build
npm test
npm run lint
```

`npm run build` generates the Langium grammar, then builds the language
package, MCP server, and VS Code extension. `npm test` runs language tests.
`npm run test:vscode` runs extension integration tests in a real VS Code
instance and may download that instance. `npm run test:gufo-conformance`
uses `robot` on `PATH`, or a ROBOT jar supplied through `ROBOT_JAR` with
Java. CI uses ROBOT 1.9.10. It exports the pattern catalog, checks the resulting OWL with
ROBOT, and asks HermiT to reject inconsistent ontologies or unsatisfiable
named classes.

Open this repository in VS Code and press `F5` to launch the Extension
Development Host. That launch builds the grammar and bundles first. For a
tighter loop, use the Watch task and **Run Extension (no build)**, then reload
the development host when a bundle changes.

The extension has two bundles: `out/extension.cjs` for the host and
`out/language-server.cjs` for the server. Building only
`packages/language` does not refresh both extension bundles; use the root
build before testing the extension.

`npm run package` builds and packages a VSIX with a UTC build timestamp in
its version and filename. Packaging changes the extension version, so avoid
using it merely as a build check.

## Validation architecture

The validator does more than compare local syntax. It computes taxonomic
compatibility from six specialization principles, and expands relation-end
compatibility from twenty-three association signatures. The transcribed
tables remain as test fixtures that check those derived results. Every
diagnostic has a stable code, and every documented rule has a small model that
still triggers it.

Several rules need to know what points *at* a class. For example, a role's
founding relator may be declared elsewhere. The workspace's reverse
reference index supplies those incoming relationships. The custom document
builder also revalidates referenced documents after an edit; ordinary
Langium dependency rebuilding alone follows references in the other
direction.

`TontoSession` in `packages/language/src/api.ts` is the short path for
validating source text without a file. For a validation or repair change,
run the rule on a model, apply its proposed edit, and validate again. A
repair should not be offered if applying it leaves an error. The rule
examples and pattern catalog are executable documentation: patterns must
validate without errors, warnings, or hints.

The CLI, extension, and MCP server share one language implementation.
`packages/language/src/tools.ts` owns each agent tool's name, parameters,
description, and result shape. When changing a tool, run
`npm run tools:sync --workspace=tonto-vscode` to update the extension's
declared tools before testing.

## Export architecture

The gUFO export is one output format, not a dependency of tonto. An export
produces `ExportedFile` values that identify the ontology, generated
filename, content, and ontology file. `writeBeside` and `writeInto` in
`packages/language/src/exports.ts` handle atomic writing for all formats.
The editor's export command chooses and saves the ontologies, while
`gufo-export.ts` handles the gUFO-specific namespace prompt. A later format
can reuse the same writing flow without changing what a tonto ontology is.

The [gUFO mapping](gufo-mapping.md) specifies the mapping itself.
[Ontology publication](ontology-publication.md) describes imports,
locations, packages, namespace metadata, and publication checks.

## Project conventions

- Comments in code explain *why* a guard, derivation, or exception exists.
- Diagnostics name the underlying modeling principle and what to write
  instead.
- Derive admissibility from principles before adding another table row.
- Use domain examples that are true, not merely parseable.
- Use US English in code, comments, diagnostics, tests, and documentation.

The complete agent-facing instructions are in [AGENTS.md](../AGENTS.md).
