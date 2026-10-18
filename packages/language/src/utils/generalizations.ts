import { AstUtils } from 'langium';
import type { ClassDeclaration, GeneralizationSet, Model } from '../generated/ast.js';
import { isClassDeclaration, isGeneralizationSet } from '../generated/ast.js';
import { registerDerivedCacheReset } from './derived-cache.js';

/**
 * Derived views of the generalization graph, memoized per AST node.
 *
 * These are hot: the anti-pattern checks compare every relation against every
 * other, and each comparison walks ancestries. Recomputing from scratch made
 * validation quadratic in document size (7s for 200 classes).
 *
 * They hold *resolved references*, so they are dropped on every document
 * update rather than relying on AST identity -- see `derived-cache.ts` for
 * why keying on nodes alone is not enough.
 */
let generalizationSetCache = new WeakMap<Model, GeneralizationSet[]>();
let directGeneralizationCache = new WeakMap<ClassDeclaration, ClassDeclaration[]>();
let ancestorCache = new WeakMap<ClassDeclaration, Set<ClassDeclaration>>();

registerDerivedCacheReset(() => {
    generalizationSetCache = new WeakMap();
    directGeneralizationCache = new WeakMap();
    ancestorCache = new WeakMap();
});

/**
 * Finds the generalization sets elsewhere in the workspace that name a class.
 *
 * Ancestry is a pure walk over resolved references and has no services to ask,
 * but a generalization set in *another* document introduces an edge all the
 * same. The lookup over the workspace index is therefore attached to each
 * document as it is validated, and read back from the document here.
 *
 * It was a module-level variable once, installed at services creation, and
 * that was a bug with a long reach: a second `TontoSession` replaced the
 * first's lookup, so every session but the last silently stopped seeing
 * cross-document generalizations -- no error, no diagnostic, just a check
 * that had quietly stopped checking. A document belongs to exactly one set of
 * services, so the document is where the lookup belongs.
 *
 * Without one -- a document built without validation, say -- ancestry falls
 * back to the document's own sets, which is where it was before.
 */
export type GeneralizationSetLookup = (node: ClassDeclaration) => GeneralizationSet[];

const LOOKUP = Symbol('tonto.generalizationSetLookup');

interface WithLookup {
    [LOOKUP]?: GeneralizationSetLookup;
}

/** Attaches this services' lookup to a document, for the checks that follow. */
export function bindGeneralizationSetLookup(document: object, lookup: GeneralizationSetLookup): void {
    (document as WithLookup)[LOOKUP] = lookup;
}

function lookupFor(node: ClassDeclaration): GeneralizationSetLookup | undefined {
    return (AstUtils.getDocument(node) as unknown as WithLookup)[LOOKUP];
}

/**
 * The generalization sets elsewhere in the workspace that name this class.
 *
 * Disjointness asks the same question ancestry does -- a set in a third
 * document says what a local one says -- so both read the one lookup.
 */
export function referringGeneralizationSets(node: ClassDeclaration): GeneralizationSet[] {
    return lookupFor(node)?.(node) ?? [];
}

/** All generalization sets declared in a node's own document. */
function documentGeneralizationSets(node: ClassDeclaration): GeneralizationSet[] {
    const model = AstUtils.getDocument(node).parseResult.value as Model;
    let sets = generalizationSetCache.get(model);
    if (!sets) {
        sets = [];
        for (const pkg of model.packages) {
            for (const declaration of pkg.declarations) {
                if (isGeneralizationSet(declaration)) {
                    sets.push(declaration);
                }
            }
        }
        generalizationSetCache.set(model, sets);
    }
    return sets;
}

/**
 * The classes a class directly specializes: both its own `specializes`
 * clause and any generalization set that lists it among the `specifics`.
 *
 * tonto lets a generalization set *declare* a generalization
 * (`genset G where A, B specializes C`) without `A`/`B` repeating a
 * `specializes C` clause, so a check that only walked `specializes` would
 * miss those edges entirely.
 */
export function getDirectGeneralizations(classDeclaration: ClassDeclaration): ClassDeclaration[] {
    const cached = directGeneralizationCache.get(classDeclaration);
    if (cached) {
        return cached;
    }
    const parents: ClassDeclaration[] = [];
    for (const ref of classDeclaration.specializes) {
        if (ref.ref) {
            parents.push(ref.ref);
        }
    }
    const gensets = new Set([
        ...documentGeneralizationSets(classDeclaration),
        ...(lookupFor(classDeclaration)?.(classDeclaration) ?? [])
    ]);
    for (const genset of gensets) {
        const general = genset.general?.ref;
        if (!general || !isClassDeclaration(general)) {
            continue;
        }
        // Reference identity, not name: this is what makes the lookup safe to
        // consult, since a set naming a *different* class of the same name
        // resolves to a different node.
        if (genset.specifics.some(specific => specific.ref === classDeclaration)) {
            parents.push(general);
        }
    }
    directGeneralizationCache.set(classDeclaration, parents);
    return parents;
}

/**
 * Every class reachable by following generalizations upwards, via both
 * `specializes` clauses and generalization sets. Cycle-safe: a generalization
 * cycle yields a finite set that happens to contain the starting class.
 */
export function collectAncestors(classDeclaration: ClassDeclaration): Set<ClassDeclaration> {
    const cached = ancestorCache.get(classDeclaration);
    if (cached) {
        return cached;
    }
    const ancestors = new Set<ClassDeclaration>();
    const pending = [...getDirectGeneralizations(classDeclaration)];
    while (pending.length > 0) {
        const parent = pending.pop()!;
        if (ancestors.has(parent)) {
            continue;
        }
        ancestors.add(parent);
        pending.push(...getDirectGeneralizations(parent));
    }
    ancestorCache.set(classDeclaration, ancestors);
    return ancestors;
}

/** Whether `sub` is `sup`, or specializes it transitively. */
export function isSameOrSpecializes(sub: ClassDeclaration, sup: ClassDeclaration): boolean {
    return sub === sup || collectAncestors(sub).has(sup);
}
