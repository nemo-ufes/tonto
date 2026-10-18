import type { AstNode, LangiumDocument } from 'langium';
import { AstUtils, CstUtils } from 'langium';
import type { Position, Range, TextEdit } from 'vscode-languageserver';
import type { ClassDeclaration, GeneralizationSet, Package, Relation } from '../generated/ast.js';
import {
    isAttribute, isClassDeclaration, isGeneralizationSet, isPackage, isRelation
} from '../generated/ast.js';
import { ENDURANT_NATURES, NATURE_ATOMS, ofClauseNatures } from '../validation/natures.js';
import { naturesAdmissibleAt } from '../validation/relation-end-natures.js';
import { TONTO_NATURE_NAMES } from '../validation/relation-nature-table.js';
import { possibleNaturesOf } from '../utils/nature-reasoning.js';
import {
    allowedSupertypeStereotypes, allowedNaturesFor, canSpecializeByStereotype,
    SUGGESTED_CLASS_STEREOTYPES, expandNatures, isBaseSortal, isNonSortal,
    stereotypesAdmittingNatures
} from '../validation/stereotype-model.js';
import { docLinesAbove } from '../documentation/doc-comment.js';

/** How many "create ..." actions to offer before the list stops being useful. */
const MAX_SUGGESTIONS = 5;

/**
 * The four kinds of individual a suggestion can be about, coarser than the
 * natures: what endures, what happens, what obtains, and what is outside time.
 */
type Family = 'endurant' | 'perdurant' | 'situation' | 'abstract';

/**
 * The family a stereotype commits to, where it commits to one.
 *
 * `kind` says endurant and `event` says perdurant; `category` and `class` say
 * nothing, since they admit every nature there is.
 */
function familyOf(keyword: string): Family | undefined {
    const allowed = allowedNaturesFor(keyword);
    if (!allowed || allowed.length === 0) {
        return undefined;
    }
    const families = new Set([...expandNatures(allowed)].map(nature => {
        const description = NATURE_ATOMS[nature];
        return description === undefined ? undefined
            : description.endures ? 'endurant'
            : description.sort === 'perdurant' ? 'perdurant'
            : description.sort === 'situation' ? 'situation'
            : 'abstract';
    }));
    return families.size === 1 ? [...families][0] : undefined;
}

/**
 * The first few, chosen to span what the end admits rather than to be the
 * most familiar.
 *
 * An end open to every concrete individual -- which is what
 * `@historicalDependence` admits at both -- was answered with `kind`,
 * `collective`, `quantity`, `relator`, `quality`: five ways of saying "an
 * endurant", and no way at all of saying the thing that happened, although a
 * historical dependence is on the past. Letting the first stereotype of each
 * family through first keeps the familiar answer at the top and still shows
 * that an event or a situation would do. Where an end admits only one family
 * -- a mediation, whose far end is an endurant -- nothing moves.
 */
function spanningFamilies(keywords: string[]): string[] {
    const covered = new Set<Family>();
    const first: string[] = [];
    const rest: string[] = [];
    for (const keyword of keywords) {
        const family = familyOf(keyword);
        if (family !== undefined && !covered.has(family)) {
            covered.add(family);
            first.push(keyword);
        } else {
            rest.push(keyword);
        }
    }
    return [...first, ...rest];
}

export interface MissingDeclaration {
    /** Keyword to declare it with -- a class stereotype, `datatype` or `enum`. */
    keyword: string;
    /** The `of` clause it is written with, where it says what it classifies. */
    natures?: string[];
    /** Where to insert the new declaration. */
    edit: TextEdit;
}

/**
 * What could plausibly be declared to satisfy an unresolved reference.
 *
 * The position of the reference says a great deal about what belongs there: a
 * supertype must be one the subject's stereotype may specialize, an
 * `instanceOf` target must be a high-order type, an attribute's type must be
 * a datatype, and an end of a stereotyped relation must have a nature that
 * stereotype admits. Each of those narrows a list of twenty-odd stereotypes
 * to a handful worth offering.
 */
