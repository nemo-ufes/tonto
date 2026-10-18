# Ontology ownership, imports and web publication

Status: implemented publication model. The parser supports `ontology`
headers for one-file and packaged ontologies, `bundles`, member packages
(`package core in shop`), package use (`use core`) and location-bearing
imports. CLI, API, MCP and editor services use ontology ownership for
checking, visibility and the gUFO RDF export. Location mappings live in
optional `tonto.json`; explicit retrieval writes a workspace-local
`.tonto/` cache. An ontology file determines which packages can be published;
unbundled packages remain drafts (section 3). The order in
which this was built, and the acceptance cases of each stage, are kept in
[How ontology publication was built](ontology-publication-stages.md).

Typical workflow:

```sh
npx tonto fetch shop.tonto --workspace=.
npx tonto check shop.tonto --workspace=.
npx tonto fetch shop.tonto --workspace=. --publication
npx tonto check shop.tonto --workspace=. --publication
npx tonto gufo shop.tonto --workspace=. --publication --write
```

Omit fetch when every dependency is local. Use `--refresh` for an explicit
cache update. `TontoSession({ workspace, locations, publication })` exposes
the same modes through `fetch`, `validateFiles` and `gufoFiles`; MCP exposes
`tonto_fetch` and publication options on checking/export. VS Code offers
Fetch Ontology Dependencies, Refresh Ontology Dependencies, and Export to
gUFO. Export runs directly unless an import uses a configured substitute;
then it asks whether to use the substitute or the original import for a
verified publication export. If an original remote import is missing from the
publication cache, the user can explicitly download it and continue.
Checking, completion, hover, formatting and export never access the network
without that explicit download action.

Cache snapshots are `.tonto/development.json` and `.tonto/publication.json`;
each cached source includes its requested, mapped and effective location,
retrieval timestamp and SHA-256 digest. These are workspace state, not
committed lockfiles. API/MCP and JSON exports identify successfully checked
unmapped exports with `publicationVerified: true`.

## 1. Purpose

A tonto package is an authoring unit for related declarations.
A published ontology can comprise many such packages. An ontology supplies
the stable public namespace; packages and source files organize its contents.

The design has these requirements:

- A simple workspace needs no configuration file, special filename or
  folder layout.
- A one-file ontology is one document: an `ontology` header followed by
  its declarations, with no package to name.
- Every published package belongs to an ontology that a document declares.
  Identifier clashes are checked within each ontology before publication or
  namespace assignment.
- A workspace can contain several ontologies.
- Identifiers are unique across an ontology, while `use` declarations declare
  architectural dependencies and control which internal declarations a
  package can reference. Ontology imports declare external dependencies.
- Completion respects those `use` declarations. References to declarations
  in unused packages of the ontology offer an explicit add-`use` quick fix.
- An authored `.tonto` ontology file can enumerate an ontology's packages
  and their source locations. Publication requires no generated source bundle.
- Importers use ontology-level names that survive internal package changes.
- Explicit document URLs support static hosting without HTTP content
  negotiation. Package documents can live in arbitrary directories.
- A workspace can substitute a local or alternative source for an imported
  location without editing the import.
- Publication verification resolves dependencies without workspace location
  mappings, so development substitutions cannot conceal broken public imports.
- Network retrieval happens only when requested. Checking never retrieves,
  and a model checked once checks the same way until its sources are
  explicitly refreshed.
- The initial web-publication profile uses hash namespaces.

The words MUST, SHOULD and MAY distinguish required behavior, recommended
conventions and permitted alternatives within this design.

## 2. Concepts and names

These are the words the specification, the diagnostics, the editor and the
guides use, each for one thing.

| Concept | Meaning | Example |
|---|---|---|
| Ontology | What is published and imported: a set of packages with one namespace and one version | `shop` |
| Ontology header | The `ontology` line that declares an ontology, with the `///` documentation and metadata above it | `ontology shop` |
| Ontology file | The one file holding an ontology's header, which an import names | `shop.tonto` |
| One-file ontology | An ontology file whose declarations follow the header directly, with no packages | `ontology shop` then `kind Product` |
| Package | A named part of an ontology, which organizes its declarations and their visibility | `commerce.sales` |
| Inline package | A package written in the ontology file, after its header | `package core` under `ontology shop` |
| Package file | A file holding a package of its own, a *member package*, which says which ontology it is in | `package sales in shop` |
| Bundle entry | One item of the header's `bundles` list: a package and the package file holding it | `sales from <commerce/sales.tonto>` |
| Use | Permission for one package to refer to another of the same ontology | `use catalog` |
| Ontology import | A dependency on another ontology, by the location of its ontology file, under an alias | `import people from <people.tonto>` |
| Import alias | The qualifier the importing author chooses for that ontology's names | `people.Person` |
| Workspace | The folder whose `.tonto` files are loaded and checked together; it may hold several ontologies | a project folder |
| `tonto.json` | A workspace's optional settings file. Its folder is a workspace root, in the editor as on the command line, and it holds that workspace's location mappings | `{ "locations": { … } }` |
| Location mapping | A redirection of an import location to another one, such as a local copy | `"https://w3id.org/ufo-l/": "../ufol/"` |
| Ontology IRI | The ontology's public identity | `https://example.org/shop` |
| Namespace | The prefix used to mint its term IRIs | `https://example.org/shop#` |

Packages are *used*, ontologies are *imported*. An ontology header identifies
the ontology; the folder and `tonto.json` determine the workspace, not which
files belong to one ontology.

Ontology names, package names and import aliases are lowercase. This
means the complete spelling, not merely the first character. `shop`,
`legalpersons` and `legal_persons` follow the convention; `Shop` and
`legalPersons` do not. Names remain case-sensitive; the resolver MUST NOT
silently lowercase names.

While a model is edited and checked, a name that breaks the convention is a
warning offering the lowercase rename, applied to every reference. Existing
models with such names keep checking. Publication of an ontology that owns
such a name, or that declares or imports under such a name, is refused.

An ontology name and an ontology import alias are single tonto identifiers.
A package name MAY have dot-separated segments, each lowercase:

```tonto
package commerce.sales
```

The existing identifier character repertoire is retained. Lowercase naming
does not impose an ASCII-only restriction. Human-facing labels can use
ordinary capitalization, for example `/// @label Shop`.

Classifiers and members retain their existing naming conventions: this
lowercase rule applies to ontology/package names and aliases, not to
`Person` or `hasComponentWheel`.

Package names MUST be unique within their owning ontology. Different
ontologies MAY each contain `core` or `commerce.sales`. A single package
cannot be spread over several declarations and silently merged.

A dotted name is one complete package name. `commerce.sales` neither
requires a package named `commerce` nor inherits its imports. Importing
`commerce` does not import `commerce.sales` or its siblings. Package names
identify bundle entries, authoring groups and the targets of `use`
(section 6.1); they do not participate in public term identities.

