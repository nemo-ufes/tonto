import type { AstNode, ValidationAcceptor } from 'langium';
import { AstUtils } from 'langium';
import type {
    Cardinality, Relation, RelationEndMetaAttributes, RelationEndTarget
} from '../generated/ast.js';
import { isClassDeclaration, isDatatype, isEnumeration, isRelation } from '../generated/ast.js';
import { isParthood } from '../utils/relations.js';
import { naturesFitStereotype } from './relation-end-natures.js';
import { hasImmutableInstances, holdsAccumulatingHistory, isSituationParthood } from './relation-nature-checks.js';
import { isSameOrSpecializes } from '../utils/generalizations.js';
import { fromUnrelatedBranches, membersInScopeOf } from '../utils/inherited-members.js';
import type { ReverseLookup } from './incoming-relations.js';
import {
    getRelationNotation, getEndCardinality, getEndOwner, getEndType, getRelationSource, getRelationSourceName
} from '../utils/relations.js';
import type { Bounds } from './cardinality-checks.js';
import { formatBounds, getBounds } from './cardinality-checks.js';
import { PART_WHOLE_STEREOTYPES } from './relation-nature-table.js';
import { adviseOnStereotype, isRelationStereotype } from './relation-stereotypes.js';

/**
 * `()` says nothing.
 *
 * The parentheses are what an end is written in, and an empty pair is a
 * decorator someone started and did not finish -- or one whose contents were
 * deleted. Refused rather than ignored: it parses, so nothing else would ever
 * mention it, and it reads like a mistake because it is one.
 */
export function checkEndDecoratorSaysSomething(end: RelationEndMetaAttributes, accept: ValidationAcceptor): void {
    const empty = !end.name && !end.subsets && !end.redefines && !end.isConst && !end.isAddOnly;
    if (empty) {
        accept('error', 'This end decorator is empty: write a flag, a name, or "subsets"/"redefines" in it -- or remove it.', {
            node: end, code: 'empty-end-decorator'
        });
    }
}

/** A relation end cannot subset or redefine itself. */
export function checkRelationEndDoesNotSubsetOrRedefineItself(end: RelationEndMetaAttributes, accept: ValidationAcceptor): void {
    if (end.subsets?.ref === end) {
        accept('error', 'A relation end cannot subset itself.', { node: end, property: 'subsets', code: 'end-self-reference' });
    }
    if (end.redefines?.ref === end) {
        accept('error', 'A relation end cannot redefine itself.', { node: end, property: 'redefines', code: 'end-self-reference' });
    }
}

/**
 * What one multiplicity says about another it is bounded by.
 *
 * The three ways of relating two ends -- a relation that `specializes`
 * another, an end that `subsets` another, an end that `redefines` another --
 * differ in what the link sets are, and agree entirely in what an upper bound
 * then means. In each case the specific end's links are among the general's
 * (for a redefinition they are the same links), so:
 *
 * - requiring more than the general permits is unsatisfiable: nothing can have
 *   three links here and at most two there;
 * - permitting more than the general permits is satisfiable and unreachable,
 *   which is imprecision rather than contradiction -- the count is bounded by
 *   the general whatever this end says;
 * - and *requiring fewer* is ordinary: a department has at least one staff
 *   member and may have no professors. Only a redefinition, which replaces the
 *   end rather than drawing from it, has to keep the lower bound too, and
 *   `checkOverride` reads that separately.
 */
function comparedWith(specific: Bounds, general: Bounds): 'requires-more' | 'permits-more' | undefined {
    if (specific.lower > general.upper) {
        return 'requires-more';
    }
    return specific.upper > general.upper ? 'permits-more' : undefined;
}

/** Whether this end names an end of that relation as the one it draws from. */
function overridesAnEndOf(meta: RelationEndMetaAttributes | undefined, general: Relation): boolean {
    const overridden = meta?.subsets?.ref ?? meta?.redefines?.ref;
    return !!overridden && overridden.$container === general;
}

/** The multiplicity an end states, written or implied: nothing means one. */
function boundsOf(cardinality: Cardinality | undefined): Bounds {
    return (cardinality && getBounds(cardinality)) ?? { lower: 1, upper: 1 };
}

/** How it reads back, written or implied. */
function boundsText(cardinality: Cardinality | undefined): string {
    return cardinality ? formatBounds(cardinality) : '[1]';
}

/**
 * Subsetting and redefinition may only *narrow*: the subsetting end's type
 * must be the same as, or a specialization of, the subset end's type, and it
 * cannot hold more links than the end it draws them from.
 *
 * How much of the multiplicity has to be kept is where the two part company.
 * A subsetting end takes its links from the subsetted one, whose own
 * multiplicity goes on applying to the whole of it -- so `professors [0..*]
 * subsets staff [1..*]` says a department has staff and may have no
 * professors, which is a model, not a mistake, and asking the whole
 * multiplicity to sit inside the other reported it as one. A redefining end *replaces* the end it redefines for instances of the
 * subtype: those are the same links under two names, so what the redefined end
 * requires still has to hold of them.
 */
