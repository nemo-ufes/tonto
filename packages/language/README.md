# tonto language and CLI

The `tonto-language` package provides the tonto language services and the
`tonto` command-line interface. The CLI validates, formats, repairs, and
exports `.tonto` ontology models.

## Requirements

Node.js 22 or later.

## Install

The npm install commands below will work after the first `tonto-language`
release is published. Until then, from this repository, build the workspace
and use its local binary:

```sh
npm install
npm run build
./node_modules/.bin/tonto guide
```

After publication, install globally to make `tonto` available in your shell:

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

## Commands

Run `tonto --help` for the command list and options. See the [language guide](https://github.com/jpalmeida/tontoredesign/blob/main/AGENTS.md#writing-tonto)
for the modeling workflow, rules, and patterns.
