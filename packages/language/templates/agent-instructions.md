<!-- tonto-model-instructions (cli) -->
# Writing tonto

This workspace contains one or more ontologies written in tonto, an OntoUML/UFO
textual language. Files ending in `.tonto` are model source files, not
TypeScript, JSON, Turtle, or free-form text.

Use the installed `tonto` command as the source of truth for language guidance,
validation, repairs, formatting, and export. Run it as `tonto` when it is on
the path, or as `npx --no -- tonto` when it is installed only in this project;
`--no` makes npx refuse to download a package it does not find. Check with
`npx --no -- tonto --version`. Do not download or run any other copy of the
CLI. If no installed CLI can be reached, tell the user that validation could
not be run, make only small, reviewable edits, and do not describe the model as
valid.

### Read before writing

Run `tonto guide` before creating or changing model syntax. It summarizes the
stereotypes, natures, association signatures, and specialization principles.
Run `tonto patterns` before inventing a modeling shape, and
`tonto patterns <name>` for one that is relevant. Use
`tonto explain <subject> <object>` to settle whether one stereotype may
specialize another, and `tonto explain @<stereotype> [<nature> <nature>]` for
what an association stereotype relates, without drafting a model.

### Start and grow an ontology

`tonto new ontology <name> [folder]` writes `<name>.tonto`, a one-file
ontology. `tonto new package <name> --in=<ontology> [folder]` writes a package
file and adds its bundle entry to the ontology file, splitting a one-file
ontology first. `tonto split <ontology-file>` splits one without adding a
package. Use these instead of writing ontology headers, package declarations,
or bundle entries by hand.

### Check the whole workspace

Before editing, read the target `.tonto` file, its ontology header or package
declaration, its `use` and `import` declarations, and related `.tonto` files.
Use `tonto ontologies <workspace-root>` to list the workspace's authored
ontologies. A workspace can contain multiple ontologies; headers and package
declarations, not folders or `tonto.json`, determine membership.

Validate the workspace together: `tonto check <workspace-root> --json`. For an
unsaved draft, pipe it to `tonto check - --json --workspace=<workspace-root>`.
Avoid `--isolated` for ordinary validation, because cross-file checks need the
related files.

Read every diagnostic, including warnings. `--json` reports each with a stable
code, location, message, and available repairs. Run `tonto rules <code>` for a
rule's rationale, example, and repairs. `tonto check <workspace-root> --fix`
writes only the repairs a rule forces. Repairs that choose a modeling
interpretation are not applied by default; naming a code with `--fix=<code>`
makes that choice, so do so only when the intended modeling decision is clear,
and say which decision it was. Never choose between modeling alternatives
silently. A repair may change more than one file; keep a copy of each file
before repairing, and review every changed file before accepting the result.

After an edit, run `tonto format <file>` and write its output back to the
file. Then check the workspace again; do not check while an edit is in
progress. Do not call a model valid until the workspace check reports no errors
or warnings. In Claude Code, a hook checks each `.tonto` file after it is
edited; resolve its diagnostics before making further model edits.

Use `tonto ast <file>` for exact structural questions. After ordinary
diagnostics are resolved, `tonto check <workspace-root> --anti-patterns` adds
the advisory anti-pattern review.

### Imports and exports

Checking stays offline. If an imported ontology is not in the workspace cache,
retrieve it explicitly with `tonto fetch <ontology-file>`, then check the
workspace again.

Use `tonto gufo <ontology-file>` to preview the checked model's gUFO Turtle,
and add `--write` to regenerate each ontology's `.ttl` beside its ontology
file. An ontology header may carry `@namespace`; without one, a preview uses a
placeholder and warns. The `@version`, `@license`, and `@creator` tags above
the ontology header are included in the exported header, and `--snapshot` also
writes the snapshot module and its SHACL shapes. Each ontology is exported as
its own document. Never edit generated Turtle in place of the source model.

### With the editor

The tonto VS Code extension adds completion, hover, Problems, and quick fixes.
Its **Tonto: Set Up Codex and Claude in Workspace** command connects agents to
the same operations as tools, and replaces these instructions with ones for
those tools.
<!-- /tonto-model-instructions -->
