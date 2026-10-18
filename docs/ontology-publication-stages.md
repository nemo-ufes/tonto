# How ontology publication was built

The [publication specification](ontology-publication.md) says what the model
is. This page keeps the order in which it was implemented, stage by stage,
and the acceptance cases each stage was held to. It is history: later stages
changed decisions earlier ones made -- `import core` for a package, accepted
in stage 4, is an error now; per-package namespaces and an implicit grouping
of files without headers are gone -- and where they disagree, the
specification is right.

Earlier drafts called the ontology file a *manifest* or *entry document*, a
one-file ontology a *monolithic ontology*, and a location mapping a
*development mapping*. The current specification uses the terms in its
concept table.

## Stages and acceptance criteria

### Stage 1: ownership and local checking

Introduce an ontology ownership model independent of document storage. Apply
the implicit workspace default and validate classifier/member identifiers
without requiring a namespace. Build a complete owned-declaration index for
each ontology and filter package reference scopes through direct `use`
declarations. Retain package `use` declarations and aliases, remove the `global` declaration
modifier, and supply built-in datatype declarations through a language-defined
base scope. Package indexes also support bundle selection, provenance,
completion and missing-`use` repair discovery.

Acceptance examples include two unannotated local packages declaring one
`Person`, a generated relation/attribute identifier clash, and independent
same-named packages in two owned ontology contexts. Collision diagnostics
must appear and disappear after incremental edits without direct references
between the colliding declarations. A non-lowercase package name must check
with a warning, and its rename repair must leave every reference resolved.
Cross-package references within an ontology must require an applicable
`use`, including references between packages in the same document. Mutual
references must resolve when their direct `use` declarations are present. A
`use` must not re-export the used package's own `use` declarations or
ontology imports.
`global package` must no longer parse as a supported declaration, while
`global` remains usable as an ordinary identifier where the resulting grammar
permits it. Built-in datatype references must work without a `use`, an
import or a user-defined global package.

Completion and repair acceptance cases must cover:

- Visible declarations appearing in ordinary content assist; declarations from
  unused packages appearing only as clearly marked `use`-adding proposals.
- An exact reference to `Person` or `core.Person` in an unused package
  producing a missing-`use` diagnostic and a `Use "core"` quick fix.
- Applying that fix inserting a correctly placed `use`, preserving
  documentation and formatting, resolving the reference, and clearing the
  diagnostic after revalidation without introducing errors.
- A completion proposal atomically inserting its reference and `use`, with
  applicable document-level `use` declarations reused and duplicates avoided.
- Named member/end references finding the package that declares the element,
  aliases handled without shadowing, and ambiguous candidates requiring an
  explicit target selection.
- Identifier clashes diagnosed across unused packages, with no `use` fix
  offered as a repair for the clash.
- `use`-adding repairs excluded from automatic repair batches even when one
  candidate exists; candidate discovery performing no network access and
  introducing no ownership or bundle-membership changes.

### Stage 2: local ontology files, imports and export

Implement the ontology file and location-bearing import syntax with local source
locations. Load the complete owned set before linking. Apply ontology-level
public scopes, metadata inheritance, hash publication validation and export
ownership. Implement location mappings (section 7.1) for local targets, so a
URL import can be developed against a local copy before retrieval exists. Make
keyword-as-name handling, formatting, hover, completion, navigation,
CLI/API/MCP scope selection and the rule catalog understand the new
constructs as part of this stage.

Acceptance cases must cover:

- One ontology file selecting packages from arbitrary folders and from a document
  containing several packages, without absorbing unselected packages.
- Two ontologies with their own `core`, different namespaces and same-named
  classifiers; a cross-ontology reference requires an explicit import.
- A local ontology-file import excluded from the workspace default.
- Package and file reorganization preserving imported ontology-level references
  and RDF IRIs; `use` declarations, qualifiers and moved declarations'
  dependency bindings are updated where applicable, including through
  add-`use` fixes.
- Namespace conflicts, duplicate ownership, unassigned drafts and missing
  bundle members producing the specified errors.
- Adding the first ontology file preserving applicable `use` declarations and references
  between remaining drafts, reporting imports/references that cross the new
  ownership boundary, and recomputing semantic and collision diagnostics for
  both resulting sets.
- Withholding an unassigned-draft repair when moving a package would break
  outgoing or incoming references, conflict with metadata, or duplicate public
  identifiers. Every offered ownership repair must pass validation after
  application and remain `batchSafe: false`, even with one ontology file.
