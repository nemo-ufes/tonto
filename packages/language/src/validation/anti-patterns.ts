import type { ValidationAcceptor } from 'langium';
import { AstUtils } from 'langium';
import type { ClassDeclaration, Model, Relation } from '../generated/ast.js';
import { isClassDeclaration, isExternalRelation } from '../generated/ast.js';
import { registerDerivedCacheReset } from '../utils/derived-cache.js';
import { cannotShareInstances } from '../utils/disjointness.js';
import { collectAncestors, getDirectGeneralizations } from '../utils/generalizations.js';
import { getRelationSource } from '../utils/relations.js';
import { getBounds } from './cardinality-checks.js';
import type { ReverseLookup } from './incoming-relations.js';
import { subtypesOf } from './ufo-checks.js';
import { isNonSortal, isSortal, isUltimateSortal } from './stereotype-model.js';

/**
 * Ontological anti-patterns from Sales & Guizzardi, "Ontological
 * Anti-Patterns: Empirically Uncovered Error-Prone Structures in
 * Ontology-Driven Conceptual Models" (NEMO/UFES, 2015).
 *
 * These are *not* errors. Each describes a structure that is legal OntoUML
 * but was empirically found to often admit unintended instances -- typically
 * because a disjointness, subsetting or cardinality constraint the modeler
 * had in mind was never written down. The paper measured them across 54
 * models and found them common (AssocCyc in 92% of applicable models, ImpAbs
 * in 72%, RepRel in 64%), and explicitly notes that not every occurrence is
 * a defect.
 *
 * They are therefore reported at `info` severity, and each diagnostic
 * carries the paper's acronym as its `code` so occurrences can be filtered
 * or suppressed per pattern. Raise ANTI_PATTERN_SEVERITY to 'warning' if you
 * want them to stand out more.
 *
 * Each is scanned over one document, unlike the rules, which read the whole
 * workspace. That is deliberate: these are pairwise loops over every class
 * and every relation, and the shape they look for -- a cycle, a repeated
 * relation, an abstraction with nothing under it -- is one an author sees in
 * front of them. The consequence is that a model split across files reports
 * fewer of them than the same model in one file, never more: the direction a
 * heuristic should err in. Checked mechanically in `test/cross-file.test.ts`,
 * which is where a `+` in the split would show up.
 */
const ANTI_PATTERN_SEVERITY = 'info' as const;

// --- shared model queries -------------------------------------------------

function documentModel(node: ClassDeclaration | Relation): Model {
    return AstUtils.getDocument(node).parseResult.value as Model;
}

// Memoized for the same reason as in utils/generalizations.ts: these scans sit
// inside pairwise loops over every relation. They hold resolved references, so
// they are dropped on every document update (see utils/derived-cache.ts).
let classCache = new WeakMap<Model, ClassDeclaration[]>();
let relationCache = new WeakMap<Model, Relation[]>();
let subtypeCache = new WeakMap<Model, Map<ClassDeclaration, ClassDeclaration[]>>();
let relationEndIndexCache = new WeakMap<Model, {
    bySource: Map<ClassDeclaration, Relation[]>;
    byTarget: Map<ClassDeclaration, Relation[]>;
}>();

registerDerivedCacheReset(() => {
    classCache = new WeakMap();
    relationCache = new WeakMap();
    subtypeCache = new WeakMap();
    relationEndIndexCache = new WeakMap();
});

function documentClasses(model: Model): ClassDeclaration[] {
    let classes = classCache.get(model);
    if (!classes) {
        classes = model.packages.flatMap(pkg => pkg.declarations.filter(isClassDeclaration));
        classCache.set(model, classes);
    }
    return classes;
}

/** Every relation written in the document, internal and external. */
function documentRelations(model: Model): Relation[] {
    let relations = relationCache.get(model);
    if (!relations) {
        relations = [];
        for (const pkg of model.packages) {
            for (const declaration of pkg.declarations) {
                if (isExternalRelation(declaration)) {
                    relations.push(declaration);
                } else if (isClassDeclaration(declaration)) {
                    relations.push(...declaration.relations);
                }
            }
        }
        relationCache.set(model, relations);
    }
    return relations;
}

