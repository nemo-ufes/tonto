import { AstUtils } from 'langium';
import type { AstNode } from 'langium';
import type {
    Attribute, Cardinality, ClassDeclaration, Classifier, Datatype, Enumeration,
    GeneralizationSet, Model, Package, Relation, RelationEndMetaAttributes, RelationEndTarget
} from './generated/ast.js';
import {
    isClassDeclaration, isDatatype, isEnumeration, isExternalRelation,
    isGeneralizationSet, isOntologyBody, isPackage, isRelation
} from './generated/ast.js';
import type { Documentation } from './documentation/doc-comment.js';
import { BUILTIN_DATATYPE_NAMES, BUILTIN_DATATYPES_URI } from './workspace/builtin-datatypes.js';
import { getBounds } from './validation/cardinality-checks.js';
import { possibleNaturesOf, classifiesOnly } from './utils/nature-reasoning.js';
import { collectAncestors, getDirectGeneralizations, isSameOrSpecializes } from './utils/generalizations.js';
import { cannotShareInstances } from './utils/disjointness.js';
import { namespaceProblem } from './utils/namespaces.js';
import type { ExportedFile } from './exports.js';
import { derivationsOf, foundedAbove, foundingOf, foundingRelations } from './utils/founding.js';
import {
    getEndOwner, getEndSide, getEndType, getRelationSource, isParthood, wholeEndOf
} from './utils/relations.js';
import { IMMUTABLE_NATURES } from './validation/natures.js';
import { ownsOnlyImmutableAttributes } from './validation/attribute-checks.js';
import { ownerOf } from './publication/workspace.js';
import { packageLabel } from './validation/package-checks.js';
import type { OntologyUnit } from './publication/workspace.js';
import { isRigid, isUltimateSortal } from './validation/stereotype-model.js';
import {
    hasImmutableInstances, holdsAccumulatingHistory, isSituationParthood
} from './validation/relation-nature-checks.js';

const GUFO = 'http://purl.org/nemo/gufo#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const OWL = 'http://www.w3.org/2002/07/owl#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const DCTERMS = 'http://purl.org/dc/terms/';
const SH = 'http://www.w3.org/ns/shacl#';
const VANN = 'http://purl.org/vocab/vann/';

export type GufoSeverity = 'error' | 'warning' | 'information' | 'hint';

export interface GufoDiagnostic {
    file: string;
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
    severity: GufoSeverity;
    code: string;
    message: string;
    fixes: [];
}

export interface GufoOptions {
    /** Internal selection: dependencies retain identities but are not republished. */
    selectedOntologies?: ReadonlySet<OntologyUnit>;
    ownedPackages?: ReadonlySet<Package>;
    /** Exact namespace for one selected unannotated ontology. */
    namespaceIri?: string;
    documentation?: (node: AstNode) => Documentation | undefined;
    /**
     * Also write the direct `rdfs:subClassOf` triples that gufoshapes reads
     * without inference, though OWL already entails them: a base sortal to its
     * nearest gUFO-sortal ancestors, and an instance of a categorizer to the
     * type it categorizes. Off by default (docs/gufo-mapping.md, section 17).
     */
    directSpecializations?: boolean;
    /**
     * Also write the snapshot layer: beside each ontology, a module that
     * imports it and adds what holds of the world at any one instant but not
     * over a whole history -- the upper bounds and the disjointness the
     * reading of section 3 withholds (section 18).
     */
    snapshot?: boolean;
}

/**
 * One ontology of a gUFO export, and the Turtle document that is it: an
 * exported file, as every format writes, and which layer it belongs to.
 */
export interface GufoFile extends ExportedFile {
    /** The ontology's IRI: its namespace without the closing `#` or `/`. */
    ontology: string;
    /** Whether this belongs to the snapshot layer (section 18) rather than being an ontology of the model's own. */
    snapshot: boolean;
    /** Whether this is the layer's SHACL shapes graph, which is not an OWL ontology to reason with. */
    shapes: boolean;
}

export interface GufoResult {
    publicationVerified?: boolean;
    /** The Turtle when the export is one ontology; empty when it is several. */
    turtle: string;
    /** Every ontology of the export, one per ontology of the model (section 4). */
    files: GufoFile[];
    diagnostics: GufoDiagnostic[];
}

/** The packages published together into one namespace, and the ontology they make. */
interface OntologyGroup {
    namespace: string;
    ontology: string;
    packages: Package[];
    unit?: OntologyUnit;
    graph: Graph;
    /** The snapshot layer's axioms for this ontology, written only when asked for (section 18). */
    snapshot: Graph;
    /** The snapshot layer's SHACL shapes for this ontology's packages (section 18). */
    shapes: Graph;
}

interface PropertyPlan {
    iri: string;
    relation: Relation;
    source: RelationEndTarget;
    target: RelationEndTarget;
    object: boolean;
    writable: boolean;
}

interface DatatypePlan {
    reified: ReadonlySet<Datatype | Enumeration>;
}

interface Alignment {
    property?: string;
    direct: boolean;
    stem: string;
    expectedSource?: ReadonlySet<string>;
    expectedTarget?: ReadonlySet<string>;
}

const BUILTIN_RANGES: Readonly<Record<string, string>> = {
    string: 'xsd:string', number: 'xsd:decimal', boolean: 'xsd:boolean',
    date: 'xsd:date', time: 'xsd:time', datetime: 'xsd:dateTime'
};

const NATURE_CLASS: Readonly<Record<string, string>> = {
    'functional-complexes': 'gufo:FunctionalComplex',
    collectives: 'gufo:Collection',
    quantities: 'gufo:Quantity',
    relators: 'gufo:Relator',
    'intrinsic-modes': 'gufo:IntrinsicMode',
    'extrinsic-modes': 'gufo:ExtrinsicMode',
    qualities: 'gufo:Quality',
    events: 'gufo:Event',
    processes: 'gufo:Event',
    situations: 'gufo:Situation',
    'abstract-individuals': 'gufo:AbstractIndividual',
    types: 'gufo:Type'
};

const ENDURANT_NATURES = new Set([
    'functional-complexes', 'collectives', 'quantities', 'relators',
    'intrinsic-modes', 'extrinsic-modes', 'qualities'
]);
const EVENT_NATURES = new Set(['events', 'processes']);
const CONCRETE_NATURES = new Set([...ENDURANT_NATURES, ...EVENT_NATURES, 'situations']);
const SUBSTANTIAL_NATURES = new Set(['functional-complexes', 'collectives', 'quantities']);
const ASPECT_NATURES = new Set(['relators', 'intrinsic-modes', 'extrinsic-modes', 'qualities']);

const ENDURANT_TYPE: Readonly<Record<string, string>> = {
    kind: 'gufo:Kind', collective: 'gufo:Kind', quantity: 'gufo:Kind',
    relator: 'gufo:Kind', quality: 'gufo:Kind', intrinsicMode: 'gufo:Kind',
    extrinsicMode: 'gufo:Kind', mode: 'gufo:Kind', subkind: 'gufo:SubKind',
    role: 'gufo:Role', historicalRole: 'gufo:Role', phase: 'gufo:Phase',
    category: 'gufo:Category', mixin: 'gufo:Mixin', roleMixin: 'gufo:RoleMixin',
    historicalRoleMixin: 'gufo:RoleMixin', phaseMixin: 'gufo:PhaseMixin',
    class: 'gufo:EndurantType'
};

const INVERSE_STEM: Readonly<Record<string, string>> = {
    inheresIn: 'bears', mediates: 'isMediatedBy', externallyDependsOn: 'hasModeDependee',
    isComponentOf: 'hasComponent', isCollectionMemberOf: 'hasCollectionMember',
    isSubCollectionOf: 'hasSubCollection', isSubQuantityOf: 'hasSubQuantity',
    isObjectProperPartOf: 'hasObjectProperPart', isAspectProperPartOf: 'hasAspectProperPart',
    isEventProperPartOf: 'hasEventProperPart', isSituationProperPartOf: 'hasSituationProperPart',
    isProperPartOf: 'hasProperPart', constitutes: 'isConstitutedBy',
    historicallyDependsOn: 'hasHistoricalDependee', participatedIn: 'hadParticipant',
    wasCreatedIn: 'created', wasTerminatedIn: 'terminated', manifestedIn: 'manifested',
    contributedToTrigger: 'wasTriggeredBy', broughtAbout: 'wasBroughtAboutBy'
};

const GRANDFATHERED_LANGUAGE_TAGS = new Set([
    'art-lojban', 'cel-gaulish', 'en-gb-oed', 'i-ami', 'i-bnn', 'i-default',
    'i-enochian', 'i-hak', 'i-klingon', 'i-lux', 'i-mingo', 'i-navajo', 'i-pwn',
    'i-tao', 'i-tay', 'i-tsu', 'no-bok', 'no-nyn', 'sgn-be-fr', 'sgn-be-nl',
    'sgn-ch-de', 'zh-guoyu', 'zh-hakka', 'zh-min', 'zh-min-nan', 'zh-xiang'
]);
const LANGUAGE_TAG = /^(?:(?:[A-Za-z]{2,3}(?:-[A-Za-z]{3}){0,3}|[A-Za-z]{4}|[A-Za-z]{5,8})(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|[0-9]{3}))?(?:-(?:[A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3}))*(?:-[0-9A-WY-Za-wy-z](?:-[A-Za-z0-9]{2,8})+)*(?:-x(?:-[A-Za-z0-9]{1,8})+)?|x(?:-[A-Za-z0-9]{1,8})+)$/;

/** A node written in place, `[ p o ; … ]`: a restriction, a class expression, an inverse. */
class Blank {
    constructor(readonly pairs: ReadonlyArray<readonly [string, Term]>) {}
}

/** An RDF collection, `( … )`. */
class Collection {
    constructor(readonly items: readonly Term[]) {}
}

/** A named resource or literal, already in Turtle, or a node written in place. */
type Term = string | Blank | Collection;

function blank(...pairs: Array<readonly [string, Term]>): Blank {
    return new Blank(pairs);
}

function collection(items: readonly Term[]): Collection {
    return new Collection(items);
}

/** A term on one line: its identity in a graph, and its layout when it fits. */
function inline(term: Term): string {
    if (typeof term === 'string') return term;
    if (term instanceof Collection) return `( ${term.items.map(inline).join(' ')} )`;
    return `[ ${term.pairs.map(([predicate, object]) => `${verb(predicate)} ${inline(object)}`).join(' ; ')} ]`;
}

function verb(predicate: string): string {
    return predicate === 'rdf:type' ? 'a' : predicate;
}

/** Past this column a collection, or a list of objects, takes a line per item. */
const WIDTH = 100;

/**
 * The order of a subject's predicates: its types, then what describes it to a
 * reader, then the axioms, in the order the mapping states them.
 */
const PREDICATE_RANK: Readonly<Record<string, number>> = {
    'rdf:type': 0, 'rdfs:label': 1, 'rdfs:comment': 2, 'rdfs:isDefinedBy': 3
};

/** A tiny deterministic RDF graph whose output is valid Turtle, not string templates scattered through the mapping. */
class Graph {
    private readonly triples = new Map<string, { subject: Term | undefined; predicates: Map<string, Map<string, Term>> }>();
    private anonymousCount = 0;

    add(subject: Term, predicate: string, object: Term): void {
        const key = inline(subject);
        const entry = this.triples.get(key) ?? { subject, predicates: new Map<string, Map<string, Term>>() };
        this.triples.set(key, entry);
        const objects = entry.predicates.get(predicate) ?? new Map<string, Term>();
        entry.predicates.set(predicate, objects);
        objects.set(inline(object), object);
    }

    /** A statement about a node nothing else refers to, written `[] p o ; … .` */
    addAnonymous(...pairs: Array<readonly [string, Term]>): void {
        const key = `\u0000${this.anonymousCount++}`;
        this.triples.set(key, { subject: undefined, predicates: new Map() });
        for (const [predicate, object] of pairs) this.add(key, predicate, object);
    }

    /** Every statement, a subject written `[]` standing for itself. */
    *statements(): Iterable<readonly [Term, string, Term]> {
        for (const [key, { subject, predicates }] of this.triples) {
            for (const [predicate, objects] of predicates) {
                for (const object of objects.values()) yield [subject ?? key, predicate, object];
            }
        }
    }

    /** Every subject, predicate and object written, each on one line, for reading what the graph refers to. */
    *terms(): Iterable<string> {
        for (const [key, { subject, predicates }] of this.triples) {
            yield subject === undefined ? '[]' : key;
            for (const [predicate, objects] of predicates) {
                yield verb(predicate);
                yield* objects.keys();
            }
        }
    }

    /**
     * The graph as Turtle: a block per subject, `a` and the annotations first,
     * a restriction's parts a line each, and a list that would run past
     * `WIDTH` an item a line, so that a change to a model is a change to the
     * lines about it.
     */
    render(): string {
        const blocks: string[] = [];
        for (const { subject, predicates } of this.triples.values()) {
            const head = subject === undefined ? '[]' : renderTerm(subject, 0, 0);
            const ordered = [...predicates].sort(([one], [two]) => (PREDICATE_RANK[one] ?? 9) - (PREDICATE_RANK[two] ?? 9));
            const lines = ordered.map(([predicate, objects], index) =>
                renderPredicate(predicate, [...objects.values()], index === 0 ? head.length + 1 : 4, 4));
            blocks.push(`${head} ${lines.join(' ;\n    ')} .`);
        }
        return blocks.join('\n\n');
    }
}

/** `predicate o1, o2` at `column`, its continuation lines indented past `indent`. */
function renderPredicate(predicate: string, objects: readonly Term[], column: number, indent: number): string {
    const name = verb(predicate);
    const flat = `${name} ${objects.map(inline).join(', ')}`;
    const spread = objects.some(object => object instanceof Blank && spreads(object));
    if (!spread && column + flat.length + 2 <= WIDTH) return flat;
    if (objects.length === 1) return `${name} ${renderTerm(objects[0]!, column + name.length + 1, indent)}`;
    const inner = indent + 4;
    return `${name}\n${objects.map(object => ' '.repeat(inner) + renderTerm(object, inner, inner)).join(',\n')}`;
}

/** A restriction is spread over lines; a short expression -- an inverse, a union -- is not. */
function spreads(node: Blank): boolean {
    return node.pairs.length > 2;
}

function renderTerm(term: Term, column: number, indent: number): string {
    if (typeof term === 'string') return term;
    if (term instanceof Collection) {
        const flat = inline(term);
        if (column + flat.length + 2 <= WIDTH) return flat;
        const inner = ' '.repeat(indent + 4);
        return `(\n${term.items.map(item => inner + renderTerm(item, indent + 4, indent + 4)).join('\n')}\n${' '.repeat(indent)})`;
    }
    if (!spreads(term) && column + inline(term).length + 2 <= WIDTH) return inline(term);
    const hang = column + 2;
    return `[ ${term.pairs.map(([predicate, object]) => renderPredicate(predicate, [object], hang, hang))
        .join(` ;\n${' '.repeat(hang)}`)} ]`;
}

