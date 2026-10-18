import type { AstNode, ValidationAcceptor } from 'langium';
import type { ClassDeclaration, GeneralizationSet } from '../generated/ast.js';
import { isClassDeclaration } from '../generated/ast.js';
import { cannotShareInstances } from '../utils/disjointness.js';
import { collectAncestors, isSameOrSpecializes } from '../utils/generalizations.js';
import {
    basesOf, crossLevelsFrom, crossLevelsInto, instancesOf, isCardelliMultiplicity,
    isCharacterizationLink, isPowertypeLink, partitionsBase
} from '../utils/mlt-graph.js';
import { findCycle } from '../utils/relation-graph.js';
import { chain } from './wording.js';
import { formatBounds } from './cardinality-checks.js';
import type { ReverseLookup } from './incoming-relations.js';

/**
 * Rules from MLT, the multi-level theory of Carvalho, Almeida & Guizzardi
 * ("Using a Well-Founded Multi-Level Theory to Support the Analysis and
 * Representation of the Powertype Pattern in Conceptual Modeling", CAiSE
 * 2016), which derives syntactic constraints for the powertype pattern from
 * an axiomatized theory rather than from UML's informal account.
 *
 * The paper's central point is that UML confounds two different notions under
 * one word. Cardelli's powertype has *all* specializations of the base type as
 * instances, the base type included; Odell's has only proper specializations,
 * and only those a classification criterion picks out. tonto already spells
 * the two apart -- `powertype` and `type` -- so the constraints attach
 * cleanly.
 */

/**
 * "Models in which the powertype stereotype is applied to types that are not
 * target of any instantiation association are deemed syntactically invalid."
 *
 * A powertype is defined by the type it is the powertype *of*; without that
 * link the stereotype asserts nothing. Counted across the workspace, since the
 * instantiation is normally written beside the base type.
 */
export function checkPowertypeHasBase(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    if (!classDeclaration.isPowerType) {
        return;
    }
    if (crossLevelsInto(lookup, classDeclaration).length > 0) {
        return;
    }
    accept(
        'error',
        `Powertype "${classDeclaration.name}" is the powertype of nothing. Add an "@instantiation" from its base type, or an "instanceOf" clause naming it.`,
        { node: classDeclaration, property: 'name', code: 'powertype-without-base' }
    );
}

/**
 * "A type may not have more than one powertype and a higher order type may be
 * a powertype of at most one other type."
 *
 * `isPowertypeOf` is a bijection between adjacent orders: the extension of a
 * Cardelli powertype is fixed entirely by its base, so two bases would have to
 * have the same specializations, and two powertypes of one base would be the
 * same type.
 */
export function checkPowertypeIsUnique(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    if (classDeclaration.isPowerType) {
        const bases = basesOf(lookup, classDeclaration);
        if (bases.length > 1) {
            accept(
                'error',
                `A powertype is the powertype of exactly one type, but "${classDeclaration.name}" is instantiated by ${bases.map(base => `"${base.name}"`).join(', ')}.`,
                { node: classDeclaration, property: 'name', code: 'powertype-not-unique' }
            );
        }
        return;
    }
    const powertypes = distinct(crossLevelsFrom(lookup, classDeclaration).filter(isPowertypeLink).map(link => link.higher));
    if (powertypes.length > 1) {
        accept(
            'error',
            `A type has at most one powertype, but "${classDeclaration.name}" instantiates ${powertypes.map(p => `"${p.name}"`).join(' and ')}.`,
            { node: classDeclaration, property: 'name', code: 'powertype-not-unique' }
        );
    }
}

/**
 * "According to Cardelli's notion of powertype the base type itself is
 * instance of the higher-order type. Thus the lower bound multiplicity of the
 * instantiation association must be set to one and the upper bound to many."
 *
 * Both bounds are forced, so anything but `[1..*]` is wrong, and each way of
 * being wrong says something different:
 *
 * - an upper bound of one denies the subtypes, when every specialization of
 *   the base is an instance too;
 * - a lower bound of zero denies the base type itself, which specializes
 *   itself and so is always an instance;
 * - `[2..*]` denies a base type with no subtypes yet, whose only instance is
 *   itself.
 *
 * A warning rather than an error: a taxonomy under construction passes through
 * these states, and the repair is unambiguous.
 */