export function checkRelationEndOverrideNarrows(
    locate: (node: AstNode) => string, end: RelationEndMetaAttributes, accept: ValidationAcceptor
): void {
    checkOverride(locate, end, 'subsets', accept);
    checkOverride(locate, end, 'redefines', accept);
}

function checkOverride(
    locate: (node: AstNode) => string,
    end: RelationEndMetaAttributes,
    property: 'subsets' | 'redefines',
    accept: ValidationAcceptor
): void {
    const general = end[property]?.ref;
    const specific = end;
    if (!general || general === specific) {
        return;
    }

    const specificType = getEndType(specific);
    const generalType = getEndType(general);
    if (specificType && generalType && !isEndTypeCompatible(specificType, generalType)) {
        accept(
            'error',
            `This end is typed by "${nameOf(specificType)}", which does not specialize "${nameOf(generalType)}" -- the type of the end it ${property}.`,
            {
                node: end,
                property,
                code: 'override-type-not-narrower',
                // The same two readings as a relation specialization that does
                // not narrow: say what the model meant, or stop saying it.
                // Which class would have to specialize which travels as a path,
                // since either may be declared in another file.
                data: { subject: locate(specificType), supertype: nameOf(generalType) }
            }
        );
    }

    const specificBounds = boundsOf(getEndCardinality(specific));
    const generalBounds = boundsOf(getEndCardinality(general));
    const written = boundsText(getEndCardinality(specific));
    const generalWritten = boundsText(getEndCardinality(general));
    const holds = property === 'redefines'
        ? 'This end replaces the one it redefines, so the two hold the same links'
        : 'The links at this end are among those of the end it subsets';
    const verdict = comparedWith(specificBounds, generalBounds);
    if (verdict === 'requires-more') {
        accept(
            'error',
            `${holds}: it cannot require more than the ${generalWritten} that end permits, and ${written} does.`,
            { node: end, property, code: 'end-holds-more-than-general' }
        );
    } else if (verdict === 'permits-more') {
        accept(
            'warning',
            `${holds}: it can never hold more than the ${generalWritten} that end permits, whatever ${written} says.`,
            { node: end, property, code: 'end-holds-more-than-general' }
        );
    }
    // A redefinition replaces the end, so an instance of the subtype has to
    // satisfy what the redefined end required of it. A subsetting end is a
    // part of the other and may be smaller, empty included.
    if (property === 'redefines' && specificBounds.lower < generalBounds.lower) {
        accept(
            'error',
            `This end replaces the one it redefines, so what that end requires still has to hold: ${written} permits fewer than the ${generalWritten} it redefines.`,
            { node: end, property, code: 'redefinition-weakens-lower-bound' }
        );
    }
}

export function isEndTypeCompatible(specific: RelationEndTarget, general: RelationEndTarget): boolean {
    if (specific === general) {
        return true;
    }
    if (isClassDeclaration(specific) && isClassDeclaration(general)) {
        return isSameOrSpecializes(specific, general);
    }
    // Datatypes/relations at an end: only exact identity is checked, since
    // their specialization rules are validated elsewhere.
    return true;
}

function nameOf(target: RelationEndTarget): string {
    return 'name' in target && target.name ? target.name : '<anonymous>';
}

/**
 * A specializing relation must connect the same classifiers as the relation
 * it specializes, or specializations of them -- and no end of it may hold
 * more than the general's.
 */
export function checkRelationSpecializationNarrows(
    locate: (node: AstNode) => string, relation: Relation, accept: ValidationAcceptor
): void {
    const general = relation.specializes?.ref;
    if (!general || general === relation) {
        return;
    }
    compareEnd(locate, relation, general, 'source', accept);
    compareEnd(locate, relation, general, 'target', accept);
    compareBounds(relation, general, 'source', accept);
    compareBounds(relation, general, 'target', accept);
}

/**
 * The links of a specialization are among the general's, so an end of it
 * cannot hold more of them than the general's end does.
 *
 * The same reading as `checkOverride` above, which is the point: subsetting an
 * end implies that its relation specializes the other -- `implied-relation-
 * specialization` says so outright -- and the two spellings of one claim were
 * answered by two different rules, one of which required the lower bound to
 * narrow and the other of which did not.
 */
function compareBounds(
    relation: Relation,
    general: Relation,
    side: 'source' | 'target',
    accept: ValidationAcceptor
): void {
    const written = side === 'source' ? relation.sourceCardinality : relation.targetCardinality;
    const generalWritten = side === 'source' ? general.sourceCardinality : general.targetCardinality;
    // An end that already says which of the general's ends it draws from is
    // answered by `checkOverride` against that end, in the same words. Both
    // spoke where a relation specialized another *and* its end subset one:
    // one mistake, one multiplicity to change, two diagnostics on it.
    if (overridesAnEndOf(side === 'source' ? relation.sourceMeta : relation.targetMeta, general)) {
        return;
    }
    const verdict = comparedWith(boundsOf(written), boundsOf(generalWritten));
    if (verdict === undefined) {
        return;
    }
    const permits = `the ${boundsText(generalWritten)} "${nameOf2(general)}" permits`;
    accept(
        verdict === 'requires-more' ? 'error' : 'warning',
        verdict === 'requires-more'
            ? `A specialization's links are among the general's: this end cannot require more than ${permits}, and ${boundsText(written)} does.`
            : `A specialization's links are among the general's: this end can never hold more than ${permits}, whatever ${boundsText(written)} says.`,
        { node: written ?? relation, code: 'end-holds-more-than-general', data: { side } }
    );
}

