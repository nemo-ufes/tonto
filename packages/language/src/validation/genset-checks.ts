import type { ValidationAcceptor } from 'langium';
import type { GeneralizationSet } from '../generated/ast.js';
import { isClassDeclaration } from '../generated/ast.js';
import { canSpecializeByStereotype } from './stereotype-model.js';
import { a } from './wording.js';
import { classifiesTypes } from '../utils/nature-reasoning.js';
import { whyNotSpecialize } from './stereotype-model.js';

export function checkNoDuplicateSpecifics(genset: GeneralizationSet, accept: ValidationAcceptor): void {
    const seenNodes = new Set<unknown>();
    const seenNames = new Set<string>();
    genset.specifics.forEach((ref, index) => {
        // Compare resolved nodes when available so two spellings of the same
        // qualified name still count as one; fall back to the written text
        // when the reference is unresolved.
        const key = ref.ref ?? undefined;
        const duplicate = key ? seenNodes.has(key) : seenNames.has(ref.$refText);
        if (duplicate) {
            accept('warning', `"${ref.$refText}" is listed more than once in generalization set "${genset.name}".`, {
                node: genset,
                property: 'specifics',
                index,
                code: 'duplicate-specific'
            });
        } else if (key) {
            seenNodes.add(key);
        } else {
            seenNames.add(ref.$refText);
        }
    });
}

/**
 * A generalization set's categorizer is the higher-order type whose
 * instances are the specific classes, so it must be a `type`/`powertype`.
 *
 * A relation is never one. The grammar resolves `categorizer` among classes
 * and relations alike, because it shares the reference type with `general`
 * and `specifics`, where a set of relations needs relations -- so the refusal
 * is here, with its own code: the repair `categorizer-not-higher-order`
 * offers, making the class classify types, has nothing to act on in a
 * relation.
 *
 * Nor does a set of relations have one. A categorizer's instances are the
 * set's specific types, which here are relations, and no class of types has
 * relations for instances: `leases` is not a type in the sense `Tenure` would
 * classify, and the model would say that a relation instantiates a class.
 * gUFO agrees -- its categorization pattern relates classes by
 * `rdfs:subClassOf`, which two relations never are -- so the refusal is here
 * rather than a silent gap in the export.
 */
export function checkCategorizerIsHigherOrder(genset: GeneralizationSet, accept: ValidationAcceptor): void {
    genset.categorizers.forEach((ref, index) => {
        const categorizer = ref.ref;
        if (!categorizer) {
            return;
        }
        if (!isClassDeclaration(categorizer)) {
            accept('error', `"${ref.$refText}" is a relation, and a generalization set's categorizer is a high-order type whose instances are the specifics. A relation has no such instances.`, {
                node: genset,
                property: 'categorizers',
                index,
                code: 'categorizer-is-relation'
            });
            return;
        }
        const general = genset.general?.ref;
        if (general && !isClassDeclaration(general)) {
            accept('error', `"${categorizer.name}" cannot categorize "${genset.name}": a categorizer's instances are the set's specific types, and this set's specifics are relations, which no class of types has as instances.`, {
                node: genset,
                property: 'categorizers',
                index,
                code: 'categorizer-on-relation-set'
            });
            return;
        }
        if (!classifiesTypes(categorizer)) {
            accept('error', `A generalization set categorizer must classify types -- a "type", or any class restricted to "of types" -- but "${categorizer.name}" does not.`, {
                node: genset,
                property: 'categorizers',
                index,
                code: 'categorizer-not-higher-order'
            });
        }
    });
}

/**
 * A `disjoint complete` set over a single specific asserts that the general
 * and the specific have exactly the same instances, which is rarely intended
 * and is better expressed by removing one of the two classes.
 */
export function checkPartitionHasSeveralSpecifics(genset: GeneralizationSet, accept: ValidationAcceptor): void {
    if (genset.disjoint && genset.complete && genset.specifics.length === 1) {
        accept(
            'warning',
            `Partition "${genset.name}" has a single specific, which makes "${genset.specifics[0].$refText}" equivalent to "${genset.general?.$refText ?? '?'}".`,
            { node: genset, property: 'specifics', index: 0, code: 'partition-single-specific' }
        );
    }
}

export function checkGeneralizationSetConsistentKind(genset: GeneralizationSet, accept: ValidationAcceptor): void {
    const general = genset.general.ref;
    if (!general) {
        return;
    }
    const generalIsClass = isClassDeclaration(general);
    genset.specifics.forEach((ref, index) => {
        const specific = ref.ref;
        if (specific && isClassDeclaration(specific) !== generalIsClass) {
            accept('error', `Generalization set "${genset.name}" mixes classes and relations: "${general.name}" and "${specific.name}" are not the same kind of element.`, {
                node: genset,
                property: 'specifics',
                index,
                // Its own code: this and self-generalization shared one, so
                // suppressing either suppressed both and `--fix=` could not
                // ask for one of them.
                code: 'genset-mixes-classes-and-relations'
            });
        }
    });
}

export function checkGeneralizationSetNoSelfGeneralization(genset: GeneralizationSet, accept: ValidationAcceptor): void {
    const general = genset.general.ref;
    if (!general) {
        return;
    }
    genset.specifics.forEach((ref, index) => {
        if (ref.ref === general) {
            accept('error', `"${general.name}" is both the general and a specific of generalization set "${genset.name}", so it would have to specialize itself.`, {
                node: genset,
                property: 'specifics',
                index,
                code: 'genset-self-generalization'
            });
        }
    });
}

/**
 * A generalization set declares generalizations, so its specifics must be
 * able to specialize its general -- the same table the `specializes` clause
 * is checked against.
 */
export function checkGeneralizationSetSortalityAndRigidity(genset: GeneralizationSet, accept: ValidationAcceptor): void {
    const general = genset.general?.ref;
    if (!general || !isClassDeclaration(general)) {
        return;
    }
    genset.specifics.forEach((ref, index) => {
        const specific = ref.ref;
        if (!specific || !isClassDeclaration(specific)) {
            return;
        }
        if (!canSpecializeByStereotype(specific.stereotype, general.stereotype)) {
            accept(
                'error',
                `"${specific.name}" cannot specialize "${general.name}" through generalization set "${genset.name}"`
                    + (whyNotSpecialize(specific.stereotype, general.stereotype)
                        ? `: ${whyNotSpecialize(specific.stereotype, general.stereotype)}.`
                        : `: ${a(specific.stereotype)} cannot specialize ${a(general.stereotype)}.`),
                { node: genset, property: 'specifics', index, code: 'genset-stereotype-cannot-specialize' }
            );
        }
    });
}