export function declarationsFor(
    document: LangiumDocument,
    range: Range,
    refText: string,
    property: string
): MissingDeclaration[] {
    const node = nodeAt(document, range.start);
    const pkg = node && AstUtils.getContainerOfType(node, isPackage);
    if (!node || !pkg) {
        return [];
    }
    const keywords = standingAlone(keywordsFor(node, property), node, property);
    const below = insertionAfter(node, pkg);
    const above = insertionBefore(node, pkg);
    const atEnd = isRelation(node) && (property === 'source' || property === 'target')
        ? naturesAdmissibleAt(node, property)
        : undefined;
    // A bare `class` at a relation end answers with `unspecific-stereotype`,
    // where the end has already said what is wanted there.
    const offered = atEnd && keywords.some(keyword => keyword !== 'class')
        ? keywords.filter(keyword => keyword !== 'class')
        : keywords;
    return spanningFamilies(offered).flatMap(keyword => {
        // A non-sortal at a relation end says what it classifies, or it may
        // classify anything and `non-sortal-natures-unstated` says so at once:
        // the natures the end admits, as far as the stereotype holds them.
        const natures = atEnd && isNonSortal(keyword) ? naturesAtEnd(keyword, atEnd) : undefined;
        if (natures === null) {
            return [];
        }
        const declaration = natures ? `${keyword} ${refText} of ${natures.join(', ')}` : `${keyword} ${refText}`;
        return [{
            keyword,
            natures,
            // A non-sortal is written above what it generalizes: it exists to
            // be specialized -- it supplies no identity, so something below
            // it must -- and a taxonomy reads downwards. Anything else lands
            // below the declaration that wanted it. No blank line either way,
            // and no trailing newline below: the anchor's own line break
            // separates them.
            edit: isNonSortal(keyword)
                ? { range: above.range, newText: `${declaration}\n${above.indent}` }
                : { range: below, newText: `\n${declaration}` }
        }];
    }).slice(0, MAX_SUGGESTIONS);
}

/**
 * The `of` clause a non-sortal created at a relation end is written with: the
 * natures the end admits that the stereotype holds. `null` where it should not
 * be offered at all -- the two share nothing, or a mixin, role mixin or phase
 * mixin would classify nothing that endures. Those exist for things that are
 * essentially one thing and contingently another, or that play roles and pass
 * through phases, which is what a meeting does not do.
 */
function naturesAtEnd(keyword: string, admissible: ReadonlySet<string>): string[] | null {
    const held = expandNatures(allowedNaturesFor(keyword) ?? []);
    const natures = [...toTontoNatures(new Set(admissible))].filter(nature => held.has(nature));
    if (natures.length === 0) {
        return null;
    }
    if (keyword !== 'category' && !natures.some(nature => ENDURANT_NATURES.includes(nature))) {
        return null;
    }
    return ofClauseNatures(natures);
}

/**
 * Drops what could not stand as a declaration on its own.
 *
 * A base sortal must specialize an ultimate sortal, and
 * `sortal-without-ultimate-sortal` says so the moment one appears with no
 * supertype -- so offering `subkind Wheel` as the fix for an unresolved
 * `Wheel` trades one error for another. The exception is a site that states
 * the generalization itself: a generalization set's specifics arrive already
 * specializing its general, so a `subkind` is complete there.
 */
function standingAlone(keywords: string[], node: AstNode, property: string): string[] {
    if (isGeneralizationSet(node) && property === 'specifics') {
        return keywords;
    }
    const kept = keywords.filter(keyword => !isBaseSortal(keyword));
    return kept.length > 0 ? kept : keywords;
}

function keywordsFor(node: AstNode, property: string): string[] {
    // What names a relation, or what a historical role is derived from: no
    // class written under that name would resolve the reference, or would
    // answer it with an error.
    if (isRelation(node) && (property === 'inverseOf' || property === 'specializes')) {
        return [];
    }
    if (isClassDeclaration(node) && property === 'derivedFrom') {
        return [];
    }
    if (isRelation(node) && property === 'derivedFrom') {
        // What a derived relation is read off.
        return node.stereotype === 'material' ? ['relator', 'extrinsicMode']
            : node.stereotype === 'comparative' ? ['quality', 'intrinsicMode']
                : [];
    }
    if (isAttribute(node) && property === 'type') {
        // An attribute is typed by a datatype or an enumeration, never a class.
        return ['datatype', 'enum'];
    }
    if (isClassDeclaration(node)) {
        if (property === 'specializes') {
            const allowed = allowedSupertypeStereotypes(node.stereotype)?.slice() ?? [...SUGGESTED_CLASS_STEREOTYPES];
            return admittingNaturesOf(allowed, node);
        }
        if (property === 'instanceOf') {
            return ['type'];
        }
    }
    if (isGeneralizationSet(node)) {
        return generalizationSetStereotypes(node, property);
    }
    if (isRelation(node) && (property === 'source' || property === 'target')) {
        return stereotypesForRelationEnd(node, property);
    }
    return [...SUGGESTED_CLASS_STEREOTYPES];
}

/**
 * Keeps only the stereotypes whose instances could share a nature with
 * `relative` -- the class on the other side of the generalization.
 *
 * The taxonomy tables say a `subkind` may specialize a `mode`, and in general
 * it may; but `subkind Hospital of functional-complexes` cannot, because
 * nothing is both a functional complex and a mode. Filtering by stereotype
 * alone offered exactly that.
 *
 * A stereotype with no nature restriction of its own -- `class` -- is always
 * kept, and so is the whole list if the filter would empty it, since an empty
 * list of suggestions helps nobody.
 */
