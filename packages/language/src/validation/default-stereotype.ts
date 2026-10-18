import type { ValidationAcceptor } from 'langium';
import type { Cardinality, ClassDeclaration, Relation } from '../generated/ast.js';
import { isClassDeclaration } from '../generated/ast.js';
import { possibleNaturesOf } from '../utils/nature-reasoning.js';
import { getRelationSource, isParthood, wholeEndOf } from '../utils/relations.js';
import { getBounds } from './cardinality-checks.js';
import { stereotypeFitsEnds, stereotypesFitting } from './relation-end-natures.js';

/**
 * The stereotype an unstereotyped relation almost certainly meant.
 *
 * A relation without a stereotype is not wrong -- plain associations are
 * allowed -- but when the natures at its ends leave only one sensible reading,
 * saying so is more useful than staying quiet. `checkStereotypeIsImplied`
 * reports that at hint severity -- the faintest thing an editor draws -- and
 * the code action offers to write it. Neither is an error: a plain association
 * remains valid however clear the reading.
 *
 * The rules are ordered, and the order carries the argument. Parthood comes
 * first because the diamond states it outright, and only then do the natures
 * decide which kind of parthood. After that the specific readings precede the
 * general ones: a situation followed by an event is a `@triggering` before it
 * is a `@presence`, and a relator's `@mediation` yields to an `@instantiation`
 * when the target is a high-order type.
 */

/** The natures an end's instances may have, in tonto's plural vocabulary. */
function naturesOf(end: ClassDeclaration | undefined): ReadonlySet<string> | undefined {
    return end && possibleNaturesOf(end);
}

function only(natures: ReadonlySet<string> | undefined, nature: string): boolean {
    return !!natures && natures.size > 0 && [...natures].every(each => each === nature);
}

function includes(natures: ReadonlySet<string> | undefined, ...wanted: string[]): boolean {
    return !!natures && wanted.some(nature => natures.has(nature));
}

/** An omitted multiplicity already means exactly one, as in UML. */
function bearsExactlyOne(cardinality: Cardinality | undefined): boolean {
    if (!cardinality) {
        return true;
    }
    const bounds = getBounds(cardinality);
    return !!bounds && bounds.lower === 1 && bounds.upper === 1;
}

export function defaultStereotypeFor(relation: Relation): string | undefined {
    // The rules below read one end at a time -- which end is the whole, or
    // whether either end is a relator -- so a rule can name a stereotype the
    // end-nature table then rejects: a functional complex whole with a relator
    // part is no `@componenthood`. A suggestion that errors the moment it is
    // accepted is worse than none, so every candidate goes back through the
    // same table the validator consults.
    const candidate = inferStereotype(relation);
    return candidate && stereotypeFitsEnds(relation, candidate) ? candidate : undefined;
}

function inferStereotype(relation: Relation): string | undefined {
    if (relation.stereotype) {
        return undefined;
    }
    const source = getRelationSource(relation);
    const target = relation.target?.ref;
    if (!isClassDeclaration(source) || !target || !isClassDeclaration(target)) {
        return undefined;
    }
    const from = naturesOf(source);
    const to = naturesOf(target);

    // The diamond says this is parthood, so only which kind is left to decide.
    // Without one, nothing has claimed parthood and an ordinary association
    // between two functional complexes is far more often a material relation.
    if (isParthood(relation)) {
        const wholeIsSource = wholeEndOf(relation) === 'source';
        const whole = wholeIsSource ? from : to;
        const part = wholeIsSource ? to : from;
        if (only(whole, 'events') && only(part, 'events')) {
            return 'structural';
        }
        if (only(whole, 'collectives')) {
            return 'membership';
        }
        if (only(whole, 'functional-complexes')) {
            return 'componenthood';
        }
        if (only(whole, 'quantities')) {
            return 'subQuantity';
        }
        return undefined;
    }

    if (only(to, 'types')) {
        return 'instantiation';
    }
    if (only(from, 'situations') && only(to, 'events')) {
        return 'triggering';
    }
    if (only(from, 'events') && only(to, 'situations')) {
        return 'bringingAbout';
    }
    if (only(from, 'situations')) {
        return 'presence';
    }
    if (only(from, 'events') && only(to, 'events')) {
        return 'structural';
    }
    if (only(from, 'relators') || only(to, 'relators')) {
        return 'mediation';
    }
    // Inherence is to exactly one bearer, so a bearer end that admits any
    // other number is a statement that this is not characterization -- and
    // suggesting it anyway would make `characterization-bearer-multiplicity`
    // fire the moment the suggestion was accepted.
    if (includes(from, 'intrinsic-modes', 'extrinsic-modes', 'qualities')
        && !includes(from, 'functional-complexes', 'collectives', 'quantities', 'events', 'situations', 'types')
        && bearsExactlyOne(relation.targetCardinality)) {
        return 'characterization';
    }
    return undefined;
}

/**
 * Names the stereotype an unstereotyped relation implies, and the others that
 * would also fit.
 *
 * The natures single one out less often than it looks: `event:event` parthood
 * fits `@participational`, `@structural` and `@temporal` equally, so saying
 * "the natures make this an @structural" would be false. The recommendation
 * comes first and the alternatives follow, in the message and in the fixes.
 *
 * Reported at hint severity, which VS Code draws as a faint underline and
 * keeps out of the Problems panel: enough for the lightbulb to be found,
 * little enough that a document full of plain associations stays readable.
 */
export function checkStereotypeIsImplied(relation: Relation, accept: ValidationAcceptor): void {
    const stereotype = defaultStereotypeFor(relation);
    if (!stereotype) {
        return;
    }
    const fitting = [stereotype, ...stereotypesFitting(relation).filter(other => other !== stereotype)];
    const quoted = fitting.map(name => `"@${name}"`);
    const message = quoted.length === 1
        ? `The natures at the ends make this an ${quoted[0]}.`
        : `The natures at the ends fit ${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}.`;
    accept('hint', message, {
        node: relation,
        code: 'implied-relation-stereotype',
        data: { stereotypes: fitting }
    });
}
