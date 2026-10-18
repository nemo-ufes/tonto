import type { ValidationAcceptor } from 'langium';
import type { Attribute, Cardinality } from '../generated/ast.js';

const UNBOUNDED = '*';

export interface Bounds {
    lower: number;
    /** `Infinity` for `*`. */
    upper: number;
}

/**
 * Numeric bounds for a cardinality, or `undefined` if it is malformed
 * (in which case `checkCardinalityBounds` has already reported it, and
 * callers should skip any comparison rather than compare garbage).
 */
export function getBounds(cardinality: Cardinality): Bounds | undefined {
    const lower = cardinality.lowerBound;
    const upper = cardinality.upperBound;

    if (lower === UNBOUNDED) {
        // `[*]` is shorthand for `[0..*]`. `[*..n]` is meaningless.
        return upper === undefined ? { lower: 0, upper: Infinity } : undefined;
    }
    const lowerNumber = Number(lower);
    if (!Number.isFinite(lowerNumber)) {
        return undefined;
    }
    if (upper === undefined) {
        // `[n]` means exactly n.
        return { lower: lowerNumber, upper: lowerNumber };
    }
    if (upper === UNBOUNDED) {
        return { lower: lowerNumber, upper: Infinity };
    }
    const upperNumber = Number(upper);
    return Number.isFinite(upperNumber) ? { lower: lowerNumber, upper: upperNumber } : undefined;
}

export function formatBounds(cardinality: Cardinality): string {
    return cardinality.upperBound === undefined
        ? `[${cardinality.lowerBound}]`
        : `[${cardinality.lowerBound}..${cardinality.upperBound}]`;
}

export function checkCardinalityBounds(cardinality: Cardinality, accept: ValidationAcceptor): void {
    if (cardinality.lowerBound === UNBOUNDED && cardinality.upperBound !== undefined) {
        accept('error', '"*" cannot be used as a lower bound; write "[0..*]" or "[*]".', {
            node: cardinality,
            property: 'lowerBound',
            code: 'multiplicity-star-lower'
        });
        return;
    }

    const bounds = getBounds(cardinality);
    if (!bounds) {
        return;
    }
    if (bounds.lower > bounds.upper) {
        accept('error', `Lower bound ${bounds.lower} is greater than upper bound ${bounds.upper}.`, { node: cardinality, code: 'multiplicity-inverted' });
        return;
    }
    if (bounds.upper === 0) {
        accept('error', 'An upper bound of 0 makes this impossible to instantiate.', { node: cardinality, code: 'multiplicity-zero-upper' });
    }
}

/**
 * `addOnly` says the values of this attribute only accumulate: they may be
 * added and never removed or replaced. Beside `const` it cannot be written at
 * all -- the two are alternatives in the grammar, since `const` says the whole
 * of what `addOnly` says and more.
 *
 * It says nothing where there is nothing to add, which is an attribute holding
 * a fixed number of values -- `[1]`, `[2]`, or nothing written, which means
 * one. `const` is what fixes those. An *optional* one is not among them:
 * `[0..1] addOnly` says the value may be filled in once and never changed
 * after, which is a different thing from `const`, and reading the upper
 * bound alone called it meaningless -- while
 * `accumulating-end-not-add-only` was asking for it on exactly that end.
 */
export function checkAddOnlyAttribute(attribute: Attribute, accept: ValidationAcceptor): void {
    if (!attribute.isAddOnly) {
        return;
    }
    const bounds = attribute.cardinality ? getBounds(attribute.cardinality) : { lower: 1, upper: 1 };
    if (bounds && bounds.lower === bounds.upper) {
        accept('warning', '"addOnly" has nothing to add to: this attribute always holds the same number of values. "const" is what fixes them.', {
            node: attribute, property: 'isAddOnly', code: 'add-only-with-nothing-to-add'
        });
    }
}

/** `ordered` says nothing about an attribute that holds at most one value. */
export function checkOrderedOnSingleValuedAttribute(attribute: Attribute, accept: ValidationAcceptor): void {
    if (!attribute.isOrdered) {
        return;
    }
    const bounds = attribute.cardinality ? getBounds(attribute.cardinality) : { lower: 1, upper: 1 };
    if (bounds && bounds.upper <= 1) {
        accept('warning', '"ordered" has no effect on an attribute that holds at most one value.', {
            node: attribute,
            property: 'isOrdered',
            code: 'ordered-single-valued'
        });
    }
}
