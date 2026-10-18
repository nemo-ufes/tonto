import "./terminals";
import "./classifiers";
import "./datatypes";
import "./relations";
import "./gensets";

/**
 * The root of every document: a flat list of imports and packages, in
 * whatever order they were written.
 *
 * Legacy tonto wrapped each top-level construct in a `Statement { import?,
 * contextModule? }` node, so consumers had to check which optional field was
 * set. Assigning straight into `Model.imports` / `Model.packages` during the
 * same alternation loop keeps the same freeform ordering in the concrete
 * syntax while removing that wrapper from the AST.
 */
interface Model {
    imports: Import[]
    packages: Package[]
    ontologies: Ontology[]
}

/**
 * `use core` lets a package reference another package of its own ontology;
 * `import shop from <shop.tonto>` brings in another ontology. Earlier tonto
 * spelled the first `import core`, which still parses with the same meaning:
 * `use` is false there, and a check offers the rewrite.
 */
interface Import {
    package?: @Package
    alias?: string
    location?: string
    use?: boolean
}

Import returns Import:
    'import' (alias=Name 'from' location=LOCATION | package=[Package:QualifiedName] ('as' alias=Name)?)
    | use?='use' package=[Package:QualifiedName] ('as' alias=Name)?
;

/**
 * An ontology file: its header, then either its declarations directly --
 * a one-file ontology, whose declarations are an `OntologyBody` -- or its
 * packages, inline and bundled. `bundled` records that `bundles` was written,
 * so an empty list can be told from an absent one.
 */
interface Ontology {
    name: string
    bundled?: boolean
    bundles: BundleEntry[]
}

Ontology returns Ontology:
    'ontology' name=Name (bundled?='bundles' bundles+=BundleEntry*)?
;

interface BundleEntry {
    name: string
    location: string
}

BundleEntry returns BundleEntry:
    name=QualifiedName 'from' location=LOCATION
;

/**
 * An authoring boundary within an ontology. Other packages require explicit
 * imports even when they share a file or a public identifier namespace.
 *
 * The name is optional in the grammar and mandatory in the language, as a
 * relation's target is: a document is nameless for as long as it takes to
 * type the name after the keyword, and a mandatory name made that a parse
 * failure -- the whole file discarded, no scope, no other diagnostic, and
 * (until the scope computation stopped handing an undefined name to the
 * index) an internal error where the message should have been.
 * `checkPackageHasName` says what is missing instead.
 */
interface Package {
    name?: string
    owner?: string
    imports: Import[]
    declarations: Declaration[]
}

/**
 * `in shop` states the ontology a package belongs to when its document is not
 * that ontology's entry: membership, which the entry's bundle confirms.
 */
Package returns Package:
    'package' name=QualifiedName? ('in' owner=Name)?
    (imports+=Import | declarations+=Declaration)*
;

/**
 * The declarations of a one-file ontology, written straight after its
 * header. They are a package -- everything that scopes, indexes and checks
 * declarations does so per package -- but one without a name, since nothing
 * else in a one-file ontology could `use` it. At least one declaration, so
 * that imports between a header and a `package` stay the document's own.
 */
interface OntologyBody extends Package {}

OntologyBody returns OntologyBody:
    (imports+=Import)* declarations+=Declaration (imports+=Import | declarations+=Declaration)*
;

Declaration:
    ClassDeclaration | AuxiliaryDeclaration
;

AuxiliaryDeclaration:
    Datatype | Enumeration | GeneralizationSetImpl | GeneralizationSetShort | ExternalRelation
;
