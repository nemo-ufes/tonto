import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { describe, expect, test } from 'vitest';
import { TontoSession } from '../src/api.js';
import { catalog as rules } from '../src/cli/rules.js';
import { catalog as patterns } from '../src/cli/patterns.js';
import { createTontoServices } from '../src/tonto-module.js';

/**
 * What the language server is asked while a model is being written.
 *
 * Every check here reads an AST the parser recovered from, where a name or a
 * reference the grammar calls mandatory is simply not there yet. Four
 * places assumed otherwise, and each one threw: the scope computation handed
 * an undefined package name to the index, which killed the build for the
 * whole file -- no scope, no diagnostics, an internal error where the missing
 * name should have been reported -- while the naming, import and
 * documentation checks threw one at a time and lost only themselves.
 *
 * The sweeps below are the protection: every prefix of every published model,
 * and every published model with one token deleted, which is what a document
 * looks like at each keystroke of writing it and each keystroke of fixing it.
 */

const session = new TontoSession({ antiPatterns: true });

async function models(): Promise<Array<[string, string]>> {
    const preamble = 'package repairs\ndatatype string\ndatatype date\ndatatype number\n';
    return [
        ...(await rules())
            .filter(rule => !rule.example.includes('// another file'))
            .map(rule => [`rule ${rule.code}`, `package repairs\n${rule.example}\n`] as [string, string]),
        ...(await patterns())
            .map(pattern => [`pattern ${pattern.name}`, `${preamble}${pattern.model}\n`] as [string, string])
    ];
}

/** Langium catches a check that throws and reports it as this. */
function internalErrors(diagnostics: Array<{ message: string }>): string[] {
    return diagnostics.map(one => one.message.split('\n')[0]).filter(message => /An error occurred/.test(message));
}

/** The cuts worth making: at every boundary, which is where a word ends. */
function boundaries(source: string): number[] {
    return [...source]
        .map((character, index) => (' \n{}[]()'.includes(character) ? index : -1))
        .filter(index => index >= 0)
        .concat(source.length);
}

describe('a document being typed', () => {
    test('every prefix of every published model is validated, not thrown on', async () => {
        const broken: string[] = [];
        let checked = 0;
        for (const [name, source] of await models()) {
            for (const cut of boundaries(source)) {
                checked++;
                try {
                    for (const message of internalErrors(await session.validateText(source.slice(0, cut)))) {
                        broken.push(`${name}@${cut}: ${message}`);
                    }
                } catch (error) {
                    broken.push(`${name}@${cut} threw: ${String(error).split('\n')[0]}`);
                }
            }
        }
        expect(broken.slice(0, 5)).toEqual([]);
        expect(checked).toBeGreaterThan(3000);
    }, 120_000);

    test('and so is every published model with one word deleted', async () => {
        // Which is the other half of it: a name is blank while it is being
        // typed, and blank again while it is being replaced.
        const broken: string[] = [];
        let checked = 0;
        for (const [name, source] of await models()) {
            for (const token of source.matchAll(/\S+/g)) {
                const mutant = source.slice(0, token.index) + source.slice(token.index + token[0].length);
                checked++;
                try {
                    for (const message of internalErrors(await session.validateText(mutant))) {
                        broken.push(`${name} without "${token[0]}": ${message}`);
                    }
                    await session.formatText(mutant);
                    await session.astOf(mutant);
                } catch (error) {
                    broken.push(`${name} without "${token[0]}" threw: ${String(error).split('\n')[0]}`);
                }
            }
        }
        expect(broken.slice(0, 5)).toEqual([]);
        expect(checked).toBeGreaterThan(2000);
    }, 120_000);

    test('and completion and formatting answer at every prefix', async () => {
        const { Tonto, shared } = createTontoServices(EmptyFileSystem);
        const parse = parseHelper(Tonto);
        const broken: string[] = [];
        let document = 0;
        for (const [name, source] of await models()) {
            for (const cut of boundaries(source)) {
                const text = source.slice(0, cut);
                const parsed = await parse(text, { documentUri: `file:///typed${document++}.tonto` });
                const lines = text.split('\n');
                try {
                    await Tonto.lsp.CompletionProvider?.getCompletion(parsed, {
                        textDocument: { uri: parsed.textDocument.uri },
                        position: { line: lines.length - 1, character: lines[lines.length - 1].length }
                    });
                    await Tonto.lsp.Formatter?.formatDocument(parsed, {
                        textDocument: { uri: parsed.textDocument.uri },
                        options: { tabSize: 4, insertSpaces: true }
                    });
                } catch (error) {
                    broken.push(`${name}@${cut}: ${String(error).split('\n')[0]}`);
                }
                shared.workspace.LangiumDocuments.deleteDocument(parsed.uri);
            }
        }
        expect(broken.slice(0, 5)).toEqual([]);
    }, 180_000);
});

describe('a package that has not been named yet', () => {
    test('is reported as that, and does not take the file down with it', async () => {
        const reported = await session.validateText('package\nkind person\n');
        expect(reported.map(one => one.code)).toContain('package-without-name');
        expect(reported.find(one => one.code === 'package-without-name')?.message)
            .toBe('This package has no name: write one after "package".');
        // The file is still a file: what it declares is still checked, which
        // is the point of the grammar taking a package without a name.
        expect(reported.map(one => one.code)).toContain('type-name-case');
    });

    test('and its declarations are still reachable from within it', async () => {
        const reported = await session.validateText('package\nkind Person\nrole Employee specializes Person\n');
        expect(reported.filter(one => one.code === 'linking-error' || one.code === 'parsing-error')).toEqual([]);
        expect(reported.map(one => one.code)).toEqual(['package-without-name', 'role-without-relator']);
    });

    test('while a named one is unaffected', async () => {
        const reported = await session.validateText('ontology p\nkind Person\n');
        expect(reported.map(one => one.code)).toEqual([]);
    });
});

describe('what a syntax error is reported as', () => {
    const session = new TontoSession();

    test('a parser or lexer error keeps its own code, not that of an unresolved name', async () => {
        const codes = (await session.validateText('package p\nkind % Person {\n')).map(one => one.code);
        expect(codes).toContain('lexing-error');
        expect(codes).toContain('parsing-error');
        expect(codes).not.toContain('linking-error');
    });

    test('names what fits by its first token, once, rather than every sequence', async () => {
        const messages = async (source: string): Promise<string[]> => (await session.validateText(source))
            .filter(one => one.code === 'parsing-error').map(one => one.message);
        // A relation stereotype on an attribute was answered with 189
        // sequences and five kilobytes.
        expect(await messages('package p\nquality W {\n  @characterization value: number\n}\n'))
            .toContain("Expecting '--', '<>--' or '--<>' but found `value`.");
        expect(await messages('package p\nkind Person {\n  -- [1...*] Person\n}\n'))
            .toContain("Expecting a number or '*' but found `.`.");
        expect(await messages('package p\nkind Person {\n  name: string\nkind Car\n'))
            .toContain("Expecting '}' but found `kind`.");
    });

    test('a legacy text block whose language the lexer took for a keyword is not a crash', async () => {
        const reported = await session.validateText('package p\nkind Person {\nlabel { @bringingAbout "Person" }\n}\n');
        expect(reported.filter(one => /error occurred/.test(one.message))).toEqual([]);
    });
});
