import { AstUtils } from 'langium';
import type { AstNode, ValidationAcceptor } from 'langium';
import type { LegacyTextBlock, Model } from '../generated/ast.js';
import { isOntology } from '../generated/ast.js';
import { namespaceProblem } from '../utils/namespaces.js';
import type { DocEntry, Documentation } from '../documentation/doc-comment.js';
import { ONTOLOGY_TAGS, docLinesAbove, lineRange, parseDocLines } from '../documentation/doc-comment.js';
import { distance } from './relation-stereotypes.js';

/**
 * The documentation checks read the `///` runs of a whole document at once.
 *
 * One pass rather than a check per declaration, for two reasons: documentation
 * attaches to anything with a name, so there is no list of types to keep in
 * step; and whether `@pr-br` is a typo can only be answered by the languages
 * the rest of the document writes.
 */
export function checkDocumentation(model: Model, accept: ValidationAcceptor): void {
    // A run has one owner (`docLinesAbove`), so each is read once.
    const documented: Array<{ node: AstNode; documentation: Documentation }> = [];
    for (const node of AstUtils.streamAllContents(model)) {
        const lines = docLinesAbove(node);
        if (lines.length > 0) {
            documented.push({ node, documentation: parseDocLines(lines) });
        }
    }
    const counts = new Map<string, number>();
    for (const { documentation } of documented) {
        for (const entry of documentation.entries) {
            if (entry.language.length > 0) {
                counts.set(entry.language, (counts.get(entry.language) ?? 0) + 1);
            }
        }
    }

    for (const { node, documentation } of documented) {
        checkOntologyTags(node, documentation, accept);
        checkEntries(node, documentation, accept);
        checkTagsThatAreNot(node, documentation, new Set(counts.keys()), accept);
        checkLanguagesAgainstEachOther(node, documentation, counts, accept);
    }
}

/**
 * `@pt-b` where the document says `@pt-br` everywhere else.
 *
 * Nothing about a tag's shape can tell a language apart from a slip in one --
 * `pt-b` is as well formed as `pt-br` -- so the document answers instead: a
 * language written once, one edit from one written repeatedly, is a slip. A
 * language genuinely used once is left alone until a near neighbor appears.
 */
function checkLanguagesAgainstEachOther(
    node: AstNode, documentation: Documentation, counts: ReadonlyMap<string, number>, accept: ValidationAcceptor
): void {
    for (const entry of documentation.entries) {
        if (entry.language.length === 0 || (counts.get(entry.language) ?? 0) > 1) {
            continue;
        }
        const established = [...counts.entries()]
            .filter(([language, count]) => count > 1 && distance(language, entry.language) === 1)
            .map(([language]) => language)[0];
        if (established) {
            report(node, entry.line,
                'hint', `"${entry.language}" is written once, and "${established}" everywhere else. Did you mean "${established}"?`,
                'doubtful-doc-language', accept, { closest: established, tag: tagOf(entry).slice(1) });
        }
    }
}

function report(
    node: AstNode, line: number, severity: 'error' | 'warning' | 'hint', message: string,
    code: string, accept: ValidationAcceptor, data?: unknown
): void {
    const range = lineRange(node, line);
    accept(severity, message, { node, code, ...(range ? { range } : {}), ...(data ? { data } : {}) });
}

/**
 * `@namespace`, `@version`, `@license` and `@creator` describe an ontology --
 * where its terms are published, and its header in the gUFO export -- so they
 * belong above its `ontology` header and nowhere else: not on a package, which
 * is a part of an ontology and published with it, nor on any other
 * declaration. An ontology has one namespace, one version and one license;
 * it may have several creators.
 */
function checkOntologyTags(node: AstNode, documentation: Documentation, accept: ValidationAcceptor): void {
    const seen = new Map<string, string>();
    for (const entry of documentation.entries) {
        if (!(ONTOLOGY_TAGS as readonly string[]).includes(entry.kind)) continue;
        if (!isOntology(node)) {
            report(node, entry.line,
                'warning', `"@${entry.kind}" describes an ontology, so it belongs above its "ontology" header; here it is ignored.`,
                'ontology-tag-not-on-header', accept, { tag: entry.kind, text: entry.text });
            continue;
        }
        const earlier = seen.get(entry.kind);
        if (entry.kind !== 'creator' && earlier !== undefined) {
            report(node, entry.line,
                'error', `An ontology has one ${entry.kind}, and "${earlier}" is already given above.`,
                entry.kind === 'namespace' ? 'duplicate-namespace' : 'duplicate-ontology-tag', accept);
            continue;
        }
        seen.set(entry.kind, entry.text);
        const problem = entry.kind === 'namespace' && entry.text.length > 0 ? namespaceProblem(entry.text) : undefined;
        if (problem) {
            report(node, entry.line, 'error', `The namespace "${entry.text}" ${problem}.`, 'namespace-malformed', accept);
        }
    }
}