/**
 * Direct subtypes of a class, within its own document, from a single reverse
 * index built once per document rather than a scan per lookup.
 *
 * Document-scoped like the rest of the anti-pattern analysis: a subtype
 * declared in another file is not counted, which can only ever *miss*
 * occurrences, never invent them.
 */
function getDirectSubtypes(classDeclaration: ClassDeclaration): ClassDeclaration[] {
    const model = documentModel(classDeclaration);
    let index = subtypeCache.get(model);
    if (!index) {
        index = new Map();
        for (const candidate of documentClasses(model)) {
            for (const parent of getDirectGeneralizations(candidate)) {
                const siblings = index.get(parent);
                if (siblings) {
                    siblings.push(candidate);
                } else {
                    index.set(parent, [candidate]);
                }
            }
        }
        subtypeCache.set(model, index);
    }
    return index.get(classDeclaration) ?? [];
}

function ultimateSortalAncestors(classDeclaration: ClassDeclaration): ClassDeclaration[] {
    const own = isUltimateSortal(classDeclaration.stereotype) ? [classDeclaration] : [];
    return [...own, ...[...collectAncestors(classDeclaration)].filter(a => isUltimateSortal(a.stereotype))];
}

function sharesAncestorWith(a: ClassDeclaration, b: ClassDeclaration): boolean {
    const ancestorsOfB = collectAncestors(b);
    return [...collectAncestors(a)].some(ancestor => ancestorsOfB.has(ancestor));
}

/**
 * Whether two types can possibly share an instance -- the BinOver
 * "overlapping types" test, conditions (1)-(8) of the paper.
 */
export function possiblyOverlap(source: ClassDeclaration, target: ClassDeclaration): boolean {
    // (1) same type
    if (source === target) {
        return true;
    }
    // (2)/(3) one specializes the other
    if (collectAncestors(source).has(target) || collectAncestors(target).has(source)) {
        return true;
    }
    // The paper says "not explicitly disjoint"; what settles it is the same
    // question one level up -- a disjointness above them reaches them, and two
    // ultimate sortals need no set at all.
    if (cannotShareInstances(source, target)) {
        return false;
    }
    // (4) sortals sharing an identity provider, not explicitly disjoint
    if (isSortal(source.stereotype) && isSortal(target.stereotype)) {
        const sourceKinds = ultimateSortalAncestors(source);
        const targetKinds = ultimateSortalAncestors(target);
        if (sourceKinds.some(kind => targetKinds.includes(kind))) {
            return true;
        }
    }
    // (5)/(6) relators (or modes) sharing a supertype, not explicitly disjoint
    const sharedStereotypeFamily =
        (source.stereotype === 'relator' && target.stereotype === 'relator') ||
        (isModeLike(source.stereotype) && isModeLike(target.stereotype));
    if (sharedStereotypeFamily && sharesAncestorWith(source, target)) {
        return true;
    }
    // (7)/(8) non-sortals generalizing a common type, or sharing a supertype
    if (isNonSortal(source.stereotype) && isNonSortal(target.stereotype)) {
        const sourceSubtypes = new Set(allSubtypes(source));
        if (allSubtypes(target).some(subtype => sourceSubtypes.has(subtype))) {
            return true;
        }
        if (sharesAncestorWith(source, target)) {
            return true;
        }
    }
    return false;
}

function isModeLike(stereotype: string): boolean {
    return stereotype === 'mode' || stereotype === 'intrinsicMode' || stereotype === 'extrinsicMode';
}

function allSubtypes(classDeclaration: ClassDeclaration): ClassDeclaration[] {
    const result: ClassDeclaration[] = [];
    const seen = new Set<ClassDeclaration>();
    const visit = (current: ClassDeclaration): void => {
        for (const subtype of getDirectSubtypes(current)) {
            if (!seen.has(subtype)) {
                seen.add(subtype);
                result.push(subtype);
                visit(subtype);
            }
        }
    };
    visit(classDeclaration);
    return result;
}

function endClasses(relation: Relation): { source?: ClassDeclaration; target?: ClassDeclaration } {
    const source = getRelationSource(relation);
    const target = relation.target?.ref;
    return {
        source: source && isClassDeclaration(source) ? source : undefined,
        target: target && isClassDeclaration(target) ? target : undefined
    };
}