function compareEnd(
    locate: (node: AstNode) => string,
    relation: Relation,
    general: Relation,
    side: 'source' | 'target',
    accept: ValidationAcceptor
): void {
    const specificType = side === 'source' ? getRelationSource(relation) : relation.target?.ref;
    const generalType = side === 'source' ? getRelationSource(general) : general.target?.ref;
    if (!specificType || !generalType || isEndTypeCompatible(specificType, generalType)) {
        return;
    }
    accept(
        'error',
        `The ${side} of this relation ("${nameOf(specificType)}") does not specialize the ${side} of the relation it specializes ("${nameOf(generalType)}").`,
        {
            node: relation,
            property: 'specializes',
            code: 'relation-specialization-not-narrower',
            // Which class would have to specialize which, for the repair that
            // makes the statement true rather than the one that deletes it.
            // The class may be declared in another file, so it travels as a
            // path rather than as a node.
            data: {
                subject: locate(specificType),
                supertype: nameOf(generalType)
            }
        }
    );
}

/**
 * `inverseOf` must name a relation running the other way: its source must be
 * this relation's target and vice versa.
 */
export function checkInverseOfIsSymmetric(relation: Relation, accept: ValidationAcceptor): void {
    const inverse = relation.inverseOf?.ref;
    if (!inverse) {
        return;
    }
    if (inverse === relation) {
        accept('error', 'A relation cannot be its own inverse.', { node: relation, property: 'inverseOf', code: 'self-inverse' });
        return;
    }

    const source = getRelationSource(relation);
    const target = relation.target?.ref;
    const inverseSource = getRelationSource(inverse);
    const inverseTarget = inverse.target?.ref;
    if (!source || !target || !inverseSource || !inverseTarget) {
        return;
    }
    if (inverseSource !== target || inverseTarget !== source) {
        accept(
            'error',
            `"${nameOf2(inverse)}" is not the inverse of this relation: an inverse must run from "${nameOf(target)}" to "${nameOf(source)}".`,
            { node: relation, property: 'inverseOf', code: 'inverse-signature-mismatch' }
        );
    }
}

function nameOf2(relation: Relation): string {
    return relation.name ?? '<anonymous relation>';
}

/**
 * An inverse is one association read the other way, so it has the same two
 * ends -- crossed over, since what is the source here is the target there.
 *
 * `Person { [*] (addOnly children) -- hasFather -- [1] (const father) Man }`
 * and, in `Man`, `-- hasChildren -- Person inverseOf Person.hasFather` say two
 * different things about one association: that a person has one father and
 * that a person has one child, that the set of children only grows and that
 * nothing about it is settled. Nothing read the second statement, so both
 * stood.
 *
 * What has to agree is what an end states: its multiplicity and its flags. A
 * name is not part of that -- an end that names itself on one side and not on
 * the other has left something unsaid rather than contradicted itself -- but
 * two *different* names for one property are two properties, and that is a
 * disagreement like any other.
 */
export function checkInverseEndsAgree(relation: Relation, accept: ValidationAcceptor): void {
    const inverse = relation.inverseOf?.ref;
    if (!inverse || inverse === relation || !crossesOver(relation, inverse)) {
        // A `inverseOf` that does not even run the other way is answered by
        // `checkInverseOfIsSymmetric`; the ends are the next question.
        return;
    }
    const mine = [endFacts(relation, 'source'), endFacts(relation, 'target')] as const;
    const theirs = [endFacts(inverse, 'target'), endFacts(inverse, 'source')] as const;
    if (agree(mine[0], theirs[0]) && agree(mine[1], theirs[1])) {
        return;
    }
    accept(
        'error',
        `"${nameOf2(inverse)}" is this association read the other way, so the two share their ends: `
        + `this one should run "${mirrorOf(inverse, 'target')}" to "${mirrorOf(inverse, 'source')}".`,
        { node: relation, code: 'inverse-ends-differ' }
    );
}

/** Whether the two relations run between the same classifiers, opposite ways. */
function crossesOver(relation: Relation, inverse: Relation): boolean {
    const source = getRelationSource(relation);
    const target = relation.target?.ref;
    return !!source && !!target
        && getRelationSource(inverse) === target && inverse.target?.ref === source;
}

interface EndFacts {
    lower: number;
    upper: number;
    flags: string;
    name?: string;
    subsets?: RelationEndMetaAttributes;
    redefines?: RelationEndMetaAttributes;
}

