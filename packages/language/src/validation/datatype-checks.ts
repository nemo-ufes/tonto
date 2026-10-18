import type { ValidationAcceptor } from 'langium';
import type { Attribute, Datatype, Enumeration } from '../generated/ast.js';
import { isClassDeclaration, isDatatype } from '../generated/ast.js';
import { classifiesOnly } from '../utils/nature-reasoning.js';
import { getBounds } from './cardinality-checks.js';

type DatatypeLike = Datatype | Enumeration;

export function checkDatatypeNatureRestriction(datatype: DatatypeLike, accept: ValidationAcceptor): void {
    const invalid = datatype.natures.filter(n => n !== 'abstract-individuals');
    if (invalid.length > 0) {
        accept('error', `A datatype classifies abstract individuals, so its "of" clause cannot say ${invalid.join(', ')}.`, {
            node: datatype,
            property: 'natures',
            code: 'datatype-nature-not-abstract'
        });
    }
}

/** An enumeration with no literals has no instances and cannot be used. */
export function checkEnumerationHasLiterals(enumeration: Enumeration, accept: ValidationAcceptor): void {
    if (enumeration.literals.length === 0) {
        accept('warning', `Enumeration "${enumeration.name}" declares no literals, so it has no possible values.`, {
            node: enumeration,
            property: 'name',
            code: 'enum-without-literals'
        });
    }
}

/**
 * A datatype whose attributes lead back to itself describes an
 * infinitely-nested value, which can never be instantiated. Reported on the
 * datatype that closes the cycle.
 *
 * Only through attributes that must be there. `datatype Node { next: Node
 * [0..1] }` is a linked list and `{ children: Node [0..*] }` is a tree: both
 * are finite, because the recursion stops wherever the optional part is left
 * out, and following every attribute regardless of its multiplicity rejected
 * the two commonest recursive shapes there are. A derived attribute is
 * computed rather than held, so it nests nothing either.
 */
export function checkNoDatatypeAttributeCycle(datatype: Datatype, accept: ValidationAcceptor): void {
    const path = findAttributeCycle(datatype, datatype, new Set());
    if (path) {
        accept('error', `Datatype "${datatype.name}" contains itself through ${path.length === 1 ? `its attribute "${path[0]}"` : `"${path.join('", then "')}"`}.`, {
            node: datatype,
            property: 'name',
            code: 'datatype-attribute-cycle'
        });
    }
}

/** Whether a value of the datatype always holds one of these. */
function mustBeThere(attribute: Attribute): boolean {
    if (attribute.isDerived) {
        return false;
    }
    const bounds = attribute.cardinality ? getBounds(attribute.cardinality) : { lower: 1, upper: 1 };
    return !bounds || bounds.lower >= 1;
}

function findAttributeCycle(current: Datatype, start: Datatype, visited: Set<Datatype>): string[] | undefined {
    if (visited.has(current)) {
        return undefined;
    }
    visited.add(current);
    for (const attribute of current.attributes) {
        const type = attribute.type?.ref;
        if (!type || !isDatatype(type) || !mustBeThere(attribute)) {
            continue;
        }
        if (type === start) {
            return [attribute.name];
        }
        const rest = findAttributeCycle(type, start, visited);
        if (rest) {
            return [attribute.name, ...rest];
        }
    }
    return undefined;
}

export function checkDatatypeSpecializationTarget(datatype: DatatypeLike, accept: ValidationAcceptor): void {
    datatype.specializes.forEach((ref, index) => {
        const target = ref.ref;
        if (!target) {
            return;
        }
        // Asked of the natures, not the stereotype: `abstractum` is the
        // stereotype for abstract individuals, and a `class of
        // abstract-individuals` or a `category` restricted to them classifies
        // the same things.
        if (isClassDeclaration(target) && !classifiesOnly(target, 'abstract-individuals')) {
            accept(
                'error',
                `"${datatype.name}" can only specialize a class whose instances are abstract individuals -- an "abstractum", or a class restricted to "abstract-individuals" -- not "${target.name}".`,
                { node: datatype, property: 'specializes', code: 'datatype-specializes-non-abstract', index }
            );
        }
    });
}
