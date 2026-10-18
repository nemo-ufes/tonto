import type {
    AstNode, AstNodeLocator, CstNode, IndexManager, LangiumDocument, LangiumDocuments,
    Reference, ReferenceDescription
} from 'langium';
import { AstUtils, CstUtils, GrammarAST, GrammarUtils, URI, isReference } from 'langium';
import type { AstReflection, ScopeProvider } from 'langium';
import type { CodeActionProvider, LangiumServices } from 'langium/lsp';
import type { CodeAction, CodeActionParams, Command, Diagnostic, Position, Range, TextEdit } from 'vscode-languageserver';
import { CodeActionKind } from 'vscode-languageserver';
import { DocumentValidator } from 'langium';
import { importCandidates, importEdit, importRepairIsValid } from '../publication/import-assist.js';
import { bundleTargets, ownerOf, publicationWorkspace } from '../publication/workspace.js';
import type { LinkingErrorData } from 'langium';
import type {
    Attribute, Cardinality, ClassDeclaration, Classifier, Datatype, EnumLiteral, Enumeration, GeneralizationSet, LegacyTextBlock,
    Import, Model, Package, Relation, RelationEndMetaAttributes
} from '../generated/ast.js';
import {
    isAttribute, isCardinality, isClassDeclaration, isClassifier, isDatatype, isEnumeration, isEnumLiteral, isLanguageText,
    isLegacyTextBlock, isExternalRelation, isGeneralizationSet, isImport, isPackage, isRelation,
    isRelationEndMetaAttributes, isOntology
} from '../generated/ast.js';
import { findDisjointConflict, gensetsDeclaringDisjoint } from '../utils/disjointness.js';
import {
    collectAncestors, getDirectGeneralizations, isSameOrSpecializes
} from '../utils/generalizations.js';
import { fromUnrelatedBranches, membersInScopeOf } from '../utils/inherited-members.js';
import { getEndCardinality, getNamedEnds } from '../utils/relations.js';
import { isParthood, wholeEndOf } from '../utils/relations.js';
import { getBounds } from '../validation/cardinality-checks.js';
import { collectMembers } from '../validation/member-checks.js';
import { distance, inverseKeepsStereotype } from '../validation/relation-stereotypes.js';
import { PART_WHOLE_STEREOTYPES } from '../validation/relation-nature-table.js';
import { lowerCasePackageName } from '../validation/package-checks.js';
import {
    bundleMember, ontologyForPackage, placeOntologyTag, createBundledPackage, declareOwner, ownerRenames, removeOwner, splitOneFileOntology, useKeyword,
    wrapLooseDeclarations
} from './ontology-actions.js';
import {
    canBePartOf, naturesFitStereotype, stereotypeFitsEnds, stereotypesAdmissibleAt
} from '../validation/relation-end-natures.js';
import { getRelationNotation, getRelationSource, getRelationSourceName } from '../utils/relations.js';
import { getMediations } from '../validation/anti-patterns.js';
import { groundingRelators, localPhasesOf, naturesBeneath, subtypesOf } from '../validation/ufo-checks.js';
import {
    admits, derivedMaterialCardinalities, mediationsInDocumentOrder, writeMultiplicity
} from '../validation/derivation-checks.js';
import { foundingCandidatesInto, foundsHistorically } from '../utils/founding.js';
import { ultimateSortalOf } from '../utils/relation-graph.js';
import {
    participationalParthoods, portionParticipantConflict, stillAdmitsWhenNarrowed, wholeOf
} from '../validation/relation-nature-checks.js';
import { declarationsFor, insertionAfter } from './create-missing-class.js';
import type { ReverseLookup } from '../validation/incoming-relations.js';
import { outgoingByStereotype } from '../validation/incoming-relations.js';
import { createReverseLookup } from '../validation/incoming-relations.js';
import { qualifiedRelationName } from '../validation/relation-checks.js';
import { docLinesAbove } from '../documentation/doc-comment.js';
import { claimLines } from './edit-batch.js';
import { identityWouldHold, identityWouldSurvive, rankByNatureFit, suggestedStereotypes } from './stereotype-suggestions.js';
import type { ConstraintKind } from '../utils/nature-reasoning.js';
import {
    admitsStereotype, admitsSupertype, classifiesOnly, classifiesTypes, culprits, naturesWithout,
    possibleNaturesOf, removingAllSupertypesHelps
} from '../utils/nature-reasoning.js';
import { naturesAdmissibleAt } from '../validation/relation-end-natures.js';
import { ENDURANT_NATURES, TABLE_NATURE_NAMES } from '../validation/natures.js';
import {
    allowedNaturesFor, expandNatures, SUGGESTED_CLASS_STEREOTYPES, isUltimateSortal,
    naturesNotPermittedBy, canSpecializeByStereotype, isNonSortal } from '../validation/stereotype-model.js';

/** The last segment of a possibly qualified name. */
function lastSegment(name: string): string {
    return name.split('.').pop() ?? name;
}

/** Recases the last segment, leaving any package qualification alone. */
function recase(name: string, to: 'upper' | 'lower'): string {
    const segments = name.split('.');
    const last = segments[segments.length - 1];
    if (!last) {
        return name;
    }
    segments[segments.length - 1] = (to === 'upper' ? last[0].toUpperCase() : last[0].toLowerCase()) + last.slice(1);
    return segments.join('.');
}

/** Declarations whose name a case fix may rewrite. */
function isRenameable(node: unknown): node is AstNode & { name: string } {
    return isClassDeclaration(node) || isDatatype(node) || isEnumeration(node)
        || isAttribute(node) || isRelationEndMetaAttributes(node);
}

/** How many stereotype changes to offer before the list stops helping. */
const MAX_STEREOTYPE_SUGGESTIONS = 5;

/** The flags an end carries, in the order they are written. */
function writtenFlags(end: RelationEndMetaAttributes | undefined): string[] {
    return ([['const', end?.isConst], ['addOnly', end?.isAddOnly]] as const)
        .filter(([, set]) => set === true)
        .map(([word]) => word);
}

/** `subsets Team.members`, as written, or nothing. */
function overrideClause(end: RelationEndMetaAttributes | undefined): string | undefined {
    const reference = end?.subsets ?? end?.redefines;
    return reference ? `${end?.subsets ? 'subsets' : 'redefines'} ${reference.$refText}` : undefined;
}

/**
 * The smallest change to one multiplicity that brings it inside another.
 *
 * `upper`: what the specialization may not exceed. The lower bound stays
 * where it is, since holding fewer is allowed -- unless it is above the
 * general's upper, where it has nowhere to stay.
 *
 * `lower`: what a redefinition may not fall below, since it replaces the end
 * it redefines and an instance still has to satisfy it.
 */
function clampedInto(
    mine: Cardinality | undefined, theirs: Cardinality | undefined, bound: 'lower' | 'upper' | 'both'
): string | undefined {
    const inner = mine ? getBounds(mine) : { lower: 1, upper: 1 };
    const outer = theirs ? getBounds(theirs) : { lower: 1, upper: 1 };
    if (!inner || !outer) {
        return undefined;
    }
    // Both, for an end that replaces the other: what it holds is what that
    // one holds, so neither bound may stray. Moving one alone answered each
    // diagnostic with the other -- `[0..*]` redefining `[1]` became `[0..1]`
    // or `[1..*]`, and only `[1]` is either's answer.
    const both = (): [number, number] => {
        const lower = Math.min(Math.max(inner.lower, outer.lower), outer.upper);
        return [lower, Math.max(lower, Math.min(inner.upper, outer.upper))];
    };
    const [lower, upper] = bound === 'both' ? both() : bound === 'upper'
        ? [Math.min(inner.lower, outer.upper), Math.min(inner.upper, outer.upper)]
        : [Math.max(inner.lower, outer.lower), Math.max(inner.upper, Math.max(inner.lower, outer.lower))];
    const write = (value: number): string => value === Infinity ? '*' : String(value);
    return lower === upper ? `[${write(lower)}]` : `[${write(lower)}..${write(upper)}]`;
}



/**
 * `source.fixAll.tonto`, not plain `source.fixAll`: an editor configured to
 * fix everything on save asks for the shorter one, and the longer one answers
 * it, while a user asking for this language's own is not handed another's.
 */
const FIX_ALL = `${CodeActionKind.SourceFixAll}.tonto`;

/** The three rules that say an import line says nothing. */
const REDUNDANT_IMPORTS = new Set(['unnecessary-use', 'duplicate-use', 'self-use']);

/**
 * Whether the request asks for actions of this kind.
 *
 * `only` is hierarchical: a request for `source.fixAll` wants
 * `source.fixAll.tonto` too, and a request for nothing in particular wants
 * everything.
 */
function wants(params: CodeActionParams, kind: string): boolean {
    const only = params.context.only;
    return only === undefined || only.some(asked => kind === asked || kind.startsWith(`${asked}.`));
}

/** A datatype or enumeration, both of which carry a nature restriction. */
function isDatatypeLike(node: unknown): node is Datatype | Enumeration {
    return isDatatype(node) || isEnumeration(node);
}

function isHigherOrder(node: ClassDeclaration): boolean {
    return classifiesTypes(node);
}

/**
 * A declaration's own text, with whitespace flattened.
 *
 * Enough to tell "written twice" from "two things under one name", which is
 * the whole question a duplicate-name repair has to answer before deleting
 * anything. Nothing subtler is wanted: two declarations that differ only in
 * spacing say the same thing, and two that differ in any other way might not.
 */
function normalizedText(node: AstNode): string {
    return (node.$cstNode?.text ?? '').replace(/\s+/g, ' ').trim();
}

/** Members a duplicate-name fix can delete outright. */
function isRemovableMember(node: unknown): node is Attribute | EnumLiteral | Relation {
    return isAttribute(node) || isEnumLiteral(node) || isRelation(node);
}

/** Every relation a package declares, inside its classes or beside them. */
function packageRelations(pkg: Package): Relation[] {
    const relations: Relation[] = [];
    for (const declaration of pkg.declarations) {
        if (isExternalRelation(declaration)) {
            relations.push(declaration);
        } else if (isClassDeclaration(declaration)) {
            relations.push(...declaration.relations);
        }
    }
    return relations;
}

/** Every relation in the document containing `relation`. */
function documentRelationsOf(relation: Relation): Relation[] {
    const model = AstUtils.getDocument(relation).parseResult.value as Model;
    const relations: Relation[] = [];
    for (const pkg of model.packages) {
        for (const declaration of pkg.declarations) {
            if (isExternalRelation(declaration)) {
                relations.push(declaration);
            } else if (isClassDeclaration(declaration)) {
                relations.push(...declaration.relations);
            }
        }
    }
    return relations;
}

/**
 * The repairs a batch may apply without asking.
 *
 * "Only one action is offered" is not the same as "this repair decides
 * nothing". A lone phase has exactly one repair here -- change it to a
 * subkind -- and two readings: the sibling phase has not been written yet, or
 * the stereotype is wrong. Counting actions cannot see the reading whose
 * repair is a declaration nobody has written, so a batch quietly picked the
 * one that could be written and turned a stage of a life into a rigid
 * subdivision.
 *
 * What is listed here is forced by the rule it answers: there is one way to
 * satisfy that rule, and taking it changes how the model is written rather
 * than what it claims -- a duplicate token deleted, a bound that has only one
 * admissible value, a flag the rule requires, a keyword spelled wrong. What
 * is *not* listed is every repair that picks between readings, adds a claim
 * (a mediation, a partition, a specialization) or takes one away. Those stay
 * one click away in an editor, where a person is choosing.
 *
 * Not listing a repair is the safe mistake: the batch leaves it, and the
 * diagnostic is still there to see. So new repairs are absent from this list
 * until someone decides otherwise, rather than the other way round.
 */
const MECHANICAL: ReadonlySet<string> = new Set([
    // A token written twice, or one that cannot apply where it is written.
    'duplicate-supertype', 'duplicate-specific', 'duplicate-member', 'duplicate-attribute-stereotype',
    'duplicate-end-name', 'duplicate-use', 'unnecessary-use', 'self-use',
    'datatype-nature-not-abstract', 'add-only-on-immutable',
    'ordered-single-valued', 'end-self-reference', 'self-inverse',
    // A bound with one admissible value, or two written the wrong way round.
    'multiplicity-inverted', 'multiplicity-star-lower', 'characterization-bearer-multiplicity',
    'participational-portion-multiple-participants',
    'sub-collection-multiplicity', 'sub-quantity-multiplicity',
    'end-time-point-not-mandatory', 'end-time-point-not-optional', 'powertype-instantiation-multiplicity',
    // The narrowest multiplicity the end and its derivation both allow.
    'dependence-end-not-mandatory', 'material-cardinality-weaker',
    'empty-doc-tag', 'duplicate-doc-language',
    // A flag the rule requires wherever it applies.
    'quantity-part-not-essential', 'immutable-end-not-const', 'dependence-end-not-const',
    'creation-end-not-const',
    'const-not-propagated', 'time-point-not-const', 'immutable-attribute-not-const',
    'add-only-not-propagated', 'accumulating-end-not-add-only',
    // Spelling: the word written is not a word of the language, and one is.
    'unknown-relation-stereotype', 'unknown-attribute-stereotype',
    'type-name-case', 'member-name-case', 'package-name-case', 'import-for-use',
    // Membership the ontology file has already decided, said again where it
    // is missing or contradicted, and said once where it is said twice.
    'package-file-without-in', 'package-in-mismatch', 'package-in-redundant',
    // Saying in the model what the model already implies.
    'legacy-text-block', 'implied-relation-specialization'
]);

/**
 * Turns diagnostics into one-click fixes.
 *
 * Most fixes here are mechanical -- deleting a redundant line, swapping two
 * numbers, tightening a bound. Some are not, and are offered all the same,
 * because in an editor the person applying one has read the diagnostic: a
 * lone phase may become a subkind, a partition may be written over the phases
 * that lack one. Those carry `batchSafe: false`, and `tonto check --fix`
 * leaves them alone unless their rule is named. Diagnostics whose repair
 * cannot even be written down without knowing the domain (which ultimate
 * sortal a sortal should specialize, whether two types are really disjoint)
 * have no quick fix at all, because guessing would be worse than saying
 * nothing.
 */
export class TontoCodeActionProvider implements CodeActionProvider {
    private readonly services: LangiumServices;

    private readonly documents: LangiumDocuments;
    private readonly indexManager: IndexManager;
    private readonly locator: AstNodeLocator;
    private readonly scopeProvider: ScopeProvider;
    private readonly reflection: AstReflection;

    private readonly reverse: ReverseLookup;

    constructor(services: LangiumServices) {
        this.services = services;
        this.documents = services.shared.workspace.LangiumDocuments;
        this.indexManager = services.shared.workspace.IndexManager;
        this.locator = services.workspace.AstNodeLocator;
        this.scopeProvider = services.references.ScopeProvider;
        this.reflection = services.shared.AstReflection;
        // The same question the checks ask -- what points at this class --
        // asked by the repairs. A rule that reads the workspace and a repair
        // that reads one file disagree about what there is to repair.
        this.reverse = createReverseLookup(this.indexManager, this.documents, this.locator);
        services.shared.workspace.DocumentBuilder.onUpdate(() => this.reverse.reset());
    }

    /**
     * The node a `uri#path` locator names, wherever it is written.
     *
     * These locators are put on diagnostics by checks that found something in
     * another document, which is the ordinary case for a model in more than
     * one file. Resolving them only against the reported document meant the
     * repair for what the check found was never offered.
     */
    private nodeAtLocator(locator: string | undefined): AstNode | undefined {
        const [uri, path] = locator?.split('#') ?? [];
        if (!uri || !path) {
            return undefined;
        }
        const document = this.documents.getDocument(URI.parse(uri));
        return document && this.locator.getAstNode(document.parseResult.value, path);
    }

    async getCodeActions(document: LangiumDocument, params: CodeActionParams): Promise<Array<Command | CodeAction>> {
        const actions: CodeAction[] = [];
        // Two checks can report the same position -- a generalization set with
        // an invalid specific that is also the general, say -- and would then
        // offer the identical repair twice.
        const offered = new Set<string>();
        if (!wants(params, CodeActionKind.QuickFix)) {
            // An editor saving a file asks for `source.fixAll` and nothing
            // else. Answering with every quick fix at the cursor as well made
            // the response say yes to a question nobody asked.
            return this.writableActions(this.sourceActions(document, params));
        }
        for (const diagnostic of params.context.diagnostics) {
            if (diagnostic.code === 'ontology-name-case') {
                const node = this.nodeAt(document, diagnostic, (node): node is Import | import('../generated/ast.js').Ontology => isImport(node) || isOntology(node));
                if (node) {
                    const property = isImport(node) ? 'alias' : 'name';
                    const name = isImport(node) ? node.alias : node.name;
                    const nameNode = GrammarUtils.findNodeForProperty(node.$cstNode, property);
                    if (name && nameNode) {
                        const edits: TextEdit[] = [{ range: nameNode.range, newText: name.toLowerCase() }];
                        const members = isOntology(node) ? ownerRenames(node, name.toLowerCase(), this.documents.all) : {};
                        const own = document.uri.toString();
                        edits.push(...members[own] ?? []);
                        delete members[own];
                        if (isImport(node)) for (const reference of document.references) {
                            if (!reference.$refNode || !reference.$refText.startsWith(`${name}.`)) continue;
                            const site = reference.error?.info.container ?? reference.$refNode.astNode;
                            const scope = AstUtils.getContainerOfType(site, isPackage);
                            if (node.$container === scope || node.$container === document.parseResult.value) {
                                edits.push({ range: reference.$refNode.range, newText: name.toLowerCase() + reference.$refText.slice(name.length) });
                            }
                        }
                        const changes = { ...members, [own]: edits };
                        if (await importRepairIsValid(this.services, document, changes)) actions.push({
                            title: `Rename to "${name.toLowerCase()}"`, kind: CodeActionKind.QuickFix, diagnostics: [diagnostic],
                            edit: { changes }, data: { batchSafe: true }
                        });
                    }
                }
                continue;
            }
            if (diagnostic.code === 'missing-package-use') {
                const reference = document.references.find(ref => ref.$refNode?.range.start.line === diagnostic.range.start.line
                    && ref.$refNode.range.start.character === diagnostic.range.start.character);
                const info = reference?.error?.info;
                const pkg = info && AstUtils.getContainerOfType(info.container, isPackage);
                if (pkg && info) {
                    for (const candidate of importCandidates(this.services, info, reference!.$refText)) {
                        const edit = importEdit(document, pkg, candidate.pkg);
                        if (edit && await importRepairIsValid(this.services, document, [edit], candidate.description)) actions.push({
                            title: `Use "${candidate.pkg.name}"`, kind: CodeActionKind.QuickFix, diagnostics: [diagnostic],
                            edit: { changes: { [document.uri.toString()]: [edit] } }, data: { batchSafe: false }
                        });
                    }
                }
                continue;
            }
            if (diagnostic.code === 'package-not-bundled') {
                const action = bundleMember(document, diagnostic, publicationWorkspace(this.services.shared));
                if (action?.edit?.changes && await importRepairIsValid(this.services, document, action.edit.changes)) {
                    actions.push(action);
                }
                continue;
            }
            if (diagnostic.code === 'package-without-ontology') {
                for (const action of ontologyForPackage(document, diagnostic, publicationWorkspace(this.services.shared))) {
                    // Joining an entry edits two documents; whether both still check is asked, not assumed.
                    const changes = action.edit?.changes;
                    if (changes && Object.keys(changes).length > 1 && !await importRepairIsValid(this.services, document, changes)) continue;
                    // Each package of a document reports it, and one header answers them all.
                    const key = `${action.title}\u0000${JSON.stringify(changes ?? {})}`;
                    if (offered.has(key)) continue;
                    offered.add(key);
                    actions.push(action);
                }
                continue;
            }
            if (diagnostic.code === 'publication-location') {
                const action = createBundledPackage(document, diagnostic, publicationWorkspace(this.services.shared),
                    this.services.shared.workspace.FileSystemProvider);
                if (action) actions.push(action);
                continue;
            }
            const batchSafe = MECHANICAL.has(String(diagnostic.code));
            for (const action of this.createFixes(document, diagnostic)) {
                const key = `${action.title}\u0000${JSON.stringify(action.edit?.changes ?? {})}`;
                if (!offered.has(key)) {
                    offered.add(key);
                    // Says whether applying this without reading it is safe.
                    // Carried on the action rather than looked up again by
                    // whoever applies it, so the answer has one home.
                    //
                    // The code's answer is the default and not the last word:
                    // a rule can be mechanical in general and still offer one
                    // repair that decides something -- deleting a duplicate
                    // name is a deletion of nothing when the two declarations
                    // say the same thing, and a deletion of a claim when they
                    // do not. A repair that knows which it is says so, and
                    // keeps its own answer.
                    const decided = (action.data as { batchSafe?: boolean } | undefined)?.batchSafe;
                    actions.push({
                        ...action,
                        data: { ...(action.data as object ?? {}), batchSafe: decided ?? batchSafe }
                    });
                }
            }
        }
        return this.writableActions([...actions, ...this.sourceActions(document, params)]);
    }

    private writableActions(actions: CodeAction[]): CodeAction[] {
        return actions.filter(action => Object.keys(action.edit?.changes ?? {}).every(uri => {
            const target = this.documents.getDocument(URI.parse(uri));
            return !target || !publicationWorkspace(this.services.shared).isReadOnly(target);
        }));
    }

    /**
     * What can be done to the file rather than to a diagnostic.
     *
     * A source action has nothing to anchor to -- no squiggle, no cursor
     * position it belongs at -- so each has to say for itself whether there is
     * anything here to do, and offer nothing when there is not: a menu of
     * entries that turn out to be no-ops is worse than a short menu.
     */
    private sourceActions(document: LangiumDocument, params: CodeActionParams): CodeAction[] {
        const actions: CodeAction[] = [];
        if (wants(params, FIX_ALL)) {
            const all = this.repairEverythingSafe(document);
            if (all) {
                actions.push(all);
            }
        }
        if (wants(params, CodeActionKind.SourceOrganizeImports)) {
            const imports = this.organizeImports(document);
            if (imports) {
                actions.push(imports);
            }
        }
        if (wants(params, CodeActionKind.RefactorRewrite)) {
            for (const action of [
                this.extractRelator(document, params),
                ...this.extractExtrinsicModes(document, params),
                this.createDerivedMaterialRelation(document, params),
                this.createInverse(document, params),
                this.externalizeRelation(document, params),
                this.internaliseRelation(document, params),
                splitOneFileOntology(document, params.range)
            ]) {
                if (action) {
                    actions.push(action);
                }
            }
        }
        return actions;
    }

    /**
     * Every repair in the file that decides nothing, in one edit.
     *
     * The same contract `tonto check --fix` runs under, and the same code
     * deciding it: a repair is applied unread only where its rule forces it
     * (`MECHANICAL`) and where it is the only one offered for that diagnostic,
     * since a rule that offers two is asking a question. Repairs that would
     * write into one line twice are left for the next pass rather than
     * combined, which is what `claimLines` is for -- an editor running this on
     * save gets the rest on the next save.
     */
    private repairEverythingSafe(document: LangiumDocument): CodeAction | undefined {
        const edits: TextEdit[] = [];
        const taken = new Map<string, Set<number>>();
        const uri = document.textDocument.uri;
        let repairs = 0;
        for (const diagnostic of document.diagnostics ?? []) {
            if (!MECHANICAL.has(String(diagnostic.code))) {
                continue;
            }
            const offered = this.createFixes(document, diagnostic);
            // A rule may be mechanical in general while this particular
            // repair decides something about the model.
            if (offered.length === 1
                && (offered[0].data as { batchSafe?: boolean } | undefined)?.batchSafe === false) {
                continue;
            }
            const written = offered.length === 1 ? offered[0].edit?.changes?.[uri] ?? [] : [];
            // This document and no other: a repair that reaches into another
            // file is not one a "fix all" here may make.
            const only = offered.length === 1 && Object.keys(offered[0].edit?.changes ?? {}).length === 1;
            if (written.length === 0 || !only || !claimLines(taken, [[uri, written]])) {
                continue;
            }
            edits.push(...written);
            repairs++;
        }
        if (repairs === 0) {
            return undefined;
        }
        return {
            title: repairs === 1
                ? 'Apply the one repair that decides nothing'
                : `Apply the ${repairs} repairs that decide nothing`,
            kind: FIX_ALL,
            edit: { changes: { [uri]: edits } }
        };
    }

    /**
     * The import block, with what says nothing removed and the rest in order.
     *
     * What to remove is not decided here: `unnecessary-use`, `duplicate-use`
     * and `self-use` already say which lines say nothing, and this takes
     * the lines they name. What is new is the ordering, and it is done a run
     * at a time -- a contiguous stretch of import lines with nothing between
     * them. A comment or a blank line ends the run, because a comment sits
     * above the import it is about and sorting across it would carry the
     * import away from its comment.
     */
    private organizeImports(document: LangiumDocument): CodeAction | undefined {
        const uri = document.textDocument.uri;
        const text = document.textDocument.getText();
        const lines = text.split('\n');
        const dropped = new Set<number>();
        for (const diagnostic of document.diagnostics ?? []) {
            if (REDUNDANT_IMPORTS.has(String(diagnostic.code))) {
                dropped.add(diagnostic.range.start.line);
            }
        }
        // Ontology imports and package uses, which sort into one run: the
        // first by location, the second by name, each kind together.
        const isImport = (line: string): boolean => /^\s*(import|use)\s+\S/.test(line);
        const edits: TextEdit[] = [];
        for (let start = 0; start < lines.length; start++) {
            if (!isImport(lines[start])) {
                continue;
            }
            let end = start;
            while (end + 1 < lines.length && isImport(lines[end + 1])) {
                end++;
            }
            const run = lines.slice(start, end + 1);
            const kept = run
                .filter((_, index) => !dropped.has(start + index))
                .sort((left, right) => left.trim().localeCompare(right.trim()));
            if (kept.join('\n') !== run.join('\n')) {
                edits.push({
                    range: {
                        start: { line: start, character: 0 },
                        // Up to the start of the line after the run, so a run
                        // that loses a line loses its newline with it.
                        end: { line: end + 1, character: 0 }
                    },
                    newText: kept.length > 0 ? `${kept.join('\n')}\n` : ''
                });
            }
            start = end;
        }
        if (edits.length === 0) {
            return undefined;
        }
        return {
            title: dropped.size > 0 ? 'Sort the uses and imports, and drop what says nothing' : 'Sort the uses and imports',
            kind: CodeActionKind.SourceOrganizeImports,
            edit: { changes: { [uri]: edits } }
        };
    }

    /**
     * Writes the relator a material relation is derived from.
     *
     * "Someone works for a company because there is an employment": the
     * material relation is the mediations of that employment read together,
     * and this writes the employment. The relation itself stays -- both belong
     * to the pattern -- and `material-without-relator`, which is the hint that
     * asks for this, goes quiet as soon as it is applied.
     *
     * The multiplicities are carried across rather than invented, and they
     * cross: how many employments an employee has is how many organizations
     * they work for, which is what the *far* end of the material relation
     * says. The name is the relation's, capitalized, since that is the word
     * the author already chose for it.
     */
    private extractRelator(document: LangiumDocument, params: CodeActionParams): CodeAction | undefined {
        const relation = this.relationUnder(document, params.range.start);
        const pkg = relation && AstUtils.getContainerOfType(relation, isPackage);
        if (!relation || !pkg || relation.stereotype !== 'material') {
            return undefined;
        }
        // Only where the model does not already say what grounds it, which is
        // the question `material-without-relator` answers -- asked of its
        // answer rather than worked out again here, so the two cannot come to
        // disagree about what counts as grounded.
        const ungrounded = (document.diagnostics ?? []).some(diagnostic =>
            diagnostic.code === 'material-without-relator'
            && diagnostic.range.start.line === relation.$cstNode?.range.start.line);
        if (!ungrounded) {
            return undefined;
        }
        const source = getRelationSource(relation);
        const target = relation.target?.ref;
        if (!source || !isClassDeclaration(source) || !target || !isClassDeclaration(target)) {
            return undefined;
        }
        const name = this.freeName(relation.name ? recase(relation.name, 'upper') : `${source.name}${target.name}`, pkg);
        const edits = this.materialRelatorEdits(relation, pkg, name, true);
        if (!edits) {
            return undefined;
        }
        return {
            title: `Write the relator "${name}" this is derived from`,
            kind: CodeActionKind.RefactorRewrite,
            edit: { changes: { [document.textDocument.uri]: edits } }
        };
    }

