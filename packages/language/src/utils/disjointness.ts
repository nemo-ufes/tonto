import { AstUtils } from 'langium';
import type { ClassDeclaration, GeneralizationSet, Model } from '../generated/ast.js';
import { isClassDeclaration, isGeneralizationSet } from '../generated/ast.js';
import { registerDerivedCacheReset } from './derived-cache.js';
import type { AstNode } from 'langium';
import { collectAncestors, referringGeneralizationSets } from './generalizations.js';
import { possibleNaturesOf } from './nature-reasoning.js';
import { isUltimateSortal } from '../validation/stereotype-model.js';

/**
 * Which classes a `disjoint` generalization set declares cannot share an
 * instance, as a symmetric adjacency index built once per document.
 *
 * Keyed on node identity rather than names, so two same-named classes in
 * different packages are never confused. Holds resolved references, hence the
 * cache reset (see derived-cache.ts).
 *
 * Document-scoped: a disjoint set declared in another file is not seen, which
 * can only miss a contradiction, never invent one.
 */
let disjointCache = new WeakMap<Model, Map<ClassDeclaration, Set<ClassDeclaration>>>();

registerDerivedCacheReset(() => {
    disjointCache = new WeakMap();
});

function disjointIndex(model: Model): Map<ClassDeclaration, Set<ClassDeclaration>> {
    let index = disjointCache.get(model);
    if (index) {
        return index;
    }
    index = new Map();
    const relate = (x: ClassDeclaration, y: ClassDeclaration): void => {
        const partners = index!.get(x);
        if (partners) {
            partners.add(y);
        } else {
            index!.set(x, new Set([y]));
        }
    };
    for (const pkg of model.packages) {
        for (const declaration of pkg.declarations) {
            if (!isGeneralizationSet(declaration) || !declaration.disjoint) {
                continue;
            }
            const specifics = declaration.specifics
                .map(ref => ref.ref)
                .filter((node): node is ClassDeclaration => !!node && isClassDeclaration(node));
            for (let i = 0; i < specifics.length; i++) {
                for (let j = i + 1; j < specifics.length; j++) {
                    // A set that lists the same class twice is a separate
                    // diagnostic; it must not make the class disjoint from
                    // itself here.
                    if (specifics[i] !== specifics[j]) {
                        relate(specifics[i], specifics[j]);
                        relate(specifics[j], specifics[i]);
                    }
                }
            }
        }
    }
    disjointCache.set(model, index);
    return index;
}

/**
 * The classes declared disjoint from this one, wherever the set saying so was
 * written.
 *
 * The document index is where most of them are, and the workspace lookup is
 * what finds the rest: a set may name its specifics from a third file,
 * belonging neither to them nor to the class being asked about, and it says
 * exactly what a local one says. Without this the same model reported
 * `disjoint-supertypes` written in one file and nothing at all written in
 * three.
 */
export function getDisjointPartners(classDeclaration: ClassDeclaration): ReadonlySet<ClassDeclaration> | undefined {
    const model = AstUtils.getDocument(classDeclaration).parseResult.value as Model;
    const local = disjointIndex(model).get(classDeclaration);
    const elsewhere = partnersFromReferringSets(classDeclaration);
    if (elsewhere.size === 0) {
        return local;
    }
    return local ? new Set([...local, ...elsewhere]) : elsewhere;
}

/**
 * Partners named by `disjoint` sets that refer to this class from elsewhere.
 *
 * Reference identity throughout, which is what makes consulting a lookup safe:
 * a set naming a different class of the same name contributes nothing.
 */
function partnersFromReferringSets(classDeclaration: ClassDeclaration): Set<ClassDeclaration> {
    const found = new Set<ClassDeclaration>();
    for (const genset of referringGeneralizationSets(classDeclaration)) {
        if (!genset.disjoint) {
            continue;
        }
        const specifics = genset.specifics.map((ref: GeneralizationSet['specifics'][number]) => ref.ref);
        if (!specifics.includes(classDeclaration)) {
            continue;
        }
        for (const specific of specifics) {
            if (specific && isClassDeclaration(specific) && specific !== classDeclaration) {
                found.add(specific);
            }
        }
    }
    return found;
}