/** What an end states, in the two forms it can be written in. */
function endFacts(relation: Relation, side: 'source' | 'target'): EndFacts {
    const cardinality = side === 'source' ? relation.sourceCardinality : relation.targetCardinality;
    const meta = side === 'source' ? relation.sourceMeta : relation.targetMeta;
    // An end with no multiplicity written is exactly one, which is what an end
    // that writes `[1]` says: the two agree.
    const bounds = (cardinality && getBounds(cardinality)) ?? { lower: 1, upper: 1 };
    const flags = ['isConst', 'isAddOnly'] as const;
    return {
        lower: bounds.lower,
        upper: bounds.upper,
        flags: flags.filter(flag => meta?.[flag] === true).join(','),
        name: meta?.name,
        subsets: meta?.subsets?.ref,
        redefines: meta?.redefines?.ref
    };
}

function agree(mine: EndFacts, theirs: EndFacts): boolean {
    return mine.lower === theirs.lower && mine.upper === theirs.upper && mine.flags === theirs.flags
        && (mine.name === undefined || theirs.name === undefined || mine.name === theirs.name);
}

/** Every statement at one end agrees, rather than merely not contradicting an omitted name. */
function exactlyAgrees(mine: EndFacts, theirs: EndFacts): boolean {
    return mine.lower === theirs.lower && mine.upper === theirs.upper && mine.flags === theirs.flags
        && mine.name === theirs.name && mine.subsets === theirs.subsets && mine.redefines === theirs.redefines;
}

/**
 * Suggests inversehood when two independently written associations already
 * say exactly the same thing in opposite directions.
 *
 * This remains a hint: identical signatures do not prove identity -- a person
 * may stand in two distinct one-to-one relations with an organization -- but
 * they make the omitted declaration likely enough to put the choice in front
 * of the modeler. Each unordered pair is reported once, even across files.
 *
 * A relation that already has an inverse -- named by its own `inverseOf` or
 * by one naming it -- is not offered another. Nor is a pair of relations
 * between one class and itself whose ends say the same in either direction:
 * crossing them changes nothing, so agreeing crossed says no more than two
 * relations running the same way, `likes` and `admires`.
 */
export function checkMatchingInverse(
    lookup: ReverseLookup,
    locate: (node: AstNode) => string,
    relation: Relation,
    accept: ValidationAcceptor
): void {
    const source = getRelationSource(relation);
    const target = relation.target?.ref;
    const hasInverse = (one: Relation): boolean => !!one.inverseOf
        || lookup.referrers(one).some(referrer => isRelation(referrer) && referrer.inverseOf?.ref === one);
    if (!relation.name || !source || !isClassDeclaration(source) || !target || !isClassDeclaration(target)
        || hasInverse(relation)) {
        return;
    }
    const here = locate(relation);
    for (const candidate of new Set(lookup.touching(target))) {
        if (candidate === relation || !candidate.name || here >= locate(candidate)
            || !crossesOver(relation, candidate)
            || hasInverse(candidate)) {
            continue;
        }
        if (source === target
            && relation.isAggregation === candidate.isAggregation
            && relation.isAggregationInverted === candidate.isAggregationInverted
            && exactlyAgrees(endFacts(relation, 'source'), endFacts(candidate, 'source'))
            && exactlyAgrees(endFacts(relation, 'target'), endFacts(candidate, 'target'))) {
            continue;
        }
        const diamondsAgree = relation.isAggregation === candidate.isAggregationInverted
            && relation.isAggregationInverted === candidate.isAggregation;
        const endsAgree = exactlyAgrees(endFacts(relation, 'source'), endFacts(candidate, 'target'))
            && exactlyAgrees(endFacts(relation, 'target'), endFacts(candidate, 'source'));
        if (!diamondsAgree || !endsAgree) {
            continue;
        }
        accept(
            'hint',
            `"${relation.name}" and "${candidate.name}" have the same association ends in opposite directions. If they name one association, make them inverses.`,
            {
                node: relation,
                property: 'name',
                code: 'matching-inverse',
                data: { candidate: locate(candidate) }
            }
        );
    }
}

/**
 * One end of a relation as it would be written at the other side: the source
 * takes its decorator first and the target its multiplicity first, which is
 * the one asymmetry in how the two are spelled.
 */
export function mirrorOf(relation: Relation, side: 'source' | 'target'): string {
    const cardinality = side === 'source' ? relation.sourceCardinality : relation.targetCardinality;
    const meta = side === 'source' ? relation.sourceMeta : relation.targetMeta;
    const bound = cardinality?.$cstNode?.text ?? '[1]';
    const decorator = meta?.$cstNode?.text;
    // Written where it is read: at the source, the decorator precedes the
    // multiplicity; at the target it follows it.
    const written = side === 'source'
        ? [bound, decorator]
        : [decorator, bound];
    return written.filter(part => part !== undefined && part.length > 0).join(' ');
}

/**
 * UML requires the *context* of a subsetting or redefining property to
 * conform to the context of the property it overrides: `C.x subsets B.y` only
 * makes sense when `C` specializes `B`, otherwise the two properties describe
 * unrelated things and there is nothing to narrow.
 */