Matching folders are a useful convention, not a resolution rule:

```text
commerce/sales.tonto    package commerce.sales
commerce/returns.tonto  package commerce.returns
```

The ontology name, package names, filenames and aliases MUST NOT contribute
to public term IRIs. The namespace and the term's structural name determine
those IRIs. An ontology name is an authoring/tooling name; the namespace is
its public identity. An import alias need not match the declared name.

## 3. Package ownership and unbundled drafts

An ontology exists because a document declares it with an `ontology` header
(section 4). A package can be:

- written in an ontology file after its header: an inline package;
- selected by a bundle entry of its ontology file, and saying so with `in`:
  a member package (section 4.4);
- saying `in shop` while the workspace holds no ontology file for `shop`: an
  unbundled draft associated with that name, checked with other packages
  that say the same and never published (section 4.4, rule 3).

A package with no `ontology` header above it and no `in` belongs to no
ontology. That is an error, `package-without-ontology`, reported at its
name. Nothing else implies an ontology: not a folder, a file name, a shared
package name, a shared `@namespace` annotation, a `use` or a `tonto.json`.
Until the error is repaired, the packages of each such document are checked
together, unbundled, so their declarations still receive every
other check; a `use` in them reaches only packages of the same document. The
repairs say which ontology the package belongs to, a modeling choice, so
none is `batchSafe`:

- In a document with one package, an undotted name and no `use`, the package
  becomes a one-file ontology: `package sales` becomes `ontology sales`,
  with the same declarations (section 4.1).
- An `ontology` header written above the document's packages makes them its
  inline packages (section 4.2). The header is named after the document,
  lowercased.
- For each authored ontology file that bundles packages, the package can
  join that ontology: the repair writes `in shop` after its name and adds its
  bundle entry to the ontology file.

Common ownership determines identifier uniqueness, not automatic visibility: a
reference to another package's declaration requires an applicable `use`
(section 6.1). A `use` never changes ownership. To use packages in separate
documents as one ontology, bundle them from one ontology file. Otherwise import the
other ontology by location.

No namespace or version is required merely to edit or check an ontology.
The ontology name is an authoring name; it MUST NOT be inferred as a public
identifier, and filenames never are.

For example, two ontologies may each declare `Person`:

```tonto
// people.tonto
ontology people
kind Person
```

```tonto
// customers.tonto
ontology customers
kind Person
```

They are distinct ontologies with distinct namespaces. Two packages bundled
by one ontology file may not: both classifiers would publish as `Person` in the same
namespace, and the clash is reported during ordinary checking (section 9).

Dependencies loaded through ontology imports, including imports from local
ontology files, retain their own ownership. Cache location and physical
presence under the workspace directory do not make dependency packages
members of an authored ontology.

The built-in datatype package is a language dependency and never a member
of an authored ontology.

## 4. Ontology files

An ontology is declared by an ontology file that begins with an `ontology`
header. The header names the ontology and carries its documentation and
metadata. What follows the header says which form the ontology takes.

### 4.1 One-file ontologies

A one-file ontology is one document holding all its declarations directly
under the header, with no package:

```tonto
/// Products and their prices.
///
/// @namespace https://example.org/shop#
ontology shop

import tax from <tax.tonto>

kind Product {
    price: number
}

role TaxedProduct specializes Product
```

This is the starting form for most ontologies, and the form a new starter
model takes. The loose declarations form the ontology's only package, which
has no name: nothing else can `use` it, since nothing else can be a member of
a one-file ontology, and an importer writes `shop.Product` through its own
import alias in any case (section 6.2). Diagnostics and tooling identify
these declarations by the ontology's name.

Ontology imports may appear after the header among the declarations, or
before it; either way they apply to the loose declarations.

A one-file ontology is closed. Its membership is its one document: a
package elsewhere that declares itself `in shop` is an error (section 4.4).

### 4.2 Packaged ontologies

A packaged ontology lists its packages after the header. A package written in
the ontology file is a member by being there. A package in another document
is a member by a bundle entry, which names it and gives its location:

```tonto
/// @namespace https://example.org/shop#
ontology shop bundles
    catalog from <catalog.tonto>
    commerce.sales from <commerce/sales.tonto>

package core

kind Person
```

The members of `shop` are `core`, written inline, and the two bundled
packages. The ontology file is complete: its inline packages and bundle
entries are the ontology's entire membership. Either part may be empty, so
a single-file packaged ontology has only inline packages and a typical
multi-file one has only bundles.

An ontology has one form or the other. A loose declaration beside a package
or a `bundles` clause is an error, `ontology-loose-declarations`: the loose
declarations would be a package without a name, which no other package can
`use`. Its repair wraps them in a package named after the ontology, which the
author can rename. Turning a one-file ontology into a multi-file one is the
refactoring of section 4.6.

### 4.3 Syntax

```ebnf
EntryDocument  = { OntologyImport }, OntologyHeader,
                 ( OntologyBody | [ Bundles ], { Package } ) ;
OntologyHeader = "ontology", Name ;
Bundles        = "bundles", BundleEntry, { BundleEntry } ;
BundleEntry    = QualifiedName, "from", "<", RelativeDocumentPath, ">" ;
OntologyBody   = { OntologyImport | Declaration } ;
Package        = "package", QualifiedName, [ "in", Name ],
                 { PackageUse | OntologyImport | Declaration } ;
PackageUse     = "use", QualifiedName, [ "as", Name ] ;
OntologyImport = "import", Name, "from", "<", DocumentLocation, ">" ;
```

`Name` and `QualifiedName` refer to tonto's identifier syntax, subject to
the lowercase rules in section 2. `DocumentLocation` is a nonempty URI
reference. `RelativeDocumentPath` has no scheme, leading slash, query or
fragment and resolves against the ontology file. Bundle sources belong to
the ontology declared there; another ontology is reached through `import`.
Locations name documents and MUST NOT contain fragments. `in` and
`use` are soft keywords: both remain usable as names.

Bundle entries have no separator; each ends with its location. The formatter
writes one entry per line, so adding or removing a package is a one-line
edit. A `bundles` clause lists at least one entry.

A document holds at most one ontology header. A package-source document
holds packages and no header.

Every bundle entry MUST specify `from`. There is no implicit mapping from
`commerce.sales` to `commerce/sales.tonto`, directory scan, glob or recursive
inclusion rule. Shorthand locations can be considered separately later.

Each bundle entry selects exactly one package with the declared name in the
retrieved document. Its spelling is the actual package name, not a rename.
A source document MAY contain several packages; only explicitly selected
packages become members of this bundle.

Repeated package names, a missing selected package, or several matching
package declarations are errors. Retrieving a file with a different package
name MUST NOT be treated as a successful bundle entry.

### 4.4 Member packages

A package in a document of its own states the ontology it belongs to:

```tonto
package catalog in shop

kind Product
```

