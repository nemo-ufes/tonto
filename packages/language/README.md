# tonto language and CLI

The `tonto-language` package provides the tonto language services and the
`tonto` command-line interface. The CLI validates, formats, repairs, and
exports `.tonto` ontology models.

## Requirements

Node.js 22 or later.

## Install

Install globally to make `tonto` available in your shell:

```sh
npm install --global tonto-language
tonto --version
tonto guide
```

For a project-specific, reproducible version, install it as a development
dependency and run it through `npx`:

```sh
npm install --save-dev tonto-language
npx tonto check model.tonto
```

To run it once without adding a dependency to the current project:

```sh
npx --yes --package=tonto-language tonto guide
```

Upgrade a global installation with `npm update --global tonto-language`. A
project-local installation is upgraded by changing its dependency version and
running `npm install`.

From a source checkout, build the workspace and use its local binary:

```sh
npm install
npm run build
./node_modules/.bin/tonto guide
```

## Start a workspace

```sh
tonto init my-ontology             # agent instructions, Claude Code's hook, a first ontology
tonto new ontology shop            # another one-file ontology
tonto new package sales --in=shop  # a package file and its bundle entry
```

`tonto init` sets a folder up for Codex and Claude Code with this CLI: the
instructions in `AGENTS.md`, `CLAUDE.md` importing them, and a Claude Code
hook that checks each edited `.tonto` file. In a folder with no model it also
writes a one-file ontology named after the folder. It registers no MCP server.

## Commands

Run `tonto --help` for the command list and options. See the [language guide](https://github.com/nemo-ufes/tonto/blob/main/AGENTS.md#writing-tonto)
for the modeling workflow, rules, and patterns.
