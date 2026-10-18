import type {
    AstNode, AstNodeDescription, AstNodeLocator, IndexManager, LangiumDocument, LangiumDocuments, MaybePromise,
    ReferenceInfo, Stream
} from 'langium';
import { AstUtils, CstUtils, EMPTY_STREAM, GrammarAST, GrammarUtils } from 'langium';
import type { NextFeature } from 'langium/lsp';
import { DefaultCompletionProvider } from 'langium/lsp';
import type { CompletionAcceptor, CompletionContext, LangiumServices } from 'langium/lsp';
import { CompletionItemKind, CompletionList, InsertTextFormat } from 'vscode-languageserver';
import type { CancellationToken, CompletionParams, TextEdit } from 'vscode-languageserver';
import type {
    ClassDeclaration, ClassStereotype, Datatype, Enumeration, GeneralizationSet, Relation,
    RelationEndMetaAttributes
} from '../generated/ast.js';
import {
    isClassDeclaration, isGeneralizationSet, isRelation, isRelationEndMetaAttributes
} from '../generated/ast.js';
import type { TontoScopeProvider } from '../references/tonto-scope-provider.js';
import { admits } from '../validation/derivation-checks.js';
import { cannotShareInstances, wouldConflictWithLineage } from '../utils/disjointness.js';
import { foundingCandidatesInto, foundingOf, foundsHistorically } from '../utils/founding.js';
import { createReverseLookup } from '../validation/incoming-relations.js';
import type { ReverseLookup } from '../validation/incoming-relations.js';
import { ownerOf, validationOntology } from '../publication/workspace.js';
import { collectAncestors, isSameOrSpecializes } from '../utils/generalizations.js';
import { admitsSupertype } from '../utils/nature-reasoning.js';
import { admissibleAtRelationEnd, mayStandFirst, naturesFitStereotype } from '../validation/relation-end-natures.js';
import { isEndTypeCompatible } from '../validation/relation-checks.js';
import { getEndOwner, getEndType, getRelationSource, getRelationSourceName, isParthood } from '../utils/relations.js';
import {
    allowedNaturesFor, allowedSupertypeStereotypes, canSpecializeByStereotype,
    CLASS_STEREOTYPES_BY_FAMILIARITY, DEPRECATED_STEREOTYPES, isUltimateSortal, NATURE_KEYWORDS,
    STEREOTYPES
} from '../validation/stereotype-model.js';
import { isDatatype, isEnumeration } from '../generated/ast.js';
import { classifiesOnly, classifiesTypes, possibleNaturesOf } from '../utils/nature-reasoning.js';
import { IMMUTABLE_NATURES } from '../validation/relation-nature-checks.js';
import { docLinesAbove, parseDocLines } from '../documentation/doc-comment.js';
import { RELATION_STEREOTYPES } from '../validation/relation-stereotypes.js';
import { PART_WHOLE_STEREOTYPES, signatureOf } from '../validation/relation-nature-table.js';
import { a } from '../validation/wording.js';
import { TIME_POINT_STEREOTYPES } from '../validation/attribute-checks.js';
import { importCandidates, importEdit } from '../publication/import-assist.js';
import { isImport, isModel, isPackage } from '../generated/ast.js';

const NATURE_WORDS = new Set<string>(NATURE_KEYWORDS);

/** The words that are keywords only after `@`. */
/** The older spelling of documentation: still parsed, never proposed. */
const LEGACY_KEYWORDS = new Set(['label', 'description']);

const SOFT_KEYWORDS = new Set<string>([...RELATION_STEREOTYPES, ...TIME_POINT_STEREOTYPES]);

/**
 * The rules that readmit a keyword where a *name* is written.
 *
 * `HardKeyword` and `EndSafeKeyword` exist so that `(of)` and `relation of`
 * parse -- see `terminals.langium`. They put every word of the language into
 * the parser's follow set at every name position, and Langium proposes what
 * the parser will accept: inside an empty `()` that came out as sixty
 * proposals, `kind` and `package` among them, where four words and a name are
 * the whole of what belongs there. The same reasoning as the `SoftKeyword`
 * suppression below, applied where the grammar says it rather than by
 * listing the words again: a name is the user's to write.
 */
const NAME_SPELLING_RULES = new Set(['HardKeyword', 'EndSafeKeyword', 'SoftKeyword']);

/** Whether this keyword is offered only because a name may be spelled with it. */
function spellsAName(keyword: GrammarAST.Keyword): boolean {
    const rule = AstUtils.getContainerOfType(keyword, GrammarAST.isParserRule);
    return !!rule && NAME_SPELLING_RULES.has(rule.name);
}

/**
 * The words that begin a declaration, and the three that may stand in front
 * of one.
 *
 * Derived from the tables rather than listed: every class stereotype opens a
 * declaration, and so do the six other things a package may contain.
 */
const BEGINS_A_DECLARATION: ReadonlySet<string> = new Set<string>([
    ...CLASS_STEREOTYPES_BY_FAMILIARITY,
    'datatype', 'enum', 'genset', 'import', 'use', 'package', 'relation', 'ontology',
    'disjoint', 'complete'
]);

/**
 * Whether a declaration may begin here.
 *
 * One per line, which is what the formatter writes and what every model in
 * the corpus looks like. After `kind Person` the parser will accept a second
 * declaration on the same line, so all forty of them were proposed beside
 * `of`, `isPowerType` and `specializes` -- the three words that actually
 * continue what is being written.
 *
 * The word being typed does not count as something in the way, or `kin`
 * could not complete to `kind`; nor do `global`, `disjoint` and `complete`,
 * which stand in front of a declaration rather than after one.
 */
function startsADeclaration(prefix: string): boolean {
    return /^\s*((global|disjoint|complete)\s+)*\w*$/.test(prefix);
}

/**
 * Whether this line is already writing a member of a body.
 *
 * A tag still being typed is not: `@med` is heading for the snippet that
 * writes the whole relation, and that is the one moment it has to be
 * offered.
 */
function memberUnderWay(prefix: string): boolean {
    const beginning = /^\s*@?\w*$/.test(prefix);
    return (writesARelation(prefix) && !beginning) || prefix.includes(':');
}

/**
 * Whether the cursor is between the parentheses of an end decorator.
 *
 * Read from the text rather than from the tree: an unclosed `(` is a parse
 * error, so there is no decorator node to be inside of, and that is exactly
 * the position this has to recognize -- the words a decorator takes are the
 * ones that should survive there.
 */
function insideEndDecorator(context: CompletionContext): boolean {
    const before = context.textDocument.getText({
        start: { line: context.position.line, character: 0 },
        end: context.position
    });
    let depth = 0;
    for (const character of before) {
        if (character === '(') {
            depth++;
        } else if (character === ')') {
            depth--;
        }
    }
    return depth > 0;
}

/**
 * Whether the cursor is inside a comment, where nothing the grammar expects
 * belongs.
 *
 * Read from the text rather than from the tree: comments are hidden tokens,
 * so there is no node to be inside of -- which is exactly why the parser
 * state there is "between declarations", and why every declaration keyword
 * was proposed in the middle of a sentence.
 */
function insideComment(document: LangiumDocument, params: CompletionParams): boolean {
    const text = document.textDocument.getText();
    const offset = document.textDocument.offsetAt(params.position);
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    if (text.slice(lineStart, offset).includes('//')) {
        return true;
    }
    const opened = text.lastIndexOf('/*', offset);
    return opened >= 0 && text.lastIndexOf('*/', offset) < opened;
}

/**
 * The clauses that may close a relation, where the parser cannot say so.
 *
 * `<>-- Node ` leaves the parser between two readings: `Node` may be the
 * relation's *name*, with a second `--` and the class still to come, or the
 * class itself, with `specializes`, `inverseOf` and `derivedFrom` free to
 * follow. Langium follows the name reading, so the words reached completion
 * only through the rules that readmit a keyword where a name is written -- and
 * those are dropped, for the same reason an empty `()` should not offer
 * `kind`. Writing a multiplicity or a decorator in front of the class settles
 * the reading and the words came back, which is what made this look like it
 * only happened after some relations.
 *
 * So they are offered outright wherever a relation has a class at its end.
 * Each is legal there whichever way the ambiguity is resolved: an end that
 * turns out to be a name is followed by a class, and a class may be followed
 * by any of the clauses.
 */
function whatFollowsARelation(
    document: LangiumDocument, params: CompletionParams, list: CompletionList | undefined
): CompletionList | undefined {
    const prefix = document.textDocument.getText({
        start: { line: params.position.line, character: 0 },
        end: params.position
    });
    if (!writesARelation(prefix) || !endClassWritten(prefix)) {
        return list;
    }
    const items = list?.items ?? [];
    const already = new Set(items.map(item => item.label));
    const added = ['specializes', 'inverseOf', 'derivedFrom']
        .filter(word => !already.has(word))
        .map(word => ({ label: word, kind: CompletionItemKind.Keyword, detail: 'Keyword', sortText: '1' }));
    return added.length === 0
        ? list
        : CompletionList.create([...items, ...added], list?.isIncomplete ?? true);
}

