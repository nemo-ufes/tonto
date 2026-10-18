import { EmptyFileSystem, URI } from 'langium';
import { CodeActionKind } from 'vscode-languageserver';
import { createTontoServices } from '../tonto-module.js';
import { publicationWorkspace } from '../publication/workspace.js';

/**
 * One worked example per rule: the smallest plausible model that trips it.
 *
 * This is documentation that runs. `catalog()` validates every entry and
 * reports the diagnostic it actually produced, so a rule whose example stops
 * tripping it -- because the rule moved, or the language did -- shows up as a
 * failing test rather than as a paragraph that quietly stopped being true.
 * It has caught exactly that twice: an example built from `event X specializes
 * Meeting` after that stopped being legal, and one that predated parthood
 * inheritance.
 *
 * `code` is the diagnostic code, or a fragment of the message for the few
 * rules Langium raises itself. A `null` model uses the shared preamble, for
 * rules about the package declaration.
 */
export interface RuleCase {
    /** Diagnostic code, or a message fragment where there is none. */
    code: string;
    group: string;
    rationale: string;
    /** The model, several files where the rule is about crossing them. */
    model: string | { docs: string[]; focus: number; paths?: string[]; publication?: boolean; locations?: Record<string, string> } | null;
}

export interface Rule extends Omit<RuleCase, 'model'> {
    example: string;
    /**
     * The code the diagnostic actually carried, which the test compares with
     * `code`. They drifted apart once: eleven entries were keyed by a fragment
     * of the message after the diagnostics had gained codes, and three of
     * those were second entries for a rule already in the catalog.
     */
    reported: string | undefined;
    severity: string | undefined;
    message: string | undefined;
    fixes: string[];
    /**
     * Whether `tonto check --fix` applies the repair on its own. False where
     * the repair decides something a rule cannot decide -- which of two
     * readings of a lone phase is meant, whether a partition is really
     * complete -- and the repair then waits for someone to choose it, in an
     * editor or by naming the rule to `--fix=`.
     */
    batchSafe: boolean;
}