`in shop` states membership, not completeness. Only the ontology file says
what the whole ontology is. These rules connect the two statements:

1. A package selected by a bundle entry MUST declare `in` with the bundling
   ontology's name before publication. A missing owner is
   `package-file-without-in`, a warning while editing and an error in
   publication verification, whose repair adds it; a different name is an
   error, `package-in-mismatch`, whose repair corrects it. Both repairs
   are batch-safe: the ontology file has already decided the membership.
2. A package that declares `in shop` but that no bundle of `shop` selects is
   an error, `package-not-bundled`, when the workspace holds an ontology
   file for `shop`. When `shop` is a one-file ontology, the message says so; it
   cannot bundle anything until it is split (section 4.6). Otherwise the
   repair adds a bundle entry for the package to the ontology file. It is
   `batchSafe: false`, as every repair that changes membership is
   (section 5).
3. When the workspace holds no ontology file for `shop`, the packages that
   declare `in shop` are the unbundled packages of `shop`. They check
   together, so their identifiers are compared and they can `use` one
   another, and each reports the missing ontology file,
   `ontology-file-missing`: a warning while editing, an error under
   publication. Unbundled packages are never published.
4. Inside the ontology file, an inline package needs no `in`: writing
   `package core in shop` under `ontology shop` is a warning,
   `package-in-redundant`, whose repair removes the clause. An inline
   package that names a different ontology is `package-in-mismatch`.
5. A member's document cannot be imported as though it were the ontology.
   A location import that selects a document whose packages declare `in` is
   an error, `package-file-import`, which asks for the ontology file's
   location instead.
6. `in` names an ontology by its authoring name, which is not a public
   identity (section 5). The authored ontology files of one workspace
   therefore need distinct ontology names; two of them with one name are an
   error, `ontology-name-clash`, at both headers. A bundled package's `in` is
   checked against the ontology file that bundles it, whatever else is loaded.

Membership is exhaustive and non-transitive: a reference to a declaration
does not add its package to the bundle. A declaration from an unlisted package
is absent from the ontology's owned declaration index, even if that package
happens to be loaded in the workspace. A `use` controls visibility within the
existing ontology; it does not expand membership or retrieve another file. A
reference to another ontology's declaration requires an ontology import; it
does not incorporate that declaration.

### 4.5 Metadata belongs to the ontology file

The ontology file supplies the public namespace and the ontology's
metadata (section 8). Imports never infer ownership, and filenames and
package names never determine term IRIs.

### 4.6 Splitting a one-file ontology

A one-file ontology outgrows one document by becoming an ontology file that
bundles one package. The editor offers this as a refactoring, *Split "shop"
into an ontology file and package "core"*, on the `ontology` header of a one-file
ontology.
It:

1. creates a document beside the ontology file, named after the new package, that
   starts `package core in shop`;
2. moves into it every loose declaration and every ontology import, with the
   comments and documentation between them, in their written order;
3. leaves the header, its documentation and metadata in the ontology file,
   followed by `bundles` and the one bundle entry `core from <core.tonto>`.

The new package is named `core` (`core2`, `core3` and so on when a document
of that name exists). Renaming it afterward updates the bundle entry. Since
the new document sits beside the ontology file, relative import locations still
resolve. No public identifier changes: an importer's `shop.Product` names the
same declaration, with the same IRI, before and after (section 13).

### 4.7 Adding a package

A package's membership is two statements in two files: `package sales in
shop` in its package file, and `sales from <sales.tonto>` in the ontology
file's `bundles`. The editor's **New Package...** command writes both in one
edit. It lists the workspace's ontologies (one is chosen without asking), asks
for the package's name -- lowercase, not already a package of that ontology --
and writes the package file in the ontology file's folder, or in the folder
the Explorer was asked about, with its location relative to the ontology file.
A one-file ontology bundles nothing, so it is split first (section 4.6), in
the same edit and after asking. **New Ontology...** writes a one-file
ontology, `ontology <name>`, in a file named after it.

## 5. Workspaces, several ontologies and unbundled packages

The workspace is the folder whose `.tonto` files the CLI, API, MCP or editor
load and check together. Directory discovery can find it, but once chosen it
MUST not change because another file is opened. Discovery from a file takes
the nearest ancestor directory holding a `tonto.json`; without one, it takes
the highest ancestor still holding `.tonto` files. The editor's workspaces
are the folders it opens and, beneath them, every folder holding a
`tonto.json`, so a file is checked in the same workspace whether the editor
or the command line reads it. Each workspace keeps its own location mappings
(section 7.1) and its own retrieval cache (section 7.2), and its ontology
names need only be distinct from each other. A `tonto.json` holds location
mappings; it says nothing about which packages form an ontology.

A workspace MAY contain several ontology files. Each determines its own
package set, public scope and namespace. Ontology files are independent
roots; opening them together does not create an umbrella ontology. Within one
workspace their ontology names are distinct (section 4.4).

The same source package MUST NOT be owned by two ontologies. Ownership
checks identify a source package by its resolved document and declaration,
not by the package name alone. Two different source packages both named
`core` are valid when owned by different ontologies.

Shared concepts should be placed in one ontology that the others import.
Copying or rebundling a package into another ontology is not an import.

Packages that no ontology file bundles are *unbundled*: those that say
`in shop` while the workspace holds no ontology file for `shop`, which check
together as the packages of `shop` (section 4.4), and those of a document
that declares no ontology, which are an error already and check together
with the other packages of their document (section 3). The same resolution
and checking rules apply to them:

- `use` among the unbundled packages of one ontology controls visibility
  (section 6.1), while the identifier checks of section 9 apply across them.
- Semantic validation of them sees them and the ontologies they import by
  location (section 10).
- They reach an ontology only through a location-bearing import of its
  ontology file, as any importer would. An unqualified reference cannot
  cross from an unbundled package to a bundled declaration or in the
  opposite direction.

Unbundled packages are never published. `ontology-file-missing` is a warning
while editing, so a package can be written before its ontology file, and an
error under publication. Checking or publishing a selected, complete
ontology need not fail because unbundled packages exist elsewhere in the
workspace.

An import selects an ontology file; a document without an `ontology` header
cannot be imported (section 7).

Different ontology roots MUST NOT silently publish into the same namespace.
An explicit bundle is how packages combine into one ontology. Multiple
aliases of the same already resolved root refer to one ontology instance;
two independent ontology files claiming the same namespace require a
conflict diagnostic unless a location mapping (section 7.1) makes them one
root.

Ontology names alone do not establish identity. Independently imported
ontologies may have the same declared name and different namespaces; their
importers distinguish them through aliases. Tool selections must use an
ontology-file location when a name is ambiguous.

## 6. Package visibility, ontology imports and content assist

### 6.1 Package use

An ontology owns one identifier namespace, but each package has its own
reference scope. A package's own declarations are directly visible. Other
packages' declarations are visible only through an applicable `use`. The
distinction is architectural: `use` explicitly permits a dependency without
changing the used declaration's public identity.

For example, if `shop` owns a `core` package declaring `Person`, its
`commerce.sales` package can write:

```tonto
package commerce.sales in shop