export function generateGufo(models: readonly Model[], options: GufoOptions = {}): GufoResult {
    const diagnostics: GufoDiagnostic[] = [];
    const anchor = models[0];
    // A one-file ontology's declarations are a package without a name.
    const packages = models.flatMap(model => model.packages)
        .filter(pkg => (!!pkg.name || isOntologyBody(pkg)) && (!options.ownedPackages || options.ownedPackages.has(pkg)))
        .sort((one, two) => lexicalCompare(one.name ?? '', two.name ?? ''));
    const emptyUnits = [...options.selectedOntologies ?? []].filter(unit => unit.declaration && unit.packages.length === 0);

    // Ownership is fixed by the loader, and only an ontology's header gives
    // it a namespace: every package is published in its ontology's.
    const tagged = new Map<Package, string>();
    for (const pkg of packages) {
        const namespace = ownerOf(pkg)?.namespace;
        if (namespace) tagged.set(pkg, namespace);
    }
    const untagged = packages.filter(pkg => !tagged.has(pkg));
    const supplied = new Map<Package, string>();
    if (options.namespaceIri !== undefined) {
        const problem = namespaceProblem(options.namespaceIri);
        if (problem) {
            diagnostics.push(diagnostic(untagged[0] ?? anchor, 'error', 'gufo-invalid-namespace-iri',
                `The ontology namespace <${options.namespaceIri}> ${problem}.`));
            return { turtle: '', files: [], diagnostics };
        }
        const names = new Set(untagged.map(pkg => ownerOf(pkg)?.id ?? 'implicit'));
        const inheritedOverride = [...packages.map(pkg => ownerOf(pkg)), ...emptyUnits]
            .some(unit => unit?.namespaceSupplied === true && unit.namespace === options.namespaceIri);
        if (names.size !== 1 && !inheritedOverride) {
            const detail = names.size === 0
                ? 'the selected ontologies already have a namespace'
                : `the unannotated ontology roots are ${[...names].map(name => `"${name}"`).join(', ')}`;
            diagnostics.push(diagnostic(untagged[0] ?? anchor, 'error', 'gufo-namespace-iri-ambiguous',
                `An exact namespace can be supplied only for one selected unannotated ontology; ${detail}. Write each ontology\'s "/// @namespace" above its header.`));
            return { turtle: '', files: [], diagnostics };
        }
        if (!inheritedOverride) for (const pkg of untagged) supplied.set(pkg, options.namespaceIri);
    }
    // An ontology whose header gives no namespace is previewed under a
    // placeholder named after it, said so once at its header.
    const placeholders = new Map<string, string>();
    const placeholder = (unit: OntologyUnit | undefined, at: AstNode | undefined): string => {
        const name = unit?.name ?? 'model';
        let namespace = placeholders.get(name);
        if (namespace === undefined) {
            namespace = `https://example.org/${encodeURIComponent(name)}#`;
            placeholders.set(name, namespace);
            diagnostics.push(diagnostic(unit?.declaration ?? at ?? anchor, 'warning', 'gufo-placeholder-namespace',
                `Ontology "${name}" declares no namespace, so this export uses <${namespace}>. Write "/// @namespace" above its header.`));
        }
        return namespace;
    };
    const packageNamespaces = new Map<Package, string>();
    for (const pkg of packages) {
        packageNamespaces.set(pkg, tagged.get(pkg) ?? supplied.get(pkg) ?? placeholder(ownerOf(pkg), pkg));
    }
    for (const unit of emptyUnits) if (!unit.namespace) unit.namespace = placeholder(unit, unit.declaration);
    const groups = groupByNamespace(packages, packageNamespaces, diagnostics, emptyUnits);
    const groupOf = (pkg: Package): OntologyGroup =>
        groups.find(group => group.packages.includes(pkg))!;
    const prefixes = packagePrefixes(packages, packageNamespaces);
    const termForIri = (iri: string): string => compactIri(iri, prefixes);
    const iriOfClassifier = (classifier: Classifier): string =>
        `${packageNamespaces.get(classifier.$container)!}${encodeIriSegment(classifier.name)}`;
    const termOfClassifier = (classifier: Classifier): string => termForIri(iriOfClassifier(classifier));

    const classifiers = packages.flatMap(pkg => pkg.declarations)
        .filter((node): node is ClassDeclaration | Datatype | Enumeration =>
            isClassDeclaration(node) || isDatatype(node) || isEnumeration(node));
    const classes = classifiers.filter(isClassDeclaration);
    const datatypes = classifiers.filter((node): node is Datatype | Enumeration => isDatatype(node) || isEnumeration(node));
    const relations: Relation[] = [];
    for (const pkg of packages) {
        for (const declaration of pkg.declarations) {
            if (isClassDeclaration(declaration)) relations.push(...declaration.relations);
            else if (isRelation(declaration)) relations.push(declaration);
        }
    }
    const gensets = packages.flatMap(pkg => pkg.declarations.filter(isGeneralizationSet));
    const datatypePlan = planDatatypes(datatypes);

    const relationPlans = new Map<Relation, PropertyPlan>();
    for (const relation of relations) {
        const source = getRelationSource(relation);
        const target = relation.target?.ref;
        if (!source || !target || relation.stereotype === 'instantiation') {
            continue;
        }
        const object = !isPrimitiveDatatype(target, datatypePlan);
        relationPlans.set(relation, {
            iri: '', relation, source, target, object,
            writable: !isPrimitiveDatatype(source, datatypePlan)
        });
    }

    // Properties and literals are always named through their semantic owner --
    // `Person.name`, `Customer.buys`, `Car.hasComponentEngine`, `Color.red`.
    // The structural separator makes the name independent of every other
    // declaration in the ontology, and package moves cannot change it.
    const members: NamedMember[] = [];
    for (const classifier of classifiers) {
        for (const attribute of classifier.attributes) {
            members.push({ node: attribute, pkg: classifier.$container, owner: classifier, plain: attribute.name });
        }
        if (isEnumeration(classifier)) {
            for (const literal of classifier.literals) {
                members.push({ node: literal, pkg: classifier.$container, owner: classifier, plain: literal.name });
            }
        }
    }
    relationPlans.forEach(plan => {
        if (plan.writable) {
            members.push({
                node: plan.relation, pkg: packageOfRelation(plan.relation), owner: plan.source,
                plain: relationPlainName(plan.relation, plan.source, plan.target)
            });
        }
    });
    const memberIris = nameMembers(members, packageNamespaces);
    relationPlans.forEach(plan => {
        plan.iri = memberIris.get(plan.relation) ?? '';
    });

    const iriOwners = new Map<string, AstNode>();
    const claim = (iri: string, node: AstNode): void => {
        const earlier = iriOwners.get(iri);
        if (earlier && earlier !== node) {
            diagnostics.push(diagnostic(node, 'error', 'gufo-iri-collision', collisionMessage(iri, earlier, node)));
        } else {
            iriOwners.set(iri, node);
        }
    };
    classifiers.forEach(classifier => claim(iriOfClassifier(classifier), classifier));
    memberIris.forEach((iri, node) => claim(iri, node));
    // A term may not be an ontology: in a slash namespace a class is named by
    // appending to it, and `<…/shop/>` with a class `sales` is `<…/shop/sales>`,
    // the ontology of an unannotated package `sales` beneath the same base.
    for (const group of groups) {
        const term = iriOwners.get(group.ontology);
        if (term) {
            diagnostics.push(diagnostic(term, 'error', 'gufo-ontology-collision',
                `<${group.ontology}> would be both "${(term as { name?: string }).name ?? 'this element'}" and an ontology. Rename it, or change a namespace.`));
        }
    }

    validateDocumentation([
        ...packages, ...classifiers, ...classifiers.flatMap(c => c.attributes),
        ...datatypes.filter(isEnumeration).flatMap(enumeration => enumeration.literals),
        ...relations, ...gensets
    ], options, diagnostics);
    const headers = groups.map(group => ontologyHeader(group, prefixes, options));
    if (diagnostics.some(entry => entry.severity === 'error')) {
        return { turtle: '', files: [], diagnostics };
    }

    const context: EmitContext = {
        graph: groups[0]!.graph, snapshot: groups[0]!.snapshot, snapshotBounds: [],
        shapes: groups[0]!.shapes, shapeRecords: [],
        diagnostics, options, datatypePlan, classes, relations, gensets,
        relationPlans, iriOfClassifier, memberIris, termOfClassifier, termForIri,
        disjointPairs: new Map(),
        ultimateSortals: new Set(classes.filter(classifier => isUltimateSortal(classifier.stereotype))),
        categorizerInstances: new Map(),
        categorizations: [],
        ontology: `<${groups[0]!.ontology}>`,
        groups,
        enter: pkg => {
            const group = groupOf(pkg);
            context.graph = group.graph;
            context.snapshot = group.snapshot;
            context.shapes = group.shapes;
            context.ontology = `<${group.ontology}>`;
        }
    };
    groups.forEach((group, index) => {
        group.graph.add(`<${group.ontology}>`, 'rdf:type', 'owl:Ontology');
        group.graph.add(`<${group.ontology}>`, 'owl:imports', `<${GUFO}>`);
        for (const [predicate, object] of headers[index]!) {
            group.graph.add(`<${group.ontology}>`, predicate, object);
        }
        if (options.snapshot) {
            const module = `<${snapshotIri(group)}>`;
            group.snapshot.add(module, 'rdf:type', 'owl:Ontology');
            group.snapshot.add(module, 'owl:imports', `<${group.ontology}>`);
            for (const [predicate, object] of layerHeader(group, headers[index]!, options, 'snapshot', SNAPSHOT_COMMENT)) {
                group.snapshot.add(module, predicate, object);
            }
            const shapes = `<${shapesIri(group)}>`;
            group.shapes.add(shapes, 'rdf:type', 'owl:Ontology');
            for (const [predicate, object] of layerHeader(group, headers[index]!, options, 'shapes', SHAPES_COMMENT)) {
                group.shapes.add(shapes, predicate, object);
            }
        }

    });
    for (const classifier of classifiers) {
        if (classifier.legacyText.length > 0) {
            diagnostics.push(diagnostic(classifier.legacyText[0], 'information', 'gufo-legacy-text-ignored',
                `The "label { }" and "description { }" blocks of "${classifier.name}" are not exported; `
                + '"tonto check --fix=legacy-text-block" rewrites them as "///" documentation, which is.'));
        }
    }
    emitClassifiers(context, classifiers);
    emitGeneralizationSets(context);
    emitAttributes(context, classifiers);
    emitRelations(context);
    emitRelationalConditions(context);
    emitHistoricalDerivations(context);
    emitParticipationUpward(context);
    emitInstantiation(context);
    emitUltimateDisjointness(context);
    emitPartitionDisjointness(context);
    if (options.directSpecializations) emitDirectSpecializations(context);
    // Last, since whether a chain may be written depends on every other
    // axiom about the property (section 9.2).
    emitDerivationChains(context);
    if (options.snapshot) {
        emitSnapshotBounds(context);
        emitShapes(context);
    }
    // Declared, since OWL 2 DL has no annotation property it was not told of,
    // and a reader would otherwise have to guess what an IRI-valued
    // `dcterms:license` is. Last, below the terms the reader came for.
    for (const graph of groups.flatMap(group => [group.graph, group.snapshot, group.shapes])) {
        const used = new Set([...graph.statements()].map(([, predicate]) => predicate)
            .filter(predicate => predicate.startsWith('dcterms:') || predicate.startsWith('vann:')));
        for (const predicate of [...used].sort(lexicalCompare)) graph.add(predicate, 'rdf:type', 'owl:AnnotationProperty');
    }

    const written = writeFiles(groups, prefixes, options.snapshot ?? false);
    const selected = new Set(groups.filter(group => !options.selectedOntologies
        || (group.unit && options.selectedOntologies.has(group.unit))
        || group.packages.some(pkg => options.selectedOntologies!.has(ownerOf(pkg)!)))
        .flatMap(group => [group.ontology, snapshotIri(group), shapesIri(group)]));
    const files = written.filter(file => selected.has(file.ontology));
    return { turtle: files.length === 1 ? files[0]!.content : '', files, diagnostics };
}

/**
 * What two elements that would share an IRI have in common, and so what to
 * change: two classifiers are in packages that publish into one namespace; a
 * member name qualified by its owner can still collide for unnamed relations.
 */
function collisionMessage(iri: string, earlier: AstNode, node: AstNode): string {
    const named = (element: AstNode) => (element as { name?: string }).name ?? '';
    const packageOf = (element: AstNode) => {
        const pkg = AstUtils.getContainerOfType(element, isPackage);
        return pkg ? packageLabel(pkg) : 'package ""';
    };
    if (isClassifierNode(earlier) && isClassifierNode(node)) {
        return `"${named(earlier)}" in ${packageOf(earlier)} and "${named(node)}" in ${packageOf(node)} `
            + `would both be <${iri}>, because the packages publish into one namespace. Rename one, or give the packages different namespaces.`;
    }
    if (isRelation(earlier) || isRelation(node)) {
        return `More than one model element maps to <${iri}>, even with its source classifier in the name; name one of the relations explicitly.`;
    }
    return `More than one model element maps to <${iri}>, even with its owner in the name; rename one of them.`;
}

function isClassifierNode(node: AstNode): boolean {
    return isClassDeclaration(node) || isDatatype(node) || isEnumeration(node);
}

/**
 * Ownership has already rejected independent roots sharing a namespace.
 * Grouping here is serialization only; it creates no aggregate ontology.
 */