/** A description a reader can locate: the relation's name, or its endpoints. */
function relationLabel(relation: Relation): string {
    if (relation.name) {
        return `"${relation.name}"`;
    }
    const { source, target } = endClasses(relation);
    if (source && target) {
        return `the relation "${source.name}" -- "${target.name}"`;
    }
    return 'this relation';
}

// --- BinOver --------------------------------------------------------------

/**
 * BinOver -- Binary Relation Between Overlapping Types. The two ends can be
 * instantiated by the same individual, so without an explicit constraint the
 * relation permits an object to relate to itself.
 */
export function checkBinaryRelationBetweenOverlappingTypes(relation: Relation, accept: ValidationAcceptor): void {
    const { source, target } = endClasses(relation);
    if (!source || !target || !possiblyOverlap(source, target)) {
        return;
    }
    accept(
        ANTI_PATTERN_SEVERITY,
        `${relationLabel(relation)} relates "${source.name}" and "${target.name}", whose instances may overlap. Consider whether an individual may relate to itself, and add a disjointness or irreflexivity constraint if not.`,
        { node: relation, code: 'BinOver' }
    );
}

// --- ImpAbs ---------------------------------------------------------------

/**
 * ImpAbs -- Imprecise Abstraction. A relation end with an upper bound above
 * one, attached to a class that has two or more subtypes, is usually hiding
 * subtype-specific constraints.
 */
export function checkImpreciseAbstraction(relation: Relation, accept: ValidationAcceptor): void {
    const { source, target } = endClasses(relation);
    const check = (side: 'source' | 'target', classDeclaration?: ClassDeclaration): void => {
        if (!classDeclaration) {
            return;
        }
        const cardinality = side === 'source' ? relation.sourceCardinality : relation.targetCardinality;
        if (!cardinality) {
            return;
        }
        const bounds = getBounds(cardinality);
        if (!bounds || bounds.upper < 2) {
            return;
        }
        const subtypes = getDirectSubtypes(classDeclaration);
        if (subtypes.length >= 2) {
            accept(
                ANTI_PATTERN_SEVERITY,
                `The ${side} end of ${relationLabel(relation)} allows several "${classDeclaration.name}", which has ${subtypes.length} subtypes. Consider whether the relation should be stated more precisely against those subtypes.`,
                { node: relation, code: 'ImpAbs' }
            );
        }
    };
    check('source', source);
    check('target', target);
}

// --- RelSpec --------------------------------------------------------------

/**
 * RelSpec -- Relation Specialization. Two relations whose ends line up by
 * specialization suggest one should specialize, subset or redefine the
 * other, or that they should be declared disjoint.
 */
export function checkRelationSpecializationOpportunity(relation: Relation, accept: ValidationAcceptor): void {
    // Only report from the more specific relation, and skip relations that
    // already declare the connection explicitly -- including through an end
    // that subsets or redefines, which implies the specialization. Advising
    // one to "consider whether it should subset" was the opposite of help.
    const overrides = (meta: typeof relation.sourceMeta): boolean => !!meta?.subsets || !!meta?.redefines;
    if (relation.specializes || relation.inverseOf || overrides(relation.sourceMeta) || overrides(relation.targetMeta)) {
        return;
    }
    const ends = endClasses(relation);
    if (!ends.source || !ends.target) {
        return;
    }

    // A candidate must have one end at an ancestor-or-self of this relation's
    // source, so only those relations are examined. Comparing against every
    // relation in the document instead made validation quadratic in relation
    // count -- ~7s on a 1000-relation model.
    const { bySource, byTarget } = relationEndIndex(documentModel(relation));
    const sourceUpwards = [ends.source, ...collectAncestors(ends.source)];

    const report = (other: Relation): void => {
        accept(
            ANTI_PATTERN_SEVERITY,
            `${relationLabel(relation)} connects the same or more specific types as ${relationLabel(other)}. Consider whether it should specialize, subset or redefine it.`,
            { node: relation, code: 'RelSpec' }
        );
    };

    for (const ancestor of sourceUpwards) {
        for (const other of bySource.get(ancestor) ?? []) {
            const otherEnds = endClasses(other);
            if (isCandidate(relation, ends, other, otherEnds) && isSameOrSub(ends.target, otherEnds.target!)) {
                report(other);
                return;
            }
        }
        // The same relation written the other way round.
        for (const other of byTarget.get(ancestor) ?? []) {
            const otherEnds = endClasses(other);
            if (isCandidate(relation, ends, other, otherEnds) && isSameOrSub(ends.target, otherEnds.source!)) {
                report(other);
                return;
            }
        }
    }
}