export function checkPowertypeInstantiationBounds(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    for (const link of crossLevelsFrom(lookup, classDeclaration)) {
        if (!isPowertypeLink(link) || !link.relation || isCardelliMultiplicity(link.bounds)) {
            continue;
        }
        const bounds = link.bounds;
        if (!bounds) {
            continue;
        }
        const reasons: string[] = [];
        if (bounds.upper === 1) {
            reasons.push('every specialization of the base type is an instance too, so the upper bound must be "*"');
        }
        if (bounds.lower === 0) {
            reasons.push(`"${classDeclaration.name}" specializes itself and so always instantiates "${link.higher.name}", making the lower bound 1`);
        }
        if (bounds.lower > 1) {
            reasons.push(`its base type instantiates "${link.higher.name}" once whether or not anything specializes it, so the lower bound is 1`);
        }
        const written = link.relation.targetCardinality
            ? formatBounds(link.relation.targetCardinality)
            : '[1], which is what an omitted multiplicity means';
        accept(
            'warning',
            `The powertype end of this "@instantiation" is ${written}, but a Cardelli powertype admits only "[1..*]": ${reasons.join('; and ')}.`,
            {
                node: link.relation.targetCardinality ?? link.relation,
                ...(link.relation.targetCardinality ? {} : { property: 'target' as const }),
                code: 'powertype-instantiation-multiplicity'
            }
        );
    }
}

/**
 * "There should be no generalization set anchored in types stereotyped
 * powertype -- powertype relations do not give rise to generalization sets."
 *
 * A generalization set states a classification *criterion*, which is what an
 * Odell `type` supplies. A Cardelli powertype has every specialization as an
 * instance whatever criterion produced it, so it partitions nothing and has no
 * generalization set to anchor.
 */
export function checkCategorizerIsNotAPowertype(genset: GeneralizationSet, accept: ValidationAcceptor): void {
    genset.categorizers.forEach((ref, index) => {
        const categorizer = ref.ref;
        if (categorizer && isClassDeclaration(categorizer) && categorizer.isPowerType) {
            accept(
                'error',
                `"${categorizer.name}" is a power type, so it supplies no classification criterion and cannot categorize a generalization set. A high-order type categorizes; a power type holds every specialization whatever the criterion.`,
                { node: genset, property: 'categorizers', index, code: 'powertype-as-categorizer' }
            );
        }
    });
}

/**
 * "Cycles of associations stereotyped instantiation are not allowed", since a
 * cross-level link puts its source exactly one order below its target and a
 * cycle would put a type below itself.
 */
export function checkNoInstantiationCycle(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    const path = findCycle(classDeclaration, node => crossLevelsFrom(lookup, node).map(link => link.higher));
    if (!path) {
        return;
    }
    accept(
        'error',
        `Instantiation raises the order by one, so it cannot come back round: ${chain([classDeclaration.name, ...path], 'is an instance of', false)}.`,
        { node: classDeclaration, property: 'name', code: 'instantiation-cycle' }
    );
}


/**
 * "If a type t' is powertype of a type t and a type t'' characterizes the same
 * base type t then all instances of t'' are also instances of t' and thus t''
 * proper specializes t'."
 *
 * Everything a criterion picks out of the base type's specializations is a
 * specialization of the base type, and a Cardelli powertype has all of those
 * as instances. So a categorizer of a type that has a powertype sits beneath
 * that powertype.
 */
export function checkCategorizerUnderPowertype(
    lookup: ReverseLookup, locate: (node: AstNode) => string,
    classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    const links = crossLevelsFrom(lookup, classDeclaration);
    const powertype = links.find(isPowertypeLink)?.higher;
    if (!powertype) {
        return;
    }
    for (const link of links.filter(isCharacterizationLink)) {
        if (isSameOrSpecializes(link.higher, powertype)) {
            continue;
        }
        accept(
            // A warning, where the rest of the multi-level family errs: what
            // is missing is a generalization the model already implies rather
            // than something it gets wrong. Everything the categorizer
            // classifies *is* an instance of the powertype -- the taxonomy has
            // simply not been asked to say so, and the repair says it.
            'warning',
            `"${link.higher.name}" categorizes "${classDeclaration.name}", whose powertype is "${powertype.name}". Everything "${link.higher.name}" classifies is a specialization of "${classDeclaration.name}" and so an instance of "${powertype.name}", so "${link.higher.name}" must specialize "${powertype.name}".`,
            {
                node: link.relation ?? classDeclaration,
                ...(link.relation ? {} : { property: 'name' as const }),
                code: 'categorizer-not-under-powertype',
                // Which class would have to specialize which, as a path: the
                // categorizer may be declared in another file.
                data: { subject: locate(link.higher), supertype: powertype.name }
            }
        );
    }
}

