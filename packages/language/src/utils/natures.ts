import type { ClassDeclaration } from '../generated/ast.js';
import { getDirectGeneralizations } from './generalizations.js';
import { possibleNaturesOf } from './nature-reasoning.js';
import { allowedNaturesFor, expandNatures, isUltimateSortal } from '../validation/stereotype-model.js';

export type NatureOrigin = 'declared' | 'inherited' | 'implied';

export interface EffectiveNatures {
    natures: readonly string[];
    origin: NatureOrigin;
    /** The ancestor the restriction came from, when inherited. */
    from?: ClassDeclaration;
}

/**
 * The ontological natures a class's instances can actually have.
 *
 * Only a minority of classes state `of ...` explicitly; for the rest the
 * restriction is either inherited from the nearest ancestor that does state
 * one, or implied by the identity principle of the ultimate sortal the class
 * specializes (a `kind` yields functional complexes, a `collective` yields
 * collectives, and so on). Reporting only the declared natures would
 * therefore say nothing about most classes in a model.
 */
export function getEffectiveNatures(classDeclaration: ClassDeclaration): EffectiveNatures | undefined {
    if (classDeclaration.natures.length > 0) {
        return { natures: classDeclaration.natures, origin: 'declared' };
    }

    const ownImplied = impliedNatures(classDeclaration);
    if (ownImplied) {
        return { natures: ownImplied, origin: 'implied' };
    }

    // Breadth-first so the *nearest* ancestor wins, which is the one whose
    // restriction is most specific.
    for (const ancestor of ancestorsNearestFirst(classDeclaration)) {
        const stated = ancestor.natures.length > 0 ? ancestor.natures : impliedNatures(ancestor);
        if (!stated) {
            continue;
        }
        // Nearest is not the same as narrowest: two ancestors on separate
        // branches both bind, and their intersection may be smaller than
        // either. Reported as the atoms it comes to, and credited to nobody
        // in particular, since no one ancestor says it -- a card claiming
        // "objects (inherited from Wide)" where the checks had already
        // narrowed to functional-complexes disagreed with the diagnostics
        // about the same class.
        const narrowed = possibleNaturesOf(classDeclaration);
        const wider = expandNatures(stated);
        if (narrowed && narrowed.size > 0 && narrowed.size < wider.size) {
            return { natures: [...narrowed], origin: 'inherited' };
        }
        return { natures: stated, origin: 'inherited', from: ancestor };
    }
    return undefined;
}

/** The natures an ultimate sortal confers by virtue of its stereotype alone. */
function impliedNatures(classDeclaration: ClassDeclaration): readonly string[] | undefined {
    if (!isUltimateSortal(classDeclaration.stereotype)) {
        return undefined;
    }
    const allowed = allowedNaturesFor(classDeclaration.stereotype);
    return allowed && allowed.length > 0 ? allowed : undefined;
}

function* ancestorsNearestFirst(classDeclaration: ClassDeclaration): Generator<ClassDeclaration> {
    const seen = new Set<ClassDeclaration>([classDeclaration]);
    let frontier = getDirectGeneralizations(classDeclaration);
    while (frontier.length > 0) {
        const next: ClassDeclaration[] = [];
        for (const ancestor of frontier) {
            if (seen.has(ancestor)) {
                continue;
            }
            seen.add(ancestor);
            yield ancestor;
            next.push(...getDirectGeneralizations(ancestor));
        }
        frontier = next;
    }
}

export function describeNatures(effective: EffectiveNatures): string {
    const list = effective.natures.join(', ');
    switch (effective.origin) {
        case 'declared':
            return list;
        case 'inherited':
            return `${list} (inherited from \`${effective.from?.name ?? '?'}\`)`;
        case 'implied':
            return `${list} (implied by the stereotype)`;
    }
}

/**
 * The natures a class's instances can have, as atomic natures, falling back
 * to whatever its stereotype permits when nothing is declared or inherited.
 *
 * `getEffectiveNatures` deliberately infers only for ultimate sortals, since
 * that is the one case where the stereotype *fixes* the nature. For checking
 * an end against a table of admissible natures that is too timid: an `event`
 * declares no `of` clause yet its instances are plainly events, and without
 * this the check would simply not run. A stereotype that permits everything
 * -- plain `class` -- still yields `undefined`, so nothing is assumed of it.
 */
export function getAssumedNatures(classDeclaration: ClassDeclaration): ReadonlySet<string> | undefined {
    // Everything above at once, not the nearest restriction alone. Two
    // ancestors that each narrow differently both bind, and taking whichever
    // was reached first made the answer depend on the order the supertypes
    // were written: `category X specializes Wide, Narrow` was checked as
    // `Wide`, so an end only `Narrow` forbids went unreported -- and swapping
    // the two words reported it. `possibleNaturesOf` folds the intersection,
    // stereotype and `of` clause included, and returns nothing only when
    // nothing anywhere restricts.
    const narrowed = possibleNaturesOf(classDeclaration);
    if (narrowed) {
        return narrowed;
    }
    const allowed = allowedNaturesFor(classDeclaration.stereotype);
    return allowed && allowed.length > 0 ? expandNatures(allowed) : undefined;
}