/**
 * Whether the cursor is at the name of a package that has none yet.
 *
 * The name is optional in the grammar only so that a half-written `package `
 * still parses -- it used to bring the whole build down -- and
 * `package-without-name` reports what is left. The parser will accept a
 * declaration straight after the keyword, so every one of them was proposed
 * where a name is the only thing that belongs.
 */
function atPackageName(context: CompletionContext): boolean {
    return /^\s*(global\s+)?package\s+$/.test(linePrefix(context));
}

/**
 * Whether a word that only some documents can use is one this document can.
 *
 * `bundles` and `in` continue a header, so they are proposed on its line: a
 * line below is where a declaration begins, and there they stood first in the
 * list. `bundles` also needs a header with nothing after it, since an
 * ontology either declares its own content or lists its packages, never both.
 * `use` names another package of the same ontology, and a document whose
 * ontology header is followed by no package has none to name.
 */
function continuesTheHeader(context: CompletionContext, word: string): boolean {
    const model = context.document.parseResult.value;
    switch (word) {
        case 'bundles':
            return /^\s*ontology\s+\w+\s+\w*$/.test(linePrefix(context))
                && (!isModel(model) || model.packages.length === 0);
        case 'in':
            return /^\s*(global\s+)?package\s+[\w.]+\s+\w*$/.test(linePrefix(context));
        case 'use':
            return !isModel(model) || model.ontologies.length === 0 || model.packages.some(pkg => !!pkg.name);
        default:
            return true;
    }
}

/** The text of the line up to the cursor. */
function linePrefix(context: CompletionContext): string {
    return context.textDocument.getText({
        start: { line: context.position.line, character: 0 },
        end: context.position
    });
}

/**
 * What the line already holds after the word under the cursor. Completing a
 * stereotype in front of a written relation or attribute replaces the tag and
 * nothing else, so what follows is part of the member being completed.
 */
function lineRest(context: CompletionContext): string {
    const line = context.textDocument.getText({
        start: { line: context.position.line, character: 0 },
        end: { line: context.position.line + 1, character: 0 }
    }).replace(/\r?\n$/, '');
    return line.slice(context.position.character).replace(/^[\w-]*/, '');
}

/** The three ways a relation says which end holds the whole, or that neither does. */
const RELATION_MARKERS = /(<>--|--<>|--)/g;

/**
 * Whether this line is writing a relation.
 *
 * Four shapes begin one: a relation stereotype, a multiplicity, a decorator,
 * and the `relation` keyword of the external form -- and once a marker is
 * written, the line is a relation whatever it began with.
 */
function writesARelation(prefix: string): boolean {
    const written = prefix.trimStart();
    const stereotype = /^@(\w*)/.exec(written)?.[1];
    const answer = /^(@\w+\s+)?(relation\b|\[|\()/.test(written)
        || RELATION_MARKERS.test(written)
        || (stereotype !== undefined && !TIME_POINT_STEREOTYPES.includes(stereotype as never));
    RELATION_MARKERS.lastIndex = 0;
    return answer;
}

/**
 * Whether this line is writing an instant -- `@begin born: const date` --
 * and has not got to the name yet.
 *
 * An instant is an attribute, so what belongs after the tag is a name and a
 * type. The class-body list was offered instead, relation snippets and all,
 * which cannot follow `@begin` at all.
 */
function atUnwrittenInstant(prefix: string): boolean {
    return /^\s*@(begin|end)\s+$/.test(prefix);
}

/**
 * Whether the cursor is on a relation line whose end class has not been
 * written yet.
 *
 * Read from the text of the line, not from the parsed relation: the parse of
 * a *finished* document has a target at every end, and completion is asked in
 * the middle of one all the time. What Langium answers with comes from
 * re-parsing the text up to the cursor, and there the target is optional --
 * the grammar says so, so that a half-written relation still parses and the
 * classes narrow from the first keystroke -- so everything which may follow a
 * finished relation is offered as well: `specializes`, `inverseOf`, and every
 * class-body proposal, none of which can be written until the class at the
 * end is.
 *
 * A relation is one line, which the formatter guarantees, so the line is the
 * whole of what has to be read.
 */
function atUnwrittenEnd(context: CompletionContext): boolean {
    const prefix = linePrefix(context);
    return writesARelation(prefix) && !endClassWritten(prefix);
}

/**
 * Whether a class has been written at the end this line is up to.
 *
 * Everything after the last marker, minus the multiplicities and decorators
 * that may stand in front of the class. A bare word left over is the class --
 * or, before any marker, the source of an external relation, which is written
 * the same way.
 */
function endClassWritten(prefix: string): boolean {
    const markers = [...prefix.matchAll(RELATION_MARKERS)];
    const last = markers[markers.length - 1];
    const tail = (last ? prefix.slice(last.index + last[0].length) : prefix)
        .replace(/^\s*relation\b/, '')
        .replace(/@\w+/g, '')
        .replace(/\[[^\]]*\]?/g, '')
        .replace(/\([^)]*\)?/g, '');
    return /[A-Za-z_]/.test(tail);
}

/**
 * The end whose decorator the cursor is in, where the tree does not say so.
 *
 * Part way through `(staff subsets |)` the node Langium hands over is
 * whatever the parser last attached the offset to -- often the relation
 * rather than the end -- so the two ends are asked which one the offset is
 * inside of.
 */
function endBeingWritten(context: CompletionContext): RelationEndMetaAttributes | undefined {
    const relation = AstUtils.getContainerOfType(context.node, isRelation);
    return [relation?.sourceMeta, relation?.targetMeta].find(meta => {
        const node = meta?.$cstNode;
        return !!node && context.offset >= node.offset && context.offset <= node.end;
    });
}

/** Whether the cursor sits in the `@...` that introduces a stereotype. */
function afterAt(context: CompletionContext): boolean {
    return tagStart(context) !== undefined;
}

/** Where the `@` is, when the cursor is inside the word it introduces. */
function tagStart(context: CompletionContext): number | undefined {
    const before = context.textDocument.getText({
        start: { line: context.position.line, character: 0 },
        end: context.position
    });
    const match = /@[\w-]*$/.exec(before);
    return match ? match.index : undefined;
}

/**
 * The declaration whose braces the cursor sits between, innermost first.
 *
 * Walks up from the node under the cursor rather than trusting it: that node
 * is whatever the parser last attached the offset to -- a relation, an
 * attribute, the class itself -- and only its position relative to a pair of
 * braces says which body, if any, is being written in. A body still being
 * typed has no closing brace yet, and counts as open to the end of the file.
 */
function bodyAround(context: CompletionContext): AstNode | undefined {
    return bodyOf(context.node, context.offset);
}

/** The same, where there is a document and an offset rather than a context. */
function bodyAt(document: LangiumDocument, offset: number): AstNode | undefined {
    const root = document.parseResult.value.$cstNode;
    // On a blank line there is no leaf *at* the offset, and the node before
    // it is the one whose body the cursor is in.
    const leaf = root
        && (CstUtils.findLeafNodeAtOffset(root, offset) ?? CstUtils.findLeafNodeBeforeOffset(root, offset));
    return bodyOf(leaf?.astNode ?? document.parseResult.value, offset);
}

function bodyOf(from: AstNode | undefined, offset: number): AstNode | undefined {
    let node: AstNode | undefined = from;
    while (node) {
        const open = node.$cstNode && GrammarUtils.findNodeForKeyword(node.$cstNode, '{');
        const close = node.$cstNode && GrammarUtils.findNodeForKeyword(node.$cstNode, '}');
        if (open && offset > open.offset && (!close || offset <= close.offset)) {
            return node;
        }
        node = node.$container;
    }
    return undefined;
}

/** The class body the cursor is in, where it is in one. */
function classAround(context: CompletionContext): ClassDeclaration | undefined {
    const body = bodyAround(context);
    return body && isClassDeclaration(body) ? body : undefined;
}

/**
 * Whether a nature is one the declaration being written may actually take.
 *
 * Answered from the stereotype, which is already on the page by the time `of`
 * is: a `kind` classifies objects, an `event` events, and a datatype abstract
 * individuals and nothing else. Where the declaration cannot be identified the
 * nature is offered -- the point is to remove what is known to be wrong.
 */
function admissibleNature(context: CompletionContext, nature: string): boolean {
    const node = context.node && AstUtils.getContainerOfType(context.node, isNatureBearer);
    if (!node) {
        return true;
    }
    if (isDatatype(node) || isEnumeration(node)) {
        return nature === 'abstract-individuals';
    }
    const allowed = allowedNaturesFor(node.stereotype);
    return allowed === undefined || allowed.includes(nature);
}

function isNatureBearer(node: AstNode): node is ClassDeclaration | Datatype | Enumeration {
    return isClassDeclaration(node) || isDatatype(node) || isEnumeration(node);
}

function stereotypeDetail(stereotype: string): string {
    const facts = STEREOTYPES[stereotype as ClassStereotype];
    return [facts.sortality, facts.rigidity].filter(Boolean).join(', ');
}