- `ontology`, `bundles` and `from` remaining usable as names, as the grammar
  test requires of every word-shaped keyword; the formatter writing one bundle
  entry per line.
- A URL import mapped to a local ontology file, checked as authored; a mapping
  published beside a dependency being ignored. Publication verification must
  ignore the workspace mapping too and must not reuse the mapped bindings.
- Cyclic references between packages, ontology import cycles and alias
  conflicts resolving without order-dependent bindings or scope leakage.
  A dependency's owned declarations must remain absent from the importer's
  unqualified scope, and one package's internal or external dependency imports
  must not become available to sibling packages through a shared index.
- A dependency's validation and exported content remaining independent of
  which downstream ontologies are open in the workspace.
- The worked example producing one ontology with distinct `Person.name`
  and `Product.name`, and no automatically generated umbrella.

### Stage 3: remote retrieval

Add HTTP(S) retrieval to the same resolver, behind the explicit fetch and
refresh operations of section 7.2. Preserve effective source URLs, keep the
workspace's retrieval record, deduplicate roots, and propagate retrieval errors
through their import chains. Extend location mappings to URL targets. All
front ends should obtain the same loaded model and diagnostics through this
shared service rather than implement separate loaders.

Use a local HTTP fixture server to verify remote loading, relative locations
after redirects, imports relative to package documents, cache reuse, cycles,
missing sources and aliases of one root. A remotely imported package
file must include only that document's packages. A remote dependency cache
must never join the authored default ontology. Direct `.tonto` requests must
work without HTTP content negotiation.

With the fixture server stopped, checking a fetched model must succeed from the
cache, and checking an unfetched one must report the missing location rather
than attempt retrieval. A change on the server must not affect checking until
a refresh, which must report it; a refresh interrupted part way must leave the
previous documents in use. Two releases of one namespace must be reported as a
conflict and may be resolved by a mapping for development; the original
conflicting closure must still fail publication verification.

Acceptance must also cover a mapping from release 1.2 to 1.3 that makes a
1.3-only reference pass development checking while publication verification
fails against the cached 1.2 source. If only the mapped target is cached,
publication verification must report the original location as missing.
`tonto fetch --publication` must retrieve the unmapped closure explicitly,
without changing development bindings or accessing the network during the
subsequent publication check. A valid unmapped closure must produce verified
output using its own dependency IRIs and declarations.

### Stage 4: ontology headers, member packages and `use`

Make the `ontology` header the start of every published ontology: a
one-file ontology's declarations follow it directly, and a packaged one has
inline packages, bundles or both. Add `package … in …`, the rules of
section 4.4 and `use`, keeping `import core` as an accepted spelling with a
rewrite. The starter model is a one-file ontology: the editor asks for an ontology
name and writes `ontology <name>` followed by a first declaration. The
refactoring of section 4.6 is offered on a one-file ontology's header.

Acceptance cases must cover:

- A one-file ontology checking, exporting and being imported with the same
  public names and IRIs as before splitting, and after.
- An ontology file with inline packages and bundles owning both; loose declarations
  beside either reported, and the wrapping repair leaving no error.
- Each member-package condition of section 4.4 reported with its code, each
  batch-safe repair resolving its diagnostic without introducing another.
- Packages declaring `in shop` with no ontology file checking together as a draft.
- `use core` and `import core` resolving alike; the rewrite repair changing
  only the keyword; add-`use` repairs writing `use`.
- `in` and `use` remaining usable as names.
- The split refactoring producing an ontology file and a member package that check
  without errors, with relative import locations still resolving.

### Stage 5: every package in a declared ontology

Remove implicit ontologies: the grouping of header-less packages by shared
document, package name or namespace, and `tonto.json`'s meaning that a
folder is one model. A package with no header above it and no `in` is
`package-without-ontology`, with the repairs of section 3. Importing a
document without a header is `ontology-file-required`. The rule catalog,
pattern catalog and API snippets are written as ontologies.

Acceptance cases must cover:

- A header-less package reported in development and publication alike, with
  a `tonto.json` present or not, and each of its repairs leaving no error.
- Two header-less documents whose packages share a name or a namespace staying
  apart, and a `use` between them reported, not joining them.
- A location import of a header-less document reported at the import.
- `tonto.json` mappings working as before.

These stages describe the implemented dependency ordering and its acceptance
criteria. The [gUFO mapping](gufo-mapping.md) specifies the RDF encoding over
these ownership boundaries. Add-to-`bundles` repairs are offered only where a
package already declares its owner with `in` (section 4.4); other ownership
changes remain explicit edits to an ontology file.
