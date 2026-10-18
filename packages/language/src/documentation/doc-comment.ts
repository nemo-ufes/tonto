import { AstUtils } from 'langium';
import type { AstNode } from 'langium';
import type { Range } from 'vscode-languageserver';

const DOC_PREFIX = '///';

/**
 * A tag names a language when it has the shape of one: two or three letters,
 * then any number of subtags. Nothing else is a tag, so a line beginning
 * `@mediation` is prose, which is what a sentence about a stereotype needs.
 */
const LANGUAGE = /^[a-z]{2,3}(-[a-z0-9]+)*$/i;

const LABEL = 'label';

/**
 * The tags that describe an ontology, one line each, written above its
 * header: where its terms go, and what the exported header says of it.
 */
export const ONTOLOGY_TAGS = ['namespace', 'version', 'license', 'creator'] as const;
export type OntologyTag = typeof ONTOLOGY_TAGS[number];

/** What a `///` line turned out to be. */
export type EntryKind = 'label' | 'description' | OntologyTag;

export interface DocEntry {
    kind: EntryKind;
    /** Lower-cased language tag; `''` where none was written. */
    language: string;
    text: string;
    /** The line the tag was written on, for reporting on it. */
    line: number;
}

/** A line beginning with `@` that named no language and no known tag. */
export interface UnknownTag {
    tag: string;
    line: number;
}

/**
 * Everything a declaration's documentation says.
 *
 * `text` is the prose, in no declared language: a model whose author wrote in
 * Portuguese did not say so, and assuming English of it would be the kind of
 * guess that is silently wrong. A language is recorded only where one was
 * written.
 */
export interface Documentation {
    text?: string;
    /** Description by language tag. */
    descriptions: Record<string, string>;
    /** Display name by language tag; `''` is the one written with no language. */
    labels: Record<string, string>;
    /**
     * `@namespace <IRI>`: where a package's terms are published. Meaningful on
     * a package only, which `checkDocumentation` says elsewhere.
     */
    namespace?: string;
    /** `@version <text>`: the version of the ontology a package is published as. */
    version?: string;
    /** `@license <IRI or text>`: the terms it is published under. */
    license?: string;
    /** `@creator <name>`, one line per creator. */
    creators: string[];
    entries: DocEntry[];
    unknownTags: UnknownTag[];
}

export function isEmpty(documentation: Documentation): boolean {
    return documentation.text === undefined
        && Object.keys(documentation.descriptions).length === 0
        && Object.keys(documentation.labels).length === 0
        && documentation.namespace === undefined
        && documentation.version === undefined
        && documentation.license === undefined
        && documentation.creators.length === 0;
}

/**
 * A document's lines, and which of them begin inside a string or a block
 * comment.
 *
 * Both are done once per version, not once per lookup: every documented node
 * asks, and a large model asks a few hundred times while a single validation
 * runs. The second is what keeps a `///` that is not a comment from being read
 * as one -- a line of a multi-line string, or of a `/* ... *\/` block, is text
 * rather than documentation however it begins.
 */
interface Scanned {
    lines: string[];
    /** Line numbers whose first character is inside a string or a block comment. */
    quoted: Set<number>;
}

/**
 * Keyed on the `TextDocument`, and checked against the text it holds now.
 *
 * The identity is not enough on its own. A language server hands Langium the
 * same `TextDocument` object across an edit and rewrites its contents in
 * place, so a cache that trusted the key alone answered every question about
 * the text as it was before the edit -- documentation on hover, and the
 * diagnostics over it, both a keystroke behind for as long as the object
 * lived. Comparing the text costs nothing where it matches: `getText()` hands
 * back the same string it was given.
 */
const scanCache = new WeakMap<object, { text: string; scanned: Scanned }>();

function scan(text: string): Scanned {
    const lines = text.split(/\r?\n/);
    const quoted = new Set<number>();
    let state: 'code' | 'block' | '"' | "'" = 'code';
    let line = 0;
    for (let i = 0; i < text.length; i++) {
        const here = text[i];
        if (here === '\n') {
            line++;
            if (state !== 'code') {
                quoted.add(line);
            }
            continue;
        }
        if (state === 'code') {
            if (here === '"' || here === "'") {
                state = here;
            } else if (here === '/' && text[i + 1] === '*') {
                state = 'block';
                i++;
            } else if (here === '/' && text[i + 1] === '/') {
                // A line comment runs to the end of the line, and everything
                // in it is a comment -- which is the case this file is about.
                while (i < text.length && text[i] !== '\n') {
                    i++;
                }
                i--;
            }
        } else if (state === 'block') {
            if (here === '*' && text[i + 1] === '/') {
                state = 'code';
                i++;
            }
        } else if (here === state) {
            state = 'code';
        }
    }
    return { lines, quoted };
}

function scanned(node: AstNode): Scanned | undefined {
    const textDocument = AstUtils.getDocument(node)?.textDocument;
    if (!textDocument) {
        return undefined;
    }
    const text = textDocument.getText();
    let found = scanCache.get(textDocument);
    if (!found || found.text !== text) {
        found = { text, scanned: scan(text) };
        scanCache.set(textDocument, found);
    }
    return found.scanned;
}

function linesOf(node: AstNode): string[] | undefined {
    return scanned(node)?.lines;
}

/** One raw `///` line: the text after the slashes, and where it was written. */
interface DocLine {
    text: string;
    line: number;
}