type Ends = { source?: ClassDeclaration; target?: ClassDeclaration };

function isCandidate(relation: Relation, ends: Ends, other: Relation, otherEnds: Ends): boolean {
    if (other === relation || other.specializes || other.inverseOf) {
        return false;
    }
    if (!otherEnds.source || !otherEnds.target) {
        return false;
    }
    // Identical end pairs are not a specialization opportunity, just a duplicate.
    return ends.source !== otherEnds.source || ends.target !== otherEnds.target;
}

/** Relations of a document indexed by the class at each end. */
function relationEndIndex(model: Model): {
    bySource: Map<ClassDeclaration, Relation[]>;
    byTarget: Map<ClassDeclaration, Relation[]>;
} {
    let index = relationEndIndexCache.get(model);
    if (!index) {
        const bySource = new Map<ClassDeclaration, Relation[]>();
        const byTarget = new Map<ClassDeclaration, Relation[]>();
        const add = (map: Map<ClassDeclaration, Relation[]>, key: ClassDeclaration, relation: Relation): void => {
            const list = map.get(key);
            if (list) {
                list.push(relation);
            } else {
                map.set(key, [relation]);
            }
        };
        for (const relation of documentRelations(model)) {
            const { source, target } = endClasses(relation);
            if (source && target) {
                add(bySource, source, relation);
                add(byTarget, target, relation);
            }
        }
        index = { bySource, byTarget };
        relationEndIndexCache.set(model, index);
    }
    return index;
}

function isSameOrSub(sub: ClassDeclaration, sup: ClassDeclaration): boolean {
    return sub === sup || collectAncestors(sub).has(sup);
}

// --- relator-based patterns ----------------------------------------------

export interface Mediation {
    relation: Relation;
    /** The mediated (non-relator) end's class. */
    mediated: ClassDeclaration;
    /** Bounds of the mediated end. */
    mediatedUpper: number;
    /** Bounds of the relator end. */
    relatorUpper: number;
}

/** Mediations touching a relator, found within the relator's own document. */
export function getMediations(relator: ClassDeclaration): Mediation[] {
    const result: Mediation[] = [];
    for (const relation of documentRelations(documentModel(relator))) {
        if (relation.stereotype !== 'mediation') {
            continue;
        }
        const { source, target } = endClasses(relation);
        let mediated: ClassDeclaration | undefined;
        let mediatedCardinality;
        let relatorCardinality;
        if (source === relator && target) {
            mediated = target;
            mediatedCardinality = relation.targetCardinality;
            relatorCardinality = relation.sourceCardinality;
        } else if (target === relator && source) {
            mediated = source;
            mediatedCardinality = relation.sourceCardinality;
            relatorCardinality = relation.targetCardinality;
        }
        if (!mediated) {
            continue;
        }
        const mediatedBounds = mediatedCardinality ? getBounds(mediatedCardinality) : undefined;
        const relatorBounds = relatorCardinality ? getBounds(relatorCardinality) : undefined;
        result.push({
            relation,
            mediated,
            mediatedUpper: mediatedBounds?.upper ?? 1,
            relatorUpper: relatorBounds?.upper ?? 1
        });
    }
    return result;
}

/**
 * RelOver -- Relator Mediating Overlapping Types. A relator mediating two or
 * more possibly-overlapping types, where the mediated upper bounds sum to
 * more than two, usually needs those types declared disjoint.
 */