const CASES: ReadonlyArray<readonly [string, string, string, RuleCase['model']]> = [
['ontology-header', 'Ontologies and packages', 'A document declares at most one ontology, and a "bundles" clause lists at least one package.',
 { docs: ['ontology shop bundles\nontology other bundles'], focus: 0 }],
['ontology-bundle', 'Ontologies and packages', 'Each explicit source location must select exactly one package with the declared name; an incomplete bundle must not export a surviving subset.',
 { docs: ['ontology shop bundles absent from <core.tonto>', 'package core in shop\nkind Person'], paths: ['shop.tonto', 'core.tonto'], focus: 0 }],
['ontology-bundle-location', 'Ontologies and packages', 'A bundle selects a package file relative to the ontology file that lists it. A separately located ontology is an import, not a package of this one.',
 { docs: ['ontology shop bundles core from <https://example.org/core.tonto>'], focus: 0 }],
['package-bundled-twice', 'Ontologies and packages', 'One package belongs to one ontology; two ontology files cannot both bundle it.',
 { docs: ['ontology one bundles core from <core.tonto>', 'ontology two bundles core from <core.tonto>', 'package core in one\nkind Person'], paths: ['one.tonto', 'two.tonto', 'core.tonto'], focus: 1 }],
['ontology-namespace-conflict', 'Publication', 'A namespace is an ontology\u2019s public identity, so two ontologies of one workspace cannot claim the same one. If they are one ontology, bundle their packages from one ontology file; if one is a local copy of the other, a location mapping makes them one.',
 { docs: ['/// @namespace https://example.org/shop#\nontology shop\nkind Product', '/// @namespace https://example.org/shop#\nontology store\nkind Offer'], paths: ['shop.tonto', 'store.tonto'], focus: 0 }],
['publication-namespace', 'Publication', 'Remote imports and publication require an explicit HTTP(S) hash namespace; generic local RDF previews may still use slash namespaces.',
 { docs: ['ontology people\nkind Person'], focus: 0, publication: true }],
['ontology-file-required', 'Ontologies and packages', 'An import names an ontology by its ontology file, which starts with an "ontology" header. A document without one declares no ontology, so there is nothing at its location to import.',
 { docs: ['ontology shop\nimport legacy from <legacy.tonto>\nrole Customer specializes legacy.Person', 'package legacy\nkind Person'], paths: ['shop.tonto', 'legacy.tonto'], focus: 0 }],
['package-without-ontology', 'Ontologies and packages', 'Every package belongs to an ontology that a document declares: written under an "ontology" header, or saying "in" the ontology whose ontology file bundles it. Nothing else makes one -- not a folder, a file, a shared namespace, a "use" or a tonto.json. Which ontology a package belongs to is the author\u2019s to say, so the repairs -- making a lone package a one-file ontology, writing a header above the packages, or bundling the package into an existing ontology file -- are offered, never applied unread.',
 { docs: ['package sales\nkind Order'], paths: ['orders.tonto'], focus: 0 }],
['publication-location', 'Publication', 'Checking is offline. Explicit document locations must be readable locally or already present in the workspace retrieval cache; run tonto fetch to retrieve them.',
 { docs: ['ontology client\nimport people from <https://example.org/not-cached.tonto>\nkind Visitor'], focus: 0 }],
['publication-configuration', 'Publication', 'A workspace\'s settings file, `tonto.json` -- and the location mappings the CLI, API or MCP supply with `--locations` -- is read as data, never trusted to be well formed: a file that does not parse, or an entry whose key is not an absolute HTTP(S) URL, a key with a fragment, or a prefix key whose target does not end in "/", is reported at the workspace\'s first file and ignored, while the valid mappings beside it still apply.',
 { docs: ['ontology client\nimport people from <https://example.org/people.tonto>\nkind Visitor'], focus: 0, locations: { 'example.org/people.tonto': 'people.tonto' } }],
['cross-ontology-package-use', 'Ontologies and packages', 'A "use" names a package of the using ontology. A package another ontology bundles is reached only by importing that ontology by location and qualifying its names with the alias. The message names the owning ontology and the location import to write, rather than reporting an unresolved name.',
 { docs: ['/// @namespace https://example.org/shop#\nontology shop bundles core from <core.tonto>', 'package core in shop\nkind Person', 'ontology client\npackage visits\nuse core\nkind Visitor'], paths: ['shop.tonto', 'core.tonto', 'client.tonto'], focus: 2 }],
['namespace-member-clash', 'Ontologies and packages', 'Generated relation names and attribute names share the ontology public identifier space. Name one relation differently; association ends do not disambiguate RDF predicates.',
 'datatype Text\nkind Car {\n hasComponentWheel: Text\n @componenthood [1] <>-- [4] Wheel\n}\nkind Wheel'],
['ontology-name-case', 'Ontologies and packages', 'Ontology names and aliases are entirely lowercase, like package names; the repair updates applicable references together.',
 { docs: ['ontology Shop\nkind Product'], focus: 0 }],
['missing-package-use', 'Ontologies and packages', 'Identifiers are ontology-global, but referencing another owned package requires an applicable direct "use". The validated repair is an architectural choice and is excluded from automatic batches.',
 { docs: ['ontology bikes\npackage core\nkind Person\npackage details\nsubkind Cyclist specializes core.Person'], focus: 0 }],
['import-for-use', 'Ontologies and packages', 'Packages are used and ontologies are imported. "use core" lets a package refer to another package of its own ontology; "import shop from <shop.tonto>" brings in another ontology by the location of its ontology file. "import core", naming a package, mixes the two, and is an error; the repair changes the keyword and nothing else.',
 { docs: ['ontology shop\npackage parties\nkind Person\npackage billing\nimport parties\nrole Customer specializes parties.Person'], focus: 0 }],
['ontology-loose-declarations', 'Ontologies and packages', 'An ontology either holds its declarations straight after its header -- a one-file ontology, with no packages -- or holds packages, inline and bundled. Declarations beside packages would be a package without a name, which no other package could use. The repair wraps them in a package named after the ontology; to grow a one-file ontology into several files, split it from its header instead.',
 { docs: ['ontology shop\nkind Product\npackage people\nkind Person'], focus: 0 }],
['package-file-without-in', 'Ontologies and packages', 'A package file says which ontology it belongs to, "package catalog in shop", so the file read alone says what it is part of. The ontology file that bundles it has decided the membership already, so the repair writes the ontology it names. A warning while editing, an error before publication.',
 { docs: ['ontology shop bundles catalog from <catalog.tonto>', 'package catalog\nkind Product'], paths: ['shop.tonto', 'catalog.tonto'], focus: 1 }],
['package-in-mismatch', 'Ontologies and packages', 'A package can be in one ontology: the one whose ontology file bundles it, or the one whose ontology file it is written in. Saying "in" another contradicts the ontology file, which has the last word.',
 { docs: ['ontology shop bundles catalog from <catalog.tonto>', 'package catalog in store\nkind Product'], paths: ['shop.tonto', 'catalog.tonto'], focus: 1 }],
['package-in-redundant', 'Ontologies and packages', 'A package written in an ontology file is a member by being there; "in" is for package files.',
 { docs: ['ontology shop\npackage core in shop\nkind Person'], focus: 0 }],
['package-not-bundled', 'Ontologies and packages', '"in shop" states membership, and only the ontology file of "shop" states completeness: a package that says it is in an ontology whose ontology file does not bundle it is in neither. The repair adds the package to its "bundles", a decision about the ontology, so it is never applied unread. A one-file ontology bundles nothing until it is split.',
 { docs: ['ontology shop bundles catalog from <catalog.tonto>', 'package catalog in shop\nkind Product', 'package offers in shop\nkind Offer'], paths: ['shop.tonto', 'catalog.tonto', 'offers.tonto'], focus: 2 }],
['ontology-file-missing', 'Ontologies and packages', 'Packages that say they are "in" an ontology no ontology file in the workspace declares are unbundled: checked together, their identifiers compared and free to use one another, but published by nothing until an ontology file bundles them. A warning while editing, so a package can be written before its ontology file; an error before publication, which never adds a package silently.',
 { docs: ['package catalog in shop\nkind Product'], focus: 0 }],
['package-file-import', 'Ontologies and packages', 'An import brings in an ontology through its ontology file. A package file, whose package says it is "in" an ontology, is part of that ontology, not one of its own: importing it would split off a piece the ontology file says belongs with the rest.',
 { docs: ['ontology shop bundles catalog from <catalog.tonto>', 'package catalog in shop\nkind Product', 'ontology books\nimport catalog from <catalog.tonto>\nkind Book'], paths: ['shop.tonto', 'catalog.tonto', 'books.tonto'], focus: 2 }],
['ontology-name-clash', 'Ontologies and packages', 'Members name their ontology with "in", so the ontologies authored in one workspace need distinct names. An ontology name is not its public identity -- that is its namespace -- so imported ontologies may share one, told apart by their import aliases.',
 { docs: ['ontology shop\nkind Product', 'ontology shop\nkind Offer'], paths: ['shop.tonto', 'store.tonto'], focus: 0 }],
// --- Ontological nature -------------------------------------------------
['incompatible-supertype-natures', 'Nature', 'A class cannot inherit from supertypes whose natures share nothing -- whether a single pair conflicts outright, or three or more agree pairwise and still have nothing in common once all of them are considered together.',
 'category Alive of objects\nrelator Employment\nrole Employee specializes Alive, Employment'],
['stereotype-nature-unreachable', 'Nature', 'A stereotype needs at least one nature in common with what the class inherits.',
 'class PhysicalObject of objects\nevent BoardMeeting specializes PhysicalObject'],
['stereotype-nature-mismatch', 'Nature', 'A stereotype and an explicit "of" clause must agree.',
 'kind Contract of relators'],
['declared-nature-incompatible-with-inherited', 'Nature', 'An "of" clause may narrow what is inherited, never diverge from it.',
 'category Agent of functional-complexes\ncategory Party of functional-complexes, collectives specializes Agent'],
['datatype-nature-not-abstract', 'Nature', 'A datatype classifies abstract individuals and nothing else.',
 'datatype MonetaryValue of events'],
// --- Sortality and identity ---------------------------------------------
['sortal-without-ultimate-sortal', 'Identity', 'Every sortal draws identity from exactly one ultimate sortal.',
 'kind Car\nsubkind SportsCar'],
['multiple-ultimate-sortals', 'Identity', 'Ultimate sortals are pairwise disjoint, so a lineage holds at most one.',
 'kind Person\nkind Organization\nphase ActiveParty specializes Person, Organization'],
['non-sortal-without-sortal-subtype', 'Identity', 'A non-sortal supplies no identity principle, so it must generalize a sortal.',
 'category Resource of objects\nmixin Tangible specializes Resource'],
['non-sortal-natures-unstated', 'Identity', 'A non-sortal supplies no identity of its own, so its stereotype admits nearly every nature, and with no "of" clause anywhere in its lineage it is read that way: a category may classify events and values as readily as people. Every check that reads natures then has nothing to rule out, and the gUFO export can only write the union of everything. Non-sortals that really span natures are rare, so the likelier reading is that the clause was not written. A warning, as a bare "class" is. Spanning stays allowed -- "of functional-complexes, events" is a statement like any other -- and only the topmost unstated non-sortal is reported, since those beneath it inherit whatever it comes to say. The repair writes the natures of what the model puts beneath it, which closes the type to what is modeled now, so it is offered and not applied; and it is withheld where the narrower reading would break a relation the type is an end of, which is then the misuse to look at.',
 'category Agent\nkind Person specializes Agent\nkind Organization specializes Agent'],
['mixin-without-changeable-instances', 'Identity', 'A "mixin" is semi-rigid, so it needs an individual that can stop being an instance and go on existing. Only endurants can: an event does not stop being that event; a situation cannot change and stay the same situation, since its constituents and their properties are what it is, so what looks like one changing is a later situation obtaining in place of an earlier; and an abstract individual has no life over which anything could change. A "category" is the unrestricted one.',
 'mixin Notable of events, situations'],
['powertype-does-not-classify-types', 'Multi-level', 'A Cardelli power type holds every specialization of its base, and specializations are types \u2014 so "isPowerType" only says something on a class restricted to types. It is a modifier rather than a stereotype because what the class is stays open: a "type", a "category of types" and a "class of types" may each carry it.',
 'kind Car isPowerType'],
['historical-role-without-event', 'Identity', 'A historical role is held because of an event its instances took part in, and the model should name it. As an error that would be too strong \u2014 an instance is a former student whether or not the model has named the enrollment \u2014 but as a hint it is the most useful thing the language can say about the stereotype: one with no event behind it is usually a role. Satisfied by the role\'s own \u00abparticipation\u00bb, \u00abcreation\u00bb or \u00abtermination\u00bb, or by a "derivedFrom" naming one written where it happened -- a graduate is whoever, as a student, took part in a graduation -- which the repair offers where such a relation already exists, rather than writing a second one from the role.',
 'kind Person\nevent Graduation\nhistoricalRole FormerStudent specializes Person'],
['class-derivation-not-historical', 'Identity', 'A class is derived from what happened only if it is a historical role: once the event has happened it stays happened, which is what makes the role never lapse. A role founded by a relator lapses with it, and is not derived this way.',
 'kind Person\nrole Student specializes Person\nevent Graduation\n@participation relation Student (const) [1..*] -- graduatedIn -- [0..1] (addOnly) Graduation\nrole Graduate specializes Person derivedFrom Student.graduatedIn'],
['historical-derivation-not-founding', 'Identity', 'What a historical role is derived from is an event and how its instances were in it: a "@participation", "@creation" or "@termination" -- being born in Brazil is a historical role founded by a birth, as being a graduate is one founded by a graduation. A relation of another stereotype founds nothing, nor does a class that is not an event, nor an event nothing that could be an instance of the role is related to that way.',
 'kind Person\nrole Student specializes Person\nkind University\nrelator Enrollment {\n@mediation [1..*] -- [1] (const) Student\n@mediation [0..*] -- [1] (const) University\n}\nhistoricalRole FormerStudent specializes Person derivedFrom Enrollment'],
['historical-derivation-participant-disjoint', 'Identity', 'What took part in the event is what becomes an instance of the historical role, so it has to be able to be one. An organization hosting a graduation does not make anyone a graduate.',
 'kind Person\nkind Organization\nevent Graduation\n@participation relation Organization (const) [1..*] -- hosted -- [0..*] (addOnly) Graduation\nhistoricalRole Graduate specializes Person derivedFrom Organization.hosted'],
['historical-derivation-ambiguous', 'Identity', 'Naming the event is shorthand for the one relation into it that could found the role. Where there are several -- a graduand and a guest both take part in a graduation, and only one of them graduated -- the shorthand says nothing, and the repair offers to name each.',
 'kind Person\nrole Student specializes Person\nevent Graduation\n@participation relation Student (const) [1..*] -- graduatedIn -- [0..1] (addOnly) Graduation\n@participation relation Person (const) [0..*] -- attended -- [0..*] (addOnly) Graduation\nhistoricalRole Graduate specializes Person derivedFrom Graduation'],
['historical-role-specializes-anti-rigid', 'Taxonomy', 'A historical role holds forever once it holds, so an anti-rigid type above it can never lapse for its instances. Coherent, and sometimes intended \u2014 but the consequence lands on the relator that founds the role, not on either class named. What is usually meant is the rigid type, derived from what happened to the role: a former employee is a person who, as an employee, retired. Where the role has such a relation, the repair says that.',
 'kind Person\nrole Employee specializes Person\nkind Organization\nrelator Employment {\n@mediation [1..*] -- [1] (const) Employee\n@mediation [0..*] -- [1] (const) Organization\n}\nevent Retirement\n@participation relation Employee (const) [1] -- retiredIn -- [0..1] (addOnly) Retirement\nhistoricalRole FormerEmployee specializes Employee'],
['deprecated-stereotype', 'Identity', '"mode" is an ultimate sortal covering intrinsic and extrinsic modes at once, and an ultimate sortal is what says how its instances are individuated. The two are individuated differently and differ in what they depend on \u2014 an intrinsic mode on its bearer alone, an extrinsic one on a further individual (UFO a69\u2013a70) \u2014 so a word covering both supplies neither. Write "intrinsicMode" or "extrinsicMode", or a "category of intrinsic-modes" / "of extrinsic-modes" where the point is to speak across the two, which is what a non-sortal is for. Still parsed, so a model that uses it reads; never proposed, and the repairs offer the reading the model already supports \u2014 an "@externalDependence" anywhere in its lineage makes it the extrinsic pair.',
 'kind Person\nmode Skill {\n@characterization [1] -- [1] (const) Person\n}'],
['unspecific-stereotype', 'Identity', 'A bare "class" states nothing about identity or rigidity.',
 'class LegalEntity\nsubkind Company specializes LegalEntity'],
['subkind-founded-on-relator', 'Identity', 'Being mediated is what says a type is held in virtue of a relationship \u2014 it is the evidence "DepPhase" reads to tell a phase from a role. A "subkind" is rigid, so it claims its instances are instances necessarily, and nothing can be necessarily a customer and a customer only while a purchase stands. The stronger half of the mistake AGENTS.md lists first: "Employee", "Student" and "Customer" are founded on a relator, so they are roles, while a subkind is a rigid subdivision like "SportsCar" or "Man". A hint, since the repair changes what the model says about identity rather than correcting a slip, and a model may mean its mediation loosely.',
 'kind Person\nsubkind Customer specializes Person\nrelator Purchase {\n@mediation [1] -- [1] (const) Customer\n@mediation [1] -- [1] (const) Person\n}'],
// --- Taxonomy -----------------------------------------------------------
['stereotype-cannot-specialize', 'Taxonomy', 'The rigidity and sortality table governs which stereotype may specialize which.',
 'kind Person\nkind Student specializes Person'],
['specialization-cycle', 'Taxonomy', 'Generalization is acyclic.',
 'category Alive of objects specializes Legal\ncategory Legal of objects specializes Alive'],
['disjoint-supertypes', 'Taxonomy', 'A class cannot specialize two classes a disjoint set holds apart.',
 'kind Vehicle\nsubkind Car specializes Vehicle\nsubkind Truck specializes Vehicle\ndisjoint genset vehicleTypes where Car, Truck specializes Vehicle\nsubkind Pickup specializes Car, Truck'],
['duplicate-supertype', 'Taxonomy', 'A supertype listed twice adds nothing.',
 'kind Person\nrole Student specializes Person, Person'],
// --- Generalization sets ------------------------------------------------
['genset-stereotype-cannot-specialize', 'Generalization sets', 'A set declares generalizations, so the same taxonomy rules apply.',
 'kind Person\nkind Student\ngenset roles where Student specializes Person'],
['duplicate-specific', 'Generalization sets', 'A specific listed twice in one set.',
 'kind Person\nrole Student specializes Person\ngenset Roles where Student, Student specializes Person'],
['genset-self-generalization', 'Generalization sets', 'A set cannot specialize its own general.',
 'kind Person\nsubkind Man specializes Person\ngenset biologicalSex where Person, Man specializes Person'],
['genset-mixes-classes-and-relations', 'Generalization sets', 'A set generalizes classes or relations, and not the two together.',
 'kind Person\nkind Organization\nrelation Organization [1] -- employs -- [*] Person\ngenset employmentForms where employs specializes Organization'],
['instance-of-not-higher-order', 'Generalization sets', 'An "instanceOf" target classifies types, so it must be one.',
 'kind CarModel\nkind Car (instanceOf CarModel)'],
['categorizer-not-higher-order', 'Generalization sets', 'A categorizer must be a high-order type.',
 'kind Person\nphase Child specializes Person\nphase Adult specializes Person\nkind LifeStage\ndisjoint complete genset lifeStages {\ngeneral Person\ncategorizer LifeStage\nspecifics Child, Adult\n}'],
['categorizer-is-relation', 'Generalization sets', 'A categorizer is a high-order type whose instances are the specifics, and a relation is not one.',
 'kind Person\nsubkind Man specializes Person\nsubkind Woman specializes Person\nrelation Person [*] -- knows -- [*] Person\ngenset bySex {\ngeneral Person\ncategorizer Person.knows\nspecifics Man, Woman\n}'],
['categorizer-on-relation-set', 'Generalization sets', 'A set of relations has no categorizer. A categorizer\u2019s instances are the set\u2019s specific types, and in a set of relations those are relations, which no class of types has as instances -- nor can gUFO say it, since its categorization pattern relates classes by "rdfs:subClassOf".',
 'kind Person\nrelation Person [*] -- owns -- [*] Person\nrelation Person [*] -- leases -- [*] Person specializes Person.owns\ntype Tenure\ngenset byTenure {\ngeneral Person.owns\ncategorizer Tenure\nspecifics Person.leases\n}'],
['namespace-malformed', 'Documentation', 'An ontology\u2019s "@namespace" is an absolute http(s) IRI ending in "#" (one document describes every term) or "/" (each term is its own address), with no query and no other "#", and not the namespace of OWL, RDF, RDFS, XSD or gUFO.',
 { docs: ['/// @namespace https://example.org/shop\nontology sales\nkind Customer'], focus: 0 }],
['duplicate-namespace', 'Documentation', 'An ontology has one namespace; a second "@namespace" would be ignored.',
 { docs: ['/// @namespace https://example.org/shop/sales#\n/// @namespace https://example.org/sales#\nontology sales\nkind Customer'], focus: 0 }],
['ontology-tag-not-on-header', 'Documentation', '"@namespace", "@version", "@license" and "@creator" describe an ontology -- where its terms are published, and the header of its gUFO export -- so they belong above its "ontology" header. On a package they would say that a part of an ontology has a namespace or a version of its own, which it has not: it is published with its ontology. On any other declaration they say nothing. The repair moves the tag to the header when the header does not say it yet, or removes it.',
 { docs: ['ontology sales\n/// @license https://creativecommons.org/licenses/by/4.0/\nkind Customer'], focus: 0 }],
['duplicate-ontology-tag', 'Documentation', 'An ontology is published under one version and one license; a second "@version" or "@license" would be ignored. Creators may be several, one "@creator" line each.',
 { docs: ['/// @version 1.0.0\n/// @version 1.1.0\nontology sales\nkind Customer'], focus: 0 }],
['namespace-name-clash', 'Documentation', 'The packages of one ontology publish into one namespace and one file, so a classifier name may be used by only one of them: two declarations of "Customer" would be one IRI.',
 { docs: ['ontology shop\npackage sales\nkind Customer\npackage billing\nkind Customer'], focus: 0 }],
['partition-single-specific', 'Generalization sets', 'A partition over one specific makes it equivalent to the general.',
 'kind Person\nphase Adult specializes Person\ndisjoint complete genset Ages where Adult specializes Person'],
['lone-phase', 'Generalization sets', 'A partition of phases needs at least two phases, and one phase is not a partition to look for: either the phase it alternates with is missing, or what was meant is a rigid subdivision. A hint, since only the modeler knows which.',
 'kind Person\nphase Adult specializes Person'],
['partition-mixes-phases', 'Generalization sets', 'The same clause, read the other way: "no specializing class decorated with another OntoUML class stereotype". A set mixing a phase with a subkind says an individual is in exactly one of them, which is two claims at once \u2014 one about a stage that passes and one about a division that does not.',
 'kind Person\nphase Adult specializes Person\nphase Child specializes Person\nsubkind Man specializes Person\ndisjoint complete genset ages where Adult, Child, Man specializes Person'],
['phases-without-partition', 'Generalization sets', 'Phases divide a lifecycle, so each belongs in a disjoint complete set. A class that changes along more than one line \u2014 a person a child or an adult, and ill or healthy \u2014 has one partition for each.',
 'kind Person\nphase Child specializes Person\nphase Adult specializes Person'],
['phase-mixins-without-partition', 'Generalization sets', 'The same for phase mixins, which are phases over more than one kind: they come in partitions, whose members are alternative intrinsic conditions for entities that may follow different identity principles \u2014 living and deceased animals, functional and broken devices. Two of them under one type that no disjoint complete set covers leave unsaid that an instance is in exactly one. As with phases, a type that changes along more than one line has one partition for each.',
 'category Device of functional-complexes\nphaseMixin FunctionalDevice specializes Device\nphaseMixin BrokenDevice specializes Device\nkind Phone specializes Device\nphase WorkingPhone specializes Phone, FunctionalDevice\nphase BrokenPhone specializes Phone, BrokenDevice\ndisjoint complete genset phoneStatus where WorkingPhone, BrokenPhone specializes Phone\nkind Printer specializes Device\nphase WorkingPrinter specializes Printer, FunctionalDevice\nphase BrokenPrinter specializes Printer, BrokenDevice\ndisjoint complete genset printerStatus where WorkingPrinter, BrokenPrinter specializes Printer\ndisjoint complete genset working where WorkingPhone, WorkingPrinter specializes FunctionalDevice\ndisjoint complete genset broken where BrokenPhone, BrokenPrinter specializes BrokenDevice'],
// --- Relations: stereotype semantics ------------------------------------
['characterization-bearer-not-reifiable', 'Relations', 'Aspects are reified for what has a life to bear them: the endurants, and processes, which are fast now and slow later. An event is over, and a situation, insofar as it obtains, is fact-like \u2014 nothing about it varies while it stays that situation \u2014 so what would have been an aspect of either is recorded as a "const" property of it instead.',
 'event Wedding\nquality Duration {\nhours: number\n@characterization -- [1] (const) Wedding\n}'],
['relation-end-nature-mismatch', 'Relations', 'Each relation stereotype admits only certain natures at each end \u2014 "@mediation" runs from a relator to what it binds, "@characterization" from an aspect to its bearer. "tonto tables" prints the whole grid. Sometimes the stereotype at an *end* is the only thing wrong \u2014 an "intrinsicMode" that declares an "@externalDependence" is an extrinsic mode that has not said so \u2014 and where exactly one word would let the class stand where it stands, and its own natures and taxonomy admit that word, the repair offers it. Where several would, what the class is is the question, and a list of guesses is no answer.',
 'kind Person\nkind Car\n@mediation relation Person [1] -- drives -- [1] Car'],
['relation-ends-reversed', 'Relations', 'Each relation stereotype admits only certain natures at each end. Where the reverse direction is the admissible one, the ends are probably the wrong way round \u2014 offered as a repair, but not applied for you: swapping them and rewriting the stereotype are two readings of the same line, and which was meant is the modeler\u2019s to say.',
 'kind Person\nrelator Employment\n@mediation relation Person [1] -- holds -- [1] Employment'],
['characterization-bearer-multiplicity', 'Relations', 'A characterized moment inheres in exactly one bearer.',
 'kind Person\nquality BodyWeight\n@characterization relation BodyWeight -- [0..*] Person'],
['participational-portion-multiple-participants', 'Relations', 'A participational decomposition projects one maximal event portion for each endurant on which events in that portion exclusively depend. The whole event may have many participants; one such portion cannot. Its explicit "@participation" therefore has maximum one at the participant end.',
 'kind Person\nevent Meeting {\n@participational (const) [1] <>-- [2..*] (const) AttendeeParticipation\n}\nevent AttendeeParticipation\n@participation relation Person (const) [1..*] -- attended -- [0..*] (addOnly) AttendeeParticipation'],
['participational-portion-two-participants', 'Relations', 'A participational portion is the part of an event that depends on exactly one endurant, which gUFO states as a "gufo:Participation" having exactly one participant. Read one at a time, two "@participation" relations into the portion can each say one and pass; together they require two, and where the two participants cannot be one individual -- distinct kinds, a disjoint set, natures with nothing in common -- no portion satisfies the model. Participations into a type above the portion count, since its instances are instances of that type. Two readings, so two repairs and neither applied for you: the part is not one participant\'s portion, and the parthood is "@structural"; or one of them took part in the whole event, and its participation moves there.',
 'kind Person\nkind Message\nevent InformationDisorder {\n@participational (const) [1] <>-- [2..*] (const) AgentParticipation\n}\nevent AgentParticipation\n@participation relation Person (const) [1] -- acted -- [0..*] (addOnly) AgentParticipation\n@participation relation Message (const) [1] -- figured -- [0..*] (addOnly) AgentParticipation'],
['participational-portion-participants-coincide', 'Relations', 'The same count, where the two participants could be one individual -- two roles of the same kind, say. Every portion then satisfies the model, but only because the two are the same individual every time, which is rarely what two relations were written to say. A warning, with the same two repairs.',
 'kind Person\nrole Speaker specializes Person\nrole Listener specializes Person\nevent Conversation {\n@participational (const) [1] <>-- [2..*] (const) Turn\n}\nevent Turn\n@participation relation Speaker (const) [1] -- spoke -- [0..*] (addOnly) Turn\n@participation relation Listener (const) [1] -- listened -- [0..*] (addOnly) Turn'],
['relator-mediates-one', 'Relations', 'A relator existentially depends on at least two individuals.',
 'kind Person\nrelator Marriage {\n@mediation [0..*] -- [1] Person\n}'],
['moment-without-bearer', 'Relations', 'A quality or mode inheres in something, so something must bear it.',
 'kind Person\nquality BloodPressure {\n-- [1] (const) Person\n}'],
['parthood-descends-forever', 'Relations', 'Proper parthood is irreflexive, so a cycle every step of which is required cannot be satisfied: each whole needs a part that needs a part, and the parts never bottom out. A cycle among *types* entails nothing on its own \u2014 \u201ckind Node { @componenthood [0..1] <>-- [*] Node }\u201d is a tree, and it stops at a leaf. What makes it unsatisfiable is the lower bound at the part end, which an omitted multiplicity sets to one here as everywhere else in tonto: \u201c<>-- Node\u201d says every node contains a node. The repair drops that bound to zero.',
 'kind Department {\n@componenthood [0..1] <>-- [1..*] Team\n}\nkind Team {\n@componenthood [0..1] <>-- [1] Department\n}'],
['parthood-climbs-forever', 'Relations', 'The same axiom read the other way. Each part belongs to a whole that belongs to a whole, and the wholes never top out. The bound that says so is the one beside the whole, which an omitted multiplicity also sets to one \u2014 a bare diamond claims exactly one whole, which is what \u201c<o>--\u201d used to say and why it was dropped \u2014 so \u201c<>-- [0..1] Node\u201d still climbs however freely the decomposition stops. A tree is \u201c[0..1] <>-- [*]\u201d, and the repair writes that bound. Reported separately from the descent, since the two are separate claims made by separate multiplicities, and a model may make both.',
 'kind Node {\n@componenthood <>-- [0..1] Node\n}'],
['quantity-part-not-essential', 'Relations', 'A quantity is an extensional individual: "the change of any of its parts changes the identity of the whole. In other words, all parts of a quantity are essential" (Guizzardi 2005, \u00a78.3). The end holding the part is the whole\'s property, so marking it "(const)" is what says the whole cannot come to have a different one. An error, where the rest of the immutability family warns: those report a model that left unsaid what its own natures settle, while this one is stated as a constraint \u2014 a quantity whose parts may change is not a quantity. Written against the nature, not the stereotype: a bare diamond from a quantity says the same thing.',
 'quantity Wine {\n@subQuantity [1] <>-- [1] Alcohol\n@subQuantity [1] <>-- [1] Water\n}\nquantity Alcohol\nquantity Water'],
['sub-collection-multiplicity', 'Relations', 'A sub-collection is obtained by refining the unifying relation of the collective, and the refinement picks out one: "any collective can have at maximum one subcollection of a given type" (Guizzardi 2005, \u00a78.3). Per kind, like the sub-quantity rules \u2014 a relation between non-sortals quantifies over every kind at once.',
 'collective Orchestra {\n@subCollection [1] <>-- [2..*] StringSection\n}\ncollective StringSection'],
['essential-part-of-anti-rigid-whole', 'Relations', '"Only rigid universals can participate as wholes in essential parthood relations. In the case of anti-rigid universals, the modal necessity of the parts can only be a case of de dicto necessity. These parts are named immutable parts instead" (Guizzardi 2005, \u00a78.3). Nothing is wrong \u2014 the modeler may mean exactly this \u2014 but what they may have meant is essential, and the place to say that is the kind.',
 'kind Person\nkind Badge\nrole Employee specializes Person {\n@componenthood [1] <>-- [1] (const) Badge\n}'],
['sub-quantity-multiplicity', 'Relations', 'A quantity is maximal, so "since every part of a quantity is itself a quantity, Q-parthood must have a cardinality constraint of one and exactly one in the subquantity side": there is exactly one portion of alcohol in a given portion of wine.',
 'quantity Wine {\n@subQuantity [1] <>-- [0..*] (const) Alcohol\n@subQuantity [1] <>-- [1] (const) Water\n}\nquantity Alcohol\nquantity Water'],
['sub-quantity-shared', 'Relations', 'Maximality again: if a portion of alcohol were part of two portions of wine, those two would overlap and so be part of a larger self-connected portion, which contradicts both being maximal. Non-shareable is what the whole end\u2019s upper bound says \u2014 it used to be what a filled diamond said, and the rule read the glyph, so a model writing "[1]" there was told to say it differently.',
 'quantity Wine {\n@subQuantity [0..*] <>-- [1] (const) Alcohol\n@subQuantity [1] <>-- [1] (const) Water\n}\nquantity Alcohol\nquantity Water'],
// --- Relations: UML structure -------------------------------------------
['multiplicity-inverted', 'Multiplicities', 'Bounds must be ordered.',
 'kind Author\nkind Book {\n[5..2] -- writtenBy -- [1] Author\n}'],
['multiplicity-star-lower', 'Multiplicities', '"*" is not a lower bound.',
 'kind Author\nkind Book {\n[*..3] -- writtenBy -- [1] Author\n}'],
['multiplicity-zero-upper', 'Multiplicities', 'An upper bound of zero makes the end impossible to instantiate.',
 'kind Author\nkind Book {\n[0..0] -- writtenBy -- [1] Author\n}'],
['end-holds-more-than-general', 'Relations', 'Three spellings of one claim \u2014 a relation that "specializes" another, an end that "subsets" another, an end that "redefines" another \u2014 and in each the links here are among the links there. So an end that *requires* more than the other permits is unsatisfiable, which is an error; one that merely *permits* more is bounded by the other whatever it says, which is imprecision and a warning. Requiring fewer is neither: a department has staff and may have no professors.',
 'kind Person\nkind Department {\n-- [0..2] (staff) Person\n-- [3..*] (subsets Department.staff) Person\n}'],
['redefinition-weakens-lower-bound', 'Relations', 'A redefining end replaces the end it redefines for instances of the subtype, so the two hold the same links under two names and what the redefined end requires still has to hold of them. This is the one thing subsetting does not carry over: a subsetting end draws from the other and may be smaller, empty included.',
 'kind Person\nkind Team {\n-- [2..*] (members) Person\n}\nsubkind Squad specializes Team {\n-- [0..*] (redefines Team.members) Person\n}'],
['empty-end-decorator', 'Relations', 'The parentheses are what a relation end is written in, and an empty pair is one someone started and did not finish. It parses, so nothing else would ever mention it.',
 'kind Person\nkind Department {\n-- [1..*] () Person\n}'],
['end-self-reference', 'Relations', 'An end cannot subset or redefine itself.',
 'kind Person\nkind Department {\n-- [1..*] (staff subsets Department.staff) Person\n}'],
['inverse-ends-differ', 'Relations', 'An inverse is one association read the other way, so it has the same two ends \u2014 crossed over, since what is the source here is the target there. Two statements of one association that disagree about a multiplicity or a flag are two claims about one thing, and nothing read the second one. A name is not part of what has to agree: an end named on one side and not on the other has left something unsaid, and the repair carries that name over rather than dropping it.',
 'kind Person {\n@historicalDependence (addOnly children) [*] -- hasFather -- [1] (const father) Man\n}\nsubkind Man specializes Person {\n-- hasChildren -- Person inverseOf Person.hasFather\n}'],
['matching-inverse', 'Relations', 'Two named associations whose types, multiplicities, end flags, end names, overrides and diamonds agree exactly after crossing the ends may be two declarations of one association. The shape cannot prove that -- two distinct relationships may share a signature -- so this is a hint whose repair states the modeler\'s choice explicitly by adding reciprocal "inverseOf" clauses. Not said of a relation that already has an inverse, from either side, nor of two relations from a class to itself whose ends read the same either way round, where agreeing crossed says no more than running the same way.',
 'kind Person\nkind Organization\nrelation Person [0..*] -- worksFor -- [1] Organization\nrelation Organization [1] -- employs -- [0..*] Person'],
['self-inverse', 'Relations', 'A relation cannot be its own inverse.',
 'kind Person\nrelation Person [1] -- supervises -- [0..*] Person inverseOf supervises'],
['parthood-specialization-mismatch', 'Relations', 'Instances of the specializing relation are instances of the general one, so if either states that its ends stand in parthood, both do. Subsetting and redefining an end imply the specialization, so they carry the rule with them.',
 'kind Car\nkind Wheel\nrelation Car [1] -- has -- [4] Wheel\n@componenthood relation Car [1] <>-- fits -- [4] Wheel specializes Car.has'],
['diamond-without-parthood', 'Relations', 'A diamond states parthood, so a stereotype that is not a parthood one contradicts it. The diamond is what makes an unstereotyped relation parthood, which is why the acyclicity and supplementation rules read it \u2014 and that only holds together if the two never disagree.',
 'kind Person\nkind Organization\n@material relation Organization [1] <>-- employs -- [0..*] Person'],
['parthood-without-diamond', 'Relations', 'The stereotype states parthood and the notation states an ordinary association, so the two disagree and nothing marks which end is the whole. Which side the diamond belongs on follows from the natures, since parthood entries read (whole, part).',
 'collective Fleet\nkind Car\n@membership relation Fleet [1] -- [2..*] Car'],
['implied-relation-specialization', 'Relations', 'An end reference names exactly one relation, so subsetting or redefining implies the specialization rather than needing it declared \u2014 said quietly, since writing it makes the taxonomy readable without following the reference. An anonymous relation is not mentioned, having no name a clause could hold.',
 'kind Component\nkind Vehicle {\n@componenthood [*] <>-- hasPart -- [*] (parts) Component\n}\nsubkind Car specializes Vehicle {\n@componenthood [*] <>-- hasWheel -- [*] (wheels redefines Vehicle.parts) Component\n}'],
['immutable-end-not-const', 'Relations', 'A warning rather than an error: the model is not contradictory, it has left "(const)" unwritten where its own natures settle the matter. An end is a property of the classifier at the *opposite* end, so an end belonging to an event or an abstract individual cannot change \u2014 they cannot. A process is not immutable: its constitution varies as it goes on, which is what its changing consists in. Histories are different: what later stands in a situation, what it triggers, what an event brings about, and what comes to depend on something past may accumulate without the settled individual itself changing.',
 'kind Place\nevent Wedding {\n-- [1] (venue) Place\n}'],
['dependence-end-not-mandatory', 'Relations', 'Two dependences are constitutive of what stands at the near end: a relator that binds nothing is not a relator, and an extrinsic mode with nothing beyond its bearer to depend on is an intrinsic one. So the end naming what is depended on starts at one or more. The other two are left alone \u2014 "@characterization" because "characterization-bearer-multiplicity" asks for the stronger "[1]", and "@historicalDependence" because standing in it is not what makes anything what it is: gUFO\u2019s own "historicallyDependsOn" runs "[*]" to "[*]" between concrete individuals.',
 'kind Person\nextrinsicMode Commitment {\n@characterization [*] -- [1] (const) Person\n@externalDependence [*] -- [0..1] (const) Person\n}'],
['dependence-end-not-const', 'Relations', '"@characterization", "@mediation" and "@externalDependence" are existential dependence written down: a quality inheres in one individual, a relator in those it binds, an extrinsic mode in something beyond its bearer. None survives losing what it depends on, so no existing link can be removed or re-pointed. A plural end may be closed with "const" or left able to gain dependencies with "addOnly". "@historicalDependence" is settled for another reason \u2014 the past does not stop having happened.',
 'kind Person\nquality Weight {\n@characterization -- [1] Person\n}'],
['const-not-propagated', 'Relations', 'A subsetting end may not relax a read-only end.',
 'kind Person\nkind Department {\n-- [1..*] (const staff) Person\n-- [1] (subsets Department.staff) Person\n}'],
// --- Documentation -----------------------------------------------------
['legacy-text-block', 'Documentation', 'A "label" or "description" block says about a classifier what "///" says about any declaration, in text a string literal cannot always hold -- there is no escape for a quote -- and it is edited a block at a time. The blocks still parse; the fix converts one.',
 'kind Person {\nlabel { @en "Person" }\n}'],
['duplicate-doc-language', 'Documentation', 'A language documents a declaration once. A second writing in the same language is dropped, so the model says something the reader cannot see.',
 '/// @en A human being.\n/// @en Someone else.\nkind Person'],
['empty-doc-tag', 'Documentation', 'A tag with no text after it names a language and says nothing in it.',
 '/// @pt-br\nkind Person'],
['doubtful-doc-language', 'Documentation', 'Nothing about the shape of a tag tells a language apart from a slip in one -- "pt-b" is as well formed as "pt-br" -- so the rest of the document answers instead: a language written once, one edit from one written repeatedly, is a slip.',
 '/// @pt-br Uma pessoa.\nkind Person\n/// @pt-br Uma organização.\nkind Organization\n/// @pt-b Um veículo.\nkind Vehicle'],
['unknown-doc-tag', 'Documentation', 'A line beginning with "@" is prose unless the word names a language or is "label" -- a sentence about "@mediation" has to be writable. Reported only where the word is one edit away from a tag that is meant, which is where it is a slip rather than a sentence.',
 '/// @labl Person\nkind Person'],
// --- Time points --------------------------------------------------------
['unknown-attribute-stereotype', 'Time points', 'The only attribute stereotypes are "@begin" and "@end". The grammar takes any word after "@" so a slip is answered by name, with a suggestion, rather than by a parse error.',
 'kind Person {\n@bgin birth: const date\n}'],
['duplicate-attribute-stereotype', 'Time points', 'One attribute may carry both "@begin" and "@end" \u2014 that is how an instantaneous individual is written \u2014 but not the same one twice.',
 'kind Person {\n@begin @begin birth: const date\n}'],
['time-point-on-atemporal-owner', 'Time points', 'Only something in time begins and ends. Concrete individuals are everything but the abstract ones: endurants (a high-order "type" among them), events and situations. A datatype describes values, and 3 does not begin.',
 'abstractum MonetaryValue {\n@begin recordedAt: const date\n}'],
['time-point-not-const', 'Time points', 'When something began is settled by its beginning, and once it has ended, when it ended is settled too, so both "@begin" and "@end" are "const".',
 'kind Person {\n@begin birth: date\n}'],
['end-time-point-not-mandatory', 'Time points', 'An event has ended \u2014 that is what makes it one \u2014 so it has an end point. An endurant that still exists, a process going on and a situation obtaining are the ones that may not, and those are what "[0..1]" is for.',
 'datatype date\nevent Wedding {\n@end finishedAt: const date [0..1]\n}'],
['creation-end-not-const', 'Relations', 'An individual comes into existence in exactly one event, and that event is over, so the link cannot be re-pointed: the event end of a "@creation" is "(const)" for the whole of the individual\u2019s life. Not covered by "immutable-end-not-const", which reads the nature of the classifier the end belongs to \u2014 and the endurant that owns this end changes freely. "@termination" is a different shape: its event end is "[0..1]", so the link is made once and never broken, which is "(addOnly)".',
 'event Birth\nkind Person {\n@creation (const) [1] -- [1] Birth\n}'],
['immutable-attribute-not-const', 'Time points', 'An event is over, and a situation, insofar as it obtains, is fact-like: its constituents and their properties are what it is, and altering them would make it a different situation. A value is what its components are, so a datatype\'s attribute is fixed the same way: an address with another street is another address. So an attribute of any of these holds the same value for as long as there is anything to hold it. The same reasoning as "immutable-end-not-const", about the other half of what a classifier declares.',
 'datatype date\nevent Wedding {\nheldAt: date\n}'],
['end-time-point-not-optional', 'Time points', 'An endurant that still exists has no end point yet, so on a class of endurants "@end" holds of some instances and not others. An event is not in this position: a modeled event is one that occurred, and it has both instants.',
 'kind Person {\n@end death: const date\n}'],
['add-only-with-nothing-to-add', 'Relations', '"addOnly" says a collection only ever grows: values may be added and never removed or replaced. Where the number of them is fixed \u2014 "[1]", "[2]", or nothing written \u2014 nothing can be added, and "const" is what fixes them. An optional end is not fixed: "[0..1] (addOnly)" says the link may be made once and never broken, which is what "accumulating-end-not-add-only" asks for. Two readings, so two repairs and neither applied for you: the flag is wrong, or the bound is \u2014 and the second keeps the lower bound, since how many are *required* is a separate claim.',
 'kind Person\nkind Department {\n-- [1] (addOnly) Person\n}'],
['add-only-on-immutable', 'Relations', 'An end is a property of the classifier at the *opposite* end, so an end belonging to an event or an abstract individual cannot change at all \u2014 and a collection that cannot change is not one that grows. Parts and outward histories escape this: a situation may gain parts, and the world around a settled individual may add what stands in it, what it triggers or brings about, and what comes to depend on it, without changing that individual.',
 'kind Place\nevent Wedding {\n-- [2..*] (addOnly venues) Place\n}'],
['add-only-not-propagated', 'Relations', 'A redefinition may strengthen what it redefines, never weaken it: an end that only grows cannot be redefined by one that may shrink. The step down from "const" is caught by "const-not-propagated"; this is the other one.',
 'kind Person\nkind Team {\n<>-- [2..*] (addOnly members) Person\n}\nsubkind Squad specializes Team {\n<>-- [2..*] (players redefines Team.members) Person\n}'],
['accumulating-end-not-add-only', 'Relations', 'The life of a process accumulates as it goes on: the events constituting it later have those constituting it earlier as a starting part, and so do its temporal parts (Guarino & Guizzardi 2024, A7). Nothing is taken back, which is "addOnly". The axiom says the stronger thing \u2014 the earlier constitution is a *prefix* of the later \u2014 and the language has no word for it since "ordered" became an attribute flag alone. A situation gains parts the same way, and so does the dependent end of a "@historicalDependence": what has come to depend on something past never stops, since the past does not change. A hint for the first three, where a model may reasonably be indifferent to how a process unfolds, and a warning for historical dependence, where the far end of the same relation is "const" for the same reason.',
 'process Baking\nevent Kneading\n@constitution relation Baking (const) [1] -- [1..*] Kneading'],
['ordered-single-valued', 'Hygiene', '"ordered" says nothing about an attribute holding at most one value. An end has no "ordered" to say it about \u2014 a sequence at an association end was a claim no rule here read.',
 'datatype string\nkind Person {\nname: ordered string\n}'],
// --- Declarations and hygiene -------------------------------------------
['duplicate-member', 'Hygiene', 'Two members of one classifier cannot share a name.',
 'kind Person {\nname: string\nname: string\n}'],
['relation-without-target', 'Relations', 'A relation needs something at its far end. The grammar accepts one without, so that a half-written relation still parses and every other rule still has something to say about it \u2014 a mandatory target made the parser discard the whole declaration and answer with "Expecting token of type \'EOF\'".',
 'kind Person\nkind Company\nrelation Person [1] -- worksAt -- [1] '],
['diamond-marks-both-ends', 'Relations', 'A diamond marks the whole of a parthood, and a relation with one at each end claims both ends are the whole of the other \u2014 which no part can be. Written with a name in between, "<>-- name --<>", or bare, this used to leave the parser matching the first marker alone as a relation with no target and starting a second, unrelated one from whatever came after the second marker.',
 'kind Person\nkind Company\nrelation Person <>-- worksAt --<> Company'],
['unknown-relation-stereotype', 'Hygiene', 'A stereotype the language does not define; the grammar accepts any word after "@" so a slip is reported with a suggestion.',
 'kind Person\nrelator Employment\n@mediaton relation Employment [1] -- involves -- [1] Person'],
['extrinsic-mode-without-dependence', 'Relations', 'An extrinsic mode depends on something beyond its bearer, and that is what distinguishes it from an intrinsic one, so the model has to say what: a commitment inheres in the person committed and depends on the one committed to. The same omission "moment-without-bearer" reports, one dependence over.',
 'kind Person\nextrinsicMode Commitment {\n@characterization -- [1] (const) Person\n}'],
['event-without-participation', 'Relations', 'An event is what its participants are doing, and it exists only because they are doing it: a wedding is the two who marry, and an event type with nothing taking part in it names an occurrence with nobody in it. The same omission "relator-without-mediation" reports of a relator and "moment-without-bearer" of a moment. Satisfied by anything that endures being related to it by what it does \u2014 taking part in it, being created or terminated by it, changing in it, being manifested in it \u2014 and by a participant of one of its parts, or of the process it constitutes, since those take part in it too. A hint, except on a participational portion: that is projected by dependence on one endurant, so the participant is what the type is, and leaving it out is a warning, as it is for a relator or a moment.',
 'kind Person\nevent Wedding\nrelation Person [1..*] -- [1] Wedding'],
['process-without-constitution', 'Relations', '"At each time, a process is constituted by a certain series of events" (Guarino & Guizzardi 2024, \u00a73.1, axiom A5), and nothing else constitutes one. A process with no events behind it says that something is going on and not what happens in it.',
 'event Fold\nprocess Baking {\n-- [1..*] Fold\n}'],
['material-without-relator', 'Relations', 'A material relation is derived from an extrinsic aspect: usually a relator, whose mediations are read together, or for a one-sided relation an extrinsic mode that inheres in one end and externally depends on the other. Written with neither named, it states a connection and nothing that makes it true \u2014 which is what a plain association says, and what a "@comparative" says when the connection is founded on qualities instead. A hint because the grounding aspect is often in a file nobody has opened, and leaving it unmodeled is a defensible simplification.',
 'kind Person\nkind Organization\n@material relation Person [0..*] -- worksFor -- [0..*] Organization'],
['derivation-unstated', 'Relations', 'A material relation is derived from the relator that binds its ends, and "derivedFrom" says which. Where a relator mediating both ends is already in the model, the relation is presumably read off it -- but that is an inference, and two relators can bind the same pair (an employment and a contract both relate employee and employer), so the derivation is written rather than found. An inverse is the same association read backwards, so it inherits a derivation already stated on its inverse declaration and need not repeat it. Written, the derivation is also what the gUFO export turns into gufo:isDerivedFrom. A hint: an unstated derivation is incomplete, not wrong.',
 'kind Person\nrole Employee specializes Person\nkind Organization\nrelator Employment {\n@mediation [1..*] -- [1] (const) Employee\n@mediation [0..*] -- [1] (const) Organization\n}\n@material relation Employee [0..*] -- worksFor -- [1..*] Organization'],
['derivation-on-underived-relation', 'Relations', 'Only two kinds of relation are derived: a material relation, read off the relator that binds its ends, and a comparative one, read off the qualities it compares. Every other relation is the connection itself -- a mediation is the relator\u2019s own dependence, a parthood the whole\u2019s structure -- so "derivedFrom" on one names a ground for something that has none. Usually the stereotype was left out.',
 'kind Person\nrole Employee specializes Person\nkind Organization\nrelator Employment {\n@mediation [1..*] -- [1] (const) Employee\n@mediation [0..*] -- [1] (const) Organization\n}\nrelation Employee [0..*] -- worksFor -- [1..*] Organization derivedFrom Employment'],
['derivation-source-nature', 'Relations', 'What a relation is derived from is an aspect: a material relation is read off an extrinsic one -- the relator binding its ends, or an extrinsic mode inhering in one and depending on the other -- and a comparative relation off intrinsic ones, the qualities or intrinsic modes it compares. These are also the only things gUFO lets gufo:isDerivedFrom point at.',
 'kind Person\nquality Height {\n@characterization [1] -- [1] (const) Person\n}\n@comparative relation Person [0..*] -- tallerThan -- [0..*] Person derivedFrom Person'],
['material-derived-from-many', 'Relations', 'A material relation is the mediations of one relator read together: someone works for a company because there is an employment. Two relators bind two sets of links, and one relation derived from both would say that a contract and an employment are one connection. Write a relation for each.',
 'kind Person\nrole Employee specializes Person\nkind Organization\nrelator Employment {\n@mediation [1..*] -- [1] (const) Employee\n@mediation [0..*] -- [1] (const) Organization\n}\nrelator Contract {\n@mediation [1..*] -- [1] (const) Employee\n@mediation [0..*] -- [1] (const) Organization\n}\n@material relation Employee [0..*] -- worksFor -- [1..*] Organization derivedFrom Employment, Contract'],
['derivation-not-grounded', 'Relations', 'What a relation is derived from has to reach what it relates: the relator has to mediate both ends, an extrinsic mode has to inhere in one and depend on the other, and a compared quality has to be borne at each end. A mediation or characterization anywhere up the lineage counts. Naming a relator that does not bind a material end is an error because the stated derivation cannot hold; the mode and comparative cases remain warnings while their dependency structure may merely be unfinished.',
 'kind Person\nrole Employee specializes Person\nrole Member specializes Person\nkind Organization\nrelator Employment {\n@mediation [1..*] -- [1] (const) Employee\n@mediation [0..*] -- [1] (const) Organization\n}\nrelator Membership {\n@mediation [1..*] -- [1] (const) Member\n@mediation [0..*] -- [1] (const) Organization\n}\n@material relation Employee [0..*] -- worksFor -- [1..*] Organization derivedFrom Membership'],
['material-cardinality-mismatch', 'Relations', 'A material relation is the two mediation paths through its relator read together. If a relator relates `S` and `T`, the `S`s per `T` are at most the relators per `T` times the `S`s per relator, and at least the lower bound of the `S`s per relator, where a `T` must have a relator at all -- two relators may bind the same pair, so lower bounds do not multiply. The other end is derived symmetrically, and an omitted multiplicity is `[1]`. A written multiplicity sharing no number with the derived one says what the mediations make impossible. Either may be wrong, so the repair -- writing the derived multiplicity -- is not applied for you.',
 'kind Person\nkind Organization\nrelator Employment {\n@mediation [1] -- [1] (const) Person\n@mediation [0..*] -- [1] (const) Organization\n}\n@material relation Person [0..*] -- worksFor -- [2..*] Organization derivedFrom Employment'],
['material-cardinality-weaker', 'Relations', 'The same derivation, where the written multiplicity admits numbers the mediations rule out: someone with at least one employment works for at least one organization, so "[0..*]" says less than the model already does. Not a contradiction, so a warning; the repair writes what both allow, keeping any bound the end states more narrowly.',
 'kind Person\nkind Organization\nrelator Employment {\n@mediation [1..*] -- [1] (const) Person\n@mediation [0..*] -- [1] (const) Organization\n}\n@material relation Person [0..*] -- worksFor -- [0..*] Organization derivedFrom Employment'],
['material-cardinality-narrower', 'Relations', 'The same derivation, where the written multiplicity is narrower than the derived one. That is a constraint of the relation\'s own, and a derived relation may state one: someone may hold several employments and still work for one organization. A hint, with a repair writing the derived multiplicity for where the narrowing was not meant.',
 'kind Person\nkind Organization\nrelator Employment {\n@mediation [1..*] -- [1] (const) Person\n@mediation [0..*] -- [1] (const) Organization\n}\n@material relation Person [0..*] -- worksFor -- [1] Organization derivedFrom Employment'],
['material-cardinality-ambiguous', 'Relations', 'The cardinalities of a material relation can be calculated only when its relator has one identifiable mediation role for each distinct end. A self relation may instead use exactly two same-typed mediations in one file: the earlier one supplies its source role and the later one its target. More candidates, or two split across files with no declaration order between them, leave a choice the model does not state. A warning with no repair.',
 'kind Person\nkind Organization\nrelator Contract {\n@mediation [1] -- [1] (const) Person\n@mediation [0..*] -- [1] (const) Person\n@mediation [0..*] -- [1] (const) Organization\n}\n@material relation Person [0..*] -- partyTo -- [1] Organization derivedFrom Contract'],
['founding-relation-optional', 'Relations', 'What founds a role is the one thing its instances cannot lack: a student with no enrollment is not a student, and a former employee who took part in nothing did not become one. So where a single relation founds a role -- a relator mediating it, a whole it is part of, or for a historical role the event it took part in -- the multiplicity at the far end says at least one. Where several relations found it, each may stay optional, since one is enough: someone retired or was dismissed. The gUFO export writes the condition either way; this asks the model to say what the stereotype already does. A hint, since the other reading is a founding relation not yet written.',
 'kind Person\nrole Student specializes Person\nkind University\nrelator Enrollment {\n@mediation [0..*] -- [1] (const) Student\n@mediation [0..*] -- [1] (const) University\n}'],
['role-without-relator', 'Relations', 'A role holds while a relationship does, and the relator is that relationship: what makes someone a student is an enrollment. If nothing mediates the role then either the relator is missing or the type is not a role \u2014 a phase, where the condition is intrinsic. Being part of something founds a role too, and needs no relator to do it: a main motor is a motor a boat has as its main one. A hint, because the relator often lives in a file the workspace has not opened, and because leaving it unmodeled is a defensible simplification.',
 'kind Person\nrole Student specializes Person'],
['collective-without-members', 'Relations', 'A collective is a plurality, and the model should say what it is a plurality of: a "@membership" reaching the type of its members. A hint rather than a warning, because a collective is a plurality whether or not the model has got round to naming its members \u2014 but a collective whose members are nowhere is very often a "kind". Satisfied anywhere in the lineage, by a complete partition whose specifics each say it, and by the members of a sub-collection, which are members of the collection it is part of.',
 'kind Musician\ncollective Orchestra {\n[1] <>-- [2..*] Musician\n}'],
['relator-without-mediation', 'Relations', 'A relator exists by binding what it relates, so it needs a "@mediation"; the fix stereotypes an association the relator already has.',
 'relator Marriage {\n[1] -- [2] (spouses) Person\n}\nkind Person'],
['parthood-crosses-natures', 'Relations', 'A diamond states parthood even with no stereotype, and outside the substantials parthood does not cross natures: an event has events as parts, a situation situations, a relator relators. One thing widens that: a collective admits members of any substantial nature. A process is not a second: what it gains from events is its constitution, which is a relation of its own.',
 'collective Forest\nkind Person {\n<>-- [1] Forest\n}'],
['implied-relation-stereotype', 'Relations', 'The natures at the ends narrow what the relation could be, so the stereotypes that fit can be listed with the likeliest first; the code actions write any of them. A plain association stays valid, which is why this is a hint and not a warning.',
 'relator Marriage\nkind Person\nrelation Marriage [1] -- [2] Person'],
['type-name-case', 'Hygiene', 'Type names are capitalized; the built-in datatypes are the exception.',
 'kind automovel'],
['member-name-case', 'Hygiene', 'Member names are not capitalized.',
 'kind Person {\nFullName: string\n}'],
['package-name-case', 'Hygiene', 'Package names are written in lower case, a segment at a time -- "university.people", "core.datatypes" -- as legacy tonto\u2019s documentation and "tonto init" write them, so that in "sales.Customer" the namespace and the class read differently. The repair renames every use of the package and every name it qualifies, in each file that writes one.',
 { docs: ['ontology law\npackage LegalRegistry\nkind Statute'], focus: 0 }],
['datatype-specializes-non-abstract', 'Hygiene', 'A datatype may only specialize a class whose instances are abstract individuals \u2014 an "abstractum", or any class restricted to that nature. Asked of the natures, not the stereotype.',
 'kind Place\ndatatype Address specializes Place'],
// --- Anti-patterns ------------------------------------------------------
['RelSpec', 'Anti-patterns', 'A relation between more specific types than one it resembles may need to specialize it.',
 'kind Person\nkind Organization\nrole Executive specializes Person\nrole Employer specializes Organization\nrelation Organization [1] -- employs -- [0..*] Person\nrelation Employer [1] -- appoints -- [0..*] Executive'],
['RepRel', 'Anti-patterns', 'Relator instances that cannot be told apart.',
 'kind Person\nkind Organization\nrelator Employment {\n@mediation [0..*] -- [1] Person\n@mediation [0..*] -- [1] Organization\n}'],
['powertype-without-base', 'Multi-level', 'A power type is defined by the type it is the power type of (MLT D3).',
 'type PersonType isPowerType'],
['powertype-not-unique', 'Multi-level', 'isPowertypeOf is a bijection between adjacent orders.',
 'type VehicleType isPowerType\nkind Car { @instantiation -- [1..*] VehicleType }\nkind Truck { @instantiation -- [1..*] VehicleType }'],
['powertype-instantiation-multiplicity', 'Multi-level', 'MLT fixes both bounds of a power type instantiation at [1..*].',
 'type CarModel isPowerType\nkind Car {\n@instantiation -- [2..*] CarModel\n}'],
['powertype-as-categorizer', 'Multi-level', 'A power type supplies no classification criterion, so it categorizes nothing.',
 'type PersonType isPowerType\nkind Person { @instantiation -- [1..*] PersonType }\nsubkind Man specializes Person\ngenset personSubtypes {\ngeneral Person\ncategorizer PersonType\nspecifics Man\n}'],
['instantiation-cycle', 'Multi-level', 'Instantiation raises the order by exactly one, so it cannot return.',
 'type TaskKind { @instantiation -- [0..*] TaskCategory }\ntype TaskCategory { @instantiation -- [0..*] TaskKind }'],
['categorizer-not-under-powertype', 'Multi-level', 'Everything a criterion picks out is an instance of the base type\u2019s powertype. A warning, where the rest of the multi-level family errs: the generalization is one the model already implies rather than something it gets wrong, and the repair writes it \u2014 as a \u201csubkind\u201d where the categorizer is a \u201ctype\u201d, since a type does not specialize a type and that is how MLT writes a mirrored hierarchy.',
 'type PersonType isPowerType\ntype PersonGender\nkind Person {\n@instantiation -- [1..*] PersonType\n@instantiation -- [1] PersonGender\n}'],
['powertype-hierarchy-mismatch', 'Multi-level', 'The power type hierarchy mirrors the base hierarchy.',
 'type PersonType isPowerType\ntype EmployeeType isPowerType\nkind Person { @instantiation -- [1..*] PersonType }\nrole Employee specializes Person { @instantiation -- [1..*] EmployeeType }'],
['partition-specializes-partition', 'Multi-level', 'Two partitions of one type cut it along independent criteria.',
 'kind Person\ntype Gender\nsubkind BiologicalSex specializes Gender\n@instantiation relation Person [0..*] -- [1] Gender\n@instantiation relation Person [0..*] -- [1] BiologicalSex'],
['genset-contradicts-instantiation', 'Multi-level', 'A generalization set\u2019s own constraints may not contradict the instantiation multiplicity (Table 3). Two readings, and both are offered: move the bound the set contradicts, or drop the word that contradicts it \u2014 \u201ccomplete\u201d for a lower bound of zero, and the set\u2019s overlapping for an upper bound of one, which \u201cdisjoint\u201d settles. A set that is complete *and* overlapping constrains both ends at once, and only \u201c[1..*]\u201d satisfies both \u2014 said as one complaint with one repair, since neither word could go on its own.',
 'kind Person\ntype Gender\nsubkind Man specializes Person\nsubkind Woman specializes Person\ndisjoint complete genset bySex {\ngeneral Person\ncategorizer Gender\nspecifics Man, Woman\n}\n@instantiation relation Person [0..*] -- [0..*] Gender'],
['whole-with-one-part', 'Relations', 'A whole is more than one of its parts (UFO a51). What counts as a part depends on the whole: a collective is supplemented by its members, so a "@subCollection" \u2014 a portion of the collective rather than one of the things it is made of \u2014 is left out of the count, and a collective whose members are "[2..*]" has answered this before any sub-collection is written.',
 'kind Engine\nkind Car { @componenthood [1] <>-- [1] Engine }'],
['characterization-cycle', 'Relations', 'Inherence is irreflexive and asymmetric (UFO t28, t29).',
 'intrinsicMode Skill { @characterization [1] -- [1] Dedication }\nintrinsicMode Dedication { @characterization [1] -- [1] Skill }'],
['constitution-cycle', 'Relations', 'Constitution is asymmetric (UFO a61).',
 'kind Statue { @constitution [1] -- [1] Clay }\nkind Clay { @constitution [1] -- [1] Statue }'],
['moment-with-two-bearers', 'Relations', 'A moment inheres in exactly one individual (UFO a67, non-migration).',
 'kind Person\nkind Vehicle\nquality Weight {\n@characterization [0..*] -- [1] Person\n@characterization [0..*] -- [1] Vehicle\n}'],
['constitution-within-one-kind', 'Relations', 'Constituent and constituted obey different principles of identity (UFO a57).',
 'kind Material\nsubkind Clay specializes Material\nsubkind Statue specializes Material {\n@constitution [1] -- [1] Clay\n}'],
['instance-not-specializing-base', 'Multi-level', 'An instance of a categorizer specializes what that categorizer categorizes (gufoshapes).',
 'kind Car\ntype CarModel\n@instantiation relation Car [0..*] -- [1] CarModel\nkind Motorcycle (instanceOf CarModel)'],
['instance-is-its-own-base', 'Multi-level', 'A "type" categorizes properly, so its base type is not among its instances.',
 'kind Car (instanceOf CarModel)\ntype CarModel\n@instantiation relation Car [0..*] -- [0..*] CarModel'],
['partition-instances-not-disjoint', 'Multi-level', 'The instances of a partitioning type cannot overlap (gufoshapes).',
 'kind Person\ntype Gender\n@instantiation relation Person [0..*] -- [1] Gender\nsubkind Man (instanceOf Gender) specializes Person\nsubkind Woman (instanceOf Gender) specializes Person'],
['BinOver', 'Anti-patterns', 'A relation between two types that can share instances may need a disjointness constraint.',
 'kind Person\nrole Employee specializes Person\nrelation Employee [0..*] -- reportsTo -- [0..*] Employee'],
['AssocCyc', 'Anti-patterns', 'A cycle of associations whose multiplicities force an infinite population.',
 'kind Person\nkind Department\nkind Project\nrelation Person [1] -- worksIn -- [1] Department\nrelation Department [1] -- responsibleFor -- [1] Project\nrelation Project [1] -- ledBy -- [1] Person'],
['RelOver', 'Anti-patterns', 'A relator mediating two types that can share instances.',
 'kind Person\nrole Employee specializes Person\nrole Manager specializes Person\nrelator Assignment {\n@mediation [1] -- [2] Employee\n@mediation [1] -- [1] Manager\n}'],
['duplicate-use', 'Ontologies and packages', 'The same package used twice. The second says nothing the first did not, and an alias on one of them is the only reason to write both \u2014 which is what the fix leaves alone.',
 { docs: ['ontology model bundles\n    parties from <parties.tonto>\n    billing from <billing.tonto>', 'package parties in model\nkind Person', 'use parties\nuse parties\npackage billing in model\nrole Customer specializes parties.Person'], paths: ['model.tonto', 'parties.tonto', 'billing.tonto'], focus: 2 }],
['unnecessary-use', 'Ontologies and packages', 'A "use" that nothing here refers through.',
 { docs: ['ontology model bundles\n    money from <money.tonto>\n    billing from <billing.tonto>', 'package money in model\nkind Currency', 'use money\npackage billing in model\nkind Invoice'], paths: ['model.tonto', 'money.tonto', 'billing.tonto'], focus: 2 }],
['duplicate-alias', 'Ontologies and packages', 'Two "use" or "import" declarations under one alias make "alias.X" name two things.',
 { docs: ['ontology model\npackage parties\nkind Person\npackage places\nkind Building\npackage leases\nuse parties as P\nuse places as P\nrole Tenant specializes P.Person'], focus: 0 }],
['alias-shadows-package', 'Ontologies and packages', 'An alias spelled like a package already in scope names two things.',
 { docs: ['ontology model\npackage parties\nkind Person\npackage places\nkind Building\npackage leases\nuse parties\nuse places as parties\nrole Tenant specializes parties.Person'], focus: 0 }],
['self-use', 'Ontologies and packages', 'A package does not use itself.',
 { docs: ['ontology shop\npackage billing\nuse billing\nkind Invoice'], focus: 0 }],
['duplicate-package-across-files', 'Ontologies and packages', 'Two files declaring one package name in one ontology would silently merge.',
 { docs: ['ontology shop bundles\n    billing from <receipts.tonto>\n\npackage billing\nkind Invoice', 'package billing in shop\nkind Receipt'], paths: ['shop.tonto', 'receipts.tonto'], focus: 1 }],
['duplicate-package-in-file', 'Ontologies and packages', 'One file cannot declare a package twice.',
 { docs: ['ontology shop\npackage billing\nkind Invoice\npackage billing\nkind Receipt'], focus: 0 }],
['package-without-name', 'Ontologies and packages', 'A package is a namespace, and a namespace needs a name. The grammar takes one without, so that a file being typed still parses and every other rule still has something to say about it \u2014 with the name mandatory, the moment between "package" and what it is called discarded the whole file and answered with a list of the twenty-six tokens it might have been.',
 { docs: ['ontology shop\npackage billing\nkind Invoice\npackage\nkind Receipt'], focus: 0 }],
['duplicate-declaration', 'Hygiene', 'Two declarations of one package cannot share a name.',
 'kind Person\nkind Person'],
['enum-without-literals', 'Hygiene', 'An enumeration with no literals has no possible values.',
 'enum Status { }'],
['datatype-attribute-cycle', 'Hygiene', 'A datatype cannot contain itself. Only through attributes that must be there: "next: Node [0..1]" is a linked list and "children: Node [0..*]" is a tree, both finite, since the recursion stops wherever the optional part is left out. A derived attribute is computed rather than held, and nests nothing either.',
 'datatype Address {\ncity: const City\n}\ndatatype City {\npostalAddress: const Address\n}'],
['inverse-signature-mismatch', 'Relations', 'An inverse must run between the same two types, the other way round.',
 'kind Person\nkind Company\nrelation Person [0..*] -- worksAt -- [1] Company\nrelation Person [0..*] -- alsoAt -- [1] Company inverseOf worksAt'],
['relation-specialization-not-narrower', 'Relations', 'A specializing relation must connect the same or more specific types.',
 'kind Person\nkind Company\nrole Employee specializes Person\nrelation Employee [1] -- worksAt -- [1] Company\nrelation Person [1] -- visits -- [1] Company specializes worksAt'],
['short-reference-ambiguous', 'Relations', 'What a class inherits it may name plainly \u2014 "subsets parts" rather than "subsets ComplexPhysicalObject.parts" \u2014 since the specialization has already said where to look, and the nearest declaration of the name is the one meant. Two declarations of one name under classes that say nothing about each other are two properties, and which was meant would depend on the order the supertypes happen to be written in. A redefinition chain is not this: a "parts" closer to the class refines the "parts" above it.',
 'kind Person\nmixin A {\n-- [0..*] (parts) Person\n}\nmixin B {\n-- [0..*] (parts) Person\n}\nkind X specializes A, B {\n-- [0..1] (mine subsets parts) Person\n}'],
['override-type-not-narrower', 'Relations', 'A subsetting end may only narrow the type it subsets. Two readings, and the taxonomy is usually the one that has not caught up: the repair adds the generalization the end was assuming, or drops the clause that assumes it.',
 'kind Person\nrole Employee specializes Person\nkind Team {\n-- [0..*] (staff) Employee\n-- [0..*] (subsets Team.staff) Person\n}'],
['override-owner-not-subtype', 'Relations', 'Subsetting is only meaningful between ends of related classifiers. Repaired the same way as the type rule: say what the end was assuming, or stop assuming it.',
 'kind Person\nkind Team {\n-- [0..*] (staff) Person\n}\nkind Club {\n-- [0..*] (subsets Team.staff) Person\n}'],
['duplicate-end-name', 'Relations', 'Two ends of one relation must be distinguishable.',
 'kind Person\nrelation Person (peer) [1] -- knows -- [1] (peer) Person'],
['DepPhase', 'Anti-patterns', 'A phase and a role are both anti-rigid, and what separates them is why they stop holding: a phase by a change in the individual itself, a role by a relationship it stands in. A phase that a relator mediates is classifying by a relationship while saying it classifies by a condition.',
 'kind Person\nphase Employed specializes Person\nphase Unemployed specializes Person\ndisjoint complete genset stages where Employed, Unemployed specializes Person\nkind Organization\nrelator Employment {\n@mediation [1..*] -- [1] (const) Employed\n@mediation [0..*] -- [1] (const) Organization\n}'],
['MixIden', 'Anti-patterns', 'A non-sortal exists to say something across kinds. One whose sortals all draw identity from the same ultimate sortal is saying it across nothing, and a "subkind", "role" or "phase" of that kind says it while supplying the identity a non-sortal cannot.',
 'kind Person\ncategory Human of functional-complexes\nsubkind Man specializes Person, Human\nsubkind Woman specializes Person, Human'],
['HetColl', 'Anti-patterns', 'A collective is unified by one relation holding among its members. Members typed by a non-sortal may draw identity from different kinds, and whatever unifies them is not one relation among comparable things.',
 'kind Person\nkind Organization\ncategory Party of functional-complexes\nsubkind Client specializes Person, Party\nsubkind Firm specializes Organization, Party\ncollective Crowd {\n@membership [0..*] <>-- [2..*] (members) Party\n}'],
['ImpAbs', 'Anti-patterns', 'A relation stated against a type with many subtypes may be imprecise.',
 'category Party of functional-complexes\nkind Person specializes Party\nkind Organization specializes Party\nkind Account\nrelation Party [0..*] -- holds -- [0..*] Account'],
];