/**
 * The `///` run directly above a node.
 *
 * "Immediately preceding" is meant literally: the run ends at the first line
 * that is not a `///` line, blank lines included. A blank line between the
 * prose and the declaration means the prose was about something else.
 */
export function docLinesAbove(node: AstNode): DocLine[] {
    const cstNode = node.$cstNode;
    const source = cstNode && scanned(node);
    if (!cstNode || !source || !ownsItsLine(node)) {
        return [];
    }
    const { lines, quoted } = source;
    const collected: DocLine[] = [];
    for (let line = cstNode.range.start.line - 1; line >= 0; line--) {
        const text = lines[line]?.trim() ?? '';
        // A line inside a string or a block comment is text, whatever it
        // begins with.
        if (!text.startsWith(DOC_PREFIX) || quoted.has(line)) {
            break;
        }
        // One space after the slashes is the separator, not indentation.
        collected.unshift({ text: text.slice(DOC_PREFIX.length).replace(/^ /, ''), line });
    }
    return collected;
}

/**
 * Whether a run above this node is this node's, rather than something's
 * enclosing it on the same line.
 *
 * A run documents the outermost declaration that begins below it: `enum
 * Color { Red, Green }` is one declaration with a label, not three, and `kind
 * Car { name: string }` does not hand the car's label to its attribute. The
 * model itself is never documented -- it begins wherever its first
 * declaration does, which is that declaration's run, not the file's.
 */
function ownsItsLine(node: AstNode): boolean {
    const container = node.$container;
    // A one-file ontology's declarations are a package without a header of
    // its own: it begins where its first declaration does, so the run above
    // is that declaration's, and the package is never documented.
    if (!container || node.$type === 'OntologyBody') {
        return false;
    }
    if (container.$type === 'OntologyBody') {
        return true;
    }
    // Containment nests, so the direct container is the one to ask: anything
    // further out that begins on this line encloses the container too.
    return !container.$container
        || container.$cstNode?.range.start.line !== node.$cstNode?.range.start.line;
}

/** The full line a documentation entry was written on, for a diagnostic. */
export function lineRange(node: AstNode, line: number): Range | undefined {
    const lines = linesOf(node);
    return lines?.[line] === undefined
        ? undefined
        : { start: { line, character: 0 }, end: { line, character: lines[line].length } };
}

const TAG = /^@([A-Za-z][\w-]*)(?::([A-Za-z][\w-]*))?(?:[ \t]+(.*))?$/;

/**
 * Reads a run of `///` lines.
 *
 * Prose runs until the first tag. `@pt-br` opens the same documentation in
 * that language and stays open over the untagged lines that follow, so a
 * translation is written the way the original is. `@label` is a display name,
 * which is one line by construction -- a name does not have paragraphs -- so
 * it closes whatever was open and the prose resumes.
 */
export function parseDocLines(lines: readonly DocLine[]): Documentation {
    const documentation: Documentation = { descriptions: {}, labels: {}, creators: [], entries: [], unknownTags: [] };
    const prose: string[] = [];
    let open: DocEntry | undefined;
    const collected: string[] = [];

    const close = (): void => {
        if (open) {
            open.text = collected.join('\n').trim();
            documentation.entries.push(open);
            collected.length = 0;
            open = undefined;
        }
    };

    for (const { text, line } of lines) {
        const match = TAG.exec(text);
        const name = match?.[1];
        const qualifier = match?.[2];
        const rest = match?.[3] ?? '';

        if (name && name.toLowerCase() === LABEL) {
            close();
            documentation.entries.push({
                kind: 'label',
                language: (qualifier ?? '').toLowerCase(),
                text: rest.trim(),
                line
            });
            continue;
        }
        const packageTag = name && !qualifier
            ? ONTOLOGY_TAGS.find(tag => tag === name.toLowerCase())
            : undefined;
        if (packageTag) {
            // One line, like a label: an IRI, a version or a name has no
            // paragraphs.
            close();
            documentation.entries.push({ kind: packageTag, language: '', text: rest.trim(), line });
            continue;
        }
        if (name && !qualifier && LANGUAGE.test(name)) {
            close();
            open = { kind: 'description', language: name.toLowerCase(), text: '', line };
            collected.push(rest);
            continue;
        }
        if (name) {
            // Not a tag, so it is prose -- but prose that looks like a tag is
            // worth a second look, which `checkDocumentationTags` gives it.
            documentation.unknownTags.push({ tag: name, line });
        }
        (open ? collected : prose).push(text);
    }
    close();

    const text = prose.join('\n').trim();
    if (text.length > 0) {
        documentation.text = text;
    }
    for (const entry of documentation.entries) {
        const text = entry.text.length > 0 ? entry.text : undefined;
        if (entry.kind === 'namespace' || entry.kind === 'version' || entry.kind === 'license') {
            // The first is used; `checkOntologyTags` reports a second.
            documentation[entry.kind] ??= text;
            continue;
        }
        if (entry.kind === 'creator') {
            if (text && !documentation.creators.includes(text)) documentation.creators.push(text);
            continue;
        }
        const into = entry.kind === 'label' ? documentation.labels : documentation.descriptions;
        // First writing wins; a second is reported rather than silently used.
        if (!(entry.language in into) && entry.text.length > 0) {
            into[entry.language] = entry.text;
        }
    }
    return documentation;
}