/**
 * Whether two classes can be told apart by something the model already says,
 * rather than by a `disjoint` set naming both.
 *
 * Three things settle it, and a rule that asks for a declaration has to read
 * all three before asking. A disjointness declared anywhere above either of
 * them reaches both, since an instance of a class is an instance of every
 * class above it -- `Man specializes Male` and `Woman specializes Female`
 * share nothing once `Male` and `Female` are declared disjoint. Two different
 * ultimate sortals settle it because ultimate sortals are pairwise disjoint,
 * which is the whole point of identity. And natures with nothing in common
 * settle it because there is no individual of both.
 */
export function cannotShareInstances(a: ClassDeclaration, b: ClassDeclaration): boolean {
    if (a === b) {
        return false;
    }
    // Declared: between the two, or anywhere in the lineages that reach them.
    if (wouldConflictWithLineage(a, b)) {
        return true;
    }
    const identityOf = (node: ClassDeclaration): ClassDeclaration | undefined =>
        [node, ...collectAncestors(node)].find(member => isUltimateSortal(member.stereotype));
    const [first, second] = [identityOf(a), identityOf(b)];
    if (first && second && first !== second) {
        return true;
    }
    const naturesOfA = possibleNaturesOf(a);
    const naturesOfB = possibleNaturesOf(b);
    return !!naturesOfA && !!naturesOfB && naturesOfA.size > 0 && naturesOfB.size > 0
        && ![...naturesOfA].some(nature => naturesOfB.has(nature));
}

export interface DisjointConflict {
    /** The two classes that cannot share an instance. */
    first: ClassDeclaration;
    second: ClassDeclaration;
}

/**
 * Two classes in this class's own lineage that a `disjoint` set declares
 * cannot share an instance -- which makes the class uninstantiable.
 *
 * The lineage includes the class itself, so it also catches a class that
 * specializes a co-specific it is declared disjoint from.
 */
export function findDisjointConflict(classDeclaration: ClassDeclaration): DisjointConflict | undefined {
    const lineage = new Set<ClassDeclaration>([classDeclaration, ...collectAncestors(classDeclaration)]);
    for (const member of lineage) {
        const partners = getDisjointPartners(member);
        if (!partners) {
            continue;
        }
        for (const partner of partners) {
            if (lineage.has(partner)) {
                return { first: member, second: partner };
            }
        }
    }
    return undefined;
}

/**
 * Whether adding `candidate` as a supertype of `subject` would place two
 * disjoint classes in one lineage.
 *
 * Both sides have to be compared as whole lineages, not as single classes: in
 * `CrazyMeeting specializes GoodMeeting, EvenWorseMeeting` neither
 * `GoodMeeting` nor `EvenWorseMeeting` is itself declared disjoint from the
 * other -- the conflict is between `GoodMeeting` and `BadMeeting`, two levels
 * above the candidate.
 */
export function wouldConflictWithLineage(subject: ClassDeclaration, candidate: ClassDeclaration): boolean {
    const subjectLineage = new Set<ClassDeclaration>([subject, ...collectAncestors(subject)]);
    for (const ancestor of [candidate, ...collectAncestors(candidate)]) {
        const partners = getDisjointPartners(ancestor);
        if (!partners) {
            continue;
        }
        for (const partner of partners) {
            if (subjectLineage.has(partner)) {
                return true;
            }
        }
    }
    return false;
}

/** The `disjoint` generalization sets that put both classes among their specifics. */
export function gensetsDeclaringDisjoint(a: ClassDeclaration, b: ClassDeclaration): GeneralizationSet[] {
    const model = AstUtils.getDocument(a).parseResult.value as Model;
    const result: GeneralizationSet[] = [];
    // The set may be in a's document, or in one that merely names it.
    const candidates = new Set<AstNode>([
        ...referringGeneralizationSets(a),
        ...model.packages.flatMap(pkg => pkg.declarations)
    ]);
    for (const declaration of candidates) {
        if (!isGeneralizationSet(declaration) || !declaration.disjoint) {
            continue;
        }
        const specifics = declaration.specifics.map(ref => ref.ref);
        if (specifics.includes(a) && specifics.includes(b)) {
            result.push(declaration);
        }
    }
    return result;
}
