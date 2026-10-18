# Agent evaluations for tonto modelers

These cases make **real agent calls**. Run them explicitly; they are not part of
`npm test`. Each run creates a fresh temporary workspace, copies the extension's
agent instruction template, saves the agent transcript, and checks the
resulting files with the tonto CLI. The default interface configures the built
tonto MCP server.

Build first with `npm run build`. Then run one case at a time:

```sh
node evals/agents/run.mjs codex draft
node evals/agents/run.mjs claude repair
node evals/agents/run.mjs copilot workspace
```

To evaluate direct CLI use without tonto MCP configuration, add
`--interface=cli`:

```sh
node evals/agents/run.mjs codex draft --interface=cli
node evals/agents/run.mjs claude repair --interface=cli
node evals/agents/run.mjs copilot workspace --interface=cli
```

CLI fixtures put a symlink to this repository's built `tonto` executable on
the agent's `PATH`. They do not install a package or fetch one with `npx`.
The runner observes completed CLI commands in each agent's structured event
stream and requires `tonto check` after an edit. The independent final check
must also have no diagnostics. In CLI mode, a successful tonto MCP call fails
the interface isolation check.

Use `--out=/absolute/path` to keep the run at a chosen location. The command
refuses to replace an existing `workspace` directory. Its report contains the
agent version and exit status, final tonto validation, expected structural features, and
tonto tool names found in the transcript. It also records model identifiers
reported in the agent's event stream, when available. Inspect `agent.stdout`,
`agent.stderr`, `validation.json`, and the workspace for failures. In MCP mode,
the runner looks for successful tool calls in Codex, Claude, and Copilot's
structured events; mentioning a tool or having its call denied does not count.
In both modes a pass needs a validation started after the *last* edit
completed: validating after the first of two edits leaves the second
unchecked, and a validation started alongside a write checked the model before
it, even if it finishes later. A shell command counts as an edit when it writes
a `.tonto` file; a `tonto check`, even with `--fix`, does not. The final tonto
check must have no diagnostics.

A Claude MCP fixture also gets what **tonto: Set Up Codex and Claude in
Workspace** installs beside the server: the validation hook, in
`.claude/settings.json`. The report's `hook` counts its runs and the edits it
answered with diagnostics. Claude loads project settings only
(`--setting-sources project`) and only the fixture's MCP server, so your own
hooks, plugins and MCP servers do not take part in the run; its `init` event
in `agent.stdout` shows what it did load.
The scoring is `score.mjs`, kept apart from running the agent so it can be
tested without one: `packages/language/test/agent-evals.test.ts` scores
made-up Claude, Codex and Copilot streams and two recorded Claude runs in
`fixtures/`, cut down to the fields the scoring reads. Change the scoring
there, with a stream that shows why.
A clean model and a matching text pattern are necessary but do not prove the chosen
ontology is right; review the model as a modeler would.

`--prepare-only` creates a CLI fixture without making an agent call. Use it to
inspect the starting model. For a VS Code agent, prepare a separate fixture:

```sh
node evals/agents/run.mjs vscode draft --out=/absolute/path
```

The VS Code fixture includes `AGENTS.md` but no `.mcp.json`, so the editor
agent must discover the extension's language-model tools. An MCP fixture's
configuration would make VS Code Copilot use the MCP server instead and mask
whether the extension tools are available.
Use `--model=ID` to hold the selected model constant across comparable runs.

The three cases cover drafting a role and relator, repairing a parthood
diamond, and editing an ontology split across package files. Record the agent
version and selected model when comparing results across releases. An MCP run
exercises the MCP integration and guidance. It does not establish that the
VS Code extension's language-model tools are offered to an editor agent.
See [the MCP baseline](baseline-2026-10-17.md) and
[the direct CLI baseline](baseline-cli-2026-10-17.md) for observed runs.

For the VS Code acceptance pass, install the current VSIX, open each prepared
VS Code case workspace, and start a new chat in the target editor agent. Use
the prompt in `case.json` without adding tool instructions. Check that the
agent discovers the intended tonto tools, edits the expected files, and
validates the saved model. Run `tonto check <workspace> --json` independently
afterward. Record the VS Code version, extension version, agent harness,
model, tool calls, and result. Repeat a failure in a new chat before changing
the guidance.