function admittingNaturesOf(candidates: string[], relative: ClassDeclaration): string[] {
    const natures = possibleNaturesOf(relative);
    if (!natures || natures.size === 0) {
        return candidates;
    }
    const kept = candidates.filter(candidate => {
        const allowed = allowedNaturesFor(candidate);
        return !allowed || allowed.length === 0 || [...expandNatures(allowed)].some(nature => natures.has(nature));
    });
    return kept.length > 0 ? kept : candidates;
}

/**
 * Stereotypes a missing member of a generalization set could have.
 *
 * The two sides constrain each other, and the *other* side is usually already
 * written: in
 * `genset G where GoodMeeting, BadMeeting specializes Meeting` the general is
 * an `event`, and only an `event` may specialize an event -- so that is the
 * only sensible thing to offer. Falling back to the full stereotype list here
 * ignored a constraint sitting in plain view on the same line.
 */
function generalizationSetStereotypes(genset: GeneralizationSet, property: string): string[] {
    if (property === 'categorizers') {
        return ['type'];
    }
    if (property === 'specifics') {
        const general = genset.general?.ref;
        if (general && isClassDeclaration(general)) {
            return admittingNaturesOf(
                SUGGESTED_CLASS_STEREOTYPES.filter(stereotype => canSpecializeByStereotype(stereotype, general.stereotype)),
                general);
        }
    }
    if (property === 'general') {
        // Whatever the general is, every specific must be able to specialize it.
        const specifics = genset.specifics
            .map(ref => ref.ref)
            .filter((node): node is ClassDeclaration => !!node && isClassDeclaration(node));
        if (specifics.length > 0) {
            const byTaxonomy = SUGGESTED_CLASS_STEREOTYPES.filter(stereotype =>
                specifics.every(specific => canSpecializeByStereotype(specific.stereotype, stereotype)));
            return specifics.reduce<string[]>(
                (candidates, specific) => admittingNaturesOf(candidates, specific), [...byTaxonomy]);
        }
    }
    return [...SUGGESTED_CLASS_STEREOTYPES];
}

/** Stereotypes whose instances could sit at one end of a relation. */
function stereotypesForRelationEnd(relation: Relation, property: 'source' | 'target'): string[] {
    const natures = naturesAdmissibleAt(relation, property);
    const candidates = natures && stereotypesAdmittingNatures(toTontoNatures(natures));
    return candidates && candidates.length > 0 ? candidates : [...SUGGESTED_CLASS_STEREOTYPES];
}

function toTontoNatures(natures: Set<string>): Set<string> {
    const result = new Set<string>();
    for (const nature of natures) {
        const name = TONTO_NATURE_NAMES[nature];
        if (name) {
            result.add(name);
        }
    }
    return result;
}

/**
 * Just past the declaration the reference sits in, so the new element lands
 * beside the one that wanted it rather than at the far end of the package.
 */
export function insertionAfter(node: AstNode, pkg: Package): Range {
    const end = anchorFor(node, pkg).$cstNode?.range.end ?? { line: 0, character: 0 };
    return { start: end, end };
}

/**
 * Just before the same anchor, for a declaration that belongs above it.
 *
 * Above the anchor's documentation, not between it and the anchor: a run of
 * `///` lines belongs to the declaration it precedes, and inserting into the
 * gap would silently hand that documentation to the new declaration. The
 * anchor's own indentation is returned with the position, to be written after
 * the new line so the anchor keeps it.
 */
export function insertionBefore(node: AstNode, pkg: Package): { range: Range; indent: string } {
    const anchor = anchorFor(node, pkg);
    const start = anchor.$cstNode?.range.start ?? { line: 0, character: 0 };
    const documentation = docLinesAbove(anchor);
    const position = {
        line: documentation.length > 0 ? documentation[0].line : start.line,
        character: start.character
    };
    return { range: { start: position, end: position }, indent: ' '.repeat(start.character) };
}

/**
 * The package-level declaration a reference sits in: a relation written inside
 * a class body anchors to the whole class, not to the middle of it. Falls back
 * to the last declaration when the reference is not inside one at all.
 */
function anchorFor(node: AstNode, pkg: Package): AstNode {
    return pkg.declarations.find(declaration =>
        declaration === node || AstUtils.hasContainerOfType(node, candidate => candidate === declaration))
        ?? pkg.declarations[pkg.declarations.length - 1]
        ?? pkg;
}

function nodeAt(document: LangiumDocument, position: Position): AstNode | undefined {
    const root = document.parseResult.value.$cstNode;
    if (!root) {
        return undefined;
    }
    const leaf = CstUtils.findLeafNodeAtOffset(root, document.textDocument.offsetAt(position));
    return leaf?.astNode;
}