export function checkRelatorMediatingOverlappingTypes(classDeclaration: ClassDeclaration, accept: ValidationAcceptor): void {
    if (classDeclaration.stereotype !== 'relator') {
        return;
    }
    const mediations = getMediations(classDeclaration);
    if (mediations.length < 2) {
        return;
    }
    const totalUpper = mediations.reduce((sum, m) => sum + m.mediatedUpper, 0);
    if (!(totalUpper > 2)) {
        return;
    }
    for (let i = 0; i < mediations.length; i++) {
        for (let j = i + 1; j < mediations.length; j++) {
            const a = mediations[i].mediated;
            const b = mediations[j].mediated;
            if (possiblyOverlap(a, b)) {
                accept(
                    ANTI_PATTERN_SEVERITY,
                    `Relator "${classDeclaration.name}" mediates "${a.name}" and "${b.name}", whose instances may overlap. Consider whether one individual may fill both roles in the same relationship.`,
                    { node: classDeclaration, property: 'name', code: 'RelOver' }
                );
                return;
            }
        }
    }
}

// --- AssocCyc -------------------------------------------------------------

/**
 * Longest cycle searched, in vertices. Enumerating every simple cycle is
 * exponential, so the walk is bounded; long cycles are also the least likely
 * to represent a constraint a modeler actually had in mind.
 */
const MAX_CYCLE_LENGTH = 8;

/** Upper bound on reported cycles per document, so a dense model cannot flood the panel. */
const MAX_REPORTED_CYCLES = 25;

interface CycleEdge {
    id: number;
    from: ClassDeclaration;
    to: ClassDeclaration;
    /** Undefined for a generalization edge. */
    relation?: Relation;
}

/**
 * Builds the undirected graph the paper's cycle analysis runs over:
 * associations plus generalizations, excluding derived ones (constraint 3 --
 * a derived association's cycle is already closed by its derivation rule).
 *
 * A relation is derived when it says what from: `derivedFrom` names the
 * relator a material relation is read off, or the qualities a comparative one
 * compares. One that is derived and does not say so counts as an edge, which
 * over-reports rather than under-reports.
 */
function buildCycleGraph(model: Model): { edges: CycleEdge[]; adjacency: Map<ClassDeclaration, CycleEdge[]> } {
    const edges: CycleEdge[] = [];
    let id = 0;

    for (const relation of documentRelations(model)) {
        if (relation.derivedFrom.length > 0) {
            continue;
        }
        const { source, target } = endClasses(relation);
        // A self-loop is a BinOver occurrence, not a cycle in this sense.
        if (source && target && source !== target) {
            edges.push({ id: id++, from: source, to: target, relation });
        }
    }

    const generalizations = new Set<string>();
    for (const classDeclaration of documentClasses(model)) {
        for (const parent of getDirectGeneralizations(classDeclaration)) {
            if (parent === classDeclaration) {
                continue;
            }
            // `specializes` and a generalization set can state the same edge twice.
            const key = `${classDeclaration.name}\u0000${parent.name}`;
            if (!generalizations.has(key)) {
                generalizations.add(key);
                edges.push({ id: id++, from: classDeclaration, to: parent });
            }
        }
    }

    const adjacency = new Map<ClassDeclaration, CycleEdge[]>();
    const link = (vertex: ClassDeclaration, edge: CycleEdge): void => {
        const list = adjacency.get(vertex);
        if (list) {
            list.push(edge);
        } else {
            adjacency.set(vertex, [edge]);
        }
    };
    for (const edge of edges) {
        link(edge.from, edge);
        link(edge.to, edge);
    }
    return { edges, adjacency };
}

/**
 * The Relator design pattern -- a relator mediating two types that are
 * themselves connected by a material relation -- is a legitimate closed
 * cycle, since the material relation is derived from the relator. Constraint
 * 4 of the paper excludes it.
 */
function isRelatorPattern(cycle: CycleEdge[]): boolean {
    if (cycle.length !== 3) {
        return false;
    }
    const mediations = cycle.filter(edge => edge.relation?.stereotype === 'mediation');
    if (mediations.length !== 2) {
        return false;
    }
    const [first, second] = mediations;
    const shared = [first.from, first.to].find(vertex => vertex === second.from || vertex === second.to);
    return shared?.stereotype === 'relator';
}

/**
 * AssocCyc -- Association Cycle. Three or more associations forming a cycle
 * leave it unstated whether instance-level cycles are intended, which is
 * exactly the ambiguity the paper found modelers resolve inconsistently.
 *
 * Registered on `Model` rather than on each relation so the graph is built
 * once per document and each cycle is reported exactly once.
 */
