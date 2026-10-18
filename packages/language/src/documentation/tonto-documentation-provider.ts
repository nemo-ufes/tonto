import { JSDocDocumentationProvider } from 'langium';
import type { AstNode, LangiumCoreServices } from 'langium';
import { isLegacyTextBlock } from '../generated/ast.js';
import type { Classifier } from '../generated/ast.js';
import type { Documentation } from './doc-comment.js';
import { docLinesAbove, isEmpty, parseDocLines } from './doc-comment.js';

/**
 * Documentation written as `///` lines above a declaration.
 *
 * Two comment forms, one job each: `//` is an aside to whoever is reading the
 * source, and `///` is what the declaration *means*, which the language server
 * hands back on hover and in completion. The split is the one C#, Rust and
 * Kotlin use, and it is the cheaper of the two for a program to write: a doc
 * comment is a run of whole lines, so adding, removing or moving one is a
 * line-level edit with no delimiters to balance and no continuation column to
 * keep aligned.
 *
 * The run also carries what `label { }` and `description { }` used to: a line
 * tagged with a language is that documentation in that language, and `@label`
 * is a display name. Those blocks still parse, and are folded in here so that
 * everything downstream -- hover, completion, the serialized AST -- reads one
 * shape whichever way a model was written.
 */
export class TontoDocumentationProvider extends JSDocDocumentationProvider {

    constructor(services: LangiumCoreServices) {
        super(services);
    }

    /** Everything the declaration says about itself, comments and blocks alike. */
    getStructured(node: AstNode): Documentation | undefined {
        const documentation = parseDocLines(docLinesAbove(node));
        foldInLegacyBlocks(node, documentation);
        return isEmpty(documentation) ? undefined : documentation;
    }

    /**
     * Only what the `///` lines say. The legacy blocks are left to the editor,
     * which shows them and offers their conversion; an export writes what the
     * model documents in the current form only.
     */
    getFromComments(node: AstNode): Documentation | undefined {
        const documentation = parseDocLines(docLinesAbove(node));
        return isEmpty(documentation) ? undefined : documentation;
    }

    override getDocumentation(node: AstNode): string | undefined {
        const documentation = this.getStructured(node);
        return documentation ? render(documentation) : super.getDocumentation(node);
    }
}

/**
 * `label { @en "Person" }` says what `/// @label:en Person` says.
 *
 * Read into the same record, and second: a conversion that has already been
 * made by hand takes precedence over the block it was made from.
 */
function foldInLegacyBlocks(node: AstNode, documentation: Documentation): void {
    const blocks = (node as Classifier).legacyText;
    if (!Array.isArray(blocks)) {
        return;
    }
    for (const block of blocks) {
        if (!isLegacyTextBlock(block)) {
            continue;
        }
        const into = block.kind === 'label' ? documentation.labels : documentation.descriptions;
        for (const item of block.items) {
            // `@en` with nothing after it yet: a half-written block says
            // nothing, and asking it for documentation is not an error.
            if (!item.language || !item.text) {
                continue;
            }
            const language = item.language.toLowerCase();
            const text = unquote(item.text);
            if (!(language in into) && text.length > 0) {
                into[language] = text;
            }
        }
    }
}

/** The grammar keeps a string's quotes; documentation is the text inside them. */
function unquote(text: string): string {
    return text.length >= 2 && (text.startsWith('"') || text.startsWith("'"))
        ? text.slice(1, -1).trim()
        : text.trim();
}

/**
 * The markdown a reader sees: the prose, then the names it goes by, then the
 * same documentation in each language it was written in.
 */
export function render(documentation: Documentation): string {
    const sections: string[] = [];
    if (documentation.text) {
        sections.push(documentation.text);
    }
    const labels = Object.entries(documentation.labels);
    if (labels.length > 0) {
        sections.push(labels.map(([language, text]) =>
            language ? `*${language}* ${text}` : text).join(' · '));
    }
    for (const [language, text] of Object.entries(documentation.descriptions)) {
        sections.push(`*${language}* — ${text}`);
    }
    if (documentation.namespace) {
        sections.push(`Namespace: \`${documentation.namespace}\``);
    }
    const published = [
        documentation.version && `Version: ${documentation.version}`,
        documentation.license && `License: ${documentation.license}`,
        documentation.creators.length > 0 && `Creators: ${documentation.creators.join(', ')}`
    ].filter((line): line is string => !!line);
    if (published.length > 0) {
        sections.push(published.join('  \n'));
    }
    return sections.join('\n\n');
}
