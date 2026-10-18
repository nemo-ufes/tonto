import type { ValidationAcceptor } from 'langium';
import type { Attribute, Classifier } from '../generated/ast.js';
import { isClassDeclaration, isDatatype, isEnumeration } from '../generated/ast.js';
import { classifiesOnly, possibleNaturesOf } from '../utils/nature-reasoning.js';
import { instancesCanChange } from './stereotype-model.js';
import { hasImmutableInstances } from './relation-nature-checks.js';

/**
 * Whether an instance of this nature may still be going on, and so may have no
 * end point yet: an endurant that exists, a process unfolding, a situation
 * obtaining. An event has finished, and an abstract individual was never in
 * time to begin with.
 */
function mayStillBeUnfolding(nature: string): boolean {
    return instancesCanChange(nature) || nature === 'situations';
}
import { getBounds } from './cardinality-checks.js';
import { capitalize } from './wording.js';
import { distance } from './relation-stereotypes.js';

/**
 * The two attribute stereotypes: the instant a concrete
 * individual begins to exist and the instant it ceases to.
 *
 * Nothing here asks for them. An ontology that never mentions when its
 * individuals begin or end is complete as it stands -- these rules say what
 * such an attribute must look like *once written*, and say nothing at all
 * about a class that does not write one.
 */
export const TIME_POINT_STEREOTYPES = ['begin', 'end'] as const;

// A begin or end point is typed by a datatype.
// Nothing checks that here because nothing can violate it: `AttributeType` is
// `Datatype | Enumeration`, so a class-typed attribute does not parse.

function isTimePoint(stereotype: string): boolean {
    return (TIME_POINT_STEREOTYPES as readonly string[]).includes(stereotype);
}

/** The distinct stereotypes on this attribute that the language defines. */
function timePoints(attribute: Attribute): string[] {
    return [...new Set(attribute.stereotypes)].filter(isTimePoint);
}

/**
 * A word after `@` that is not an attribute stereotype.
 *
 * The grammar takes any identifier there for the same reason the relation
 * grammar does: a slip should be answered by name, with a suggestion, rather
 * than by a parse error that says nothing about what was meant. Without this
 * the other rules here would quietly skip the attribute -- `@bgin` would look
 * stereotyped and be treated as plain.
 */
export function checkAttributeStereotypeIsKnown(attribute: Attribute, accept: ValidationAcceptor): void {
    attribute.stereotypes.forEach((stereotype, index) => {
        if (isTimePoint(stereotype)) {
            return;
        }
        const closest = TIME_POINT_STEREOTYPES
            .map(known => ({ known, d: distance(stereotype.toLowerCase(), known) }))
            // Two edits on a five-letter word is already most of it: past
            // that, a suggestion is a guess, and no suggestion is the honest
            // answer.
            .filter(({ d }) => d <= 2)
            .sort((a, b) => a.d - b.d)[0]?.known;
        accept('error',
            `"@${stereotype}" is not an attribute stereotype; the only ones are "@begin" and "@end".${closest ? ` Use "@${closest}".` : ''}`,
            {
                node: attribute,
                property: 'stereotypes',
                index,
                code: 'unknown-attribute-stereotype',
                ...(closest ? { data: { closest } } : {})
            });
    });
}

/** `@begin @begin t: Date` says one thing twice. */
export function checkNoDuplicateAttributeStereotype(attribute: Attribute, accept: ValidationAcceptor): void {
    const seen = new Set<string>();
    attribute.stereotypes.forEach((stereotype, index) => {
        if (seen.has(stereotype)) {
            accept('error', `"@${stereotype}" is already on this attribute.`, {
                node: attribute,
                property: 'stereotypes',
                index,
                code: 'duplicate-attribute-stereotype'
            });
        }
        seen.add(stereotype);
    });
}

/**
 * Only something in time begins and ends.
 *
 * They are restricted to concrete individuals, and concrete
 * individuals are everything but the abstract ones: endurants (`types`
 * included -- a high-order type is an endurant, and one may be introduced and
 * later abandoned like anything else), events and situations. So the rule is
 * asked in the negative, and only fires where it is certain: a class whose
 * every instance is an abstract individual, or a datatype, which describes
 * values, and a value is not somewhere in time -- 3 does not begin.
 *
 * A class that restricts nothing is left alone. It may well classify things
 * with lifetimes, and demanding an `of` clause first would make ordinary
 * models ill-formed.
 */
export function checkTimePointOwnerIsConcrete(attribute: Attribute, accept: ValidationAcceptor): void {
    const stereotypes = timePoints(attribute);
    if (stereotypes.length === 0) {
        return;
    }
    const owner = attribute.$container;
    let what: string;
    if (!isClassDeclaration(owner)) {
        what = `"${owner.name}" is a datatype, so its instances are values`;
    } else {
        const natures = possibleNaturesOf(owner);
        if (!natures || natures.size === 0 || [...natures].some(nature => nature !== 'abstract-individuals')) {
            return;
        }
        what = `every instance of "${owner.name}" is an abstract individual`;
    }
    for (const stereotype of stereotypes) {
        accept('error',
            `${capitalize(what)}, and nothing outside time begins or ends, so there is no instant for "@${stereotype}" to name.`,
            { node: attribute, property: 'stereotypes', code: 'time-point-on-atemporal-owner' });
    }
}

/**
 * When something began is settled by its beginning.
 *
 * The same holds of `@end` once it is acquired, for the same reason,
 * and it is the reason every other immutability rule here rests on: a fact
 * about the past does not stop having been the case.
 *
 * A warning, not an error: the model is not contradictory, it has left unsaid
 * something its own semantics already settle.
 */
