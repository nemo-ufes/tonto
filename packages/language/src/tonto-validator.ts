import type { ValidationAcceptor, ValidationCheck, ValidationChecks } from 'langium';
import { AstUtils } from 'langium';
import type { AstNode } from 'langium';
import type {
    ClassDeclaration, GeneralizationSet, Package, Relation, RelationEndMetaAttributes, TontoAstType
} from './generated/ast.js';
import type { TontoServices } from './tonto-module.js';
import { ownerOf, publicationWorkspace, validationOntology } from './publication/workspace.js';
import { resetDerivedCaches } from './utils/derived-cache.js';
import { checkOntologyIdentifiers, checkPublicationNames } from './publication/checks.js';
import {
    checkAssociationCycles,
    checkBinaryRelationBetweenOverlappingTypes,
    checkCollectiveMembersShareAKind,
    checkNonSortalSpansKinds,
    checkPhaseIsIntrinsic,
    checkImpreciseAbstraction,
    checkRelationSpecializationOpportunity,
    checkRelatorMediatingOverlappingTypes,
    checkRepeatableRelatorInstances
} from './validation/anti-patterns.js';
import {
    checkAddOnlyAttribute, checkCardinalityBounds, checkOrderedOnSingleValuedAttribute
} from './validation/cardinality-checks.js';
import { checkDocumentation, checkLegacyTextBlock } from './validation/documentation-checks.js';
import {
    checkAttributeStereotypeIsKnown,
    checkEndPointIsOptional,
    checkEventEndPointIsMandatory,
    checkImmutableAttributeIsConst,
    checkNoDuplicateAttributeStereotype,
    checkTimePointIsConst,
    checkTimePointOwnerIsConcrete
} from './validation/attribute-checks.js';
import { checkStereotypeIsImplied } from './validation/default-stereotype.js';
import type { ReverseLookup } from './validation/incoming-relations.js';
import { createReverseLookup } from './validation/incoming-relations.js';
import {
    checkAttributeNameStartsLowercase, checkRelationEndNameStartsLowercase,
    checkTypeNameStartsWithCapital
} from './validation/naming-checks.js';
import {
    checkCategorizerIsNotAPowertype, checkCategorizerUnderPowertype, checkGensetAgreesWithInstantiation,
    checkInstanceSpecializesBase, checkNoInstantiationCycle, checkPartitionInstancesAreDisjoint,
    checkPartitionsDoNotSpecialize, checkPowertypeHasBase,
    checkPowertypeHierarchyMirrorsBase, checkPowertypeInstantiationBounds, checkPowertypeIsUnique
} from './validation/mlt-checks.js';
import {
    checkAcyclicDependencies, checkConstitutionCrossesKinds,
    checkExtrinsicModeDependsOnSomething, checkHistoricalRoleUnderAntiRigid, checkMomentHasBearer,
    checkMomentHasOneBearer, checkNonSortalGeneralizesASortal, checkParthoodIsAcyclic,
    checkEventHasParticipation, checkFoundingRelationIsRequired, checkHistoricalRoleParticipatesInAnEvent, checkMaterialHasRelator,
    checkPartitionOfPhasesIsUniform, checkPhaseHasASibling,
    checkPhasesFormAPartition, checkPhaseMixinsFormAPartition,
    checkProcessIsConstituted, checkRelatorHasMediation,
    checkCollectiveHasMembers, checkRelatorMediatesTwo, checkRoleHasRelator,
    checkSubkindIsNotFoundedOnARelator, checkWeakSupplementation, checkNonSortalStatesNatures,
    checkClassDerivation
} from './validation/ufo-checks.js';
import {
    checkCompatibleNatures,
    checkMixinSpansAnEndurant,
    checkNatureConsistency,
    checkNoDisjointSupertypes,
    checkNoDuplicateGeneralization,
    checkPowerTypeClassifiesTypes,
    checkSortalSpecializesUniqueUltimateSortal,
    checkStereotypeGiven,
    checkStereotypeIsCurrent,
    checkSupertypeStereotype
} from './validation/classifier-checks.js';
import {
    checkDatatypeNatureRestriction,
    checkDatatypeSpecializationTarget,
    checkEnumerationHasLiterals,
    checkNoDatatypeAttributeCycle
} from './validation/datatype-checks.js';
import {
    checkCategorizerIsHigherOrder,
    checkGeneralizationSetConsistentKind,
    checkGeneralizationSetNoSelfGeneralization,
    checkGeneralizationSetSortalityAndRigidity,
    checkNoDuplicateSpecifics,
    checkPartitionHasSeveralSpecifics
} from './validation/genset-checks.js';
import { checkImports, checkNoDuplicatePackageNamesInDocument } from './validation/import-checks.js';
import {
    checkAccumulates, checkCharacterizationBearerCardinality, checkCharacterizationIsReified,
    checkCreationEndIsConst, checkDependenceEndIsConst, checkDependenceEndIsMandatory,
    checkImmutableEndIsConst, checkHistoricalEventSourceCanLapse, checkParthoodNatures,
    checkParticipationalPortionHasOneParticipant, checkParticipationalPortionParticipantsAgree,
    checkRelationStereotypeNatures
} from './validation/relation-nature-checks.js';
import {
    checkEssentialPartOfAntiRigidWhole, checkQuantityPartsAreEssential, checkSubCollectionMultiplicity,
    checkSubQuantityIsExclusive, checkSubQuantityMultiplicity
} from './validation/parthood-meta-checks.js';
import { AntiPatternSetting } from './validation/anti-pattern-setting.js';
import {
    checkClassDeclarationMembers,
    checkDatatypeMembers,
    checkEnumerationMembers,
    checkInstanceOfTargetIsHigherOrder
} from './validation/member-checks.js';
import {
    checkNoCircularSpecialization, checkNoDuplicateDeclarationNames, checkPackageHasName,
    checkPackageNameIsLowerCase
} from './validation/package-checks.js';
import {
    checkInverseEndsAgree,
    checkInverseOfIsSymmetric,
    checkMatchingInverse,
    checkAddOnlyEnd,
    checkAddOnlyNotRelaxed,
    checkAddOnlyOnImmutableEnd,
    checkReadOnlyNotRelaxed,
    checkEndDecoratorSaysSomething,
    checkRelationEndDoesNotSubsetOrRedefineItself,
    checkRelationEndNamesDiffer,
    checkOverrideSpecializesItsRelation,
    checkParthoodAgreesWithSpecialization,
    checkParthoodUsesADiamond,
    checkRelationEndOverrideContext,
    checkRelationEndOverrideNarrows,
    checkShortReferenceIsUnambiguous,
    checkShortRelationReferenceIsUnambiguous,
    checkRelationSpecializationNarrows,
    checkRelationHasTarget,
    checkValueRelationMayBeAttribute,
    checkDiamondMarksOneEndOnly,
    checkRelationStereotypeIsKnown,
    checkDiamondMeansParthood
} from './validation/relation-checks.js';
import {
    checkDerivationIsGrounded, checkDerivationIsWellFormed, checkMaterialCardinalitiesAreDerived
} from './validation/derivation-checks.js';