    /**
     * The relator pattern behind a material relation: one crossed mediation
     * for each end, and optionally the `derivedFrom` clause when it was not
     * already written. Shared by the cursor refactoring and the repair for an
     * unresolved relator name so the two entry points cannot produce
     * different models.
     */
    private materialRelatorEdits(
        relation: Relation, pkg: Package, name: string, addDerivation: boolean
    ): TextEdit[] | undefined {
        const source = getRelationSource(relation);
        const target = relation.target?.ref;
        const sourceName = getRelationSourceName(relation);
        const targetName = relation.target?.$refText;
        if (!source || !isClassDeclaration(source) || !target || !isClassDeclaration(target)
            || !sourceName || !targetName) {
            return undefined;
        }
        const written = [
            '',
            `relator ${name} {`,
            // An end with no multiplicity written is exactly one.
            `    @mediation ${relation.targetCardinality?.$cstNode?.text ?? '[1]'} -- [1] (const) ${sourceName}`,
            `    @mediation ${relation.sourceCardinality?.$cstNode?.text ?? '[1]'} -- [1] (const) ${targetName}`,
            '}'
        ].join('\n');
        return this.groundingDeclarationEdits(relation, pkg, name, written, addDerivation);
    }

    /**
     * Writes an extrinsic mode that makes the material relation hold.
     *
     * Unlike a relator, an extrinsic mode has a bearer: it characterizes one
     * end and externally depends on the other. Either end may be the bearer,
     * and relation direction does not decide which, so both readings are
     * offered with that choice in their titles. A self-relation has only one
     * distinguishable reading.
     */
    private extractExtrinsicModes(document: LangiumDocument, params: CodeActionParams): CodeAction[] {
        const relation = this.relationUnder(document, params.range.start);
        const pkg = relation && AstUtils.getContainerOfType(relation, isPackage);
        if (!relation || !pkg || relation.stereotype !== 'material') {
            return [];
        }
        const ungrounded = (document.diagnostics ?? []).some(diagnostic =>
            diagnostic.code === 'material-without-relator'
            && diagnostic.range.start.line === relation.$cstNode?.range.start.line);
        if (!ungrounded) {
            return [];
        }
        const source = getRelationSource(relation);
        const target = relation.target?.ref;
        if (!source || !isClassDeclaration(source) || !target || !isClassDeclaration(target)) {
            return [];
        }
        const name = this.freeName(
            relation.name ? recase(relation.name, 'upper') : `${source.name}${target.name}`,
            pkg
        );
        return this.extrinsicModeActions(document, relation, pkg, name, true, CodeActionKind.RefactorRewrite);
    }

    /** The two possible bearer choices for a material relation's extrinsic mode. */
    private extrinsicModeActions(
        document: LangiumDocument,
        relation: Relation,
        pkg: Package,
        name: string,
        addDerivation: boolean,
        kind: typeof CodeActionKind.RefactorRewrite | typeof CodeActionKind.QuickFix,
        diagnostic?: Diagnostic,
        titleName = name
    ): CodeAction[] {
        const source = getRelationSource(relation);
        const target = relation.target?.ref;
        if (!source || !isClassDeclaration(source) || !target || !isClassDeclaration(target)) {
            return [];
        }
        const choices: Array<{ bearer: ClassDeclaration; bearerSide: 'source' | 'target' }> = [
            { bearer: source, bearerSide: 'source' },
            ...(target === source ? [] : [{ bearer: target, bearerSide: 'target' as const }])
        ];
        return choices.flatMap(({ bearer, bearerSide }) => {
            const edits = this.materialExtrinsicModeEdits(relation, pkg, name, bearerSide, addDerivation);
            if (!edits) {
                return [];
            }
            const title = addDerivation
                ? `Write the extrinsic mode "${titleName}" this is derived from, borne by "${bearer.name}"`
                : `Create extrinsicMode "${titleName}" borne by "${bearer.name}"`;
            return [{
                title,
                kind,
                ...(diagnostic ? { diagnostics: [diagnostic], isPreferred: false } : {}),
                edit: { changes: { [document.textDocument.uri]: edits } }
            }];
        });
    }

    /** A characterization to the bearer and an external dependence on the other end. */
    private materialExtrinsicModeEdits(
        relation: Relation,
        pkg: Package,
        name: string,
        bearerSide: 'source' | 'target',
        addDerivation: boolean
    ): TextEdit[] | undefined {
        const source = getRelationSource(relation);
        const target = relation.target?.ref;
        const sourceName = getRelationSourceName(relation);
        const targetName = relation.target?.$refText;
        if (!source || !isClassDeclaration(source) || !target || !isClassDeclaration(target)
            || !sourceName || !targetName) {
            return undefined;
        }
        const sourceMultiplicity = relation.sourceCardinality?.$cstNode?.text ?? '[1]';
        const targetMultiplicity = relation.targetCardinality?.$cstNode?.text ?? '[1]';
        const bearerName = bearerSide === 'source' ? sourceName : targetName;
        const dependeeName = bearerSide === 'source' ? targetName : sourceName;
        const bearerMultiplicity = bearerSide === 'source' ? targetMultiplicity : sourceMultiplicity;
        const dependeeMultiplicity = bearerSide === 'source' ? sourceMultiplicity : targetMultiplicity;
        const written = [
            '',
            `extrinsicMode ${name} {`,
            `    @characterization ${bearerMultiplicity} -- [1] (const) ${bearerName}`,
            `    @externalDependence ${dependeeMultiplicity} -- [1] (const) ${dependeeName}`,
            '}'
        ].join('\n');
        return this.groundingDeclarationEdits(relation, pkg, name, written, addDerivation);
    }

    /** Inserts a grounding declaration and, where needed, names it on the relation. */
    private groundingDeclarationEdits(
        relation: Relation, pkg: Package, name: string, written: string, addDerivation: boolean
    ): TextEdit[] {
        // Said on the relation as well, which is what makes it the relation's
        // ground rather than an aspect that happens to reach the same two.
        // An external relation's end is where the new declaration goes, and two
        // insertions at one position have no order an editor must keep, so
        // there they are one edit.
        const insertion = insertionAfter(relation, pkg);
        const end = relation.$cstNode!.range.end;
        const derivation = addDerivation ? ` derivedFrom ${name}` : '';
        const together = insertion.start.line === end.line && insertion.start.character === end.character;
        return together || !derivation
            ? [{ range: insertion, newText: `${together ? derivation : ''}${written}` }]
            : [{ range: { start: end, end }, newText: derivation }, { range: insertion, newText: written }];
    }

    /**
     * Reads a relator's two mediations as the material relation they ground.
     *
     * There is no action with fewer mediations because one does not relate
     * two ends, and none with more because choosing a pair would be a
     * modeling decision. The declaration is package-level: its source is
     * one mediated type rather than the relator under the cursor. Declaration
     * order is semantic here: the earlier mediation supplies the source, the
     * later one the target, including when both mediate the same type.
     */
    private createDerivedMaterialRelation(
        document: LangiumDocument, params: CodeActionParams
    ): CodeAction | undefined {
        const relator = this.classUnder(document, params.range.start);
        const pkg = relator && AstUtils.getContainerOfType(relator, isPackage);
        const natures = relator && possibleNaturesOf(relator);
        if (!relator?.$cstNode || !pkg || !natures || natures.size === 0
            || [...natures].some(nature => nature !== 'relators')) {
            return undefined;
        }

        const found = [...new Set(this.reverse.touching(relator))].filter(relation =>
            relation.stereotype === 'mediation' && getRelationSource(relation) === relator);
        const mediations = found.length === 2 ? mediationsInDocumentOrder(found) : undefined;
        if (!mediations || this.reverse.referrers(relator).some(referrer =>
            isRelation(referrer) && referrer.stereotype === 'material'
            && referrer.derivedFrom.some(reference => reference.ref === relator))) {
            return undefined;
        }
        const source = mediations[0].target?.ref;
        const target = mediations[1].target?.ref;
        const cardinalities = derivedMaterialCardinalities(mediations[0], mediations[1]);
        if (!source || !isClassDeclaration(source) || !target || !isClassDeclaration(target) || !cardinalities) {
            return undefined;
        }

        // Ask the real package-level scope how to spell all three references.
        // A mediation may live in another file, where the reference text it
        // uses is not necessarily meaningful at this insertion point.
        const prospective = { $type: 'ExternalRelation', $container: pkg } as unknown as Relation;
        const sourceName = this.nameInScope(prospective, 'source', source);
        const targetName = this.nameInScope(prospective, 'target', target);
        const relatorName = this.nameInScope(prospective, 'derivedFrom', relator);
        if (!sourceName || !targetName || !relatorName) {
            return undefined;
        }
        const name = this.freeRelationName(recase(relator.name, 'lower'), source);
        const line = `@material relation ${sourceName} ${writeMultiplicity(cardinalities.source)} -- ${name} -- `
            + `${writeMultiplicity(cardinalities.target)} ${targetName} derivedFrom ${relatorName}`;
        return this.rewrite(document, `Create derived material relation "${name}"`, [{
            range: insertionAfter(relator, pkg),
            newText: `\n${line}`
        }]);
    }

    /**
     * Writes a named association again in the opposite direction.
     *
     * The inverse follows the original declaration's form: beside an external
     * relation at package level, or in the far end's class when the original
     * is written in its source class. The latter matters beyond layout: an
     * internal relation belongs to the class whose body says it, so writing
     * the inverse back in the original class would give it the wrong source.
     * Both declarations name the other: inversehood is symmetric, and each
     * line should state the complete fact on its own.
     */
    private createInverse(document: LangiumDocument, params: CodeActionParams): CodeAction | undefined {
        const relation = this.relationUnder(document, params.range.start);
        const source = relation && getRelationSource(relation);
        const target = relation?.target?.ref;
        const pkg = relation && AstUtils.getContainerOfType(relation, isPackage);
        if (!relation?.$cstNode || !relation.name || !source || !isClassDeclaration(source)
            || !target || !isClassDeclaration(target) || !pkg || this.hasInverse(relation)) {
            return undefined;
        }

        const wanted = `inverse${recase(relation.name, 'upper')}`;
        const name = this.freeRelationName(wanted, target);
        const plan = this.inverseToCreate(relation, name);
        if (!plan) {
            return undefined;
        }
        const originalEdit = this.addInverseClause(relation, plan.referenceFromOriginal);
        return {
            title: `Create inverse "${name}"`,
            kind: CodeActionKind.RefactorRewrite,
            edit: { changes: this.inverseChanges(plan, document.textDocument.uri, originalEdit) }
        };
    }

    /** Whether either declaration already says that this association has an inverse. */
    private hasInverse(relation: Relation): boolean {
        return !!relation.inverseOf || this.reverse.referrers(relation)
            .some(referrer => isRelation(referrer) && referrer.inverseOf?.ref === relation);
    }

    /** A name free in a relation's source class, regardless of its spelling. */
    private freeRelationName(wanted: string, owner: ClassDeclaration): string {
        const inherited = membersInScopeOf(owner, member => this.reverse.touching(member));
        const taken = new Set([
            ...collectMembers(owner, this.reverse).map(member => member.name),
            ...inherited.relations.keys(),
            ...inherited.ends.keys()
        ]);
        if (!taken.has(wanted)) {
            return wanted;
        }
        for (let suffix = 2; ; suffix++) {
            if (!taken.has(`${wanted}${suffix}`)) {
                return `${wanted}${suffix}`;
            }
        }
    }

    /**
     * Everything shared by creating an inverse from the cursor and writing
     * one named by an unresolved `inverseOf`: its text, placement and the
     * references in both directions.
     */
    private inverseToCreate(relation: Relation, name: string): InverseCreation | undefined {
        const source = getRelationSource(relation);
        const target = relation.target?.ref;
        const pkg = AstUtils.getContainerOfType(relation, isPackage);
        const targetReference = relation.target?.$refText;
        if (!relation.name || !source || !isClassDeclaration(source) || !target || !isClassDeclaration(target)
            || !pkg || !targetReference) {
            return undefined;
        }
        const external = isExternalRelation(relation);
        const sourceText = external
            ? relation.source?.$refText
            : this.referenceFromClass(target, 'target', source);
        const inverseText = external
            ? relation.name
            : this.referenceFromClass(target, 'inverseOf', relation);
        if (!sourceText || !inverseText) {
            return undefined;
        }
        const keepsStereotype = inverseKeepsStereotype(relation.stereotype);
        const derivations = keepsStereotype
            ? relation.derivedFrom.map(reference => external
                ? reference.$refText
                : reference.ref && this.referenceFromClass(target, 'derivedFrom', reference.ref))
            : [];
        // Keeping a derived stereotype without being able to name what
        // grounds it would answer one action with an unresolved reference.
        if (derivations.some(reference => !reference)) {
            return undefined;
        }
        const line = this.inverseAsWritten(
            relation, name, sourceText, external ? targetReference : undefined, inverseText,
            derivations.filter((reference): reference is string => !!reference)
        );
        const insertion = external
            ? { range: insertionAfter(relation, pkg), newText: `\n${line}` }
            : this.insertionInClass(target, line);
        if (!insertion) {
            return undefined;
        }
        return {
            insertion,
            uri: external ? AstUtils.getDocument(relation).textDocument.uri : AstUtils.getDocument(target).textDocument.uri,
            referenceFromOriginal: external ? name : `${targetReference}.${name}`
        };
    }

    /** Adds the inverse and, when supplied, updates the declaration that asked for it. */
    private inverseChanges(
        plan: InverseCreation, originalUri?: string, originalEdit?: TextEdit
    ): Record<string, TextEdit[]> {
        const changes: Record<string, TextEdit[]> = { [plan.uri]: [plan.insertion] };
        if (!originalUri || !originalEdit) {
            return changes;
        }
        const sameInsertion = plan.uri === originalUri
            && plan.insertion.range.start.line === originalEdit.range.start.line
            && plan.insertion.range.start.character === originalEdit.range.start.character
            && plan.insertion.range.end.line === originalEdit.range.end.line
            && plan.insertion.range.end.character === originalEdit.range.end.character;
        if (sameInsertion) {
            changes[plan.uri] = [{
                range: originalEdit.range,
                newText: `${originalEdit.newText}${plan.insertion.newText}`
            }];
        } else {
            (changes[originalUri] ??= []).push(originalEdit);
        }
        return changes;
    }

    /**
     * The shortest name visible from a relation that will be written in
     * `owner`. A small prospective node lets the real scope provider account
     * for package uses, aliases and members inherited by that class.
     */
    private referenceFromClass(owner: ClassDeclaration, property: string, target: AstNode): string | undefined {
        const prospective = { $type: 'InternalRelation', $container: owner } as unknown as Relation;
        return this.nameInScope(prospective, property, target);
    }

    /** Appends one relation to a class body, making the body when necessary. */
    private insertionInClass(owner: ClassDeclaration, written: string): TextEdit | undefined {
        if (!owner.$cstNode) {
            return undefined;
        }
        const outerIndent = ' '.repeat(owner.$cstNode.range.start.character);
        const indent = `${outerIndent}    `;
        const close = GrammarUtils.findNodeForKeyword(owner.$cstNode, '}');
        return close
            ? {
                range: { start: close.range.start, end: close.range.start },
                newText: `${indent}${written}\n${outerIndent}`
            }
            : {
                range: { start: owner.$cstNode.range.end, end: owner.$cstNode.range.end },
                newText: ` {\n${indent}${written}\n${outerIndent}}`
            };
    }

    /** Adds the reciprocal clause before `derivedFrom`, which the grammar puts last. */
    private addInverseClause(relation: Relation, inverse: string): TextEdit {
        const derivedFrom = GrammarUtils.findNodeForKeyword(relation.$cstNode, 'derivedFrom');
        const position = derivedFrom?.range.start ?? relation.$cstNode!.range.end;
        return {
            range: { start: position, end: position },
            newText: derivedFrom ? `inverseOf ${inverse} ` : ` inverseOf ${inverse}`
        };
    }

    /** The inverse relation with its two ends crossed and its diamond reversed. */
    private inverseAsWritten(
        relation: Relation,
        name: string,
        sourceText: string,
        targetText: string | undefined,
        inverseOf?: string,
        derivations = relation.derivedFrom.map(reference => reference.$refText)
    ): string {
        const keepsStereotype = inverseKeepsStereotype(relation.stereotype);
        const stereotype = keepsStereotype ? `@${relation.stereotype} ` : '';
        const left = relation.isAggregationInverted ? '<>--' : '--';
        const right = relation.isAggregation ? '--<>' : '--';
        const derived = keepsStereotype && derivations.length > 0
            ? ` derivedFrom ${derivations.join(', ')}`
            : '';
        return [
            targetText ? `${stereotype}relation ${targetText}` : stereotype.trimEnd(),
            this.endAsWritten(relation, 'target', undefined, 'source'),
            `${left} ${name} ${right}`,
            this.endAsWritten(relation, 'source', undefined, 'target'),
            `${sourceText}${inverseOf ? ` inverseOf ${inverseOf}` : ''}${derived}`
        ].filter(part => part.length > 0).join(' ');
    }

    /**
     * Moves a relation out of the class body it is written in.
     *
     * The two forms say the same thing -- `getRelationSource` reads the
     * container for one and the reference for the other -- so this is a move
     * and not a change: the same text, with `relation <Source>` written in
     * where the grammar reads it, one line down from the class it was inside.
     *
     * Its documentation goes with it, and a body left holding nothing goes
     * with the relation.
     */
    private externalizeRelation(document: LangiumDocument, params: CodeActionParams): CodeAction | undefined {
        const relation = this.relationUnder(document, params.range.start);
        const owner = relation && AstUtils.getContainerOfType(relation, isClassDeclaration);
        const pkg = owner && AstUtils.getContainerOfType(owner, isPackage);
        if (!relation || isExternalRelation(relation) || !owner?.$cstNode || !pkg || !relation.$cstNode) {
            return undefined;
        }
        const written = this.writtenWithSource(document, relation, owner.name);
        const documentation = docLinesAbove(relation);
        // `docLinesAbove` gives the content; the run is written back with the
        // prefix it is read by.
        const carried = documentation.map(line => `/// ${line.text}\n`).join('');
        const removed = this.withDocumentation(relation, documentation);
        const emptied = this.bodyEmptiedBy(document, owner, removed);
        const action = this.rewrite(document, 'Write this at package level', [
            { range: emptied ?? removed, newText: '' },
            { range: insertionAfter(owner, pkg), newText: `\n${carried}${written}` }
        ]);
        // At package level the relation is a declaration in its own right:
        // references no longer need to pass through its former source class.
        // Remove that segment wherever the shorter spelling is not already
        // claimed by something that would shadow the moved declaration.
        for (const [uri, edits] of Object.entries(this.referencesAfterExternalizing(relation, owner))) {
            const changes = action.edit!.changes!;
            changes[uri] = [...(changes[uri] ?? []), ...edits];
        }
        return action;
    }

    /**
     * And back into it: `relation Person` goes, and the line lands in the body
     * of the class that was its source -- which is given a body if it has
     * none.
     *
     * Only where that source is a class in this document. A datatype's body
     * holds attributes and nothing else, and a class in another file would
     * take the relation into another package, which is a different question
     * from where the line sits.
     */
    private internaliseRelation(document: LangiumDocument, params: CodeActionParams): CodeAction | undefined {
        const relation = this.relationUnder(document, params.range.start);
        const source = relation && isExternalRelation(relation) ? relation.source?.ref : undefined;
        if (!relation?.$cstNode || !source || !isClassDeclaration(source) || !source.$cstNode
            || AstUtils.getDocument(source) !== document) {
            return undefined;
        }
        const indent = ' '.repeat(source.$cstNode.range.start.character + 4);
        const written = this.writtenWithoutSource(document, relation);
        const documentation = docLinesAbove(relation);
        const carried = documentation.map(line => `${indent}/// ${line.text}\n`).join('');
        // Before the closing brace rather than after the opening one, so what
        // the body already says stays where it was written.
        const close = GrammarUtils.findNodeForKeyword(source.$cstNode, '}');
        const insertion: TextEdit = close
            ? { range: { start: close.range.start, end: close.range.start },
                newText: `${carried}${indent}${written}\n${' '.repeat(source.$cstNode.range.start.character)}` }
            : {
                range: { start: source.$cstNode.range.end, end: source.$cstNode.range.end },
                newText: ` {\n${carried}${indent}${written}\n${' '.repeat(source.$cstNode.range.start.character)}}`
            };
        const action = this.rewrite(document, `Write this inside "${source.name}"`, [
            insertion,
            { range: this.withDocumentation(relation, documentation), newText: '' }
        ]);
        // Inside a class a relation is named through it: the plain name a
        // package-level relation answers to is gone, and whatever used it --
        // an `inverseOf`, a `specializes`, a historical role's `derivedFrom`,
        // in this file or another -- has to say where to look.
        for (const [uri, edits] of Object.entries(this.qualifiedReferencesTo(relation, source))) {
            const changes = action.edit!.changes!;
            changes[uri] = [...(changes[uri] ?? []), ...edits];
        }
        return action;
    }

    /**
     * The references to a relation that would stop resolving once it is
     * written inside its source class, rewritten through it: `joinedByParticipant`
     * becomes `Meeting.joinedByParticipant`, and `p.joinedByParticipant`
     * becomes `p.Meeting.joinedByParticipant`. A reference already qualified
     * by the class needs nothing, and so does one written inside the class or
     * a class specializing it, where an inherited relation is named plainly.
     */
    private qualifiedReferencesTo(relation: Relation, source: ClassDeclaration): Record<string, TextEdit[]> {
        const name = relation.name;
        const changes: Record<string, TextEdit[]> = {};
        if (!name) {
            return changes;
        }
        for (const referrer of this.reverse.referrers(relation)) {
            const container = AstUtils.getContainerOfType(referrer, isClassDeclaration);
            if (container && isSameOrSpecializes(container, source)) {
                continue;
            }
            const values = Object.entries(referrer)
                .filter(([property]) => !property.startsWith('$'))
                .flatMap(([, value]) => Array.isArray(value) ? value : [value]);
            for (const value of values) {
                if (!isReference(value) || value.ref !== relation || !value.$refNode) {
                    continue;
                }
                const segments = value.$refText.split('.');
                if (segments[segments.length - 1] !== name || segments[segments.length - 2] === source.name) {
                    continue;
                }
                const uri = AstUtils.getDocument(referrer).textDocument.uri;
                (changes[uri] ??= []).push({
                    range: value.$refNode.range,
                    newText: [...segments.slice(0, -1), source.name, name].join('.')
                });
            }
        }
        return changes;
    }

    /**
     * References to an internal relation shortened once it becomes a package
     * declaration: `Person.worksFor` becomes `worksFor`, and an imported
     * `sales.Person.worksFor` becomes `sales.worksFor`.
     *
     * A class scope may already use the shorter name for an inherited member.
     * In that case the qualified spelling remains valid after the move and is
     * the only one that still names this relation, so it is deliberately kept.
     */
    private referencesAfterExternalizing(
        relation: Relation, source: ClassDeclaration
    ): Record<string, TextEdit[]> {
        const name = relation.name;
        const changes: Record<string, TextEdit[]> = {};
        if (!name) {
            return changes;
        }
        const targetUri = AstUtils.getDocument(relation).uri.toString();
        const targetPath = this.locator.getAstNodePath(relation);
        for (const referrer of this.reverse.referrers(relation)) {
            for (const [property, raw] of Object.entries(referrer)) {
                if (property.startsWith('$')) {
                    continue;
                }
                for (const value of Array.isArray(raw) ? raw : [raw]) {
                    if (!isReference(value) || value.ref !== relation || !value.$refNode) {
                        continue;
                    }
                    const segments = value.$refText.split('.');
                    if (segments[segments.length - 1] !== name
                        || segments[segments.length - 2] !== source.name) {
                        continue;
                    }
                    const shortened = [...segments.slice(0, -2), name].join('.');
                    const occupying = this.scopeProvider.getScope({ reference: value, container: referrer, property })
                        .getElement(shortened);
                    const isThisRelation = occupying?.documentUri.toString() === targetUri
                        && occupying.path === targetPath;
                    if (occupying && !isThisRelation) {
                        continue;
                    }
                    const uri = AstUtils.getDocument(referrer).textDocument.uri;
                    (changes[uri] ??= []).push({ range: value.$refNode.range, newText: shortened });
                }
            }
        }
        return changes;
    }

    /**
     * The value-type hint offers a modeling choice, not an automatic repair.
     * Only a plain, unreferenced relation can be replaced without leaving
     * relation-specific declarations or references behind. Its target bound
     * becomes the attribute's bound; the reverse bound has no attribute form.
     */
    private relationToAttribute(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const relation = this.nodeAt(document, diagnostic, isRelation);
        const source = relation && getRelationSource(relation);
        const target = relation?.target?.ref;
        if (!relation?.$cstNode || !relation.name || !source || !isClassDeclaration(source) || !source.$cstNode
            || !target || !isDatatypeLike(target) || relation.stereotype || relation.isAggregation
            || relation.isAggregationInverted || relation.sourceMeta || relation.targetMeta
            || relation.specializes || relation.inverseOf || relation.derivedFrom.length > 0
            || ownerOf(relation) !== ownerOf(source) || this.reverse.referrers(relation).length > 0
            || collectMembers(source, this.reverse).some(member => member.name === relation.name && member.node !== relation)) {
            return undefined;
        }

        // A relation may be written in another package or file. Ask the
        // attribute's actual scope how to spell the target there.
        const prospective = { $type: 'Attribute', $container: source } as unknown as Attribute;
        const targetName = this.nameInScope(prospective, 'type', target);
        if (!targetName) {
            return undefined;
        }
        const cardinality = relation.targetCardinality?.$cstNode?.text;
        const attribute = `${relation.name}: ${targetName}${cardinality ? ` ${cardinality}` : ''}`;
        const sourceDocument = AstUtils.getDocument(source);
        const changes: Record<string, TextEdit[]> = {};
        const add = (uri: string, edit: TextEdit): void => { (changes[uri] ??= []).push(edit); };

        if (isExternalRelation(relation)) {
            const indent = ' '.repeat(source.$cstNode.range.start.character + 4);
            const documentation = docLinesAbove(relation);
            const carried = documentation.map(line => `${indent}/// ${line.text}\n`).join('');
            const close = GrammarUtils.findNodeForKeyword(source.$cstNode, '}');
            const insertion: TextEdit = close
                ? { range: { start: close.range.start, end: close.range.start },
                    newText: `${carried}${indent}${attribute}\n${' '.repeat(source.$cstNode.range.start.character)}` }
                : { range: { start: source.$cstNode.range.end, end: source.$cstNode.range.end },
                    newText: ` {\n${carried}${indent}${attribute}\n${' '.repeat(source.$cstNode.range.start.character)}}` };
            add(sourceDocument.uri.toString(), insertion);
            add(document.uri.toString(), { range: this.withDocumentation(relation, documentation), newText: '' });
        } else {
            add(document.uri.toString(), { range: relation.$cstNode.range, newText: attribute });
        }

        return {
            title: `Use attribute "${attribute}" (drops the relation's reverse bound)`,
            kind: CodeActionKind.QuickFix,
            diagnostics: [diagnostic],
            edit: { changes },
            data: { batchSafe: false }
        };
    }

    /** The lines a relation occupies, its `///` run included. */
    private withDocumentation(relation: Relation, documentation: Array<{ line: number }>): Range {
        const lines = this.lineRange(relation.$cstNode!.range);
        return documentation.length > 0
            ? { start: { line: documentation[documentation.length - 1].line, character: 0 }, end: lines.end }
            : lines;
    }

    /** A refactoring: no diagnostic behind it, so it says so. */
    private rewrite(document: LangiumDocument, title: string, edits: TextEdit[]): CodeAction {
        return {
            title,
            kind: CodeActionKind.RefactorRewrite,
            edit: { changes: { [document.textDocument.uri]: edits } }
        };
    }

    /** The relation as written, with `relation <Source>` put in. */
    private writtenWithSource(document: LangiumDocument, relation: Relation, source: string | undefined): string {
        const node = relation.$cstNode!;
        const text = document.textDocument.getText().slice(node.offset, node.end);
        const stereotype = GrammarUtils.findNodeForProperty(node, 'stereotype');
        const at = stereotype ? stereotype.end - node.offset : 0;
        return `${text.slice(0, at)}${at > 0 ? ' ' : ''}relation ${source ?? '?'} ${text.slice(at).trimStart()}`;
    }

