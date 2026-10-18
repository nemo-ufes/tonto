import { isClassDeclaration, isDatatype, isEnumeration } from '../generated/ast.js';
import type { AstNode } from 'langium';
import type { ClassDeclaration, Relation } from '../generated/ast.js';
import { possibleNaturesOf } from '../utils/nature-reasoning.js';
import { getRelationSource, isParthood, wholeEndOf } from '../utils/relations.js';
import {
    naturesFor, PART_WHOLE_STEREOTYPES, PARTHOOD_NATURE_PAIRS, RELATION_NATURE_TABLE,
    TABLE_NATURE_NAMES, TONTO_NATURE_NAMES
} from './relation-nature-table.js';
import { allowedNaturesFor, expandNatures, SUGGESTED_CLASS_STEREOTYPES } from './stereotype-model.js';

/**
 * Which natures may sit at one end of a relation, given everything the line
 * already says.
 *
 * Three things narrow it, and a partly written relation usually offers at
 * least one. The stereotype, where there is one, fixes the row of the table
 * outright. The notation speaks even when the stereotype is missing -- a
 * diamond is a claim of parthood and rules out every other row. And so does
 * the class at the *other* end: in
 *
 *     event Wedding { <>-- VowReading }
 *
 * the whole is an event, every admissible event-parthood stereotype requires
 * an event part too. The natures cannot choose between `@structural`,
 * `@temporal` and `@participational`; their decomposition criteria do.
 *
 * What makes that work is reading the table's pairs rather than its margins.
 * A nature survives only if some candidate stereotype admits it *opposite* a
 * nature the known end actually has, so `functional-complex` never appears
 * merely because parthood as a whole allows it somewhere.
 *
 * Returns `undefined` when nothing constrains the end -- both sides unwritten,
 * or a stereotype with no table entry -- which callers read as "no opinion"
 * rather than "nothing is allowed".
 */
export function naturesAdmissibleAt(relation: Relation, property: 'source' | 'target'): Set<string> | undefined {
    const other = property === 'source' ? relation.target?.ref : getRelationSource(relation);
    const known = naturesOfEnd(other);
    if (!relation.stereotype && isParthood(relation)) {
        return acrossParthood(relation, property, known);
    }
    const admissible = new Set<string>();
    for (const stereotype of candidateStereotypes(relation)) {
        const side = tablePositionOf(relation, property, stereotype);
        for (const pair of naturesFor(stereotype) ?? []) {
            const [first, second] = pair.split(':');
            const mine = side === 'first' ? first : second;
            const theirs = side === 'first' ? second : first;
            if (!known || known.has(TONTO_NATURE_NAMES[theirs])) {
                admissible.add(mine);
            }
        }
    }
    return admissible.size > 0 ? admissible : undefined;
}

/**
 * The natures of whatever stands at a relation end.
 *
 * An end may name a datatype or an enumeration as well as a class, and those
 * classify abstract individuals -- values, outside time. Reading only classes
 * gave them no natures at all, which every caller reads as "no opinion": the
 * table then had nothing to say about `@membership <>-- date`, in the
 * validator or in the list of what to complete.
 */
export function naturesOfEnd(node: AstNode | undefined): ReadonlySet<string> | undefined {
    if (isClassDeclaration(node)) {
        return possibleNaturesOf(node);
    }
    return isDatatype(node) || isEnumeration(node) ? ABSTRACT_ONLY : undefined;
}

const ABSTRACT_ONLY: ReadonlySet<string> = new Set([TONTO_NATURE_NAMES['abstract']]);

/** Whether this could stand at this end without contradicting the table. */
export function admissibleAtRelationEnd(
    relation: Relation, property: 'source' | 'target', candidate: AstNode
): boolean {
    const admissible = naturesAdmissibleAt(relation, property);
    const natures = naturesOfEnd(candidate);
    if (!admissible || !natures || natures.size === 0) {
        return true;
    }
    return [...admissible].some(nature => natures.has(TONTO_NATURE_NAMES[nature]));
}

/**
 * The stereotypes that would let this class stand at this end.
 *
 * The nature check reports the pair; this asks what would make the pair
 * admissible without moving anything -- `intrinsicMode CarCapacity` with an
 * `@externalDependence` is an `extrinsicMode` that says so, and the word is
 * the only thing wrong with it.
 *
 * Judged the same way the check judges what is written: the natures a
 * stereotype admits against the natures the end leaves open. What the *class*
 * may be -- what it specializes, what specializes it, what its `of` clause
 * says -- is a separate question, and the caller asks it.
 */
export function stereotypesAdmissibleAt(relation: Relation, property: 'source' | 'target'): string[] {
    const admissible = naturesAdmissibleAt(relation, property);
    if (!admissible) {
        return [];
    }
    return SUGGESTED_CLASS_STEREOTYPES.filter(stereotype => {
        const allowed = allowedNaturesFor(stereotype);
        const natures = allowed ? expandNatures(allowed) : undefined;
        return !!natures && natures.size > 0
            && [...natures].every(nature => admissible.has(TABLE_NATURE_NAMES[nature]));
    });
}

/**
 * An unstereotyped parthood is not confined to the stereotyped rows: the
 * tonto names no stereotype for the parthood of a relator or a quality, and
 * `PARTHOOD_NATURE_PAIRS` is what such a relation must satisfy.
 */