export function registerValidationChecks(services: TontoServices): AntiPatternSetting {
    const registry = services.validation.ValidationRegistry;
    // Off unless `tonto.antiPatterns` says otherwise; see the class comment.
    const antiPatterns = new AntiPatternSetting(services.shared);
    const indexManager = services.shared.workspace.IndexManager;
    const publication = publicationWorkspace(services.shared);
    const reverse = createReverseLookup(
        indexManager, services.shared.workspace.LangiumDocuments, services.workspace.AstNodeLocator);
    // What it remembers is derived from resolved references, so it must not
    // outlive a change to any document. Wired to this workspace's builder,
    // which is what owns it: registering the reset in the module-level
    // registry instead kept every session that ever ran alive, index and all.
    services.shared.workspace.DocumentBuilder.onUpdate(() => reverse.reset());

    /**
     * Packages that declare one `@namespace` publish their terms into it
     * together, so a classifier name may be used by only one of them: two
     * `Person`s would be one IRI. Reads every package in the workspace, since
     * the other may be in any file.
     */
    const checkNamespaceNamesAreUnique = (pkg: Package, accept: ValidationAcceptor): void => {
        checkOntologyIdentifiers(pkg, accept);
    };

    // The two rules that count what refers to a type rather than what it
    // declares, bound to the workspace-wide lookup.
    const relatorMediatesTwo = (node: ClassDeclaration, accept: ValidationAcceptor): void =>
        checkRelatorMediatesTwo(reverse, node, accept);
    const materialHasRelator = (node: Relation, accept: ValidationAcceptor): void =>
        checkMaterialHasRelator(reverse, node, accept);
    const derivationIsGrounded = (node: Relation, accept: ValidationAcceptor): void =>
        checkDerivationIsGrounded(reverse, node, accept);
    const materialCardinalitiesAreDerived = (node: Relation, accept: ValidationAcceptor): void =>
        checkMaterialCardinalitiesAreDerived(reverse, node, accept);
    const foundingRelationIsRequired = (node: Relation, accept: ValidationAcceptor): void =>
        checkFoundingRelationIsRequired(reverse, node, accept);
    const relatorHasMediation = (node: ClassDeclaration, accept: ValidationAcceptor): void =>
        checkRelatorHasMediation(reverse, node, accept);
    const eventHasParticipation = (node: ClassDeclaration, accept: ValidationAcceptor): void =>
        checkEventHasParticipation(reverse, node, accept);
    // Reads the workspace, unlike its neighbors in that file: see the comment
    // on the check.
    const nonSortalSpansKinds = (node: ClassDeclaration, accept: ValidationAcceptor): void =>
        checkNonSortalSpansKinds(reverse, node, accept);
    // The general may be any relation in the workspace, so the diagnostic
    // carries its path rather than the node, which has to survive JSON.
    const locate = (node: AstNode): string =>
        `${AstUtils.getDocument(node).uri.toString()}#${services.workspace.AstNodeLocator.getAstNodePath(node)}`;
    const parthoodAgrees = (node: Relation, accept: ValidationAcceptor): void =>
        checkParthoodAgreesWithSpecialization(
            locate, node, accept);
    const relationSpecializationNarrows = (node: Relation, accept: ValidationAcceptor): void =>
        checkRelationSpecializationNarrows(locate, node, accept);
    const matchingInverse = (node: Relation, accept: ValidationAcceptor): void =>
        checkMatchingInverse(reverse, locate, node, accept);
    const shortReferenceIsUnambiguous = (node: RelationEndMetaAttributes, accept: ValidationAcceptor): void =>
        checkShortReferenceIsUnambiguous(reverse, node, accept);
    const shortRelationReferenceIsUnambiguous = (node: Relation, accept: ValidationAcceptor): void =>
        checkShortRelationReferenceIsUnambiguous(reverse, node, accept);
    const powertypeHasBase = (node: ClassDeclaration, accept: ValidationAcceptor): void =>
        checkPowertypeHasBase(reverse, node, accept);
    const powertypeIsUnique = (node: ClassDeclaration, accept: ValidationAcceptor): void =>
        checkPowertypeIsUnique(reverse, node, accept);
    const gensetAgreesWithInstantiation = (node: GeneralizationSet, accept: ValidationAcceptor): void =>
        checkGensetAgreesWithInstantiation(reverse, locate, node, accept);
    /** Binds the workspace lookup into an MLT check, which all of them need. */
    const bindMlt = (
        check: (lookup: ReverseLookup, node: ClassDeclaration, accept: ValidationAcceptor) => void
    ) => (node: ClassDeclaration, accept: ValidationAcceptor): void => check(reverse, node, accept);
    const momentHasBearer = (node: ClassDeclaration, accept: ValidationAcceptor): void =>
        checkMomentHasBearer(reverse, node, accept);
    const extrinsicModeDepends = (node: ClassDeclaration, accept: ValidationAcceptor): void =>
        checkExtrinsicModeDependsOnSomething(reverse, node, accept);
    const processIsConstituted = (node: ClassDeclaration, accept: ValidationAcceptor): void =>
        checkProcessIsConstituted(reverse, node, accept);
    const roleHasRelator = (node: ClassDeclaration, accept: ValidationAcceptor): void =>
        checkRoleHasRelator(reverse, node, accept);
    const subkindNotFoundedOnRelator = (node: ClassDeclaration, accept: ValidationAcceptor): void =>
        checkSubkindIsNotFoundedOnARelator(reverse, node, accept);
    const historicalRoleHasEvent = (node: ClassDeclaration, accept: ValidationAcceptor): void =>
        checkHistoricalRoleParticipatesInAnEvent(reverse, node, accept);
    const participationalPortionHasOneParticipant = (node: Relation, accept: ValidationAcceptor): void =>
        checkParticipationalPortionHasOneParticipant(reverse, node, accept);

    const checks: ValidationChecks<TontoAstType> = {
        Model: [
            (model, accept) => {
                checkPublicationNames(model, accept, publication.isPublication || AstUtils.getDocument(model).uri.scheme.startsWith('http'));
                for (const problem of publication.problems) {
                    if (AstUtils.getDocument(problem.node).parseResult.value === model) {
                        accept(problem.warning ? 'warning' : 'error', problem.message, { node: problem.node, property: problem.property as never, code: problem.code });
                    }
                }
            },
            checkImports,
            checkNoDuplicatePackageNamesInDocument,
            checkDocumentation,
            antiPatterns.gate(checkAssociationCycles)
        ],
        LegacyTextBlock: [checkLegacyTextBlock],
        Package: [
            checkPackageHasName,
            checkPackageNameIsLowerCase,
            checkNoDuplicateDeclarationNames,
            checkNoCircularSpecialization,
            checkNamespaceNamesAreUnique
        ],
        ClassDeclaration: [
            checkStereotypeGiven,
            checkStereotypeIsCurrent,
            checkPowerTypeClassifiesTypes,
            checkCompatibleNatures,
            checkMixinSpansAnEndurant,
            checkNatureConsistency,
            checkSupertypeStereotype,
            checkSortalSpecializesUniqueUltimateSortal,
            bindMlt(checkClassDeclarationMembers),
            checkInstanceOfTargetIsHigherOrder,
            checkNoDisjointSupertypes,
            checkNoDuplicateGeneralization,
            bindMlt(checkNonSortalGeneralizesASortal),
            bindMlt(checkNonSortalStatesNatures),
            // Multi-level theory (Carvalho, Almeida & Guizzardi 2016).
            powertypeHasBase,
            powertypeIsUnique,
            bindMlt(checkPowertypeInstantiationBounds),
            bindMlt(checkNoInstantiationCycle),
            (node: ClassDeclaration, accept: ValidationAcceptor): void =>
                checkCategorizerUnderPowertype(reverse, locate, node, accept),
            (node: ClassDeclaration, accept: ValidationAcceptor): void =>
                checkPowertypeHierarchyMirrorsBase(reverse, locate, node, accept),
            bindMlt(checkPartitionsDoNotSpecialize),
            // gufoshapes (nemo-ufes), read from the instance side.
            (node: ClassDeclaration, accept: ValidationAcceptor): void =>
                checkInstanceSpecializesBase(reverse, locate, node, accept),
            bindMlt(checkPartitionInstancesAreDisjoint),
            // UFO 2021 axioms about dependence and mereology.
            bindMlt(checkWeakSupplementation),
            bindMlt(checkCollectiveHasMembers),
            bindMlt(checkAcyclicDependencies),
            bindMlt(checkMomentHasOneBearer),
            bindMlt(checkConstitutionCrossesKinds),
            checkTypeNameStartsWithCapital,
            bindMlt(checkParthoodIsAcyclic),
            bindMlt(checkPhasesFormAPartition),
            bindMlt(checkPhaseMixinsFormAPartition),
            bindMlt(checkPhaseHasASibling),
            checkHistoricalRoleUnderAntiRigid,
            relatorMediatesTwo,
            relatorHasMediation,
            eventHasParticipation,
            momentHasBearer,
            extrinsicModeDepends,
            processIsConstituted,
            roleHasRelator,
            subkindNotFoundedOnRelator,
            historicalRoleHasEvent,
            bindMlt(checkClassDerivation),
            bindMlt(checkParticipationalPortionParticipantsAgree),
            // Anti-patterns (Sales & Guizzardi 2015), reported at info severity.
            antiPatterns.gate(checkRelatorMediatingOverlappingTypes),
            antiPatterns.gate(checkRepeatableRelatorInstances),
            antiPatterns.gate(checkPhaseIsIntrinsic),
            antiPatterns.gate(nonSortalSpansKinds)
        ],
        Datatype: [
            checkTypeNameStartsWithCapital,
            checkDatatypeNatureRestriction,
            checkDatatypeSpecializationTarget,
            checkDatatypeMembers,
            checkNoDatatypeAttributeCycle
        ],
        Enumeration: [
            checkTypeNameStartsWithCapital,
            checkDatatypeNatureRestriction,
            checkDatatypeSpecializationTarget,
            checkEnumerationMembers,
            checkEnumerationHasLiterals
        ],
        GeneralizationSet: [
            checkGeneralizationSetConsistentKind,
            checkGeneralizationSetNoSelfGeneralization,
            checkGeneralizationSetSortalityAndRigidity,
            checkNoDuplicateSpecifics,
            checkCategorizerIsHigherOrder,
            checkCategorizerIsNotAPowertype,
            gensetAgreesWithInstantiation,
            checkPartitionHasSeveralSpecifics,
            checkPartitionOfPhasesIsUniform
        ],
        Relation: [
            checkRelationHasTarget,
            checkValueRelationMayBeAttribute,
            checkDiamondMarksOneEndOnly,
            materialHasRelator,
            checkDerivationIsWellFormed,
            derivationIsGrounded,
            materialCardinalitiesAreDerived,
            foundingRelationIsRequired,
    checkRelationStereotypeIsKnown,
            checkDiamondMeansParthood,
            parthoodAgrees,
    checkParthoodUsesADiamond,
            relationSpecializationNarrows,
            checkInverseOfIsSymmetric,
            checkInverseEndsAgree,
            matchingInverse,
            checkRelationEndNamesDiffer,
            antiPatterns.gate(checkBinaryRelationBetweenOverlappingTypes),
            antiPatterns.gate(checkImpreciseAbstraction),
            antiPatterns.gate(checkRelationSpecializationOpportunity),
            antiPatterns.gate(checkCollectiveMembersShareAKind),
                    checkRelationStereotypeNatures,
            checkParthoodNatures,
            checkQuantityPartsAreEssential,
            checkSubQuantityMultiplicity,
            checkSubQuantityIsExclusive,
            checkSubCollectionMultiplicity,
            checkEssentialPartOfAntiRigidWhole,
            checkCharacterizationBearerCardinality,
            participationalPortionHasOneParticipant,
            checkImmutableEndIsConst,
            checkAddOnlyOnImmutableEnd,
            checkAccumulates,
            checkHistoricalEventSourceCanLapse,
            checkCharacterizationIsReified,
            checkDependenceEndIsConst,
            checkCreationEndIsConst,
            checkDependenceEndIsMandatory,
            checkStereotypeIsImplied,
            shortRelationReferenceIsUnambiguous
        ],
        RelationEndMetaAttributes: [
            checkEndDecoratorSaysSomething,
    checkRelationEndDoesNotSubsetOrRedefineItself,
            (node: RelationEndMetaAttributes, accept: ValidationAcceptor): void =>
                checkRelationEndOverrideNarrows(locate, node, accept),
            checkOverrideSpecializesItsRelation,
            (node: RelationEndMetaAttributes, accept: ValidationAcceptor): void =>
                checkRelationEndOverrideContext(locate, node, accept),
            shortReferenceIsUnambiguous,
                    checkAddOnlyEnd,
            checkAddOnlyNotRelaxed,
            checkReadOnlyNotRelaxed,
            checkRelationEndNameStartsLowercase
        ],
        Cardinality: [checkCardinalityBounds],
        Attribute: [
            checkOrderedOnSingleValuedAttribute,
            checkAddOnlyAttribute,
            checkAttributeNameStartsLowercase,
            checkAttributeStereotypeIsKnown,
            checkNoDuplicateAttributeStereotype,
            checkTimePointOwnerIsConcrete,
            checkTimePointIsConst,
                    checkEndPointIsOptional,
            checkEventEndPointIsMandatory,
            checkImmutableAttributeIsConst
        ]
    };
    let previousOntology: ReturnType<typeof ownerOf>;
    const contextual = Object.fromEntries(Object.entries(checks).map(([type, callbacks]) => [type,
        [callbacks].flat().map(callback => {
            const check = callback as ValidationCheck;
            // An ontology whose closure did not load is checked for names
            // and ownership only, never as though the import were absent.
            const structural = type === 'Model' || type === 'Package';
            return ((node, accept, token) => {
                const unit = ownerOf(node);
                if (unit?.incomplete && !structural) return;
                if (previousOntology !== unit) { resetDerivedCaches(); previousOntology = unit; }
                return validationOntology.run(unit, () => check(node, accept, token));
            }) as ValidationCheck;
        })]));
    registry.register(contextual);
    return antiPatterns;
}