/** What the tables say about a stereotype, as the proposal's documentation. */
function stereotypeDocumentation(stereotype: string): string {
    const facts = STEREOTYPES[stereotype as ClassStereotype];
    const natures = facts.natures ?? [];
    const supertypes = allowedSupertypeStereotypes(stereotype as ClassStereotype);
    const lines = [`**${stereotype}** — ${stereotypeDetail(stereotype)}`, ''];
    lines.push(natures.length > 0
        ? `*classifies* ${natures.join(', ')}`
        : '*classifies* anything -- say what with `of <natures>`');
    if (supertypes && supertypes.length > 0) {
        lines.push('', `*may specialize* ${supertypes.join(', ')}`);
    } else if (supertypes) {
        lines.push('', '*may specialize* nothing: it tops its own lineage');
    }
    return lines.join('\n');
}

interface Snippet {
    label: string;
    detail: string;
    body: string;
    /** The relation stereotype it writes, where the class must be able to open one. */
    stereotype?: string;
    /** An instant, which only something in time has. */
    instants?: boolean;
}

/**
 * Full-construct snippets, keyed by the keyword that must be valid at the
 * cursor for them to be offered. Attaching them to a keyword means they only
 * ever appear where that keyword itself is grammatically legal -- no
 * hand-rolled context detection that can drift from the grammar.
 */
const SNIPPETS: Record<string, Snippet[]> = {
    ontology: [
        {
            label: 'ontology (one-file)',
            detail: 'one-file ontology: the header, then its declarations',
            body: '/// @namespace ${1:https://example.org/model#}\nontology ${2:model}\n\nkind ${3:Thing}$0'
        },
        {
            label: 'ontology (with inline package)',
            detail: 'ontology file with a package written in it',
            body: '/// @namespace ${1:https://example.org/model#}\nontology ${2:model}\n\npackage ${3:core}\nkind ${4:Thing}$0'
        }
    ],
    package: [
        {
            label: 'package (inline)',
            detail: 'package written in the ontology file',
            body: 'package ${1:core}\n\nkind ${2:Thing}$0'
        },
        {
            label: 'package (package file)',
            detail: 'package in a file of its own, bundled by the ontology file',
            body: 'package ${1:core} in ${2:model}\n\nkind ${3:Thing}$0'
        }
    ],
    bundles: [{
        label: 'bundles (relative source)',
        detail: 'package file relative to this ontology file',
        body: 'bundles\n\t${1:core} from <${2:core.tonto}>$0'
    }],
    import: [{
        label: 'import (ontology)',
        detail: 'another ontology, by the location of its ontology file',
        body: 'import ${1:other} from <${2:other.tonto}>$0'
    }],
    use: [{
        label: 'use (package)',
        detail: 'another package owned by this ontology',
        body: 'use ${1:core}$0'
    }],
    kind: [
        {
            label: 'kind (with attributes)',
            detail: 'kind with a body',
            body: 'kind ${1:Name} {\n\t${2:attribute}: ${3:string}\n\t$0\n}'
        },
        {
            label: 'kind (documented)',
            detail: 'kind with "///" documentation and a display name',
            body: '/// ${1:What it is}\n/// @label ${2:Name}\nkind ${2:Name}$0'
        }
    ],
    role: [{
        label: 'role (with its relator)',
        detail: 'role, its base kind, and what founds it',
        body: 'role ${1:Name} specializes ${2:Kind}\nrelator ${3:Relationship} {\n\t@mediation [1..*] -- [1] (const) ${1:Name}\n\t$0\n}'
    }],
    phase: [{
        label: 'phase (partition)',
        detail: 'two phases and the set that divides them',
        body: 'phase ${1:PhaseA} specializes ${3:Kind}\nphase ${2:PhaseB} specializes ${3:Kind}\ndisjoint complete genset ${4:Name} where ${1:PhaseA}, ${2:PhaseB} specializes ${3:Kind}$0'
    }],
    event: [{
        label: 'event (with its instants)',
        detail: 'event with begin and end points',
        body: 'event ${1:Name} {\n\t@begin ${2:startedAt}: const ${3:date}\n\t@end ${4:finishedAt}: const ${3:date}\n\t$0\n}'
    }],
    relator: [{
        label: 'relator (with mediations)',
        detail: 'relator mediating two types',
        body: 'relator ${1:Name} {\n\t@mediation [1..*] -- [1] (const) ${2:TypeA}\n\t@mediation [1..*] -- [1] (const) ${3:TypeB}\n\t$0\n}'
    }],
    datatype: [{
        label: 'datatype (with attributes)',
        detail: 'structured datatype',
        body: 'datatype ${1:Name} {\n\t${2:field}: ${3:string}\n\t$0\n}'
    }],
    enum: [{
        label: 'enum (with literals)',
        detail: 'enumeration',
        body: 'enum ${1:Name} {\n\t${2:first}, ${3:second}\n}'
    }],
    genset: [
        {
            label: 'genset (short form)',
            detail: 'genset ... where ... specializes ...',
            body: 'disjoint complete genset ${1:Name} where ${2:SubA}, ${3:SubB} specializes ${4:Super}'
        },
        {
            label: 'genset (block form)',
            detail: 'genset with general/specifics',
            body: 'disjoint complete genset ${1:Name} {\n\tgeneral ${2:Super}\n\tspecifics ${3:SubA}, ${4:SubB}\n}'
        }
    ],
    relation: [{
        label: 'relation (external)',
        detail: 'package-level relation',
        body: 'relation ${1:Source} [${2:1}] -- ${3:name} -- [${4:0..*}] ${5:Target}'
    }],
};

/**
 * How each stereotype is written, for the ones the table cannot say by itself.
 *
 * Everything else is derived below, so a stereotype added to the vocabulary
 * arrives here with it: hand-listing them left `@creation` and `@termination`
 * out of a kind's list, where they belong, because nobody had written those
 * two down.
 *
 * The multiplicities default to the weaker claim, since the other end is a
 * placeholder: a relator mediating `[*]` says nothing that has to be taken
 * back, while `[1..*]` would say the mediated type is founded by it -- true of
 * a role, false of a kind. What the rules do fix is written in.
 */
const WRITTEN: Record<string, { ends: string; detail?: string }> = {
    // Existential dependence: exactly one of it, and not re-pointable.
    mediation: { ends: '[${1:*}] -- [${2:1}] (const) ${3:Type}', detail: 'relator to what it binds' },
    characterization: {
        ends: '[${1:*}] -- [${2:1}] (const) ${3:Bearer}',
        detail: 'mode or quality to its bearer, which is always exactly one'
    },
    externalDependence: {
        ends: '[${1:*}] -- [${2:1}] (const) ${3:Type}',
        detail: 'what an extrinsic mode needs beyond its bearer'
    },
    // What a past has gained it keeps.
    historicalDependence: {
        ends: '(addOnly) [${1:*}] -- [${2:1}] (const) ${3:Type}',
        detail: 'what had to exist for this to exist, though it need not still'
    },
    // Parthood: the diamond marks the whole, and a whole has more than one part.
    componenthood: { ends: '[${1:0..1}] <>-- [${2:1..*}] ${3:Part}' },
    membership: { ends: '[${1:*}] <>-- [${2:2..*}] (${3:members}) ${4:Type}' },
    subCollection: { ends: '[${1:*}] <>-- [${2:1}] ${3:SubCollection}' },
    // The whole end is `[1]` and not `[*]`: a portion of alcohol is part of one
    // portion of wine and no other, which is what `sub-quantity-shared` says of
    // a snippet that offers anything wider.
    subQuantity: {
        ends: '[${1:1}] <>-- [${2:1}] (const) ${3:SubQuantity}',
        detail: 'a portion within a portion: exclusive, and essential to it'
    },
    structural: {
        ends: '(const) [${1:1}] <>-- [${2:2..*}] (const) ${3:Part}',
        detail: 'an event part that belongs to the definition of the whole event'
    },
    temporal: {
        ends: '(const) [${1:1}] <>-- [${2:2..*}] (const) ${3:Segment}',
        detail: 'a maximal segment projected by an external temporal scheme, such as before/after noon'
    },
    participational: {
        ends: '(const) [${1:1}] <>-- [${2:2..*}] (const) ${3:Participation}',
        detail: 'a maximal portion depending exclusively on one participant; its participant end has maximum 1'
    },
    // It runs from what is constituted to what constitutes it, so written in
    // a body it says what *this* is made of: `[0..1]` because a portion of
    // clay constitutes at most one statue, `[1]` because a statue is of one.
    constitution: { ends: '[${1:0..1}] -- [${2:1}] ${3:Constituent}', detail: 'what constitutes this' },
    // An event is over, so what took part in it is fixed. What an endurant
    // has taken part in may continue to accumulate.
    participation: {
        ends: '(const) [${1:*}] -- ${2:participatedIn} -- [${3:0..*}] (addOnly) ${4:Event}',
        detail: 'what took part in something that happened; name event participation in the past'
    },
    creation: {
        ends: '(const) [${1:1}] -- ${2:name} -- [${3:1}] (const) ${4:Event}',
        detail: 'the event an individual came into existence in'
    },
    // Both ends optional, unlike `@creation`: an endurant that still exists has
    // no termination yet, so the event end is `[0..1]` and not `[1]`. And that
    // is why the word there is `addOnly` where `@creation` has `const`: the
    // link is made once, when the individual ceases to exist, and never broken
    // -- `const` would forbid the making of it, which is the one thing this
    // end is for.
    termination: {
        ends: '(const) [${1:0..1}] -- ${2:name} -- [${3:0..1}] (addOnly) ${4:Event}',
        detail: 'the event it ceased to exist in, if it has'
    },
    triggering: { ends: '(const) [${1:1}] -- [${2:0..1}] (addOnly) ${3:Event}', detail: 'the event this situation sets off' },
    bringingAbout: {
        ends: '(const) [${1:1}] -- [${2:0..1}] (addOnly) ${3:Situation}',
        detail: 'the situation this leaves behind, if it succeeds'
    },
    // The source end is `[*]`: how many individuals instantiate a type is not
    // something the type says, and leaving it out claimed exactly one.
    instantiation: {
        ends: '[${1:*}] -- [${2:1..*}] ${3:Type}',
        detail: 'the type whose instances this is one of'
    },
    // The two that reach a perdurant without writing a name for it. Derived,
    // they came out as `[*] -- [0..*] Type`: the wrong end fixed, and a
    // placeholder that does not say the far end is something that happens.
    // The near end is a property of the event, and an event is over, so it is
    // `(const) [1]`; what an endurant has been through accumulates, so the
    // far end is `[0..*]`.
    change: {
        ends: '(const) [${1:1}] -- [${2:0..*}] ${3:Event}',
        detail: 'the event this changed in'
    },
    manifestation: {
        ends: '(const) [${1:1}] -- [${2:0..*}] ${3:Event}',
        detail: 'the event this aspect showed itself in'
    }
};

