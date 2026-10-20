<!-- tonto-model-instructions -->
# Writing tonto

This workspace contains one or more ontologies written in tonto, an OntoUML/UFO
textual language. Files ending in `.tonto` are model source files, not
TypeScript, JSON, Turtle, or free-form text.

Use the Tonto MCP tools available in this session as the source of truth for
language guidance, validation, repairs, formatting, and export. Do not invoke
`tonto` or start a separate Tonto server when the MCP tools are available.

### Read before writing

Call `tonto_guide` before creating or changing model syntax. It summarizes the
stereotypes, natures, association signatures, and specialization principles.
Call `tonto_patterns` before inventing a modeling shape; request a named
pattern when one is relevant. Use `tonto_explain` to settle a stereotype or
specialization question without drafting a model. Use `tonto_complete` at an
unfinished position when admissible values are unclear.

### Check the whole workspace

Before editing, read the target `.tonto` file, its ontology header or package
declaration, its `use` and `import` declarations, and related `.tonto` files.
Use `tonto_ontologies` to inspect the workspace's authored ontologies when
needed. Validate saved files with `tonto_validate(paths: [...])`; validate a
draft with `tonto_validate(source: ...)`. Include all relevant workspace files
so cross-file relations and imports are checked together. A workspace can
contain multiple ontologies; headers and package declarations, not folders or
`tonto.json`, determine membership. For related draft files that are not saved
yet, use `tonto_hold` so imports and cross-file references can resolve.

Read every diagnostic, including warnings. Each has a stable code, location,
message, and available repairs. `tonto_repair` applies only repairs that are
mechanically forced and returns the revised source and remaining diagnostics;
it does not write files. For a repair that requires a modeling choice, use
`tonto_rules` to understand the rule, then use `tonto_apply` with the chosen
repair title and the diagnostic location. Never choose between modeling
alternatives silently. A repair may affect more than one file; review every
reported change before saving it.

After an edit, call `tonto_format` and save its returned source. Then call
`tonto_validate` on the saved workspace; do not validate concurrently with an
edit. Use `tonto_diff` with before and after source when reviewing whether an
edit introduced or resolved diagnostics. Do not call a model valid until the
workspace validation has no errors or warnings.

For structural questions, use `tonto_ast`; for a model-level review, use
`tonto_digest`. Use `tonto_rules` with a diagnostic code for its rationale
and examples. Use `tonto_tables` only when the guide and explain tools do not
answer.

### Imports and exports

If an imported ontology is missing from the workspace
cache, use `tonto_fetch` to retrieve it, then validate again. Fetching is the
MCP operation that accesses the network.

Use `tonto_gufo` without `write` or `outDir` for a read-only preview. To
regenerate Turtle, validate and save the `.tonto` source first, then call
`tonto_gufo` with saved `paths` and `write` (or a workspace-relative
`outDir`). Never edit generated Turtle in place of the source model.

### Look up instead of experimenting

Use `tonto_explain` to ask whether a stereotype can specialize another, or
what an association stereotype relates. For a rule diagnostic, use
`tonto_rules(code: ...)` to read its rationale, example, and available
repairs. Use `tonto_format` before handing back edited source. Use
`tonto_ast` for exact structural questions and `tonto_digest` for a concise
model review.

Use `tonto_gufo` to preview the checked model's gUFO Turtle. To write an
export, first validate the saved model, then call the tool with saved file
paths and `write` (or `outDir`). An ontology header may carry
`@namespace`; without one, a preview uses a placeholder and warns. The
`@version`, `@license`, and `@creator` tags above the ontology header are
included in the exported header. `@snapshot` requests the snapshot module and
SHACL shapes. Each ontology is exported as its own document. These tags belong
above the ontology header; on a package they are ignored with
`ontology-tag-not-on-header`.

For any MCP tool, inspect its returned result before proceeding. Tools whose
names start with `tonto_` are exposed by the connected Tonto MCP server; the
host may display a server prefix.

## Use the connected Tonto support

Use the Tonto MCP tools for language guidance, syntax questions, validation,
repairs, formatting, structural inspection, and gUFO export. Call
`tonto_guide` before writing and consult `tonto_patterns` for modeling
shapes. After each saved edit, call `tonto_validate` on the workspace and
resolve all diagnostics, warnings included, before describing the model as
valid. Do not validate in parallel with an edit.

The VS Code extension also provides completion, hover, formatting, Problems,
and quick fixes. Prefer MCP validation for agent work because it returns
structured diagnostics and repairs. If MCP tools are missing, use the CLI
fallback below if an installed `tonto` command is available. Otherwise run
**Tonto: Set Up Codex and Claude in Workspace**, trust the project MCP server,
and start a new chat; until validation is available, make only small,
reviewable edits and do not claim the model validates. In Claude Code, if a
hook validates edited `.tonto` files, resolve its diagnostics before making
further model edits.

For gUFO output, edit and validate the `.tonto` source, then call
`tonto_gufo` with saved paths and `write` to regenerate each ontology's
`.ttl` beside its ontology file. Omit `write` for a read-only preview. Do not
hand-edit generated Turtle as a substitute for changing the source model.

### CLI fallback when MCP is unavailable

Use this only when the Tonto MCP tools cannot be reached and the `tonto` CLI
is already installed. Check with `command -v tonto`; do not use `npx` to
download or run a CLI. If no installed CLI is available, restore MCP access
with **Tonto: Set Up Codex and Claude in Workspace**. If neither the MCP tools
nor the CLI can be reached, tell the user that validation could not be run and
do not describe the model as valid.

- Read `tonto guide` before writing. Use `tonto patterns [name]` for validated
  modeling examples, `tonto explain <subject> <target>` for stereotype
  questions, and `tonto rules <code>` to understand a diagnostic.
- Read the relevant `.tonto` files and validate the workspace together:
  `tonto check <workspace-root> --json`. For an unsaved draft, pipe it to
  `tonto check - --json --workspace=<workspace-root>`. Avoid `--isolated` for
  ordinary workspace validation because cross-file checks need related files.
- Review every diagnostic, including warnings. `--json` reports stable codes,
  locations, and repairs. `tonto check <workspace-root> --fix` writes the
  repairs forced by rules; inspect the resulting diff and validate again.
  Repairs that choose a modeling interpretation are not applied by default.
  Naming a code with `--fix=<code>` makes that choice, so do so only when the
  intended modeling decision is clear. Preserve a before/after copy and review
  every changed file before accepting the result.
- Run `tonto format <file>` and save its formatted output before handing back
  model changes. Use `tonto ontologies <workspace-root>` to inspect authored
  ontologies and `tonto ast <file>` for structural questions.
- Checking stays offline. If an import is not cached, retrieve it explicitly
  with `tonto fetch <ontology-file>`, then check the workspace again. Use
  `tonto gufo <ontology-file>` for a preview or add `--write` to regenerate
  Turtle beside its ontology file. Run
  `tonto check <workspace-root> --anti-patterns` for an advisory anti-pattern
  review; resolve ordinary validation diagnostics first.
  <!-- /tonto-model-instructions -->
