# Give Codex and Claude the tonto tools

The Codex extension reads project guidance from `AGENTS.md`; Claude Code reads
`CLAUDE.md`. Neither consumes tools contributed through another extension's
generic VS Code API.

Use **Set Up Codex and Claude in Workspace** once. It installs the instruction
files and configures the tonto MCP server bundled in the VSIX. Start new chats
afterward and approve or trust the project server when the agent asks.

Then try asking:

> Read the tonto guide, review this model, repair only the unambiguous
> problems, format it, and validate it again.

To regenerate the gUFO Turtle without using the Command Palette, ask the agent
to call `tonto_gufo` with the saved file path and `write`: each `.ttl` is
written beside its ontology file, as the editor's export writes it.
For one ontology without a `@namespace`, supply its exact `namespaceIri`,
including the final `#` or `/`. Better still, write each ontology's
`@namespace` above its header, where the editor's export also puts it.

The MCP server has seventeen tonto tools and runs with VS Code's internal Node.js
runtime. No separate Node.js, CLI, package installation, or external MCP server
is needed.