/**
 * A name written without its class has to reach one thing.
 *
 * What a class inherits it may name plainly -- `subsets parts` rather than
 * `subsets ComplexPhysicalObject.parts` -- because the specialization has
 * already said where to look. Two declarations of one name under classes that
 * say nothing about each other are two properties, and the model has to say
 * which: the nearest-first rule would pick one silently, and which one
 * depends on the order the mixins happen to be written in.
 *
 * A redefinition is not this: `parts` closer to the class refines the `parts`
 * above it, and the nearer is the answer.
 */
export function checkShortReferenceIsUnambiguous(
    lookup: ReverseLookup, end: RelationEndMetaAttributes, accept: ValidationAcceptor
): void {
    for (const property of ['subsets', 'redefines'] as const) {
        const written = end[property]?.$refText;
        const owner = AstUtils.getContainerOfType(end, isClassDeclaration);
        if (!written || written.includes('.') || !owner) {
            continue;
        }
        const owners = fromUnrelatedBranches(membersInScopeOf(owner, member => lookup.touching(member)).ends.get(written) ?? []);
        if (owners.length > 1) {
            accept(
                'warning',
                `"${written}" is declared by ${owners.map(one => `"${one.name}"`).join(' and ')}, which say nothing about each other. Write which one is meant: "${owners[0].name}.${written}".`,
                { node: end, property, code: 'short-reference-ambiguous' }
            );
        }
    }
}

/**
 * The same of a relation specialization, which may also be named plainly.
 */
export function checkShortRelationReferenceIsUnambiguous(
    lookup: ReverseLookup, relation: Relation, accept: ValidationAcceptor
): void {
    const written = relation.specializes?.$refText;
    const owner = AstUtils.getContainerOfType(relation, isClassDeclaration);
    if (!written || written.includes('.') || !owner) {
        return;
    }
    const owners = fromUnrelatedBranches(membersInScopeOf(owner, member => lookup.touching(member)).relations.get(written) ?? []);
    if (owners.length > 1) {
        accept(
            'warning',
            `"${written}" is declared by ${owners.map(one => `"${one.name}"`).join(' and ')}, which say nothing about each other. Write which one is meant: "${owners[0].name}.${written}".`,
            { node: relation, property: 'specializes', code: 'short-reference-ambiguous' }
        );
    }
}

export function checkRelationEndOverrideContext(
    locate: (node: AstNode) => string, end: RelationEndMetaAttributes, accept: ValidationAcceptor
): void {
    for (const property of ['subsets', 'redefines'] as const) {
        const general = end[property]?.ref;
        const specific = end;
        if (!general || general === specific) {
            continue;
        }
        const specificOwner = getEndOwner(specific);
        const generalOwner = getEndOwner(general);
        if (!specificOwner || !generalOwner || !isClassDeclaration(specificOwner) || !isClassDeclaration(generalOwner)) {
            continue;
        }
        if (!isSameOrSpecializes(specificOwner, generalOwner)) {
            const verb = property === 'subsets' ? 'subset' : 'redefine';
            accept(
                'error',
                `"${specificOwner.name}" does not specialize "${generalOwner.name}", so this end cannot ${verb} an end of "${generalOwner.name}".`,
                {
                    node: end,
                    property,
                    code: 'override-owner-not-subtype',
                    // Same two readings as the type rule: say what was meant,
                    // or stop saying it.
                    data: { subject: locate(specificOwner), supertype: generalOwner.name }
                }
            );
        }
    }
}

/**
 * Parthood is inherited, so a specialization has to agree about it.
 *
 * A parthood relation may only specialize a parthood relation, and anything
 * specializing one is a parthood too -- the same claim read from either end.
 * Instances of the specializing relation *are* instances of the general one,
 * so if either states that its ends stand in parthood, both do.
 *
 * Subsetting and redefining an end imply the specialization
 * (`checkOverrideSpecializesItsRelation`), so they carry the rule with them.
 */
export function checkParthoodAgreesWithSpecialization(
    locate: (node: Relation) => string, relation: Relation, accept: ValidationAcceptor
): void {
    const specific = isParthood(relation);
    const reported = new Set<Relation>();
    for (const { general, explicit } of generalRelationsOf(relation)) {
        if (general === relation || reported.has(general) || isParthood(general) === specific) {
            continue;
        }
        reported.add(general);
        const named = qualifiedRelationName(general) ?? 'the relation it specializes';
        const implied = explicit ? '' : ` Subsetting or redefining an end of "${named}" implies specializing it.`;
        accept(
            'error',
            (specific
                ? `This relation states parthood but "${named}", which it specializes, does not -- and parthood is inherited, so a parthood may only specialize a parthood.`
                : `"${named}" states parthood, so a relation specializing it states parthood too.`) + implied,
            {
                node: relation,
                ...(explicit ? { property: 'specializes' as const } : {}),
                code: 'parthood-specialization-mismatch',
                data: { make: specific ? 'general' : 'specific', explicit, general: locate(general) }
            }
        );
    }
}

/**
 * The relations this one specializes: the `specializes` clause, and every
 * relation whose end one of this relation's ends subsets or redefines.
 */