/** What a stereotype with nothing written for it looks like. */
function derivedEnds(stereotype: string): string {
    if (PART_WHOLE_STEREOTYPES.has(stereotype)) {
        // Event parthood, which is all that is left here: an event is over, so
        // both ends are fixed.
        return '(const) [${1:1}] <>-- [${2:2..*}] (const) ${3:Part}';
    }
    return '[${1:*}] -- [${2:0..*}] ${3:Type}';
}

function snippetFor(stereotype: string): Snippet {
    const written = WRITTEN[stereotype];
    return {
        // The suffix is what lets the snippet and the plain word stand in one
        // list: `@medi` has to be able to complete to the word.
        label: `@${stereotype} (with ends)`,
        detail: written?.detail ?? signatureOf(stereotype),
        stereotype,
        body: `@${stereotype} ${written?.ends ?? derivedEnds(stereotype)}`
    };
}

/**
 * What `@` may introduce inside a class body.
 *
 * Two things decide which of these are offered. Where the cursor is: `@`
 * begins an attribute stereotype in a datatype body and a relation with its
 * source at package level, so the same list cannot serve all three. And what
 * the class *is*: a `kind` does not mediate -- only a relator binds -- and a
 * `@mediation` offered inside one is an error offered as advice. Each carries
 * the stereotype it writes, and `mayStandFirst` asks the same table the check
 * reads whether this class may open it.
 */
const IN_A_CLASS: Snippet[] = [
    { label: 'attribute', detail: 'a named value', body: '${1:name}: ${2:string}$0' },
    ...RELATION_STEREOTYPES.map(snippetFor),
    {
        label: '@begin (attribute)',
        detail: 'when the individual began to exist',
        instants: true,
        body: '@begin ${1:startedAt}: const ${2:date}'
    },
    {
        label: '@end (attribute)',
        detail: 'when it ceased to -- optional on an endurant, "[1]" on an event',
        instants: true,
        body: '@end ${1:finishedAt}: const ${2:date} [0..1]'
    }
];

/** Inside a datatype or an enumeration: values, and nothing that relates. */
const IN_A_VALUE: Snippet[] = [
    { label: 'attribute', detail: 'a named value', body: '${1:name}: ${2:string}$0' }
];

/** At package level a relation carries its source, so `@` starts a relation. */
const AT_PACKAGE_LEVEL: Snippet[] = [
    {
        label: '@mediation (relation)',
        detail: 'relator to what it binds, written at package level',
        body: '@mediation relation ${1:Relator} [${2:*}] -- [${3:1}] (const) ${4:Type}'
    },
    {
        label: '@material (relation)',
        detail: 'material relation, written at package level',
        body: '@material relation ${1:Source} [${2:0..*}] -- ${3:name} -- [${4:0..*}] ${5:Target}'
    }
];

export class TontoCompletionProvider extends DefaultCompletionProvider {
    private readonly services: LangiumServices;

    /** `@` is not an identifier character, so editors will not ask unless the server names it. */
    override readonly completionOptions = { triggerCharacters: ['@'] };

    private readonly nodeLocator: AstNodeLocator;
    private readonly documents: LangiumDocuments;
    private readonly index: IndexManager;
    private readonly reverse: ReverseLookup;

    constructor(services: LangiumServices) {
        super(services);
        this.services = services;
        this.nodeLocator = services.workspace.AstNodeLocator;
        this.documents = services.shared.workspace.LangiumDocuments;
        this.index = services.shared.workspace.IndexManager;
        this.reverse = createReverseLookup(this.index, this.documents, this.nodeLocator);
        services.shared.workspace.DocumentBuilder.onUpdate(() => this.reverse.reset());
    }

    /**
     * Whether the cursor is inside a `genset` block whose `general` names a
     * relation.
     *
     * Read from the text, like `insideEndDecorator`: completion parses the
     * document only up to the cursor, and a block cut off there has no
     * generalization-set node to ask. The name is then looked up in the index,
     * which holds every relation under the `Source.name` a set refers to it by.
     */
    private insideRelationSet(context: CompletionContext): boolean {
        const before = context.textDocument.getText().slice(0, context.offset);
        const opened = [...before.matchAll(/\bgenset\b/g)].pop()?.index;
        if (opened === undefined || before.indexOf('}', opened) >= 0) {
            return false;
        }
        const general = /\bgeneral\s+([^\s{}]+)/.exec(before.slice(opened))?.[1];
        if (!general) {
            return false;
        }
        // The relations written in this document, which the parse up to the
        // cursor still holds, then any other file's through the index.
        const local = AstUtils.streamAllContents(context.document.parseResult.value)
            .some(node => isRelation(node) && !!node.name && `${getRelationSourceName(node)}.${node.name}` === general);
        return local || this.index.allElements().some(description => description.name === general
            && (description.type === 'InternalRelation' || description.type === 'ExternalRelation'));
    }