    /** And as written without it, for the move the other way. */
    private writtenWithoutSource(document: LangiumDocument, relation: Relation): string {
        const node = relation.$cstNode!;
        const text = document.textDocument.getText();
        const keyword = GrammarUtils.findNodeForKeyword(node, 'relation');
        const reference = GrammarUtils.findNodeForProperty(node, 'source');
        if (!keyword || !reference) {
            return text.slice(node.offset, node.end);
        }
        return `${text.slice(node.offset, keyword.offset)}${text.slice(reference.end, node.end)}`.replace(/\s+/g, ' ').trim();
    }

    /**
     * The span that takes the braces too, when what is being removed is all
     * they hold: `kind Person { … }` comes out as `kind Person` rather than as
     * a pair of braces around nothing.
     */
    private bodyEmptiedBy(document: LangiumDocument, owner: ClassDeclaration, removed: Range): Range | undefined {
        const block = this.bracedBlock(owner.$cstNode);
        const open = GrammarUtils.findNodeForKeyword(owner.$cstNode, '{');
        const close = GrammarUtils.findNodeForKeyword(owner.$cstNode, '}');
        if (!block || !open || !close) {
            return undefined;
        }
        const text = document.textDocument.getText();
        const [from, to] = this.offsetsOf(document, removed);
        const inside = text.slice(open.end, from) + text.slice(to, close.offset);
        if (inside.trim().length > 0) {
            return undefined;
        }
        // Back to the end of the declaration proper, so the space before `{`
        // goes with it.
        let start = open.offset;
        while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) {
            start--;
        }
        return { start: document.textDocument.positionAt(start), end: close.range.end };
    }

    private offsetsOf(document: LangiumDocument, range: Range): [number, number] {
        return [document.textDocument.offsetAt(range.start), document.textDocument.offsetAt(range.end)];
    }

    /** The relation the cursor is in, if it is in one. */
    private relationUnder(document: LangiumDocument, position: Position): Relation | undefined {
        const root = document.parseResult.value.$cstNode;
        const leaf = root && CstUtils.findLeafNodeAtOffset(root, document.textDocument.offsetAt(position));
        return leaf && AstUtils.getContainerOfType(leaf.astNode, isRelation);
    }

    /** The class declaration containing the cursor, including through one of its members. */
    private classUnder(document: LangiumDocument, position: Position): ClassDeclaration | undefined {
        const root = document.parseResult.value.$cstNode;
        const leaf = root && CstUtils.findLeafNodeAtOffset(root, document.textDocument.offsetAt(position));
        return leaf && AstUtils.getContainerOfType(leaf.astNode, isClassDeclaration);
    }

    /** A name no non-relation declaration in the package has taken. */
    private freeName(wanted: string, pkg: Package): string {
        const taken = new Set(pkg.declarations.filter(declaration => !isExternalRelation(declaration))
            .map(declaration => declaration.name));
        if (!taken.has(wanted)) {
            return wanted;
        }
        for (let suffix = 2; ; suffix++) {
            if (!taken.has(`${wanted}${suffix}`)) {
                return `${wanted}${suffix}`;
            }
        }
    }

    private createFixes(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        const linking = linkingErrorData(diagnostic);
        if (linking) {
            return this.createMissingDeclaration(document, diagnostic, linking);
        }
        switch (diagnostic.code) {
            case 'unnecessary-use':
            case 'duplicate-use':
            case 'self-use':
                return asArray(this.removeUse(document, diagnostic));
            case 'import-for-use':
                return asArray(useKeyword(document, diagnostic));
            case 'package-file-without-in':
            case 'package-in-mismatch':
                return asArray(declareOwner(document, diagnostic));
            case 'package-in-redundant':
                return asArray(removeOwner(document, diagnostic));
            case 'ontology-loose-declarations':
                return asArray(wrapLooseDeclarations(document, diagnostic));
            case 'ontology-tag-not-on-header':
                return placeOntologyTag(document, diagnostic);
            case 'multiplicity-inverted':
                return asArray(this.swapCardinalityBounds(document, diagnostic));
            case 'duplicate-specific':
                return asArray(this.removeDuplicateSpecific(document, diagnostic));
            case 'RepRel':
                return asArray(this.restrictRelatorEnd(document, diagnostic));
            case 'sortal-without-ultimate-sortal':
                return [
                    ...this.specializeUltimateSortal(document, diagnostic),
                    ...this.becomeAnUltimateSortal(document, diagnostic)
                ];
            case 'multiplicity-star-lower':
                return asArray(this.replaceStarLowerBound(document, diagnostic));
            case 'duplicate-supertype':
                return asArray(this.removeOffendingSpecialization(document, diagnostic));
            case 'stereotype-cannot-specialize':
                return this.repairInvalidSpecialization(document, diagnostic);
            case 'genset-stereotype-cannot-specialize':
                return this.repairInvalidGensetSpecialization(document, diagnostic);
            case 'datatype-nature-not-abstract':
                return asArray(this.removeNatureClause(document, diagnostic));
            case 'subkind-founded-on-relator':
                return asArray(this.changeStereotype(document, diagnostic, 'subkind', 'role'));
            case 'duplicate-member':
                return asArray(this.removeDuplicateMember(document, diagnostic));
            case 'value-relation-may-be-attribute':
                return asArray(this.relationToAttribute(document, diagnostic));
            case 'categorizer-not-higher-order':
            case 'instance-of-not-higher-order':
                return asArray(this.makeTargetHigherOrder(document, diagnostic));
            case 'RelSpec':
                return asArray(this.addRelationSpecialization(document, diagnostic));
            case 'disjoint-supertypes':
                return this.resolveDisjointSupertypes(document, diagnostic);
            case 'multiple-ultimate-sortals':
                return this.dropExtraUltimateSortals(document, diagnostic);
            case 'incompatible-supertype-natures':
            case 'stereotype-nature-mismatch':
            case 'stereotype-nature-unreachable':
            case 'declared-nature-incompatible-with-inherited':
                return this.repairNatureConflict(document, diagnostic);
            case 'multiplicity-zero-upper':
                return this.replaceCardinality(document, diagnostic, ['[0..1]', '[0..*]']);
            case 'characterization-bearer-multiplicity':
                return this.replaceCardinality(document, diagnostic, ['[1]']);
            case 'participational-portion-multiple-participants':
                return asArray(this.restrictParticipationalParticipant(document, diagnostic));
            case 'non-sortal-natures-unstated':
                return asArray(this.stateNaturesBeneath(document, diagnostic));
            case 'participational-portion-two-participants':
            case 'participational-portion-participants-coincide':
                return this.separatePortionParticipants(document, diagnostic);
            case 'dependence-end-not-mandatory':
                return asArray(this.requireOne(document, diagnostic));
            case 'sub-quantity-multiplicity':
            case 'sub-collection-multiplicity':
                return this.replaceCardinality(document, diagnostic, ['[1]']);
            case 'sub-quantity-shared':
                // Two readings, so both are offered and neither is applied
                // unread: every portion of alcohol is in some wine, or it may
                // be a portion on its own.
                return this.replaceCardinality(document, diagnostic, ['[1]', '[0..1]']);
            case 'ordered-single-valued':
                return asArray(this.removeFlag(document, diagnostic, 'ordered'));
            case 'add-only-with-nothing-to-add':
                return [
                    ...asArray(this.removeFlag(document, diagnostic, 'addOnly')),
                    ...asArray(this.letItGrow(document, diagnostic))
                ];
            case 'add-only-on-immutable':
                return asArray(this.replaceFlag(document, diagnostic, 'addOnly', 'const'));
            case 'accumulating-end-not-add-only':
                return asArray(this.markEnd(document, diagnostic, 'addOnly'));
            case 'add-only-not-propagated':
                return asArray(this.markEnd(document, diagnostic, 'addOnly'));
            case 'self-inverse':
                return asArray(this.removeClause(document, diagnostic, 'inverseOf', 'Remove "inverseOf"'));
            case 'empty-end-decorator':
                return asArray(this.removeEmptyDecorator(document, diagnostic));
            case 'end-self-reference':
                return asArray(this.removeSelfEndReference(document, diagnostic));
            case 'const-not-propagated':
                return asArray(this.addConstToEnd(document, diagnostic));
            case 'package-name-case':
                return asArray(this.lowerCasePackageName(document, diagnostic));
            case 'type-name-case':
                return asArray(this.recaseName(document, diagnostic, 'upper'));
            case 'member-name-case':
                return asArray(this.recaseName(document, diagnostic, 'lower'));
            case 'phases-without-partition':
            case 'phase-mixins-without-partition':
                return asArray(this.addPhasePartition(document, diagnostic));
            case 'legacy-text-block':
                return asArray(this.convertLegacyTextBlock(document, diagnostic));
            case 'empty-doc-tag':
            case 'duplicate-doc-language':
                return asArray(this.removeDocumentationLine(document, diagnostic));
            case 'unknown-doc-tag':
            case 'doubtful-doc-language':
                return asArray(this.correctDocumentationTag(document, diagnostic));
            case 'specialization-cycle':
                return this.breakSpecializationCycle(document, diagnostic);
            case 'genset-self-generalization':
            case 'genset-mixes-classes-and-relations':
                return asArray(this.removeGensetSpecific(document, diagnostic));
            case 'partition-single-specific':
                return asArray(this.removeKeyword(document, diagnostic, 'complete', 'Make the generalization set incomplete'));
            case 'datatype-specializes-non-abstract':
                return asArray(this.removeDatatypeSpecialization(document, diagnostic));
            case 'end-holds-more-than-general':
            case 'redefinition-weakens-lower-bound':
                // One code, two shapes: an end that overrides another carries
                // its general on the decorator, a relation that specializes
                // one carries it on the relation. Each answers for its own.
                return [
                    ...asArray(this.matchGeneralMultiplicity(document, diagnostic)),
                    ...asArray(this.matchTheGeneralEnd(document, diagnostic))
                ];
            case 'characterization-bearer-not-reifiable':
                return asArray(this.reifyAsProperty(document, diagnostic));
            case 'relation-ends-reversed':
                return asArray(this.swapRelationEnds(document, diagnostic));

            case 'unspecific-stereotype':
                return this.specifyStereotype(document, diagnostic);
            case 'powertype-instantiation-multiplicity':
                return asArray(this.widenPowertypeEnd(document, diagnostic));
            case 'unknown-relation-stereotype':
                return asArray(this.correctRelationStereotype(document, diagnostic));
            case 'unknown-attribute-stereotype':
                return asArray(this.correctAttributeStereotype(document, diagnostic));
            case 'moment-without-bearer':
                return this.stereotypeAnExistingAssociation(document, diagnostic, 'characterization', 'first');
            case 'historical-role-without-event':
                return [
                    ...this.deriveFromWhatHappened(document, diagnostic),
                    ...this.stereotypeAnExistingAssociation(document, diagnostic, 'participation', 'first'),
                    ...this.participateInAnEvent(document, diagnostic)
                ];
            case 'historical-role-specializes-anti-rigid':
                return this.specializeTheRigidTypeAndDerive(document, diagnostic);
            case 'class-derivation-not-historical':
                return [
                    ...asArray(this.removeClassDerivation(document, diagnostic)),
                    ...asArray(this.changeStereotype(document, diagnostic, 'roleMixin', 'historicalRoleMixin')),
                    ...asArray(this.changeStereotype(document, diagnostic, 'role', 'historicalRole'))
                ];
            case 'historical-derivation-ambiguous':
                return this.nameTheDerivation(document, diagnostic);
            case 'process-without-constitution':
                return this.stereotypeAnExistingAssociation(document, diagnostic, 'constitution', 'first');
            case 'event-without-participation':
                return this.stereotypeAnExistingAssociation(document, diagnostic, 'participation', 'second');
            case 'collective-without-members':
                return this.stereotypeAnExistingAssociation(document, diagnostic, 'membership', 'first');
            case 'extrinsic-mode-without-dependence':
                return [
                    ...this.stereotypeAnExistingAssociation(document, diagnostic, 'externalDependence', 'first'),
                    ...asArray(this.changeStereotype(document, diagnostic, 'extrinsicMode', 'intrinsicMode'))
                ];
            case 'role-without-relator':
                return [
                    ...this.stereotypeAnExistingAssociation(document, diagnostic, 'mediation', 'second'),
                    ...asArray(this.changeStereotype(document, diagnostic, 'role', 'phase')),
                    ...asArray(this.changeStereotype(document, diagnostic, 'roleMixin', 'phaseMixin'))
                ];
            case 'material-without-relator':
                return [
                    ...asArray(this.extractRelatorFor(document, diagnostic)),
                    ...this.extractExtrinsicModesFor(document, diagnostic)
                ];
            case 'founding-relation-optional':
                return asArray(this.requireTheFoundingRelation(document, diagnostic));
            case 'derivation-unstated':
                return this.deriveFromTheGroundingRelator(document, diagnostic);
            case 'derivation-on-underived-relation':
                return this.markDerivedOrUnderive(document, diagnostic);
            case 'material-derived-from-many':
                return this.deriveFromOneOnly(document, diagnostic);
            case 'derivation-source-nature':
                return asArray(this.dropADerivationSource(document, diagnostic));
            case 'derivation-not-grounded':
                return this.deriveFromTheGroundingRelator(document, diagnostic);
            case 'material-cardinality-mismatch':
            case 'material-cardinality-weaker':
            case 'material-cardinality-narrower':
                return asArray(this.useDerivedMaterialCardinality(document, diagnostic));
            case 'deprecated-stereotype':
                return this.replaceTheDeprecatedStereotype(document, diagnostic);
            case 'lone-phase':
                return asArray(this.changeStereotype(document, diagnostic, 'phase', 'subkind'));
            case 'partition-mixes-phases':
                return this.makeTheOddSpecificsPhases(document, diagnostic);
            case 'relator-without-mediation':
                return this.stereotypeAnExistingAssociation(document, diagnostic, 'mediation', 'first');
            case 'diamond-without-parthood':
                return asArray(this.dropTheDiamond(document, diagnostic));
            case 'parthood-descends-forever':
                return this.letTheChainStop(document, diagnostic, 'part');
            case 'parthood-climbs-forever':
                return this.letTheChainStop(document, diagnostic, 'whole');
            case 'quantity-part-not-essential':
            case 'immutable-end-not-const':
            case 'creation-end-not-const':
                return asArray(this.markEndConst(document, diagnostic));
            case 'dependence-end-not-const':
                return this.settleDependenceEnd(document, diagnostic);
            case 'time-point-not-const':
            case 'immutable-attribute-not-const':
                return asArray(this.markAttributeConst(document, diagnostic));
            case 'end-time-point-not-mandatory':
                return asArray(this.makeAttributeMandatory(document, diagnostic));
            case 'end-time-point-not-optional':
                return asArray(this.makeAttributeOptional(document, diagnostic));
            case 'duplicate-attribute-stereotype':
                return asArray(this.removeDuplicateAttributeStereotype(document, diagnostic));
            case 'parthood-without-diamond':
                return this.markTheWhole(document, diagnostic);
            case 'powertype-does-not-classify-types':
            case 'powertype-without-base':
                return asArray(this.dropPowerTypeModifier(document, diagnostic));
            case 'instance-is-its-own-base':
                return asArray(this.markAsPowerType(document, diagnostic));
            case 'instance-not-specializing-base':
            case 'powertype-hierarchy-mismatch':
                return asArray(this.addSupertype(document, diagnostic));
            case 'inverse-signature-mismatch':
                return asArray(this.removeClause(document, diagnostic, 'inverseOf', 'Remove "inverseOf"'));
            case 'relation-specialization-not-narrower':
                // Two readings, and the first is usually the one meant: the
                // end was supposed to specialize the general's end and the
                // taxonomy has not said so yet. Dropping the clause is the
                // other -- it leaves a relation that says less rather than
                // something false, which is what `inverse-signature-mismatch`
                // gets, one clause over.
                return [
                    ...asArray(this.addSupertype(document, diagnostic)),
                    ...asArray(this.removeClause(document, diagnostic, 'specializes', 'Remove "specializes"'))
                ];
            case 'override-type-not-narrower':
                // The same two readings as a relation specialization that does
                // not narrow, and the same order: the taxonomy usually has not
                // caught up with what the end was meant to say.
                return [
                    ...asArray(this.addSupertype(document, diagnostic)),
                    ...asArray(this.removeSelfEndReference(document, diagnostic))
                ];
            case 'override-owner-not-subtype':
                return [
                    ...asArray(this.addSupertype(document, diagnostic)),
                    ...asArray(this.removeSelfEndReference(document, diagnostic))
                ];
            case 'genset-contradicts-instantiation':
                return this.settleTheInstantiationBound(document, diagnostic);
            case 'relation-end-nature-mismatch':
                return this.restereotypeAnEnd(document, diagnostic);
            case 'categorizer-not-under-powertype':
                // The generalization the model already implies: everything the
                // categorizer classifies is an instance of the powertype.
                return asArray(this.addSupertype(document, diagnostic));
            case 'short-reference-ambiguous':
                return this.qualifyTheShortReference(document, diagnostic);
            case 'inverse-ends-differ':
                return asArray(this.mirrorTheInverseEnds(document, diagnostic));
            case 'matching-inverse':
                return asArray(this.makeRelationsInverse(document, diagnostic));
            case 'duplicate-end-name':
                return asArray(this.dropEndName(document, diagnostic));
            case 'parthood-specialization-mismatch':
                return this.agreeOnParthood(document, diagnostic);
            case 'implied-relation-specialization':
                return asArray(this.specializeTheOverriddenRelation(document, diagnostic));
            case 'relator-mediates-one':
                return this.strengthenTheMediations(document, diagnostic);
            case 'whole-with-one-part':
                return this.supplementTheWhole(document, diagnostic);
            case 'mixin-without-changeable-instances':
                return asArray(this.changeStereotype(document, diagnostic, 'mixin', 'category'));
            case 'parthood-crosses-natures':
                return asArray(this.flipDiamond(document, diagnostic));
            case 'implied-relation-stereotype':
                return this.writeImpliedStereotype(document, diagnostic);
            case 'powertype-as-categorizer':
            case 'categorizer-is-relation':
            case 'categorizer-on-relation-set':
                return asArray(this.removeGensetCategorizer(document, diagnostic));
            default:
                return [];
        }
    }

    /**
     * Offers to declare whatever an unresolved reference was looking for.
     *
     * Which stereotypes are worth offering follows from where the reference
     * sits: after `specializes` only the stereotypes the subject may
     * specialize, for `instanceOf` only high-order types, for an attribute a
     * datatype or enumeration, and at the end of a stereotyped relation only
     * stereotypes whose nature that relation admits.
     */
    private createMissingDeclaration(
        document: LangiumDocument,
        diagnostic: Diagnostic,
        linking: LinkingErrorData
    ): CodeAction[] {
        if (linking.property === 'subsets' || linking.property === 'redefines') {
            return this.qualifyEndReference(document, diagnostic, linking.refText);
        }
        // A name one keystroke from something in scope is a typo, and offering
        // to *create* it entrenches the mistake. The near misses come first;
        // creating the thing stays available after them.
        const corrections = this.correctReference(document, diagnostic, linking);
        return [
            ...corrections,
            ...this.whatAlreadyFitsTheEnd(document, diagnostic, linking, corrections),
            ...declarationsFor(document, diagnostic.range, linking.refText, linking.property)
            .flatMap(candidate => {
                const specialized = candidate.keyword === 'relator'
                    ? asArray(this.createMissingMaterialRelator(document, diagnostic, linking))
                    : candidate.keyword === 'extrinsicMode'
                        ? this.createMissingMaterialExtrinsicModes(document, diagnostic, linking)
                        : [];
                return specialized.length > 0 ? specialized : [this.edit(
                    document,
                    diagnostic,
                    `Create ${candidate.keyword} "${linking.refText}"${candidate.natures ? ` of ${candidate.natures.join(', ')}` : ''}`,
                    [candidate.edit],
                    false
                )];
            }),
            ...this.dropTheUnresolvedClause(document, diagnostic, linking)
        ];
    }

    /**
     * Resolves `derivedFrom Missing` on a material relation by writing the
     * complete relator pattern, not a bare relator that immediately triggers
     * the missing-mediation rules. The requested name is already present on
     * the relation, so only the relator and its two mediations are inserted.
     */
    private createMissingMaterialRelator(
        document: LangiumDocument, diagnostic: Diagnostic, linking: LinkingErrorData
    ): CodeAction | undefined {
        const relation = this.nodeAt(document, diagnostic, isRelation);
        const pkg = relation && AstUtils.getContainerOfType(relation, isPackage);
        if (!relation || !pkg || relation.stereotype !== 'material' || linking.property !== 'derivedFrom'
            || relation.derivedFrom.length !== 1) {
            return undefined;
        }
        const segments = linking.refText.split('.');
        const name = segments.pop();
        const qualifier = segments.join('.');
        // The declaration is inserted in this package. A name qualified by a
        // different package needs an edit to that package, not a declaration
        // silently written in the wrong namespace.
        if (!name || (qualifier && qualifier !== pkg.name)) {
            return undefined;
        }
        const edits = this.materialRelatorEdits(relation, pkg, name, false);
        return edits
            ? this.edit(document, diagnostic, `Create relator "${linking.refText}"`, edits, false)
            : undefined;
    }

    /** The complete extrinsic-mode counterparts of `createMissingMaterialRelator`. */
    private createMissingMaterialExtrinsicModes(
        document: LangiumDocument, diagnostic: Diagnostic, linking: LinkingErrorData
    ): CodeAction[] {
        const relation = this.nodeAt(document, diagnostic, isRelation);
        const pkg = relation && AstUtils.getContainerOfType(relation, isPackage);
        if (!relation || !pkg || relation.stereotype !== 'material' || linking.property !== 'derivedFrom'
            || relation.derivedFrom.length !== 1) {
            return [];
        }
        const segments = linking.refText.split('.');
        const name = segments.pop();
        const qualifier = segments.join('.');
        if (!name || (qualifier && qualifier !== pkg.name)) {
            return [];
        }
        return this.extrinsicModeActions(
            document,
            relation,
            pkg,
            name,
            false,
            CodeActionKind.QuickFix,
            diagnostic,
            linking.refText
        );
    }

    /**
     * At a relation end that only something happening can fill -- an event,
     * a process, a situation -- the classes already declared beside it that
     * fit: `Reunião` for an unresolved `Meeting` a participation reaches. Not
     * a near miss in spelling, so the scope's corrections never find it, and
     * a model has few such classes, so what is missing is usually one of them
     * under another name.
     *
     * Not at an end that takes endurants: nearly every class fits there, and
     * a list of them says nothing -- a relator offered as what it mediates,
     * or what it already mediates. Only classes every instance of which the
     * end admits, and never the class at the relation's other end.
     */
    private whatAlreadyFitsTheEnd(
        document: LangiumDocument, diagnostic: Diagnostic, linking: LinkingErrorData, corrections: CodeAction[]
    ): CodeAction[] {
        const relation = this.nodeAt(document, diagnostic, isRelation);
        const property = linking.property;
        const range = this.rangeOfReference(document, diagnostic);
        const pkg = relation && AstUtils.getContainerOfType(relation, isPackage);
        if (!relation || !pkg || !range || (property !== 'source' && property !== 'target')) {
            return [];
        }
        const admissible = naturesAdmissibleAt(relation, property);
        const enduring = new Set(ENDURANT_NATURES.map(nature => TABLE_NATURE_NAMES[nature]));
        if (!admissible || [...admissible].some(nature => enduring.has(nature))) {
            return [];
        }
        const other = property === 'source' ? relation.target?.ref : getRelationSource(relation);
        const offered = new Set(corrections.map(action => action.title));
        return pkg.declarations
            .filter(isClassDeclaration)
            .filter(candidate => candidate !== other)
            .filter(candidate => {
                const natures = possibleNaturesOf(candidate);
                return !!natures && natures.size > 0
                    && [...natures].every(nature => admissible.has(TABLE_NATURE_NAMES[nature]));
            })
            .map(candidate => `Change to "${candidate.name}"`)
            .filter(title => !offered.has(title))
            .slice(0, 3)
            .map(title => this.edit(document, diagnostic, title,
                [{ range, newText: title.slice('Change to "'.length, -1) }], false));
    }

    /**
     * Writes the inverse an unresolved `inverseOf` names: the same association
     * read the other way, using the same placement rule as `Create inverse`.
     * An internal original therefore puts its inverse inside the far end's
     * class and qualifies the clause that asked for it.
     *
     * Same ends, crossed over -- multiplicities, flags and end names -- which
     * is what `inverse-ends-differ` asks of an inverse, and the diamond on the
     * other side, so the whole stays the whole. The stereotype remains only
     * where it classifies the relationship itself (`@material` and
     * `@comparative`) or the moving diamond preserves its parthood reading.
     * Directional stereotypes become plain associations; a `derivedFrom`
     * goes only with a stereotype that remains.
     */
    private writeTheInverse(
        document: LangiumDocument, diagnostic: Diagnostic, relation: Relation, refText: string
    ): CodeAction | undefined {
        const target = relation.target?.ref;
        const targetText = relation.target?.$refText;
        // The name as written must resolve to what is written: plain, or
        // qualified by the class the inverse is read from.
        const segments = refText.split('.');
        const name = segments[segments.length - 1];
        const qualifier = segments.slice(0, -1).join('.');
        if (!relation.name || !target || !isClassDeclaration(target) || !targetText
            || (qualifier && qualifier !== targetText)) {
            return undefined;
        }
        const plan = this.inverseToCreate(relation, name);
        const referenceNode = relation.inverseOf?.$refNode;
        if (!plan || !referenceNode) {
            return undefined;
        }
        const referenceEdit = refText === plan.referenceFromOriginal
            ? undefined
            : { range: referenceNode.range, newText: plan.referenceFromOriginal };
        return {
            title: `Write the inverse "${name}"`,
            kind: CodeActionKind.QuickFix,
            diagnostics: [diagnostic],
            isPreferred: true,
            edit: {
                changes: referenceEdit
                    ? this.inverseChanges(plan, document.textDocument.uri, referenceEdit)
                    : this.inverseChanges(plan)
            }
        };
    }

    /**
     * Where nothing can be created to answer the reference -- what names a
     * relation, or what a historical role is derived from -- the clause can
     * still go.
     */
    private dropTheUnresolvedClause(
        document: LangiumDocument, diagnostic: Diagnostic, linking: LinkingErrorData
    ): CodeAction[] {
        if (linking.property === 'inverseOf' || linking.property === 'specializes') {
            const relation = this.nodeAt(document, diagnostic, isRelation);
            return relation
                ? [
                    ...(linking.property === 'inverseOf' ? asArray(this.writeTheInverse(document, diagnostic, relation, linking.refText)) : []),
                    ...asArray(this.removeClause(document, diagnostic, linking.property, `Remove "${linking.property}"`))
                ]
                : [];
        }
        if (linking.property === 'derivedFrom' && !this.nodeAt(document, diagnostic, isRelation)) {
            return asArray(this.removeClassDerivation(document, diagnostic));
        }
        return [];
    }

    /**
     * Names within an edit or two of something already in scope.
     *
     * The scope is asked rather than the index, so nothing is proposed that
     * would not resolve where it is written -- a class in a package this file
     * never imported is not a near miss, it is a different problem.
     */
    private correctReference(
        document: LangiumDocument, diagnostic: Diagnostic, linking: LinkingErrorData
    ): CodeAction[] {
        const node = this.nodeAt(document, diagnostic, (candidate): candidate is AstNode => !!candidate);
        const reference = node && this.unresolved(node, linking);
        const range = this.rangeOfReference(document, diagnostic);
        if (!node || !reference || !range) {
            return [];
        }
        const written = linking.refText.split('.').pop() ?? linking.refText;
        // The scope offers each element under its simple name and again
        // package-qualified; keeping the first occurrence keeps the shorter
        // spelling, as completion does.
        return this.scopeProvider.getScope({ reference, container: node, property: linking.property })
            .getAllElements()
            .distinct(description => `${description.documentUri.toString()}#${description.path}`)
            .map(description => ({ name: description.name, off: distance(description.name.split('.').pop() ?? '', written) }))
            .filter(({ name, off }) => off > 0 && off <= 2 && name !== linking.refText)
            .toArray()
            .sort((a, b) => a.off - b.off || a.name.length - b.name.length)
            .slice(0, 3)
            .map(({ name }) => this.edit(document, diagnostic, `Change to "${name}"`,
                [{ range, newText: name }], false))
            .filter((action): action is CodeAction => !!action);
    }

    /** The unresolved reference the diagnostic is about, on its container. */
    private unresolved(node: AstNode, linking: LinkingErrorData): Reference | undefined {
        const value = (node as unknown as Record<string, unknown>)[linking.property];
        const candidates = Array.isArray(value) ? value : [value];
        return candidates.find((candidate): candidate is Reference =>
            !!candidate && typeof candidate === 'object' && '$refText' in candidate
            && (candidate as Reference).$refText === linking.refText);
    }

    /** Where the reference text sits, which is what a correction replaces. */
    private rangeOfReference(document: LangiumDocument, diagnostic: Diagnostic): Range | undefined {
        return diagnostic.range.start.line === diagnostic.range.end.line
            && diagnostic.range.end.character > diagnostic.range.start.character
            ? diagnostic.range
            : undefined;
    }

    /**
     * Makes the two relations agree about parthood, by marking whichever of
     * them lacks the diamond -- or, where the specialization was written
     * rather than implied, by dropping it.
     *
     * The general may live in another document, which a code action cannot
     * edit; then only the removal is offered.
     */
    private agreeOnParthood(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        const data = diagnostic.data as { make?: string; explicit?: boolean; general?: string } | undefined;
        const relation = this.nodeAt(document, diagnostic, isRelation);
        if (!relation) {
            return [];
        }
        const target = data?.make === 'general' ? this.relationAt(data.general) : relation;
        const label = target && data?.make === 'general'
            ? `Mark the whole of "${qualifiedRelationName(target) ?? '?'}"`
            : 'Mark the whole';
        const actions = target ? this.diamondFixes(document, diagnostic, target, 'source', label) : [];
        if (data?.explicit) {
            const removal = this.removeClause(document, diagnostic, 'specializes', 'Remove the specialization');
            if (removal) {
                actions.push(removal);
            }
        }
        return actions;
    }

    /**
     * `isPowerType` says every specialization of a base is an instance. Where
     * there is no base, or where the class classifies something other than
     * types, the modifier is the part that is wrong.
     */
    private dropPowerTypeModifier(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const classDeclaration = this.nodeAt(document, diagnostic, isClassDeclaration);
        const keyword = classDeclaration && GrammarUtils.findNodeForKeyword(classDeclaration.$cstNode, 'isPowerType');
        if (!keyword) {
            return undefined;
        }
        return this.edit(document, diagnostic, 'Remove "isPowerType"', [{
            range: this.withOneSpace(document, { offset: keyword.offset, end: keyword.end, range: keyword.range }),
            newText: ''
        }]);
    }

    /**
     * The other way round: a base type *is* an instance of its own power type,
     * so saying so is a matter of marking the higher type as one.
     */
    private markAsPowerType(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const subject = this.classAt((diagnostic.data as { subject?: string } | undefined)?.subject);
        if (!subject?.$cstNode || subject.isPowerType) {
            return undefined;
        }
        // After the natures if there are any, after the name if not: the
        // grammar takes the modifier in exactly that slot.
        const natures = GrammarUtils.findNodesForProperty(subject.$cstNode, 'natures');
        const anchor = natures[natures.length - 1] ?? GrammarUtils.findNodeForProperty(subject.$cstNode, 'name');
        if (!anchor) {
            return undefined;
        }
        // A power type's instantiation end is `[1..*]` and nothing else
        // (`powertype-instantiation-multiplicity`), so the ends written into it
        // in this file move with the mark rather than becoming the next warning.
        const home = AstUtils.getDocument(subject);
        const ends = this.reverse.touching(subject)
            .filter(relation => relation.stereotype === 'instantiation' && relation.target?.ref === subject
                && AstUtils.getDocument(relation) === home)
            .flatMap(relation => {
                const written = relation.targetCardinality?.$cstNode;
                if (written) {
                    return written.text.replace(/\s+/g, '') === '[1..*]' ? [] : [{ range: written.range, newText: '[1..*]' }];
                }
                const range = this.multiplicityPosition(relation, false);
                return range ? [{ range, newText: '[1..*] ' }] : [];
            });
        return this.editAt(subject, diagnostic, `Mark "${subject.name}" as "isPowerType"`, [
            { range: { start: anchor.range.end, end: anchor.range.end }, newText: ' isPowerType' },
            ...ends
        ]);
    }

    /** Adds the generalization a multi-level rule says has to be there. */
    private addSupertype(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const data = diagnostic.data as { subject?: string; supertype?: string } | undefined;
        const subject = data?.subject
            ? this.classAt(data.subject)
            : this.nodeAt(document, diagnostic, isClassDeclaration);
        const supertype = subject && this.declarationsNamed(document, data?.supertype);
        if (!data?.supertype || !subject?.$cstNode || !supertype || !admitsSupertype(subject, supertype)) {
            return undefined;
        }
        // Where the stereotype cannot take the supertype, the clause alone is
        // no repair -- it moves the error. What both multi-level rules want is
        // a base sortal beneath an ultimate one, so the stereotype changes with
        // it: `type EmployeeType` becomes `subkind EmployeeType specializes
        // PersonType`, which is how MLT writes a mirrored hierarchy.
        const restereotype = !canSpecializeByStereotype(subject.stereotype, supertype.stereotype)
            && canSpecializeByStereotype('subkind', supertype.stereotype)
            && admitsStereotype(subject, 'subkind');
        if (!restereotype && !canSpecializeByStereotype(subject.stereotype, supertype.stereotype)) {
            return undefined;
        }
        const stereotypeEdit = restereotype
            ? [{
                range: GrammarUtils.findNodeForKeyword(subject.$cstNode, subject.stereotype)!.range,
                newText: 'subkind'
            }]
            : [];
        const verb = restereotype
            ? `Make "${subject.name}" a subkind of "${data.supertype}"`
            : `Specialize "${data.supertype}"`;
        const last = subject.specializes[subject.specializes.length - 1]?.$refNode;
        if (last) {
            return this.edit(document, diagnostic,
                restereotype ? verb : `Also specialize "${data.supertype}"`,
                [...stereotypeEdit, { range: { start: last.range.end, end: last.range.end }, newText: `, ${data.supertype}` }]);
        }
        // The clause goes last, so it goes after whatever else is written:
        // the grammar reads name, natures, isPowerType, instanceOf, specializes.
        const natures = GrammarUtils.findNodesForProperty(subject.$cstNode, 'natures');
        const instanceOf = GrammarUtils.findNodeForProperty(subject.$cstNode, 'instanceOf');
        const anchor = instanceOf
            ?? GrammarUtils.findNodeForKeyword(subject.$cstNode, 'isPowerType')
            ?? natures[natures.length - 1]
            ?? GrammarUtils.findNodeForProperty(subject.$cstNode, 'name');
        if (!anchor) {
            return undefined;
        }
        // `instanceOf` names a reference inside brackets; the clause follows
        // the closing one.
        const end = instanceOf ? { line: anchor.range.end.line, character: anchor.range.end.character + 1 } : anchor.range.end;
        return this.edit(document, diagnostic, verb, [
            ...stereotypeEdit,
            { range: { start: end, end }, newText: ` specializes ${data.supertype}` }
        ]);
    }

    /** One of two ends carrying the same name has to give it up. */
    private dropEndName(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const end = this.nodeAt(document, diagnostic, isRelationEndMetaAttributes);
        const name = end && GrammarUtils.findNodeForProperty(end.$cstNode, 'name');
        if (!end || !name) {
            return undefined;
        }
        // With the name gone the parentheses may have nothing left to hold,
        // and an empty pair is `empty-end-decorator` -- one repair answering
        // itself with another.
        const saysNothingElse = !end.subsets && !end.redefines && !end.isConst && !end.isAddOnly;
        const removed = saysNothingElse && end.$cstNode ? end.$cstNode : name;
        return this.edit(document, diagnostic, 'Remove the duplicate end name', [{
            range: this.withOneSpace(document, removed),
            newText: ''
        }]);
    }

    /** The class of that name declared in this document, if there is one. */
    private declarationsNamed(document: LangiumDocument, name: string | undefined): ClassDeclaration | undefined {
        return name === undefined ? undefined : AstUtils.streamAllContents(document.parseResult.value)
            .filter(isClassDeclaration)
            .find(candidate => candidate.name === name);
    }

    /** The class a `uri#path` locator names, when it lives in this file. */
    private classAt(locator: string | undefined): ClassDeclaration | undefined {
        const node = this.nodeAtLocator(locator);
        return node && isClassDeclaration(node) ? node : undefined;
    }

    /** The relation a `uri#path` locator names, wherever it is written. */
    private relationAt(locator: string | undefined): Relation | undefined {
        const node = this.nodeAtLocator(locator);
        return node && isRelation(node) ? node : undefined;
    }

    /** Takes the empty `()` out, and the space in front of it. */
    private removeEmptyDecorator(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const end = this.nodeAt(document, diagnostic, isRelationEndMetaAttributes);
        const node = end?.$cstNode;
        return node && this.edit(document, diagnostic, 'Remove it', [
            { range: this.withOneSpace(document, node), newText: '' }
        ]);
    }

    /** Rewrites one flag as another, in place. */
    private replaceFlag(
        document: LangiumDocument, diagnostic: Diagnostic, from: string, to: string
    ): CodeAction | undefined {
        const root = document.parseResult.value.$cstNode;
        const offset = root && document.textDocument.offsetAt(diagnostic.range.start);
        const owner = root && offset !== undefined
            ? CstUtils.findLeafNodeAtOffset(root, offset)?.astNode
            : undefined;
        const node = owner && GrammarUtils.findNodeForKeyword(owner.$cstNode, from);
        return node
            ? this.edit(document, diagnostic, `Write "${to}" instead`, [{ range: node.range, newText: to }])
            : undefined;
    }

    private markEndConst(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        return this.markEnd(document, diagnostic, 'const');
    }

    private markEnd(document: LangiumDocument, diagnostic: Diagnostic, keyword: string): CodeAction | undefined {
        const atSource = (diagnostic.data as { side?: string } | undefined)?.side === 'source';
        const relation = this.nodeAt(document, diagnostic, isRelation);
        if (!relation?.$cstNode) {
            return undefined;
        }
        const end = atSource ? relation.sourceMeta : relation.targetMeta;
        const title = `Mark the end "${keyword}"`;
        if (keyword === 'const' && end?.isAddOnly && end.$cstNode) {
            const written = GrammarUtils.findNodeForKeyword(end.$cstNode, 'addOnly');
            return written && this.edit(document, diagnostic, title, [
                { range: written.range, newText: 'const' }
            ]);
        }
        if (end?.$cstNode) {
            // The flags come first, so a new one goes just inside the
            // parenthesis whatever else the end already says.
            const open = GrammarUtils.findNodeForKeyword(end.$cstNode, '(');
            return open && this.edit(document, diagnostic, title, [
                { range: { start: open.range.end, end: open.range.end }, newText: `${keyword} ` }
            ]);
        }
        // No decorator yet: it goes where the grammar takes one. At the target
        // that is just before the class; at the source it is *before* the
        // multiplicity, which is written after the decorator rather than
        // before it.
        const anchor = atSource
            ? (GrammarUtils.findNodeForProperty(relation.$cstNode, 'sourceCardinality')?.range.start
                ?? this.notationStart(relation))
            : GrammarUtils.findNodeForProperty(relation.$cstNode, 'target')?.range.start;
        return anchor && this.edit(document, diagnostic, title, [
            { range: { start: anchor, end: anchor }, newText: `(${keyword}) ` }
        ]);
    }

    /**
     * Writes this relation's ends as the ones its inverse states, crossed.
     *
     * The whole span between the source of the relation and the class at its
     * far end is replaced at once -- both decorators, both multiplicities, and
     * the notation with whatever name it carries kept verbatim in the middle
     * -- because the alternative is four edits into slots that may or may not
     * exist, each needing its own answer to where a missing one would go.
     *
     * An end name this side has and the other does not is carried over rather
     * than dropped: `Man.children` may be referenced by a `subsets` somewhere,
     * and mirroring is not a reason to delete a name.
     */
    private mirrorTheInverseEnds(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const relation = this.nodeAt(document, diagnostic, isRelation);
        const inverse = relation?.inverseOf?.ref;
        const target = relation?.$cstNode && GrammarUtils.findNodeForProperty(relation.$cstNode, 'target');
        const notation = relation && this.notationRange(relation);
        if (!relation || !inverse || !target || !notation) {
            return undefined;
        }
        const start = [relation.sourceMeta?.$cstNode, relation.sourceCardinality?.$cstNode]
            .filter((node): node is CstNode => !!node)
            .map(node => node.range.start)
            .sort((left, right) => left.line - right.line || left.character - right.character)[0]
            ?? notation.start;
        const text = document.textDocument.getText({ start: notation.start, end: notation.end });
        const written = [
            this.endAsWritten(inverse, 'target', relation.sourceMeta?.name, 'source'),
            text,
            this.endAsWritten(inverse, 'source', relation.targetMeta?.name, 'target')
        ].filter(part => part.length > 0).join(' ');
        return this.edit(document, diagnostic, `Match the ends of "${inverse.name ?? 'its inverse'}"`, [
            { range: { start, end: target.range.start }, newText: `${written} ` }
        ]);
    }

    /** Adds the two reciprocal `inverseOf` clauses proposed by `matching-inverse`. */
    private makeRelationsInverse(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const relation = this.nodeAt(document, diagnostic, isRelation);
        const candidate = this.nodeAtLocator(
            (diagnostic.data as { candidate?: string } | undefined)?.candidate
        );
        if (!relation?.name || !candidate || !isRelation(candidate) || !candidate.name) {
            return undefined;
        }
        const changes: Record<string, TextEdit[]> = {};
        for (const [from, to] of [[relation, candidate], [candidate, relation]] as const) {
            if (from.inverseOf?.ref === to) {
                continue;
            }
            if (from.inverseOf) {
                return undefined;
            }
            const reference = this.nameInScope(from, 'inverseOf', to);
            if (!reference) {
                return undefined;
            }
            const uri = AstUtils.getDocument(from).textDocument.uri;
            (changes[uri] ??= []).push(this.addInverseClause(from, reference));
        }
        if (Object.keys(changes).length === 0) {
            return undefined;
        }
        return {
            title: `Make "${relation.name}" and "${candidate.name}" inverses`,
            kind: CodeActionKind.QuickFix,
            diagnostics: [diagnostic],
            edit: { changes }
        };
    }

    /** The span of `--`, `<>--` and the name between two of them. */
    private notationRange(relation: Relation): Range | undefined {
        const markers = ['<>--', '--<>', '--']
            .flatMap(marker => GrammarUtils.findNodesForKeyword(relation.$cstNode, marker))
            .sort((left, right) => left.offset - right.offset);
        return markers.length === 0
            ? undefined
            : { start: markers[0].range.start, end: markers[markers.length - 1].range.end };
    }

    /**
     * One end of the inverse, spelled for the side it is being written at: a
     * source end takes its decorator before its multiplicity and a target end
     * after it.
     */
    private endAsWritten(
        inverse: Relation, from: 'source' | 'target', keptName: string | undefined, at: 'source' | 'target'
    ): string {
        const cardinality = from === 'source' ? inverse.sourceCardinality : inverse.targetCardinality;
        const meta = from === 'source' ? inverse.sourceMeta : inverse.targetMeta;
        const inside = [...writtenFlags(meta), meta?.name ?? keptName, overrideClause(meta)]
            .filter((part): part is string => !!part)
            .join(' ');
        const decorator = inside.length > 0 ? `(${inside})` : undefined;
        const bound = cardinality?.$cstNode?.text ?? '[1]';
        return (at === 'source' ? [decorator, bound] : [bound, decorator])
            .filter((part): part is string => !!part)
            .join(' ');
    }

    /** Where a source-side decorator goes: immediately before the notation. */
    private notationStart(relation: Relation): Position | undefined {
        return ['<>--', '--<>', '--']
            .map(marker => GrammarUtils.findNodeForKeyword(relation.$cstNode, marker))
            .filter((node): node is CstNode => !!node)
            .sort((a, b) => a.offset - b.offset)[0]?.range.start;
    }

    /** The two diamonds for one side of a relation, as edits on its marker. */
    private diamondFixes(
        document: LangiumDocument, diagnostic: Diagnostic, relation: Relation, side: 'source' | 'target', label: string
    ): CodeAction[] {
        const dashes = GrammarUtils.findNodesForKeyword(relation.$cstNode, '--');
        const dash = side === 'target' ? dashes[dashes.length - 1] : dashes[0];
        if (!dash) {
            return [];
        }
        return (side === 'target' ? ['--<>'] : ['<>--'])
            .map(marker => this.editAt(relation, diagnostic, `${label} with "${marker}"`, [
                { range: dash.range, newText: marker }
            ]))
            .filter((action): action is CodeAction => !!action);
    }

    /**
     * Marks the whole with a diamond, offering both kinds since only the
     * modeler knows whether the part belongs to one whole exclusively.
     *
     * A named relation writes two dashes -- `A -- owns -- B` -- so the one to
     * replace depends on the side: the marker before the name for a source
     * whole, the one after it for a target whole.
     */
    private markTheWhole(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        const atTarget = (diagnostic.data as { side?: string } | undefined)?.side === 'target';
        const relation = this.nodeAt(document, diagnostic, isRelation);
        if (!relation) {
            return [];
        }
        return this.diamondFixes(document, diagnostic, relation, atTarget ? 'target' : 'source', 'Mark the whole');
    }

    /**
     * Writes what the override already implies: the relation whose end is
     * subset or redefined is the one this relation specializes.
     *
     * The clause goes after the target, which is the only place the grammar
     * accepts it. Where one is already written and names something else, it is
     * replaced -- an override fixes which relation that has to be.
     */
    private specializeTheOverriddenRelation(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const general = (diagnostic.data as { general?: string } | undefined)?.general;
        const attribute = this.nodeAt(document, diagnostic, isRelationEndMetaAttributes);
        const relation = attribute && AstUtils.getContainerOfType(attribute, isRelation);
        if (!general || !relation?.$cstNode) {
            return undefined;
        }
        const existing = GrammarUtils.findNodeForProperty(relation.$cstNode, 'specializes');
        if (existing) {
            return this.edit(document, diagnostic, `Specialize "${general}"`, [
                { range: existing.range, newText: general }
            ]);
        }
        const target = GrammarUtils.findNodeForProperty(relation.$cstNode, 'target');
        if (!target) {
            return undefined;
        }
        return this.edit(document, diagnostic, `Add "specializes ${general}"`, [
            { range: { start: target.range.end, end: target.range.end }, newText: ` specializes ${general}` }
        ]);
    }

    /**
     * An end is named `Owner.endName`, and writing only the end's own name is
     * the usual way to miss it.
     *
     * `(redefines parts)` looks complete but is a single segment, so nothing
     * matches; what was meant is `(redefines Entity.parts)`. Nothing can be
     * *created* to satisfy such a reference either -- an end is not a
     * declaration -- so offering "Create kind \"parts\"" was doubly wrong.
     *
     * Near misses are offered too, since the other way to get this wrong is to
     * write the end's name from memory: `(redefines objectPart)` where the end
     * is `objectParts`. Exact matches come first, then the closest.
     */
    private qualifyEndReference(document: LangiumDocument, diagnostic: Diagnostic, refText: string): CodeAction[] {
        const node = this.nodeAt(document, diagnostic, isRelationEndMetaAttributes);
        const reference = node && (GrammarUtils.findNodeForProperty(node.$cstNode, 'subsets')
            ?? GrammarUtils.findNodeForProperty(node.$cstNode, 'redefines'));
        if (!node || !reference) {
            return [];
        }
        const written = refText.split('.').pop() ?? refText;
        // Every end a reference written here could name, which is not only
        // the ends written here: a model in more than one file redefines an
        // end from the file that declares the relation it narrows.
        return this.reachablePackages(node)
            .flatMap(({ pkg, qualified }) => packageRelations(pkg)
                .flatMap(relation => getNamedEnds(relation))
                .filter(end => !!end.ownerName)
                .map(end => ({
                    name: qualified ? `${pkg.name}.${end.ownerName}.${end.name}` : `${end.ownerName}.${end.name}`,
                    off: distance(end.name, written)
                })))
            .filter(({ off }) => off <= 2)
            .sort((a, b) => a.off - b.off)
            .filter((candidate, index, all) => all.findIndex(other => other.name === candidate.name) === index)
            .map(({ name }) => this.edit(
                document, diagnostic,
                `Change to "${name}"`,
                [{ range: reference.range, newText: name }]
            ))
            .filter((action): action is CodeAction => !!action);
    }

    /**
     * Offers the stereotypes a bare `class` could be given, inferred from what
     * it specializes, what specializes it, and its natures.
     *
     * Nothing is offered when the model says nothing about the class -- with
     * no hierarchy and no `of` clause every stereotype is equally possible,
     * and listing twenty is no help.
     */
    private specifyStereotype(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        const node = this.nodeAt(document, diagnostic, isClassDeclaration);
        const keyword = node && GrammarUtils.findNodeForProperty(node.$cstNode, 'stereotype');
        if (!node || !keyword) {
            return [];
        }
        // A non-sortal with nothing in its lineage saying what it classifies
        // is read as classifying everything, which `non-sortal-natures-
        // unstated` reports; so the clause goes with it, written as that
        // repair would write it, wherever the model beneath settles it.
        const name = GrammarUtils.findNodeForProperty(node.$cstNode, 'name');
        const unstated = node.natures.length === 0 && ![...collectAncestors(node)].some(ancestor => ancestor.natures.length > 0);
        const clauseFor = (stereotype: string): string | undefined => {
            const natures = unstated && name && isNonSortal(stereotype) ? naturesBeneath(this.reverse, node, stereotype) : undefined;
            return natures
                && this.reverse.touching(node).every(relation => stillAdmitsWhenNarrowed(relation, node, expandNatures(natures)))
                ? `of ${natures.join(', ')}` : undefined;
        };
        return suggestedStereotypes(node, this.reverse)
            .slice(0, MAX_STEREOTYPE_SUGGESTIONS)
            .map(stereotype => {
                const stated = clauseFor(stereotype);
                return this.edit(
                    document,
                    diagnostic,
                    stated ? `Change to ${stereotype} ${stated}` : `Change to ${stereotype}`,
                    [{ range: keyword.range, newText: stereotype },
                        ...stated && name ? [{ range: { start: name.range.end, end: name.range.end }, newText: ` ${stated}` }] : []],
                    false
                );
            });
    }

    /**
     * A class below two disjoint classes can be repaired three ways, and which
     * is right is a modeling decision: drop either specialization, or accept
     * that the two types overlap and stop declaring them disjoint. All three
     * are offered rather than one being guessed at.
     */
    private resolveDisjointSupertypes(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        const subject = this.nodeAt(document, diagnostic, isClassDeclaration);
        const conflict = subject && findDisjointConflict(subject);
        if (!subject || !conflict) {
            return [];
        }
        const actions: CodeAction[] = [];

        // The conflicting class is often not what the subject writes: with
        // `CrazyMeeting specializes VeryBadMeeting` reaching `BadMeeting`, the
        // entry to drop is `VeryBadMeeting`. Find the entry each side of the
        // conflict is reached *through*.
        const removed = new Set<number>();
        for (const target of [conflict.first, conflict.second]) {
            if (target === subject) {
                continue;
            }
            const index = subject.specializes.findIndex(ref => {
                const parent = ref.ref;
                return !!parent && (parent === target || collectAncestors(parent).has(target));
            });
            const entry = index >= 0 ? subject.specializes[index].ref : undefined;
            if (index < 0 || !entry || removed.has(index)) {
                continue;
            }
            const edit = this.specializationRemoval(subject, index);
            if (!edit) {
                continue;
            }
            removed.add(index);
            const title = entry === target
                ? `Remove specialization of "${entry.name}"`
                : `Remove specialization of "${entry.name}", which inherits "${target.name}"`;
            actions.push(this.edit(document, diagnostic, title, [edit], false));
        }

        for (const genset of gensetsDeclaringDisjoint(conflict.first, conflict.second)) {
            const keyword = GrammarUtils.findNodeForKeyword(genset.$cstNode, 'disjoint');
            if (!keyword) {
                continue;
            }
            // Take the space after the keyword with it, so the line stays tidy.
            const declaring = AstUtils.getDocument(genset);
            const text = declaring.textDocument.getText();
            const end = text[keyword.end] === ' '
                ? declaring.textDocument.positionAt(keyword.end + 1)
                : keyword.range.end;
            actions.push(this.editAt(
                genset,
                diagnostic,
                `Make generalization set "${genset.name}" non-disjoint`,
                [{ range: { start: keyword.range.start, end }, newText: '' }],
                false
            ));
        }
        return actions;
    }

    /**
     * Offers to drop each `specializes` entry that brings in an ultimate
     * sortal, leaving whichever the modeler keeps as the single one.
     *
     * As with the disjointness fix, the entry to remove is the one the
     * ultimate sortal is *reached through*: `phase C specializes A, SubOfB`
     * must offer `SubOfB`, not the `B` named in the message.
     */
    private dropExtraUltimateSortals(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        const subject = this.nodeAt(document, diagnostic, isClassDeclaration);
        if (!subject) {
            return [];
        }
        const actions: CodeAction[] = [];
        subject.specializes.forEach((ref, index) => {
            const parent = ref.ref;
            if (!parent) {
                return;
            }
            const reached = [parent, ...collectAncestors(parent)]
                .find(ancestor => isUltimateSortal(ancestor.stereotype));
            const edit = reached && this.specializationRemoval(subject, index);
            if (!reached || !edit) {
                return;
            }
            const title = reached === parent
                ? `Remove specialization of "${parent.name}"`
                : `Remove specialization of "${parent.name}", which inherits "${reached.name}"`;
            actions.push(this.edit(document, diagnostic, title, [edit], false));
        });
        // Only worth offering when there is a choice; a single entry carrying
        // two ultimate sortals is a contradiction further up, not here.
        return actions.length > 1 ? actions : [];
    }

    /** `[*..n]` is meaningless; `[0..n]` is what was meant. */
    private replaceStarLowerBound(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const node = this.nodeAt(document, diagnostic, isCardinality);
        const range = node?.$cstNode?.range;
        if (!node || !range || node.upperBound === undefined) {
            return undefined;
        }
        // Fixing only the star in [*..0] would introduce zero-upper instead.
        // Choosing a different upper bound is a separate modeling decision.
        if (Number(node.upperBound) === 0) {
            return undefined;
        }
        const newText = `[0..${node.upperBound}]`;
        return this.edit(document, diagnostic, `Change to ${newText}`, [{ range, newText }]);
    }

    /**
     * Drops the single `specializes` entry the diagnostic points at, keeping
     * any siblings and removing the keyword entirely when it was the only one.
     */
    private removeOffendingSpecialization(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const owner = this.nodeAt(document, diagnostic, isClassDeclaration);
        if (!owner || owner.specializes.length === 0) {
            return undefined;
        }
        const index = this.referenceIndexAt(owner.specializes, diagnostic, document) ?? 0;
        const target = owner.specializes[index];
        const targetRange = target?.$refNode?.range;
        if (!targetRange) {
            return undefined;
        }

        const edit = this.specializationRemoval(owner, index);
        if (!edit) {
            return undefined;
        }
        const title = owner.specializes.length === 1
            ? `Remove "specializes ${target.$refText}"`
            : `Remove "${target.$refText}" from the specialization list`;
        return this.edit(document, diagnostic, title, [edit]);
    }

    /**
     * The edit that drops one entry from a `specializes` list, taking the
     * keyword with it when it was the only entry and the joining comma
     * otherwise.
     */
    private specializationRemoval(owner: ClassDeclaration, index: number): TextEdit | undefined {
        const targetRange = owner.specializes[index]?.$refNode?.range;
        if (!targetRange) {
            return undefined;
        }
        if (owner.specializes.length === 1) {
            const keyword = GrammarUtils.findNodeForKeyword(owner.$cstNode, 'specializes');
            const start = keyword ? keyword.range.start : targetRange.start;
            return { range: { start, end: targetRange.end }, newText: '' };
        }
        const previous = index > 0 ? owner.specializes[index - 1].$refNode?.range.end : undefined;
        const next = index === 0 ? owner.specializes[1].$refNode?.range.start : undefined;
        const range = previous
            ? { start: previous, end: targetRange.end }
            : next
                ? { start: targetRange.start, end: next }
                : targetRange;
        return { range, newText: '' };
    }

    /** A datatype may only be restricted to `abstract-individuals`, so drop the clause. */
    private removeNatureClause(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const node = this.nodeAt(document, diagnostic, isDatatypeLike);
        const removal = node && this.natureClauseRemoval(node);
        if (!removal) {
            return undefined;
        }
        return this.edit(document, diagnostic, 'Remove the nature restriction', [removal]);
    }

    /** The edit that deletes an `of ...` clause, wherever it is written. */
    private natureClauseRemoval(node: { natures: string[]; $cstNode?: CstNode }): TextEdit | undefined {
        if (node.natures.length === 0) {
            return undefined;
        }
        const keyword = GrammarUtils.findNodeForKeyword(node.$cstNode, 'of');
        const natureNodes = GrammarUtils.findNodesForProperty(node.$cstNode, 'natures');
        const last = natureNodes[natureNodes.length - 1];
        if (!keyword || !last) {
            return undefined;
        }
        return { range: { start: keyword.range.start, end: last.range.end }, newText: '' };
    }

    /** Deletes the repeated attribute, literal, relation or end declaration. */
    private removeDuplicateMember(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const root = document.parseResult.value.$cstNode;
        // Both members written here: the second is the redundant one, and
        // deleting it is the repair. With the other one in a different file,
        // which of the two is redundant is a question about the model.
        if (!root || (diagnostic.data as { local?: boolean } | undefined)?.local === false) {
            return undefined;
        }
        const offset = document.textDocument.offsetAt(diagnostic.range.start);
        const leaf = CstUtils.findLeafNodeAtOffset(root, offset);
        const member = leaf && AstUtils.getContainerOfType(leaf.astNode, isRemovableMember);
        const range = member?.$cstNode?.range;
        if (!member || !range) {
            return undefined;
        }
        if (isEnumLiteral(member)) {
            // Literals are comma-separated, so take the preceding comma too.
            const literals = (member.$container as Enumeration).literals;
            const index = literals.indexOf(member);
            const previous = index > 0 ? literals[index - 1].$cstNode?.range.end : undefined;
            return this.edit(document, diagnostic, `Remove the duplicate literal "${member.name}"`, [
                { range: previous ? { start: previous, end: range.end } : range, newText: '' }
            ]);
        }
        // Two declarations of one name are not always two of one thing.
        // `name: string` written twice says it twice, and deleting the second
        // loses nothing; `name: string` beside `name: number`, or two
        // relations called `has` running to different classes, are separate
        // claims that happen to collide. Deleting either of those is a
        // decision, so it is offered and not applied unread -- a blanket
        // `--fix` used to take a whole relation out of the model in silence.
        const collision = this.collidingName(member);
        const equivalent = collision?.twin !== undefined
            && normalizedText(collision.twin) === normalizedText(member);
        const action = this.edit(document, diagnostic,
            equivalent
                ? 'Remove the duplicate declaration'
                : `Remove this declaration of "${collision?.name ?? '?'}", and what it says`,
            [{ range: this.lineRange(range), newText: '' }]);
        return equivalent ? action : { ...action, data: { ...(action.data as object ?? {}), batchSafe: false } };
    }

    /**
     * The name this member collides under, and the other member holding it.
     *
     * Read from `collectMembers`, which is where the namespace they collide
     * in is defined: an end is a property of the classifier at the *opposite*
     * side, so what shares a name with an attribute is not always written
     * anywhere near it, and the name is not always on the node being deleted
     * -- an unnamed relation collides through the end it carries. Deriving
     * either a second time here would be two answers to one question.
     */
    private collidingName(
        member: Attribute | EnumLiteral | Relation
    ): { name: string; twin: AstNode | undefined } | undefined {
        // Whose namespace this collides in is not always where it is written:
        // a package-level `relation Person [1] -- [*] (foo) Car` puts `foo`
        // into `Person`, and its own container is the package. So both ends
        // are candidates as well as whatever encloses it.
        const candidates = [
            AstUtils.getContainerOfType(member, isClassifier),
            ...(isRelation(member) ? [getRelationSource(member), member.target?.ref] : [])
        ].filter((node): node is Classifier => !!node && isClassifier(node));

        const owns = (node: AstNode): boolean =>
            node === member || AstUtils.getContainerOfType(node, isRemovableMember) === member;
        for (const classifier of candidates) {
            const members = collectMembers(classifier, this.reverse);
            const mine = members.find(entry => owns(entry.node));
            if (mine) {
                return {
                    name: mine.name,
                    twin: members.find(entry => entry.name === mine.name && !owns(entry.node))?.node
                };
            }
        }
        return undefined;
    }

    /** Retypes the referenced class as a `type`, which is what a higher-order reference requires. */
    private makeTargetHigherOrder(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const target = this.higherOrderTarget(document, diagnostic);
        const stereotypeNode = target && GrammarUtils.findNodeForProperty(target.$cstNode, 'stereotype');
        if (!target || !stereotypeNode) {
            return undefined;
        }
        // Written where the class is: a categorizer or an `instanceOf` target
        // is usually declared in another file, and the repair is an edit
        // there. It used to decline rather than reach across.
        return this.editAt(target, diagnostic, `Make "${target.name}" a type`, [
            { range: stereotypeNode.range, newText: 'type' }
        ]);
    }

    private higherOrderTarget(document: LangiumDocument, diagnostic: Diagnostic): ClassDeclaration | undefined {
        const genset = this.nodeAt(document, diagnostic, isGeneralizationSet);
        if (genset) {
            const categorizer = genset.categorizers
                .map(ref => ref.ref)
                .find(node => node && isClassDeclaration(node) && !isHigherOrder(node));
            return categorizer && isClassDeclaration(categorizer) ? categorizer : undefined;
        }
        const owner = this.nodeAt(document, diagnostic, isClassDeclaration);
        return owner?.instanceOf?.ref;
    }

    /** RelSpec suggests a specialization; this writes it. */
    private addRelationSpecialization(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const relation = this.nodeAt(document, diagnostic, isRelation);
        const cstNode = relation?.$cstNode;
        if (!relation || !cstNode || relation.specializes) {
            return undefined;
        }
        // The message names the general relation; recover it from the model so
        // the inserted text is a name that actually resolves.
        const general = this.generalRelationFor(relation);
        if (!general?.name) {
            return undefined;
        }
        const source = getRelationSourceName(general);
        const name = source ? `${source}.${general.name}` : general.name;
        return this.edit(document, diagnostic, `Specialize "${name}"`, [
            { range: { start: cstNode.range.end, end: cstNode.range.end }, newText: ` specializes ${name}` }
        ]);
    }

    private generalRelationFor(relation: Relation): Relation | undefined {
        const source = getRelationSource(relation);
        const target = relation.target?.ref;
        if (!source || !target || !isClassDeclaration(source) || !isClassDeclaration(target)) {
            return undefined;
        }
        const sourceAncestors = collectAncestors(source);
        const targetAncestors = collectAncestors(target);
        for (const other of documentRelationsOf(relation)) {
            if (other === relation || other.specializes || other.inverseOf || !other.name) {
                continue;
            }
            const otherSource = getRelationSource(other);
            const otherTarget = other.target?.ref;
            if (!otherSource || !otherTarget || !isClassDeclaration(otherSource) || !isClassDeclaration(otherTarget)) {
                continue;
            }
            const sourceOk = otherSource === source || sourceAncestors.has(otherSource);
            const targetOk = otherTarget === target || targetAncestors.has(otherTarget);
            if (sourceOk && targetOk && (otherSource !== source || otherTarget !== target)) {
                return other;
            }
        }
        return undefined;
    }

    /** Index of the cross-reference the diagnostic range falls inside. */
    private referenceIndexAt(
        references: readonly { $refNode?: { offset: number; end: number } }[],
        diagnostic: Diagnostic,
        document: LangiumDocument
    ): number | undefined {
        const offset = document.textDocument.offsetAt(diagnostic.range.start);
        for (let index = 0; index < references.length; index++) {
            const node = references[index].$refNode;
            if (node && node.offset <= offset && offset < node.end) {
                return index;
            }
        }
        return undefined;
    }

    private lineRange(range: Range): Range {
        return {
            start: { line: range.start.line, character: 0 },
            end: { line: range.end.line + 1, character: 0 }
        };
    }

    // --- fixes ------------------------------------------------------------

    private removeUse(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const node = this.nodeAt(document, diagnostic, isImport);
        const range = node && this.wholeLines(document, node);
        if (!range) {
            return undefined;
        }
        return this.edit(document, diagnostic, `Remove this "${node.use ? 'use' : 'import'}"`, [{ range, newText: '' }]);
    }

    private swapCardinalityBounds(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const node = this.nodeAt(document, diagnostic, isCardinality);
        const range = node?.$cstNode?.range;
        if (!node || !range || node.upperBound === undefined) {
            return undefined;
        }
        const newText = `[${node.upperBound}..${node.lowerBound}]`;
        return this.edit(document, diagnostic, `Swap bounds to ${newText}`, [{ range, newText }]);
    }

    /**
     * Deletes the repeated entry from a generalization set, including the
     * comma that joins it to its neighbor.
     */
    private removeDuplicateSpecific(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const genset = this.nodeAt(document, diagnostic, isGeneralizationSet);
        if (!genset) {
            return undefined;
        }
        const index = this.duplicateIndexAt(genset, diagnostic.range.start, document);
        if (index === undefined || index === 0) {
            return undefined;
        }
        const previous = genset.specifics[index - 1]?.$refNode?.range.end;
        const current = genset.specifics[index]?.$refNode?.range.end;
        if (!previous || !current) {
            return undefined;
        }
        // From the end of the previous entry through the end of this one,
        // which swallows the separating comma.
        return this.edit(document, diagnostic, 'Remove the duplicate entry', [
            { range: { start: previous, end: current }, newText: '' }
        ]);
    }

    private duplicateIndexAt(genset: GeneralizationSet, position: Position, document: LangiumDocument): number | undefined {
        const offset = document.textDocument.offsetAt(position);
        for (let index = 0; index < genset.specifics.length; index++) {
            const refNode = genset.specifics[index].$refNode;
            if (refNode && refNode.offset <= offset && offset < refNode.end) {
                return index;
            }
        }
        return undefined;
    }

    /**
     * RepRel is reported when *every* mediation admits more than one relator.
     * Restricting a single relator end to `[1]` is enough to make the relator
     * identifying, so the fix targets the first mediation.
     */
    private restrictRelatorEnd(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const relator = this.nodeAt(document, diagnostic, isClassDeclaration);
        if (!relator) {
            return undefined;
        }
        const mediation = getMediations(relator)[0];
        if (!mediation) {
            return undefined;
        }
        const cardinality = this.relatorEndCardinality(mediation.relation, relator);
        const range = cardinality?.$cstNode?.range;
        if (!range) {
            return undefined;
        }
        return this.edit(document, diagnostic, 'Restrict this relator end to [1]', [{ range, newText: '[1]' }]);
    }

    private relatorEndCardinality(relation: Relation, relator: ClassDeclaration): Cardinality | undefined {
        const targetRef: Reference<AstNode> | undefined = relation.target;
        return targetRef?.ref === relator ? relation.targetCardinality : relation.sourceCardinality;
    }

    /**
     * Offers one fix per ultimate sortal in scope whose ontological nature is
     * compatible with the sortal being fixed -- the identity provider it is
     * missing. Which one is correct is a modeling decision, so every viable
     * candidate is offered rather than one being guessed at.
     */
    private specializeUltimateSortal(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        const sortal = this.nodeAt(document, diagnostic, isClassDeclaration);
        if (!sortal) {
            return [];
        }
        return this.candidateUltimateSortals(sortal)
            .filter(candidate => this.isViableIdentityProvider(sortal, candidate.node))
            .sort(byQualificationThenName)
            .map(candidate => {
                const edit = this.addSpecialization(sortal, candidate.insertName);
                return edit && this.edit(
                    document,
                    diagnostic,
                    `Specialize "${candidate.insertName}" (${candidate.node.stereotype})`,
                    [edit],
                    false
                );
            })
            .filter((action): action is CodeAction => action !== undefined);
    }

    /**
     * Or it is the ultimate sortal itself.
     *
     * Nothing in scope has to supply the identity: a `subkind` under two
     * categories of events is an event, and saying so is the whole repair.
     * `specializeUltimateSortal` can only offer what the model already
     * declares, so a model that has not written its kinds yet -- which is a
     * model early on -- was left with an error and nothing to do about it.
     *
     * Only the ultimate sortals, since only they end the search for identity,
     * and only those whose natures fit what the class inherits, which is what
     * puts `event` above `kind` under a category of events.
     */
    private becomeAnUltimateSortal(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        const sortal = this.nodeAt(document, diagnostic, isClassDeclaration);
        return sortal ? this.stereotypeChanges(document, diagnostic, sortal, isUltimateSortal) : [];
    }

    /**
     * The packages a reference written here could name, and how it would have
     * to spell each of them: unqualified for the writer's own package and for
     * global packages, package-qualified for what it imports.
     *
     * Only these three sources are in scope (see `TontoScopeProvider`), so a
     * candidate from, say, a sibling package that is neither imported nor
     * global is correctly not offered -- writing it would not link.
     */
    private reachablePackages(from: AstNode): Array<{ pkg: Package; qualified: boolean }> {
        const ownPackage = AstUtils.getContainerOfType(from, isPackage);
        const model = AstUtils.getDocument(from).parseResult.value as Model;
        const reachable: Array<{ pkg: Package; qualified: boolean }> = [];
        if (ownPackage) {
            reachable.push({ pkg: ownPackage, qualified: false });
        }
        for (const imp of [...model.imports, ...(ownPackage?.imports ?? [])]) {
            const target = imp.package?.ref;
            if (target && target !== ownPackage) {
                reachable.push({ pkg: target, qualified: true });
            }
        }
        // Declarations of `global` packages are visible everywhere unqualified.
        for (const otherDocument of this.documents.all) {
            for (const pkg of (otherDocument.parseResult?.value as Model | undefined)?.packages ?? []) {
                if (otherDocument.uri.toString() === 'tonto:/builtin/datatypes.tonto' && pkg !== ownPackage) {
                    reachable.push({ pkg, qualified: false });
                }
            }
        }
        return reachable;
    }

    /**
     * Ultimate sortals a reference from `sortal` could actually resolve to,
     * paired with the exact name to write.
     */
    private candidateUltimateSortals(sortal: ClassDeclaration): Candidate[] {
        const seen = new Set<ClassDeclaration>();
        const candidates: Candidate[] = [];
        for (const { pkg, qualified } of this.reachablePackages(sortal)) {
            for (const declaration of pkg.declarations) {
                if (!isClassDeclaration(declaration) || seen.has(declaration)) {
                    continue;
                }
                seen.add(declaration);
                if (isUltimateSortal(declaration.stereotype) && declaration.name) {
                    candidates.push({
                        node: declaration,
                        insertName: qualified ? `${pkg.name}.${declaration.name}` : declaration.name,
                        qualified
                    });
                }
            }
        }
        return candidates;
    }

    private isViableIdentityProvider(sortal: ClassDeclaration, candidate: ClassDeclaration): boolean {
        if (candidate === sortal) {
            return false;
        }
        // Specializing a descendant would close a generalization cycle.
        if (collectAncestors(candidate).has(sortal)) {
            return false;
        }
        if (sortal.natures.length === 0) {
            return true;
        }
        // A candidate that declares no natures still carries the identity
        // natures implied by its stereotype (a `kind` yields functional
        // complexes, a `collective` yields collectives, and so on).
        const candidateNatures = candidate.natures.length > 0
            ? candidate.natures
            : allowedNaturesFor(candidate.stereotype) ?? [];
        if (candidateNatures.length === 0) {
            return true;
        }
        return naturesNotPermittedBy(candidateNatures, sortal.natures).length === 0;
    }

    /**
     * Writes the specialization in the right place: appended to an existing
     * `specializes` list, otherwise inserted before the class body, otherwise
     * at the end of the declaration.
     */
    private addSpecialization(sortal: ClassDeclaration, name: string): TextEdit | undefined {
        if (sortal.specializes.length > 0) {
            const last = sortal.specializes[sortal.specializes.length - 1].$refNode;
            return last && { range: { start: last.range.end, end: last.range.end }, newText: `, ${name}` };
        }
        const cstNode = sortal.$cstNode;
        if (!cstNode) {
            return undefined;
        }
        const brace = GrammarUtils.findNodeForKeyword(cstNode, '{');
        if (brace) {
            return { range: { start: brace.range.start, end: brace.range.start }, newText: `specializes ${name} ` };
        }
        return { range: { start: cstNode.range.end, end: cstNode.range.end }, newText: ` specializes ${name}` };
    }

    // --- helpers ----------------------------------------------------------

    private nodeAt<T extends AstNode>(
        document: LangiumDocument,
        diagnostic: Diagnostic,
        predicate: (node: unknown) => node is T
    ): T | undefined {
        const root = document.parseResult.value.$cstNode;
        if (!root) {
            return undefined;
        }
        const offset = document.textDocument.offsetAt(diagnostic.range.start);
        const leaf = CstUtils.findLeafNodeAtOffset(root, offset);
        return leaf && AstUtils.getContainerOfType(leaf.astNode, predicate);
    }

    /** The full lines a node occupies, so deleting it leaves no blank line behind. */
    private wholeLines(document: LangiumDocument, node: Import): Range | undefined {
        const range = node.$cstNode?.range;
        if (!range) {
            return undefined;
        }
        return {
            start: { line: range.start.line, character: 0 },
            end: { line: range.end.line + 1, character: 0 }
        };
    }

    /**
     * Opens the powertype end of an `@instantiation` up to `[1..*]`.
     *
     * An explicit multiplicity is replaced in place. An omitted one has no
     * text to replace, so `[1..*]` is written where the grammar reads a target
     * multiplicity from -- before the end decorator, when there is one.
     */
    private widenPowertypeEnd(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const relation = this.nodeAt(document, diagnostic, isRelation);
        if (!relation) {
            return undefined;
        }
        const existing = relation.targetCardinality?.$cstNode;
        if (existing) {
            return this.edit(document, diagnostic, 'Change the powertype end to [1..*]',
                [{ range: existing.range, newText: '[1..*]' }]);
        }
        const range = this.multiplicityPosition(relation, false);
        if (!range) {
            return undefined;
        }
        return this.edit(document, diagnostic, 'Set the powertype end to [1..*]',
            [{ range, newText: '[1..*] ' }]);
    }


    /**
     * Raises a dependence end to at least one, keeping its upper bound.
     *
     * `[0..*]` becomes `[1..*]` rather than `[1]`: how many it depends on is
     * the model's to say, and only that there is one is forced.
     */
    private requireOne(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const node = this.nodeAt(document, diagnostic, isCardinality);
        const range = node?.$cstNode?.range;
        const bounds = node && getBounds(node);
        if (!range || !bounds) {
            return undefined;
        }
        const text = bounds.upper === 1 ? '[1]'
            : bounds.upper === Infinity ? '[1..*]'
            : `[1..${bounds.upper}]`;
        return this.edit(document, diagnostic, `Change to ${text}`, [{ range, newText: text }]);
    }

    /** Offers each replacement multiplicity for the cardinality at the diagnostic. */
    private replaceCardinality(document: LangiumDocument, diagnostic: Diagnostic, options: string[]): CodeAction[] {
        const range = this.nodeAt(document, diagnostic, isCardinality)?.$cstNode?.range;
        if (!range) {
            return [];
        }
        return options.map((text, index) => this.edit(
            document, diagnostic, `Change to ${text}`, [{ range, newText: text }], index === 0));
    }

    /** Keeps the stated lower bound while restricting a portion to one participant. */
    private restrictParticipationalParticipant(
        document: LangiumDocument, diagnostic: Diagnostic
    ): CodeAction | undefined {
        const cardinality = this.nodeAt(document, diagnostic, isCardinality);
        const bounds = cardinality && getBounds(cardinality);
        const range = cardinality?.$cstNode?.range;
        if (!bounds || !range) {
            return undefined;
        }
        const text = bounds.lower === 0 ? '[0..1]' : '[1]';
        return this.edit(document, diagnostic, `Change the participant end to ${text}`,
            [{ range, newText: text }]);
    }

    /**
     * Writes the `of` clause a non-sortal leaves out, from what the model
     * already puts beneath it.
     *
     * That closes the type to what is modeled now -- a category of
     * functional complexes cannot later take a collective -- which is a
     * decision, so the repair is offered and not applied for you. It is not
     * offered where the narrower reading would break a relation the type is
     * an end of: such a relation was admitted only because the type could be
     * anything, and is the misuse the rule exists to find, which the modeler
     * should see said as an error rather than find written in by a repair.
     */
    private stateNaturesBeneath(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const nonSortal = this.nodeAt(document, diagnostic, isClassDeclaration);
        const natures = nonSortal && naturesBeneath(this.reverse, nonSortal);
        const name = nonSortal?.$cstNode && GrammarUtils.findNodeForProperty(nonSortal.$cstNode, 'name');
        if (!nonSortal || !natures || !name) {
            return undefined;
        }
        const atoms = expandNatures(natures);
        if (!this.reverse.touching(nonSortal).every(relation => stillAdmitsWhenNarrowed(relation, nonSortal, atoms))) {
            return undefined;
        }
        const clause = `of ${natures.join(', ')}`;
        return this.edit(document, diagnostic, `Write "${clause}"`,
            [{ range: { start: name.range.end, end: name.range.end }, newText: ` ${clause}` }]);
    }

    /**
     * The two readings of a portion that two participations each require one
     * participant of. Either the part is not one participant's portion of
     * the whole at all, and the parthood is `@structural`; or one of the two
     * took part in the whole event rather than in this portion of it, and
     * its participation moves to the whole.
     *
     * Each is offered only where it clears the diagnostic. A parthood
     * changed while another still makes the event a portion leaves the
     * conflict where it was, and so does moving one of three participations.
     * The move is written by name, so it is offered only where the whole is
     * declared in the participation's own package and the name resolves as
     * written.
     */
    private separatePortionParticipants(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        const event = this.nodeAt(document, diagnostic, isClassDeclaration);
        const conflict = event && portionParticipantConflict(this.reverse, event);
        if (!event || !conflict) {
            return [];
        }
        const actions: CodeAction[] = [];
        const parthoods = participationalParthoods(this.reverse, event);
        const keyword = parthoods.length === 1
            ? GrammarUtils.findNodeForProperty(parthoods[0].$cstNode, 'stereotype')
            : undefined;
        if (keyword) {
            actions.push(this.editAt(parthoods[0], diagnostic, 'Make the parthood "@structural"',
                [{ range: keyword.range, newText: 'structural' }], false));
        }
        const own = parthoods.filter(parthood => wholeOf(parthood) !== event
            && (parthood.target?.ref === event || getRelationSource(parthood) === event));
        const whole = own.length === 1 ? wholeOf(own[0]) : undefined;
        if (!whole || !isClassDeclaration(whole) || conflict.required.length !== 2) {
            return actions;
        }
        for (const { relation, participant } of conflict.required) {
            const target = GrammarUtils.findNodeForProperty(relation.$cstNode, 'target');
            const samePackage = AstUtils.getContainerOfType(relation, isPackage)
                === AstUtils.getContainerOfType(whole, isPackage);
            // Only a participation into this event itself moves; one into a
            // type above it says something about every instance of that type.
            if (!target || !samePackage || relation.target?.ref !== event) {
                continue;
            }
            actions.push(this.editAt(relation, diagnostic,
                `Move the participation of "${participant.name}" to "${whole.name}"`,
                [{ range: target.range, newText: whole.name }], false));
        }
        return actions;
    }

    /**
     * Drops an ineffective `ordered`, together with whatever punctuation would
     * be left dangling: `(ordered)` goes entirely rather than leaving `{}`,
     * and an end meta-attribute that said nothing else goes with its comma.
     */
    private removeFlag(document: LangiumDocument, diagnostic: Diagnostic, keyword: string): CodeAction | undefined {
        const root = document.parseResult.value.$cstNode;
        const offset = root && document.textDocument.offsetAt(diagnostic.range.start);
        const owner = root && offset !== undefined
            ? CstUtils.findLeafNodeAtOffset(root, offset)?.astNode
            : undefined;
        const fix = (range: Range): CodeAction =>
            this.edit(document, diagnostic, `Remove "${keyword}"`, [{ range, newText: '' }]);

        if (isAttribute(owner)) {
            // The braces go too when nothing else was in them.
            const alone = [owner.isOrdered, owner.isConst, owner.isAddOnly, owner.isDerived]
                .filter(Boolean).length === 1;
            const block = alone ? this.bracedBlock(owner.$cstNode) : undefined;
            return this.rangeOrKeyword(document, block, owner.$cstNode, keyword, fix);
        }
        if (isRelationEndMetaAttributes(owner)) {
            // A flag is a word inside the parentheses. With nothing else in
            // there, the parentheses go with it; otherwise the word takes the
            // space after it, so `(const children)` does not become
            // `( children)`.
            const saysNothingElse = !owner.name && !owner.subsets && !owner.redefines
                && [owner.isConst, owner.isAddOnly].filter(Boolean).length === 1;
            if (saysNothingElse) {
                // With the space that held it apart from its neighbors, or
                // `[1] (addOnly) Person` came back as `[1]  Person`.
                return owner.$cstNode ? fix(this.withOneSpace(document, owner.$cstNode)) : undefined;
            }
            const word = GrammarUtils.findNodeForKeyword(owner.$cstNode, keyword);
            return word && fix(this.withOneSpace(document, word));
        }

        return this.rangeOrKeyword(document, undefined, owner?.$cstNode, keyword, fix);
    }

    private rangeOrKeyword(
        document: LangiumDocument,
        preferred: Range | undefined,
        cstNode: CstNode | undefined,
        keyword: string,
        fix: (range: Range) => CodeAction
    ): CodeAction | undefined {
        if (preferred) {
            return fix(preferred);
        }
        const node = GrammarUtils.findNodeForKeyword(cstNode, keyword);
        return node ? fix(this.withOneSpace(document, node)) : undefined;
    }

    /**
     * `const` on an attribute, written where the modifiers go: in front of the
     * type, after whatever other modifiers are already there.
     */
    private markAttributeConst(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const attribute = this.nodeAt(document, diagnostic, isAttribute);
        const type = attribute?.$cstNode && GrammarUtils.findNodeForProperty(attribute.$cstNode, 'type');
        if (!attribute || !type) {
            return undefined;
        }
        if (attribute.isAddOnly) {
            const written = GrammarUtils.findNodeForKeyword(attribute.$cstNode, 'addOnly');
            return written && this.edit(document, diagnostic, 'Mark it "const"', [
                { range: written.range, newText: 'const' }
            ]);
        }
        return this.edit(document, diagnostic, 'Mark it "const"', [
            { range: { start: type.range.start, end: type.range.start }, newText: 'const ' }
        ]);
    }

    /**
     * Turns a characterization of an event or a situation into the `const`
     * property it should have been.
     *
     * Offered only where the aspect says what its value is -- one attribute,
     * whose type the property takes. An aspect with several, or with none, is
     * a modeling decision rather than a rewrite, and the diagnostic stands on
     * its own there.
     */
    private reifyAsProperty(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const relation = this.nodeAt(document, diagnostic, isRelation);
        const aspect = relation && getRelationSource(relation);
        const bearer = relation?.target?.ref;
        if (!relation?.$cstNode || !aspect || !isClassDeclaration(aspect)
            || !bearer || !isClassDeclaration(bearer) || !bearer.$cstNode) {
            return undefined;
        }
        const value = aspect.attributes.length === 1 ? aspect.attributes[0] : undefined;
        const type = value?.type?.$refText;
        if (!type) {
            return undefined;
        }
        const name = aspect.name.charAt(0).toLowerCase() + aspect.name.slice(1);
        const indent = ' '.repeat(bearer.$cstNode.range.start.character + 4);
        const property = `${indent}${name}: const ${type}`;
        const open = GrammarUtils.findNodeForKeyword(bearer.$cstNode, '{');
        const written: TextEdit = open
            ? { range: { start: open.range.end, end: open.range.end }, newText: `\n${property}` }
            : {
                range: { start: bearer.$cstNode.range.end, end: bearer.$cstNode.range.end },
                newText: ` {\n${property}\n${' '.repeat(bearer.$cstNode.range.start.character)}}`
            };
        // Two files, in general: the property is written where the bearer is
        // and the characterization is deleted where it is written, and an
        // event characterized from another file is the ordinary case rather
        // than the exotic one. Keying both to the reported document put the
        // bearer's coordinates into the aspect's file, where they landed in
        // the middle of whatever happened to sit at them -- a package name,
        // in the split that found this.
        const changes: Record<string, TextEdit[]> = {};
        const into = (node: AstNode, edit: TextEdit): void => {
            (changes[AstUtils.getDocument(node).textDocument.uri] ??= []).push(edit);
        };
        into(bearer, written);
        // The aspect's one value is now the bearer's property, so where
        // nothing else names the aspect and it says nothing else, it goes as
        // well: left behind, it is a quality with no bearer, which
        // `moment-without-bearer` reports next.
        const inBody = relation.$container === aspect;
        const alone = aspect.$cstNode && aspect.relations.length === (inBody ? 1 : 0)
            && aspect.specializes.length === 0
            && this.reverse.referrers(aspect).every(referrer => referrer === relation
                || AstUtils.getContainerOfType(referrer, isClassDeclaration) === aspect);
        if (alone && aspect.$cstNode) {
            // Its `///` run goes with it, or it would document what follows.
            const lines = this.lineRange(aspect.$cstNode.range);
            const above = docLinesAbove(aspect).map(line => line.line);
            const start = above.length > 0 ? { line: Math.min(...above), character: 0 } : lines.start;
            into(aspect, { range: { start, end: lines.end }, newText: '' });
            if (!inBody) {
                into(relation, { range: this.lineRange(relation.$cstNode.range), newText: '' });
            }
        } else {
            into(relation, { range: this.lineRange(relation.$cstNode.range), newText: '' });
        }
        return {
            title: `Record it as a "const" property of "${bearer.name}"${alone ? `, in place of "${aspect.name}"` : ''}`,
            kind: CodeActionKind.QuickFix,
            diagnostics: [diagnostic],
            isPreferred: true,
            edit: { changes }
        };
    }

    /** `[1]`: an event has ended, so its end point is not optional. */
    private makeAttributeMandatory(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const attribute = this.nodeAt(document, diagnostic, isAttribute);
        const existing = attribute?.cardinality?.$cstNode;
        return existing
            ? this.edit(document, diagnostic, 'Change to [1]', [{ range: existing.range, newText: '[1]' }])
            : undefined;
    }

    /** `[0..1]`, written where the multiplicity goes: after the type. */
    private makeAttributeOptional(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const attribute = this.nodeAt(document, diagnostic, isAttribute);
        if (!attribute) {
            return undefined;
        }
        const existing = attribute.cardinality?.$cstNode?.range;
        const type = GrammarUtils.findNodeForProperty(attribute.$cstNode, 'type');
        const edit: TextEdit | undefined = existing
            ? { range: existing, newText: '[0..1]' }
            : type && { range: { start: type.range.end, end: type.range.end }, newText: ' [0..1]' };
        return edit ? this.edit(document, diagnostic, 'Change to [0..1]', [edit]) : undefined;
    }

    /** Deletes the repeated `@begin`, taking its `@` and the space after it. */
    private removeDuplicateAttributeStereotype(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const attribute = this.nodeAt(document, diagnostic, isAttribute);
        if (!attribute) {
            return undefined;
        }
        // The diagnostic is on the repeated occurrence, so ask which one that is.
        const offset = document.textDocument.offsetAt(diagnostic.range.start);
        const nodes = GrammarUtils.findNodesForProperty(attribute.$cstNode, 'stereotypes');
        const index = nodes.findIndex(node => offset >= node.offset && offset < node.end);
        const keyword = nodes[index];
        if (!keyword) {
            return undefined;
        }
        // Back up over the `@` (and any space between it and the word).
        const text = document.textDocument.getText();
        let start = keyword.offset;
        while (start > 0 && text[start - 1] !== '@') {
            start--;
        }
        const range = this.withOneSpace(document, {
            offset: start - 1,
            end: keyword.end,
            range: { start: document.textDocument.positionAt(start - 1), end: keyword.range.end }
        });
        return this.edit(document, diagnostic, `Remove the duplicate "@${attribute.stereotypes[index]}"`, [
            { range, newText: '' }
        ]);
    }

    private bracedBlock(cstNode: CstNode | undefined): Range | undefined {
        const open = GrammarUtils.findNodeForKeyword(cstNode, '{');
        const close = GrammarUtils.findNodeForKeyword(cstNode, '}');
        return open && close ? { start: open.range.start, end: close.range.end } : undefined;
    }

    /**
     * Deletes a standalone keyword such as `complete`, taking one
     * adjacent space with it so the line does not end up with a double gap.
     */
    private removeKeyword(
        document: LangiumDocument, diagnostic: Diagnostic, keyword: string, title: string
    ): CodeAction | undefined {
        const root = document.parseResult.value.$cstNode;
        const offset = root && document.textDocument.offsetAt(diagnostic.range.start);
        const owner = offset !== undefined && root
            ? CstUtils.findLeafNodeAtOffset(root, offset)?.astNode
            : undefined;
        const node = owner && GrammarUtils.findNodeForKeyword(owner.$cstNode, keyword);
        if (!node) {
            return undefined;
        }
        return this.edit(document, diagnostic, title, [{ range: this.withOneSpace(document, node), newText: '' }]);
    }

    /** A node's range extended over the space that follows it, or precedes it at end of line. */
    private withOneSpace(document: LangiumDocument, node: { offset: number; end: number; range: Range }): Range {
        const text = document.textDocument.getText();
        if (text[node.end] === ' ') {
            return { start: node.range.start, end: document.textDocument.positionAt(node.end + 1) };
        }
        if (text[node.offset - 1] === ' ') {
            return { start: document.textDocument.positionAt(node.offset - 1), end: node.range.end };
        }
        return node.range;
    }

    /** Drops a `<keyword> <reference>` clause, e.g. `inverseOf r`, from a relation. */
    private removeClause(
        document: LangiumDocument, diagnostic: Diagnostic, keyword: string, title: string
    ): CodeAction | undefined {
        const relation = this.nodeAt(document, diagnostic, isRelation);
        const start = relation && GrammarUtils.findNodeForKeyword(relation.$cstNode, keyword);
        const reference = relation && GrammarUtils.findNodeForProperty(relation.$cstNode, keyword);
        if (!start || !reference) {
            return undefined;
        }
        const range = { start: start.range.start, end: reference.range.end };
        return this.edit(document, diagnostic, title, [
            { range: this.withOneSpace(document, { offset: start.offset, end: reference.end, range }), newText: '' }
        ]);
    }

    /**
     * Drops whichever of `subsets`/`redefines` an end carries.
     *
     * The repair for three rules: an end that overrides itself, one whose type
     * does not narrow what it overrides, and one whose owner does not
     * specialize the other's. In each the clause states a relationship that
     * does not hold, and there is nothing to correct it *to* -- which end it
     * should point at instead is modeling.
     */
    private removeSelfEndReference(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const meta = this.nodeAt(document, diagnostic, isRelationEndMetaAttributes);
        const property = meta?.subsets ? 'subsets' as const : meta?.redefines ? 'redefines' as const : undefined;
        const range = meta && property && this.overrideClauseRemoval(document, meta, property);
        if (!meta || !property || !range) {
            return undefined;
        }
        return this.edit(document, diagnostic, `Remove "${property}"`, [{ range, newText: '' }]);
    }

    /**
     * The span that deletes a `subsets`/`redefines` clause: its keyword and
     * the reference after it, with the space in front so nothing is left
     * doubled inside the parentheses. Where the clause is all the decorator
     * says, the decorator goes with it.
     */
    private overrideClauseRemoval(
        document: LangiumDocument, end: RelationEndMetaAttributes, property: 'subsets' | 'redefines'
    ): Range | undefined {
        const keyword = GrammarUtils.findNodeForKeyword(end.$cstNode, property);
        const reference = GrammarUtils.findNodeForProperty(end.$cstNode, property);
        if (!keyword || !reference) {
            return undefined;
        }
        const saysNothingElse = !end.name && !end.isConst && !end.isAddOnly
            && !(property === 'subsets' ? end.redefines : end.subsets);
        if (saysNothingElse) {
            return end.$cstNode?.range;
        }
        // The space in front goes with it, so `(q subsets B.q)` does not
        // become `(q )`.
        return this.withOneSpace(document, {
            offset: keyword.offset, end: reference.end,
            range: { start: keyword.range.start, end: reference.range.end }
        });
    }

    /**
     * Adds `const` beside the `subsets`/`redefines` that reported it, which is
     * where the other meta-attributes of this end already sit.
     */
    private addConstToEnd(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const meta = this.nodeAt(document, diagnostic, isRelationEndMetaAttributes);
        const range = meta?.$cstNode?.range;
        if (!meta || !range) {
            return undefined;
        }
        if (meta.isAddOnly) {
            const written = GrammarUtils.findNodeForKeyword(meta.$cstNode, 'addOnly');
            return written && this.edit(document, diagnostic, 'Make this end "const" too', [
                { range: written.range, newText: 'const' }
            ]);
        }
        // Just inside the parenthesis, where the flags of an end are written:
        // `(subsets X)` becomes `(const subsets X)`.
        const open = GrammarUtils.findNodeForKeyword(meta.$cstNode, '(');
        return open && this.edit(document, diagnostic, 'Make this end "const" too', [
            { range: { start: open.range.end, end: open.range.end }, newText: 'const ' }
        ]);
    }

    /**
     * Dependence preserves every link already acquired, but a plural end may
     * either be closed (`const`) or continue to acquire links (`addOnly`).
     * Neither reading is a batch-safe modeling choice.
     */
    private settleDependenceEnd(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        const choices = asArray(this.markEnd(document, diagnostic, 'const'));
        const mayGrow = (diagnostic.data as { mayGrow?: boolean } | undefined)?.mayGrow === true;
        if (!mayGrow) {
            return choices;
        }
        return [...choices, ...asArray(this.markEnd(document, diagnostic, 'addOnly'))]
            .map(action => ({ ...action, data: { ...(action.data as object ?? {}), batchSafe: false } }));
    }

    /**
     * A generalization the taxonomy forbids -- `kind Rule specializes Norm`,
     * where a kind cannot specialize another kind.
     *
     * Dropping the generalization is one answer, but usually the wrong one:
     * the hierarchy is what the modeler meant and the stereotype is what
     * needs adjusting. Under a `kind`, `Rule` can be any base sortal, so those
     * come first and the removal last.
     */
    private repairInvalidSpecialization(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        const node = this.nodeAt(document, diagnostic, isClassDeclaration);
        if (!node) {
            return [];
        }
        const actions = this.stereotypeChanges(document, diagnostic, node);
        const removal = this.removeOffendingSpecialization(document, diagnostic);
        if (removal) {
            actions.push({ ...removal, isPreferred: actions.length === 0 });
        }
        return actions;
    }

    /** The same, for a generalization a set declares rather than a clause. */
    private repairInvalidGensetSpecialization(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        const genset = this.nodeAt(document, diagnostic, isGeneralizationSet);
        const offset = document.textDocument.offsetAt(diagnostic.range.start);
        const specific = genset?.specifics.find(ref => {
            const node = ref.$refNode;
            return !!node && offset >= node.offset && offset <= node.end;
        })?.ref;
        const actions = specific && isClassDeclaration(specific)
            ? this.stereotypeChanges(document, diagnostic, specific)
            : [];
        const removal = this.removeGensetSpecific(document, diagnostic);
        if (removal) {
            actions.push({ ...removal, isPreferred: actions.length === 0 });
        }
        return actions;
    }

    /** Where a `derivedFrom` clause goes on a class: after what it specializes, before its body. */
    private derivationInsertion(classDeclaration: ClassDeclaration, text: string): TextEdit | undefined {
        const cst = classDeclaration.$cstNode;
        const brace = cst && GrammarUtils.findNodeForKeyword(cst, '{');
        if (brace) {
            return { range: { start: brace.range.start, end: brace.range.start }, newText: `derivedFrom ${text} ` };
        }
        return cst && { range: { start: cst.range.end, end: cst.range.end }, newText: ` derivedFrom ${text}` };
    }

    /**
     * Derives a historical role from a relation the model already has: one an
     * event founds it by, from something that can be an instance of it --
     * `Student.graduatedIn` for a `Graduate`. Better than writing a second
     * participation saying the same thing from the role.
     *
     * Only relations that can be named from here as written: named, and in
     * the role's own package.
     */
    private deriveFromWhatHappened(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        const role = this.nodeAt(document, diagnostic, isClassDeclaration);
        const pkg = role && AstUtils.getContainerOfType(role, isPackage);
        if (!role || !pkg || role.derivedFrom.length > 0) {
            return [];
        }
        const candidates = pkg.declarations
            .filter(isClassDeclaration)
            .filter(event => classifiesOnly(event, 'events') || classifiesOnly(event, 'processes'))
            .flatMap(event => foundingCandidatesInto(role, event, node => this.reverse.touching(node)))
            .filter(relation => relation.name && getRelationSource(relation) !== role
                && AstUtils.getContainerOfType(relation, isPackage) === pkg);
        return [...new Set(candidates)]
            .slice(0, TontoCodeActionProvider.MAX_CANDIDATES)
            .flatMap(relation => {
                const name = qualifiedRelationName(relation);
                const edit = name && this.derivationInsertion(role, name);
                return edit ? [this.edit(document, diagnostic, `Derive from "${name}"`, [edit], false)] : [];
            });
    }

    /**
     * A historical role under a role that lapses, where the role has a
     * relation an event founds it by: what was meant is usually the rigid
     * type, derived from what happened to the role -- a former employee is a
     * person who, as an employee, retired. Offered only for a historical role
     * with that one supertype and no derivation yet, and only where both
     * names can be written as they are.
     */
    private specializeTheRigidTypeAndDerive(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        const role = this.nodeAt(document, diagnostic, isClassDeclaration);
        const reference = role?.specializes.length === 1 ? role.specializes[0] : undefined;
        const lapsing = reference?.ref;
        const range = reference?.$refNode?.range;
        if (!role || !lapsing || !range || role.derivedFrom.length > 0) {
            return [];
        }
        const rigid = ultimateSortalOf(lapsing, isUltimateSortal);
        const pkg = AstUtils.getContainerOfType(role, isPackage);
        if (!rigid || AstUtils.getContainerOfType(rigid, isPackage) !== pkg) {
            return [];
        }
        return this.reverse.touching(lapsing)
            .filter(relation => foundsHistorically(relation) && relation.name && getRelationSource(relation) === lapsing)
            .slice(0, TontoCodeActionProvider.MAX_CANDIDATES)
            .map(relation => this.edit(document, diagnostic,
                `Specialize "${rigid.name}" and derive from "${reference.$refText}.${relation.name}"`, [
                    { range, newText: rigid.name },
                    { range: { start: range.end, end: range.end }, newText: ` derivedFrom ${reference.$refText}.${relation.name}` }
                ], false));
    }

    /** Drops a `derivedFrom` clause from a class, every name in it included. */
    private removeClassDerivation(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const classDeclaration = this.nodeAt(document, diagnostic, isClassDeclaration);
        const cst = classDeclaration?.$cstNode;
        const start = cst && GrammarUtils.findNodeForKeyword(cst, 'derivedFrom');
        const names = cst ? GrammarUtils.findNodesForProperty(cst, 'derivedFrom') : [];
        const last = names[names.length - 1];
        if (!start || !last) {
            return undefined;
        }
        const range = { start: start.range.start, end: last.range.end };
        return this.edit(document, diagnostic, 'Remove "derivedFrom"', [
            { range: this.withOneSpace(document, { offset: start.offset, end: last.end, range }), newText: '' }
        ]);
    }

    /** Names, for an event that more than one relation into could mean, each of them. */
    private nameTheDerivation(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        const role = this.nodeAt(document, diagnostic, isClassDeclaration);
        const offset = document.textDocument.offsetAt(diagnostic.range.start);
        const reference = role?.derivedFrom.find(ref => !!ref.$refNode && offset >= ref.$refNode.offset && offset <= ref.$refNode.end);
        const event = reference?.ref;
        const range = reference?.$refNode?.range;
        if (!role || !event || !isClassDeclaration(event) || !range) {
            return [];
        }
        // Only relations into the event itself: naming one into a type above
        // it would lose the narrowing the event was named for.
        return foundingCandidatesInto(role, event, node => this.reverse.touching(node))
            .filter(relation => relation.target?.ref === event)
            .map(relation => qualifiedRelationName(relation))
            .filter((name): name is string => !!name)
            .map(name => this.edit(document, diagnostic, `Derive from "${name}"`, [{ range, newText: name }], false));
    }

    /**
     * Offers a participation in each event the package declares, as
     * `mediateSomethingElse` offers a mediation: the event is the one thing
     * the language cannot invent, and naming the candidates is the next best.
     */
    private participateInAnEvent(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        const role = this.nodeAt(document, diagnostic, isClassDeclaration);
        const pkg = role && AstUtils.getContainerOfType(role, isPackage);
        if (!role || !pkg) {
            return [];
        }
        const insertion = insertionAfter(role, pkg);
        return pkg.declarations
            .filter(isClassDeclaration)
            .filter(candidate => classifiesOnly(candidate, 'events'))
            // What took part has to be something that can: a historical role
            // over a process may name an event, but not as its participant.
            .filter(event => naturesFitStereotype('participation', role, event))
            .slice(0, TontoCodeActionProvider.MAX_CANDIDATES)
            .map(event => this.edit(
                document, diagnostic,
                `Participate in "${event.name}"`,
                [{
                    range: insertion,
                    newText: `\n@participation relation ${role.name} (const) [0..*] -- [1] ${event.name}`
                }]
            ))
            .filter((action): action is CodeAction => !!action);
    }

    /** Restereotypes the specifics of a phase partition that are not phases. */
    private makeTheOddSpecificsPhases(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        const genset = this.nodeAt(document, diagnostic, isGeneralizationSet);
        return (genset?.specifics ?? [])
            .map(reference => reference.ref)
            .filter((specific): specific is ClassDeclaration =>
                !!specific && isClassDeclaration(specific) && specific.stereotype !== 'phase')
            .map(specific => {
                const keyword = GrammarUtils.findNodeForProperty(specific.$cstNode, 'stereotype');
                return keyword && this.editAt(
                    specific, diagnostic, `Change "${specific.name}" to phase`,
                    [{ range: keyword.range, newText: 'phase' }]);
            })
            .filter((action): action is CodeAction => !!action);
    }

    /** Restereotyping actions for a class, from what its neighbors allow. */
    private stereotypeChanges(
        _document: LangiumDocument, diagnostic: Diagnostic, node: ClassDeclaration,
        only: (stereotype: string) => boolean = () => true
    ): CodeAction[] {
        const keyword = GrammarUtils.findNodeForProperty(node.$cstNode, 'stereotype');
        if (!keyword) {
            return [];
        }
        return suggestedStereotypes(node, this.reverse)
            .filter(stereotype => stereotype !== node.stereotype && only(stereotype))
            .slice(0, MAX_STEREOTYPE_SUGGESTIONS)
            .map((stereotype, index) => this.editAt(node, diagnostic,
                `Change "${node.name}" to ${stereotype}`,
                [{ range: keyword.range, newText: stereotype }], index === 0));
    }

    /** Package names are conventionally capitalized. */
    /**
     * Renames a package to lower case, with everything that spells its name.
     *
     * Two kinds of reference do: a `use` of the package, and any name
     * qualified by it -- `Sales.Customer`, `Sales.Team.members` -- which
     * resolves to the declaration inside rather than to the package, so
     * `renameAction` would never see it and the rename would leave it
     * dangling. A reference through an import alias (`S.Customer`) does not
     * spell the package and is left alone, as is one to a package that merely
     * shares the prefix (`Sales.reports.X` belongs to `Sales.reports`, which
     * answers for its own name).
     */
    private lowerCasePackageName(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const pkg = this.nodeAt(document, diagnostic, isPackage);
        const nameNode = pkg && GrammarUtils.findNodeForProperty(pkg.$cstNode, 'name');
        if (!pkg?.name || !nameNode) {
            return undefined;
        }
        const oldName = pkg.name;
        const newName = lowerCasePackageName(oldName);
        if (newName === oldName) {
            return undefined;
        }
        if (ownerOf(pkg)?.packages.some(other => other !== pkg && other.name === newName)) return undefined;
        const changes: Record<string, TextEdit[]> = {
            [document.textDocument.uri]: [{ range: nameNode.range, newText: newName }]
        };
        let references = 0;
        // An import names the package whole. A reference to something inside
        // it spells the package only as a qualifier: `specializes Person`
        // inside `package Person` names the class, and is left as it is.
        const rewrite = (reference: ReferenceDescription, whole: boolean): void => {
            const source = this.documents.getDocument(reference.sourceUri);
            if (!source) {
                return;
            }
            if (!whole && !((source.parseResult.value as Model).packages ?? []).some(other => ownerOf(other) === ownerOf(pkg))) return;
            const written = source.textDocument.getText(reference.segment.range);
            const newText = whole && written === oldName ? newName
                : written.startsWith(`${oldName}.`) ? newName + written.slice(oldName.length)
                    : undefined;
            if (newText !== undefined) {
                (changes[source.textDocument.uri] ??= []).push({ range: reference.segment.range, newText });
                references++;
            }
        };
        for (const reference of this.indexManager.findAllReferences(pkg, this.locator.getAstNodePath(pkg))) {
            rewrite(reference, true);
        }
        for (const node of AstUtils.streamAllContents(pkg)) {
            if (typeof (node as { name?: unknown }).name === 'string') {
                for (const reference of this.indexManager.findAllReferences(node, this.locator.getAstNodePath(node))) {
                    rewrite(reference, false);
                }
            }
        }
        for (const source of this.documents.all) for (const ontology of (source.parseResult.value as Model).ontologies ?? []) {
            for (const bundle of ontology.bundles) {
                const at = bundleTargets.get(bundle) === pkg && GrammarUtils.findNodeForProperty(bundle.$cstNode, 'name');
                if (at) (changes[source.uri.toString()] ??= []).push({ range: at.range, newText: newName });
            }
        }
        const scope = references === 0
            ? ''
            : ` and ${references === 1 ? 'its one reference' : `its ${references} references`}`;
        return {
            title: `Rename to "${newName}"${scope}`,
            kind: CodeActionKind.QuickFix,
            diagnostics: [diagnostic],
            isPreferred: true,
            edit: { changes }
        };
    }

    /** Recases a type or member name, leaving any package qualification alone. */
    private recaseName(document: LangiumDocument, diagnostic: Diagnostic, to: 'upper' | 'lower'): CodeAction | undefined {
        const node = this.nodeAt(document, diagnostic, isRenameable);
        if (!node?.name) {
            return undefined;
        }
        return this.renameAction(document, diagnostic, node, recase(node.name, to));
    }

    /**
     * Renames a declaration *and everything that names it*, in this document
     * and any other that is loaded.
     *
     * Editing only the declaration is not a rename, it is a break: the first
     * version of this fix turned `kind carro` into `kind Carro` and left
     * `specializes carro` dangling. References may be written qualified, so
     * each one has its own last segment replaced rather than the whole text.
     */
    private renameAction(
        document: LangiumDocument, diagnostic: Diagnostic, node: AstNode & { name?: string }, newName: string
    ): CodeAction | undefined {
        if (newName === node.name) {
            return undefined;
        }
        const nameNode = GrammarUtils.findNodeForProperty(node.$cstNode, 'name');
        if (!nameNode) {
            return undefined;
        }
        const changes: Record<string, TextEdit[]> = {
            [document.textDocument.uri]: [{ range: nameNode.range, newText: newName }]
        };
        const simple = lastSegment(newName);
        let references = 0;
        for (const reference of this.indexManager.findAllReferences(node, this.locator.getAstNodePath(node))) {
            const source = this.documents.getDocument(reference.sourceUri);
            if (!source) {
                continue;
            }
            const written = source.textDocument.getText(reference.segment.range);
            const segments = written.split('.');
            segments[segments.length - 1] = simple;
            (changes[source.textDocument.uri] ??= []).push({
                range: reference.segment.range,
                newText: segments.join('.')
            });
            references++;
        }
        const scope = references === 0
            ? ''
            : ` and ${references === 1 ? 'its one reference' : `its ${references} references`}`;
        return {
            title: `Rename to "${simple}"${scope}`,
            kind: CodeActionKind.QuickFix,
            diagnostics: [diagnostic],
            isPreferred: true,
            edit: { changes }
        };
    }

    /**
     * Writes the `disjoint complete` generalization set the phases imply,
     * just after the class they divide -- over the phases no partition holds
     * yet, so a class already partitioned one way gets a second partition
     * rather than a set that repeats the first. Phase mixins are partitioned
     * the same way, and the check says which of the two it counted.
     */
    private addPhasePartition(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const parent = this.nodeAt(document, diagnostic, isClassDeclaration);
        const end = parent?.$cstNode?.range.end;
        if (!parent || !end) {
            return undefined;
        }
        // Only the phases written here: the set names them unqualified, so a
        // phase in another package would be written as a name this document
        // cannot resolve. The check says whether that is the case.
        const data = diagnostic.data as
            { local?: boolean; phases?: string[]; stereotype?: 'phase' | 'phaseMixin' } | undefined;
        const stereotype = data?.stereotype ?? 'phase';
        const phases = localPhasesOf(parent, stereotype)
            .filter(phase => !data?.phases || data.phases.includes(phase.name));
        if (phases.length < 2 || data?.local === false) {
            return undefined;
        }
        const taken = new Set(AstUtils.streamAst(document.parseResult.value).filter(isGeneralizationSet).map(set => set.name));
        let name = `${parent.name}Phase`;
        for (let count = 2; taken.has(name); count++) {
            name = `${parent.name}Phase${count}`;
        }
        // Named, not counted: beside an existing partition the set holds only
        // the phases outside it, and which those are is what the title has
        // to say for the choice to be an informed one.
        const named = phases.map(phase => `"${phase.name}"`).join(', ');
        return this.edit(document, diagnostic, `Add a disjoint complete generalization set over ${named}`, [{
            range: { start: end, end },
            newText: `\ndisjoint complete genset ${name} where ${phases.map(phase => phase.name).join(', ')} specializes ${parent.name}`
        }]);
    }

    /** A second `label`/`description` block replaces the first; delete it. */
    /**
     * Lifts a `label { }` or `description { }` block out of a body and writes
     * it as `///` lines above the declaration.
     *
     * The lines go after an existing run rather than before it, so prose
     * already written stays first and the tags follow it, which is the order
     * the run is read in. A text holding newlines becomes a tagged first line
     * and plain continuations, which is what the tag's own continuation rule
     * expects.
     */
    private convertLegacyTextBlock(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const block = this.nodeAt(document, diagnostic, isLegacyTextBlock);
        const owner = block?.$container;
        const blockRange = block?.$cstNode?.range;
        const ownerRange = owner?.$cstNode?.range;
        if (!block || !owner || !blockRange || !ownerRange) {
            return undefined;
        }
        const lines = block.items.flatMap(item => this.documentationLines(block.kind, item));
        if (lines.length === 0) {
            return this.edit(document, diagnostic, `Remove the empty "${block.kind}" block`, [
                { range: this.lineRange(blockRange), newText: '' }
            ]);
        }
        const indent = ' '.repeat(ownerRange.start.character);
        const written = lines.map(line => `${indent}/// ${line}`.trimEnd() + '\n').join('');
        // At the declaration's own line, so anything it is already documented
        // with stays above: prose first, then the tags, which is the order a
        // run is read in.
        const at = { line: ownerRange.start.line, character: 0 };
        return this.edit(document, diagnostic, 'Convert to "///" documentation', [
            { range: { start: at, end: at }, newText: written },
            // A body that held nothing else goes with the block: `kind Person`
            // says what `kind Person { }` says, with one thing to read.
            this.emptiedBody(document, block) ?? { range: this.lineRange(blockRange), newText: '' }
        ]);
    }

    /**
     * The edit that removes an owner's braces, when the block being converted
     * is all they contain. `undefined` when anything else is in there --
     * another member, or a comment, which the braces are not free to take
     * with them.
     */
    private emptiedBody(document: LangiumDocument, block: LegacyTextBlock): TextEdit | undefined {
        const owner = block.$container.$cstNode;
        const open = GrammarUtils.findNodeForKeyword(owner, '{');
        const close = GrammarUtils.findNodeForKeyword(owner, '}');
        const blockNode = block.$cstNode;
        if (!open || !close || !blockNode) {
            return undefined;
        }
        const text = document.textDocument.getText();
        const remainder = text.slice(open.end, blockNode.offset) + text.slice(blockNode.end, close.offset);
        if (remainder.trim().length > 0) {
            return undefined;
        }
        // Take the space before `{` with it, so no trailing gap is left.
        let start = open.offset;
        while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) {
            start--;
        }
        return {
            range: { start: document.textDocument.positionAt(start), end: close.range.end },
            newText: ''
        };
    }

    /** `@en "a\nb"` becomes `@en a` and a plain continuation line `b`. */
    private documentationLines(kind: string, item: { language?: string; text?: string }): string[] {
        // Half-written: `@en` with no text yet, which the parser recovers into
        // an item with neither field.
        if (!item.text || !item.language) {
            return [];
        }
        const unquoted = item.text.length >= 2 && /^["']/.test(item.text)
            ? item.text.slice(1, -1)
            : item.text;
        const lines = unquoted.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
        if (lines.length === 0) {
            return [];
        }
        const tag = kind === 'label' ? `@label:${item.language}` : `@${item.language}`;
        return [`${tag} ${lines[0]}`, ...lines.slice(1)];
    }

    /** Replaces a near-miss documentation tag with the one it was meant to be. */
    private correctDocumentationTag(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const data = diagnostic.data as { closest?: string; tag?: string } | undefined;
        if (!data?.closest || !data.tag) {
            return undefined;
        }
        const line = diagnostic.range.start.line;
        const text = document.textDocument.getText().split(/\r?\n/)[line] ?? '';
        const column = text.indexOf(`@${data.tag}`);
        if (column < 0) {
            return undefined;
        }
        return this.edit(document, diagnostic, `Change to "@${data.closest}"`, [{
            range: {
                start: { line, character: column },
                end: { line, character: column + data.tag.length + 1 }
            },
            newText: `@${data.closest}`
        }]);
    }

    /**
     * Offers to drop each `specializes` entry that closes a generalization
     * cycle -- the entry whose target reaches the class again.
     */
    private breakSpecializationCycle(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        const subject = this.nodeAt(document, diagnostic, isClassDeclaration);
        if (!subject) {
            return [];
        }
        const actions: CodeAction[] = [];
        subject.specializes.forEach((ref, index) => {
            const parent = ref.ref;
            if (!parent || (parent !== subject && !collectAncestors(parent).has(subject))) {
                return;
            }
            const edit = this.specializationRemoval(subject, index);
            if (edit) {
                actions.push(this.edit(document, diagnostic,
                    `Remove specialization of "${parent.name}", which closes the cycle`, [edit], false));
            }
        });
        return actions;
    }

    /** Removes the one generalization-set specific the diagnostic points at. */
    private removeGensetSpecific(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const genset = this.nodeAt(document, diagnostic, isGeneralizationSet);
        if (!genset) {
            return undefined;
        }
        const offset = document.textDocument.offsetAt(diagnostic.range.start);
        const index = genset.specifics.findIndex(ref => {
            const node = ref.$refNode;
            return !!node && offset >= node.offset && offset <= node.end;
        });
        const target = index >= 0 ? genset.specifics[index] : undefined;
        const range = target?.$refNode?.range;
        if (!target || !range) {
            return undefined;
        }
        if (genset.specifics.length === 1) {
            // A set with no specifics does not parse, and one is what is left.
            // The whole declaration goes: a generalization set that states no
            // generalization is not a repair, it is a leftover.
            return genset.$cstNode && this.edit(
                document, diagnostic, `Remove the generalization set "${genset.name}"`,
                [{ range: this.lineRange(genset.$cstNode.range), newText: '' }]);
        }
        // Specifics are comma-separated; take the joining comma with the entry.
        const previous = index > 0 ? genset.specifics[index - 1].$refNode?.range.end : undefined;
        const next = index === 0 && genset.specifics.length > 1
            ? genset.specifics[1].$refNode?.range.start
            : undefined;
        const span = previous ? { start: previous, end: range.end } : next ? { start: range.start, end: next } : range;
        return this.edit(document, diagnostic, `Remove "${target.$refText}" from the specifics`, [
            { range: span, newText: '' }
        ]);
    }

    /** A datatype may only specialize an abstract-individual class; drop the clause. */
    private removeDatatypeSpecialization(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const datatype = this.nodeAt(document, diagnostic, isDatatype);
        const keyword = datatype && GrammarUtils.findNodeForKeyword(datatype.$cstNode, 'specializes');
        const nodes = datatype && GrammarUtils.findNodesForProperty(datatype.$cstNode, 'specializes');
        const last = nodes && nodes[nodes.length - 1];
        if (!keyword || !last) {
            return undefined;
        }
        return this.edit(document, diagnostic, 'Remove the specialization', [
            { range: { start: keyword.range.start, end: last.range.end }, newText: '' }
        ]);
    }

    /**
     * Narrows an end of a specialization to what the general's end holds.
     *
     * The general's own multiplicity is always an answer -- every link of the
     * specialization is one of the general's, so whatever the general permits
     * the specialization may permit too.
     */
    private matchTheGeneralEnd(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const relation = this.nodeAt(document, diagnostic, isRelation);
        const general = relation?.specializes?.ref;
        const side = (diagnostic.data as { side?: 'source' | 'target' } | undefined)?.side;
        if (!relation || !general || !side) {
            return undefined;
        }
        const mine = side === 'source' ? relation.sourceCardinality : relation.targetCardinality;
        const theirs = side === 'source' ? general.sourceCardinality : general.targetCardinality;
        const range = mine?.$cstNode?.range;
        const text = range && clampedInto(mine, theirs, 'upper');
        if (!range || !text) {
            return undefined;
        }
        return this.edit(document, diagnostic, `Change to ${text}`, [{ range, newText: text }]);
    }

    /**
     * Brings an overriding end inside what the end it overrides holds.
     *
     * Only the bound the rule is about moves. An end that may hold *fewer* is
     * saying something a subsetting end is allowed to say, so `[0..2]` under a
     * general's `[1]` becomes `[0..1]` and not `[1]` -- copying the general's
     * multiplicity wholesale turned an optional end into a mandatory one,
     * which is a modeling claim no rule here makes.
     */
    private matchGeneralMultiplicity(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const meta = this.nodeAt(document, diagnostic, isRelationEndMetaAttributes);
        const general = (meta?.subsets ?? meta?.redefines)?.ref;
        if (!meta || !general) {
            return undefined;
        }
        const mine = getEndCardinality(meta);
        const range = mine?.$cstNode?.range;
        // The redefinition rule is about the lower bound and the other about
        // the upper; each moves its own.
        const text = range && clampedInto(mine, getEndCardinality(general),
            meta.redefines?.ref ? 'both' : diagnostic.code === 'redefinition-weakens-lower-bound' ? 'lower' : 'upper');
        if (!range || !text) {
            return undefined;
        }
        return this.edit(document, diagnostic, `Change to ${text}`, [{ range, newText: text }]);
    }

    /**
     * Or the bound is what is wrong.
     *
     * `addOnly` and `[1]` are a modeler saying two things at once: that links
     * accumulate here, and that there is only ever one of them. Dropping the
     * flag is one way to settle it and widening the end is the other -- and it
     * is often the one meant, since the flag was written on purpose. The lower
     * bound is kept, because how many are *required* is a separate claim: `[1]`
     * becomes `[1..*]`, `[2]` becomes `[2..*]`.
     *
     * An end or an attribute with no multiplicity written holds exactly one,
     * so there is nothing to widen and one to write.
     */
    private letItGrow(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const attribute = this.nodeAt(document, diagnostic, isAttribute);
        const meta = attribute ? undefined : this.nodeAt(document, diagnostic, isRelationEndMetaAttributes);
        const cardinality = attribute ? attribute.cardinality : meta && getEndCardinality(meta);
        const bounds = cardinality ? getBounds(cardinality) : { lower: 1, upper: 1 };
        if ((!attribute && !meta) || !bounds) {
            return undefined;
        }
        const text = `[${bounds.lower}..*]`;
        const written = cardinality?.$cstNode?.range;
        if (written) {
            return this.edit(document, diagnostic, `Let it grow: "${text}"`, [{ range: written, newText: text }]);
        }
        // Nothing written means one, and the multiplicity goes where the end
        // or the attribute would have carried it: in front of the decorator
        // for an end, and after the type for an attribute.
        const at = attribute
            ? this.after(attribute.$cstNode)
            : meta && this.before(meta.$cstNode);
        return at && this.edit(
            document, diagnostic, `Let it grow: "${text}"`,
            [{ range: at, newText: attribute ? ` ${text}` : `${text} ` }]
        );
    }

    /** An empty range at the end of a node, for something written after it. */
    private after(node: CstNode | undefined): Range | undefined {
        return node && { start: node.range.end, end: node.range.end };
    }

    /** An empty range at the start of a node, for something written in front. */
    private before(node: CstNode | undefined): Range | undefined {
        return node && { start: node.range.start, end: node.range.start };
    }

    /**
     * Repairs a relation whose stereotype only permits the reverse direction.
     *
     * Two shapes, because "reversed" means different things:
     *
     * - for parthood the part/whole roles come from the aggregation diamond,
     *   so mirroring the diamond is the whole fix and the classes stay put --
     *   which also leaves each multiplicity beside the class it constrains;
     * - otherwise the classes themselves must trade places, and everything
     *   attached to an end (multiplicity, end name, meta-attributes) travels
     *   with it.
     *
     * An internal relation's source is the class that encloses it, so a swap
     * would mean moving the declaration into another class. That is a
     * refactoring, not a quick fix, and nothing is offered.
     */
    private swapRelationEnds(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const relation = this.nodeAt(document, diagnostic, isRelation);
        if (!relation) {
            return undefined;
        }
        const mirrored = this.mirroredDiamond(relation);
        if (mirrored) {
            const newWhole = getRelationNotation(relation).wholeEnd === 'source'
                ? relation.target?.$refText
                : getRelationSourceName(relation);
            const title = newWhole
                ? `Turn the diamond round, making "${newWhole}" the whole`
                : 'Turn the diamond round';
            return this.edit(document, diagnostic, title, [mirrored]);
        }
        if (!isExternalRelation(relation)) {
            return undefined;
        }

        const sourceRef = relation.source?.$refNode;
        const targetRef = relation.target?.$refNode;
        if (!sourceRef || !targetRef) {
            return undefined;
        }
        const sourceParts = [relation.sourceMeta?.$cstNode, relation.sourceCardinality?.$cstNode];
        const targetParts = [relation.targetCardinality?.$cstNode, relation.targetMeta?.$cstNode];
        const text = document.textDocument.getText();
        // Everything between the two sides is the notation, kept verbatim --
        // it may carry a relation name between its dashes.
        const notationStart = sourceParts.filter(Boolean).pop()?.end ?? sourceRef.end;
        const notationEnd = targetParts.filter(Boolean)[0]?.offset ?? targetRef.offset;
        const notation = text.slice(notationStart, notationEnd);

        const join = (...pieces: (string | undefined)[]): string => pieces.filter(Boolean).join(' ');
        const newText = join(
            targetRef.text,
            ...targetParts.reverse().map(node => node?.text)
        ) + notation + join(
            ...sourceParts.reverse().map(node => node?.text),
            sourceRef.text
        );
        return this.edit(document, diagnostic, 'Swap the two ends', [
            { range: { start: sourceRef.range.start, end: targetRef.range.end }, newText }
        ]);
    }

    /**
     * The edit that mirrors an aggregation diamond, for parthood relations.
     *
     * Not a token swap: the marker and the relation name trade places, since
     * the grammar writes `<>-- name --` on one side and `-- name --<>` on the
     * other. The whole notation is rebuilt rather than the diamond patched.
     */
    private mirroredDiamond(relation: Relation): TextEdit | undefined {
        const mirror: Record<string, string> = { '<>--': '--<>', '--<>': '<>--' };
        const tokens = [...CstUtils.streamCst(relation.$cstNode!)]
            .filter(node => node.grammarSource && GrammarAST.isKeyword(node.grammarSource)
                && (node.text === '--' || node.text in mirror));
        const marker = tokens.find(node => node.text in mirror);
        if (!marker) {
            return undefined;
        }
        const name = GrammarUtils.findNodeForProperty(relation.$cstNode, 'name');
        const bounds = [...tokens, ...(name ? [name] : [])];
        const start = bounds.reduce((a, b) => (a.offset <= b.offset ? a : b));
        const end = bounds.reduce((a, b) => (a.end >= b.end ? a : b));

        const mirrored = mirror[marker.text];
        const newText = mirrored.startsWith('--')
            ? (name ? `-- ${name.text} ${mirrored}` : mirrored)
            : (name ? `${mirrored} ${name.text} --` : mirrored);
        return { range: { start: start.range.start, end: end.range.end }, newText };
    }

    /** Replaces a mistyped stereotype with the one the validator suggested. */
    private correctRelationStereotype(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const closest = (diagnostic.data as { closest?: string } | undefined)?.closest;
        const relation = this.nodeAt(document, diagnostic, isRelation);
        const node = relation && GrammarUtils.findNodeForProperty(relation.$cstNode, 'stereotype');
        if (!closest || !node) {
            return undefined;
        }
        return this.edit(document, diagnostic, `Change to "@${closest}"`, [
            { range: node.range, newText: closest }
        ]);
    }

    /** The same, for `@bgin birth: Date` on an attribute. */
    private correctAttributeStereotype(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const closest = (diagnostic.data as { closest?: string } | undefined)?.closest;
        const attribute = this.nodeAt(document, diagnostic, isAttribute);
        if (!closest || !attribute) {
            return undefined;
        }
        const offset = document.textDocument.offsetAt(diagnostic.range.start);
        const node = GrammarUtils.findNodesForProperty(attribute.$cstNode, 'stereotypes')
            .find(each => offset >= each.offset && offset < each.end);
        return node
            ? this.edit(document, diagnostic, `Change to "@${closest}"`, [{ range: node.range, newText: closest }])
            : undefined;
    }

    /** How many classes to offer before the list stops being a suggestion. */
    private static readonly MAX_CANDIDATES = 4;

    /**
     * The two ways to bind a second individual: say the end already there
     * comes in twos, or mediate something else as well.
     *
     * The shape mirrors `supplementTheWhole` because the omission is the same
     * one -- a moment that does not reach far enough to exist.
     */
    private strengthenTheMediations(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        const relator = this.nodeAt(document, diagnostic, isClassDeclaration);
        if (!relator) {
            return [];
        }
        // Every mediation of this relator, wherever written: the check counts
        // them across the workspace, so a repair that counted the ones in
        // this file offered to widen an end while another file held the
        // mediation the modeler meant.
        const mediations = this.reverse.touching(relator)
            .filter(relation => relation.stereotype === 'mediation' && getRelationSource(relation) === relator);
        return [
            ...this.widenAMediatedEnd(document, diagnostic, mediations),
            ...this.mediateSomethingElse(document, diagnostic, relator, mediations)
        ];
    }

    /**
     * "[1] Person" becomes "[2] Person": one relation binding two individuals
     * of the same type, which is what a marriage is.
     *
     * The upper bound is carried over rather than replaced -- widening
     * `[0..*]` to `[2]` would silently forbid the third participant.
     */
    private widenAMediatedEnd(document: LangiumDocument, diagnostic: Diagnostic, mediations: Relation[]): CodeAction[] {
        return mediations.flatMap(relation => {
            const cardinality = relation.targetCardinality;
            const bounds = cardinality ? getBounds(cardinality) : { lower: 1, upper: 1 };
            const range = cardinality?.$cstNode?.range
                ?? this.multiplicityPosition(relation, false);
            if (!bounds || bounds.lower >= 2 || !range) {
                return [];
            }
            const widened = bounds.upper === Infinity ? '[2..*]' : bounds.upper > 2 ? `[2..${bounds.upper}]` : '[2]';
            const mediated = relation.target?.ref;
            const action = this.editAt(
                relation, diagnostic,
                `Mediate two of "${mediated?.name ?? 'them'}": "${widened}"`,
                [{ range, newText: cardinality ? widened : `${widened} ` }]
            );
            return action ? [action] : [];
        });
    }

    /** Or the relator binds something else the model has not connected yet. */
    private mediateSomethingElse(
        document: LangiumDocument, diagnostic: Diagnostic, relator: ClassDeclaration, mediations: Relation[]
    ): CodeAction[] {
        const pkg = AstUtils.getContainerOfType(relator, isPackage);
        if (!pkg) {
            return [];
        }
        const already = new Set(mediations.map(relation => relation.target?.ref));
        const insertion = insertionAfter(relator, pkg);
        return pkg.declarations
            .filter(isClassDeclaration)
            .filter(candidate => candidate !== relator && !already.has(candidate)
                && naturesFitStereotype('mediation', relator, candidate))
            .slice(0, TontoCodeActionProvider.MAX_CANDIDATES)
            .map(mediated => this.edit(
                document, diagnostic,
                `Mediate "${mediated.name}" as well`,
                [{
                    range: insertion,
                    newText: `\n@mediation relation ${relator.name} [0..*] -- [1] ${mediated.name}`
                }]
            ))
            .filter((action): action is CodeAction => !!action);
    }

    /**
     * The two ways to give a whole more than one part: say that the part it
     * has comes in numbers, or give it another part.
     *
     * The parthoods come from the workspace, as the check's do, and each
     * repair is written where its relation is. Walking this document alone
     * meant the repair disagreed with the diagnostic about what there was.
     */
    private supplementTheWhole(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        const whole = this.nodeAt(document, diagnostic, isClassDeclaration);
        if (!whole) {
            return [];
        }
        const parthoods = this.reverse.touching(whole)
            .filter(relation => isParthood(relation) && this.wholeOf(relation) === whole);
        return [...this.widenAPartEnd(document, diagnostic, parthoods), ...this.addAnotherPart(document, diagnostic, whole, parthoods)];
    }

    /** The class at this relation's whole end, whichever end that is. */
    private wholeOf(relation: Relation): ClassDeclaration | undefined {
        const source = getRelationSource(relation);
        const target = relation.target?.ref;
        const whole = wholeEndOf(relation) === 'source' ? source : target;
        return isClassDeclaration(whole) ? whole : undefined;
    }

    /**
     * "[1] Engine" becomes "[2..*] Engine": the whole always had more than one
     * of them, and the model said so imprecisely.
     */
    private widenAPartEnd(document: LangiumDocument, diagnostic: Diagnostic, parthoods: Relation[]): CodeAction[] {
        return parthoods.flatMap(relation => {
            if (relation.stereotype === 'subQuantity' || relation.stereotype === 'subCollection') {
                // One sub-quantity of a kind and one sub-collection of a kind:
                // `sub-quantity-multiplicity` and `sub-collection-multiplicity`
                // both fix that end at `[1]`, so widening it answers one rule
                // by breaking another. The answer in both is another part.
                return [];
            }
            const atSource = wholeEndOf(relation) !== 'source';
            const cardinality = atSource ? relation.sourceCardinality : relation.targetCardinality;
            const bounds = cardinality && getBounds(cardinality);
            if (cardinality && (!bounds || bounds.lower !== 1)) {
                return [];
            }
            // An omitted multiplicity means exactly one, so it is the same
            // case -- there is just nothing to overwrite, and the bound goes
            // where it would have been written.
            const range = cardinality?.$cstNode?.range ?? this.multiplicityPosition(relation, atSource);
            if (!range) {
                return [];
            }
            const part = (atSource ? getRelationSource(relation) : relation.target?.ref) as ClassDeclaration | undefined;
            const action = this.editAt(
                relation, diagnostic,
                `Require more than one "${part?.name ?? 'part'}": "[2..*]"`,
                [{ range, newText: cardinality ? '[2..*]' : '[2..*] ' }]
            );
            return action ? [action] : [];
        });
    }

    /**
     * Where a multiplicity goes at an end that has none written.
     *
     * The two ends are not mirror images, and writing them as if they were is
     * what broke: the grammar reads a source end as decorator then
     * multiplicity and a target end as multiplicity then decorator, both
     * running outwards from the notation. So the source anchor is the
     * notation, which puts the multiplicity after any `(const)`, and the
     * target anchor is the decorator when there is one -- inserting before the
     * class instead left `(const) [2..*] Engine`, which does not parse.
     */
    private multiplicityPosition(relation: Relation, atSource: boolean): Range | undefined {
        const node = atSource
            ? ['<>--', '--<>', '--']
                .map(marker => GrammarUtils.findNodeForKeyword(relation.$cstNode, marker))
                .filter((found): found is CstNode => !!found)
                .sort((a, b) => a.offset - b.offset)[0]
            : relation.targetMeta?.$cstNode
                ?? GrammarUtils.findNodeForProperty(relation.$cstNode, 'target');
        return node && { start: node.range.start, end: node.range.start };
    }

    /**
     * Or the decomposition is simply unfinished. Every class the nature table
     * lets this one have as a part is offered, minus those it already has --
     * the modeler knows which, and nothing else here can.
     *
     * And minus its own lineage. Proper parthood is irreflexive, so a whole
     * and its part cannot be the same individual; a supertype or subtype of
     * the whole is a type whose instances may be exactly that. The written
     * repair says `[1] <>-- [1..*]`, and either direction then states a chain
     * that never stops: an ancestor as the part makes every whole part of a
     * whole (`parthood-climbs-forever`), a descendant makes every whole
     * contain one (`parthood-descends-forever`). `candidate !== whole` caught
     * only the same class, which is that mistake at zero levels of remove.
     */
    private addAnotherPart(
        document: LangiumDocument, diagnostic: Diagnostic, whole: ClassDeclaration, parthoods: Relation[]
    ): CodeAction[] {
        const pkg = AstUtils.getContainerOfType(whole, isPackage);
        if (!pkg) {
            return [];
        }
        const already = new Set(parthoods.map(relation =>
            wholeEndOf(relation) === 'source' ? relation.target?.ref : getRelationSource(relation)));
        const insertion = insertionAfter(whole, pkg);
        return pkg.declarations
            .filter(isClassDeclaration)
            .filter(candidate => !already.has(candidate) && canBePartOf(whole, candidate)
                && !isSameOrSpecializes(candidate, whole) && !isSameOrSpecializes(whole, candidate))
            .slice(0, TontoCodeActionProvider.MAX_CANDIDATES)
            .map(part => this.edit(
                document, diagnostic,
                `Add "${part.name}" as another part`,
                [{ range: insertion, newText: `\nrelation ${whole.name} [1] <>-- [1..*] ${part.name}` }]
            ))
            .filter((action): action is CodeAction => !!action);
    }

    /** Rewrites a class's stereotype keyword, leaving everything else alone. */
    private changeStereotype(
        document: LangiumDocument, diagnostic: Diagnostic, from: string, to: string
    ): CodeAction | undefined {
        const classDeclaration = this.nodeAt(document, diagnostic, isClassDeclaration);
        const keyword = classDeclaration && GrammarUtils.findNodeForKeyword(classDeclaration.$cstNode, from);
        if (!keyword || !this.stereotypeFitsTaxonomy(classDeclaration, to)) {
            return undefined;
        }
        return this.edit(document, diagnostic, `Change to "${to}"`, [{ range: keyword.range, newText: to }]);
    }

    /**
     * Whether a class could take this stereotype where it stands: under each
     * of its supertypes, over each of its direct subtypes, and with the
     * natures it is restricted to. A repair that answered one diagnostic with
     * another -- `lone-phase` making a phase under a role mixin a subkind --
     * is not offered.
     */
    private stereotypeFitsTaxonomy(classDeclaration: ClassDeclaration, stereotype: string): boolean {
        const supertypes = getDirectGeneralizations(classDeclaration);
        const subtypes = subtypesOf(this.reverse, classDeclaration)
            .filter(subtype => getDirectGeneralizations(subtype).includes(classDeclaration));
        return supertypes.every(supertype => !supertype.stereotype || canSpecializeByStereotype(stereotype, supertype.stereotype))
            && subtypes.every(subtype => !subtype.stereotype || canSpecializeByStereotype(subtype.stereotype, stereotype))
            && admitsStereotype(classDeclaration, stereotype);
    }

    /**
     * Two things say how many of a categorizer an individual instantiates,
     * and they disagree: the multiplicity, and the set's own words.
     *
     * A `complete` set says every instance of the base is under one of the
     * specifics, so the instantiation cannot start at zero -- and an
     * overlapping set says two of them may classify one individual, so the
     * instantiation cannot stop at one. Either side may be the one that was
     * meant, so both are offered: move the bound, or drop the word.
     *
     * The multiplicity is written on the relation, which is somewhere else in
     * the file (or in another one), so it travels as a path.
     */
    private settleTheInstantiationBound(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        const data = diagnostic.data as
            { bound?: 'lower' | 'upper' | 'both'; instantiation?: string } | undefined;
        const genset = this.nodeAt(document, diagnostic, isGeneralizationSet);
        const relation = this.nodeAtLocator(data?.instantiation);
        if (!data?.bound || !genset || !isRelation(relation)) {
            return [];
        }
        const actions: CodeAction[] = [];
        const cardinality = relation.targetCardinality;
        const bounds = cardinality ? getBounds(cardinality) : { lower: 1, upper: 1 };
        const range = cardinality?.$cstNode?.range ?? this.multiplicityPosition(relation, false);
        if (bounds && range) {
            // Every instance is under one of them, so at least one; two of
            // them may classify one individual, so more than one. A set that
            // says both leaves exactly one shape.
            const lower = data.bound === 'upper' ? bounds.lower : 1;
            const upper = data.bound === 'lower' ? bounds.upper : Infinity;
            const text = lower === upper
                ? `[${lower}]`
                : `[${lower}..${upper === Infinity ? '*' : upper}]`;
            const title = data.bound === 'lower'
                ? `Instantiate at least one: "${text}"`
                : data.bound === 'upper'
                    ? `Let it instantiate more than one: "${text}"`
                    : `Instantiate one of them, or more: "${text}"`;
            actions.push(this.editAt(
                relation, diagnostic, title,
                [{ range, newText: cardinality ? text : `${text} ` }]
            ));
        }
        // Where both bounds are constrained, neither word can go on its own:
        // dropping `complete` leaves an upper bound of one under an
        // overlapping set, and writing `disjoint` leaves a lower bound of zero
        // under a complete one. The multiplicity is the whole repair.
        const word = data.bound === 'lower' ? 'complete' : undefined;
        const written = word && genset.$cstNode && GrammarUtils.findNodeForKeyword(genset.$cstNode, word);
        if (word && written) {
            actions.push(this.edit(document, diagnostic, `Drop "${word}"`, [
                { range: { start: written.range.start, end: written.range.end }, newText: '' }
            ]));
        }
        if (data.bound === 'upper' && genset.$cstNode) {
            // In front of everything the declaration already says: the grammar
            // takes `disjoint` before `complete`, and writing it against
            // `genset` gave `complete disjoint genset`, which does not parse.
            const keyword = ['complete', 'genset']
                .map(word => GrammarUtils.findNodeForKeyword(genset.$cstNode, word))
                .find(node => !!node);
            if (keyword) {
                actions.push(this.edit(document, diagnostic, 'Make the set "disjoint"', [
                    { range: { start: keyword.range.start, end: keyword.range.start }, newText: 'disjoint ' }
                ]));
            }
        }
        return actions;
    }

    /**
     * The word at an end, where the word is the only thing wrong.
     *
     * `intrinsicMode CarCapacity` with an `@externalDependence` is an
     * extrinsic mode that has not said so: an intrinsic mode depends on
     * nothing beyond its bearer, which is the difference the two words carry.
     * Rather than deleting the relation, the class is offered the stereotypes
     * that would let it stand where it already stands -- at either end, since
     * either may be the one that was mis-stereotyped.
     *
     * Filtered twice over: by the natures the end leaves open, and by what
     * the class may be at all -- its `of` clause, what it specializes and
     * what specializes it, which is `admitsStereotype` and the specialization
     * table. A candidate that would trade this error for another is no
     * repair. And offered only where exactly one word survives that: several
     * would mean the question is what the class *is*, which is the modeler's
     * to answer and not a list's.
     */
    private restereotypeAnEnd(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        const relation = this.nodeAt(document, diagnostic, isRelation);
        if (!relation) {
            return [];
        }
        const ends = [
            { node: getRelationSource(relation), property: 'source' as const },
            { node: relation.target?.ref, property: 'target' as const }
        ];
        const actions: CodeAction[] = [];
        for (const end of ends) {
            const classDeclaration = end.node;
            if (!isClassDeclaration(classDeclaration) || !classDeclaration.$cstNode) {
                continue;
            }
            const keyword = GrammarUtils.findNodeForProperty(classDeclaration.$cstNode, 'stereotype');
            if (!keyword) {
                continue;
            }
            const viable = stereotypesAdmissibleAt(relation, end.property)
                .filter(candidate => candidate !== classDeclaration.stereotype
                    && admitsStereotype(classDeclaration, candidate)
                    && this.stillFitsItsTaxonomy(classDeclaration, candidate));
            // One word or none. Where several would satisfy the table, the
            // question is what the class *is* -- an event mediated by a
            // relator is not repaired by calling it a kind, a collective or a
            // quantity in turn -- and a list of guesses is no help. Where
            // exactly one fits, the model has already said which.
            if (viable.length === 1) {
                actions.push(this.editAt(
                    classDeclaration, diagnostic,
                    `Change "${classDeclaration.name}" to "${viable[0]}"`,
                    [{ range: keyword.range, newText: viable[0] }]
                ));
            }
        }
        return actions;
    }

    /** Whether the class could take this stereotype and keep its supertypes and subtypes. */
    private stillFitsItsTaxonomy(classDeclaration: ClassDeclaration, candidate: string): boolean {
        const above = getDirectGeneralizations(classDeclaration)
            .every((parent: ClassDeclaration) => canSpecializeByStereotype(candidate, parent.stereotype));
        const below = subtypesOf(this.reverse, classDeclaration)
            .every((child: ClassDeclaration) => canSpecializeByStereotype(child.stereotype, candidate));
        return above && below;
    }

    /**
     * Says which of the classes a bare name reaches was meant.
     *
     * One action per branch, in the order the lineage offers them, so the
     * nearest -- which is what the reference resolves to today -- comes
     * first. Only the reference text is rewritten; nothing else on the line
     * moves.
     */
    private qualifyTheShortReference(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        const node = this.nodeAt(document, diagnostic, isRelationEndMetaAttributes)
            ?? this.nodeAt(document, diagnostic, isRelation);
        const owner = node && AstUtils.getContainerOfType(node, isClassDeclaration);
        if (!node || !owner || !node.$cstNode) {
            return [];
        }
        const property = isRelation(node)
            ? 'specializes'
            : (node.subsets?.$refText && !node.subsets.$refText.includes('.') ? 'subsets' : 'redefines');
        const reference = GrammarUtils.findNodeForProperty(node.$cstNode, property);
        const written = reference?.text;
        if (!reference || !written) {
            return [];
        }
        const members = membersInScopeOf(owner);
        const found = isRelation(node) ? members.relations.get(written) : members.ends.get(written);
        return fromUnrelatedBranches(found ?? []).map(candidate => this.edit(
            document, diagnostic, `Write "${candidate.name}.${written}"`,
            [{ range: reference.range, newText: `${candidate.name}.${written}` }]
        ));
    }

    /**
     * What `mode` was standing in for.
     *
     * Four readings, and the model usually says which. An extrinsic mode is
     * one that depends on something beyond its bearer, so a class with an
     * `@externalDependence` is offered the extrinsic pair and a class without
     * one the intrinsic pair -- the other two are not proposed, since
     * `extrinsic-mode-without-dependence` would report the first the moment it
     * was written and the nature checks the second. Within a pair, the
     * ultimate sortal comes first and the `category` second: a non-sortal is
     * what speaks across kinds, and that is the rarer thing to mean.
     */
    private replaceTheDeprecatedStereotype(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        const classDeclaration = this.nodeAt(document, diagnostic, isClassDeclaration);
        if (!classDeclaration) {
            return [];
        }
        const written = new Set(classDeclaration.natures);
        // A class that says outright that it classifies both is the one case
        // the word was for, and a category over both is all it can become:
        // the clause already says which natures, so only the word changes.
        if (written.has('intrinsic-modes') && written.has('extrinsic-modes')) {
            return asArray(this.changeStereotype(document, diagnostic, classDeclaration.stereotype, 'category'));
        }
        const extrinsic = written.has('extrinsic-modes')
            || [classDeclaration, ...collectAncestors(classDeclaration)]
                .some(member => outgoingByStereotype(this.reverse, member, 'externalDependence').length > 0);
        const sortal = extrinsic ? 'extrinsicMode' : 'intrinsicMode';
        const nature = extrinsic ? 'extrinsic-modes' : 'intrinsic-modes';
        // Not where the class writes a nature the sortal cannot classify:
        // `stereotype-nature-mismatch` would report it the moment it landed.
        const admissible = classDeclaration.natures.every(one => one === nature);
        return [
            admissible ? this.changeStereotype(document, diagnostic, classDeclaration.stereotype, sortal) : undefined,
            this.becomeACategoryOf(document, diagnostic, classDeclaration, nature)
        ].filter((action): action is CodeAction => !!action);
    }

    /**
     * Rewrites the stereotype and pins the nature the word no longer says.
     *
     * A `category` classifies whatever its `of` clause admits, so the two
     * edits are one repair: without the clause the class would classify every
     * nature there is, which says less than the word it replaced.
     */
    private becomeACategoryOf(
        document: LangiumDocument, diagnostic: Diagnostic, classDeclaration: ClassDeclaration, nature: string
    ): CodeAction | undefined {
        const keyword = GrammarUtils.findNodeForKeyword(classDeclaration.$cstNode, classDeclaration.stereotype);
        const name = GrammarUtils.findNodeForProperty(classDeclaration.$cstNode, 'name');
        if (!keyword || !name) {
            return undefined;
        }
        const written = GrammarUtils.findNodeForKeyword(classDeclaration.$cstNode, 'of');
        const clause = written && classDeclaration.natures.length > 0
            // An `of` clause already there is rewritten whole, since what it
            // says is what the deprecated word was covering.
            ? {
                start: written.range.start,
                end: (GrammarUtils.findNodeForProperty(
                    classDeclaration.$cstNode, 'natures', classDeclaration.natures.length - 1
                ) ?? written).range.end
            }
            : { start: name.range.end, end: name.range.end };
        return this.edit(
            document, diagnostic, `Change to "category of ${nature}"`,
            [
                { range: keyword.range, newText: 'category' },
                { range: clause, newText: written && classDeclaration.natures.length > 0
                    ? `of ${nature}`
                    : ` of ${nature}` }
            ]
        );
    }

    /**
     * Answers "nothing bears it" with the association that already says so.
     *
     * A moment without a `@characterization`, or a relator without a
     * `@mediation`, usually has the relation written already and only lacks
     * the word: `relator Marriage { [1] -- [2] (spouses) Person }` is the
     * mediation, unstereotyped. Every plain association on the class whose end
     * natures would admit the stereotype is offered, so nothing is proposed
     * that the nature check would then reject.
     *
     * Only associations in this document are offered, since a code action
     * edits one file.
     */
    private stereotypeAnExistingAssociation(
        document: LangiumDocument, diagnostic: Diagnostic, stereotype: string, position: 'first' | 'second'
    ): CodeAction[] {
        const classDeclaration = this.nodeAt(document, diagnostic, isClassDeclaration);
        if (!classDeclaration) {
            return [];
        }
        // The stereotype has to put the reported class where the rule wants
        // it: a moment first, as what inheres; a role second, as what is
        // mediated. Fitting the ends' natures is not enough -- stereotyping
        // the association that has a process as its *constituent* left the
        // process unconstituted, and a role-mixin could be made the relator.
        const standsAt = (relation: Relation): boolean => {
            const source = getRelationSource(relation);
            const target = relation.target?.ref;
            const wholeAtTarget = PART_WHOLE_STEREOTYPES.has(stereotype) && wholeEndOf(relation) === 'target';
            const first = wholeAtTarget ? target : source;
            const second = wholeAtTarget ? source : target;
            return source !== target && (position === 'first' ? first : second) === classDeclaration;
        };
        return this.reverse.touching(classDeclaration)
            .filter(relation => !relation.stereotype && standsAt(relation) && stereotypeFitsEnds(relation, stereotype))
            .map(relation => {
                const source = getRelationSource(relation);
                const target = relation.target?.ref;
                const other = source === classDeclaration ? target : source;
                return this.editAt(
                    relation,
                    diagnostic,
                    `Add "@${stereotype}" to the association with "${other && 'name' in other ? other.name : '?'}"`,
                    [{
                        range: { start: relation.$cstNode!.range.start, end: relation.$cstNode!.range.start },
                        newText: `@${stereotype} `
                    }]
                );
            });
    }

    /**
     * The same relator the refactoring writes, offered from the diagnostic
     * that asks for it. The lightbulb is what finds the repair; the refactor
     * stays available at the cursor as well.
     */
    /**
     * Raises the lower bound of the one relation that founds a role to one,
     * keeping its upper bound. Offered, not applied unasked: the other reading
     * is that a second founding relation has not been written yet.
     */
    private requireTheFoundingRelation(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const replacement = (diagnostic.data as { replacement?: string } | undefined)?.replacement;
        const cardinality = this.nodeAt(document, diagnostic, isCardinality);
        const range = cardinality?.$cstNode?.range;
        if (!replacement || !range) {
            return undefined;
        }
        return this.edit(document, diagnostic, `Require one: "${replacement}"`, [{ range, newText: replacement }]);
    }

    /**
     * Writes a material end's multiplicity from its derivation: what the two
     * mediations derive, where the end contradicts or narrows it, and what
     * both allow, where the end admits more than they do. Only the last is
     * mechanical -- in the other two the end may be right and a mediation
     * wrong, or the narrower bound meant.
     */
    private useDerivedMaterialCardinality(
        document: LangiumDocument, diagnostic: Diagnostic
    ): CodeAction | undefined {
        const data = diagnostic.data as {
            side?: 'source' | 'target';
            replacement?: string;
        } | undefined;
        const relation = this.nodeAt(document, diagnostic, isRelation);
        if (!relation || !data?.side || !data.replacement) {
            return undefined;
        }
        const atSource = data.side === 'source';
        const cardinality = atSource ? relation.sourceCardinality : relation.targetCardinality;
        const range = cardinality?.$cstNode?.range ?? this.multiplicityPosition(relation, atSource);
        if (!range) {
            return undefined;
        }
        const title = diagnostic.code === 'material-cardinality-weaker'
            ? `Narrow the ${data.side} end to "${data.replacement}"`
            : `Use the derived ${data.side} cardinality "${data.replacement}"`;
        return this.edit(document, diagnostic, title, [{
            range,
            newText: cardinality ? data.replacement : `${data.replacement} `
        }]);
    }

    /**
     * Names the relator a material relation is derived from, among those
     * that mediate both of its ends.
     *
     * One action per relator, since which of several grounds the relation is
     * the modeler's to say; where only one does, it is still a claim the
     * model did not make, so none of these is applied unasked. Answers
     * `derivation-not-grounded` too, where the relator named binds only one
     * end and another binds both.
     */
    private deriveFromTheGroundingRelator(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        const relation = this.nodeAt(document, diagnostic, isRelation);
        const source = relation && getRelationSource(relation);
        const target = relation?.target?.ref;
        if (!relation || relation.stereotype !== 'material' || relation.derivedFrom.length > 1
            || !source || !isClassDeclaration(source) || !target || !isClassDeclaration(target)) {
            return [];
        }
        const current = relation.derivedFrom[0]?.ref;
        const candidates = groundingRelators(this.reverse, source, target).filter(relator => relator !== current);
        return candidates.flatMap(relator => {
            const name = this.nameInScope(relation, 'derivedFrom', relator);
            return name
                ? [this.edit(document, diagnostic, `Derive it from "${name}"`,
                    this.derivationWritten(document, relation, [name]), candidates.length === 1)]
                : [];
        });
    }

    /**
     * A `derivedFrom` on a relation nothing is derived for: say which derived
     * relation it is, where what follows the keyword decides it, or drop the
     * clause. Either way the model changes its mind about something, so both
     * are offered and neither is applied unasked.
     */
    private markDerivedOrUnderive(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        const relation = this.nodeAt(document, diagnostic, isRelation);
        const start = relation?.$cstNode?.range.start;
        if (!relation || !start) {
            return [];
        }
        const grounds = relation.derivedFrom.flatMap(reference => reference.ref ? [reference.ref] : []);
        const marked = relation.stereotype || grounds.length !== relation.derivedFrom.length ? undefined
            : ['material', 'comparative'].find(stereotype => grounds.every(ground => admits(stereotype, ground)));
        return [
            ...(marked && !(marked === 'material' && grounds.length > 1)
                ? [this.edit(document, diagnostic, `Mark it "@${marked}"`,
                    [{ range: { start, end: start }, newText: `@${marked} ` }])]
                : []),
            this.edit(document, diagnostic, 'Remove "derivedFrom"', this.derivationWritten(document, relation, []), false)
        ];
    }

    /** One relator per material relation: keep one, and let the rest be relations of their own. */
    private deriveFromOneOnly(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        const relation = this.nodeAt(document, diagnostic, isRelation);
        if (!relation) {
            return [];
        }
        return relation.derivedFrom.map(reference => reference.$refText).map(name =>
            this.edit(document, diagnostic, `Derive it from "${name}" only`,
                this.derivationWritten(document, relation, [name]), false));
    }

    /** Drops the one entry whose nature cannot ground the relation, and the clause if it was the only one. */
    private dropADerivationSource(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const relation = this.nodeAt(document, diagnostic, isRelation);
        const nodes = relation && GrammarUtils.findNodesForProperty(relation.$cstNode, 'derivedFrom');
        const offset = document.textDocument.offsetAt(diagnostic.range.start);
        const index = nodes?.findIndex(node => node.offset <= offset && offset < node.end) ?? -1;
        if (!relation || index < 0) {
            return undefined;
        }
        const kept = relation.derivedFrom.filter((_, at) => at !== index).map(reference => reference.$refText);
        const title = kept.length === 0 ? 'Remove "derivedFrom"'
            : `Remove "${relation.derivedFrom[index].$refText}" from "derivedFrom"`;
        return this.edit(document, diagnostic, title, this.derivationWritten(document, relation, kept), false);
    }

    /**
     * The edit that leaves a relation derived from exactly `names`: the clause
     * rewritten where there is one, appended where there is none, and gone
     * when `names` is empty.
     */
    private derivationWritten(document: LangiumDocument, relation: Relation, names: readonly string[]): TextEdit[] {
        const clause = names.length === 0 ? '' : ` derivedFrom ${names.join(', ')}`;
        const keyword = GrammarUtils.findNodeForKeyword(relation.$cstNode, 'derivedFrom');
        const references = GrammarUtils.findNodesForProperty(relation.$cstNode, 'derivedFrom');
        const last = references[references.length - 1];
        if (!keyword || !last) {
            const end = relation.$cstNode!.range.end;
            return clause ? [{ range: { start: end, end }, newText: clause }] : [];
        }
        const text = document.textDocument.getText();
        const from = text[keyword.offset - 1] === ' ' ? keyword.offset - 1 : keyword.offset;
        return [{
            range: { start: document.textDocument.positionAt(from), end: last.range.end },
            newText: clause
        }];
    }

    /**
     * How `target` is written in a reference from `container`: the shortest
     * name the scope there has for it -- its simple name in its own package,
     * qualified from another -- or nothing if it is out of reach.
     */
    private nameInScope(container: AstNode, property: string, target: AstNode): string | undefined {
        const uri = AstUtils.getDocument(target).uri.toString();
        const path = this.locator.getAstNodePath(target);
        const reference = { $refText: '' } as Reference;
        return this.scopeProvider.getScope({ reference, container, property })
            .getAllElements()
            .filter(description => description.documentUri.toString() === uri && description.path === path)
            .map(description => description.name)
            .toArray()
            .sort((a, b) => a.length - b.length)[0];
    }

    private extractRelatorFor(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const relation = this.nodeAt(document, diagnostic, isRelation);
        if (!relation) {
            return undefined;
        }
        const action = this.extractRelator(document, {
            textDocument: { uri: document.textDocument.uri },
            range: diagnostic.range,
            context: { diagnostics: [diagnostic] }
        });
        return action && { ...action, kind: CodeActionKind.QuickFix, diagnostics: [diagnostic], isPreferred: true };
    }

    /** The two bearer choices, offered from the same hint as the relator repair. */
    private extractExtrinsicModesFor(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        return this.extractExtrinsicModes(document, {
            textDocument: { uri: document.textDocument.uri },
            range: diagnostic.range,
            context: { diagnostics: [diagnostic] }
        }).map(action => ({
            ...action,
            kind: CodeActionKind.QuickFix,
            diagnostics: [diagnostic],
            isPreferred: false
        }));
    }

    /**
     * A required chain has to stop somewhere, and either end may be where.
     *
     * `kind Node { @componenthood <>-- [0..1] Node }` says every node is a
     * component of exactly one node -- a diamond with nothing beside it is
     * exactly one -- so the wholes never top out; `<>-- Node` says every node
     * contains one as well, so the parts never bottom out either. Dropping a
     * lower bound to zero lets a root belong to nothing or a leaf hold
     * nothing, and leaves everything else the line says alone: `[1]` becomes
     * `[0..1]`, `[1..*]` becomes `[0..*]`, and an omitted bound is written
     * out as `[0..1]`.
     *
     * One end per diagnostic, since the two directions are reported
     * separately: `parthood-climbs-forever` is answered at the whole's bound
     * and `parthood-descends-forever` at the part's. A model that makes both
     * claims gets both reports, each with the bound that answers it.
     */
    private letTheChainStop(
        document: LangiumDocument, diagnostic: Diagnostic, drop: 'part' | 'whole'
    ): CodeAction[] {
        const classDeclaration = this.nodeAt(document, diagnostic, isClassDeclaration);
        if (!classDeclaration) {
            return [];
        }
        const actions: CodeAction[] = [];
        const family = [classDeclaration, ...collectAncestors(classDeclaration)];
        const seen = new Set<Relation>();
        for (const relation of family.flatMap(member => this.reverse.touching(member))) {
            if (!isParthood(relation) || seen.has(relation)) {
                continue;
            }
            seen.add(relation);
            const wholeIsSource = wholeEndOf(relation) === 'source';
            const source = getRelationSource(relation);
            const target = relation.target?.ref;
            const ends = drop === 'whole'
                // The climb: this class is the part, and the bound to drop is
                // the one beside the whole, which lets a root belong to
                // nothing.
                ? [{
                    mine: wholeIsSource ? target : source,
                    atSource: wholeIsSource,
                    cardinality: wholeIsSource ? relation.sourceCardinality : relation.targetCardinality,
                    says: 'have no whole'
                }]
                // The descent: this class is the whole, and the bound to drop
                // is the part's, which lets a leaf hold nothing.
                : [{
                    mine: wholeIsSource ? source : target,
                    atSource: !wholeIsSource,
                    cardinality: wholeIsSource ? relation.targetCardinality : relation.sourceCardinality,
                    says: 'have no parts'
                }];
            for (const end of ends) {
                // Nothing written means exactly one, which is the shape this
                // is most often reported of: there is no multiplicity to
                // rewrite, and one to insert where the end would carry it.
                const bounds = end.cardinality ? getBounds(end.cardinality) : { lower: 1, upper: 1 };
                const range = end.cardinality?.$cstNode?.range
                    ?? this.multiplicityPosition(relation, end.atSource);
                // The relation may be written at an ancestor: what a vehicle
                // must contain, a car must contain, and the bound to drop is
                // the one on the vehicle's line. Named after the end it sits
                // beside rather than the class reported, since that is what
                // the edit changes.
                const applies = isClassDeclaration(end.mine)
                    && isSameOrSpecializes(classDeclaration, end.mine);
                if (!applies || !isClassDeclaration(end.mine) || !bounds || !range || bounds.lower < 1) {
                    continue;
                }
                const text = `[0..${bounds.upper === Infinity ? '*' : bounds.upper}]`;
                actions.push(this.editAt(
                    relation, diagnostic,
                    `Let "${end.mine.name}" ${end.says}: "${text}"`,
                    [{ range, newText: end.cardinality ? text : `${text} ` }]
                ));
            }
        }
        return actions;
    }

    /**
     * A diamond on a stereotype that is not parthood: turn it back into `--`.
     *
     * The converse already marks the whole. This is the same edit the other
     * way, and it is forced -- the two cannot both stay.
     */
    private dropTheDiamond(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const relation = this.nodeAt(document, diagnostic, isRelation);
        for (const marker of ['<>--', '--<>'] as const) {
            const node = relation && GrammarUtils.findNodeForKeyword(relation.$cstNode, marker);
            if (node) {
                return this.edit(document, diagnostic, 'Drop the diamond', [
                    { range: node.range, newText: '--' }
                ]);
            }
        }
        return undefined;
    }

    /**
     * Deletes the documentation line a tag diagnostic points at.
     *
     * A `///` run is assembled from adjacent lines, so removing one is a
     * whole-line edit. A language repeated inside a leftover `label { }`
     * block is an item of that block instead.
     */
    private removeDocumentationLine(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const item = this.nodeAt(document, diagnostic, isLanguageText);
        if (item?.$cstNode) {
            return this.edit(document, diagnostic, 'Remove the duplicate language', [
                { range: this.lineRange(item.$cstNode.range), newText: '' }
            ]);
        }
        return this.edit(document, diagnostic, 'Remove this documentation line', [
            { range: this.lineRange(diagnostic.range), newText: '' }
        ]);
    }

    /**
     * Moves the aggregation diamond to the other end, which is what a parthood
     * written the wrong way round needs. Offered only where the reverse
     * direction is actually admissible.
     */
    private flipDiamond(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        if (!(diagnostic.data as { reversed?: boolean } | undefined)?.reversed) {
            return undefined;
        }
        const relation = this.nodeAt(document, diagnostic, isRelation);
        const flipped: Record<string, string> = { '<>--': '--<>', '--<>': '<>--' };
        for (const [marker, replacement] of Object.entries(flipped)) {
            const node = relation && GrammarUtils.findNodeForKeyword(relation.$cstNode, marker);
            if (node) {
                return this.edit(document, diagnostic, 'Put the diamond at the other end', [
                    { range: node.range, newText: replacement }
                ]);
            }
        }
        return undefined;
    }

    /**
     * Offers every stereotype the end natures admit, the recommended one
     * first. Each goes at the very start, before `relation` or the diamond,
     * which is the only place the grammar accepts it.
     */
    private writeImpliedStereotype(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        const stereotypes = (diagnostic.data as { stereotypes?: string[] } | undefined)?.stereotypes ?? [];
        const relation = this.nodeAt(document, diagnostic, isRelation);
        if (!relation?.$cstNode) {
            return [];
        }
        const start = relation.$cstNode.range.start;
        return stereotypes.map(stereotype => this.edit(
            document, diagnostic, `Add "@${stereotype}"`,
            [{ range: { start, end: start }, newText: `@${stereotype} ` }]
        ));
    }

    /**
     * A powertype categorizes nothing, so the categorizer clause goes. The
     * generalization set itself is unaffected -- it still states the
     * generalizations; it just no longer claims a criterion supplies them.
     */
    private removeGensetCategorizer(document: LangiumDocument, diagnostic: Diagnostic): CodeAction | undefined {
        const genset = this.nodeAt(document, diagnostic, isGeneralizationSet);
        const keyword = genset && GrammarUtils.findNodeForKeyword(genset.$cstNode, 'categorizer');
        const nodes = genset && GrammarUtils.findNodesForProperty(genset.$cstNode, 'categorizers');
        const last = nodes && nodes[nodes.length - 1];
        if (!keyword || !last) {
            return undefined;
        }
        return this.edit(document, diagnostic, 'Remove the categorizer', [
            { range: this.lineRange({ start: keyword.range.start, end: last.range.end }), newText: '' }
        ]);
    }

    /** The `specializes A, B, C` clause in full, keyword included. */
    private wholeSpecializesClause(node: ClassDeclaration): TextEdit | undefined {
        const keyword = GrammarUtils.findNodeForKeyword(node.$cstNode, 'specializes');
        const last = node.specializes[node.specializes.length - 1]?.$refNode;
        if (!keyword || !last) {
            return undefined;
        }
        return { range: { start: keyword.range.start, end: last.range.end }, newText: '' };
    }

    /**
     * Repairs any contradiction between a class's stereotype, its `of` clause
     * and its supertypes.
     *
     * All four such diagnostics land here, because they are the same question
     * asked of different constraints, and `culprits` answers it once: which
     * restrictions, dropped, leave a class that can have instances. Each
     * culprit maps to the edit that removes it -- a `specializes` entry, the
     * `of` clause, or the stereotype, which is "removed" by replacing it with
     * one the remaining constraints allow.
     *
     * When no single constraint is to blame -- two object-natured supertypes
     * under an `event`, where dropping either leaves the other contradicting
     * the stereotype just as flatly -- the whole `specializes` clause is
     * offered instead.
     */
    private repairNatureConflict(document: LangiumDocument, diagnostic: Diagnostic): CodeAction[] {
        const node = this.nodeAt(document, diagnostic, isClassDeclaration);
        if (!node) {
            return [];
        }
        const actions: CodeAction[] = [];
        // Ordered by how much of the modeler's intent each repair discards:
        // a supertype is a claim about the hierarchy, a stereotype can often
        // be swapped for one that means much the same, and an explicit `of`
        // clause is the most specific thing on the line, so it goes last.
        const order: Record<ConstraintKind, number> = { supertype: 0, stereotype: 1, declared: 2 };
        const blamed = [...culprits(node)].sort((a, b) => order[a.kind] - order[b.kind]);

        // No single supertype to blame does not mean the supertypes are
        // innocent: two object-natured ones under an `event` are jointly at
        // fault, and only dropping both settles it.
        if (!blamed.some(culprit => culprit.kind === 'supertype') && removingAllSupertypesHelps(node)) {
            const whole = this.wholeSpecializesClause(node);
            if (whole) {
                actions.push(this.edit(document, diagnostic, 'Remove all the specializations', [whole]));
            }
        }

        for (const culprit of blamed) {
            if (culprit.kind === 'supertype' && culprit.parent) {
                const index = node.specializes.findIndex(ref => ref.ref === culprit.parent);
                const edit = index >= 0 && identityWouldSurvive(node, culprit.parent)
                    && this.specializationRemoval(node, index);
                if (edit) {
                    actions.push(this.edit(document, diagnostic,
                        `Remove specialization of "${culprit.parent.name}" (${[...culprit.natures].join(', ')})`,
                        [edit], actions.length === 0));
                }
            }
            if (culprit.kind === 'declared') {
                const removal = this.natureClauseRemoval(node);
                if (removal) {
                    actions.push(this.edit(document, diagnostic, 'Remove the nature restriction',
                        [removal], actions.length === 0));
                }
            }
            if (culprit.kind === 'stereotype') {
                actions.push(...this.restereotype(document, diagnostic, node));
            }
        }
        return actions;
    }

    /** Every stereotype the class's remaining constraints would accept. */
    private restereotype(document: LangiumDocument, diagnostic: Diagnostic, node: ClassDeclaration): CodeAction[] {
        const keyword = GrammarUtils.findNodeForProperty(node.$cstNode, 'stereotype');
        if (!keyword) {
            return [];
        }
        const viable = SUGGESTED_CLASS_STEREOTYPES
            .filter(stereotype => stereotype !== node.stereotype && admitsStereotype(node, stereotype)
                && identityWouldHold(node, stereotype));
        // Ranked against what the class would still be bound by, which is
        // exactly the natures a replacement stereotype has to accommodate.
        return rankByNatureFit(viable, naturesWithout(node, 'stereotype'))
            .slice(0, MAX_STEREOTYPE_SUGGESTIONS)
            .map(stereotype => this.edit(document, diagnostic, `Change to ${stereotype}`,
                [{ range: keyword.range, newText: stereotype }], false));
    }

    /**
     * A repair whose ranges are in the document holding `anchor`.
     *
     * Not always the document reported on. A generalization set names classes
     * in other files, and the repair for what it says -- restereotype this
     * specific, drop the `disjoint` -- is an edit to text somewhere else.
     * Keying it to the reported document instead wrote one file's coordinates
     * into another file, which in one file was invisible and across two
     * deleted a word from whatever happened to sit at those offsets.
     */
    private editAt(
        anchor: AstNode,
        diagnostic: Diagnostic,
        title: string,
        edits: TextEdit[],
        isPreferred = true
    ): CodeAction {
        return this.edit(AstUtils.getDocument(anchor), diagnostic, title, edits, isPreferred);
    }

    private edit(
        document: LangiumDocument,
        diagnostic: Diagnostic,
        title: string,
        edits: TextEdit[],
        isPreferred = true
    ): CodeAction {
        return {
            title,
            kind: CodeActionKind.QuickFix,
            diagnostics: [diagnostic],
            isPreferred,
            edit: {
                changes: {
                    [document.textDocument.uri]: edits
                }
            }
        };
    }
}

interface InverseCreation {
    insertion: TextEdit;
    uri: string;
    /** The reference the original declaration uses for the created inverse. */
    referenceFromOriginal: string;
}

interface Candidate {
    node: ClassDeclaration;
    /** The exact text to write so the reference resolves from the fix site. */
    insertName: string;
    qualified: boolean;
}

/** Nearest first: same package before imported/global, then alphabetical. */
function byQualificationThenName(a: Candidate, b: Candidate): number {
    if (a.qualified !== b.qualified) {
        return a.qualified ? 1 : -1;
    }
    return a.insertName.localeCompare(b.insertName);
}

function asArray(action: CodeAction | undefined): CodeAction[] {
    return action ? [action] : [];
}

/** The structured payload Langium attaches to an unresolved-reference diagnostic. */
function linkingErrorData(diagnostic: Diagnostic): LinkingErrorData | undefined {
    const data = diagnostic.data as LinkingErrorData | undefined;
    return data && data.code === DocumentValidator.LinkingError ? data : undefined;
}