/**
 * "If a type t specializes a type t' then the powertype of t specializes the
 * powertype of t'."
 *
 * The specializations of a subtype are among the specializations of its
 * supertype, and a powertype's instances are exactly those specializations, so
 * the powertype hierarchy mirrors the base hierarchy.
 */
export function checkPowertypeHierarchyMirrorsBase(
    lookup: ReverseLookup, locate: (node: ClassDeclaration) => string,
    classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    const own = crossLevelsFrom(lookup, classDeclaration).find(isPowertypeLink)?.higher;
    if (!own) {
        return;
    }
    for (const ancestor of collectAncestors(classDeclaration)) {
        const theirs = crossLevelsFrom(lookup, ancestor).find(isPowertypeLink)?.higher;
        if (!theirs || theirs === own || isSameOrSpecializes(own, theirs)) {
            continue;
        }
        accept(
            'error',
            `"${classDeclaration.name}" specializes "${ancestor.name}", so its powertype "${own.name}" must specialize "${ancestor.name}"'s powertype "${theirs.name}".`,
            {
                node: classDeclaration, property: 'name', code: 'powertype-hierarchy-mismatch',
                data: { subject: locate(own), supertype: qualifiedName(theirs) }
            }
        );
        return;
    }
}

/**
 * "If two types t' and t'' both partition the same type t then it is not
 * possible for t' to specialize t''."
 *
 * Two partitions of one base type cut it along independent criteria -- age and
 * gender, say -- and every individual is in exactly one class of each. A
 * specialization between them would force the two criteria to agree.
 */
export function checkPartitionsDoNotSpecialize(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    const partitioners = crossLevelsFrom(lookup, classDeclaration)
        .filter(link => isCharacterizationLink(link) && partitionsBase(link))
        .map(link => link.higher);
    for (const one of partitioners) {
        for (const other of partitioners) {
            if (one !== other && isSameOrSpecializes(one, other)) {
                accept(
                    'error',
                    `"${one.name}" and "${other.name}" both partition "${classDeclaration.name}", so they cut it along independent criteria and neither may specialize the other.`,
                    { node: classDeclaration, property: 'name', code: 'partition-specializes-partition' }
                );
                return;
            }
        }
    }
}

/**
 * Table 3 -- the combinations of an instantiation multiplicity with a
 * generalization set's own constraints that the paper marks *invalid*.
 *
 * The two say different things and UML lets them contradict each other: the
 * multiplicity constrains how many instances of the higher-order type an
 * individual instantiates, while `complete`/`disjoint` constrain only the
 * subtypes actually enumerated. Two combinations cannot both hold:
 *
 * - a lower bound of zero says some individual instantiates none of them,
 *   which a `complete` set denies;
 * - an upper bound of one says no individual instantiates two, which an
 *   overlapping (non-`disjoint`) set asserts is possible.
 */
export function checkGensetAgreesWithInstantiation(
    lookup: ReverseLookup, locate: (node: AstNode) => string,
    genset: GeneralizationSet, accept: ValidationAcceptor
): void {
    const general = genset.general?.ref;
    if (!general || !isClassDeclaration(general)) {
        return;
    }
    for (const ref of genset.categorizers) {
        const categorizer = ref.ref;
        if (!categorizer || !isClassDeclaration(categorizer)) {
            continue;
        }
        for (const link of crossLevelsInto(lookup, categorizer)) {
            if (link.base !== general || !link.bounds) {
                continue;
            }
            const written = link.relation?.targetCardinality
                ? formatBounds(link.relation.targetCardinality)
                : '[1]';
            const startsAtZero = genset.complete && link.bounds.lower === 0;
            const stopsAtOne = !genset.disjoint && link.bounds.upper === 1;
            if (startsAtZero && stopsAtOne) {
                // A set that is complete and overlapping constrains both ends
                // of the multiplicity, and only one repair satisfies both --
                // so it is said once, rather than as two complaints that fix
                // each other in turn.
                report(
                    `"complete" says every "${general.name}" instantiates one of them and the set's overlapping says two may, so the bound has to start at one and reach past it`,
                    'both'
                );
            } else if (startsAtZero) {
                report(
                    `its lower bound of 0 says some "${general.name}" instantiates no "${categorizer.name}", which "complete" denies`,
                    'lower'
                );
            } else if (stopsAtOne) {
                report(
                    `its upper bound of 1 says no "${general.name}" instantiates two of them, which an overlapping set asserts is possible`,
                    'upper'
                );
            }

            function report(why: string, bound: 'lower' | 'upper' | 'both'): void {
                accept(
                    'error',
                    `Generalization set "${genset.name}" contradicts the "@instantiation" ${written} that categorizes "${general!.name}": ${why}.`,
                    {
                        node: genset,
                        property: 'name',
                        code: 'genset-contradicts-instantiation',
                        // Which bound is the contradicted one, and where the
                        // multiplicity that carries it is written -- as a
                        // path, since the relation may be in another file.
                        data: {
                            bound,
                            instantiation: link.relation ? locate(link.relation) : undefined
                        }
                    }
                );
            }
        }
    }
}