use core

role Customer specializes core.Person
```

`use core` exposes `core.Person` and its unqualified name `Person`, subject
to existing reference-type restrictions. An alias provides an additional
package qualifier:

```tonto
use commerce.sales as sales
```

This allows `sales.Customer` as well as the package's full qualifier. Named
member handles use their semantic owners, such as `Car.hasComponentWheel`
when the relation was explicitly named that way. Class-local and nearest
inherited-member lookup retain their existing rules; `use` does not flatten
class members into unqualified top-level names.

`use` is resolved only within the current ontology. It does not search other
ontologies or infer a source-file location. The package must already be
owned by the current ontology, whether an inline member or a bundled one. Using it does not change either ownership or membership. The
unnamed package of a one-file ontology cannot be used, and need not be:
it is the ontology's only package.

`use` is direct and non-transitive: if `a` uses `b`, and `b` uses `c`, `a`
still needs its own `use c` to reference `c`'s declarations. The ontology
import aliases used inside `b` are not re-exported either. Parent packages and
sibling packages have no special visibility. References between packages can
be cyclic when the necessary `use` declarations exist. This does not prevent
using inherited members already made available through a class's ancestry
under the language's existing member-lookup rules.

A `use` inside a package applies only to that package. A document-level `use`
applies to the packages declared in that document. A package does not see
another package's declarations merely because both are in the same file; it
still needs an applicable `use`. Using a different package in the same file
is therefore not redundant. Using one's own package is redundant. Duplicate
and unused `use` declarations remain diagnosable.

Packages are used and ontologies are imported. The two operations differ in
kind: `use` grants visibility inside one ontology, `import … from <…>` brings
in another ontology (section 6.2). `import core`, naming a package, is an
error, `import-for-use`, whose batch-safe repair rewrites the keyword as
`use`; it is parsed only so that the error can say which word was meant.

All owned packages must be indexed before linking, so loading order never
determines availability. The complete index is used for ontology-wide
identifier validation and content assist; reference resolution filters it
through the current package's applicable `use` declarations. Two classifiers
named `Person` in different owned packages remain an error even when those
packages do not use one another. A `use` or qualifier cannot repair that
identifier clash.

User-defined `global` packages are removed. Every user-defined cross-package
dependency needs an explicit `use`; no package can grant its declarations
automatic visibility elsewhere by marking itself global.

Built-in datatypes such as `string`, `number` and `date` remain implicitly
available through a language-defined base scope. They may still be represented
as datatype AST declarations in a virtual document, but their visibility MUST
NOT depend on a `global` package modifier exposed in the language. They remain
excluded from authored bundles and generated ontology content.

### 6.2 Ontology imports

An import loads another ontology through its ontology file and binds its
public scope under an alias:

```tonto
ontology books

import shop from <https://example.org/shop.tonto>

subkind PrintedBook specializes shop.Product
```

It does not incorporate the imported ontology's packages into `books`.

The name before `from` is the locally chosen alias. It need not match the
ontology's declared name. Import aliases have no effect on RDF identity.

The same operation supports local development:

```tonto
import shop from <../shop/shop.tonto>
```

Ontology imports can occur at document or package level, and among a
one-file ontology's declarations. An import inside a package applies to
that package. A location-bearing import in a bundled ontology's ontology
file applies to all its inline and bundled packages. A document-level
import in a bundled source applies only to packages in that source document;
imports in one bundled source are never inherited by sibling sources. A
document-level `use` in the ontology file remains local to it.

`use` does not propagate ontology import aliases. If two packages each
reference `people.Person`, they may share an import in their ontology file,
or each have an applicable local import. A local import cannot reuse an alias
already declared by the ontology file. Moving a declaration with an internal or
external dependency may require moving or adding its `use` or local imports
at the destination. Internal references to the moved declaration may also
need `use` updates; external ontology-level references retain their identity.

The ontology file uses ordinary ontology imports as shared dependency declarations.
Its direct ontology dependencies are the union of these imports and the
location-bearing imports in its member packages and source documents.

An importing package sees the imported ontology's owned declarations through
the alias. Classifiers are exposed directly as `shop.Product`, regardless of
which package declares them. Named members and named association-end handles
are exposed through their semantic owner, for example
`shop.Customer.buys` or `shop.Car.wheels`, subject to existing reference-type
rules. Package names remain available as provenance in tooling; there is no
public package path such as `shop.commerce.sales.Customer`.

Association-end handles do not mint RDF resources. An unnamed relation's
generated RDF member name does not automatically become a new tonto source
reference handle. Existing rules for named relations and ends still apply.

Ontology imports do not introduce unqualified classifier names. Dependencies
are loaded transitively for linking, but their public scopes are not
re-exported: importing `shop` does not bind an alias for `people`, even if
Shop depends on People. To write `people.Person`, the referencing package
must import People itself.

Two different import bindings with the same alias, or a binding that conflicts
with an available package qualifier, are errors. The implementation MUST NOT
resolve the ambiguity by choosing whichever document was loaded first.

The resolver MUST NOT expose a dependency's declarations through the current
ontology's internal package scope. Its declarations are reached through
the applicable ontology import alias.

### 6.3 Completion and add-`use` quick fixes

Ordinary completion prioritizes declarations in the current package, the
packages it uses, applicable ontology imports, and the built-in base scope.
Suggestions respect the reference's required element type and the existing
class-local/inherited-member rules. The editor must not imply that an unused
package's declarations are already in scope.

Content assist MAY additionally offer declarations from unused packages of
the same ontology.
Such proposals MUST identify their package and clearly state that accepting
them adds a `use`. Acceptance applies the reference text and the necessary
package-local `use` as one edit operation, for
example through completion `additionalTextEdits`. Merely requesting
completion never changes the model or retrieves a document from the network.

When an unresolved reference matches a declaration in an unused package of
the same ontology, validation MUST identify the missing package dependency, with the
stable code `missing-package-use`, and offer a quick fix to add the `use`
when a valid edit exists under the safeguards below. This applies to unqualified references such as `Person` and
package-qualified references such as `core.Person`.
For example, given `Person` in package `core`, a package containing
`specializes core.Person` without an applicable `use` offers `Use "core"`.
The lookup must also cover named member and association-end handles wherever
the reference type admits them, using the package declaring the referenced
element rather than assuming it is the classifier's package.

The fix inserts `use core` in the referencing package's `use` section,
creating that section if necessary. It preserves the reference text when
that spelling will resolve, reuses applicable document-level imports, avoids
duplicates, and keeps formatting and adjacent documentation intact. If an
alias or a change to the reference is necessary, the proposal previews those
edits together; it must not silently shadow an existing qualifier.

Candidate discovery uses the complete owned-package index but does not bind
the reference until the `use` is present. A declaration with an exact name
and compatible reference type must be considered before offering to create
a new declaration. Missing-`use` diagnostics must be distinguishable by a
stable code from a declaration that cannot be found anywhere in the ontology.
If several viable candidates exist, proposals identify each declaration and
its declaring package for explicit selection. Using a package must never be
presented as a remedy for an ontology-wide identifier clash.

Every offered `use` edit must resolve its target reference without
introducing new parsing, linking, alias or model-validation errors in the
affected scope. Completion acceptance and quick-fix selection are explicit
architectural choices. `use`-adding repairs are `batchSafe: false`, even
when only one candidate exists; an automatic repair batch must not create
package dependencies merely to silence unresolved-reference errors.

This discovery is limited to the current ontology's owned packages. It must
not offer a `use` for a package from another ontology,
silently extend a bundle, or fetch an unknown package. Dependencies on other
ontologies retain the explicit ontology-file import of section 6.2.

## 7. Locations and remote resolution

A location-bearing import explicitly selects its ontology file. The resolver
MUST NOT derive the location from an ontology name, package name or namespace.

An import selects an ontology file with an `ontology` header (section 4):
a one-file ontology, or a packaged one whose inline packages and bundle
entries supply membership. A document whose packages declare `in` is a member
of another ontology and cannot be imported as one (`package-file-import`,
section 4.4). A document with no header declares no ontology, and importing
it is an error, `ontology-file-required`, at the import.

A remote importer cannot discover the publisher's local workspace. An
imported ontology comprises exactly what its ontology file declares: its inline
packages and the sources its bundle entries name. The importer does not
search for extra files, and HTTP directory listings are never used to infer
membership.

Relative locations use normal URI-reference resolution against the document
containing the location. The base is the document's effective retrieval URL
after redirects. Namespace metadata does not change that base. This rule
follows [RFC 3986, section 5](https://www.rfc-editor.org/rfc/rfc3986.html#section-5).

For an ontology file at `https://example.org/shop.tonto`:

| Location in the ontology file | Resolved document |
|---|---|
| `foundation/core.tonto` | `https://example.org/foundation/core.tonto` |
| `domains/catalog.tonto` | `https://example.org/domains/catalog.tonto` |
| `../shared/people.tonto` | `https://example.org/shared/people.tonto` |

Bundle entries use relative paths only. An absolute URL is valid for an
ontology `import`, not for a bundle. A remotely published ontology file can still
fetch its relative package sources from the same publication location.
When a local bundle source does not exist, the editor offers to create it
with `package <name> in <ontology>`. Creating a source is an authoring choice,
so the action is not part of automatic repair batches.

Imports inside a retrieved package document resolve against that package
document's effective URL, not against the ontology file URL. Local files use the
equivalent file-URI resolution rules. A remote document cannot cause a local
file to be read through a `file:` reference; local-file resolution belongs
to locally selected sources or the workspace's location mappings
(section 7.1).

The resolver MUST perform these logical stages:

1. Retrieve and parse the ontology file.
2. Discover its package membership and retrieve the required source documents.
   Independent retrievals MAY run concurrently.
3. Register selected packages with their ontology owner and verify all bundle
   selectors and ownership constraints before linking `use` declarations
   or declaration references.
4. Discover ontology imports in the selected packages, load their ontology
   files, and repeat discovery until the dependency graph is known.
5. Construct ontology-scoped symbol indexes, link references, and validate
   each ontology against its dependency closure.

Retrieval order MUST NOT determine binding or public names. `use`
declarations and references may be cyclic; all owned packages are indexed
before linking, and each package resolves references through its applicable
`use` declarations and ontology imports.
Ontology import cycles must terminate through a
visited-root registry and be linked after discovery, rather than recurse
indefinitely. An incomplete dependency closure cannot be reported as a
successfully checked publication.

Repeated requests for the same resolved ontology file reuse one ontology
instance. Document and ontology caches are distinct: one fetched document
can provide several selected packages, without merging their ontology owners.
Cached documents retain their effective retrieval URLs as their resolution
bases (section 7.2). The implementation must retain an import/bundle chain for
retrieval failures so a diagnostic can identify how the missing source was
reached.

### 7.1 Location mappings

A workspace MAY map locations to other locations. A mapping substitutes the
source of a document without changing the import that names it. It is how a
workspace develops a dependency locally while its importers name the published
location, follows a dependency whose host moved, and settles which release of
a namespace a model uses (section 8).

Mappings are written in an optional `tonto.json` in the workspace's root
directory. Mapping locations is all it does; it does not affect ownership
(section 3):

```json
{
  "locations": {
    "https://w3id.org/ufo-l/": "../ufol/",
    "https://example.org/shop/1.2.0/shop.tonto": "https://example.org/shop/1.3.0/shop.tonto"
  }
}
```

A workspace without mappings needs no such file. The CLI, API and MCP accept
the same mappings as options, which take precedence over the file's for the
same key.

- A key is an absolute HTTP(S) URL. A key ending in `/` maps every location
  beneath it, and its value is a prefix that receives the remainder; any other
  key maps one document. The longest matching key applies. A mapped location is
  not mapped again.
- A value is an absolute URL or a reference relative to the directory holding
  `tonto.json`.
- Mappings apply to every location in the resolved model, including those
  written in dependencies' documents. They are applied before retrieval and
  before roots are deduplicated, so two imports that map to one document share
  one ontology instance. This is the development resolution model; publication
  verification disables mappings throughout the closure (section 7.3).
- Only the workspace's own mappings apply. A `tonto.json` published beside a
  dependency is never read: a dependency cannot redirect what its importer
  loads, and a remote document still cannot cause a local file to be read.
- Relative locations inside a mapped document resolve against the mapped
  location, so a local copy keeps its own layout.
- When the target is a document in the workspace, the ontology it selects is
  authored, not a dependency: it is checked and diagnosed like any authored
  ontology, and edits to it apply without a refresh. A target outside the
  workspace is read-only, like a retrieved dependency.
- A target that cannot be read is a retrieval error at the import that reached
  it, naming the mapping. The resolver MUST NOT fall back to the original
  location.

Diagnostics on a mapped document name both its original location and the
mapping. Merely finding a loaded document with a matching namespace is not
sufficient to substitute it; only a mapping does.

### 7.2 Retrieval and the document cache

Remote documents are read from a cache that only an explicit request fills.
Checking, linking, completion, hover, formatting and export MUST NOT access the
network. Local `file:` documents are read directly and are not cached.

- `tonto fetch` retrieves every remote document the workspace's resolved model
  needs and the cache lacks. `tonto fetch --refresh` retrieves all of them
  again. The editor and the MCP server offer the same two operations.
- `tonto fetch --publication` discovers and fills the cache for the selected
  publication's closure without applying workspace location mappings.
  `--refresh` can be combined with this option to refresh that closure. The
  editor, API and MCP expose the same publication retrieval mode. These are
  explicit network operations; publication verification itself never fetches.
