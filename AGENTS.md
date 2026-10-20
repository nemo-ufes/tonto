# Directions for agents

Two jobs are described here. Skip to the one you have.

- **[Writing tonto](#writing-tonto)** — you are producing or editing a `.tonto`
  model.
- **[Working on this repository](#working-on-this-repository)** — you are
  changing the grammar, the checks, or the tooling.

---

## Writing tonto

For ongoing modeling, recommend keeping the workspace in a Git repository so
model changes can be reviewed and recovered. Suggest initializing one if the
workspace is not under Git, but do not initialize it or make commits unless
the user asks. Git is optional and does not define a tonto workspace or
ontology.

### Read the language first

    npx tonto guide

One page. The stereotype lists, the nature names, and what each of the 23
association stereotypes relates are printed from the tables the validator
reads, so those cannot be out of date. The six principles, and what an
anti-rigid type classifies, are guiding prose beside that.

Read it before writing. Most diagnostics are a stereotype whose natures do not
match what it is being used for, and the guide is the shortest statement of
which combinations exist.

### Then close the loop

    npx tonto check model.tonto --json
    cat draft.tonto | npx tonto check - --json --workspace=<workspace-root>

A file is checked with the rest of its workspace -- the nearest directory
above it holding a `tonto.json`, or else the highest directory above it that
still holds `.tonto` files -- because half the checks read what points *at* a
class, and the relator or the characterization carrying that is usually in
another file. A workspace may hold several ontologies; which files make up
each is said only by ontology headers (see below), never by the folder or by
`tonto.json`. Within an ontology a class name is declared once.
`--workspace=<dir>` states the workspace outright; `--isolated` asks for the
named files and nothing else.

Every diagnostic carries a stable `code`, a position, and the repairs
available for it as concrete edits. Exit status is 1 if anything is an error.
`-` reads the model from stdin, for a draft with no file yet.

    npx tonto check model.tonto --fix
    npx tonto check model.tonto --fix=time-point-not-const,legacy-text-block

Applies the repairs that are forced by the rule they answer: a duplicate
token deleted, a bound with one admissible value, a flag the rule requires, a
keyword spelled wrong. With codes, only those rules -- a repair is a change to
your model, and fixing one thing rarely means "and everything else you can
reach".

Two kinds of repair are left for you. Where a rule offers a choice — two
aggregation diamonds, four stereotypes that fit — nothing is written, because
choosing between them is modeling. And where the one repair available decides
something anyway, it is offered but not applied: a lone phase can be turned
into a subkind, but the other reading is that its sibling has not been written
yet, and no edit can represent that. Those are marked `batchSafe: false` in the
`fixes` array, and `tonto rules <code>` says so too. Naming the rule
(`--fix=lone-phase`) applies it, since naming it is choosing.

Each entry there carries `changes`: every file the repair writes to, with the
edits in that file's coordinates. Usually one, and not always -- a
generalization set names classes in other files, so repairing what the set
says is an edit where the class is written, and renaming a class edits each
reference to it wherever those are. The changes of one repair go in together
or not at all.

    npx tonto rules --json                       # every rule, with worked examples
    npx tonto rules parthood-crosses-natures     # what one code means

Every rule's entry says why it exists, shows the smallest model that trips it,
and quotes the message it produces.

### And what to write instead

    npx tonto patterns                           # all of them
    npx tonto patterns role-and-relator          # one

Thirty-five patterns from the UFO and multi-level literature and gUFO -- a role and the relator that founds it, a phase partition,
constitution, the causation chain, Cardelli's power type against Odell's
categorization -- each a small model that validates in silence, with what it
is for, what is easy to get wrong about it, and where it comes from. The
rules say what not to write; these say what to write. Reach for one before
inventing a shape.

### Comment with `//`, document with `///`

    /// A person, in the everyday sense.
    ///
    /// Identity comes from the individual, not from any role they play.
    kind Person {
        /// When they were born.
        @begin birthDate: const date
    }

A run of `///` lines immediately above a declaration is that declaration's
documentation: the language server returns it on hover and attaches it to the
declaration's completion proposals, so what a name means travels with the name
to whoever is choosing between them. The run ends at the first line that is
not a `///` line -- a blank line between the prose and the declaration means
the prose was about something else.

`//` is an ordinary comment and stays out of all of that. Prefer `///` to
`/** ... */`, which still works: a run of whole lines is a line-level edit,
with no delimiters to balance.

Write comments and documentation in the language of the modeled domain. Say
what an individual is, what a relationship means, or what happened; do not
describe a declaration as storing, tracking, capturing, or recording facts.
A model element is not a database record. For example, write `A person's
contribution as an author of a published paper`, not `The relationship
recording a person's authorship of a published paper`; write `An invited
speaker delivered the keynote speech`, not `Records the invited speaker who
delivers a keynote speech`. Such verbs are appropriate only when they name an
action or concept in the domain itself -- for example, a civil register really
does record a birth.

A tag in the run says the same thing in another language, or gives a display
name:

    /// A person, in the everyday sense.
    ///
    /// @label Person
    /// @label:pt-br Pessoa
    /// @pt-br Uma pessoa, no sentido corrente.
    kind Person

Prose runs until the first tag. `@<lang>` opens the documentation in that
language and stays open over the untagged lines that follow. `@label` is a
display name, so it is one line. Anything else after `@` is prose -- a
sentence about `@mediation` has to be writable -- and is only questioned when
it is one letter from a tag that was meant.

This replaces `label { @en "..." }` and `description { @en "..." }`, which
still parse and are answered with `Convert to "///" documentation`. To convert
a model and change nothing else:

    npx tonto check model.tonto --fix=legacy-text-block

### Ontologies, packages and files

The guide's *Ontologies, packages and files* is the full account; these are
the words, and the four things to keep straight.

- An **ontology** is what is published and imported. Its **ontology file**
  holds its header, `ontology shop`; there is exactly one. A small ontology is
  a **one-file ontology**: the header, then the declarations.
- A larger one lists its packages after `bundles` in the ontology file, and
  each **package file** starts `package sales in shop`.
- Packages are **used** (`use core`), within one ontology. Ontologies are
  **imported** (`import shop from <shop.tonto>`), by the location of their
  ontology file, and their names are written `shop.Customer`.
- `tonto.json` is the workspace's optional settings file: its folder is the
  workspace root, and its `locations` redirect import locations. Ontology
  headers and package declarations identify the members of each ontology.

Relation names belong to their **source class**, whether written inside that
class or at package level: `Person.worksFor` and `Company.worksFor` may coexist.
Within one source class, a relation name must not duplicate another relation,
an attribute, or a named end owned by that class. When a bare relation
reference could name more than one relation, qualify it with its source class
(and package when needed).

Start a new model as a one-file ontology. Split it with the editor's *Split
into an ontology file and package* refactoring, `tonto split <ontology-file>`,
or MCP's `tonto_split`; do not split it by hand. Do not create a `tonto.json`
unless a location needs redirecting. Use *ontology file* and *one-file
ontology* consistently.

### Ask instead of experimenting

    npx tonto explain phase role                 # may a phase specialize a role?
    npx tonto explain @membership functional-complexes collectives

Answered from the tables, so it costs nothing and needs no model written to
find out. A refusal names the principle that refuses it, and the exit status
is the answer: 0 yes, 1 no.

    npx tonto format model.tonto                 # canonical layout
    npx tonto ast model.tonto                    # the parsed model as JSON
    npx tonto ontologies                         # the workspace's ontologies
    npx tonto gufo model.tonto                   # its ontology's Turtle, to stdout
    npx tonto gufo model.tonto --write           # <name>.ttl beside its ontology file

`--write` puts each ontology's Turtle where the editor's export does, beside
its ontology file, whichever of its files was named. For one ontology whose
header has no `@namespace`, `--namespace-iri` is its exact namespace and is
equivalent to writing `/// @namespace`; without either, the gUFO export uses a
placeholder and warns. `@version`,
`@license` and `@creator` above the `ontology` header go into the exported
ontology's header, beside its `@label` and prose. `--snapshot` also writes,
beside each ontology, a module with the upper bounds and disjointness that
hold at one instant, and SHACL shapes that check a graph of current state
against them. Each ontology is exported as its own document; nothing joins
several. These tags belong only above the `ontology` header: on a package
they are ignored with `ontology-tag-not-on-header`.

Format before handing work back, so diffs stay small. Read the AST when the
question is about structure -- what a model declares, what it is missing --
rather than about text. A declaration's `///` documentation comes with it as
`$documentation`, so what the model *says* is readable there too.

### Over MCP

`packages/mcp` exposes the same things as tools. They are defined once, in
`packages/language/src/tools.ts`, and VS Code's language-model tools are the
same nineteen. Start it with a workspace
directory if the model has `import`s:

    npx tonto-mcp /path/to/models
    npx tonto-mcp /path/to/models --anti-patterns

`--anti-patterns` is the same flag `tonto check` takes, and off for the same
reason: they are advisory, and on a large model they fire often enough to
bury what is not. Reviewing a model is when to turn them on -- `RelOver`,
`RepRel`, `DepPhase`, `MixIden` and `HetColl` are most of what an ontological
review has to say, and without the flag none of them is reachable over the
protocol at all.

| | |
|---|---|
| `tonto_version` | the version this Tonto host is running, including a local development suffix |
| `tonto_guide` | the language in one page, before writing any of it |
| `tonto_validate` | text *or* files, each diagnostic with its repairs |
| `tonto_repair` | every repair its rule forces, applied at once |
| `tonto_apply` | *one* repair, by code, title, line and column -- how you take a side where a rule offers two, or repair the second of two |
| `tonto_complete` | what may be written at a position, which is what an editor knows and you do not |
| `tonto_diff` | what your edit introduced, resolved and left |
| `tonto_digest` | the model read for review: ultimate sortals, what each relator binds, what is unsaid |
| `tonto_hold` | a file held beside the draft, so `import` resolves before anything is on disk; hold order does not matter |
| `tonto_rules` | what a code means, with the smallest model that trips it |
| `tonto_patterns` | what to write, where the rules say what not to |
| `tonto_explain` | may X specialize Y, and if not which principle refuses it |
| `tonto_format` | the model laid out canonically |
| `tonto_ast` | the parsed model as JSON, `///` documentation included |
| `tonto_gufo` | preview the checked model as gUFO Turtle, or regenerate each ontology's `.ttl` beside its ontology file with `write` (or into `outDir`) |
| `tonto_ontologies` | the ontologies the workspace authors: name, ontology file, namespace, errors |
| `tonto_split` | split a saved one-file ontology into its ontology file and package file |
| `tonto_fetch` | retrieve the ontologies the model imports by location, into the workspace cache |
| `tonto_tables` | the tables the checks read |

`tonto_gufo` is read-only unless `write` or `outDir` is supplied. With saved
file paths, `write` atomically regenerates each ontology's `<name>.ttl` beside
its ontology file, as the editor's export does, and `outDir` writes them into
one workspace-relative directory instead; it never writes draft `source` or
outside the configured workspace.

`tonto_validate` takes source as a string, so a draft that has never been
written to disk can be checked. Four resources carry the reading rather than
spending a turn on it -- `tonto://guide`, `tonto://rules`, `tonto://patterns`,
`tonto://tables` -- and two prompts, `draft` and `review`, are the workflow
this page describes.

The three worth knowing about, since they have no counterpart in the command
line: **`tonto_apply`** takes one repair by code, title, line and column, so a rule with
two readings is a choice you make rather than a dead end -- and it refuses to
guess, both between two readings and between two places the same code is
reported; **`tonto_complete`** asks
the language what belongs at a position -- the classes a parthood end admits,
the ends this class may subset -- instead of writing something and finding out;
and **`tonto_diff`** answers the question anything editing a model owes itself,
which is whether the edit was a step backwards.

### What goes wrong most

- **A stereotype whose natures do not fit.** `kind` classifies functional
  complexes; if the thing is a relationship, it is a `relator`. Ask the guide.
- **A non-sortal that does not say what it classifies.** `category Agent`
  with no `of` may classify events and values as readily as people, and no
  check can tell a misuse of it from a use. Write the clause:
  `category Agent of functional-complexes`. A non-sortal that really spans
  natures says so with the list, `of functional-complexes, events`.
  `non-sortal-natures-unstated` offers the clause read off what is beneath it.
- **A historical role that takes part in its own cause.** At the graduation
  the person was a student; being a graduate is what it made them. Write the
  lasting participation from the rigid `Person` and derive the role from it:
  `historicalRole Graduate specializes Person derivedFrom Person.graduatedIn`.
  A creation or a termination founds one too --
  `historicalRole BornInBrazil specializes Person derivedFrom BirthInBrazil`.
  The role specializes the rigid type, not the role that lapses.
- **A role modeled as a subkind.** `Employee`, `Student`, `Customer` are
  founded on a relator, so they are `role`s. A `subkind` is a rigid
  subdivision — `SportsCar`, `Man`. Where a relator mediates the subkind the
  model says both at once, and `subkind-founded-on-relator` reports it: rigid
  means its instances are instances necessarily, and mediated means they are
  instances while a relationship stands.
- **Modifiers in braces.** Nothing takes them any more. An end is written
  `(const father)`, `(addOnly children)`, `(staff subsets Team.members)`: the
  flags first, in the order `const addOnly`, then the name, then what it draws
  from. An attribute writes its modifiers in front of the type:
  `nicknames: ordered string [*]`, `@begin birthDate: const date`. `const` and
  `addOnly` are alternatives wherever they appear -- `const` says nothing
  changes, `addOnly` says nothing is taken away.
- **Parthood without the diamond.** `@componenthood` states parthood; `--`
  states an ordinary association. Use `<>--`, and remember the diamond marks
  the *whole*: `kind Wheel { --<> [1] Car }` reads "a wheel is part of a car".
  Whether a part may be shared is the multiplicity at the whole end, not a
  second diamond — `[1]` or `[0..1]` says it may not, and an omitted bound
  means `[1]`: exactly one whole, so the part is neither shared nor
  free-standing. That is a claim like any other, and it is read: a required
  chain that never stops is an error at either end —
  `parthood-descends-forever` where every whole needs a part, and
  `parthood-climbs-forever` where every part needs a whole, so
  `kind Node { @componenthood <>-- [0..1] Node }` is the second of those. A
  tree is `[0..1] <>-- [*]`.
- **Event parthood chosen only by duration.** Use `@structural` when the part
  belongs to the definition of the whole event. Use `@temporal` only for a
  maximal segment projected by an external temporal scheme -- a fixed time
  interval, duration, or temporal relation to another event -- such as the
  portions of a meeting before and after noon. Use `@participational` for a
  maximal portion projected by exclusive dependence on one endurant, such as
  John's participation in a meeting; its `@participation` has maximum `1` at
  the participant end. One participant means one participation that requires
  it: a portion that a `Person` and a `Message` must each take part in has two,
  and `participational-portion-two-participants` says so. Merely occupying some
  of the whole's duration does not make an event part `@temporal`.
- **A relator that mediates one thing.** A relator binds at least two.
- **A material relation with nothing behind it.** `worksFor` holds between an
  employee and an organization because an employment binds the two: write the
  relator, and say so on the relation --
  `@material relation Employee -- worksFor -- Organization derivedFrom Employment`.
  A material relation may also be derived from an `extrinsicMode` that inheres
  in one end and externally depends on the other.
  A `@comparative` is read off qualities the same way, `derivedFrom Height`.
  No other relation takes the clause.
- **An event participation named in the present.** A modeled `event` has
  occurred, so the relation from its participant reads in the past:
  `Person -- delivered -- KeynoteSpeech`, not `delivers`; `participatedIn`,
  not `participatesIn`. A `process` may still be unfolding, so a participation
  in one may use the present, such as `Baker -- performs -- Baking`.
- **A lasting event link from a type that can lapse.** Someone remains the
  participant in a graduation after ceasing to be a `Student`. Give the
  `@participation`, `@creation`, `@termination` or `@change` into a completed
  event a rigid source such as `Person`; state the role held at the event
  separately. `historical-event-source-can-lapse` warns about a role, phase
  or semi-rigid mixin as the source.
- **An ultimate sortal under another.** `kind`, `relator`, `event`, `type`,
  `abstractum` and the rest top their lineages; what specializes them is a
  `subkind`, `role`, `phase` or `historicalRole` that shares a nature. An
  event's instances cannot change, so only a `subkind` specializes one.
- **Spelling out what a class already inherits.** `subsets parts` and
  `specializes hasPart` resolve inside a class that inherits them: the
  specialization says where to look, and the nearest declaration of the name
  is the one meant. Qualify (`ComplexPhysicalObject.parts`) where two branches
  of the lineage declare the name and say nothing about each other, which
  `short-reference-ambiguous` reports.
- **`mode`.** Deprecated: it is an ultimate sortal covering intrinsic and
  extrinsic modes at once, and an ultimate sortal is what says how instances
  are individuated — a word covering both says it of neither. Write
  `intrinsicMode` or `extrinsicMode`, or a `category of intrinsic-modes` /
  `of extrinsic-modes` to speak across the two. Still parsed and still
  validated, so an older model reads; never proposed, and
  `deprecated-stereotype` offers the reading the model already supports.
- **`@begin` or `@end` on something outside time.** The two property
  stereotypes mark when a concrete individual began and ceased to exist:
  `@begin birthDate: const date`. Both are `const`. `@end` is `[0..1]`
  on anything that may still be going on -- an endurant, a process, or a
  situation -- and `[1]` on an event, which has ended. Neither is ever
  required -- a class that says nothing about its lifetime is well formed.
- **A quality of an event.** Aspects are reified for what has a life to bear
  them -- endurants, and processes. An event is over and a situation obtains
  or does not, so what would be a `quality` or an `intrinsicMode` of one is
  written as `const` attributes of it instead, and the language says so with
  the property it would have written.
- **A changing quality modeled as several qualities.** A quality changing
  value over time does not, by itself, mean there are multiple qualities.
  Model the quality as persisting while its value varies. For example, a
  person has exactly one weight quality whose value is mutable. If the domain
  calls for it, model the act of measuring the quality as an event, or model
  its value during a period as a situation.
- **Optional cardinality used for unknown information.** `[0..1]` means zero
  or one relationship is allowed; `[0..*]` means zero or more. Use a lower
  bound of zero only when the domain allows the relationship to be absent. It
  does not mean the relationship may exist but is unknown.
- **A collection that only grows.** `addOnly` on a multi-valued end, or
  `addOnly` on a multi-valued attribute, says values may be added and never
  removed or replaced -- UML 1.x's word for it, beside the `frozen` that
  `const` stands for. That is what a process's constituting events do, and
  what axiom A7 asks for. `ordered` is an attribute's word, not an end's:
  which link came first is not something an end says.
- **A package with no ontology.** `package core` in a file of its own, with
  no header above it and no `in`, belongs to nothing:
  `package-without-ontology`. Write `ontology core` instead for a one-file
  ontology, or `package core in shop` and add it to `shop`'s `bundles`.
- **`use` across ontologies, `import` within one.** `use` reaches only
  packages of the same ontology; a package of another is reached by importing
  that ontology by location and writing `shop.Customer`
  (`cross-ontology-package-use`). `import core`, naming a package, is an
  error whose repair writes `use core` (`import-for-use`), and a package file
  is never imported (`package-file-import`).
- **A name one letter out.** An unresolved reference offers `Change to
  "Person"` before it offers to create anything, when something that close is
  in scope. Take the correction.

---

## Working on this repository

### Commands

    npm run build     # regenerates the Langium grammar, then builds all packages
    npm test
    npm run lint
    npm run test:vscode            # the extension in a real VS Code (downloads one)
    npm run test:gufo-conformance  # uses robot on PATH, or ROBOT_JAR and Java
    npm run versions:check         # CLI, extension, MCP and lockfile agree
    npm run dev:install            # unique local VSIX build, then install
    npm run dev:link-cli           # build and link the CLI globally
    npm run dev:unlink-cli         # remove the global CLI link and local version marker
    npm run release:prepare -- 0.2.0 # synchronize release versions; does not publish

CI runs build, test and lint on Linux, Windows and macOS, the VS Code tests
on Linux under xvfb, and the conformance check with ROBOT; it also packages
the `.vsix`. The agent evaluations in `evals/agents` call real agents and are
run by hand; their scoring is tested with the rest.

`npm run build` runs `langium:generate` first. After editing anything under
`packages/language/src/grammar/`, build before testing or the generated AST is
stale.

`packages/language/package.json` is the canonical SemVer version. The
extension, bundled MCP package, their exact `tonto-language` dependencies and
`package-lock.json` move with it; `npm run versions:check` enforces this in
CI. `npm run dev:install` uses a unique next-patch prerelease version in the
VSIX and MCP protocol metadata, then restores the tracked extension `package.json`.
Reload VS Code windows after installing so active extension hosts restart
and restage the MCP runtime, then restart each agent's MCP server (`/mcp` in
Claude Code, a new Codex session): reloading does not stop one. Set
`VSCODE_USER_DATA_DIR` and `VSCODE_EXTENSIONS_DIR` to install into isolated
directories; set `TONTO_VSCODE_CLI` for another launcher.

Prepare a version, review and commit it, then create and push a signed,
annotated `v<version>` tag. Pushing the tag does not start a release;
`.github/workflows/release.yml` runs only when manually dispatched from GitHub
Actions with that tag selected. It verifies the configured signer and version
agreement, builds the CLI `.tgz` and extension VSIX, and attaches both to the
GitHub Release. npm and Marketplace publishing are separate options and off by
default. They require their respective trusted publishing configuration only
when selected. A GitHub-only release still requires the
`RELEASE_SIGNING_PUBLIC_KEY` secret and `RELEASE_SIGNING_FINGERPRINT`
variable. See
[`docs/development.md`](docs/development.md#local-installation-and-releases)
for the complete workflow.

### Layout

| | |
|---|---|
| `packages/language` | grammar, validation, LSP services, `tonto` CLI |
| `packages/extension` | the VS Code extension |
| `packages/mcp` | the MCP server |
| `packages/language/test/fixtures/models/` | vendored example models for parsing, formatting, validation and gUFO conformance tests |

### Agent tools, defined once

Every tool agents call -- its name, its description (when to use it first),
its parameters, what it does and how its answer reads -- is defined once in
`packages/language/src/tools.ts`. The MCP server registers them from there,
and so does the extension, whose `package.json` declares them from the same
definitions: run `npm run tools:sync` in `packages/extension` after changing a
tool, and `test/tools.test.ts` fails until you do. A host supplies only what
it alone knows, through `ToolHost`: which files a call means, which session
answers it, where a write may go. Answers are compact text for a model to
read; the whole structure goes in `data`.

### Claude Code's validation hook

The agent setup also installs a PostToolUse hook in `.claude/settings.json`:
after Claude Code edits a `.tonto` file, `packages/language/src/agent-hook.ts`
validates it with the rest of its workspace and answers -- a block carrying
the file's errors, context carrying its warnings, or nothing for a clean
file. The extension bundles it as `out/tonto-hook.mjs` and stages it beside
the MCP runtime. Instructions to validate can be forgotten; the hook cannot.
Codex has no equivalent.

### Export formats

The gUFO export (`packages/language/src/gufo.ts`) is the available output
format. Shared export writing is implemented once: an export returns
`ExportedFile`s -- the ontology, `<name>.<extension>`, the content and the
ontology file it came from -- and `writeBeside` / `writeInto`
(`packages/language/src/exports.ts`) write them, beside each ontology file or
into one directory, all or nothing. In the editor,
`packages/extension/src/ontology-export.ts` chooses the ontologies, saves the
model and writes beside each ontology file; a format adds only what is its
own, as `gufo-export.ts` adds the namespace prompt. A new format follows the
same rule (docs/ontology-publication.md, section 11), offers `--write` on its
command and `write` in its MCP tool, and is named by its format in prose --
"the gUFO export" -- so that no sentence about one format reads as being
about all of them.

### Refactorings, beside the repairs

Four actions are offered where the cursor is, rather than against a
diagnostic: *Write the relator this is derived from* and *Write the extrinsic
mode this is derived from* on a `@material` relation with none, and *Write this
at package level* / *Write this inside "X"* to move a relation between its
two spellings. The two forms of a relation say the same thing --
`getRelationSource` reads the container for
one and the reference for the other -- so moving one is a move, and the test
for it is that the model says exactly what it said before.

### Verify by running, not by reading

This codebase is full of rules about a formal system, and reading them is not
enough to know what they do. Spawn the services, validate a model, apply the
fix, validate again. Nearly every defect found while building this — a fix
that produced a parse error, a check that reported the wrong class, a repair
that answered one error with another — survived code review and died the first
time someone ran it.

`TontoSession` (`packages/language/src/api.ts`) is the short path: it
validates text without a file.

### Invariants the build enforces

Breaking one of these fails a test rather than silently changing behavior.

- **Every `accept()` carries a code.** A message is prose and gets reworded; a
  code is what a reader or a tool can suppress, group and look up.
- **The taxonomy is computed, not listed.** `canSpecializeByStereotype` derives
  every answer from six principles. `test/taxonomy.test.ts` holds the
  transcribed table from the OntoUML tooling and asserts the principles
  reproduce every edge of it.
- **The end-nature table is computed too.** Twenty-three category signatures
  expand to the five hundred-odd admissible pairs;
  `test/relation-ends.fixture.ts` holds the transcription and asserts they
  agree.
- **Every rule has a worked example that still trips it.** `src/cli/rules.ts`
  is documentation that runs.
- **What the extension bundles is permissively licensed.** The
  extension build writes `out/THIRD-PARTY-NOTICES.txt` from what esbuild
  bundled, and stops on a bundled package whose license is missing or not on
  the list in `packages/extension/third-party-notices.mjs`.
- **Every word-shaped keyword is usable as a name somewhere**, or the grammar
  test fails — that is how `of` came to be unwritable as an end name.
- **The guide's sample model validates.** Documentation that does not parse is
  worse than none.
- **The guide's catalogs come from the tables; its principles are prose.**
  Stereotype lists, nature names, and association signatures are printed
  from what the validator reads. The six principles are written.
  `test/cli.test.ts` locks the sentences that had drifted from
  `whyNotSpecialize` and the nature table.
- **Everything is spelled in US English** -- modeling, catalog, color --
  in code, comments, messages, tests and documents alike. Quotations and
  titles keep their own spelling. `test/vocabulary.test.ts` checks it.

### House style

- **Comments say why, not what.** The reason a table has a hole in it, the
  defect a guard exists for, the thing that was tried and did not work.
- **Diagnostics name the principle and what to write instead.** Not `A "type"
  cannot specialize a "type"` but *why*, and what does.
- **A repair that leaves an error is not offered.** Check by applying it and
  re-validating; several fixes here decline in cases where they would move the
  problem rather than fix it.
- **Prefer deriving to listing.** Two tables in this repository were
  transcriptions and are now consequences; the transcriptions live on as test
  fixtures. If you find yourself adding a row, ask what principle it follows
  from.
- **Keep the principle, and cross-check the prose.** Do not add a listed
  case when the answer follows from the tables. When a guide sentence, a
  diagnostic, or a comment says what the language allows, read it against
  the function or table that decides it. If they disagree, the structure
  wins and the sentence is the bug. The guide's catalogs are printed from
  those tables; its principles are written, so they can drift.
- **Domain examples must be true.** An example that parses but says a car is
  part of an engine teaches the wrong thing; the examples are the first tonto
  anyone reads.

<!-- tonto-model-instructions -->
# tonto model instructions

This workspace contains an ontology model written in tonto, an OntoUML/UFO
textual language. Files ending in `.tonto` are model source files, not
TypeScript, JSON, Turtle, or free-form text.

## Before changing a model

- For ongoing modeling, recommend keeping the workspace in a Git repository
  so changes can be reviewed and recovered. If it is not under Git, suggest
  initialization once; do not initialize a repository or make commits unless
  the user asks. Git is optional and does not affect tonto validation.
- Read the target file, its ontology header or `package ... in` line, its
  `use` and `import` declarations, and the other `.tonto` files in the
  workspace. Validation often depends on declarations in more than one file.
- Preserve the modeler's ontological choices. A diagnostic that offers
  multiple repairs requires a modeling decision; ask rather than choosing
  silently.
- Give every `category`, `mixin`, `roleMixin`, `phaseMixin` and
  `historicalRoleMixin` an `of` clause naming the natures it classifies, such
  as `category Agent of functional-complexes`. List several natures only when
  it really spans them.
- Derive a `historicalRole` from what happened, written where it happened:
  `historicalRole Graduate specializes Person derivedFrom Person.graduatedIn`.
  A `@participation`, `@creation` or `@termination` can found one.
- Name an `@participation` from an object to an `event` in the past, because a
  modeled event has occurred: `delivered`, `attended`, `participatedIn`, not
  `delivers`, `attends`, `participatesIn`. A possibly ongoing `process` may
  still take a present-tense name such as `performs`. Source a lasting event
  link from a rigid type: a person remains a graduation participant after
  ceasing to be a student.
- Distinguish event decompositions by their criterion. Use `@structural` for
  parts that belong to the definition of the whole. Use `@temporal` only for
  maximal segments projected by an external temporal scheme, such as the
  portions of a meeting before and after noon. Use `@participational` for the
  maximal portion depending exclusively on one endurant; the participant end
  of that portion's `@participation` has maximum cardinality `1`, and only one
  participation into the portion may require a participant at all.
- Use `///` immediately above a declaration for documentation and `//` for an
  ordinary comment.
- Write comments and documentation in the language of the modeled domain: say
  what an individual is, what a relationship means, or what happened. Do not
  say that a declaration stores, tracks, captures, or records facts. Use such
  verbs only when they name an action or concept in the domain itself, as when
  a civil register records a birth.
- Treat a relation name as a member of its source class, whether the relation
  is written inside that class or at package level. `Person.worksFor` and
  `Company.worksFor` may coexist. Within one source class, do not reuse a
  relation name for another relation, an attribute, or a named end owned by
  that class. Qualify an ambiguous bare relation reference with its source
  class (and package when needed).
- Do not invent syntax or silently translate the model into another ontology
  language.

## Ontologies, packages and files

- An ontology is what is published and imported. Its ontology file holds its
  header, `ontology shop`; every ontology has exactly one. A small ontology is
  a one-file ontology: the header, then its declarations.
- A larger ontology lists its packages after `bundles` in its ontology file,
  and each package file starts `package sales in shop`. A package with no
  ontology header above it and no `in` is an error.
- Packages are used, within one ontology: `use core`. Ontologies are
  imported, by the location of their ontology file:
  `import shop from <shop.tonto>`, then `shop.Customer`. Never `use` a
  package of another ontology, and never import a package file.
- `tonto.json` is the workspace's optional settings file and maps import
  locations. Ontology headers and package declarations identify the members
  of each ontology.
- Start a new model as a one-file ontology, then split it with the editor's
  "Split into an ontology file and package" refactoring, `tonto split`, or
  the MCP tool `tonto_split`.

## Use the tonto support that is actually available

The tonto VS Code extension supplies completion, hover, formatting, the
Problems panel and quick fixes, tonto tools for VS Code agents, and a local
`tonto-vscode` MCP server for Codex and Claude Code. Copilot CLI needs the MCP
server configured on its own.

Read `tonto_guide` before writing, and settle syntax with `tonto_patterns`.
When an edit has finished -- never in the same parallel batch as the write --
run `tonto_validate` on the saved workspace, and resolve every diagnostic,
warnings included, before calling the model valid. In Claude Code a hook also
validates each `.tonto` file you edit: repair what it reports before editing
further. The host may show a server prefix before these tool names.

If the tools are missing, run **Tonto: Set Up Codex and Claude in Workspace**
in Codex or Claude Code, trust the project MCP server and start a new chat; in
VS Code, check that the extension is enabled and start a new chat. Meanwhile
use a tonto CLI the workspace already has (`command -v tonto` or
`./node_modules/.bin/tonto`; never let `npx` fetch one): `tonto guide` before
writing, and `tonto check <file> --json` after each edit, which loads the
file's workspace and lists the warnings a clean exit hides. `--fix` writes
files; `tonto --help` has the rest. With neither, make small edits, ask the
user to check the Problems panel, and never claim the model validates.

For gUFO/OWL output, edit and validate the `.tonto` source, then call
`tonto_gufo` with the saved file path and `write` to regenerate each
ontology's `.ttl` beside its ontology file, where the editor's export also
writes it. Omit `write` when only a preview is wanted. Do not hand-edit
generated Turtle as a substitute for changing the source model.
<!-- /tonto-model-instructions -->