function distinct(nodes: ClassDeclaration[]): ClassDeclaration[] {
    return [...new Set(nodes)];
}

/**
 * gufoshapes `CategorizationShape` -- "Instances of a categorizing higher-order
 * type must be subclasses of the categorized base type."
 *
 * This is D3 and D4 read from the instance side. A higher-order type
 * classifies specializations of its base and nothing else, so a class declared
 * `instanceOf` it has to be one of them. Which kind of specialization depends
 * on the theory the stereotype picks:
 *
 * - a `type` characterizes (D4), whose instances are *proper* specializations,
 *   so the base type itself is not among them;
 * - a `powertype` (D3) has every specialization as an instance, the base type
 *   included, so an improper one is fine.
 */
export function checkInstanceSpecializesBase(
    lookup: ReverseLookup, locate: (node: ClassDeclaration) => string,
    classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    const higher = classDeclaration.instanceOf?.ref;
    if (!higher || !isClassDeclaration(higher)) {
        return;
    }
    for (const base of basesOf(lookup, higher)) {
        if (base === classDeclaration) {
            if (!higher.isPowerType) {
                accept(
                    'error',
                    `"${higher.name}" categorizes "${base.name}", and a categorizer's instances are proper specializations of what it categorizes, so "${classDeclaration.name}" cannot be an instance of it. "isPowerType" is the reading that includes the base type itself.`,
                    {
                        node: classDeclaration, property: 'instanceOf', code: 'instance-is-its-own-base',
                        data: { subject: locate(higher) }
                    }
                );
            }
            continue;
        }
        if (isSameOrSpecializes(classDeclaration, base)) {
            continue;
        }
        accept(
            'error',
            `"${classDeclaration.name}" is an instance of "${higher.name}", which classifies specializations of "${base.name}", so "${classDeclaration.name}" must specialize "${base.name}".`,
            {
                node: classDeclaration, property: 'instanceOf', code: 'instance-not-specializing-base',
                data: { supertype: qualifiedName(base) }
            }
        );
    }
}

/**
 * gufoshapes `PartitionPairwiseDisjointnessShape` -- "Instances of the
 * partitioning type are not declared disjoint."
 *
 * A partition puts every individual in exactly one of its classes (D7), so the
 * classes instantiating a partitioning type cannot share instances. Declaring
 * them in a `disjoint` generalization set is how a tonto model says so; left
 * undeclared, the model asserts the partition and then permits an overlap that
 * contradicts it.
 *
 * Undeclared, not merely undeclared *here*: a disjointness above them reaches
 * them, two ultimate sortals settle it without any set at all, and natures
 * with nothing in common leave nothing to overlap. `cannotShareInstances`
 * reads all three, and asking only for the declaration reported models that
 * had already said it.
 *
 * Reported once per partitioning type, on the first undeclared pair, since a
 * partition of five classes would otherwise raise ten near-identical
 * complaints.
 */
export function checkPartitionInstancesAreDisjoint(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    const partitioned = crossLevelsFrom(lookup, classDeclaration)
        .filter(link => isCharacterizationLink(link) && partitionsBase(link));
    for (const link of partitioned) {
        const members = instancesOf(lookup, link.higher);
        // "Once per partitioning type": break out of this link's own pair
        // search, not the whole function, so a class partitioned two
        // independent ways is checked -- and warned about -- both ways.
        pairs: for (let i = 0; i < members.length; i++) {
            for (let j = i + 1; j < members.length; j++) {
                if (cannotShareInstances(members[i], members[j])) {
                    continue;
                }
                accept(
                    'warning',
                    `"${link.higher.name}" partitions "${classDeclaration.name}", so each "${classDeclaration.name}" is an instance of exactly one of its instances -- but "${members[i].name}" and "${members[j].name}" are not declared disjoint.`,
                    { node: classDeclaration, property: 'name', code: 'partition-instances-not-disjoint' }
                );
                break pairs;
            }
        }
    }
}

/** How a class is written as a reference from elsewhere in its package. */
function qualifiedName(classDeclaration: ClassDeclaration): string {
    return classDeclaration.name;
}