- An import whose closure needs a document the cache lacks is reported at that
  import, naming the missing location and the command that retrieves it. The
  model is then incomplete (section 10); it is never checked as though the
  import were absent.
- A cached document does not change until a refresh. A refresh replaces the
  documents of the closure together and reports which changed, which are new
  and which are no longer needed. Only a retrieval that covers every authored
  document of the workspace knows what nothing needs; it removes those
  documents from the cache, while a retrieval for some files keeps them. A
  refresh that fails part way leaves the previous documents in use.
- Each workspace keeps its own record of what it retrieved, in its `.tonto/`
  directory: for each document the requested location, the effective URL after
  redirects, the retrieval time and a SHA-256 digest of the content. Contents
  MAY be shared between workspaces in a content-addressed store, but a refresh
  in one workspace does not change what another reads.
- The record distinguishes an import's original location from the location
  actually requested after mapping. A cached mapped target cannot satisfy the
  original location when mappings are disabled. Development and publication
  resolution can share a retrieved document only when their actual request
  locations agree; mapping provenance is not discarded during deduplication.
- Without a network connection, everything except retrieval works from the
  cache.

The record is local state. Whether it becomes a committed lockfile that other
machines verify against is deferred (section 14).

### 7.3 Publication verification

Ordinary development checking uses workspace location mappings. Successful
checking of that model does not certify a publication. Publication
verification MUST build a separate resolution model with every workspace
location mapping disabled, including mappings supplied through tool options
and mappings affecting transitive dependencies or bundle entries.

The selected authored ontology file is the root input; it need not already
be hosted remotely. Its bundle entries and imports resolve as written, using
the document-relative rules of section 7. Dependency documents are read from
their original local locations or the cache for their actual unmapped remote
locations. The implementation MUST NOT reuse mapped symbol bindings or fall
back to a local replacement when an original dependency is absent.

If this closure is missing a remote document, verification reports the
missing location and the explicit `tonto fetch --publication` operation.
Once complete, the publication model must pass ownership, linking, semantic,
namespace and publication-specific naming checks. Publication Turtle and
other certified publication outputs MUST be generated from this model.
Development exports using mappings may remain available as previews, but
must not be presented as a successfully verified publication.

For example, mapping a dependency's release 1.2 to 1.3 may make a reference to
a class introduced in 1.3 valid during development. Publication verification
still loads 1.2 if that is what the authored import names, and rejects the
unresolved reference. The author must choose published dependency locations
whose original closure supports the model. Updating workspace mappings alone
cannot resolve a broken published import or a published release conflict.

This check establishes that an importer using the same document contents and
no substitutions can resolve and validate the publication. It does not
guarantee that mutable remote documents stay unchanged after verification;
immutable release locations remain recommended (section 14).

## 8. Namespace and ontology metadata

The initial tonto web-publication profile requires an absolute HTTP(S)
namespace ending in exactly one final `#`, with no query or earlier fragment
marker, in addition to the existing namespace-validity constraints. HTTPS
SHOULD be used for new publications. An ontology being edited can have no
namespace; publication and a usable remote ontology import require one.

For a namespace `N#`, the ontology IRI is `N`:

| Purpose | Conventional location or identity |
|---|---|
| Ontology IRI | `https://example.org/shop` |
| Term namespace | `https://example.org/shop#` |
| tonto ontology file | `https://example.org/shop.tonto` |
| Generated Turtle document | `https://example.org/shop.ttl` |
| Classifier | `https://example.org/shop#Product` |
| Property | `https://example.org/shop#Customer.buys` |

The `.tonto` and `.ttl` locations are conventions, not additional semantic
identifiers. An ontology file may be hosted elsewhere without changing its terms.
The explicit import URL remains authoritative; stripping a fragment and
appending `.tonto` is not a discovery algorithm in this design.

Hash namespaces avoid overlap between term fragments and source-document
paths. This profile is a tonto publication choice, not a claim that slash
namespaces are invalid RDF. Generic RDF export can continue to support slash
namespaces outside this publication profile.

Only the ontology header gives an ontology its namespace, version, license
and creators, and its documentation describes the ontology. A package is a
part of an ontology, published with it, so it has none of these of its own:
`@namespace`, `@version`, `@license` or `@creator` written above a package,
or above any other declaration, is ignored with a warning,
`ontology-tag-not-on-header`. Its repair moves the line to the header when the
header does not say it yet, and otherwise removes it; where the header gives
another value, the header has the last word. A package's other documentation
describes the package. A one-file ontology's unnamed package has no
documentation of its own: the comment above its first declaration documents
that declaration.

A namespace supplied explicitly by export can fill in a missing value for
the one exported ontology whose header gives none, but never overrides a
declared one. Without either, a gUFO export preview uses a placeholder,
`https://example.org/<name>#`, and says so; a preview with a placeholder is
not a publication.

`@version` is descriptive metadata. It does not pin a dependency, select an
alternative version or change term IRIs. Publishers may use immutable release
directories for an ontology file and its packages while retaining the declared
namespace. Simultaneous different releases of one namespace in one resolved
model are a conflict. The diagnostic names both locations and the imports that
reached them. The importing workspace resolves it without editing any
dependency, by a location mapping (section 7.1) that sends one release's
location to the other's for development. Publication verification still
requires the original imports to select a consistent closure; a workspace
mapping is not a published dependency-resolution rule (section 7.3).
Version-range resolution is outside this design.

## 9. Identifier construction and collision validation

Ownership supplies a symbolic namespace before an HTTP(S) namespace is known.
The validator MUST compare identifiers across every package owned by an
ontology, including packages that do not reference one another.

Public RDF local names follow the existing structural naming decision:

| Element | Local name |
|---|---|
| Class, datatype or enumeration | its declared name, such as `Person` |
| Attribute | `Owner.member`, such as `Person.name` |
| Enumeration literal | `Enumeration.literal`, such as `Color.red` |
| Named relation | `Source.member`, such as `Customer.buys` |
| Unnamed relation | `Source.directionalStemTarget`, such as `Car.hasComponentWheel` |
| Association end | no RDF resource; its name is a tonto reference handle |

The symbolic identity key is `(owning ontology, RDF local name)`. When a
namespace is assigned, each declared-name segment is encoded using the
mapping's existing IRI encoding rules. The structural dot is inserted between
encoded segments. Case is preserved; the validator must also check final
encoded IRI equality. No ordinal suffix or automatic package qualifier may
resolve a collision.

An attribute and an enum literal belong to their classifier's ontology. A
relation belongs to the ontology owning its declaring package, including
when its source classifier comes from a dependency. The source classifier's
name qualifies the property; its package name and namespace do not enter the
property local name. The relation does not transfer ownership of its source.