export function checkAssociationCycles(model: Model, accept: ValidationAcceptor): void {
    const { adjacency } = buildCycleGraph(model);
    const vertices = [...adjacency.keys()];
    const order = new Map(vertices.map((vertex, index) => [vertex, index]));
    const reported = new Set<string>();
    let count = 0;

    for (const start of vertices) {
        if (count >= MAX_REPORTED_CYCLES) {
            break;
        }
        const startIndex = order.get(start)!;
        const path: ClassDeclaration[] = [start];
        const used: CycleEdge[] = [];

        const walk = (current: ClassDeclaration): void => {
            if (count >= MAX_REPORTED_CYCLES) {
                return;
            }
            for (const edge of adjacency.get(current) ?? []) {
                if (used.includes(edge)) {
                    continue;
                }
                const next = edge.from === current ? edge.to : edge.from;
                if (next === start) {
                    if (used.length >= 2) {
                        record([...used, edge], [...path]);
                    }
                    continue;
                }
                // Only extend through vertices ordered after the start, so each
                // cycle is enumerated from a single origin.
                if (order.get(next)! <= startIndex || path.includes(next) || path.length >= MAX_CYCLE_LENGTH) {
                    continue;
                }
                path.push(next);
                used.push(edge);
                walk(next);
                used.pop();
                path.pop();
            }
        };

        const record = (cycle: CycleEdge[], vertexPath: ClassDeclaration[]): void => {
            // Constraint 2: more than two *associations*; generalization edges
            // may pad a cycle but never constitute one.
            const associations = cycle.filter(edge => edge.relation);
            if (associations.length <= 2 || isRelatorPattern(cycle)) {
                return;
            }
            const key = cycle.map(edge => edge.id).sort((a, b) => a - b).join(',');
            if (reported.has(key)) {
                return;
            }
            reported.add(key);
            count++;

            // Anchor on the earliest association so the diagnostic lands in a
            // stable, predictable place.
            const anchor = associations
                .filter(edge => edge.relation?.$cstNode)
                .sort((a, b) => a.relation!.$cstNode!.offset - b.relation!.$cstNode!.offset)[0];
            if (!anchor?.relation) {
                return;
            }
            const names = [...vertexPath.map(vertex => vertex.name), vertexPath[0].name];
            accept(
                ANTI_PATTERN_SEVERITY,
                `${associations.length} associations form a cycle: ${names.join(' -> ')}. Decide whether instances must form cycles too -- if so constrain it, otherwise forbid it or derive one of the associations.`,
                { node: anchor.relation, code: 'AssocCyc' }
            );
        };

        walk(start);
    }
}

/**
 * RepRel -- Repeatable Relator Instances. When every mediation's relator end
 * admits more than one relator, the model permits several indistinguishable
 * relators over the very same individuals.
 */
export function checkRepeatableRelatorInstances(classDeclaration: ClassDeclaration, accept: ValidationAcceptor): void {
    if (classDeclaration.stereotype !== 'relator') {
        return;
    }
    const mediations = getMediations(classDeclaration);
    if (mediations.length < 2 || !mediations.every(m => m.relatorUpper > 1)) {
        return;
    }
    accept(
        ANTI_PATTERN_SEVERITY,
        `Every mediation of relator "${classDeclaration.name}" allows more than one relator at its relator end, so several indistinguishable "${classDeclaration.name}" instances may relate the same individuals. Consider restricting a relator end to [1].`,
        { node: classDeclaration, property: 'name', code: 'RepRel' }
    );
}


// --- DepPhase -------------------------------------------------------------

/**
 * DepPhase -- a phase whose condition is relational.
 *
 * A phase and a role are both anti-rigid, and what separates them is *why*
 * they stop holding: a phase by a change in the individual itself -- being a
 * child, being empty -- and a role by a relationship it stands in. So a phase
 * that a relator mediates, or that depends on something outside itself, is
 * classifying by a relationship while saying it classifies by a condition, and
 * the two readings differ exactly where it matters: whether an instance can
 * stop being one without changing.
 *
 * Reported rather than refused, as the whole family is: the model may be
 * saying that the phase happens to coincide with a relationship, which is not
 * a mistake, only a place where two stereotypes could each be meant.
 */