export function checkTimePointIsConst(attribute: Attribute, accept: ValidationAcceptor): void {
    const stereotypes = timePoints(attribute);
    if (stereotypes.length === 0 || attribute.isConst) {
        return;
    }
    const which = stereotypes.map(s => `"@${s}"`).join(' and ');
    accept('warning',
        `${which} names an instant that has already passed once it is known, so it cannot change. Mark it "const".`,
        { node: attribute, property: 'name', code: 'time-point-not-const' });
}

/**
 * Whether nothing about an instance of this owner changes, so that every
 * attribute it declares is immutable whether or not it says so.
 *
 * An event is over, a situation is fact-like, and an abstract individual was
 * never in time. A datatype or an enumeration classifies values, which are
 * abstract individuals too: a value with a different street is a different
 * address, not the same one changed.
 *
 * About attributes only. An association end owned by a value is not a part of
 * the value -- the end at `Color` of `Apple -- color -- Color` lists the
 * apples that are red, and which apples those are changes.
 */
export function ownsOnlyImmutableAttributes(owner: Classifier): boolean {
    return isDatatype(owner) || isEnumeration(owner)
        || (isClassDeclaration(owner) && hasImmutableInstances(owner));
}

/**
 * Everything about an event, a situation or a value is settled, so its
 * properties are too.
 *
 * An event is over, and a situation, insofar as it obtains, is fact-like: its
 * constituents and their properties are what it is, and altering them would
 * make it a different situation. A value is what its components are, so
 * altering one makes it a different value. So an attribute of any of these
 * holds the same value for as long as there is anything to hold it. The same
 * reasoning as `checkImmutableEndIsConst`, about the other half of what a
 * classifier declares.
 */
export function checkImmutableAttributeIsConst(attribute: Attribute, accept: ValidationAcceptor): void {
    const owner = attribute.$container;
    if (attribute.isConst || attribute.isDerived || !ownsOnlyImmutableAttributes(owner)) {
        return;
    }
    const message = isClassDeclaration(owner)
        ? `Nothing about an instance of "${owner.name}" changes, so neither does this. Mark it "const".`
        : `"${owner.name}" classifies values, and a value with a different "${attribute.name}" is a different value, so this cannot change. Mark it "const".`;
    accept('warning', message, { node: attribute, property: 'name', code: 'immutable-attribute-not-const' });
}

/**
 * An event has ended, so it has an end point: `[1]`, not `[0..1]`.
 *
 * The mirror of the rule below. What separates them is whether an instance may
 * still be unfolding -- an endurant that exists, a process going on, a
 * situation obtaining -- and an event never is.
 */
export function checkEventEndPointIsMandatory(attribute: Attribute, accept: ValidationAcceptor): void {
    const owner = attribute.$container;
    if (!attribute.stereotypes.includes('end') || !isClassDeclaration(owner)
        || !classifiesOnly(owner, 'events')) {
        return;
    }
    const bounds = attribute.cardinality ? getBounds(attribute.cardinality) : { lower: 1, upper: 1 };
    if (!bounds || bounds.lower >= 1) {
        return;
    }
    accept('warning',
        `"${owner.name}" classifies events, and an event has ended, so its end point is "[1]".`,
        { node: attribute, property: 'name', code: 'end-time-point-not-mandatory' });
}

/**
 * An endurant that still exists has no end point yet, so an `@end` on a class
 * of endurants holds of some of its instances and not others: lower bound 0.
 *
 * An event is not in this position -- a modeled event is one that occurred,
 * and it has both instants -- so the hint asks first whether an instance may
 * still be unfolding. A process going on and a situation obtaining both may,
 * and neither has an end point yet.
 *
 * Nor is an instantaneous individual, written by putting both stereotypes on
 * one attribute: it ends when it begins, so the one value is known as soon as
 * there is anything to know it of.
 */
/**
 * What the class classifies, in the words of the reason it has no end point.
 *
 * The rule covers three sorts and the message named one of them: a process
 * and a situation were both told they classify endurants, which is the one
 * thing they are not.
 */
function whatKeepsGoing(natures: ReadonlySet<string>): string {
    const said: string[] = [];
    if ([...natures].some(nature => nature !== 'processes' && nature !== 'situations')) {
        said.push('endurants, and one that still exists has no end point yet');
    }
    if (natures.has('processes')) {
        said.push('processes, and one still going on has no end point yet');
    }
    if (natures.has('situations')) {
        said.push('situations, and one still obtaining has no end point yet');
    }
    return said.join('; ');
}

export function checkEndPointIsOptional(attribute: Attribute, accept: ValidationAcceptor): void {
    if (!attribute.stereotypes.includes('end') || attribute.stereotypes.includes('begin')) {
        return;
    }
    const owner = attribute.$container;
    const natures = isClassDeclaration(owner) ? possibleNaturesOf(owner) : undefined;
    if (!natures || natures.size === 0 || ![...natures].every(mayStillBeUnfolding)) {
        return;
    }
    const bounds = attribute.cardinality ? getBounds(attribute.cardinality) : { lower: 1, upper: 1 };
    if (!bounds || bounds.lower === 0) {
        return;
    }
    accept('hint',
        `"${owner.name}" classifies ${whatKeepsGoing(natures)}, so "@end" should be optional: "[0..1]".`,
        { node: attribute, property: 'name', code: 'end-time-point-not-optional' });
}
