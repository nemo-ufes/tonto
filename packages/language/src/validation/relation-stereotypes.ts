/**
 * The association stereotype vocabulary.
 *
 * The grammar cannot carry this as a type: `RelationStereotype` ends with
 * `ID | STRING`, so any word parses after `@`. That permissiveness is worth
 * keeping -- a stereotype tonto dropped or renamed is far better
 * reported with an explanation than as a parse error -- but it means the AST
 * property is a bare `string` and nothing but a check stands between a typo
 * and silence.
 *
 * `test/grammar.test.ts` asserts this list still matches the grammar rule, so
 * adding a stereotype to one without the other fails the build.
 */
export const RELATION_STEREOTYPES = [
    // Endurants
    'material', 'characterization', 'mediation', 'externalDependence', 'comparative',
    'componenthood', 'membership', 'subCollection', 'subQuantity', 'constitution',
    // Events. `change` sits between the two ends of an endurant's life,
    // which `creation` and `termination` state.
    'historicalDependence', 'participation', 'creation', 'change', 'termination', 'manifestation',
    'structural', 'temporal', 'participational',
    // Situations
    'triggering', 'bringingAbout', 'presence',
    // Multi-level
    'instantiation'
] as const;

export type RelationStereotype = typeof RELATION_STEREOTYPES[number];

const KNOWN = new Set<string>(RELATION_STEREOTYPES);

export function isRelationStereotype(name: string): name is RelationStereotype {
    return KNOWN.has(name);
}

/**
 * Whether an association keeps its stereotype when named in the opposite
 * direction.
 *
 * This is semantic, not a question of whether the reversed endpoint natures
 * happen to fit. Material and comparative classify the relationship itself,
 * so their converses remain material or comparative and retain the same
 * derivation. Parthood is likewise the same fact because the diamond moves
 * with the inverse and continues to identify the whole. Every other
 * stereotype fixes roles to source and target -- inhering aspect to bearer,
 * participant to event, trigger to what it triggers, and so on -- and its
 * converse is therefore a plain association.
 */
const INVERSE_PRESERVING = new Set<RelationStereotype>([
    'material', 'comparative',
    'componenthood', 'membership', 'subCollection', 'subQuantity',
    'structural', 'temporal', 'participational'
]);

export function inverseKeepsStereotype(stereotype: string | undefined): boolean {
    return !!stereotype && isRelationStereotype(stereotype) && INVERSE_PRESERVING.has(stereotype);
}

/**
 * Stereotypes tonto renamed -- nouns for parthood, gerunds for
 * causation.
 *
 * Only the newer spelling is accepted. The older one still *parses*, since any
 * word may follow `@`, and is answered with the rename rather than a guess: no
 * edit distance would connect `memberOf` to `membership`, and a model written
 * before the rename deserves to be told what happened rather than left to
 * infer it from a near-miss.
 */
export const RENAMED_STEREOTYPES: Readonly<Record<string, string>> = {
    componentOf: 'componenthood',
    memberOf: 'membership',
    subCollectionOf: 'subCollection',
    subQuantityOf: 'subQuantity',
    triggers: 'triggering',
    bringsAbout: 'bringingAbout'
};

/**
 * Stereotypes tonto has no counterpart for, with what it does instead.
 *
 * None of these were wrong; they named things tonto expresses another
 * way, and a model using one needs to know which way rather than simply that
 * the word is unknown.
 */
export const RETIRED_STEREOTYPES: Readonly<Record<string, string>> = {
    derivation: 'a derivation is said on the derived relation itself: "derivedFrom" after a "@material" relation names the relator or extrinsic mode it is read off, and after a "@comparative" one the qualities or intrinsic modes it compares',
    formal: 'tonto keeps "@comparative" for comparative relations and leaves other formal relations as plain associations',
    inherence: 'inherence is what "@characterization" and "@mediation" mean, not a stereotype of its own',
    value: 'tonto handles values through datatypes and attributes',
    composition: 'UML already carries composition on the association end, so use a parthood stereotype with the "<>--" diamond',
    aggregation: 'UML already carries aggregation on the association end, so use a parthood stereotype with the "<>--" diamond'
};

/** Edit distance, capped: only near-misses are worth suggesting. */
export function distance(a: string, b: string): number {
    const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let diagonal = previous[0];
        previous[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const carried = previous[j];
            previous[j] = Math.min(
                previous[j] + 1,
                previous[j - 1] + 1,
                diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
            diagonal = carried;
        }
    }
    return previous[b.length];
}

export interface StereotypeAdvice {
    /** The stereotype to use instead, when there is one. */
    replacement?: string;
    /** Why, when the answer is not simply a misspelling. */
    because?: string;
}

/**
 * What to tell someone who wrote a stereotype tonto does not define:
 * the rename, the retirement, or the nearest spelling.
 */
export function adviseOnStereotype(written: string): StereotypeAdvice {
    const renamed = RENAMED_STEREOTYPES[written];
    if (renamed) {
        return { replacement: renamed, because: 'it was renamed in tonto' };
    }
    const retired = RETIRED_STEREOTYPES[written];
    if (retired) {
        return { because: retired };
    }
    const exact = RELATION_STEREOTYPES.find(name => name.toLowerCase() === written.toLowerCase());
    if (exact) {
        return { replacement: exact };
    }
    let best: string | undefined;
    let bestDistance = Math.min(3, Math.ceil(written.length / 2));
    for (const name of RELATION_STEREOTYPES) {
        const d = distance(written.toLowerCase(), name.toLowerCase());
        if (d <= bestDistance) {
            best = name;
            bestDistance = d;
        }
    }
    return { replacement: best };
}