export const RULES: readonly RuleCase[] = CASES.map(([code, group, rationale, model]) =>
    ({ code, group, rationale, model }));

const SEVERITY = ['', 'error', 'warning', 'information', 'hint'];

/** Every rule, with the diagnostic and repairs its example actually produces. */
export async function catalog(): Promise<Rule[]> {
    const services = createTontoServices(EmptyFileSystem);
    // The reference documents the anti-patterns even though they are off.
    services.shared.workspace.ConfigurationProvider.updateConfiguration(
        { settings: { tonto: { antiPatterns: true } } });
    const documents = services.shared.workspace.LangiumDocuments;
    const rules: Rule[] = [];
    let n = 0;

    for (const { code, group, rationale, model } of RULES) {
        n++;
        const texts = model === null ? ['ontology legalregistry\nkind Statute']
            : typeof model === 'string' ? [`ontology demo${n}\n${model}`]
            : model.docs;
        const focus = typeof model === 'object' && model !== null && 'focus' in model ? model.focus : 0;
        publicationWorkspace(services.shared).configure([], typeof model === 'object' && model !== null
            ? { publication: model.publication, locations: model.locations } : { publication: false });
        const built = texts.map((text, index) => {
            const document = services.shared.workspace.LangiumDocumentFactory
                .fromString(text, URI.parse(typeof model === 'object' && model !== null && model.paths
                    ? `file:///rules/${n}/${model.paths[index]}` : `file:///rule${n}_${index}.tonto`));
            documents.addDocument(document);
            return document;
        });
        await services.shared.workspace.DocumentBuilder.build(built, { validation: true });
        const document = built[focus];
        const reported = document.diagnostics ?? [];
        const hit = reported.find(diagnostic => diagnostic.code === code)
            ?? reported.find(diagnostic => String(diagnostic.message).includes(code));
        const actions = hit
            ? await services.Tonto.lsp.CodeActionProvider?.getCodeActions(document, {
                textDocument: { uri: document.textDocument.uri },
                range: hit.range,
                context: { diagnostics: [hit], only: [CodeActionKind.QuickFix] }
            })
            : undefined;
        rules.push({
            code, group, rationale,
            // A written package line is shown; only the generated preamble is not.
            example: texts.length > 1
                ? texts.map((text, index) => `// ${index === focus ? 'this file' : 'another file'}\n${text}`).join('\n\n')
                : typeof model === 'object' && model !== null ? texts[0]
                    : texts[0].split('\n').slice(1).join('\n'),
            reported: hit?.code === undefined ? undefined : String(hit.code),
            severity: hit ? SEVERITY[hit.severity ?? 1] : undefined,
            message: hit ? String(hit.message) : undefined,
            fixes: (actions ?? []).map(action => 'title' in action ? action.title : ''),
            batchSafe: (actions ?? []).some(action =>
                'data' in action && (action.data as { batchSafe?: boolean } | undefined)?.batchSafe === true)
        });
        await services.shared.workspace.DocumentBuilder.update([], built.map(document => document.uri));
    }
    return rules;
}