    /**
     * The specifics of the set whose general is being written, read from the
     * text: `genset g where A, B specializes |`, or a block naming them on a
     * `specifics` line before or after the cursor. Undefined where the cursor
     * is not in one, so the caller falls back to the ordinary filter.
     */
    private specificsFromText(context: CompletionContext): ClassDeclaration[] | undefined {
        const text = context.textDocument.getText();
        const before = text.slice(0, context.offset);
        const opened = [...before.matchAll(/\bgenset\b/g)].pop()?.index;
        if (opened === undefined) {
            return undefined;
        }
        const statement = before.slice(opened);
        const inline = /^genset\s+\S+\s+where\s+([^{}]*?)\s+specializes\s+\w*$/.exec(statement)?.[1];
        let listed = inline;
        if (listed === undefined && statement.includes('{') && !statement.includes('}') && /\bgeneral\s+\w*$/.test(statement)) {
            const block = statement + text.slice(context.offset, text.indexOf('}', context.offset) >>> 0);
            listed = /\bspecifics\s+([^}\n]+)/.exec(block)?.[1];
        }
        if (listed === undefined) {
            return undefined;
        }
        const names = listed.split(',').map(name => name.trim()).filter(Boolean);
        const declared = AstUtils.streamAllContents(context.document.parseResult.value)
            .filter(isClassDeclaration).toArray();
        return names.flatMap(name => declared.filter(node => node.name === name));
    }

    /**
     * A `///` line is a hidden token, so Langium has nothing to propose inside
     * one -- and the tags are exactly what a writer is unsure of. Answered
     * before the grammar is consulted, from the languages the document already
     * writes: a model documented in `pt-br` should not have to be told twice.
     */
    override async getCompletion(
        document: LangiumDocument, params: CompletionParams, cancelToken?: CancellationToken
    ): Promise<CompletionList | undefined> {
        const tags = this.documentationTags(document, params);
        if (tags) {
            return tags;
        }
        // Everything else a comment contains is prose. The parser is between
        // declarations there, so Langium proposed every declaration keyword
        // in the middle of a sentence.
        if (insideComment(document, params)) {
            return CompletionList.create([], true);
        }
        const list = await super.getCompletion(document, params, cancelToken);
        const answered = whatFollowsARelation(document, params, list);
        return this.whatBelongsHere(document, params, answered);
    }

    /**
     * What may be written here, where the parser has nothing to say.
     *
     * `@componenthood <>-- Person` leaves the parser reading `Person` as the
     * relation's *name*, waiting for a second `--` and a class -- so on the
     * next line it expects a name, and a name is the writer's to invent.
     * The list came out empty inside a class body, where a member may always
     * begin. The ambiguity is the grammar's and cannot be typed away: what
     * settles it is the class at the end, which is only read after the
     * position being asked about.
     *
     * Only where nothing else was found, and only where a member or a
     * declaration may begin, so this never adds to a list that is already
     * answering the question.
     */
    private whatBelongsHere(
        document: LangiumDocument, params: CompletionParams, list: CompletionList | undefined
    ): CompletionList | undefined {
        const prefix = document.textDocument.getText({
            start: { line: params.position.line, character: 0 },
            end: params.position
        });
        // Only on an empty line: a word already being typed is a name being
        // invented, and an editor that accepts a proposal on Enter would
        // replace it -- which is the reason nothing is proposed at a name
        // position in the first place.
        if ((list?.items.length ?? 0) > 0 || prefix.trim() !== '') {
            return list;
        }
        const offset = document.textDocument.offsetAt(params.position);
        const body = bodyAt(document, offset);
        const snippets = this.snippetsIn(body, prefix)
            .map(snippet => isClassDeclaration(body) ? this.tunedFor(snippet, body) : snippet)
            .filter(snippet => !isClassDeclaration(body) || this.writableIn(snippet, body));
        return snippets.length === 0 ? list : CompletionList.create(snippets.map(snippet => ({
            label: snippet.label,
            kind: CompletionItemKind.Snippet,
            detail: snippet.detail,
            insertText: snippet.body,
            insertTextFormat: InsertTextFormat.Snippet,
            sortText: `1_${snippet.label}`
        })), true);
    }

    private documentationTags(document: LangiumDocument, params: CompletionParams): CompletionList | undefined {
        const line = document.textDocument.getText({
            start: { line: params.position.line, character: 0 },
            end: params.position
        });
        const written = /^\s*\/\/\/\s*(@[\w:-]*)?$/.exec(line);
        if (!written) {
            return undefined;
        }
        const languages = new Set<string>(['en', 'pt-br']);
        for (const node of AstUtils.streamAllContents(document.parseResult.value)) {
            for (const entry of parseDocLines(docLinesAbove(node)).entries) {
                if (entry.language) {
                    languages.add(entry.language);
                }
            }
        }
        const items = [
            { label: '@label', detail: 'display name' },
            ...[...languages].map(language => ({ label: `@label:${language}`, detail: `display name in ${language}` })),
            ...[...languages].map(language => ({ label: `@${language}`, detail: `the same documentation in ${language}` }))
        ];
        const start = {
            line: params.position.line,
            character: params.position.character - (written[1]?.length ?? 0)
        };
        return {
            isIncomplete: false,
            items: items.map((item, index) => ({
                label: item.label,
                kind: CompletionItemKind.EnumMember,
                detail: item.detail,
                sortText: String(index).padStart(2, '0'),
                textEdit: { range: { start, end: params.position }, newText: item.label }
            }))
        };
    }

    /**
     * Offers the construct snippets registered for a keyword alongside the
     * plain keyword itself, and answers two questions the bare keyword list
     * cannot: what this stereotype *is*, and whether a nature is one this
     * declaration may take.
     */
    protected override completionForKeyword(
        context: CompletionContext,
        keyword: GrammarAST.Keyword,
        acceptor: CompletionAcceptor
    ): MaybePromise<void> {
        // Except after `@`: a stereotype is reached through `SoftKeyword` --
        // that is what makes `@mediation` proposable at all -- and there the
        // word is not a name being spelled but the thing being written.
        if (spellsAName(keyword) && !(afterAt(context) && SOFT_KEYWORDS.has(keyword.value))) {
            return undefined;
        }
        // Nothing continues a relation until the class at its end is written,
        // except the decorator that may still be open in front of it.
        // Not while the `@` word itself is being written: the stereotype list
        // is what belongs there, and the relation begins with it.
        if (atUnwrittenEnd(context) && !insideEndDecorator(context) && !afterAt(context)) {
            return this.endsAfterAStereotype(context, keyword, acceptor);
        }
        if (atPackageName(context)) {
            return undefined;
        }
        // On a class, only a historical role is derived from anything; a
        // relation's own `derivedFrom` is proposed where relations are.
        if (keyword.value === 'derivedFrom' && !writesARelation(linePrefix(context))
            && !/^\s*historicalRole(Mixin)?\b/.test(linePrefix(context))) {
            return undefined;
        }
        if (BEGINS_A_DECLARATION.has(keyword.value) && !startsADeclaration(linePrefix(context))) {
            return undefined;
        }
        if (!continuesTheHeader(context, keyword.value)) {
            return undefined;
        }
        if (atUnwrittenInstant(linePrefix(context))) {
            return this.instantAfterATag(context, keyword, acceptor);
        }
        if (NATURE_WORDS.has(keyword.value) && !admissibleNature(context, keyword.value)) {
            // `event E of |` used to offer all thirteen, eleven of which the
            // stereotype rules reject on the next keystroke.
            return undefined;
        }
        if (DEPRECATED_STEREOTYPES.has(keyword.value)) {
            // Still parsed, so a model that uses it reads; never proposed, so
            // nobody meets it for the first time from this list.
            // `deprecated-stereotype` says what to write instead.
            return undefined;
        }
        const facts = STEREOTYPES[keyword.value as ClassStereotype];
        if (facts) {
            // Ordered by familiarity rather than by where the grammar happens
            // to mention them, and each carrying what it means: a list of
            // twenty-three words is a quiz otherwise.
            acceptor(context, {
                label: keyword.value,
                kind: CompletionItemKind.Keyword,
                detail: stereotypeDetail(keyword.value),
                documentation: { kind: 'markdown', value: stereotypeDocumentation(keyword.value) },
                sortText: `0_${String(CLASS_STEREOTYPES_BY_FAMILIARITY.indexOf(keyword.value as ClassStereotype)).padStart(2, '0')}`
            });
            for (const snippet of SNIPPETS[keyword.value] ?? []) {
                this.offerSnippet(context, snippet, acceptor);
            }
            return undefined;
        }
        if (SOFT_KEYWORDS.has(keyword.value) && afterAt(context) && !this.wrongSortForWhatFollows(context, keyword.value)) {
            // Written `@mediation`, so proposed that way: a proposal labeled
            // `mediation` does not match what has been typed -- the `@` is
            // part of the prefix -- and the whole vocabulary was unreachable
            // from the one keystroke that asks for it. What it relates comes
            // with it, off the same table the check reads.
            //
            // The snippets carry a suffix (`@mediation (with ends)`) so that
            // both can stand in one list: the snippet is only offered while
            // the `@` itself is what the parser expects, and skipping the
            // plain word for it left `@mate` unable to complete `@material`.
            // The whole vocabulary stays proposable: `@medi` is heading for
            // `@mediation` wherever it is typed, and a list that hid it would
            // leave the word uncompletable. What the class cannot open is said
            // rather than removed -- the snippets, which write a whole
            // relation, are the ones that go.
            // The class whose body this is, not whatever node the offset
            // landed on: on a blank line after a relation that node is the
            // relation, and the annotation went missing wherever the body had
            // anything written in it.
            const owner = classAround(context);
            const opens = (RELATION_STEREOTYPES as readonly string[]).includes(keyword.value)
                && !!owner && mayStandFirst(keyword.value, owner);
            // In front of a written relation both ends are known, and the
            // words that cannot join them go to the bottom of the list,
            // saying why, as those the class cannot open already do.
            const target = owner && (RELATION_STEREOTYPES as readonly string[]).includes(keyword.value)
                ? this.writtenTarget(context) : undefined;
            const wholeAtTarget = /--<>/.test(lineRest(context)) && PART_WHOLE_STEREOTYPES.has(keyword.value);
            const joins = !owner || !target || naturesFitStereotype(keyword.value,
                wholeAtTarget ? target : owner, wholeAtTarget ? owner : target);
            const signature = (RELATION_STEREOTYPES as readonly string[]).includes(keyword.value)
                ? `${signatureOf(keyword.value)}${opens || !owner ? ''
                    : ` -- not from ${a(owner.stereotype)}`}${!opens || joins || !target ? '' : ` -- not to ${a(target.stereotype)}`}`
                : 'the instant a concrete individual begins or ceases to exist';
            acceptor(context, {
                label: `@${keyword.value}`,
                kind: CompletionItemKind.EnumMember,
                detail: signature,
                sortText: `${target && !(opens && joins) ? 3 : 2}_${keyword.value}`,
                textEdit: this.replacingTheTag(context, keyword.value)
            });
            return undefined;
        }
        if (LEGACY_KEYWORDS.has(keyword.value)) {
            // `label { }` and `description { }` are the older spelling, kept
            // in the grammar so an old model still reads and quietly repaired
            // by `legacy-text-block`. Proposing them teaches the spelling
            // being retired -- and they were proposed in every body, an
            // enumeration's included, where the only thing to write is a name.
            return undefined;
        }
        if (SOFT_KEYWORDS.has(keyword.value)) {
            // Not proposed at all away from `@`.
            //
            // These words reach a name position only because the grammar lets
            // a name be spelled with one; nobody inventing a name wants a list
            // of them. Worse than noise: an editor that accepts a suggestion
            // on Enter replaces what was being typed, so `kind Boat` followed
            // by Enter became `kind bringingAbout`. A name is the user's to
            // write, and the way to stay out of it is to propose nothing.
            return undefined;
        }
        const result = super.completionForKeyword(context, keyword, acceptor);
        // A whole member is proposed where a member may begin. Once the line
        // has one under way -- a relation, or an attribute past its colon --
        // what is being written is that member, and a snippet offering to
        // write another was noise on every finished line.
        // The same once the rest of the member follows the cursor: a snippet
        // writing ends in front of written ones left the relation with two.
        const snippets = keyword.value === '@'
            ? (memberUnderWay(linePrefix(context)) || lineRest(context).trim() ? [] : this.snippetsAfterAt(context))
            : keyword.value === 'bundles' || startsADeclaration(linePrefix(context)) ? SNIPPETS[keyword.value] ?? [] : [];
        for (const snippet of snippets) {
            this.offerSnippet(context, snippet, acceptor);
        }
        return result;
    }

    /**
     * The class at the far end of the relation written after the cursor, when
     * the line names one this document declares.
     */
    private writtenTarget(context: CompletionContext): ClassDeclaration | undefined {
        const name = /(?:<>--|--<>|--)\s*(?:\[[^\]]*\]\s*)?(?:\([^)]*\)\s*)?([\w.]+)\s*$/.exec(lineRest(context))?.[1];
        if (!name) {
            return undefined;
        }
        return AstUtils.streamAllContents(context.document.parseResult.value)
            .filter(isClassDeclaration).find(node => node.name === name);
    }

    /**
     * Whether the member written after the cursor rules this tag out: a
     * relation stereotype in front of `name: type`, or `@begin`/`@end` in
     * front of a relation's ends. Either word would turn the line into
     * something the parser cannot read. With nothing written after it, every
     * word stays proposable.
     */
    private wrongSortForWhatFollows(context: CompletionContext, word: string): boolean {
        const rest = lineRest(context);
        const relation = (RELATION_STEREOTYPES as readonly string[]).includes(word);
        if (relation) {
            return /^\s*[\w-]+\s*:/.test(rest);
        }
        return /(<>--|--<>|--)/.test(rest);
    }

    /**
     * The ends of a relation whose stereotype has just been written.
     *
     * After `@constitution ` the parser expects a multiplicity or a marker,
     * and Langium proposes no punctuation, so the list was empty at the one
     * position where the shape of the relation is most worth offering -- and
     * before that, it was every proposal that may follow a finished relation.
     * The shape comes off the same table the `@` list is built from, tuned
     * the same way, with the stereotype dropped from the front of it since
     * that is what has just been typed.
     *
     * Offered against `--`, which is expected wherever an end may begin and
     * nowhere else, so the snippet is proposed once rather than once per
     * marker.
     */
    private endsAfterAStereotype(
        context: CompletionContext, keyword: GrammarAST.Keyword, acceptor: CompletionAcceptor
    ): undefined {
        const written = /^\s*@(\w+)\s+$/.exec(linePrefix(context));
        const stereotype = written?.[1];
        if (keyword.value !== '--' || !stereotype
            || !(RELATION_STEREOTYPES as readonly string[]).includes(stereotype)) {
            return undefined;
        }
        const owner = classAround(context);
        if (owner && !mayStandFirst(stereotype, owner)) {
            return undefined;
        }
        const snippet = owner ? this.tunedFor(snippetFor(stereotype), owner) : snippetFor(stereotype);
        const body = snippet.body.replace(/^@\w+\s*/, '');
        this.offerSnippet(context, {
            ...snippet,
            label: body.replace(/\$\{\d+:([^}]*)\}/g, '$1'),
            detail: snippet.detail,
            body
        }, acceptor);
        return undefined;
    }

    /**
     * The name and type of an instant whose tag has just been written.
     *
     * `@begin ` takes an attribute and nothing else, and what was offered was
     * the whole class-body list -- every relation snippet among them. The
     * shape is the one the `@` list writes, with the tag dropped from the
     * front of it.
     *
     * Offered against `@`, the one keyword that may still follow a tag, so
     * it is proposed once.
     */
    private instantAfterATag(
        context: CompletionContext, keyword: GrammarAST.Keyword, acceptor: CompletionAcceptor
    ): undefined {
        const tag = /^\s*@(begin|end)\s+$/.exec(linePrefix(context))?.[1];
        const snippet = IN_A_CLASS.find(candidate => candidate.label === `@${tag} (attribute)`);
        // Against `@`, which is what may follow a tag -- a second stereotype --
        // and is the keyword whose own snippets were the flood.
        if (!snippet || keyword.value !== '@') {
            return undefined;
        }
        const body = snippet.body.replace(/^@\w+\s*/, '');
        this.offerSnippet(context, {
            ...snippet,
            label: body.replace(/\$\{\d+:([^}]*)\}/g, '$1'),
            body
        }, acceptor);
        return undefined;
    }

    /**
     * What `@` may begin here, which depends on what the cursor is inside.
     *
     * The node under the cursor is not the answer, and asking it alone got
     * every line of a written body wrong: on a blank line after a relation
     * the node is that relation, which has no brace, so the body read as
     * package level; after `@begin born: const date` it is the attribute,
     * whose brace is the one around `const`, so the body read as a
     * datatype's; and just past a class's `}` the node is still the class, so
     * package level read as a body. What decides is the innermost braces the
     * cursor is actually between, which is what `bodyAround` walks up to
     * find.
     */
    private snippetsAfterAt(context: CompletionContext): Snippet[] {
        return this.snippetsIn(bodyAround(context), linePrefix(context));
    }

    /** What may be written in this body, or at package level where there is none. */
    private snippetsIn(body: AstNode | undefined, prefix: string): Snippet[] {
        if (!body) {
            // A relation written at package level is a declaration, and one
            // begins a line: after `kind Person` the two of them stood beside
            // `of` and `specializes` as though a second declaration were what
            // the line needed.
            return startsADeclaration(prefix) ? AT_PACKAGE_LEVEL : [];
        }
        if (isClassDeclaration(body)) {
            return IN_A_CLASS.filter(snippet => this.writableIn(snippet, body))
                .map(snippet => this.tunedFor(snippet, body));
        }
        // A datatype or an enumeration holds values; anywhere else with braces
        // -- a generalization set, an end decorator -- `@` begins nothing.
        return isDatatype(body) || isEnumeration(body) ? IN_A_VALUE : [];
    }

    /**
     * Two snippets say something different about a particular sort, and
     * inserting the general form there writes a diagnostic.
     *
     * An event has ended -- that is what makes it one -- so its end point is
     * `[1]` rather than the `[0..1]` an endurant takes. And a process is
     * constituted *by* events rather than constituting anything: the one pair
     * in the table whose direction is fixed (Guarino & Guizzardi 2024, A5),
     * and what accumulates as the process goes on.
     */
    private tunedFor(snippet: Snippet, classDeclaration: ClassDeclaration): Snippet {
        if (snippet.instants && classifiesOnly(classDeclaration, 'events')) {
            return { ...snippet, body: snippet.body.replace(' [0..1]', '') };
        }
        if (snippet.stereotype === 'constitution' && classifiesOnly(classDeclaration, 'processes')) {
            return {
                ...snippet,
                label: '@constitution (the events that make this up)',
                detail: 'what constitutes a process, which accumulates as it goes on',
                body: '@constitution (const) [${1:1}] -- [${2:1..*}] (addOnly) ${3:Event}'
            };
        }
        return snippet.stereotype ? this.fixedIn(snippet, classDeclaration) : snippet;
    }

    /**
     * An end written inside a class whose instances cannot change is `const`
     * before it is anything else.
     *
     * The far end of a relation is a property of the class it is written in --
     * `event Wedding { -- [1] Place }` gives `Wedding::place` -- so in an
     * event, a situation or an abstractum it cannot vary, and
     * `immutable-end-not-const` says so the moment the snippet lands. The ones
     * written for those classes already carry it; this is for the ones derived
     * from the table, which cannot know where they are being written.
     */
    private fixedIn(snippet: Snippet, classDeclaration: ClassDeclaration): Snippet {
        const natures = possibleNaturesOf(classDeclaration);
        const immutable = !!natures && natures.size > 0
            && [...natures].every(nature => IMMUTABLE_NATURES.has(nature));
        if (!immutable) {
            return snippet;
        }
        // The last end written, which is the one the class owns. Left alone
        // where the snippet already decorates it.
        const body = /\]\s*\(/.test(snippet.body.slice(snippet.body.lastIndexOf(']')))
            ? snippet.body
            : snippet.body.replace(/(\]\s*)(\$\{\d+:[A-Za-z]+\})$/, '$1(const) $2');
        return { ...snippet, body };
    }

    /** Whether this class may open the relation, or hold the instant. */
    private writableIn(snippet: Snippet, classDeclaration: ClassDeclaration): boolean {
        if (snippet.stereotype) {
            return mayStandFirst(snippet.stereotype, classDeclaration);
        }
        if (snippet.instants) {
            // Nothing outside time begins or ends, which is what
            // `time-point-on-atemporal-owner` says once one is written.
            const natures = possibleNaturesOf(classDeclaration);
            return !natures || natures.size === 0 || [...natures].some(nature => nature !== 'abstract-individuals');
        }
        return true;
    }

    /** An edit over the whole `@word`, so the `@` is not written twice. */
    private replacingTheTag(context: CompletionContext, value: string): TextEdit | undefined {
        const character = tagStart(context);
        return character === undefined ? undefined : {
            range: {
                start: { line: context.position.line, character },
                end: context.position
            },
            newText: `@${value}`
        };
    }

    private offerSnippet(context: CompletionContext, snippet: Snippet, acceptor: CompletionAcceptor): void {
        acceptor(context, {
            label: snippet.label,
            kind: CompletionItemKind.Snippet,
            detail: snippet.detail,
            insertText: snippet.body,
            insertTextFormat: InsertTextFormat.Snippet,
            // Sort snippets just after the bare keyword.
            sortText: `1_${snippet.label}`
        });
    }

    /**
     * Target type of the cross-reference being completed, read from the
     * grammar rather than from the runtime context.
     */
    private pendingReferenceType?: string;

    protected override completionForCrossReference(
        context: CompletionContext,
        next: NextFeature<GrammarAST.CrossReference>,
        acceptor: CompletionAcceptor
    ): MaybePromise<void> {
        this.pendingReferenceType = next.feature.type?.ref?.name;
        try {
            const result = super.completionForCrossReference(context, next, acceptor);
            if (context.node) {
                const refInfo = { container: context.node, property: next.property, reference: { $refText: '' } } as ReferenceInfo;
                const pkg = AstUtils.getContainerOfType(context.node, isPackage);
                if (pkg) for (const candidate of importCandidates(this.services, refInfo)) {
                    if (!this.isViableSupertype(refInfo, context, candidate.description)) continue;
                    const edit = importEdit(context.document, pkg, candidate.pkg);
                    if (edit) acceptor(context, {
                        label: candidate.description.name, kind: CompletionItemKind.Reference,
                        detail: `Adds "use ${candidate.pkg.name}"`, insertText: candidate.description.name,
                        additionalTextEdits: [edit], sortText: `2_${candidate.description.name}`
                    });
                }
            }
            return result;
        } finally {
            this.pendingReferenceType = undefined;
        }
    }

    /**
     * Trims two kinds of noise from cross-reference proposals:
     *
     * 1. The declaration currently being written -- proposing `Student` for
     *    `role Student specializes |` only invites a self-specialization that
     *    the specialization-cycle check then rejects.
     * 2. The package-qualified spelling of something already offered by its
     *    simple name, which doubled the length of every list. The qualified
     *    form is still proposed for elements that are *only* reachable that
     *    way (other packages).
     */
    protected override getReferenceCandidates(refInfo: ReferenceInfo, context: CompletionContext): Stream<AstNodeDescription> {
        const container = refInfo.container;
        // Packages are used, not imported: after `import` comes an alias and
        // a location, never a package, so none is proposed there.
        if (isImport(container) && refInfo.property === 'package' && !container.use) return EMPTY_STREAM;
        // The declaration being written is whichever named element encloses the
        // reference, e.g. the `role Student` around `specializes |`.
        //
        // Only when the container actually declares this property is it the
        // element being written. Part way through `relation |` Langium hands
        // over the nearest preceding declaration instead, and treating that as
        // "self" silently removed the package's *last* declaration from every
        // relation proposal.
        const selfPath = this.ownsProperty(refInfo) ? this.nodeLocator.getAstNodePath(container) : undefined;
        const selfUri = AstUtils.getDocument(container).uri.toString();

        const seen = new Set<string>();
        return this.candidatesInScope(refInfo, context).filter(description => {
            const uri = description.documentUri.toString();
            if (selfPath !== undefined && uri === selfUri && description.path === selfPath) {
                return false;
            }
            // The scope offers each element under its simple name first and its
            // package-qualified name second; keeping only the first occurrence
            // therefore keeps the shorter spelling and halves the list.
            const key = `${uri}#${description.path}`;
            if (seen.has(key)) {
                return false;
            }
            if (!this.isViableSupertype(refInfo, context, description)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    }

    private ownsProperty(refInfo: ReferenceInfo): boolean {
        try {
            this.astReflection.getReferenceType(refInfo);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Everything in scope for this reference.
     *
     * Langium derives the target type by asking reflection about the property
     * on the container it supplies -- but part way through `relation |`, or
     * inside a fragment such as `RelationEnds`, that container's type does not
     * declare the property. Reflection throws, Langium swallows the error, and
     * *no* completion at all appeared at any relation position. The grammar
     * states the target type outright, so it is used when reflection cannot.
     */
    private candidatesInScope(refInfo: ReferenceInfo, context: CompletionContext): Stream<AstNodeDescription> {
        try {
            return super.getReferenceCandidates(refInfo, context);
        } catch {
            const provider = this.scopeProvider as Partial<TontoScopeProvider>;
            if (!this.pendingReferenceType || typeof provider.scopeForType !== 'function') {
                return EMPTY_STREAM;
            }
            return provider.scopeForType(this.pendingReferenceType, refInfo).getAllElements();
        }
    }

    /**
     * Whether a candidate could actually serve as a supertype, applying the
     * same rules the validators enforce so completion never proposes something
     * that would immediately be flagged as an error.
     *
     * Only `specializes` on a class is filtered. A candidate that cannot be
     * resolved -- or either side stereotyped plain `class`, which carries no
     * ontological commitment -- is left in the list: the point is to remove
     * choices known to be wrong, not to guess.
     */
    private isViableSupertype(refInfo: ReferenceInfo, context: CompletionContext, description: AstNodeDescription): boolean {
        const container = refInfo.container;
        const candidate = this.resolveCandidate(description);
        if (!candidate) {
            return true;
        }
        // A relation end may name a datatype or an enumeration, and the
        // natures rule those out exactly as they rule out a class: `date` was
        // proposed as a member of a collective because the filter below asks
        // only about classes.
        if (refInfo.property === 'source' || refInfo.property === 'target') {
            // The container Langium supplies is not always the relation --
            // the same fragment problem `candidatesInScope` works around -- so
            // the node under the cursor is asked as well. A relation with
            // nothing yet typed at the end still parses, since the target is
            // optional in the grammar, so the natures narrow the list from the
            // first keystroke rather than the second.
            const relation = isRelation(container) ? container : AstUtils.getContainerOfType(context.node, isRelation);
            return !relation || admissibleAtRelationEnd(relation, refInfo.property, candidate);
        }
        // An end may only override one it could actually narrow, which is two
        // questions the rules already ask of what is written: the classifier
        // this end belongs to has to specialize the one the overridden end
        // belongs to (`override-owner-not-subtype`), and the type at this end
        // has to specialize the type at that one (`override-type-not-narrower`).
        // Without them every named end in the workspace stood in the list.
        if (refInfo.property === 'subsets' || refInfo.property === 'redefines') {
            return this.isViableOverride(context, candidate);
        }
        // The clause has two meanings: historical roles name an event or a
        // founding relation; derived relations name the aspects they read.
        // Applying the latter filter to both silently emptied the former.
        if (refInfo.property === 'derivedFrom') {
            const subject = isClassDeclaration(container) ? container : AstUtils.getContainerOfType(context.node, isClassDeclaration);
            if (subject && !isRelation(container) && !AstUtils.getContainerOfType(context.node, isRelation)) {
                if (foundingOf(subject) !== 'historical') return false;
                if (isRelation(candidate)) {
                    const participant = getRelationSource(candidate);
                    return foundsHistorically(candidate) && isClassDeclaration(participant)
                        && !cannotShareInstances(participant, subject);
                }
                if (!isClassDeclaration(candidate)) return false;
                const natures = possibleNaturesOf(candidate);
                return !!natures && natures.size > 0 && [...natures].every(nature => nature === 'events' || nature === 'processes')
                    && validationOntology.run(ownerOf(subject), () =>
                        foundingCandidatesInto(subject, candidate, node => this.reverse.touching(node)).length === 1);
            }
            const relation = isRelation(container) ? container : AstUtils.getContainerOfType(context.node, isRelation);
            const stereotype = relation?.stereotype;
            return isClassDeclaration(candidate) && (stereotype === 'material' || stereotype === 'comparative')
                && admits(stereotype, candidate);
        }
        // A categorizer is a type whose instances are the specifics, whatever
        // the set generalizes: never a relation, and never a class that does
        // not classify types (`categorizer-is-relation`,
        // `categorizer-not-higher-order`). Asked before the set is looked up,
        // since part way through a block the container is often the
        // declaration above it, and the member rules would otherwise offer
        // whatever matches the set's general.
        if (refInfo.property === 'categorizers') {
            // A set of relations takes none (`categorizer-on-relation-set`).
            const relationSet = isGeneralizationSet(container) && isRelation(container.general?.ref)
                || this.insideRelationSet(context);
            return !relationSet && isClassDeclaration(candidate) && classifiesTypes(candidate);
        }
        // A generalization set takes classes or relations, so a relation is a
        // candidate there and is judged with the rest. The container Langium
        // supplies is not always the set -- the same fragment problem
        // `candidatesInScope` works around -- so the node under the cursor is
        // asked as well.
        const genset = isGeneralizationSet(container)
            ? container
            : AstUtils.getContainerOfType(context.node, isGeneralizationSet);
        if (genset) {
            return this.isViableGensetMember(genset, refInfo, context, candidate);
        }
        // The general is mandatory, so while it is still unwritten the parse
        // has no set to ask, and the specifics were offered as their own
        // general. They are read from the text instead.
        if (refInfo.property === 'general' && isClassDeclaration(candidate)) {
            const specifics = this.specificsFromText(context);
            if (specifics) {
                return !specifics.includes(candidate) && specifics.every(specific => canSpecializeAcross(specific, candidate));
            }
        }
        if (!isClassDeclaration(candidate)) {
            return true;
        }
        if (refInfo.property === 'specializes' && isClassDeclaration(container)) {
            const edited = this.editedIndex(container, container.specializes, 'specializes', context);
            if (container.specializes.some((ref, index) => index !== edited && ref.ref === candidate)) {
                return false;
            }
            return canSpecializeAcross(container, candidate);
        }
        // `instanceOf` names a higher-order type, so only a class whose
        // instances are types can serve: the same question
        // `checkInstanceOfTargetIsHigherOrder` asks afterward. A categorizer
        // asks it too, above.
        if (refInfo.property === 'instanceOf') {
            return classifiesTypes(candidate);
        }
        return true;
    }

    /**
     * Whether this end could override the candidate end.
     *
     * The end being written is read from the node under the cursor rather than
     * from the container Langium supplies, which part way through a decorator
     * is whatever the parser last attached the offset to.
     *
     * What is not yet written narrows nothing: an end whose class is still
     * unwritten has no type to compare, and the list stays as wide as the
     * owner rule leaves it.
     */
    private isViableOverride(context: CompletionContext, candidate: AstNode): boolean {
        if (!isRelationEndMetaAttributes(candidate)) {
            return true;
        }
        const relation = AstUtils.getContainerOfType(context.node, isRelation);
        const end = AstUtils.getContainerOfType(context.node, isRelationEndMetaAttributes)
            ?? endBeingWritten(context);
        if (end === candidate || !relation) {
            return false;
        }
        // Which end is being written is read from the text, not from the
        // parse: with nothing yet typed after `subsets` the decorator does not
        // parse, and error recovery hangs it on the other end -- which turned
        // the owner and the type round and emptied the list.
        // A relation is one line, so the line up to the cursor is the whole of
        // what has been written of it.
        const atSource = !RELATION_MARKERS.test(linePrefix(context));
        RELATION_MARKERS.lastIndex = 0;
        const owner = atSource ? relation.target?.ref : getRelationSource(relation);
        const type = atSource ? getRelationSource(relation) : relation.target?.ref;
        const theirOwner = getEndOwner(candidate);
        if (isClassDeclaration(owner) && isClassDeclaration(theirOwner)
            && !isSameOrSpecializes(owner, theirOwner)) {
            return false;
        }
        // An end override implies the relation specialization, and parthood is
        // inherited both ways: a parthood relation may not specialize a plain
        // one, nor a plain one a parthood -- `parthood-specialization-mismatch`
        // is an error either way. Only once a marker says which this is.
        const marker = /<>--|--<>|--/.exec(linePrefix(context))?.[0];
        if (marker && (marker !== '--') !== isParthood(candidate.$container)) {
            return false;
        }
        const theirType = getEndType(candidate);
        return !type || !theirType || isEndTypeCompatible(type, theirType);
    }

    /**
     * A generalization set states the same relation a `specializes` does, so
     * it gets the same reasoning: each specific specializes the general.
     *
     * With one question of its own first. A set generalizes classes *or*
     * relations and not the two together -- `genset-mixes-classes-and-
     * relations` is an error the moment they are mixed -- so once anything in
     * the set has resolved, the other sort is not a candidate. Without that,
     * every relation end in the workspace stood in the list beside the
     * classes at `genset Seniority where |`.
     */
    private isViableGensetMember(
        genset: GeneralizationSet, refInfo: ReferenceInfo, context: CompletionContext, candidate: AstNode
    ): boolean {
        if (!isClassDeclaration(candidate) && !isRelation(candidate)) {
            return true;
        }
        const members = [genset.general?.ref, ...genset.specifics.map(reference => reference.ref)]
            .filter((node): node is ClassDeclaration | Relation =>
                !!node && (isClassDeclaration(node) || isRelation(node)));
        if (members.some(member => isClassDeclaration(member) !== isClassDeclaration(candidate))) {
            return false;
        }
        if (!isClassDeclaration(candidate)) {
            // What a relation specialization has to satisfy is about its ends,
            // which `relation-specialization-*` says once one is written; the
            // list stays open rather than guessing at it.
            return true;
        }
        const specifics = genset.specifics
            .map(reference => reference.ref)
            .filter((node): node is ClassDeclaration => !!node && isClassDeclaration(node));
        const general = genset.general?.ref;

        if (refInfo.property === 'specifics') {
            const edited = this.editedIndex(genset, genset.specifics, 'specifics', context);
            if (genset.specifics.some((reference, index) => index !== edited && reference.ref === candidate)) {
                return false;
            }
            // Nothing is known yet if the general is unwritten or unresolved.
            return !general || !isClassDeclaration(general) || canSpecializeAcross(candidate, general);
        }
        if (refInfo.property === 'general') {
            return specifics.every(specific => canSpecializeAcross(specific, candidate));
        }
        return true;
    }

    /**
     * Which entry of `specializes` the cursor is inside, so that re-completing
     * an already-written supertype still proposes what it names.
     *
     * `ReferenceInfo.index` is not populated during completion -- Langium
     * builds a synthetic info without it -- so the entry is located by the
     * cursor offset against each reference's CST node.
     */
    private editedIndex(
        owner: AstNode, references: readonly unknown[], property: string, context: CompletionContext
    ): number | undefined {
        const cst = owner.$cstNode;
        if (!cst) {
            return undefined;
        }
        for (let index = 0; index < references.length; index++) {
            const node = GrammarUtils.findNodeForProperty(cst, property, index);
            if (node && context.offset >= node.offset && context.offset <= node.end) {
                return index;
            }
        }
        return undefined;
    }

    /**
     * The AST node behind a description. Descriptions built for the local and
     * imported scopes carry the node directly; those from the global index do
     * not, so they are looked up through the node locator -- and skipped when
     * the owning document is not loaded, rather than dropped from the list.
     */
    private resolveCandidate(description: AstNodeDescription): AstNode | undefined {
        if (description.node) {
            return description.node;
        }
        const document = this.documents.getDocument(description.documentUri);
        return document && this.nodeLocator.getAstNode(document.parseResult.value, description.path);
    }
}


/**
 * An ultimate sortal in this class's lineage, itself included -- the kind (or
 * collective, quantity, relator, mode, quality) its instances belong to.
 *
 * `other than` lets a caller ask for one *different* from an already-fixed
 * ultimate sortal, which is the question that matters when filtering: sharing
 * the same kind is fine, a second one is not.
 */
function ultimateSortalIn(node: ClassDeclaration, otherThan?: ClassDeclaration): ClassDeclaration | undefined {
    for (const member of [node, ...collectAncestors(node)]) {
        if (isUltimateSortal(member.stereotype) && member !== otherThan) {
            return member;
        }
    }
    return undefined;
}

/**
 * Whether `sub` could specialize `sup`, however the generalization is written
 * -- a `specializes` clause or a generalization set.
 *
 * Every rule the validator would apply to the finished model, so completion
 * can never propose something that is flagged the moment it is accepted.
 */
function canSpecializeAcross(sub: ClassDeclaration, sup: ClassDeclaration): boolean {
    if (sub === sup) {
        return false;
    }
    // Choosing this would close a generalization cycle.
    if (collectAncestors(sup).has(sub)) {
        return false;
    }
    // The taxonomy rule, shared with the validator so completion can never
    // propose something that would immediately be flagged. A plain `class`
    // commits to nothing and is handled inside.
    if (!canSpecializeByStereotype(sub.stereotype, sup.stereotype)) {
        return false;
    }
    // Disjointness is about instances, so it applies whatever the stereotypes
    // are, including a bare `class`.
    if (wouldConflictWithLineage(sub, sup)) {
        return false;
    }
    // Ultimate sortals are pairwise disjoint -- an individual has exactly one
    // kind -- so a lineage holds at most one. Once `phase C specializes A` has
    // fixed the kind, neither another kind nor anything under one is a
    // possible second supertype.
    const chosen = ultimateSortalIn(sub);
    if (chosen && ultimateSortalIn(sup, chosen)) {
        return false;
    }
    // Every nature rule at once -- the candidate against the subject's
    // stereotype, its `of` clause and the supertypes already chosen -- asked
    // as the single question the validator would ask of the finished model.
    //
    // No shortcut for a plain `class`: it commits to nothing by *stereotype*,
    // but `class Carro of objects` still restricts its instances, and an
    // `event` cannot specialize it. A class that really is unconstrained
    // yields no constraint here and is admitted anyway.
    return admitsSupertype(sub, sup);
}