/** A language documents a declaration once; the second writing is dropped. */
function checkEntries(node: AstNode, documentation: Documentation, accept: ValidationAcceptor): void {
    const seen = new Set<string>();
    for (const entry of documentation.entries) {
        const key = `${entry.kind}:${entry.language}`;
        const written = tagOf(entry);
        if (entry.kind !== 'label' && entry.kind !== 'description') {
            // `checkOntologyTags` answers for these, a
            // repetition included.
            if (entry.text.length === 0) {
                report(node, entry.line,
                    'warning', `"${written}" says nothing. Write the ${entry.kind === 'namespace' || entry.kind === 'license' ? 'IRI' : entry.kind === 'version' ? 'version' : 'name'} after the tag, or remove the line.`,
                    'empty-doc-tag', accept);
            }
            continue;
        }
        if (seen.has(key)) {
            report(node, entry.line,
                'error', `${describe(entry)} is already given above, and only the first is used.`,
                'duplicate-doc-language', accept);
            continue;
        }
        seen.add(key);
        if (entry.text.length === 0) {
            report(node, entry.line,
                'warning', `"${written}" says nothing. Write the text after the tag, or remove the line.`,
                'empty-doc-tag', accept);
        }
    }
}

function tagOf(entry: DocEntry): string {
    if (entry.kind !== 'label' && entry.kind !== 'description') {
        return `@${entry.kind}`;
    }
    if (entry.kind === 'label') {
        return entry.language ? `@label:${entry.language}` : '@label';
    }
    return `@${entry.language}`;
}

function describe(entry: DocEntry): string {
    if (entry.kind === 'label') {
        return entry.language ? `A label in "${entry.language}"` : 'A label';
    }
    return `Documentation in "${entry.language}"`;
}

/**
 * A line beginning `@` that names no language reads as prose, which is what a
 * sentence about `@mediation` needs -- so this fires only where the word is
 * within one edit of `label` or of a language the document writes elsewhere.
 * Anything further away is taken at face value and left alone.
 */
function checkTagsThatAreNot(
    node: AstNode, documentation: Documentation, languages: ReadonlySet<string>, accept: ValidationAcceptor
): void {
    const known = ['label', ...ONTOLOGY_TAGS, ...languages];
    for (const { tag, line } of documentation.unknownTags) {
        const closest = known.find(candidate => distance(tag.toLowerCase(), candidate) === 1);
        if (closest) {
            report(node, line,
                'hint', `"@${tag}" is not a documentation tag, so this line reads as prose. Did you mean "@${closest}"?`,
                'unknown-doc-tag', accept, { closest, tag });
        }
    }
}

/**
 * `label { }` and `description { }` are the older spelling.
 *
 * They say about a classifier what `///` says about any declaration, in text
 * a string literal cannot always hold -- there is no escape for `"` -- and
 * they are edited a block at a time. Reported as a hint with the conversion
 * attached: nothing here is wrong, it is written the long way.
 */
export function checkLegacyTextBlock(block: LegacyTextBlock, accept: ValidationAcceptor): void {
    // Across the blocks, not within one: two `description { }` blocks are one
    // description, so a language repeated between them is repeated.
    const siblings = (block.$container as { legacyText?: LegacyTextBlock[] }).legacyText ?? [];
    const earlier = siblings.slice(0, siblings.indexOf(block))
        .filter(sibling => sibling.kind === block.kind)
        .flatMap(sibling => sibling.items.flatMap(item => item.language ? [item.language.toLowerCase()] : []));
    const seen = new Set<string>(earlier);
    block.items.forEach((item, index) => {
        // A word the lexer took for a keyword leaves no language; the parser
        // has reported that already.
        if (!item.language) return;
        const language = item.language.toLowerCase();
        if (seen.has(language)) {
            accept('error', `"@${item.language}" is already given for this "${block.kind}".`,
                { node: item, property: 'language', code: 'duplicate-doc-language', index });
        }
        seen.add(language);
    });
    accept('hint',
        `A "${block.kind}" block is the older spelling; "///" documentation says the same thing above the declaration.`,
        { node: block, property: 'kind', code: 'legacy-text-block' });
}