function generalRelationsOf(relation: Relation): Array<{ general: Relation; explicit: boolean }> {
    const generals: Array<{ general: Relation; explicit: boolean }> = [];
    if (relation.specializes?.ref) {
        generals.push({ general: relation.specializes.ref, explicit: true });
    }
    for (const end of [relation.sourceMeta, relation.targetMeta]) {
        const overridden = end?.subsets?.ref ?? end?.redefines?.ref;
        if (overridden) {
            generals.push({ general: overridden.$container, explicit: false });
        }
    }
    return generals;
}

/**
 * A relation needs something at its far end.
 *
 * The grammar accepts one without, which it did not used to: a mandatory
 * target meant the parser discarded a half-written declaration entirely and
 * answered `Expecting token of type 'EOF'`, so the relation vanished from the
 * AST and every rule that would have had something useful to say about it went
 * quiet. Parsing it and reporting the omission here says what is missing, and
 * leaves the rest of the relation available to hover, completion and every
 * other check.
 */
export function checkRelationHasTarget(relation: Relation, accept: ValidationAcceptor): void {
    if (relation.target) {
        return;
    }
    accept(
        'error',
        'This relation has no target: name the class or datatype at its far end.',
        { node: relation, code: 'relation-without-target' }
    );
}

/**
 * A class-to-value relation may be a property whose value type belongs on an
 * attribute. The relation is still valid: the author may intend a relation
 * to the abstract individuals classified by the datatype or enumeration.
 */
export function checkValueRelationMayBeAttribute(relation: Relation, accept: ValidationAcceptor): void {
    const source = getRelationSource(relation);
    const target = relation.target?.ref;
    if (!isClassDeclaration(source) || !target || (!isDatatype(target) && !isEnumeration(target))) {
        return;
    }
    const kind = isEnumeration(target) ? 'an enumeration' : 'a datatype';
    accept('hint',
        `"${target.name}" is ${kind}. If it gives the possible values of a property of "${source.name}", write an attribute typed by "${target.name}" (for example, "propertyName: ${target.name}").`,
        { node: relation, property: 'target', code: 'value-relation-may-be-attribute' }
    );
}

/**
 * A diamond marks the whole, and a parthood has exactly one.
 *
 * `<>-- name --<>` (or bare, `<>-- --<>`) writes both markers on one
 * relation: `RelationNotation` in the grammar admits it as a single relation
 * precisely so this can be said about it, rather than the parser matching
 * `<>--` alone -- a legal relation with no target, since everything after the
 * marker is optional -- and starting a second, unrelated one from whatever
 * followed, which used to leave a linking error blaming a class named after
 * the role name that came between the two markers.
 */
export function checkDiamondMarksOneEndOnly(relation: Relation, accept: ValidationAcceptor): void {
    if (!relation.isAggregation || !relation.isAggregationInverted) {
        return;
    }
    accept(
        'error',
        'This relation marks both ends with a diamond, so both the source and the target would be the whole. '
            + 'A part cannot be the whole of what it is part of: keep one diamond and drop the other.',
        { node: relation, code: 'diamond-marks-both-ends' }
    );
}

/**
 * A parthood stereotype needs the diamond that states parthood.
 *
 * `checkDiamondMeansParthood` below reads the converse -- a diamond with a
 * stereotype that is not parthood -- and between them the notation and the
 * stereotype have to agree. Written with a plain `--`, `@componenthood` says
 * parthood in one place and an ordinary association in the other, and every
 * rule that asks which end is the whole falls back to the source because
 * nothing marked it.
 *
 * Which side the diamond belongs on follows from the natures, since parthood
 * entries read (whole, part): if only the target could be the whole, that is
 * where it goes. A warning rather than an error, since the reading is
 * recoverable -- the fallback is the source end, which is usually right.
 */
export function checkParthoodUsesADiamond(relation: Relation, accept: ValidationAcceptor): void {
    const stereotype = relation.stereotype;
    if (!stereotype || !PART_WHOLE_STEREOTYPES.has(stereotype)) {
        return;
    }
    if (getRelationNotation(relation).kind !== 'association') {
        return;
    }
    const source = getRelationSource(relation);
    const target = relation.target?.ref;
    const wholeIsTarget = !!source && !!target && isClassDeclaration(source) && isClassDeclaration(target)
        && !naturesFitStereotype(stereotype, source, target)
        && naturesFitStereotype(stereotype, target, source);
    const marker = wholeIsTarget ? '"--<>"' : '"<>--"';
    accept(
        'warning',
        `"@${stereotype}" states parthood, but the notation is an ordinary association. Mark the whole with a diamond: ${marker}.`,
        {
            node: relation,
            property: 'stereotype',
            code: 'parthood-without-diamond',
            data: { side: wholeIsTarget ? 'target' : 'source' }
        }
    );
}