Consequently, two equally named foreign/local source classifiers can still
produce a property clash in one declaring ontology. The remedy is an explicit
relation name that distinguishes the predicates, not a package-dependent IRI.

Existing member-namespace checks also remain necessary for tonto references:
attributes, declared relation names, enum literals and named ends can create
an ambiguity even when an end mints no RDF resource. Public source handles
must not silently alias two declarations. Named handles for relations owned
by the importing ontology do not re-export the dependency's classifiers.

The relation-name computation MUST be shared by validation and export.
For example, two unnamed relations from `Car` to `Wheel` with the same
directional semantic stem must be diagnosed during ordinary model checking,
even if their association ends have different names. An attribute named
`hasComponentWheel` can also clash with an unnamed relation that generates
`Car.hasComponentWheel`.

Two different packages declaring `Person` in one ontology clash even if no
namespace was supplied. `Person.name` and `Product.name` do not clash.
`people#Person` and `shop#Person` in different ontologies do not clash.
Different ontologies both claiming the same actual namespace are an
ontology-identity conflict, not a way to avoid the declaration check.

Fallback labels remain the unqualified member names: an identifier such as
`Car.hasComponentWheel` has `rdfs:label "hasComponentWheel"`. SHACL paths
use the qualified IRI while `sh:name` remains concise. Explicit documentation
labels continue to take precedence.

## 10. Validation boundaries and incremental behavior

Name and ownership validation apply to the full owned package set, not just
the named file or the files currently open in the editor. Parse recovery may
permit useful editor feedback while a bundle is incomplete, but the checker
must distinguish this from a complete successful publication check.

The ontology-wide declaration index must include every owned package before
linking, including packages with no references between them. Identifier
validation reads the complete index; reference binding and completion use
the current package's applicable `use` declarations and ontology imports
(section 6). Package visibility must not depend on document order, storage in
the same file, transitive `use`, or a `global` flag. `use` and import
declarations and declaration moves between packages must also invalidate
completion candidates and missing-`use` fixes.

Each ontology's semantic validation sees its own declarations and its
transitively imported ontologies. It MUST NOT depend on unrelated workspace
ontologies or on ontologies that import it. For example, a downstream
ontology's mediation cannot make an independently incomplete dependency
validate successfully. Reverse lookups must respect this direction as well
as forward name resolution.

`use` declarations restrict reference visibility, not the set of owned
declarations considered by ontology-wide checks. A package no `use` names
still participates in identifier validation and semantic checks on the
complete ontology. Using one package does not make its own `use`
declarations or imports available for name resolution, even though validation examines the complete
owned model and its ontology dependency closure.

Ontologies that import one another, directly or through others, have the same
transitive closure, so they are validated together as one unit, while retaining
their distinct ownership and namespaces. Publication verification uses the
unmapped closure described in section 7.3. Given the same document contents
and no importer substitutions, the author's publication check and an
importer's check see the same ontology closure. Development checks using
workspace mappings do not establish that equivalence.

Changes to membership, ownership, namespaces, imports, classifier names or
generated member names MUST invalidate the affected symbol indexes and
collision diagnostics. Adding a duplicate classifier in an unreferenced
package must revalidate the ontology-wide name set. Deleting the duplicate
must clear those diagnostics without reopening another file.

Diagnostics MUST have stable codes and positions. Cross-file collisions
should name both declarations and attach related locations. Membership and
retrieval errors should point to the bundle entry or import that introduced
them. A failed fetch or selector must not silently reduce a bundle and allow
export of the surviving subset.

Implementation needs diagnostics for at least these conditions; exact code
spellings should be settled with the rule catalog during implementation:

| Condition | Required result |
|---|---|
| Non-lowercase ontology/package name or alias | warning with a rename repair; publication error; no silent normalization |
| Duplicate package name within an ontology | error |
| Missing or ambiguous package selected by a bundle entry | error |
| Absolute bundle source location | `ontology-bundle-location` error; use a relative source path |
| One source package assigned to two ontologies | error |
| Independent roots claiming the same namespace | error |
| Conflicting namespace or ontology metadata | error |
| Duplicate public classifier or generated member identifier | error |
| Unresolved reference to an unlisted or foreign declaration | error; no implicit package loading or cross-ontology lookup |
| Reference to a declaration in an unused owned package | missing-package-use error with an add-`use` quick fix when valid |
| `use` targeting another ontology or an unlisted package | error; no implicit ownership or membership change |
| `import core`, naming a package | `import-for-use` error; batch-safe rewrite to `use core` |
| Loose declarations beside packages or `bundles` | `ontology-loose-declarations` error; repair wraps them in a package |
| `bundles` with no bundle entry | `ontology-header` error |
| Bundled package without `in` | `package-file-without-in` warning; publication error; batch-safe repair |
| Package `in` an ontology other than the one bundling or containing it | `package-in-mismatch` error; batch-safe repair |
| Package `in` an ontology that does not bundle it | `package-not-bundled` error; add-to-bundle repair, `batchSafe: false` |
| Package `in` an ontology with no ontology file in the workspace | `ontology-file-missing` warning, an error under publication; checked with the other packages that say so |
| Package with no `ontology` header above it and no `in` | `package-without-ontology` error; repairs make it a one-file ontology, write a header above it, or bundle it into an ontology file, all `batchSafe: false` |
| `in` on an inline package of the ontology file | `package-in-redundant` warning; batch-safe removal |
| Location import of a member package's document | `package-file-import` error |
| Two authored ontology files with one ontology name | `ontology-name-clash` error |
| `@namespace`, `@version`, `@license` or `@creator` anywhere but above an `ontology` header | `ontology-tag-not-on-header` warning; repair moves it to the header or removes it |
| User-defined `global` modifier | unsupported syntax in the planned language |
| Ambiguous import qualifier or alias | error |
| Incomplete retrieval or dependency closure | error for checking/publication |
| Location not in the document cache | error at the import, naming the fetch command |
| Location mapping whose target cannot be read | error at the import, naming the mapping |
| Unmapped publication dependency missing from the cache | publication error at the import, naming `tonto fetch --publication`; no mapped fallback |
| Reference or release conflict concealed by a location mapping | publication error against the original import closure |
| Two releases of one namespace in a resolved model | error naming both locations |
| Unqualified reference between an unbundled package and a bundled declaration | error; cross-ontology references require an applicable ontology import |
| Missing publication namespace or slash namespace in this profile | publication/remote-import error |
| Location import of a document with no `ontology` header | `ontology-file-required` error at the import |

## 11. Exports and publication

An export writes an ontology in another format. gUFO-aligned Turtle is the
first; others will follow, and this section says what every one of them
does. An exporter consumes the ontology ownership established by the model
loader. It MUST NOT infer a separate ontology from a package name, folder or
unannotated package. Each declared ontology exports its owned package set; a
model with a package of no ontology has an error and does not export.
Verified publication output uses the unmapped publication model of section
7.3; a development preview using workspace substitutions is not sufficient
to certify it.

