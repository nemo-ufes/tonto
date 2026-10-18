# Direct CLI agent baseline, 2026-10-17

Each run used a fresh disposable workspace, the same draft, repair and split
workspace prompts as the MCP baseline, and the agent instruction template.
The built `tonto` CLI was placed on `PATH`; no tonto MCP server was configured.
The default models were Claude Opus 5.5 in Claude Code and Claude Sonnet 5.5
in Copilot CLI. Codex did not name its model in the event stream.

A pass requires the expected model structure, no diagnostics in an independent
final tonto check, and an observed successful `tonto check` command started
after an edit completes. No run used a tonto MCP tool.

| Agent CLI | Draft | Repair | Split workspace |
|---|---|---|---|
| Codex 0.162.1 | Pass | Pass | Pass |
| Claude Code 2.1.302 | Pass | Pass | Pass |
| Copilot CLI 1.0.98 | Pass | Pass | Pass |

The first Codex draft run was marked failed by the evaluator even though its
post-edit `tonto check --json` returned no diagnostics: a later `git diff` in
the same shell line exited 1 because the disposable fixture is not a Git
repository. The evaluator now recognizes the clean tonto JSON result in that
case; a fresh Codex draft run passed.

The first Copilot split-workspace run could not execute shell commands because
the fixture used `--allow-tool=bash`. Copilot's permission syntax calls this
`shell`; after the fixture used `--allow-tool=shell`, a fresh run called the CLI,
fixed two warnings, and validated the saved workspace. The failed setup run
is not evidence about tonto's CLI or Copilot's modeling ability.

These runs establish CLI discovery and use with a locally available executable.
They do not test npm installation, remote imports, or unsaved drafts. The
structural checks also cannot decide whether an ontology is conceptually
right; a modeler should review that separately.