function acrossParthood(
    relation: Relation, property: 'source' | 'target', known: ReadonlySet<string> | undefined
): Set<string> | undefined {
    const wholeIsHere = (wholeEndOf(relation) === 'source') === (property === 'source');
    const admissible = new Set<string>();
    for (const pair of PARTHOOD_NATURE_PAIRS) {
        const [whole, part] = pair.split(':');
        const mine = wholeIsHere ? whole : part;
        const theirs = wholeIsHere ? part : whole;
        if (!known || known.has(TONTO_NATURE_NAMES[theirs])) {
            admissible.add(mine);
        }
    }
    return admissible.size > 0 ? admissible : undefined;
}

/** The stereotypes this relation could still turn out to carry. */
export function candidateStereotypes(relation: Relation): string[] {
    if (relation.stereotype) {
        return naturesFor(relation.stereotype) ? [relation.stereotype] : [];
    }
    const all = Object.keys(RELATION_NATURE_TABLE);
    return isParthood(relation) ? all.filter(stereotype => PART_WHOLE_STEREOTYPES.has(stereotype)) : all;
}

/**
 * Where this end sits in a table entry: parthood reads (whole, part) and the
 * diamond says which end is the whole; every other entry reads (source,
 * target).
 */
function tablePositionOf(relation: Relation, property: 'source' | 'target', stereotype: string): 'first' | 'second' {
    const swapped = PART_WHOLE_STEREOTYPES.has(stereotype) && wholeEndOf(relation) === 'target';
    return (swapped ? property === 'target' : property === 'source') ? 'first' : 'second';
}

/**
 * Whether writing this stereotype on this relation would satisfy the table.
 *
 * The question a fix has to answer before offering to write one: a
 * `@characterization` belongs on the association running from the moment to
 * its bearer and on no other, and the pair of end natures is what says so.
 */
export function stereotypeFitsEnds(relation: Relation, stereotype: string): boolean {
    const source = getRelationSource(relation);
    const target = relation.target?.ref;
    if (!isClassDeclaration(source) || !target || !isClassDeclaration(target)) {
        return false;
    }
    // Parthood entries read (whole, part); everything else (source, target).
    const wholeFirst = PART_WHOLE_STEREOTYPES.has(stereotype) && wholeEndOf(relation) === 'target';
    return naturesFitStereotype(stereotype, wholeFirst ? target : source, wholeFirst ? source : target);
}

/**
 * The same question asked of two classes rather than of a relation, which is
 * what offering to *write* one needs: `@mediation` runs from a relator to what
 * it binds, so only a relator may stand first.
 */
export function naturesFitStereotype(
    stereotype: string, first: ClassDeclaration, second: ClassDeclaration
): boolean {
    const pairs = naturesFor(stereotype);
    const firsts = possibleNaturesOf(first);
    const seconds = possibleNaturesOf(second);
    if (!pairs || !firsts || !seconds) {
        return false;
    }
    return [...firsts].some(a => [...seconds].some(b =>
        pairs.includes(`${TABLE_NATURE_NAMES[a]}:${TABLE_NATURE_NAMES[b]}`)));
}

/**
 * Whether a class may stand at the first position of a stereotype.
 *
 * What offering to *write* a relation inside a class body needs: the other
 * end is a placeholder, so the pair cannot be asked about, but the end that
 * is known already settles most of it. A `kind` may not open a
 * `@mediation` -- only a relator binds -- and offering one there is offering
 * an error the check would report as soon as the target was typed.
 *
 * Parthood entries read (whole, part), and a relation written in a body puts
 * the class first, which the snippets mark as the whole.
 */
export function mayStandFirst(stereotype: string, classDeclaration: ClassDeclaration): boolean {
    const pairs = naturesFor(stereotype);
    const natures = possibleNaturesOf(classDeclaration);
    if (!pairs || !natures) {
        return false;
    }
    return [...natures].some(nature =>
        pairs.some(pair => pair.split(':')[0] === TABLE_NATURE_NAMES[nature]));
}

/**
 * Every stereotype that could be written on this relation as it stands.
 *
 * More than one usually can. The natures single a stereotype out far less
 * often than the parthood grids suggest: `event:event` fits `@participational`,
 * `@structural` and `@temporal` alike, and `collective:collective` fits both
 * `@membership` and `@subCollection`. Anything that offers to write one has to
 * offer the rest beside it.
 */
export function stereotypesFitting(relation: Relation): string[] {
    return candidateStereotypes(relation).filter(stereotype => stereotypeFitsEnds(relation, stereotype));
}

/**
 * Whether one class could be a part of another, by nature alone.
 *
 * The same table `checkParthoodNatures` reads, asked before a relation exists
 * -- which is what offering to *create* one needs.
 */
export function canBePartOf(whole: ClassDeclaration, part: ClassDeclaration): boolean {
    const wholes = possibleNaturesOf(whole);
    const parts = possibleNaturesOf(part);
    if (!wholes || !parts) {
        return false;
    }
    return [...wholes].some(a => [...parts].some(b =>
        PARTHOOD_NATURE_PAIRS.has(`${TABLE_NATURE_NAMES[a]}:${TABLE_NATURE_NAMES[b]}`)));
}
