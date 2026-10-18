import type { ClassDeclaration, Relation } from '../generated/ast.js';
import { isClassDeclaration } from '../generated/ast.js';
import type { Bounds } from '../validation/cardinality-checks.js';
import { getBounds } from '../validation/cardinality-checks.js';
import type { ReverseLookup } from '../validation/incoming-relations.js';
import { getRelationSource } from './relations.js';

/**
 * A cross-level link: one type sitting exactly one order above another.
 *
 * MLT (Carvalho, Almeida & Guizzardi 2016) puts instantiation between adjacent
 * orders only, so every such link raises the order by exactly one. tonto
 * writes them two ways -- an `@instantiation` relation, or an `instanceOf`
 * clause -- and both mean the same thing here.
 */
export interface CrossLevel {
    /** The lower-order type. */
    base: ClassDeclaration;
    /** The type one order above it. */
    higher: ClassDeclaration;
    /**
     * How the link was written, which is not a detail: an `@instantiation`
     * says the higher type *characterizes* the lower one, while an
     * `instanceOf` says the lower one is one of its *instances*. Both put the
     * types one order apart, so both count for orders and cycles; only the
     * first identifies a base type.
     */
    via: 'instantiation' | 'instanceOf';
    /** The relation it was written as, when it was written as one. */
    relation?: Relation;
    /** Multiplicity at the higher-order end, which fixes which MLT relation holds. */
    bounds?: Bounds;
}

/** An omitted multiplicity means exactly one, as everywhere else in tonto. */
const IMPLIED: Bounds = { lower: 1, upper: 1 };

/**
 * The cross-level links written *from* this type, i.e. those it is the base of.
 *
 * Goes through the reverse lookup rather than the class body: an
 * `@instantiation` is as often written as a package-level `relation` as it is
 * inside the base type, and reading only `base.relations` made every such
 * model look as though it had no cross-level links at all.
 */
export function crossLevelsFrom(lookup: ReverseLookup, base: ClassDeclaration): CrossLevel[] {
    const links: CrossLevel[] = [];
    for (const relation of lookup.touching(base)) {
        if (getRelationSource(relation) !== base) {
            continue;
        }
        const link = asCrossLevel(relation, base);
        if (link) {
            links.push(link);
        }
    }
    const declared = base.instanceOf?.ref;
    if (declared && isClassDeclaration(declared)) {
        links.push({ base, higher: declared, via: 'instanceOf' });
    }
    return links;
}

/**
 * The cross-level links written *into* this type, i.e. those it is the higher
 * order of, from anywhere in the workspace.
 *
 * Workspace-wide because the `@instantiation` is normally written beside the
 * base type. A powertype declared in one file and instantiated in another is
 * the ordinary case, not the exception.
 */
export function crossLevelsInto(lookup: ReverseLookup, higher: ClassDeclaration): CrossLevel[] {
    const links: CrossLevel[] = [];
    for (const referrer of lookup.referrers(higher)) {
        if (isClassDeclaration(referrer) && referrer.instanceOf?.ref === higher) {
            links.push({ base: referrer, higher, via: 'instanceOf' });
            continue;
        }
        const source = isRelationNode(referrer) ? getRelationSource(referrer) : undefined;
        if (isRelationNode(referrer) && source && isClassDeclaration(source)) {
            const link = asCrossLevel(referrer, source);
            if (link && link.higher === higher) {
                links.push(link);
            }
        }
    }
    // A relation inside the higher type's own body would name it at the far
    // end only, so the index never lists it -- but that shape has the higher
    // type as *source*, which is a different link and not wanted here.
    return links;
}

function isRelationNode(node: unknown): node is Relation {
    return !!node && typeof node === 'object' && 'stereotype' in node && 'target' in node;
}

function asCrossLevel(relation: Relation, base: ClassDeclaration): CrossLevel | undefined {
    if (relation.stereotype !== 'instantiation') {
        return undefined;
    }
    const higher = relation.target?.ref;
    if (!higher || !isClassDeclaration(higher)) {
        return undefined;
    }
    const bounds = relation.targetCardinality ? getBounds(relation.targetCardinality) : IMPLIED;
    return { base, higher, relation, bounds: bounds ?? undefined, via: 'instantiation' };
}

/**
 * The types this higher-order type characterizes or is the powertype of --
 * those linked to it by an `@instantiation`.
 *
 * Deliberately not the types *declared* to be its instances. `Elm
 * (instanceOf TreeSpecies)` says Elm is one of TreeSpecies' instances, not
 * that TreeSpecies is the powertype of Elm, and reading it as the latter made
 * every enumerated instance look like a second base type.
 */
export function basesOf(lookup: ReverseLookup, higher: ClassDeclaration): ClassDeclaration[] {
    return [...new Set(crossLevelsInto(lookup, higher)
        .filter(link => link.via === 'instantiation')
        .map(link => link.base))];
}

/** The types declared to be instances of this higher-order type. */
export function instancesOf(lookup: ReverseLookup, higher: ClassDeclaration): ClassDeclaration[] {
    return [...new Set(crossLevelsInto(lookup, higher)
        .filter(link => link.via === 'instanceOf')
        .map(link => link.base))];
}

/**
 * D3 -- `t isPowertypeOf t'`: every instance of t is a specialization of t'
 * *and* every specialization of t' is an instance of t. Since specialization
 * is reflexive, the base type is itself an instance of its powertype.
 *
 * tonto marks the Cardelli reading with the `isPowerType` modifier, so a
 * cross-level link into a class carrying it is a powertype-of link. The
 * modifier is orthogonal to the stereotype: a `type`, a `category of types`
 * and a `class of types` may each carry it.
 */
export function isPowertypeLink(link: CrossLevel): boolean {
    return link.higher.isPowerType;
}

/**
 * D4 -- `t characterizes t'`: every instance of t is a *proper* specialization
 * of t', so the base type is not among them. This is Odell's reading, which
 * the paper argues is what UML's generalization-set powertype actually means,
 * and which tonto writes as a high-order type *without* the `isPowerType`
 * modifier. The two readings are exclusive by construction, so every
 * cross-level link is one or the other.
 */
export function isCharacterizationLink(link: CrossLevel): boolean {
    return !link.higher.isPowerType;
}

/**
 * D7 -- `t partitions t'`: t characterizes t' completely and disjointly, which
 * Table 2 of the paper reads off the multiplicity at the higher-order end.
 * `[1]` -- each instance of the base instantiates exactly one instance of t.
 */
export function partitionsBase(link: CrossLevel): boolean {
    return !!link.bounds && link.bounds.lower === 1 && link.bounds.upper === 1;
}

/** Whether the link's higher end is `[1..*]`, the only shape a powertype admits. */
export function isCardelliMultiplicity(bounds: Bounds | undefined): boolean {
    return !!bounds && bounds.lower === 1 && bounds.upper === Infinity;
}
