import { describe, expect, test } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { AstNode } from 'langium';
import { docLinesAbove, parseDocLines } from '../src/documentation/doc-comment.js';
import { TontoSession } from '../src/api.js';
import type { Documentation } from '../src/documentation/doc-comment.js';

/**
 * The documentation reader, asked directly.
 *
 * Everything above it -- hover, completion, `$documentation`, the checks --
 * is one call into this, so the awkward cases are cheapest to pin here: what
 * counts as a tag, what a tag holds on to, and what is prose that merely looks
 * like one.
 */
function read(text: string): Documentation {
    return parseDocLines(text.split('\n').map((line, index) => ({ text: line, line: index })));
}

describe('what counts as a comment', () => {
    // The run is read off the lines, so a line that merely *begins* like a
    // comment had to be told from one that is a comment.
    const session = new TontoSession();

    const documentationOf = async (source: string, index: number): Promise<unknown> => {
        const ast = await session.astOf(source) as {
            packages: Array<{ declarations: Array<{ $documentation?: unknown }> }>;
        };
        return ast.packages[0].declarations[index].$documentation;
    };

    test('a line of a multi-line string is text, not documentation', async () => {
        expect(await documentationOf(
            'package p\ndatatype d\nkind K { label { @en "a\n/// pretend" } }\nkind Next\n', 2)).toBeUndefined();
    });

    test('and so is a line of a block comment', async () => {
        expect(await documentationOf('package p\n/* text\n/// pretend */\nkind Next\n', 0)).toBeUndefined();
    });

    test('while a real run is still read', async () => {
        expect(await documentationOf('package p\n/// real\nkind Next\n', 0)).toEqual({ text: 'real' });
    });
});

describe('reading a documentation run', () => {
    test('prose is what comes before the first tag', () => {
        const documentation = read('A person.\nStill about people.\n@en A person.');
        expect(documentation.text).toBe('A person.\nStill about people.');
        expect(documentation.descriptions).toEqual({ en: 'A person.' });
    });

    test('a language tag holds the untagged lines after it', () => {
        const documentation = read('@pt-br Uma pessoa.\nSegunda linha.\nTerceira.');
        expect(documentation.descriptions).toEqual({ 'pt-br': 'Uma pessoa.\nSegunda linha.\nTerceira.' });
        expect(documentation.text).toBeUndefined();
    });

    test('and lets go of them at the next tag', () => {
        const documentation = read('@pt-br Uma pessoa.\n@en A person.\nSecond line.');
        expect(documentation.descriptions).toEqual({
            'pt-br': 'Uma pessoa.',
            en: 'A person.\nSecond line.'
        });
    });

    test('a label is one line, and closes what was open', () => {
        // A name has no paragraphs, so the line after `@label` is not part of
        // it -- it goes back to the prose, which is what was open at the start.
        const documentation = read('@pt-br Uma pessoa.\n@label Person\nBack to prose.');
        expect(documentation.labels).toEqual({ '': 'Person' });
        expect(documentation.descriptions).toEqual({ 'pt-br': 'Uma pessoa.' });
        expect(documentation.text).toBe('Back to prose.');
    });

    test('a label may name its language', () => {
        expect(read('@label:pt-br Pessoa\n@label Person').labels).toEqual({ 'pt-br': 'Pessoa', '': 'Person' });
    });

    test('a language and a label in it are different things', () => {
        const documentation = read('@label:en Person\n@en A human being.');
        expect(documentation.labels).toEqual({ en: 'Person' });
        expect(documentation.descriptions).toEqual({ en: 'A human being.' });
    });

    test('the first writing wins, and the second is recorded as an entry', () => {
        const documentation = read('@en First.\n@en Second.');
        expect(documentation.descriptions).toEqual({ en: 'First.' });
        // Both are entries, which is how the duplicate is reported.
        expect(documentation.entries.map(entry => entry.text)).toEqual(['First.', 'Second.']);
        expect(documentation.entries[1].line).toBe(1);
    });

    test('a word that is not a language is prose, and is remembered as doubtful', () => {
        const documentation = read('@mediation is the stereotype to use.');
        expect(documentation.text).toBe('@mediation is the stereotype to use.');
        expect(documentation.descriptions).toEqual({});
        expect(documentation.unknownTags.map(unknown => unknown.tag)).toEqual(['mediation']);
    });

    test.each([
        ['a tag with no text', '@pt-br', { descriptions: {}, entries: 1 }],
        ['a bare "@"', '@', { descriptions: {}, entries: 0 }],
        ['an email address', 'write to a@b.com', { descriptions: {}, entries: 0 }],
        ['a tag mid-line', 'as in @en, the tag must start the line', { descriptions: {}, entries: 0 }]
    ])('%s', (_name, text, expected) => {
        const documentation = read(text);
        expect(documentation.descriptions).toEqual(expected.descriptions);
        expect(documentation.entries).toHaveLength(expected.entries);
    });

    test('case does not matter to a tag, and the key is lower case', () => {
        expect(read('@PT-BR Uma pessoa.\n@LABEL Person').descriptions).toEqual({ 'pt-br': 'Uma pessoa.' });
        expect(read('@PT-BR Uma pessoa.\n@LABEL Person').labels).toEqual({ '': 'Person' });
    });

    test('blank lines inside the run are paragraph breaks, and trailing ones go', () => {
        expect(read('First paragraph.\n\nSecond paragraph.\n\n').text)
            .toBe('First paragraph.\n\nSecond paragraph.');
    });

    test('a run with nothing in it says nothing', () => {
        const documentation = read('\n \n');
        expect(documentation.text).toBeUndefined();
        expect(documentation.entries).toEqual([]);
    });

    test('three or more letters is still a language; four is a word', () => {
        // `fr`, `eng` and `pt-br` are languages by shape; `note` is not, and
        // is left as the prose it is.
        expect(Object.keys(read('@fr Une personne.').descriptions)).toEqual(['fr']);
        expect(Object.keys(read('@eng A person.').descriptions)).toEqual(['eng']);
        expect(Object.keys(read('@note A person.').descriptions)).toEqual([]);
    });
});

describe('a document whose text is rewritten in place', () => {
    /**
     * What a language server does: the same `TextDocument` object is handed
     * back after every edit, with different contents in it. A reader that
     * remembered the object rather than the text answered about the file as
     * it was, which in an editor is the only state that is never on screen.
     */
    function nodeOver(text: string, line: number): { node: AstNode; textDocument: TextDocument } {
        const textDocument = TextDocument.create('file:///live.tonto', 'tonto', 1, text);
        const root = { $type: 'Model', $document: { textDocument } } as unknown as AstNode;
        const node = {
            $type: 'ClassDeclaration',
            $container: root,
            $cstNode: { range: { start: { line, character: 0 }, end: { line, character: 4 } } }
        } as unknown as AstNode;
        return { node, textDocument };
    }

    test('is read as it is now, not as it was', () => {
        const { node, textDocument } = nodeOver('package p\n/// first\nkind K\n', 2);
        expect(docLinesAbove(node).map(doc => doc.text)).toEqual(['first']);

        TextDocument.update(textDocument, [{ text: 'package p\n/// second\nkind K\n' }], 2);
        expect(docLinesAbove(node).map(doc => doc.text)).toEqual(['second']);
    });
});