/**
 * Subsetting and redefinition already say which relation this one narrows, so
 * the specialization is implied rather than required.
 *
 * `(redefines Entity.parts)` names an end, an end belongs to exactly one
 * relation, and that relation is the one being specialized -- there is nothing
 * left for a `specializes` clause to establish. Demanding it would also be a
 * trap: an anonymous relation has no name for such a clause to hold, and
 * subsetting an end of one is ordinary.
 *
 * What is left is worth saying quietly. Where the relation narrowed has a
 * name, stating the specialization makes the taxonomy readable without
 * following the end reference, and gUFO writes both together --
 * `(redefines Entity.parts) Object specializes Entity.hasProperPartOf`.
 * Reported at hint severity, and available as a fix.
 *
 * The classifier half is a different question and stays an error: see
 * `checkRelationEndOverrideContext` above.
 */
export function checkOverrideSpecializesItsRelation(
    end: RelationEndMetaAttributes, accept: ValidationAcceptor
): void {
    for (const property of ['subsets', 'redefines'] as const) {
        const general = end[property]?.ref;
        if (!general) {
            continue;
        }
        const specificRelation = end.$container;
        const generalRelation = general.$container;
        const named = qualifiedRelationName(generalRelation);
        if (!named || generalRelation === specificRelation
            || specializesRelation(specificRelation, generalRelation)) {
            continue;
        }
        const verb = property === 'subsets' ? 'subsetting' : 'redefining';
        accept(
            'hint',
            `${verb[0].toUpperCase()}${verb.slice(1)} an end of "${named}" implies that this relation specializes it, which is worth saying outright.`,
            {
                node: end,
                property,
                code: 'implied-relation-specialization',
                data: { general: named }
            }
        );
    }
}

/** Whether one relation specializes another, following the chain up. */
function specializesRelation(specific: Relation, general: Relation): boolean {
    const seen = new Set<Relation>();
    let current: Relation | undefined = specific;
    while (current && !seen.has(current)) {
        seen.add(current);
        if (current === general) {
            return true;
        }
        current = current.specializes?.ref;
    }
    return false;
}

/** How a relation is written as a reference: `Source.relationName`. */
export function qualifiedRelationName(relation: Relation): string | undefined {
    const source = getRelationSourceName(relation);
    return source && relation.name ? `${source}.${relation.name}` : undefined;
}



/**
 * A read-only (`const`) end cannot become writable further down the
 * hierarchy: code holding the supertype is entitled to assume the value never
 * changes, and a subtype that relaxes it breaks that expectation.
 *
 * Reported as a warning rather than an error because UML's own
 * `Property::isConsistentWith` constrains only type and multiplicity -- this
 * follows from substitutability rather than from an explicit rule.
 */
export function checkReadOnlyNotRelaxed(end: RelationEndMetaAttributes, accept: ValidationAcceptor): void {
    for (const property of ['subsets', 'redefines'] as const) {
        const general = end[property]?.ref;
        const specific = end;
        if (!general || general === specific) {
            continue;
        }
        const generalIsConst = general.isConst;
        const specificIsConst = specific.isConst;
        if (generalIsConst && !specificIsConst) {
            const verb = property === 'subsets' ? 'subsets' : 'redefines';
            accept(
                'warning',
                `The end this ${verb} is "const", so this end should be "const" too -- otherwise a subtype makes a read-only value writable.`,
                { node: end, property, code: 'const-not-propagated' }
            );
        }
    }
}

/**
 * `addOnly` says the set of links at this end only grows: links may be added
 * and never removed.
 *
 * It says nothing where there is nothing to add -- an end fixed at a size,
 * `[1]` or `[2]` or nothing written. Beside `const` it cannot be written at
 * all: the two are alternatives in the grammar, since `const` already says
 * nothing changes. `[0..1]` is not fixed at a size: going
 * from none to one is an addition, which is why
 * `checkAccumulates` asks for `addOnly` on exactly such an end.
 */
export function checkAddOnlyEnd(end: RelationEndMetaAttributes, accept: ValidationAcceptor): void {
    if (!end.isAddOnly) {
        return;
    }
    const cardinality = getEndCardinality(end);
    const bounds = cardinality ? getBounds(cardinality) : { lower: 1, upper: 1 };
    if (bounds && bounds.lower === bounds.upper) {
        accept('warning', '"addOnly" has nothing to add to: this end always holds the same number of links. "const" is what fixes them.', {
            node: end, property: 'isAddOnly', code: 'add-only-with-nothing-to-add'
        });
    }
}

/**
 * `addOnly` where nothing changes at all.
 *
 * An end is a property of the classifier at the *opposite* end, so an end
 * belonging to an event or an abstract individual cannot change -- and a
 * collection that cannot change is not one that grows. `const` is the word.
 */
export function checkAddOnlyOnImmutableEnd(relation: Relation, accept: ValidationAcceptor): void {
    const source = getRelationSource(relation);
    const target = relation.target?.ref;
    for (const side of ['source', 'target'] as const) {
        const owner = side === 'target' ? source : target;
        const end = side === 'target' ? relation.targetMeta : relation.sourceMeta;
        if (!end?.isAddOnly || !owner || !isClassDeclaration(owner) || !hasImmutableInstances(owner)
            || end?.isConst
            // Parts and outward histories may accumulate around an otherwise
            // settled individual without changing that individual.
            || isSituationParthood(relation)
            || holdsAccumulatingHistory(relation, side)) {
            continue;
        }
        accept('warning',
            `This end is a property of "${owner.name}", whose instances cannot change, so nothing is added to it either. Write "const" instead.`,
            { node: end, property: 'isAddOnly', code: 'add-only-on-immutable', data: { side } });
    }
}