function groupByNamespace(
    packages: readonly Package[], namespaces: ReadonlyMap<Package, string>,
    diagnostics: GufoDiagnostic[], emptyUnits: readonly OntologyUnit[]
): OntologyGroup[] {
    const groups = new Map<string, OntologyGroup>();
    for (const pkg of packages) {
        const namespace = namespaces.get(pkg)!;
        const group = groups.get(namespace) ?? {
            namespace, ontology: namespace.replace(/[#/]$/, ''), packages: [], unit: ownerOf(pkg),
            graph: new Graph(), snapshot: new Graph(), shapes: new Graph()
        };
        groups.set(namespace, group);
        group.packages.push(pkg);
    }
    for (const unit of emptyUnits) {
        const namespace = unit.namespace!;
        const ontology = namespace.replace(/[#/]$/, '');
        const earlier = groups.get(namespace);
        if (earlier) {
            diagnostics.push(diagnostic(unit.declaration!, 'error', 'gufo-ontology-collision',
                `The empty ontology "${unit.name}" and another ontology both use <${namespace}>.`));
            continue;
        }
        groups.set(namespace, { namespace, ontology, packages: [], unit,
            graph: new Graph(), snapshot: new Graph(), shapes: new Graph() });
    }
    const ordered = [...groups.values()].sort((one, two) => lexicalCompare(one.ontology, two.ontology));
    for (let left = 0; left < ordered.length; left++) {
        for (let right = left + 1; right < ordered.length; right++) {
            if (ordered[left]!.ontology === ordered[right]!.ontology) {
                diagnostics.push(diagnostic(ordered[right]!.packages[0], 'error', 'gufo-ontology-collision',
                    `The namespaces <${ordered[left]!.namespace}> and <${ordered[right]!.namespace}> would both be the ontology <${ordered[left]!.ontology}>.`));
            }
        }
    }
    if (ordered.length === 0) {
        ordered.push({ namespace: '', ontology: 'https://example.org/model', packages: [], graph: new Graph(), snapshot: new Graph(), shapes: new Graph() });
    }
    return ordered;
}

/**
 * What an ontology's header says about it: its prose, its `@label`s, its
 * `@version` and `@license`, and every `@creator` (section 11).
 *
 * Each is also written in the Dublin Core terms that ontology catalogs and
 * quality checks read -- ROBOT's report asks for `dcterms:title`,
 * `dcterms:description` and `dcterms:license` -- and the namespace and prefix
 * the export chose in VANN's, so that whoever loads it writes the same names.
 */
function ontologyHeader(group: OntologyGroup, prefixes: readonly PrefixPlan[], options: GufoOptions): Array<[string, string]> {
    const header: Array<[string, string]> = [];
    const declaration = group.unit?.declaration ?? (group.packages[0] && ownerOf(group.packages[0])?.declaration);
    const documentation = declaration && options.documentation?.(declaration);
    if (documentation) {
        if (documentation.text) {
            header.push(['rdfs:comment', literal(documentation.text)], ['dcterms:description', literal(documentation.text)]);
        }
        for (const [language, text] of Object.entries(documentation.descriptions)) {
            header.push(['rdfs:comment', literal(text, language)], ['dcterms:description', literal(text, language)]);
        }
        for (const [language, text] of Object.entries(documentation.labels)) {
            header.push(['rdfs:label', literal(text, language)], ['dcterms:title', literal(text, language)]);
        }
        if (documentation.version) header.push(['owl:versionInfo', literal(documentation.version)]);
        const license = documentation.license;
        if (license) header.push(['dcterms:license', /^[a-z][a-z0-9+.-]*:[^\s<>"{}|\\^`]+$/i.test(license)
            ? `<${license}>` : literal(license)]);
        for (const creator of [...new Set(documentation.creators)].sort(lexicalCompare)) header.push(['dcterms:creator', literal(creator)]);
    }
    const prefix = group.namespace ? prefixes.find(plan => plan.iri === group.namespace) : undefined;
    if (prefix) {
        header.push(['vann:preferredNamespacePrefix', literal(prefix.prefix)],
            ['vann:preferredNamespaceUri', literal(prefix.iri)]);
    }
    return header;
}

/**
 * The snapshot module's IRI: its ontology's, with `-snapshot` appended. No
 * tonto name has a hyphen, so no term and no package's ontology is called
 * this.
 */
function snapshotIri(group: OntologyGroup): string {
    return `${group.ontology}-snapshot`;
}

/** The shapes graph's IRI, beside its ontology's as the snapshot module's is. */
function shapesIri(group: OntologyGroup): string {
    return `${group.ontology}-shapes`;
}

const SHAPES_COMMENT = 'SHACL shapes for a graph of current state: every multiplicity, the class or datatype at each end, '
    + 'which specifics of a generalization set an instance may be in, and what founds each role -- as they hold at any one '
    + 'instant. Validate a graph together with the ontologies, or with RDFS inference, so that subclasses are seen.';

const SNAPSHOT_COMMENT = 'The snapshot layer: what holds of the world at any one instant, and not over a whole history '
    + '-- the upper bounds and the disjointness the ontology it imports leaves out. For a graph of current state, '
    + 'which retracts what has stopped being true.';

/**
 * What a snapshot module or shapes graph says of itself: its ontology's name
 * with "(snapshot)" or "(shapes)" after it, what it is, and the same version,
 * license and creators -- it is part of the same publication.
 */
function layerHeader(
    group: OntologyGroup, coreHeader: ReadonlyArray<[string, string]>, options: GufoOptions,
    suffix: string, comment: string
): Array<[string, string]> {
    const header: Array<[string, string]> = [];
    const labeled = new Set<string>();
    for (const pkg of group.packages) {
        for (const [language, text] of Object.entries(options.documentation?.(pkg)?.labels ?? {})) {
            if (labeled.has(language)) continue;
            labeled.add(language);
            header.push(['rdfs:label', literal(`${text} (${suffix})`, language)],
                ['dcterms:title', literal(`${text} (${suffix})`, language)]);
        }
    }
    header.push(['rdfs:comment', literal(comment)], ['dcterms:description', literal(comment)]);
    header.push(...coreHeader.filter(([predicate]) =>
        predicate === 'owl:versionInfo' || predicate === 'dcterms:license' || predicate === 'dcterms:creator'));
    return header;
}

/**
 * Each ontology as a Turtle document: `owl:imports` of every other ontology
 * whose terms it uses -- read off what it writes, so neither an `import`
 * nobody used nor a global package nobody imported decides it -- and only the
 * prefixes it needs.
 */
function writeFiles(
    groups: readonly OntologyGroup[], prefixes: readonly PrefixPlan[], snapshot: boolean
): GufoFile[] {
    const ontologies = new Set(groups.flatMap(group => [group.ontology, snapshotIri(group), shapesIri(group)]));
    for (const group of groups) {
        const dependencies = new Set(group.unit?.dependencies ?? group.packages.flatMap(pkg => [...(ownerOf(pkg)?.dependencies ?? [])]));
        const imported = groups.filter(other => other !== group && other.unit && dependencies.has(other.unit));
        for (const other of imported) {
            group.graph.add(`<${group.ontology}>`, 'owl:imports', `<${other.ontology}>`);
        }
    }
    const names = new Set<string>();
    const standard: PrefixPlan[] = [
        { prefix: 'owl', iri: OWL }, { prefix: 'rdf', iri: RDF }, { prefix: 'rdfs', iri: RDFS },
        { prefix: 'xsd', iri: XSD }, { prefix: 'gufo', iri: GUFO },
        { prefix: 'dcterms', iri: DCTERMS }, { prefix: 'vann', iri: VANN }, { prefix: 'sh', iri: SH }
    ];
    const document = (graph: Graph, comments: readonly string[], extra: readonly PrefixPlan[] = []): string => {
        const written = prefixesWritten(graph);
        const declared = [...standard, ...prefixes, ...extra].filter(prefix => written.has(prefix.prefix));
        return [
            ...comments,
            '',
            ...declared.map(prefix => `@prefix ${prefix.prefix}: <${prefix.iri}> .`),
            '',
            graph.render()
        ].join('\n') + '\n';
    };
    const core: GufoFile[] = groups.map(group => ({
        ontology: group.ontology, file: fileNameFor(group, names), source: sourceOf(group),
        content: document(group.graph, provenance(group)), snapshot: false, shapes: false
    }));
    if (!snapshot) return core;
    // Each module imports its own ontology, and the ontologies whose terms it
    // mentions.
    const snapshots: GufoFile[] = groups.map((group, index) => {
        const module = `<${snapshotIri(group)}>`;
        const used = referencedNamespaces(group.snapshot, prefixes, ontologies);
        const imported = groups.filter(other => other !== group && used.has(other.namespace)).map(other => other.ontology);
        for (const iri of imported) group.snapshot.add(module, 'owl:imports', `<${iri}>`);
        const file = beside(core[index]!.file, 'snapshot');
        return {
            ontology: snapshotIri(group), file, source: sourceOf(group), snapshot: true, shapes: false,
            content: document(group.snapshot, [
                `# Written by \`tonto gufo --snapshot\`: the snapshot layer over ${core[index]!.file} (section 18 of the mapping).`,
                '# Change the model and export it again, rather than this file.'
            ])
        };
    });
    // The shapes graphs, one beside each ontology.
    const shapes: GufoFile[] = groups.map((group, index) => {
        const own: PrefixPlan = { prefix: shapesPrefix(group), iri: `${shapesIri(group)}#` };
        return {
            ontology: shapesIri(group), file: beside(core[index]!.file, 'shapes'), source: sourceOf(group),
            snapshot: true, shapes: true,
            content: document(group.shapes, [
                `# Written by \`tonto gufo --snapshot\`: SHACL shapes for a graph of current state described by ${core[index]!.file} (section 18 of the mapping).`,
                '# Change the model and export it again, rather than this file.'
            ], [own])
        };
    });
    return [...core, ...snapshots, ...shapes];

    /** `sales.ttl` to `sales.<layer>.ttl`, kept unique. */
    function beside(coreFile: string, layer: string): string {
        let file = coreFile.replace(/\.ttl$/, `.${layer}.ttl`);
        for (let counter = 2; names.has(file); counter++) {
            file = coreFile.replace(/\.ttl$/, `.${layer}-${counter}.ttl`);
        }
        names.add(file);
        return file;
    }
}

/** The ontology file a group was declared in, when it is a file on disk. */
function sourceOf(group: OntologyGroup): string | undefined {
    const root = group.unit?.root ?? (group.packages[0] && ownerOf(group.packages[0])?.root);
    return root?.uri.scheme === 'file' && group.unit?.declaration ? root.uri.fsPath : undefined;
}

/**
 * Where a document came from, so that nobody edits it by hand and loses the
 * edit at the next export. No date or version: exporting a model twice gives
 * the same bytes.
 */
function provenance(group: OntologyGroup): string[] {
    const names = group.packages.filter(pkg => !isOntologyBody(pkg)).map(pkg => pkg.name ?? '').sort(lexicalCompare);
    const packages = `${names.length === 1 ? 'package' : 'packages'} ${names.join(', ')}`;
    // An ontology file names the ontology; its packages are where it was written.
    // A one-file ontology was written as nothing but itself.
    const declaration = group.unit?.declaration ?? (group.packages[0] && ownerOf(group.packages[0])?.declaration);
    return [
        declaration
            ? `# Written by \`tonto gufo\` from the tonto ontology ${declaration.name}${names.length ? `, ${packages}` : ''}.`
            : `# Written by \`tonto gufo\` from the tonto ${packages}.`,
        '# Change the model and export it again, rather than this file.'
    ];
}

/**
 * The package namespaces a graph's terms are written in, read off its prefixed
 * names and full IRIs. An ontology's IRI is not a term, though it may lie in
 * a slash namespace: `<…/shop/sales>`, the ontology of a package beneath the
 * base, is not a term of a package published at `<…/shop/>`.
 */
function referencedNamespaces(graph: Graph, prefixes: readonly PrefixPlan[], ontologies: ReadonlySet<string>): Set<string> {
    const found = new Set<string>();
    for (const term of graph.terms()) {
        const { iris, names } = referencesIn(term);
        for (const iri of iris) {
            if (ontologies.has(iri)) continue;
            const prefix = namespaceOf(iri, prefixes);
            if (prefix) found.add(prefix.iri);
        }
        for (const name of names) {
            const prefix = prefixes.find(candidate => candidate.prefix === name);
            if (prefix) found.add(prefix.iri);
        }
    }
    return found;
}

/** The prefix names a graph's Turtle uses, so that a document declares those and no others. */
function prefixesWritten(graph: Graph): Set<string> {
    const found = new Set<string>();
    for (const term of graph.terms()) {
        for (const name of referencesIn(term).names) found.add(name);
    }
    return found;
}

/** The full IRIs and the prefixes of the prefixed names in a term written as Turtle. */
function referencesIn(term: string): { iris: string[]; names: string[] } {
    // A literal's text is not a reference, whatever it looks like; its
    // datatype, after "^^", is.
    const text = term
        .replace(/"""(?:[^\\]|\\[\s\S])*?"""/g, ' ')
        .replace(/"(?:[^"\\]|\\.)*"(?:@[\w-]+)?/g, ' ');
    const iris = [...text.matchAll(/<([^>]*)>/g)].map(match => match[1]!);
    const names = [...text.replace(/<[^>]*>/g, ' ').matchAll(/(?:^|[\s(\[,;^])([A-Za-z\p{L}][\w.\p{L}-]*):/gu)]
        .map(match => match[1]!);
    return { iris, names };
}

/**
 * A file name for an ontology, unique within the export.
 *
 * Named after the ontology, `sales.ttl`, whatever its packages and wherever
 * its namespace is; the IRI's final path segment only when there is no name.
 */
function fileNameFor(group: OntologyGroup, taken: Set<string>): string {
    const ontologyName = group.unit?.name ?? (group.packages[0] && ownerOf(group.packages[0])?.name);
    let stem: string;
    if (ontologyName) {
        stem = ontologyName;
    } else {
        const url = new URL(group.ontology);
        stem = url.pathname.split('/').filter(Boolean).pop() ?? url.host;
    }
    stem = decodeURIComponentSafely(stem).replace(/[^\p{L}\p{N}._-]+/gu, '_') || 'ontology';
    let name = `${stem}.ttl`;
    for (let counter = 2; taken.has(name); counter++) {
        name = `${stem}-${counter}.ttl`;
    }
    taken.add(name);
    return name;
}

function decodeURIComponentSafely(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

interface EmitContext {
    graph: Graph;
    /** Where the snapshot layer's axioms for the current package go (section 18). */
    snapshot: Graph;
    /**
     * Upper bounds for the snapshot layer, written only once every chain is
     * known: a bound on a property a chain implies would leave OWL 2 DL.
     */
    snapshotBounds: Array<{ graph: Graph; owner: string; property: Term; restriction: Blank; functional: boolean; anchor: AstNode; upper: number }>;
    /** Where the snapshot layer's shapes for the current package go (section 18). */
    shapes: Graph;
    /** What the shapes check, gathered as the ontology is written and turned into shapes at the end. */
    shapeRecords: ShapeRecord[];
    diagnostics: GufoDiagnostic[];
    options: GufoOptions;
    datatypePlan: DatatypePlan;
    classes: ClassDeclaration[];
    relations: Relation[];
    gensets: GeneralizationSet[];
    relationPlans: Map<Relation, PropertyPlan>;
    iriOfClassifier: (classifier: Classifier) => string;
    /** The IRI of every attribute, enumeration literal and writable relation. */
    memberIris: ReadonlyMap<AstNode, string>;
    /**
     * Class pairs already stated disjoint, keyed by their two terms in order:
     * `list` when both are members of one `owl:AllDisjointClasses`, `pair`
     * when an `owl:disjointWith` states it.
     */
    disjointPairs: Map<string, 'list' | 'pair'>;
    /** Stated pairwise disjoint by one `owl:AllDisjointClasses`. */
    ultimateSortals: ReadonlySet<ClassDeclaration>;
    /** The classes exported as instances of each higher-order type. */
    categorizerInstances: Map<ClassDeclaration, Set<ClassDeclaration>>;
    /** Every `categorizes` or `partitions` written between two classes. */
    categorizations: Array<{ higher: ClassDeclaration; base: ClassDeclaration; partitions: boolean; pkg: Package }>;
    /** The ontology being written, as a Turtle term: what a minted term is defined by. */
    ontology: string;
    groups: readonly OntologyGroup[];
    /**
     * Directs what follows into the ontology of the package a declaration
     * belongs to, which is where its axioms are published (section 4).
     */
    enter: (pkg: Package) => void;
    termOfClassifier: (classifier: Classifier) => string;
    termForIri: (iri: string) => string;
}

interface PrefixPlan { prefix: string; iri: string }

function lexicalCompare(one: string, two: string): number {
    return one < two ? -1 : one > two ? 1 : 0;
}

/** The exact value accepted by `/// @namespace` and `GufoOptions.namespaceIri`. */
export function validGufoNamespaceIri(value: string): boolean {
    return namespaceProblem(value) === undefined;
}

/**
 * One prefix per namespace, named after the first package (by name) that
 * publishes into it: `sales:` for `sales`, `core.animals:` for `core.animals`.
 * A Turtle prefix starts with a letter, so `_internal` becomes `p_internal`.
 */
function packagePrefixes(packages: readonly Package[], namespaces: ReadonlyMap<Package, string>): PrefixPlan[] {
    const used = new Set(['owl', 'rdf', 'rdfs', 'xsd', 'gufo']);
    const result: PrefixPlan[] = [];
    const named = new Set<string>();
    for (const pkg of [...packages].sort((one, two) => lexicalCompare(one.name ?? '', two.name ?? ''))) {
        const iri = namespaces.get(pkg)!;
        if (named.has(iri)) continue;
        named.add(iri);
        let stem = (ownerOf(pkg)?.declaration?.name ?? pkg.name ?? 'package').replace(/[^A-Za-z0-9_.-]/g, '_').replace(/\.+$/, '') || 'package';
        if (!/^[A-Za-z]/.test(stem)) stem = `p${stem}`;
        stem = stem[0]!.toLowerCase() + stem.slice(1);
        let prefix = stem;
        let suffix = 2;
        while (used.has(prefix)) {
            prefix = `${stem}_${suffix++}`;
        }
        used.add(prefix);
        result.push({ prefix, iri });
    }
    return result.sort((a, b) => lexicalCompare(a.prefix, b.prefix));
}

/**
 * The namespace an IRI is in: the longest that begins it. A slash namespace
 * can hold another -- `<…/shop/>` holds the `<…/shop/sales#>` of a package
 * beneath the same base -- and the first to match could be the outer one.
 */
function namespaceOf<T extends { iri: string }>(iri: string, prefixes: readonly T[]): T | undefined {
    let found: T | undefined;
    for (const prefix of prefixes) {
        if (iri.startsWith(prefix.iri) && (!found || prefix.iri.length > found.iri.length)) found = prefix;
    }
    return found;
}

function compactIri(iri: string, prefixes: readonly PrefixPlan[]): string {
    const found = namespaceOf(iri, prefixes);
    if (found) {
        const local = iri.slice(found.iri.length);
        if (/^[\p{L}_][\p{L}\p{N}._%~-]*$/u.test(local) && !local.endsWith('.') && !local.includes('~')) {
            return `${found.prefix}:${local}`;
        }
    }
    return `<${iri}>`;
}

function encodeIriSegment(value: string): string {
    let result = '';
    for (const character of value) {
        const code = character.codePointAt(0)!;
        const asciiSafe = /^[A-Za-z0-9._~-]$/.test(character);
        const ucschar = (code >= 0xA0 && code <= 0xD7FF)
            || (code >= 0xF900 && code <= 0xFDCF)
            || (code >= 0xFDF0 && code <= 0xFFEF)
            || (code >= 0x10000 && code <= 0xEFFFD && (code & 0xFFFF) <= 0xFFFD);
        const forbidden = code === 0x200E || code === 0x200F || (code >= 0x202A && code <= 0x202E)
            || (code >= 0xFFF0 && code <= 0xFFFD);
        if (asciiSafe || (ucschar && !forbidden)) {
            result += character;
        } else {
            result += [...new TextEncoder().encode(character)]
                .map(byte => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('');
        }
    }
    return result;
}

function diagnostic(
    node: AstNode | undefined, severity: GufoSeverity, code: string, message: string
): GufoDiagnostic {
    const range = node?.$cstNode?.range;
    let file = '';
    try {
        file = node ? AstUtils.getDocument(node).uri.fsPath : '';
    } catch {
        // A missing anchor is used only for command-level options.
    }
    return {
        file,
        line: (range?.start.line ?? 0) + 1,
        column: (range?.start.character ?? 0) + 1,
        endLine: (range?.end.line ?? 0) + 1,
        endColumn: (range?.end.character ?? 0) + 1,
        severity, code, message, fixes: []
    };
}

function validateDocumentation(nodes: readonly AstNode[], options: GufoOptions, diagnostics: GufoDiagnostic[]): void {
    for (const node of nodes) {
        const documentation = options.documentation?.(node);
        if (!documentation) {
            continue;
        }
        for (const language of [
            ...Object.keys(documentation.labels), ...Object.keys(documentation.descriptions)
        ].filter(tag => tag.length > 0)) {
            if (!isLanguageTag(language)) {
                diagnostics.push(diagnostic(node, 'error', 'gufo-invalid-language-tag',
                    `"${language}" is not a well-formed BCP 47 language tag.`));
            }
        }
    }
}

function isLanguageTag(value: string): boolean {
    return GRANDFATHERED_LANGUAGE_TAGS.has(value.toLowerCase()) || LANGUAGE_TAG.test(value);
}

function planDatatypes(datatypes: readonly (Datatype | Enumeration)[]): DatatypePlan {
    const parent = new Map<Datatype | Enumeration, Datatype | Enumeration>();
    datatypes.forEach(datatype => parent.set(datatype, datatype));
    const root = (datatype: Datatype | Enumeration): Datatype | Enumeration => {
        const current = parent.get(datatype)!;
        if (current === datatype) return datatype;
        const found = root(current);
        parent.set(datatype, found);
        return found;
    };
    const union = (one: Datatype | Enumeration, two: Datatype | Enumeration): void => {
        const a = root(one);
        const b = root(two);
        if (a !== b) parent.set(a, b);
    };
    for (const datatype of datatypes) {
        for (const specialization of datatype.specializes) {
            const target = specialization.ref;
            if (target && (isDatatype(target) || isEnumeration(target)) && parent.has(target)) {
                union(datatype, target);
            }
        }
    }
    const reifiedRoots = new Set<Datatype | Enumeration>();
    for (const datatype of datatypes) {
        const abstractSupertype = datatype.specializes.some(ref =>
            !!ref.ref && isClassDeclaration(ref.ref) && classifiesOnly(ref.ref, 'abstract-individuals'));
        if (isEnumeration(datatype) || datatype.attributes.length > 0 || abstractSupertype) {
            reifiedRoots.add(root(datatype));
        }
    }
    return { reified: new Set(datatypes.filter(datatype => reifiedRoots.has(root(datatype)))) };
}

function isBuiltinDatatype(node: RelationEndTarget): node is Datatype {
    return isDatatype(node) && AstUtils.getDocument(node).uri.toString() === BUILTIN_DATATYPES_URI
        && BUILTIN_DATATYPE_NAMES.has(node.name);
}

function isPrimitiveDatatype(node: RelationEndTarget, plan: DatatypePlan): boolean {
    return isBuiltinDatatype(node) || (isDatatype(node) && !plan.reified.has(node));
}

function packageOfRelation(relation: Relation): Package {
    return isExternalRelation(relation)
        ? relation.$container as Package
        : (relation.$container as ClassDeclaration).$container;
}

/** A property, or an enumeration literal, before its IRI is settled. */
interface NamedMember {
    node: AstNode;
    /** The package whose namespace it is minted in: its declaration's. */
    pkg: Package;
    /** The classifier whose name always qualifies this member's name. */
    owner: Classifier;
    plain: string;
}

/** A relation's declared name, or the directional stem and target it is minted from. */
export function relationPlainName(relation: Relation, source: RelationEndTarget, target: RelationEndTarget): string {
    return relation.name ?? `${relationAlignment(relation, source, target).stem}${target.name}`;
}

/**
 * Settles the IRI of every property and literal (section 4).
 *
 * Each is named `Owner.member` in its declaring package's namespace:
 * `Person.name`, `Product.name`, `Customer.buys`. The dot is structural -- it
 * is not legal inside either declared name -- so adding another member cannot
 * rename one already published. The owner's package is deliberately absent:
 * moving a declaration among packages in one ontology changes no public IRI.
 * A qualified name that still collides is left to the collision check.
 */
function nameMembers(
    members: readonly NamedMember[], namespaces: ReadonlyMap<Package, string>
): Map<AstNode, string> {
    const iris = new Map<AstNode, string>();
    for (const member of members) {
        const namespace = namespaces.get(member.pkg)!;
        const owner = encodeIriSegment(member.owner.name);
        const name = encodeIriSegment(member.plain);
        iris.set(member.node, `${namespace}${owner}.${name}`);
    }
    return iris;
}

function only(natures: ReadonlySet<string> | undefined, allowed: ReadonlySet<string>): boolean {
    return !!natures && natures.size > 0 && [...natures].every(nature => allowed.has(nature));
}

function gUfoType(classDeclaration: ClassDeclaration): string | undefined {
    const natures = possibleNaturesOf(classDeclaration);
    if (only(natures, new Set(['types']))) return undefined;
    if (only(natures, ENDURANT_NATURES)) return ENDURANT_TYPE[classDeclaration.stereotype];
    if (only(natures, EVENT_NATURES)) return 'gufo:EventType';
    if (only(natures, new Set(['situations']))) return 'gufo:SituationType';
    if (only(natures, new Set(['abstract-individuals']))) return 'gufo:AbstractIndividualType';
    if (only(natures, CONCRETE_NATURES)) return 'gufo:ConcreteIndividualType';
    return undefined;
}

function natureImages(classDeclaration: ClassDeclaration): string[] {
    const natures = possibleNaturesOf(classDeclaration);
    return natures ? [...new Set([...natures].map(nature => NATURE_CLASS[nature]).filter(Boolean))] : [];
}

function relationAlignment(relation: Relation, source: RelationEndTarget, target: RelationEndTarget): Alignment {
    const allConcrete = CONCRETE_NATURES;
    const endurants = ENDURANT_NATURES;
    const aspects = ASPECT_NATURES;
    const events = EVENT_NATURES;
    const situation = new Set(['situations']);
    let property: string | undefined;
    let direct = true;
    let expectedSource: ReadonlySet<string> | undefined;
    let expectedTarget: ReadonlySet<string> | undefined;
    switch (relation.stereotype) {
        case 'characterization': property = 'inheresIn'; expectedSource = aspects; expectedTarget = allConcrete; break;
        case 'mediation': property = 'mediates'; expectedSource = new Set(['relators']); expectedTarget = endurants; break;
        case 'externalDependence': property = 'externallyDependsOn'; expectedSource = new Set(['extrinsic-modes']); expectedTarget = endurants; break;
        case 'componenthood': property = 'isComponentOf'; expectedSource = SUBSTANTIAL_NATURES; expectedTarget = new Set(['functional-complexes']); break;
        case 'membership': property = 'isCollectionMemberOf'; expectedSource = SUBSTANTIAL_NATURES; expectedTarget = new Set(['collectives']); break;
        case 'subCollection': property = 'isSubCollectionOf'; expectedSource = new Set(['collectives']); expectedTarget = new Set(['collectives']); break;
        case 'subQuantity': property = 'isSubQuantityOf'; expectedSource = new Set(['quantities']); expectedTarget = new Set(['quantities']); break;
        case 'structural': case 'temporal': case 'participational': property = 'isEventProperPartOf'; expectedSource = events; expectedTarget = events; break;
        case 'constitution': property = 'constitutes'; direct = false; expectedSource = allConcrete; expectedTarget = allConcrete; break;
        case 'historicalDependence': property = 'historicallyDependsOn'; expectedSource = allConcrete; expectedTarget = allConcrete; break;
        case 'participation': property = 'participatedIn'; expectedSource = SUBSTANTIAL_NATURES; expectedTarget = events; break;
        case 'creation': property = 'wasCreatedIn'; expectedSource = endurants; expectedTarget = events; break;
        case 'termination': property = 'wasTerminatedIn'; expectedSource = endurants; expectedTarget = events; break;
        case 'manifestation': property = 'manifestedIn'; expectedSource = aspects; expectedTarget = events; break;
        case 'triggering': property = 'contributedToTrigger'; expectedSource = situation; expectedTarget = events; break;
        case 'bringingAbout': property = 'broughtAbout'; expectedSource = events; expectedTarget = situation; break;
        case 'presence': property = 'standsIn'; direct = false; expectedTarget = situation; break;
        case 'change': return { direct: true, stem: 'changedIn' };
        case 'material': case 'comparative': return { direct: true, stem: 'has' };
    }
    // The name is read from what is written: an unstereotyped parthood is
    // `isProperPartOf` whatever its ends' natures, so editing another class's
    // natures never renames it. The natures choose only the superproperty.
    let named = property;
    if (!property && isParthood(relation)) {
        named = 'isProperPartOf';
        const sourceNatures = isClassDeclaration(source) ? possibleNaturesOf(source) : undefined;
        const targetNatures = isClassDeclaration(target) ? possibleNaturesOf(target) : undefined;
        if (only(sourceNatures, SUBSTANTIAL_NATURES) && only(targetNatures, SUBSTANTIAL_NATURES)) property = 'isObjectProperPartOf';
        else if (only(sourceNatures, ASPECT_NATURES) && only(targetNatures, ASPECT_NATURES)) property = 'isAspectProperPartOf';
        else if (only(sourceNatures, EVENT_NATURES) && only(targetNatures, EVENT_NATURES)) property = 'isEventProperPartOf';
        else if (only(sourceNatures, new Set(['situations'])) && only(targetNatures, new Set(['situations']))) property = 'isSituationProperPartOf';
        else property = 'isProperPartOf';
    }
    if (property && isParthood(relation)) {
        direct = wholeEndOf(relation) === 'target';
    }
    const stem = named === 'standsIn' && !direct ? 'involves'
        : named ? (direct ? named : INVERSE_STEM[named] ?? `has${capitalize(named)}`) : 'has';
    return { property, direct, stem, expectedSource, expectedTarget };
}

function capitalize(value: string): string {
    return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

/** Whether the class types the portion end of a participational decomposition. */
function isParticipationalPortion(context: EmitContext, classifier: ClassDeclaration): boolean {
    return context.relations.some(relation => {
        if (relation.stereotype !== 'participational') {
            return false;
        }
        const part = wholeEndOf(relation) === 'source'
            ? relation.target?.ref
            : getRelationSource(relation);
        return part === classifier;
    });
}

function emitClassifiers(context: EmitContext, classifiers: readonly (ClassDeclaration | Datatype | Enumeration)[]): void {
    for (const classifier of classifiers) {
        context.enter(classifier.$container);
        const subject = context.termOfClassifier(classifier);
        if (isClassDeclaration(classifier)) {
            context.graph.add(subject, 'rdf:type', 'owl:Class');
            const type = gUfoType(classifier);
            if (type) context.graph.add(subject, 'rdf:type', type);
            emitClassSpecializations(context, classifier);
            emitNatureSuperclass(context, classifier);
            if (isParticipationalPortion(context, classifier)) {
                context.graph.add(subject, 'rdfs:subClassOf', 'gufo:Participation');
            }
            emitDocumentation(context, classifier, subject, classifier.name);
            if (classifier.stereotype === 'historicalRole' || classifier.stereotype === 'historicalRoleMixin') {
                note(context, classifier, 'gufo-no-counterpart', classifier.derivedFrom.length > 0
                    ? `gUFO has no historical counterpart for "${classifier.stereotype}"; its sortality is preserved, and its derivation from what happened is written as a definition, which is what keeps it from lapsing.`
                    : `gUFO has no historical counterpart for "${classifier.stereotype}"; its sortality is preserved.`);
            }
            if ((classifier.stereotype === 'phase' || classifier.stereotype === 'role'
                || classifier.stereotype.endsWith('Mixin'))
                && only(possibleNaturesOf(classifier), EVENT_NATURES)) {
                note(context, classifier, 'gufo-no-counterpart',
                    'gUFO has no rigidity classification for event types; the anti-rigidity is omitted.');
            }
            continue;
        }
        if (context.datatypePlan.reified.has(classifier)) {
            context.graph.add(subject, 'rdf:type', 'owl:Class');
            context.graph.add(subject, 'rdf:type', 'gufo:AbstractIndividualType');
            context.graph.add(subject, 'rdfs:subClassOf', 'gufo:QualityValue');
            for (const specialization of classifier.specializes) {
                const target = specialization.ref;
                if (target && (isClassDeclaration(target) || context.datatypePlan.reified.has(target))) {
                    context.graph.add(subject, 'rdfs:subClassOf', context.termOfClassifier(target));
                } else if (target) {
                    note(context, classifier, 'gufo-datatype-specialization-not-expressible',
                        `The specialization of "${classifier.name}" by "${target.name}" is not expressible as an OWL datatype axiom.`);
                }
            }
        } else {
            context.graph.add(subject, 'rdf:type', 'rdfs:Datatype');
            context.graph.add(subject, 'owl:equivalentClass', 'rdfs:Literal');
            if (classifier.specializes.length > 0) {
                note(context, classifier, 'gufo-datatype-specialization-not-expressible',
                    `Literal datatype specializations of "${classifier.name}" are omitted.`);
            }
        }
        emitDocumentation(context, classifier, subject, classifier.name);
        if (isEnumeration(classifier)) emitEnumeration(context, classifier);
    }
}

function emitClassSpecializations(context: EmitContext, classifier: ClassDeclaration): void {
    const subject = context.termOfClassifier(classifier);
    for (const specialization of classifier.specializes) {
        if (specialization.ref) {
            context.graph.add(subject, 'rdfs:subClassOf', context.termOfClassifier(specialization.ref));
        }
    }
}

function emitNatureSuperclass(context: EmitContext, classifier: ClassDeclaration): void {
    const images = natureImages(classifier);
    if (images.length === 0) return;
    const inherited = [...collectAncestors(classifier)].some(ancestor => {
        const ancestorImages = natureImages(ancestor);
        return ancestorImages.length > 0 && ancestorImages.every(image => images.includes(image));
    });
    if (inherited) return;
    const target = images.length === 1 ? images[0]! : blank(['rdf:type', 'owl:Class'], ['owl:unionOf', collection(images.sort())]);
    context.graph.add(context.termOfClassifier(classifier), 'rdfs:subClassOf', target);
}

function emitEnumeration(context: EmitContext, enumeration: Enumeration): void {
    const subject = context.termOfClassifier(enumeration);
    const termByLiteral = new Map(enumeration.literals.map(literal => [literal,
        context.termForIri(context.memberIris.get(literal)!)]));
    const members = [...termByLiteral.values()].sort(lexicalCompare);
    context.graph.add(subject, 'owl:equivalentClass', blank(['rdf:type', 'owl:Class'], ['owl:oneOf', collection(members)]));
    enumeration.literals.forEach(literal => {
        const term = termByLiteral.get(literal)!;
        context.graph.add(term, 'rdf:type', 'owl:NamedIndividual');
        context.graph.add(term, 'rdf:type', subject);
        emitDocumentation(context, literal, term, literal.name);
    });
    if (members.length >= 2) {
        context.graph.addAnonymous(['rdf:type', 'owl:AllDifferent'], ['owl:distinctMembers', collection(members)]);
    }
}

function emitGeneralizationSets(context: EmitContext): void {
    for (const genset of context.gensets) {
        context.enter(genset.$container);
        if (context.options.documentation?.(genset)) {
            note(context, genset, 'gufo-no-counterpart',
                `Documentation on generalization set "${genset.name}" has no RDF resource to annotate.`);
        }
        const general = genset.general.ref;
        const specifics = genset.specifics.map(ref => ref.ref).filter((node): node is NonNullable<typeof node> => !!node);
        if (!general || specifics.length === 0) continue;
        if (isClassDeclaration(general) && specifics.every(isClassDeclaration)) {
            const classSpecifics = specifics as ClassDeclaration[];
            for (const specific of classSpecifics) {
                context.graph.add(context.termOfClassifier(specific), 'rdfs:subClassOf', context.termOfClassifier(general));
            }
            if (genset.complete) {
                const specificTerms = classSpecifics.map(context.termOfClassifier).sort(lexicalCompare);
                const union = classSpecifics.length === 1
                    ? specificTerms[0]!
                    : blank(['rdf:type', 'owl:Class'], ['owl:unionOf', collection(specificTerms)]);
                context.graph.add(context.termOfClassifier(general), 'owl:equivalentClass', union);
            }
            if (genset.disjoint) emitGensetDisjointness(context, genset, classSpecifics);
        } else if (isRelation(general) && specifics.every(isRelation)) {
            const generalPlan = context.relationPlans.get(general);
            if (generalPlan?.writable) {
                for (const specific of specifics as Relation[]) {
                    const plan = context.relationPlans.get(specific);
                    if (plan?.writable) {
                        context.graph.add(context.termForIri(plan.iri), 'rdfs:subPropertyOf',
                            context.termForIri(generalPlan.iri));
                    }
                }
            }
            if (genset.disjoint || genset.complete) {
                note(context, genset, 'gufo-no-counterpart',
                    'OWL has no accumulated-reading counterpart for a disjoint or complete set of relations.');
            }
        }
        // Only a set of classes has a categorizer: `categorizer-is-relation`
        // and `categorizer-on-relation-set` refuse the rest.
        if (!isClassDeclaration(general)) continue;
        for (const categorizerReference of genset.categorizers) {
            const categorizer = categorizerReference.ref;
            if (!categorizer || !isClassDeclaration(categorizer)) continue;
            const categorizerTerm = context.termOfClassifier(categorizer);
            for (const specific of specifics.filter(isClassDeclaration)) {
                context.graph.add(context.termOfClassifier(specific), 'rdf:type', categorizerTerm);
                recordInstance(context, categorizer, specific);
            }
            const partitions = genset.disjoint && genset.complete;
            context.categorizations.push({ higher: categorizer, base: general, partitions, pkg: genset.$container });
            context.graph.add(categorizerTerm, partitions ? 'gufo:partitions' : 'gufo:categorizes',
                context.termOfClassifier(general));
        }
    }
}

function emitGensetDisjointness(
    context: EmitContext, genset: GeneralizationSet, specifics: readonly ClassDeclaration[]
): void {
    const sound: Array<[ClassDeclaration, ClassDeclaration]> = [];
    let omitted = false;
    for (let left = 0; left < specifics.length; left++) {
        for (let right = left + 1; right < specifics.length; right++) {
            const pair: [ClassDeclaration, ClassDeclaration] = [specifics[left]!, specifics[right]!];
            if (soundlyDisjoint(pair[0], pair[1])) {
                sound.push(pair);
            } else {
                omitted = true;
            }
        }
    }
    if (!omitted && specifics.length >= 2) {
        context.graph.addAnonymous(['rdf:type', 'owl:AllDisjointClasses'],
            ['owl:members', collection(specifics.map(context.termOfClassifier).sort(lexicalCompare))]);
        sound.forEach(([one, two]) => context.disjointPairs.set(pairKey(context, one, two), 'list'));
    } else {
        for (const [one, two] of sound) {
            context.graph.add(context.termOfClassifier(one), 'owl:disjointWith', context.termOfClassifier(two));
            context.disjointPairs.set(pairKey(context, one, two), 'pair');
        }
    }
    if (omitted) {
        note(context, genset, 'gufo-disjointness-not-expressible',
            `Some pairs in "${genset.name}" can hold at different times, so their disjointness is omitted${context.options.snapshot ? '; the snapshot layer states it' : ''}.`);
        // At one instant no two of them hold of one individual (section 18).
        if (context.options.snapshot) {
            context.snapshot.addAnonymous(['rdf:type', 'owl:AllDisjointClasses'],
                ['owl:members', collection(specifics.map(context.termOfClassifier).sort(lexicalCompare))]);
        }
    }
}

function emitAttributes(context: EmitContext, classifiers: readonly (ClassDeclaration | Datatype | Enumeration)[]): void {
    for (const owner of classifiers) {
        context.enter(owner.$container);
        for (const attribute of owner.attributes) emitAttribute(context, owner, attribute);
    }
}

function emitAttribute(context: EmitContext, owner: Classifier, attribute: Attribute): void {
    const target = attribute.type.ref;
    if (!target) return;
    const iri = context.memberIris.get(attribute)!;
    const subject = context.termForIri(iri);
    const primitive = isBuiltinDatatype(target) || (isDatatype(target) && !context.datatypePlan.reified.has(target));
    context.graph.add(subject, 'rdf:type', primitive ? 'owl:DatatypeProperty' : 'owl:ObjectProperty');
    context.graph.add(subject, 'rdfs:domain', context.termOfClassifier(owner));
    const timePoint = attribute.stereotypes.includes('begin') || attribute.stereotypes.includes('end');
    const range = isBuiltinDatatype(target)
        ? attribute.stereotypes.length > 0 && target.name === 'datetime' ? 'xsd:dateTimeStamp' : BUILTIN_RANGES[target.name]!
        : context.termOfClassifier(target);
    context.graph.add(subject, 'rdfs:range', range);
    const superproperties = attributeSuperproperties(owner, attribute, target, primitive, context.datatypePlan);
    for (const superproperty of superproperties) context.graph.add(subject, 'rdfs:subPropertyOf', superproperty);
    if (timePoint && superproperties.length === 0 && (target.name === 'date' || target.name === 'datetime')) {
        const natures = isClassDeclaration(owner) ? possibleNaturesOf(owner) : undefined;
        if (natures && natures.size > 0 && !only(natures, CONCRETE_NATURES)) {
            note(context, attribute, 'gufo-alignment-dropped',
                `The time-point property "${attribute.name}" does not fit gUFO's concrete-individual domain.`);
        }
    } else if (timePoint && target.name === 'time') {
        note(context, attribute, 'gufo-no-counterpart', 'gUFO has no time-only begin or end property.');
    } else if (!timePoint && superproperties.length === 0 && isClassDeclaration(owner)) {
        const natures = possibleNaturesOf(owner);
        if (natures && natures.size > 0 && !only(natures, CONCRETE_NATURES)) {
            note(context, attribute, 'gufo-alignment-dropped',
                `The value property "${attribute.name}" does not fit gUFO's concrete-individual domain.`);
        }
    }
    if (attribute.isOrdered || attribute.isDerived) {
        const unsupported = [attribute.isOrdered ? 'ordered' : '', attribute.isDerived ? 'derived' : '']
            .filter(Boolean).join(' and ');
        note(context, attribute, 'gufo-no-counterpart',
            `${unsupported} has no OWL counterpart.`);
    }
    emitDocumentation(context, attribute, subject, attribute.name);
    if (context.options.snapshot) {
        recordShape(context, { owner, path: subject, cardinality: attribute.cardinality,
            values: valuesAt(context, target, !primitive, isBuiltinDatatype(target) && timePoint && target.name === 'datetime'
                ? ['xsd:dateTimeStamp'] : undefined), name: attribute.name });
    }
    emitRestriction(context, owner, target, subject, !primitive, attribute.cardinality,
        isEffectivelyImmutableAttribute(attribute), attribute);
}

function attributeSuperproperties(
    owner: Classifier, attribute: Attribute, target: Datatype | Enumeration,
    primitive: boolean, datatypePlan: DatatypePlan
): string[] {
    const concrete = isClassDeclaration(owner) && only(possibleNaturesOf(owner), CONCRETE_NATURES);
    const qualityValue = (isDatatype(owner) || isEnumeration(owner)) && datatypePlan.reified.has(owner);
    const results: string[] = [];
    if (attribute.stereotypes.length > 0 && isBuiltinDatatype(target)) {
        const suffix = target.name === 'date' ? 'InXSDDate'
            : target.name === 'datetime' ? 'InXSDDateTimeStamp' : undefined;
        if (suffix && concrete) {
            if (attribute.stereotypes.includes('begin')) results.push(`gufo:hasBeginPoint${suffix}`);
            if (attribute.stereotypes.includes('end')) results.push(`gufo:hasEndPoint${suffix}`);
        }
        return results;
    }
    if (primitive && concrete) results.push('gufo:hasQualityValue');
    else if (primitive && qualityValue) results.push('gufo:hasValueComponent');
    else if (!primitive && concrete) results.push('gufo:hasReifiedQualityValue');
    return results;
}

function emitRelations(context: EmitContext): void {
    for (const relation of context.relations) {
        context.enter(packageOfRelation(relation));
        if (relation.stereotype === 'instantiation') {
            if (relation.name) note(context, relation, 'gufo-no-counterpart',
                `Named @instantiation relation "${relation.name}" does not become an OWL property.`);
            continue;
        }
        const plan = context.relationPlans.get(relation);
        if (!plan) continue;
        if (!plan.writable) {
            note(context, relation, 'gufo-no-counterpart', 'An OWL property cannot have literals as its subjects.');
            continue;
        }
        const subject = context.termForIri(plan.iri);
        context.graph.add(subject, 'rdf:type', plan.object ? 'owl:ObjectProperty' : 'owl:DatatypeProperty');
        context.graph.add(subject, 'rdfs:domain', context.termOfClassifier(plan.source));
        context.graph.add(subject, 'rdfs:range', rangeTerm(context, plan.target));
        if ((relation.stereotype === 'material' || relation.stereotype === 'comparative') && plan.object) {
            context.graph.add(subject, 'rdf:type', relation.stereotype === 'material'
                ? 'gufo:MaterialRelationshipType' : 'gufo:ComparativeRelationshipType');
            // The relationship type, as an individual, points at the aspect
            // type it is read off -- both punned, as gUFO's types are.
            for (const ground of relation.derivedFrom) {
                if (ground.ref) context.graph.add(subject, 'gufo:isDerivedFrom', context.termOfClassifier(ground.ref));
            }
        }
        const alignment = relationAlignment(relation, plan.source, plan.target);
        if (alignment.property) {
            if (alignmentFits(alignment, plan.source, plan.target)) {
                context.graph.add(subject, 'rdfs:subPropertyOf', alignment.direct
                    ? `gufo:${alignment.property}` : blank(['owl:inverseOf', `gufo:${alignment.property}`]));
            } else {
                note(context, relation, 'gufo-alignment-dropped',
                    `The ends of this relation do not fit gufo:${alignment.property}; the alignment is omitted.`);
            }
        }
        if (relation.stereotype === 'change') {
            note(context, relation, 'gufo-no-counterpart', '@change has no gUFO superproperty.');
        }
        if (['structural', 'temporal', 'participational'].includes(relation.stereotype ?? '')) {
            note(context, relation, 'gufo-no-counterpart',
                `gUFO does not preserve the @${relation.stereotype} event-parthood distinction.`);
        }
        if (relation.specializes?.ref) {
            const general = context.relationPlans.get(relation.specializes.ref);
            if (general?.writable) {
                context.graph.add(subject, 'rdfs:subPropertyOf', context.termForIri(general.iri));
            }
        }
        if (relation.inverseOf?.ref) {
            const inverse = context.relationPlans.get(relation.inverseOf.ref);
            if (inverse?.writable && plan.object && inverse.object) {
                context.graph.add(subject, 'owl:inverseOf', context.termForIri(inverse.iri));
            } else if (inverse?.writable) {
                note(context, relation, 'gufo-reverse-data-end-not-expressible',
                    'OWL has no inverse data properties.');
            }
        }
        emitEndSubproperties(context, relation);
        // An unnamed relation is labeled with the name coined for it, as a
        // named one is with its own: a property with no label is shown by
        // its IRI, in every tool that reads it. The coined name is qualified
        // by its source, as in the IRI: unqualified, a brass and a string
        // section each with musicians as members were two properties called
        // "hasCollectionMemberMusician", and ROBOT's report refused the pair.
        emitDocumentation(context, relation, subject,
            relation.name ?? `${plan.source.name}.${relationPlainName(relation, plan.source, plan.target)}`);
        emitRelationRestrictions(context, relation, plan);
    }
}

/**
 * A role holds because of something outside it, and says so as a class axiom:
 * every student is mediated by some enrollment (the gUFO paper's Listing 20),
 * every former employee took part in a retirement or a dismissal.
 *
 * The multiplicities already write this where one founding relation is
 * mandatory, and nothing is added there. What the stereotype adds is the case
 * they cannot say: a role founded by several relations, each optional because
 * only one of them has to hold, gets their disjunction; one founded by a
 * single optional relation -- which `founding-relation-optional` asks to be
 * made mandatory -- gets the one restriction the stereotype implies anyway.
 *
 * The founding relations are the class's own (see `utils/founding.ts`), and
 * nothing is written where a supertype founded the same way already founds
 * it, since its own relations are then not assumed to be what does. Sound
 * under the reading of section 3: an instance is founded whenever it is one,
 * so at some time. A disjunct that cannot be written would make the rest too
 * strong, so then nothing is.
 */
function emitRelationalConditions(context: EmitContext): void {
    for (const classifier of context.classes) {
        if (!foundingOf(classifier) || foundedAbove(classifier, () => context.relations)) continue;
        const founding = foundingRelations(classifier, context.relations);
        if (founding.length === 0) continue;
        const conditions: Blank[] = [];
        let settled = false;
        for (const { relation, side } of founding) {
            const plan = context.relationPlans.get(relation);
            const far = side === 'source' ? relation.targetCardinality : relation.sourceCardinality;
            if (!plan?.writable || (side === 'target' && !plan.object) || boundsOf(far).lower >= 1) {
                settled = true;
                break;
            }
            const property = context.termForIri(plan.iri);
            conditions.push(blank(['rdf:type', 'owl:Restriction'],
                ['owl:onProperty', side === 'source' ? property : blank(['owl:inverseOf', property])],
                ['owl:someValuesFrom', rangeTerm(context, side === 'source' ? plan.target : plan.source)]));
        }
        if (settled) continue;
        context.enter(classifier.$container);
        if (context.options.snapshot) {
            context.shapeRecords.push({ kind: 'founding', graph: context.shapes, owner: classifier,
                alternatives: founding.map(({ relation, side }) => {
                    const plan = context.relationPlans.get(relation)!;
                    const property = context.termForIri(plan.iri);
                    return { path: side === 'source' ? property : blank(['owl:inverseOf', property]),
                        filler: rangeTerm(context, side === 'source' ? plan.target : plan.source) };
                }) });
        }
        context.graph.add(context.termOfClassifier(classifier), 'rdfs:subClassOf', conditions.length === 1
            ? conditions[0]!
            : blank(['rdf:type', 'owl:Class'], ['owl:unionOf', collection(conditions)]));
    }
}

/**
 * A historical role derived from what happened is defined by it:
 * `Graduate ≡ Person ⊓ ∃graduatedIn.Graduation`, with a union where several
 * relations found it -- a former employee retired or was dismissed.
 *
 * Both directions, where a role founded by a relator gets only one. Sound
 * under the reading of section 3: whoever graduated at some time is a
 * graduate from then on, and every graduate graduated. Sound in the snapshot
 * layer too, which never retracts an event or a participation in one. This
 * is the one place an equivalence over a relation is safe in a graph that
 * only grows: a role defined by its relator would keep classifying a former
 * student as a student, since the ended enrollment stays in the graph, but a
 * historical role's members grow exactly as the events it is derived from do.
 *
 * Nothing is written where a derived relation cannot be: a definition missing
 * a disjunct would be too strong.
 */
function emitHistoricalDerivations(context: EmitContext): void {
    for (const classifier of context.classes) {
        if (foundingOf(classifier) !== 'historical' || classifier.derivedFrom.length === 0) continue;
        const derived = derivationsOf(classifier, () => context.relations);
        if (derived.length === 0 || derived.length < new Set(classifier.derivedFrom.map(ref => ref.ref)).size) continue;
        const conditions: Blank[] = [];
        let writable = true;
        for (const { relation, event } of derived) {
            const plan = context.relationPlans.get(relation);
            if (!plan?.writable) {
                writable = false;
                break;
            }
            // The event named, which may be narrower than the relation's:
            // created in a birth that is a birth in Brazil.
            conditions.push(blank(['rdf:type', 'owl:Restriction'],
                ['owl:onProperty', context.termForIri(plan.iri)],
                ['owl:someValuesFrom', context.termOfClassifier(event)]));
        }
        if (!writable) continue;
        context.enter(classifier.$container);
        const condition = conditions.length === 1
            ? conditions[0]!
            : blank(['rdf:type', 'owl:Class'], ['owl:unionOf', collection(conditions)]);
        const supertypes = getDirectGeneralizations(classifier)
            .filter((general): general is ClassDeclaration => isClassDeclaration(general))
            .map(general => context.termOfClassifier(general));
        context.graph.add(context.termOfClassifier(classifier), 'owl:equivalentClass', supertypes.length === 0
            ? condition
            : blank(['rdf:type', 'owl:Class'], ['owl:intersectionOf', collection([...supertypes, condition])]));
        if (context.options.snapshot) {
            context.shapeRecords.push({ kind: 'founding', graph: context.shapes, owner: classifier,
                alternatives: derived.map(({ relation, event }) => {
                    const plan = context.relationPlans.get(relation)!;
                    return { path: context.termForIri(plan.iri), filler: context.termOfClassifier(event) };
                }) });
        }
    }
}

/**
 * Taking part in part of an event is taking part in the event (UFO-B), and a
 * participational portion is the whole of one participant's part in it. OWL
 * cannot derive the first for individuals: the chain would make
 * `gufo:participatedIn` non-simple, which gUFO's own `=1` on
 * `gufo:Participation` forbids (section 9.2). What it can hold is what follows
 * for the classes, written on `gufo:participatedIn` itself, so that no model
 * property has to be picked as the one meant:
 *
 * - A participant that must take part in an event that must be part of a
 *   whole took part in the whole: `C ⊑ ∃ gufo:participatedIn.W`, up every
 *   mandatory step of event parthood.
 * - A whole with at least `n` participational portions, each of which must
 *   have an `X` taking part, has at least `n` participants that are `X`s:
 *   `W ⊑ ≥n [ inverse gufo:participatedIn ].X`. The count rests on what
 *   `@participational` means -- one maximal portion per participant, so
 *   distinct portions, distinct participants -- and is written for no other
 *   parthood.
 *
 * Only through participations aligned to `gufo:participatedIn` (section 9.5).
 * Sound under the reading of section 3: an event's parts and participants
 * never change. Both restrictions keep `gufo:participatedIn` simple.
 */
function emitParticipationUpward(context: EmitContext): void {
    const onlyEvents = (target: RelationEndTarget | undefined): target is ClassDeclaration =>
        !!target && isClassDeclaration(target) && classifiesOnly(target, 'events');
    const participations = context.relations.flatMap(relation => {
        const plan = context.relationPlans.get(relation);
        if (relation.stereotype !== 'participation' || !plan?.writable || !plan.object) return [];
        const alignment = relationAlignment(relation, plan.source, plan.target);
        const source = plan.source;
        const target = plan.target;
        return alignment.property === 'participatedIn' && alignment.direct && alignmentFits(alignment, source, target)
            && isClassDeclaration(source) && onlyEvents(target) ? [{ relation, participant: source, event: target }] : [];
    });
    const eventParts = context.relations.flatMap(relation => {
        if (!isParthood(relation)) return [];
        const source = getRelationSource(relation);
        const target = relation.target?.ref;
        const wholeIsSource = wholeEndOf(relation) === 'source';
        const [whole, part] = wholeIsSource ? [source, target] : [target, source];
        if (!onlyEvents(whole) || !onlyEvents(part)) return [];
        return [{
            relation, whole, part,
            wholesPerPart: boundsOf(wholeIsSource ? relation.sourceCardinality : relation.targetCardinality),
            partsPerWhole: boundsOf(wholeIsSource ? relation.targetCardinality : relation.sourceCardinality)
        }];
    });
    const restriction = (property: Term, filler: ClassDeclaration, count: number): Blank => count <= 1
        ? blank(['rdf:type', 'owl:Restriction'], ['owl:onProperty', property], ['owl:someValuesFrom', context.termOfClassifier(filler)])
        : blank(['rdf:type', 'owl:Restriction'], ['owl:onProperty', property],
            ['owl:onClass', context.termOfClassifier(filler)], ['owl:minQualifiedCardinality', integer(count)]);

    // Upward, from each participant.
    for (const { relation, participant, event } of participations) {
        if (boundsOf(relation.targetCardinality).lower < 1) continue;
        const reached = new Set<ClassDeclaration>();
        const pending = [event];
        while (pending.length > 0) {
            const current = pending.pop()!;
            for (const step of eventParts) {
                if (step.wholesPerPart.lower < 1 || !isSameOrSpecializes(current, step.part) || reached.has(step.whole)) continue;
                reached.add(step.whole);
                pending.push(step.whole);
            }
        }
        const direct = participations.filter(other => other.participant === participant
            && boundsOf(other.relation.targetCardinality).lower >= 1).map(other => other.event);
        for (const whole of reached) {
            // Already said by a mandatory participation in it, or in something narrower.
            if (direct.some(event => isSameOrSpecializes(event, whole))) continue;
            context.enter(participant.$container);
            context.graph.add(context.termOfClassifier(participant), 'rdfs:subClassOf',
                restriction('gufo:participatedIn', whole, 1));
        }
    }

    // Counted, on each whole with participational portions.
    for (const step of eventParts) {
        if (step.relation.stereotype !== 'participational' || step.partsPerWhole.lower < 1) continue;
        // A portion has exactly one participant (gUFO says so of every
        // `gufo:Participation`), so each type every portion must have a
        // participant of is that one participant's: all of them count. The
        // narrowest say the rest.
        const participants = [...new Set(participations
            .filter(each => isSameOrSpecializes(step.part, each.event) && boundsOf(each.relation.sourceCardinality).lower >= 1)
            .map(each => each.participant))];
        const narrowest = participants.filter(each =>
            !participants.some(other => other !== each && isSameOrSpecializes(other, each)));
        context.enter(step.whole.$container);
        for (const participant of narrowest) {
            context.graph.add(context.termOfClassifier(step.whole), 'rdfs:subClassOf',
                restriction(blank(['owl:inverseOf', 'gufo:participatedIn']), participant, step.partsPerWhole.lower));
        }
    }
}

/**
 * A material relation holds between two individuals when the relator it is
 * derived from binds them, so its property is the chain through the
 * relator's two mediations: `worksFor` from the employee back to an
 * employment and on to the organization. An extrinsic mode binds the same way
 * through what it inheres in and what it depends on.
 *
 * Written only where it adds without taking away:
 *
 * - The two links have to be found, one per end, among the ground's own
 *   dependences. One inherited from a supertype is shared with every other
 *   specialization of it, and the chain would relate whatever those bind too.
 * - The two have to differ: one mediation read both ways relates each
 *   individual it reaches to itself.
 * - OWL 2 DL counts a property implied by a chain as non-simple, and so are
 *   the ones above it and its inverses. None of them may then carry a
 *   cardinality restriction or be functional, which OWL 2 DL requires simple
 *   properties for; where the export already writes one of those, the chain
 *   is withheld, not the bound. Nor may it reach a gUFO property, whose
 *   axioms are not the export's to weaken.
 * - A link may not itself sit under the property, which would make the
 *   property hierarchy irregular.
 *
 * Each dependence is fixed for as long as the relator or mode exists, so a
 * pair it ever binds is bound at one time, and the accumulated reading of
 * section 3 holds.
 */
function emitDerivationChains(context: EmitContext): void {
    const derived = context.relations.filter(relation => relation.stereotype === 'material' && relation.derivedFrom.length === 1);
    if (derived.length === 0) return;
    const { counted, upward } = propertyHierarchy(context);
    for (const relation of derived) {
        const plan = context.relationPlans.get(relation);
        const ground = relation.derivedFrom[0]?.ref;
        if (!plan?.writable || !plan.object || !ground
            || !isClassDeclaration(plan.source) || !isClassDeclaration(plan.target)) continue;
        const stereotypes = classifiesOnly(ground, 'relators') ? ['mediation']
            : classifiesOnly(ground, 'extrinsic-modes') ? ['characterization', 'externalDependence'] : undefined;
        if (!stereotypes) continue;
        const dependences = context.relations.filter(candidate => getRelationSource(candidate) === ground
            && stereotypes.includes(candidate.stereotype ?? '') && context.relationPlans.get(candidate)?.writable);
        const reaching = (end: ClassDeclaration): Relation[] => dependences.filter(candidate => {
            const reached = candidate.target?.ref;
            return !!reached && isClassDeclaration(reached) && isSameOrSpecializes(end, reached);
        });
        const withheld = (why: string): void => note(context, relation, 'gufo-derivation-chain-withheld',
            `The chain through "${ground.name}" is not written: ${why}.`);
        const [fromSource, fromTarget] = [reaching(plan.source), reaching(plan.target)];
        if (fromSource.length !== 1 || fromTarget.length !== 1) {
            withheld(fromSource.length === 0 || fromTarget.length === 0
                ? `it has no dependence of its own on ${fromSource.length === 0 ? `"${plan.source.name}"` : `"${plan.target.name}"`}`
                : 'more than one of its dependences reaches an end, and the model does not say which is which');
            continue;
        }
        const [sourceLink, targetLink] = [fromSource[0]!, fromTarget[0]!];
        if (sourceLink === targetLink) {
            withheld('one dependence reaches both ends, and read both ways it would relate each individual to itself');
            continue;
        }
        const property = context.termForIri(plan.iri);
        const [first, second] = [sourceLink, targetLink].map(each => context.termForIri(context.relationPlans.get(each)!.iri));
        const nonSimple = upward(property);
        const restricted = [...nonSimple].find(each => counted.has(each));
        if (restricted) {
            withheld(`OWL 2 DL would then forbid the ${restricted === property ? '' : `${restricted} `}cardinality`
                + ' restriction or functional characteristic the export writes');
            continue;
        }
        if ([...nonSimple].some(each => each.startsWith('gufo:'))) {
            withheld('the property is under a gUFO property, which OWL 2 DL would then count as non-simple');
            continue;
        }
        if (upward(first!).has(property) || upward(second!).has(property)) {
            withheld('a dependence it runs through is itself under the property');
            continue;
        }
        context.enter(packageOfRelation(relation));
        context.graph.add(property, 'owl:propertyChainAxiom', collection([blank(['owl:inverseOf', first!]), second!]));
    }
}

/** The property named by a term: itself, or what it is the inverse of. */
function namedProperty(term: Term): string | undefined {
    return typeof term === 'string' ? term
        : term instanceof Blank && term.pairs[0]?.[0] === 'owl:inverseOf' && typeof term.pairs[0][1] === 'string'
            ? term.pairs[0][1] : undefined;
}

/**
 * What OWL 2 DL's simplicity rule needs to know of the core ontologies, as
 * written so far: the properties a cardinality restriction or a functional
 * characteristic is stated of, those a chain implies, and what is above each
 * property -- its superproperties and inverses, transitively, which are
 * non-simple whenever it is.
 */
function propertyHierarchy(context: EmitContext): {
    counted: Set<string>; chained: Set<string>; upward: (start: string) => Set<string>;
} {
    const above = new Map<string, Set<string>>();
    const link = (from: string | undefined, to: string | undefined): void => {
        if (!from || !to) return;
        above.set(from, (above.get(from) ?? new Set()).add(to));
    };
    const counted = new Set<string>();
    const chained = new Set<string>();
    const COUNTS = new Set(['owl:cardinality', 'owl:minCardinality', 'owl:maxCardinality',
        'owl:qualifiedCardinality', 'owl:minQualifiedCardinality', 'owl:maxQualifiedCardinality']);
    for (const [subject, predicate, object] of context.groups.flatMap(group => [...group.graph.statements()])) {
        if (predicate === 'rdfs:subPropertyOf') link(namedProperty(subject), namedProperty(object));
        if (predicate === 'owl:inverseOf') {
            link(namedProperty(subject), namedProperty(object));
            link(namedProperty(object), namedProperty(subject));
        }
        if (predicate === 'owl:propertyChainAxiom') {
            const head = namedProperty(subject);
            if (head) chained.add(head);
        }
        if (predicate === 'rdf:type' && (object === 'owl:FunctionalProperty' || object === 'owl:InverseFunctionalProperty')) {
            const property = namedProperty(subject);
            if (property) counted.add(property);
        }
        if (object instanceof Blank && object.pairs.some(([key]) => COUNTS.has(key))) {
            const onProperty = object.pairs.find(([key]) => key === 'owl:onProperty')?.[1];
            const property = onProperty && namedProperty(onProperty);
            if (property) counted.add(property);
        }
    }
    const upward = (start: string): Set<string> => {
        const reached = new Set([start]);
        const pending = [start];
        while (pending.length > 0) {
            for (const next of above.get(pending.pop()!) ?? []) {
                if (!reached.has(next)) {
                    reached.add(next);
                    pending.push(next);
                }
            }
        }
        return reached;
    };
    return { counted, chained, upward };
}

/** What one shape checks: a property's count and values at an owner, or what founds a role. */
type ShapeRecord =
    | { kind: 'property'; graph: Graph; owner: Classifier; path: Term; min: number; max: number; values: Blank | undefined; name: string }
    | { kind: 'founding'; graph: Graph; owner: ClassDeclaration; alternatives: Array<{ path: Term; filler: string }> };

/**
 * The literal datatypes a built-in datatype's values may carry. `sh:datatype`
 * compares the datatype IRI exactly, where OWL's range admits its derived
 * types too: a `number` is an `xsd:decimal`, and `42` in Turtle is an
 * `xsd:integer`, which the range admits and `sh:datatype xsd:decimal` would
 * not. So each lists what its range admits that a graph is likely to write.
 */
const BUILTIN_SHAPE_DATATYPES: Readonly<Record<string, readonly string[]>> = {
    string: ['xsd:string'], number: ['xsd:decimal', 'xsd:integer'], boolean: ['xsd:boolean'],
    date: ['xsd:date'], time: ['xsd:time'], datetime: ['xsd:dateTime', 'xsd:dateTimeStamp']
};

/** What each value at an end must be: an instance of its class, or a literal of its datatype. */
function valuesAt(
    context: EmitContext, target: RelationEndTarget, object: boolean, datatypes: readonly string[] | undefined
): Blank | undefined {
    if (object) return blank(['sh:class', rangeTerm(context, target)]);
    // A literal datatype of the model's own is the whole of rdfs:Literal
    // (section 5.3), so it constrains nothing.
    const admitted = datatypes ?? (isBuiltinDatatype(target) ? BUILTIN_SHAPE_DATATYPES[target.name] : undefined);
    if (!admitted) return undefined;
    return admitted.length === 1 ? blank(['sh:datatype', admitted[0]!])
        : blank(['sh:or', collection(admitted.map(datatype => blank(['sh:datatype', datatype])))]);
}

function recordShape(context: EmitContext, record: {
    owner: Classifier; path: Term; cardinality: Cardinality | undefined; values: Blank | undefined; name: string;
}): void {
    const bounds = boundsOf(record.cardinality);
    context.shapeRecords.push({ kind: 'property', graph: context.shapes, owner: record.owner, path: record.path,
        min: bounds.lower, max: bounds.upper, values: record.values, name: record.name });
}

function localNameOf(iri: string): string {
    return iri.slice(Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/')) + 1);
}

/**
 * The snapshot layer's SHACL shapes: what the model says of one instant,
 * checked against a graph of current state without a reasoner -- which OWL
 * does not do, since with no unique-name assumption an upper bound merges two
 * values instead of reporting them. Every multiplicity, lower and upper,
 * whether or not the ontologies could state it; the class or datatype at
 * each end; one specific of each generalization set, as the set says; and
 * what founds a role (section 10.1). Checking a subclass needs the hierarchy
 * in the data graph: validate a graph together with the ontologies, or with
 * RDFS inference.
 *
 * A property's count includes its subproperties' values, as a reasoner's
 * would: the path is the property and every property of the model below it,
 * as `sh:alternativePath`, so that a triple asserted with a subsetting end
 * counts toward the end it subsets without inference.
 */
function emitShapes(context: EmitContext): void {
    // Below each property expression of the model, the ones specializing it.
    const below = new Map<string, Set<string>>();
    const keyOf = (term: Term): string | undefined => {
        const named = namedProperty(term);
        if (!named || named.startsWith('gufo:')) return undefined;
        return typeof term === 'string' ? named : `^${named}`;
    };
    const invert = (key: string): string => key.startsWith('^') ? key.slice(1) : `^${key}`;
    const edge = (sub: string, sup: string): void => {
        below.set(sup, (below.get(sup) ?? new Set()).add(sub));
    };
    for (const [subject, predicate, object] of context.groups.flatMap(group => [...group.graph.statements()])) {
        if (predicate !== 'rdfs:subPropertyOf') continue;
        const [sub, sup] = [keyOf(subject), keyOf(object)];
        if (!sub || !sup) continue;
        edge(sub, sup);
        edge(invert(sub), invert(sup));
    }
    const pathOf = (term: Term): Term => {
        const start = keyOf(term);
        if (!start) return term;
        const keys = new Set([start]);
        const pending = [start];
        while (pending.length > 0) {
            for (const next of below.get(pending.pop()!) ?? []) {
                if (!keys.has(next)) {
                    keys.add(next);
                    pending.push(next);
                }
            }
        }
        const paths = [...keys].sort(lexicalCompare).map(key =>
            key.startsWith('^') ? blank(['sh:inversePath', key.slice(1)]) : key);
        return paths.length === 1 ? paths[0]! : blank(['sh:alternativePath', collection(paths)]);
    };

    // One named node shape per class and graph, holding its property shapes.
    const names = new Map<Graph, Set<string>>();
    const shapeName = (graph: Graph, wanted: string): string => {
        const taken = names.get(graph) ?? new Set<string>();
        names.set(graph, taken);
        let name = wanted;
        for (let counter = 2; taken.has(name); counter++) name = `${wanted}_${counter}`;
        taken.add(name);
        return `${shapesPrefixOf(context, graph)}:${name}`;
    };
    const nodeShapes = new Map<string, string>();
    const nodeShape = (graph: Graph, owner: Classifier): string => {
        const key = `${context.groups.findIndex(group => group.shapes === graph)} ${context.termOfClassifier(owner)}`;
        let shape = nodeShapes.get(key);
        if (!shape) {
            shape = shapeName(graph, localNameOf(context.iriOfClassifier(owner)));
            nodeShapes.set(key, shape);
            graph.add(shape, 'rdf:type', 'sh:NodeShape');
            graph.add(shape, 'sh:targetClass', context.termOfClassifier(owner));
        }
        return shape;
    };
    const shapePath = (term: Term): Term => {
        const path = pathOf(term);
        const named = namedProperty(term);
        return typeof term !== 'string' && path === term && named ? blank(['sh:inversePath', named]) : path;
    };
    for (const record of context.shapeRecords) {
        if (record.kind === 'property') {
            if (record.min === 0 && !Number.isFinite(record.max) && !record.values) continue;
            const pairs: Array<[string, Term]> = [['sh:path', shapePath(record.path)], ['sh:name', literal(record.name)]];
            if (record.min > 0) pairs.push(['sh:minCount', String(record.min)]);
            if (Number.isFinite(record.max)) pairs.push(['sh:maxCount', String(record.max)]);
            if (record.values) pairs.push(...record.values.pairs.map(([key, value]) => [key, value] as [string, Term]));
            record.graph.add(nodeShape(record.graph, record.owner), 'sh:property', blank(...pairs));
        } else {
            // One of these holds at any one instant: its union (section 10.1).
            const alternatives = record.alternatives.map(({ path, filler }) =>
                blank(['sh:path', shapePath(path)], ['sh:minCount', '1'], ['sh:class', filler]));
            const shape = shapeName(record.graph, `${localNameOf(context.iriOfClassifier(record.owner))}_founded`);
            record.graph.add(shape, 'rdf:type', 'sh:NodeShape');
            record.graph.add(shape, 'sh:targetClass', context.termOfClassifier(record.owner));
            if (alternatives.length === 1) {
                record.graph.add(shape, 'sh:property', alternatives[0]!);
            } else {
                record.graph.add(shape, 'sh:or', collection(alternatives));
            }
            record.graph.add(shape, 'sh:message', literal(alternatives.length === 1
                ? `A ${record.owner.name} holds because of what founds it, and nothing here does.`
                : `A ${record.owner.name} holds because of one of the relations that found it, and none holds here.`));
        }
    }

    // Generalization sets: at any one instant, which specifics an instance may be in.
    for (const genset of context.gensets) {
        const general = genset.general?.ref;
        const specifics = genset.specifics.flatMap(reference => reference.ref && isClassDeclaration(reference.ref) ? [reference.ref] : []);
        if (!general || !isClassDeclaration(general) || specifics.length === 0 || (!genset.disjoint && !genset.complete)) continue;
        context.enter(genset.$container);
        const graph = context.shapes;
        const members = specifics.map(specific => blank(['sh:class', context.termOfClassifier(specific)]));
        const listed = specifics.map(specific => specific.name).join(', ');
        const shape = shapeName(graph, genset.name ?? `${general.name}_specifics`);
        graph.add(shape, 'rdf:type', 'sh:NodeShape');
        graph.add(shape, 'sh:targetClass', context.termOfClassifier(general));
        if (genset.disjoint && genset.complete) {
            graph.add(shape, 'sh:xone', collection(members));
            graph.add(shape, 'sh:message', literal(`At any one instant, a ${general.name} is exactly one of ${listed}.`));
        } else if (genset.complete) {
            graph.add(shape, 'sh:or', collection(members));
            graph.add(shape, 'sh:message', literal(`At any one instant, a ${general.name} is at least one of ${listed}.`));
        } else {
            // At most one: exactly one of the specifics, or of none of them.
            graph.add(shape, 'sh:xone', collection([...members, blank(['sh:not', blank(['sh:or', collection(members)])])]));
            graph.add(shape, 'sh:message', literal(`At any one instant, a ${general.name} is at most one of ${listed}.`));
        }
    }
}

/** The prefix the shapes graph of this group names its shapes with. */
function shapesPrefixOf(context: EmitContext, graph: Graph): string {
    const group = context.groups.find(each => each.shapes === graph)!;
    return shapesPrefix(group);
}

function shapesPrefix(group: OntologyGroup): string {
    const stem = localNameOf(group.ontology).replace(/[^\p{L}\p{N}_]/gu, '_');
    return `${/^\p{L}/u.test(stem) ? stem : `s${stem}`}-shapes`;
}

/**
 * The snapshot layer's upper bounds, now that every chain is written. A chain
 * makes the property it implies non-simple, and everything above it, and OWL
 * 2 DL allows no cardinality restriction or functional characteristic on a
 * non-simple property. The core keeps its chain whatever layers are asked
 * for, so it is the snapshot bound that gives way, and says so.
 */
function emitSnapshotBounds(context: EmitContext): void {
    const { chained, upward } = propertyHierarchy(context);
    const nonSimple = new Set([...chained].flatMap(head => [...upward(head)]));
    for (const bound of context.snapshotBounds) {
        const property = namedProperty(bound.property);
        if (property && nonSimple.has(property)) {
            note(context, bound.anchor, 'gufo-snapshot-bound-withheld',
                `The snapshot layer does not state the upper bound ${bound.upper} either: ${property} is implied by a chain (section 9.2), and OWL 2 DL allows no cardinality restriction on a property that is.`);
            continue;
        }
        bound.graph.add(bound.owner, 'rdfs:subClassOf', bound.restriction);
        if (!bound.functional) continue;
        if (typeof bound.property === 'string') {
            bound.graph.add(bound.property, 'rdf:type', 'owl:FunctionalProperty');
        } else if (property) {
            bound.graph.add(property, 'rdf:type', 'owl:InverseFunctionalProperty');
        }
    }
}

function emitEndSubproperties(context: EmitContext, relation: Relation): void {
    for (const end of [relation.sourceMeta, relation.targetMeta]) {
        if (!end) continue;
        for (const kind of ['subsets', 'redefines'] as const) {
            const generalEnd = end[kind]?.ref;
            if (!generalEnd) continue;
            const specificExpression = endExpression(context, end);
            const generalExpression = endExpression(context, generalEnd);
            if (specificExpression && generalExpression) {
                context.graph.add(specificExpression, 'rdfs:subPropertyOf', generalExpression);
            } else {
                note(context, end, 'gufo-reverse-data-end-not-expressible',
                    `The ${kind} constraint needs an inverse data property, which OWL cannot express.`);
            }
            if (kind === 'redefines') emitRedefinedEndValues(context, end, generalEnd, generalExpression);
        }
    }
}

/**
 * For an instance of the redefining end's owner, the redefined end holds the
 * redefining end's links and no others, so everything it reaches has the
 * redefining end's type. Under the "at some time" reading that may be written
 * only when every link the redefined end ever gives such an instance is held
 * while it is one: the owner is lifetime-wide, or neither owner's membership
 * lapses and the redefined end's links are effectively immutable (section
 * 9.6). That the redefined end has no links beyond the redefining one's has
 * no OWL form at all.
 */
function emitRedefinedEndValues(
    context: EmitContext, end: RelationEndMetaAttributes, generalEnd: RelationEndMetaAttributes,
    generalExpression: Term | undefined
): void {
    const owner = getEndOwner(end);
    const type = getEndType(end);
    const generalOwner = getEndOwner(generalEnd);
    const generalPlan = context.relationPlans.get(generalEnd.$container);
    if (!owner || !type || !generalOwner || !generalExpression || !generalPlan
        || type === getEndType(generalEnd)
        || isPrimitiveDatatype(type, context.datatypePlan) === generalPlan.object) {
        note(context, end, 'gufo-no-counterpart',
            'OWL preserves the subproperty part of redefines, but not the replacement of the general end.');
        return;
    }
    const sound = isLifetimeWide(owner) || (membershipNeverLapses(owner) && membershipNeverLapses(generalOwner)
        && isEffectivelyImmutableEnd(generalEnd.$container, getEndSide(generalEnd) ?? 'target'));
    if (sound) {
        context.graph.add(context.termOfClassifier(owner), 'rdfs:subClassOf', blank(['rdf:type', 'owl:Restriction'],
            ['owl:onProperty', generalExpression], ['owl:allValuesFrom', rangeTerm(context, type)]));
        note(context, end, 'gufo-no-counterpart',
            `OWL preserves the subproperty part of redefines and that ${owner.name} reaches only ${type.name} through the general end, but not that the general end holds no other links.`);
    } else {
        note(context, end, 'gufo-no-counterpart',
            `OWL preserves the subproperty part of redefines, but not the replacement of the general end. Not even the narrowed type: ${owner.name} may have held other links through the general end while it was not one, or before they changed${context.options.snapshot ? '; the snapshot layer states the narrowed type, which holds at any one instant' : ''}.`);
        if (context.options.snapshot) {
            context.snapshot.add(context.termOfClassifier(owner), 'rdfs:subClassOf', blank(['rdf:type', 'owl:Restriction'],
                ['owl:onProperty', generalExpression], ['owl:allValuesFrom', rangeTerm(context, type)]));
        }
    }
}

function endExpression(context: EmitContext, end: RelationEndMetaAttributes): Term | undefined {
    const relation = end.$container;
    const plan = context.relationPlans.get(relation);
    if (!plan?.writable) return undefined;
    const property = context.termForIri(plan.iri);
    if (getEndSide(end) === 'target') return property;
    return plan.object ? blank(['owl:inverseOf', property]) : undefined;
}

function emitRelationRestrictions(context: EmitContext, relation: Relation, plan: PropertyPlan): void {
    const property = context.termForIri(plan.iri);
    if (context.options.snapshot) {
        recordShape(context, { owner: plan.source, path: property, cardinality: relation.targetCardinality,
            values: valuesAt(context, plan.target, plan.object, undefined),
            name: relation.name ?? relationPlainName(relation, plan.source, plan.target) });
        if (plan.object) {
            recordShape(context, { owner: plan.target, path: blank(['owl:inverseOf', property]),
                cardinality: relation.sourceCardinality, values: valuesAt(context, plan.source, true, undefined),
                name: relation.name ?? relationPlainName(relation, plan.source, plan.target) });
        }
    }
    emitRestriction(context, plan.source, plan.target, property, plan.object,
        relation.targetCardinality, isEffectivelyImmutableEnd(relation, 'target'), relation);
    if (plan.object) {
        emitRestriction(context, plan.target, plan.source, blank(['owl:inverseOf', property]), true,
            relation.sourceCardinality, isEffectivelyImmutableEnd(relation, 'source'), relation);
    } else {
        const bounds = boundsOf(relation.sourceCardinality);
        if (bounds.lower > 0 || Number.isFinite(bounds.upper) || relation.sourceMeta?.subsets || relation.sourceMeta?.redefines) {
            note(context, relation, 'gufo-reverse-data-end-not-expressible',
                'The source end of a data-property relation has no OWL property expression.');
        }
    }
}

function emitRestriction(
    context: EmitContext, owner: Classifier, target: RelationEndTarget, property: Term,
    object: boolean, cardinality: Cardinality | undefined, immutable: boolean, anchor: AstNode
): void {
    const bounds = boundsOf(cardinality);
    const retainUpper = Number.isFinite(bounds.upper) && immutable && membershipNeverLapses(owner);
    // OWL 2's RDF mapping gives each restriction node exactly one constraint,
    // so a range [l..u] is two restrictions, never one node with both.
    const restrict = (...constraint: Array<[string, Term]>) => context.graph.add(context.termOfClassifier(owner),
        'rdfs:subClassOf', blank(['rdf:type', 'owl:Restriction'], ['owl:onProperty', property], ...constraint));
    const count = (qualified: string, unqualified: string, n: number): Array<[string, Term]> => object
        ? [['owl:onClass', rangeTerm(context, target)], [qualified, integer(n)]]
        : [[unqualified, integer(n)]];
    if (retainUpper && bounds.lower === bounds.upper) {
        restrict(...count('owl:qualifiedCardinality', 'owl:cardinality', bounds.lower));
    } else {
        if (bounds.lower > 0) {
            if (object && bounds.lower === 1 && !retainUpper) {
                restrict(['owl:someValuesFrom', rangeTerm(context, target)]);
            } else {
                restrict(...count('owl:minQualifiedCardinality', 'owl:minCardinality', bounds.lower));
            }
        }
        if (retainUpper) {
            restrict(...count('owl:maxQualifiedCardinality', 'owl:maxCardinality', bounds.upper));
        }
    }
    // The owner is the property's domain -- its range, read from the other
    // end -- and each attribute and relation has a property of its own, so a
    // max of one on the owner is a max of one on every subject: the property
    // is functional, or inverse-functional, whether declared or not. Declared,
    // for the readers that do not reason (section 10).
    if (retainUpper && bounds.upper === 1) {
        if (typeof property === 'string') {
            context.graph.add(property, 'rdf:type', 'owl:FunctionalProperty');
        } else if (property instanceof Blank && property.pairs[0]?.[0] === 'owl:inverseOf') {
            context.graph.add(property.pairs[0][1], 'rdf:type', 'owl:InverseFunctionalProperty');
        }
    }
    if (Number.isFinite(bounds.upper) && !retainUpper) {
        note(context, anchor, 'gufo-upper-bound-not-expressible',
            `The upper bound ${bounds.upper} is not lifetime-wide and is omitted${context.options.snapshot ? '; the snapshot layer states it' : ''}.`);
        // At one instant it holds whatever changes (section 18).
        if (context.options.snapshot) {
            context.snapshotBounds.push({
                graph: context.snapshot, owner: context.termOfClassifier(owner), property, anchor, upper: bounds.upper,
                restriction: blank(['rdf:type', 'owl:Restriction'], ['owl:onProperty', property],
                    ...count('owl:maxQualifiedCardinality', 'owl:maxCardinality', bounds.upper)),
                functional: bounds.upper === 1
            });
        }
    }
}

function boundsOf(cardinality: Cardinality | undefined): { lower: number; upper: number } {
    return cardinality ? getBounds(cardinality) ?? { lower: 0, upper: Infinity } : { lower: 1, upper: 1 };
}

function integer(value: number): string {
    return `"${value}"^^xsd:nonNegativeInteger`;
}

function rangeTerm(context: EmitContext, target: RelationEndTarget): string {
    return isBuiltinDatatype(target) ? BUILTIN_RANGES[target.name]! : context.termOfClassifier(target);
}

function alignmentFits(alignment: Alignment, source: RelationEndTarget, target: RelationEndTarget): boolean {
    if (!isClassDeclaration(source) || !isClassDeclaration(target)) return false;
    const writtenSource = possibleNaturesOf(source);
    const writtenTarget = possibleNaturesOf(target);
    const expectedSource = alignment.direct ? alignment.expectedSource : alignment.expectedTarget;
    const expectedTarget = alignment.direct ? alignment.expectedTarget : alignment.expectedSource;
    return (!expectedSource || only(writtenSource, expectedSource)) && (!expectedTarget || only(writtenTarget, expectedTarget));
}

function emitInstantiation(context: EmitContext): void {
    const specializationClosure = (base: ClassDeclaration): ClassDeclaration[] =>
        context.classes.filter(candidate => candidate === base || collectAncestors(candidate).has(base));
    for (const base of context.classes) {
        const declared = base.instanceOf?.ref;
        if (declared) {
            context.enter(base.$container);
            context.graph.add(context.termOfClassifier(base), 'rdf:type', context.termOfClassifier(declared));
            if (isClassDeclaration(declared)) recordInstance(context, declared, base);
        }
    }
    for (const relation of context.relations.filter(relation => relation.stereotype === 'instantiation')) {
        const base = getRelationSource(relation);
        const higher = relation.target?.ref;
        if (!base || !higher || !isClassDeclaration(base) || !isClassDeclaration(higher)) continue;
        context.enter(packageOfRelation(relation));
        if (higher.isPowerType) {
            for (const instance of specializationClosure(base)) {
                context.graph.add(context.termOfClassifier(instance), 'rdf:type', context.termOfClassifier(higher));
            }
            note(context, relation, 'gufo-no-counterpart',
                'gUFO cannot state that future specializations are instances of an isPowerType classifier.');
        } else {
            const bounds = boundsOf(relation.targetCardinality);
            const partitions = bounds.lower === 1 && bounds.upper === 1;
            context.graph.add(context.termOfClassifier(higher),
                partitions ? 'gufo:partitions' : 'gufo:categorizes', context.termOfClassifier(base));
            context.categorizations.push({ higher, base, partitions, pkg: packageOfRelation(relation) });
        }
    }
}

/**
 * Ultimate sortals share no instance. Each ontology states this for its own
 * declarations; unrelated workspace ontologies must not alter its axioms.
 */
function emitUltimateDisjointness(context: EmitContext): void {
    const ultimate = context.classes.filter(classifier => isUltimateSortal(classifier.stereotype));
    const state = (graph: Graph, members: readonly ClassDeclaration[]): void => {
        const terms = members.map(context.termOfClassifier).sort(lexicalCompare);
        if (terms.length < 2) return;
        graph.addAnonymous(['rdf:type', 'owl:AllDisjointClasses'], ['owl:members', collection(terms)]);
    };
    for (const group of context.groups) {
        state(group.graph, ultimate.filter(classifier => group.packages.includes(classifier.$container)));
    }
}

function recordInstance(context: EmitContext, higher: ClassDeclaration, instance: ClassDeclaration): void {
    const instances = context.categorizerInstances.get(higher) ?? new Set<ClassDeclaration>();
    context.categorizerInstances.set(higher, instances);
    instances.add(instance);
}

function pairKey(context: EmitContext, one: ClassDeclaration, two: ClassDeclaration): string {
    return [context.termOfClassifier(one), context.termOfClassifier(two)].sort(lexicalCompare).join(' ');
}

/** Whether "never both" is true of two classes under the accumulated reading (section 3). */
function soundlyDisjoint(one: ClassDeclaration, two: ClassDeclaration): boolean {
    return isLifetimeWide(one) || isLifetimeWide(two)
        || (membershipNeverLapses(one) && membershipNeverLapses(two));
}

/**
 * States, pair by pair, the disjointness of a partitioning type's instances
 * that the model already implies (section 17).
 *
 * A partition's instances share no instance, and gufoshapes asks for that to
 * be written down for each pair, not inherited: `Man` and `Woman` under
 * disjoint `Male` and `Female` are disjoint in tonto and in OWL alike, and
 * still fail the shape until the pair itself is declared. So every pair that
 * `cannotShareInstances` proves -- the same reading
 * `partition-instances-not-disjoint` uses -- is written, if it is sound under
 * the accumulated reading and not written already. What is left out is left
 * out on purpose: an anti-rigid pair, and a pair the model never made
 * disjoint.
 *
 * When every pair of the instances is disjoint, they are one
 * `owl:AllDisjointClasses`, whose membership has no direction for the shape
 * to miss. Otherwise the pairs that are sound are written in both
 * directions: `owl:disjointWith` is symmetric only to an OWL reasoner, and
 * the shape asks for each ordered pair in turn, so a pair a generalization
 * set stated once is stated the other way round here too.
 */
function emitPartitionDisjointness(context: EmitContext): void {
    const done = new Set<ClassDeclaration>();
    for (const { higher, partitions, pkg } of context.categorizations) {
        if (!partitions || done.has(higher)) continue;
        done.add(higher);
        context.enter(pkg);
        const members = [...context.categorizerInstances.get(higher) ?? []]
            .sort((one, two) => lexicalCompare(context.termOfClassifier(one), context.termOfClassifier(two)));
        const unstated: Array<[ClassDeclaration, ClassDeclaration]> = [];
        // Pairs that cannot share an instance at one time, but may over a
        // life: the snapshot layer's (section 18).
        const atOneInstant: Array<[ClassDeclaration, ClassDeclaration]> = [];
        let everyPair = true;
        let everyPairAtOneInstant = true;
        for (let left = 0; left < members.length; left++) {
            for (let right = left + 1; right < members.length; right++) {
                const [one, two] = [members[left]!, members[right]!];
                const stated = context.disjointPairs.get(pairKey(context, one, two));
                if (stated === 'list' || (context.ultimateSortals.has(one) && context.ultimateSortals.has(two))) {
                    continue;
                }
                if (stated === undefined && !cannotShareInstances(one, two)) {
                    everyPair = false;
                    everyPairAtOneInstant = false;
                    continue;
                }
                if (stated === undefined && !soundlyDisjoint(one, two)) {
                    everyPair = false;
                    atOneInstant.push([one, two]);
                    continue;
                }
                unstated.push([one, two]);
            }
        }
        if (context.options.snapshot && atOneInstant.length > 0) {
            if (everyPairAtOneInstant) {
                context.snapshot.addAnonymous(['rdf:type', 'owl:AllDisjointClasses'],
                    ['owl:members', collection(members.map(context.termOfClassifier))]);
            } else {
                for (const [one, two] of atOneInstant) {
                    context.snapshot.add(context.termOfClassifier(one), 'owl:disjointWith', context.termOfClassifier(two));
                    context.snapshot.add(context.termOfClassifier(two), 'owl:disjointWith', context.termOfClassifier(one));
                }
            }
        }
        if (unstated.length === 0) continue;
        if (everyPair) {
            context.graph.addAnonymous(['rdf:type', 'owl:AllDisjointClasses'],
                ['owl:members', collection(members.map(context.termOfClassifier))]);
            unstated.forEach(([one, two]) => context.disjointPairs.set(pairKey(context, one, two), 'list'));
            continue;
        }
        for (const [one, two] of unstated) {
            context.graph.add(context.termOfClassifier(one), 'owl:disjointWith', context.termOfClassifier(two));
            context.graph.add(context.termOfClassifier(two), 'owl:disjointWith', context.termOfClassifier(one));
            context.disjointPairs.set(pairKey(context, one, two), 'pair');
        }
    }
}

const GUFO_SORTAL_TYPES = new Set(['gufo:Kind', 'gufo:SubKind', 'gufo:Phase', 'gufo:Role']);

/**
 * The redundant direct specializations `directSpecializations` asks for.
 *
 * gufoshapes reads asserted triples: `BaseSortalShape` wants a base sortal's
 * own `rdfs:subClassOf` to reach a gUFO sortal, and `CategorizationShape` an
 * instance of a categorizer to be a direct subclass of what it categorizes.
 * A `class` between a subkind and its kind, or an instance two levels below
 * its base, satisfies tonto and OWL and fails both shapes. Each triple here
 * is entailed by ones already written, so the option adds no meaning.
 */
function emitDirectSpecializations(context: EmitContext): void {
    for (const classifier of context.classes) {
        if (!['gufo:SubKind', 'gufo:Phase', 'gufo:Role'].includes(gUfoType(classifier) ?? '')) continue;
        context.enter(classifier.$container);
        const direct = getDirectGeneralizations(classifier);
        if (direct.some(parent => GUFO_SORTAL_TYPES.has(gUfoType(parent) ?? ''))) continue;
        const seen = new Set<ClassDeclaration>();
        const frontier = [...direct];
        while (frontier.length > 0) {
            const ancestor = frontier.shift()!;
            if (seen.has(ancestor) || ancestor === classifier) continue;
            seen.add(ancestor);
            if (GUFO_SORTAL_TYPES.has(gUfoType(ancestor) ?? '')) {
                context.graph.add(context.termOfClassifier(classifier), 'rdfs:subClassOf', context.termOfClassifier(ancestor));
            } else {
                frontier.push(...getDirectGeneralizations(ancestor));
            }
        }
    }
    for (const { higher, base, pkg } of context.categorizations) {
        context.enter(pkg);
        for (const instance of context.categorizerInstances.get(higher) ?? []) {
            if (instance !== base && !getDirectGeneralizations(instance).includes(base)
                && isSameOrSpecializes(instance, base)) {
                context.graph.add(context.termOfClassifier(instance), 'rdfs:subClassOf', context.termOfClassifier(base));
            }
        }
    }
}

/**
 * A resource's labels and comments, and -- for a term the export mints -- the
 * ontology that defines it. Every class, datatype, literal and property goes
 * through here, which is what keeps `rdfs:isDefinedBy` on each of them.
 */
function emitDocumentation(
    context: EmitContext, node: AstNode, subject: string, declaredName: string | undefined, mints = true
): void {
    const documentation = context.options.documentation?.(node);
    if (documentation?.text) context.graph.add(subject, 'rdfs:comment', literal(documentation.text));
    for (const [language, text] of Object.entries(documentation?.descriptions ?? {})) {
        context.graph.add(subject, 'rdfs:comment', literal(text, language));
    }
    for (const [language, text] of Object.entries(documentation?.labels ?? {})) {
        context.graph.add(subject, 'rdfs:label', literal(text, language));
    }
    // The declared name is the fallback, not a companion: it is written only
    // when `///` gives no label in any language (section 11).
    if (declaredName && Object.keys(documentation?.labels ?? {}).length === 0) {
        context.graph.add(subject, 'rdfs:label', literal(declaredName));
    }
    if (mints) {
        context.graph.add(subject, 'rdfs:isDefinedBy', context.ontology);
    }
}

/**
 * A string literal. JSON's escapes are Turtle's, so a value is escaped by
 * `JSON.stringify` and never by hand; one that runs over lines is written
 * with its line breaks, in Turtle's long form, as it was written in the model.
 */
function literal(value: string, language?: string): string {
    const escaped = JSON.stringify(value)
        .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    const written = value.includes('\n')
        ? `""${escaped.replace(/\\(u[0-9A-Fa-f]{4}|.)/g, (all, escape: string) => escape === 'n' ? '\n' : all)}""`
        : escaped;
    return language ? `${written}@${language}` : written;
}

function note(context: EmitContext, node: AstNode, code: string, message: string): void {
    const existing = context.diagnostics.find(entry => entry.code === code
        && entry.file === AstUtils.getDocument(node).uri.fsPath
        && entry.line === (node.$cstNode?.range.start.line ?? 0) + 1
        && entry.column === (node.$cstNode?.range.start.character ?? 0) + 1);
    if (existing) {
        if (!existing.message.includes(message)) existing.message = `${existing.message} ${message}`;
        return;
    }
    context.diagnostics.push(diagnostic(node, 'information', code, message));
}

function isLifetimeWide(classifier: Classifier): boolean {
    if (isDatatype(classifier) || isEnumeration(classifier)) return true;
    if (!isClassDeclaration(classifier)) return false;
    if (isRigid(classifier.stereotype)) return true;
    const natures = possibleNaturesOf(classifier);
    return !!natures && natures.size > 0 && [...natures].every(nature => IMMUTABLE_NATURES.has(nature));
}

function membershipNeverLapses(classifier: Classifier): boolean {
    return isLifetimeWide(classifier) || (isClassDeclaration(classifier)
        && (classifier.stereotype === 'historicalRole' || classifier.stereotype === 'historicalRoleMixin'));
}

function isEffectivelyImmutableAttribute(attribute: Attribute): boolean {
    if (attribute.isConst || attribute.isAddOnly || attribute.stereotypes.includes('begin')
        || attribute.stereotypes.includes('end')) return true;
    return !attribute.isDerived && ownsOnlyImmutableAttributes(attribute.$container);
}

function isEffectivelyImmutableEnd(relation: Relation, side: 'source' | 'target', seen = new Set<RelationEndMetaAttributes>()): boolean {
    const end = side === 'source' ? relation.sourceMeta : relation.targetMeta;
    if (end?.isConst || end?.isAddOnly) return true;
    if (end && !seen.has(end)) {
        seen.add(end);
        for (const general of [end.subsets?.ref, end.redefines?.ref]) {
            if (general && (general.isConst || general.isAddOnly
                || isEffectivelyImmutableEnd(general.$container, getEndSide(general) ?? 'target', seen))) return true;
        }
    }
    if (side === 'target' && (['characterization', 'mediation', 'externalDependence', 'historicalDependence', 'creation']
        .includes(relation.stereotype ?? ''))) return true;
    const owner = side === 'target' ? getRelationSource(relation) : relation.target?.ref;
    if (owner && isClassDeclaration(owner) && hasImmutableInstances(owner)
        && !isSituationParthood(relation) && !holdsAccumulatingHistory(relation, side)) return true;
    if (relation.stereotype === 'historicalDependence' && side === 'source') return true;
    const source = getRelationSource(relation);
    const target = relation.target?.ref;
    if (side === 'target' && source && target && isClassDeclaration(source) && isClassDeclaration(target)) {
        if (relation.stereotype === 'constitution' && classifiesOnly(source, 'processes') && classifiesOnly(target, 'events')) return true;
        if (isParthood(relation) && wholeEndOf(relation) === 'source'
            && ((classifiesOnly(source, 'processes') && classifiesOnly(target, 'processes'))
                || isSituationParthood(relation))) return true;
    }
    return false;
}
