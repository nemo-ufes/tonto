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
| `packages/language/src/cli/` | `tonto` commands: guide, rules, and patterns |
| `packages/language/src/tools.ts` | Shared agent tool definitions and answers |
| `packages/language/src/gufo.ts` and `exports.ts` | gUFO mapping and shared export writing |
| `packages/extension/` | VS Code client, language-server bundle, commands, and agent integration |
| `packages/mcp/` | MCP host for the shared language tools |
| `packages/language/test/fixtures/models/` | Vendored example models for parsing, formatting, validation, and gUFO conformance tests |

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
Java. CI uses ROBOT 1.9.10. It exports the pattern catalog and the example
models in `packages/language/test/fixtures/models/`, checks the resulting OWL with
ROBOT, and asks HermiT to reject inconsistent ontologies or unsatisfiable
named classes.

Open this repository in VS Code and press `F5` to launch the Extension
Development Host. That launch builds the grammar and bundles first. For a
tighter loop, use the Watch task and **Run Extension (no build)**, then reload
the development host when a bundle changes.

The extension build produces `out/extension.cjs` for the host,
`out/language-server.cjs` for the language server, `out/tonto-mcp.mjs` for the
bundled MCP server, and `out/tonto-hook.mjs` for Claude Code's hook. Building
only `packages/language` does not refresh these bundles; use the root build
before testing the extension.

The VSIX is packaged with `--no-dependencies`, so the license files of the npm
packages compiled into those bundles would not otherwise ship. The build
writes `out/THIRD-PARTY-NOTICES.txt` from esbuild's metafile -- the packages
actually bundled, not everything in `package-lock.json` -- with each one's
license and notice text. It stops if a bundled package declares no license or
one outside the permissive list in `packages/extension/third-party-notices.mjs`;
adding a copyleft or proprietary dependency to the extension is a decision to
make there, on purpose. Build tools such as `@vscode/vsce` are not bundled and
are not checked.

## Local installation and releases

There are two intentional workflows: install a development build locally,
or publish a coordinated release. A local installation must not change the
version selected for the next release. A published release gives the CLI,
VS Code extension, and the MCP server bundled with that extension one shared
SemVer version, because they deliver one language implementation to users.

### Install a development build

Use F5 and the Extension Development Host for the fastest edit/run loop. Use
a packaged local install when checking the VSIX contents, installed
activation, or the bundled MCP runtime:

1. Save the changes to be exercised.
2. Run `npm run dev:install`.
3. The command builds the workspaces, creates a VSIX with a unique
   development prerelease version (for example,
   `0.1.74-dev.1792413120000.12345`), and installs it. The same development version
   identifies the extension and its bundled MCP. The version is generated
   for the package; the tracked `package.json` files remain unchanged.
4. Reload the VS Code window. An installed package does not replace code
   already loaded by an active extension host. On activation the new
   extension copies its MCP runtime to the stable path that `.mcp.json` and
   `.codex/config.toml` name.
5. Restart each agent's tonto MCP server: `/mcp` in Claude Code, or a new
   Codex session. Agents start the server once per session and keep the code
   it loaded; reloading the window does not stop it, and a server the agent
   started while the window was reloading may have read the previous copy.
   `tonto_version` says which build answered.

The local install uses the same extension identifier as the Marketplace
extension. Use a dedicated VS Code profile or isolated directories to avoid
replacing the copy used for normal work. For example, set
`VSCODE_USER_DATA_DIR` and `VSCODE_EXTENSIONS_DIR` before running the command;
`packages/extension/install-vsix.mjs` passes them to the VS Code CLI. Set
`TONTO_VSCODE_CLI` to use another launcher, such as `code-insiders`. The existing
`npm run install:local` command remains an alias for `npm run dev:install`.

The development version is the next patch after the release version, with a
timestamp and process id in its prerelease identifiers. The package script
temporarily stamps the extension's `package.json` and restores it even if packaging or installation fails.
The extension build embeds the same version in the MCP server's protocol
metadata. The tracked `package.json` files keep the stable version.

To make the checkout's CLI available as the global `tonto` command, run
`npm run dev:link-cli`. It builds `tonto-language`, writes a local development
version marker, and runs `npm link` from that package, so global invocations
use this checkout. `tonto --version` includes the generated development
prerelease version while the link is active. Run `npm run dev:unlink-cli` to
remove both the global link and the marker; install a registry version again
with `npm install --global tonto-language` if desired.

### Prepare and publish a release

Use the release command from a clean `main` branch synchronized with
`origin/main`. It prepares the coordinated version change, commits it, creates
a signed annotated tag, pushes the branch and tag, then dispatches the
`Release tonto` workflow. Pushing a tag by itself does not start a release.

```sh
npm run release -- 0.10.0 --dry-run
npm run release -- 0.10.0
```

The command requires confirmation before changing the repository. Add `--yes`
to skip the prompt in an intentional non-interactive run. npm and Marketplace
publishing are opt-in; for example, add `--publish-npm` to publish
`tonto-language` to npm, and `--publish-marketplace` to publish the VS Code
extension. Both may be selected for the same release. Without either flag, the
workflow creates the GitHub Release and attaches the CLI `.tgz` and extension
`.vsix` without publishing to registries.

The command checks the working tree, branch, `origin/main`, version, local and
remote tag availability, GitHub CLI authentication, and version consistency
before preparing. Each operation stops the sequence on error. If an error
occurs after the version commit or tag was created, inspect Git and GitHub
state before continuing; do not rerun blindly. A workflow dispatch failure
after the tag is pushed can be recovered by manually dispatching `Release
tonto` for that tag.

The workflow verifies the signed tag and package versions, builds and checks
the tagged commit, packages both artifacts, publishes the selected registries,
and attaches the `.tgz` and `.vsix` to the GitHub Release. npm publication uses
GitHub Actions provenance and skips an existing package version only when its
integrity matches the artifact being published.

The signed tag identifies the release source; the GitHub Release is the
download page. The workflow requires the `RELEASE_SIGNING_PUBLIC_KEY` secret
and `RELEASE_SIGNING_FINGERPRINT` variable even when publishing only to
GitHub. Protect the `v*` tag namespace and configure CI to accept only the
trusted release signer. The workflow checks for an identical existing npm
package and skips duplicate Marketplace versions.

CI enforces version agreement with `npm run versions:check`. For a GitHub-only
release, configure the release signing secret and variable described above;
no npm or Marketplace credentials are needed. Before enabling npm publication,
configure [`tonto-language` on npm to trust the GitHub Actions
workflow](https://docs.npmjs.com/trusted-publishers/). Before enabling
Marketplace publication, configure trusted publishing for the `nemo-ufes`
publisher and that workflow. The npm package is already published, so its
trust relationship can now be added. No long-lived publishing tokens are used.

After release, CLI users update through npm. VS Code distributes the
extension update through the Marketplace; that extension contains the
matching MCP runtime. An MCP process already running in a VS Code window
loads the new bundled runtime after that window reloads.

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