/**
 * A redefinition may strengthen what it redefines, never weaken it.
 *
 * `const` to `addOnly` is caught by `checkReadOnlyNotRelaxed`, which sees an
 * end that is not `const`. This is the other step down: an end that only grows,
 * redefined by one that may shrink.
 */
export function checkAddOnlyNotRelaxed(end: RelationEndMetaAttributes, accept: ValidationAcceptor): void {
    for (const property of ['subsets', 'redefines'] as const) {
        const general = end[property]?.ref;
        const specific = end;
        if (!general || general === specific) {
            continue;
        }
        const growsOnly = (end: typeof general): boolean =>
            (end.isAddOnly || end.isConst);
        // A `const` general is `checkReadOnlyNotRelaxed`'s to report; saying it
        // twice about one end produced two repairs writing into one decorator.
        const generalIsConst = general.isConst;
        if (!generalIsConst && growsOnly(general) && !growsOnly(specific)) {
            const verb = property === 'subsets' ? 'subsets' : 'redefines';
            accept('warning',
                `The end this ${verb} is "addOnly", so this end should be "addOnly" or "const" too -- otherwise a subtype takes back what the supertype said stays.`,
                { node: end, property, code: 'add-only-not-propagated' });
        }
    }
}

/**
 * Two ends of one relation named alike, where one classifier owns both.
 *
 * An end is a property of the classifier at the *opposite* end, so the two
 * ends of `relation Person (party) [1] -- signs -- [1] (party) Company` are
 * `Company.party` and `Person.party`: two properties of two classifiers, each
 * named for what it holds, and nothing is ambiguous about them. Reading the
 * two names alone made that an error -- and the name a modeler reaches for at
 * both ends of a symmetric relation is usually the same word.
 *
 * When the relation runs between one classifier and itself, both ends do land
 * in one namespace, and `Person.peer` then names two things.
 */
export function checkRelationEndNamesDiffer(relation: Relation, accept: ValidationAcceptor): void {
    const source: RelationEndMetaAttributes | undefined = relation.sourceMeta;
    const target: RelationEndMetaAttributes | undefined = relation.targetMeta;
    if (!source?.name || !target?.name || source.name !== target.name) {
        return;
    }
    const owner = getEndOwner(source);
    if (owner && owner === getEndOwner(target)) {
        accept('error', `Both ends of this relation are named "${source.name}", and both are properties of "${nameOf(owner)}".`,
            { node: target, property: 'name', code: 'duplicate-end-name' });
    }
}

/**
 * A stereotype the language does not define.
 *
 * The grammar accepts any word after `@` so that a slip is reported here, with
 * a suggestion, rather than as a parse error. Until this check existed the
 * word was simply ignored: every stereotype-driven rule skips what it does not
 * recognize, so `@mediaton` silently disabled the nature checking it looked
 * like it was requesting.
 */
export function checkRelationStereotypeIsKnown(relation: Relation, accept: ValidationAcceptor): void {
    const stereotype = relation.stereotype;
    if (!stereotype || isRelationStereotype(stereotype)) {
        return;
    }
    const { replacement, because } = adviseOnStereotype(stereotype);
    const reason = because ? ` -- ${because}` : '';
    const suggestion = replacement ? ` Use "@${replacement}".` : '';
    accept(
        'error',
        `"@${stereotype}" is not a relation stereotype${reason}.${suggestion}`,
        {
            node: relation,
            property: 'stereotype',
            code: 'unknown-relation-stereotype',
            ...(replacement ? { data: { closest: replacement } } : {})
        }
    );
}

/**
 * An aggregation diamond states parthood, so a stereotype that is not a
 * parthood stereotype contradicts it.
 *
 * The diamond is what makes an unstereotyped relation parthood, which is why
 * the acyclicity and supplementation rules read it. That only holds together
 * if the two never disagree: `@material [1] <>-- [1] X` would otherwise be
 * counted as parthood by one rule and as a material relation by another.
 */
export function checkDiamondMeansParthood(relation: Relation, accept: ValidationAcceptor): void {
    const stereotype = relation.stereotype;
    if (!stereotype || PART_WHOLE_STEREOTYPES.has(stereotype)) {
        return;
    }
    if (getRelationNotation(relation).kind === 'association') {
        return;
    }
    accept(
        'error',
        `The aggregation diamond states parthood, but "@${stereotype}" is not a parthood stereotype. Drop the diamond, or use one of ${[...PART_WHOLE_STEREOTYPES].map(name => `"@${name}"`).join(', ')}.`,
        { node: relation, property: 'stereotype', code: 'diamond-without-parthood' }
    );
}