Every export of an ontology writes its files beside its ontology file, named
after the ontology with the format's extension, whichever of the ontology's
files it was asked about: `shop.ttl` next to `shop.tonto` for the
gUFO export. The editor's export commands, `--write` on the command line and
`write` in the MCP tools write there; `--out`, `--out-dir` and `outDir` are
for writing elsewhere. `tonto ontologies`, the MCP tool `tonto_ontologies`
and the editor's exports list the same ontologies: those the workspace
authors, not its dependencies or its unbundled packages.

A workspace export MAY write several independent ontology documents, but
MUST NOT automatically create an umbrella. A separate explicitly requested
aggregate can be designed later.

### 11.1 The gUFO export

The gUFO export writes one Turtle document per ontology, mapped as the
[gUFO mapping](gufo-mapping.md) specifies. It includes the ontology's own
declarations and axioms, with dependency references retaining their original
IRIs. Dependencies are not copied into its namespace. The ontology's declared
imports are preserved as OWL imports, deduplicated by ontology identity.
Transitive dependencies need not be flattened into direct imports. Built-in
alignment imports such as gUFO remain governed by the mapping. Its snapshot
module and SHACL shapes, when asked for, follow the same ownership boundaries
and are written beside the ontology's Turtle: `shop.snapshot.ttl` and
`shop.shapes.ttl`.

### 11.2 Hosting

For the conventional deployment, authors publish the existing ontology and
package files at the locations used by their references, with the exported
files already beside them. No flattened `.tonto` export is required. Moving
files for hosting requires preserving their relative links or updating the
authored locations accordingly; a publication copier must not silently
rewrite them.

tonto clients retrieve the explicit `.tonto` source location. RDF clients
following `owl:imports` need the ontology IRI to yield RDF, directly or through
a fixed redirect to its Turtle document. The publisher can configure that
single default response without content negotiation. A hash namespace alone
does not configure either the HTTP response or sidecar discovery.

The response at an extensionless ontology IRI such as
`https://example.org/shop` depends on the hosting service's capabilities. A
static host that supports extensionless resources and configurable
`Content-Type` can serve Turtle there directly. For example, S3 supports
[extensionless object lookup](https://docs.aws.amazon.com/AmazonS3/latest/userguide/IndexDocumentSupport.html)
and configurable [object metadata](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingMetadata.html).
Alternatively, publishers can configure a fixed redirect to the `.ttl`
document, using their host, a persistent-identifier service such as w3id.org,
or a PURL server. A redirect is a deployment option, needed where direct RDF
serving is unavailable, rather than a universal requirement. Neither approach
requires content negotiation. The
distinction between ontology IRIs and document locations follows
[OWL 2, ontology documents](https://www.w3.org/TR/owl2-syntax/#Ontology_Documents).

## 12. Worked multi-file publication

This example illustrates the `bundles` syntax, member packages and
`use`-controlled internal visibility. Its packages state their architectural
dependencies with `use` while sharing one ontology-wide identifier space. It
could have started as a one-file `shop.tonto` split once (section 4.6), with
its declarations later moved into further packages.

```text
shop.tonto
foundation/core.tonto
domains/catalog.tonto
commerce/sales.tonto
```

`shop.tonto`:

```tonto
/// People, products and purchases.
///
/// @label Shop
/// @namespace https://example.org/shop#
/// @version 1.2.0
ontology shop bundles
    core from <foundation/core.tonto>
    catalog from <domains/catalog.tonto>
    commerce.sales from <commerce/sales.tonto>
```

`foundation/core.tonto`:

```tonto
package core in shop

kind Person {
    name: string
}
```

`domains/catalog.tonto`:

```tonto
package catalog in shop

kind Product {
    name: string
}
```

`commerce/sales.tonto`:

```tonto
package commerce.sales in shop

use core
use catalog

role Customer specializes core.Person

relator Purchase {
    @mediation [1..*] -- [1] (const) Customer
    @mediation [0..*] -- [1] (const) catalog.Product
}

@material relation Customer [0..*] -- buys -- [1..*] catalog.Product derivedFrom Purchase
```

The public names include `shop.Person`, `shop.Product`, `shop.Customer`,
`shop.Purchase` and `shop.Customer.buys`. The two attributes become
`https://example.org/shop#Person.name` and
`https://example.org/shop#Product.name`, each labeled `"name"`.

Moving `Customer` and its relations to a different package in this same
bundle leaves external ontology-level references and IRIs unchanged. Internal
`use` declarations and qualifiers referring to the moved declarations may need
updates; their dependencies must also have applicable `use` declarations and
imports at the destination. The ontology file needs an update only if its package membership or
source locations change. Content assist and missing-`use` fixes help authors
make the internal dependency changes explicitly (section 6.3).

## 13. Stability guarantees

| Change | Effect on existing public identities |
|---|---|
| Add another package with no colliding public names | none |
| Add `Product.name` beside `Person.name` | none |
| Move a declaration between packages of the same ontology | none |
| Rename a package and update its bundle entry and `use` declarations | none |
| Split a one-file ontology into an ontology file and a package (section 4.6) | none |
| Move a source file and update its locations | none |
| Change an import alias and repair references | none |
| Rename an ontology's authoring name and its members' `in` | none |
| Rename a classifier | its IRI and owner-qualified member IRIs change |
| Rename a named member | that member's IRI changes |
| Change an unnamed relation's naming stem or target name | its generated IRI changes |
| Move a declaration to another ontology namespace | its IRI changes |
| Change an ontology namespace | every owned term IRI changes |

These guarantees concern external ontology-level references and RDF
identifiers. Moving a declaration within an ontology can require updating
`use` declarations and qualifiers, even when an unqualified reference's
text does not change. Dependencies used by a moved declaration must remain
imported at its destination. Moving source files can require updating relative
locations; when a `.tonto` file or a folder is moved or renamed in the editor,
the editor rewrites the relative bundle and import locations of authored
documents that name it or are written in it, before the move. Changing an
ontology file's published URL can require import-location updates even when
its namespace stays stable.

## 14. Deferred features

Explicit per-element identifiers, compatibility aliases and migration
behavior remain out of scope. Also deferred are package-path shorthand,
globs, public package-path imports,
selective/private exports, automatic dependency re-exports, a separate
dependency-declaration file, version ranges, committed lockfiles verified
across machines, automatic `.tonto` discovery from an ontology IRI, and
publication upload commands.

User-defined `global` packages are removed by this design, rather than
deferred. `use` declarations and their aliases are retained as architectural
boundaries, with content assist and explicit add-`use` repairs. The ontology
defines identifier uniqueness and publication; applicable imports define
which dependencies a package may reference.

Versioned immutable document locations are a practical deployment convention;
this specification does not claim that mutable multi-file HTTP retrieval is
an atomic release. More elaborate release management can be specified later
without changing ontology ownership or public naming.