export function checkPhaseIsIntrinsic(classDeclaration: ClassDeclaration, accept: ValidationAcceptor): void {
    if (classDeclaration.stereotype !== 'phase' && classDeclaration.stereotype !== 'phaseMixin') {
        return;
    }
    const { byTarget } = relationEndIndex(documentModel(classDeclaration));
    const relational = (byTarget.get(classDeclaration) ?? []).find(relation =>
        relation.stereotype === 'mediation' || relation.stereotype === 'externalDependence');
    const other = relational && getRelationSource(relational);
    if (!relational || !other || !isClassDeclaration(other)) {
        return;
    }
    accept(
        ANTI_PATTERN_SEVERITY,
        `Phase "${classDeclaration.name}" is ${relational.stereotype === 'mediation' ? 'mediated by' : 'depended on by'} "${other.name}", so what makes it hold is a relationship rather than a condition of the individual. A "role" is the stereotype for that.`,
        { node: classDeclaration, property: 'name', code: 'DepPhase' }
    );
}

// --- MixIden --------------------------------------------------------------

/**
 * MixIden -- a non-sortal that spans one identity principle.
 *
 * A non-sortal exists to say something across kinds: a `category Party` holds
 * of people and of organizations, which no sortal can. One whose sortals all
 * draw identity from the same ultimate sortal is saying that across nothing --
 * everything it classifies is a Person -- and a `subkind`, `role` or `phase`
 * of that kind says it while supplying the identity a non-sortal cannot.
 *
 * Only where the model has sortals under it to judge by:
 * `non-sortal-without-sortal-subtype` reports the case with none, and a
 * taxonomy still being written is not this.
 */
export function checkNonSortalSpansKinds(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    if (!isNonSortal(classDeclaration.stereotype)) {
        return;
    }
    const identities = new Set<ClassDeclaration>();
    let sortals = 0;
    // The one anti-pattern here that reads the whole workspace, and it has to:
    // the others look for something present, which a split can only take away,
    // while this looks for a *variety* that is absent. Reading one document
    // reported a category as spanning one kind whenever the subtype under the
    // other kind was written in another file -- more occurrences across a
    // boundary, which is the direction a heuristic must never err in.
    for (const subtype of subtypesOf(lookup, classDeclaration)) {
        if (isSortal(subtype.stereotype)) {
            sortals++;
            for (const ultimate of ultimateSortalAncestors(subtype)) {
                identities.add(ultimate);
            }
        }
    }
    // No identity at all is the taxonomy being written; two or more is what a
    // non-sortal is for.
    if (sortals === 0 || identities.size !== 1) {
        return;
    }
    const [identity] = [...identities];
    accept(
        ANTI_PATTERN_SEVERITY,
        `${classDeclaration.stereotype === 'category' ? 'Category' : 'Non-sortal'} "${classDeclaration.name}" classifies individuals of more than one kind, but everything under it draws identity from "${identity.name}". A "subkind", "role", "phase" or "historicalRole" of "${identity.name}" says that, and supplies the identity a non-sortal cannot.`,
        { node: classDeclaration, property: 'name', code: 'MixIden' }
    );
}

// --- HetColl --------------------------------------------------------------

/**
 * HetColl -- a collective whose members may be of different kinds.
 *
 * A collective is unified by one relation holding among its members -- what
 * makes a deck of cards a deck -- and members drawing identity from different
 * ultimate sortals are not related in that one way: a "collective of Party"
 * is a collection of people and of organizations, and whatever unifies it is
 * not one relation among comparable things.
 *
 * The member type being a non-sortal is what says so, since that is exactly
 * the type that admits instances of several kinds.
 */
export function checkCollectiveMembersShareAKind(relation: Relation, accept: ValidationAcceptor): void {
    if (relation.stereotype !== 'membership') {
        return;
    }
    const { source, target } = endClasses(relation);
    if (!source || !target || !isNonSortal(target.stereotype)) {
        return;
    }
    accept(
        ANTI_PATTERN_SEVERITY,
        `The members of "${source.name}" are typed by "${target.name}", a non-sortal, so they may draw identity from different kinds. A collective is unified by one relation among its members, which comparable things stand in; name the kind they share, or say which kinds may mix.`,
        { node: relation, code: 'HetColl' }
    );
}
