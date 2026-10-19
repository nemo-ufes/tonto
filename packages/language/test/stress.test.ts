import { describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { URI } from 'langium';
import type { Diagnostic } from 'vscode-languageserver';
import { VirtualFileSystemProvider } from 'langium/test';
import { TontoSession } from '../src/api.js';
import { OntologySession } from './in-ontology.js';
import { createTontoServices } from '../src/tonto-module.js';

/**
 * What the language does when a model is large, deep, malformed, or written by
 * something that does not stop to look.
 *
 * The unit tests say each rule is right. These say the implementation survives
 * a model no one would write by hand: a thousand declarations, a chain two
 * hundred deep, a cycle, CRLF line endings, a file that ends mid-declaration.
 * Every bound here is generous -- they fail on a catastrophe, not on a
 * slowdown -- because a bound tight enough to measure performance is a test
 * that fails on someone else's laptop.
 */

const examplesDir = resolve(fileURLToPath(import.meta.url), '../fixtures/models');

function exampleFiles(directory = examplesDir): string[] {
    return readdirSync(directory).flatMap(entry => {
        const path = join(directory, entry);
        return statSync(path).isDirectory() ? exampleFiles(path) : (path.endsWith('.tonto') ? [path] : []);
    });
}

/** A model of `count` documented kinds, each with an attribute and a relation. */
function wideModel(count: number): string {
    const lines = ['package wide', 'datatype string', 'datatype date'];
    for (let index = 0; index < count; index++) {
        lines.push(
            `/// The ${index}th thing, and what it is for.`,
            `/// @label Thing ${index}`,
            `/// @pt-br A ${index}-ésima coisa.`,
            `kind Thing${index} {`,
            '    name: string',
            '    @begin startedAt: const date [0..1]',
            `    -- [0..*] Thing${(index + 1) % count}`,
            '}'
        );
    }
    return lines.join('\n') + '\n';
}

/** One kind and `depth` subkinds, each specializing the one before it. */
function deepModel(depth: number): string {
    const lines = ['package deep', 'kind Base0'];
    for (let index = 1; index <= depth; index++) {
        lines.push(`subkind Base${index} specializes Base${index - 1}`);
    }
    return lines.join('\n') + '\n';
}

describe('a model larger than anyone writes by hand', () => {
    const model = wideModel(300);

    test('parses and validates without blowing up', async () => {
        const session = new OntologySession();
        const started = Date.now();
        const diagnostics = await session.validateText(model);
        expect(Date.now() - started).toBeLessThan(60_000);
        // Nothing in it is wrong: the point is that nothing chokes.
        expect(diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    }, 120_000);

    test('the documentation of every declaration comes back', async () => {
        const session = new OntologySession();
        const ast = await session.astOf(model) as {
            packages: Array<{ declarations: Array<{ name: string; $documentation?: { text?: string; labels?: Record<string, string> } }> }>;
        };
        const documented = ast.packages[0].declarations.filter(declaration => declaration.$documentation);
        expect(documented).toHaveLength(300);
        expect(documented[7].$documentation?.labels).toEqual({ '': 'Thing 7' });
        expect(documented[7].$documentation?.text).toBe('The 7th thing, and what it is for.');
    }, 120_000);

    test('formatting is idempotent and does not change what it parses to', async () => {
        const session = new OntologySession();
        const once = await session.formatText(model);
        const twice = await session.formatText(once);
        expect(twice).toBe(once);
        expect(JSON.stringify(await session.astOf(once))).toBe(JSON.stringify(await session.astOf(model)));
    }, 120_000);
});

describe('a hierarchy deeper than any domain has', () => {
    test('two hundred levels of specialization still resolve', async () => {
        const session = new OntologySession();
        const diagnostics = await session.validateText(deepModel(200));
        expect(diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    }, 120_000);

    test('and a cycle in one is reported rather than followed', async () => {
        const session = new OntologySession();
        const cyclic = deepModel(60).replace('kind Base0', 'subkind Base0 specializes Base60');
        const diagnostics = await session.validateText(cyclic);
        expect(diagnostics.some(d => d.code === 'specialization-cycle')).toBe(true);
    }, 120_000);
});

describe('input written by something that does not stop to look', () => {
    const session = new OntologySession();

    test.each([
        ['an empty file', ''],
        ['whitespace only', '   \n\n\t\n'],
        ['a comment and nothing else', '/// documented nothing\n'],
        ['no trailing newline', 'package p\nkind Person'],
        ['a declaration cut off mid-word', 'package p\nkind Per'],
        ['a body left open', 'package p\nkind Person {\n    name: string'],
        ['a relation with no target', 'package p\nkind Person {\n    -- [1]\n}'],
        ['a stereotype and nothing else', 'package p\nkind Person {\n    @\n}'],
        ['unbalanced braces', 'package p\nkind A { kind B {'],
        ['only punctuation', '{}[]()<>--@,.'],
    ])('%s does not throw', async (_name, source) => {
        await expect(session.validateText(source)).resolves.toBeInstanceOf(Array);
        await expect(session.formatText(source)).resolves.toBeTypeOf('string');
        await expect(session.astOf(source)).resolves.toBeTruthy();
    });

    test('CRLF line endings document the same declarations', async () => {
        const source = ['package p', '/// A person.', '/// @label Person', 'kind Person'].join('\r\n');
        const ast = await session.astOf(source) as {
            packages: Array<{ declarations: Array<{ $documentation?: { text?: string; labels?: Record<string, string> } }> }>;
        };
        expect(ast.packages[0].declarations[0].$documentation).toEqual({
            text: 'A person.',
            labels: { '': 'Person' }
        });
    });

    test('a documentation run of ten thousand lines', async () => {
        const run = Array.from({ length: 10_000 }, (_, index) => `/// line ${index}`).join('\n');
        expect((await session.validateText(`package p\n${run}\nkind A\n`)).filter(d => d.severity === 'error')).toEqual([]);
    }, 60_000);

    test('a generalization set with five hundred specifics', async () => {
        const specifics = Array.from({ length: 500 }, (_, index) => `S${index}`);
        const source = [
            'package p',
            'kind Base',
            ...specifics.map(name => `subkind ${name} specializes Base`),
            `disjoint genset G where ${specifics.join(', ')} specializes Base`
        ].join('\n');
        expect((await session.validateText(source)).filter(d => d.severity === 'error')).toEqual([]);
    }, 60_000);

    test('five hundred packages in one file', async () => {
        const source = Array.from({ length: 500 }, (_, index) => `package p${index}\nkind K${index}`).join('\n');
        expect((await session.validateText(source)).filter(d => d.severity === 'error')).toEqual([]);
    }, 60_000);

    test('three hundred datatypes nested one inside the next', async () => {
        const source = [
            'package p',
            ...Array.from({ length: 300 }, (_, index) => `datatype D${index} {\n  next: D${index + 1}\n}`),
            'datatype D300'
        ].join('\n');
        expect((await session.validateText(source)).filter(d => d.severity === 'error')).toEqual([]);
    }, 60_000);

    test('a name may be written in the language the model is about', async () => {
        // `ID` was `[_a-zA-Z][\w...]*`, and `\w` without the `u` flag is
        // ASCII, so `kind Ação` was three tokens and a lexer error while
        // documentation in `pt-br` had been first class from the start.
        for (const source of ['package p\nkind Ação\n', 'package empresa\nkind Órgão\n', 'package p\nkind 日本語\n']) {
            expect((await session.validateText(source)).filter(d => d.severity === 'error'), source).toEqual([]);
        }
        // A script without case is not told to capitalize itself.
        expect((await session.validateText('package p\nkind 日本語\n')).map(d => d.code)).toEqual([]);
    });

    test('a very long line is not a problem', async () => {
        const long = 'x'.repeat(20_000);
        const diagnostics = await session.validateText(`package p\n/// ${long}\nkind Person\n`);
        expect(diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    });

    test('and neither is text that is not ASCII', async () => {
        const source = 'package p\n/// @pt-br Uma pessoa — açúcar, ção, 日本語, 🙂\nkind Person\n';
        expect((await session.validateText(source)).filter(d => d.severity === 'error')).toEqual([]);
        expect(await session.formatText(source)).toBe(source);
    });
});

describe('the fixer reaches a fixed point', () => {
    test('on a model that trips a dozen rules at once', async () => {
        const messy = [
            'package p',
            'datatype date',
            'kind Person {',
            '    label { @en "Person" }',
            '    description { @en "A human being." }',
            '    @begin birthDate: date',
            '}',
            'kind Place',
            'event Wedding {',
            '    -- [1] Place',
            '}',
            'relator Marriage {',
            '    @mediation [0..*] -- [2] Person',
            '}',
            'quality Weight {',
            '    @characterization -- [1] Person',
            '}'
        ].join('\n');
        const session = new OntologySession();
        const first = await session.fixText(messy);
        expect(first.applied.length).toBeGreaterThan(4);
        // Applying the fixes again changes nothing: every repair is settled.
        const second = await session.fixText(first.text);
        expect(second.text).toBe(first.text);
        expect(first.left.filter(d => d.severity === 'error')).toEqual([]);
        // The documentation survived the conversion, tag for tag.
        expect(first.text).toContain('/// @en A human being.');
        expect(first.text).toContain('/// @label:en Person');
    }, 120_000);

    test('and converting documentation preserves every language', async () => {
        const session = new OntologySession();
        const before = [
            'package p',
            'kind Person {',
            '    label { @en "Person" @pt-br "Pessoa" @de "Person" }',
            '    description { @en "A human being." @pt-br "Um ser humano." }',
            '}'
        ].join('\n');
        const after = (await session.fixText(before, 'draft', new Set(['legacy-text-block']))).text;
        const documentationOf = async (source: string): Promise<unknown> => {
            const ast = await session.astOf(source) as {
                packages: Array<{ declarations: Array<{ $documentation?: unknown }> }>;
            };
            return ast.packages[0].declarations[0].$documentation;
        };
        expect(await documentationOf(after)).toEqual(await documentationOf(before));
        expect(after).not.toContain('label {');
    }, 120_000);
});

describe('a workspace being edited, over and over', () => {
    test('fifty edits leave no stale answer behind', async () => {
        // Where cache bugs live: Langium re-links dependents without
        // re-parsing them, so anything remembered against a node outlives the
        // change that invalidated it. Flipping one supertype back and forth
        // fifty times says every derived answer is recomputed each time.
        const fileSystem = new VirtualFileSystemProvider();
        const services = createTontoServices({ fileSystemProvider: () => fileSystem });
        const workspace = services.shared.workspace;
        const baseUri = URI.file('/stress-base.tonto');
        const dependents = Array.from({ length: 20 }, (_, index) => URI.file(`/stress-${index}.tonto`));

        fileSystem.insert(baseUri, 'package base in stress\nkind Person\n');
        for (const [index, uri] of dependents.entries()) {
            fileSystem.insert(uri, `use base\npackage dep${index} in stress\nrole Student${index} specializes base.Person\n`);
        }
        await workspace.WorkspaceManager.initializeWorkspace([{ name: 'root', uri: URI.file('/').toString() }]);

        const errorsEverywhere = (): string[] => dependents.flatMap(uri =>
            (workspace.LangiumDocuments.getDocument(uri)?.diagnostics ?? [])
                .filter((diagnostic: Diagnostic) => diagnostic.severity === 1)
                .map((diagnostic: Diagnostic) => diagnostic.message));

        expect(errorsEverywhere()).toEqual([]);
        for (let round = 0; round < 25; round++) {
            // A category supplies no identity, so every dependent role loses
            // its ultimate sortal -- and gets it back when the kind returns.
            fileSystem.insert(baseUri, 'package base in stress\ncategory Person of objects\n');
            await workspace.DocumentBuilder.update([baseUri], []);
            expect(errorsEverywhere().length, `round ${round}, broken`).toBe(dependents.length);

            fileSystem.insert(baseUri, 'package base in stress\nkind Person\n');
            await workspace.DocumentBuilder.update([baseUri], []);
            expect(errorsEverywhere(), `round ${round}, restored`).toEqual([]);
        }
    }, 120_000);
});

describe('more than one session at a time', () => {
    test('each keeps its own view of the workspace', async () => {
        // The lookup that finds a generalization set in another document was
        // a module-level variable once, so the last session created owned it
        // and every earlier one silently stopped seeing cross-document
        // generalizations -- no error, just a check that had stopped checking.
        const root = mkdtempSync(join(tmpdir(), 'tonto-sessions-'));
        // Three files of one ontology, a draft of it since no entry is written.
        writeFileSync(join(root, 'base.tonto'), 'package base in sessions\nkind Person\nkind Organization\n');
        writeFileSync(join(root, 'dep.tonto'), 'use base\npackage dep in sessions\nrole Student specializes base.Person\n');
        writeFileSync(join(root, 'sets.tonto'),
            'use base\nuse dep\npackage sets in sessions\ngenset Odd where dep.Student specializes base.Organization\n');

        const first = new OntologySession({ workspace: root });
        const second = new OntologySession({ workspace: root });
        const codesOf = async (session: TontoSession): Promise<string[]> =>
            (await session.validateFiles([join(root, 'dep.tonto')])).map(diagnostic => diagnostic.code);

        // The set in the third file gives Student a second ultimate sortal.
        expect(await codesOf(second)).toContain('multiple-ultimate-sortals');
        expect(await codesOf(first)).toContain('multiple-ultimate-sortals');
    }, 60_000);
});

describe('files the workspace does not hold', () => {
    test('are read rather than answered about in silence', async () => {
        // `validateFiles` selected from the loaded documents, so a session
        // with no workspace -- or one whose workspace is elsewhere -- found
        // nothing loaded and returned no diagnostics, which reads exactly like
        // a model that holds.
        const root = mkdtempSync(join(tmpdir(), 'tonto-unloaded-'));
        const file = join(root, 'model.tonto');
        writeFileSync(file, 'package un\nkind A\nkind B specializes A\n');

        for (const session of [new OntologySession(), new OntologySession({ workspace: mkdtempSync(join(tmpdir(), 'tonto-elsewhere-')) })]) {
            expect((await session.validateFiles([file])).map(diagnostic => diagnostic.code))
                .toContain('stereotype-cannot-specialize');
        }
    }, 60_000);
});

describe('repairing a file the workspace does not hold', () => {
    test('writes it and reads it back', async () => {
        // A session with no workspace was given an empty file system, so the
        // repair was written to disk and re-reading it threw.
        const root = mkdtempSync(join(tmpdir(), 'tonto-repair-'));
        const file = join(root, 'model.tonto');
        writeFileSync(file, 'package rp\nkind carro\n');

        expect(await new OntologySession().fixFiles([file])).toEqual(['Rename to "Carro"']);
        expect(readFileSync(file, 'utf8')).toBe('package rp\nkind Carro\n');
    }, 60_000);
});

describe('two questions at once', () => {
    test('are two answers, not two drafts colliding', async () => {
        // A draft joins the workspace for as long as it takes to answer it.
        // Two at once were both in the store together, so each was reported
        // as a duplicate of the other -- an error about a file that exists
        // for a few milliseconds. A server holding one session for a client
        // that asks two things at once is the ordinary case.
        const session = new OntologySession();
        const source = 'package draft\nkind Person\n';
        const [first, second] = await Promise.all([
            session.validateText(source),
            session.validateText(source)
        ]);
        expect(first).toEqual([]);
        expect(second).toEqual([]);

        // And what each call answers is still its own.
        const [clean, repaired, broken] = await Promise.all([
            session.validateText(source),
            session.fixText('package draft\nkind carro\n'),
            session.validateText('package draft\nkind A\nkind B specializes A\n')
        ]);
        expect(clean).toEqual([]);
        expect(repaired.text).toBe('package draft\nkind Carro\n');
        expect(broken.map(diagnostic => diagnostic.code)).toEqual(['stereotype-cannot-specialize']);
    }, 60_000);
});

describe('the example corpus', () => {
    const files = exampleFiles();

    test('is not empty, or none of this proves anything', () => {
        expect(files.length).toBeGreaterThan(3);
    });

    // The corpus is stored formatted, so formatting it as it is asks the
    // formatter to do nothing -- which says nothing about whether it can lay
    // a model out. Its indentation flattened, or pushed two tabs deep, is a
    // model the formatter has to rebuild, and the stored file is the answer.
    // Spaces inside a line are not disturbed: the formatter leaves relation
    // notation as the author spaced it.
    const disturbed: Array<[string, (source: string) => string]> = [
        ['with no indentation', source => source.replace(/^[ \t]+/gm, '')],
        ['indented two tabs deep', source => source.replace(/^(?=[ \t]*\S)/gm, '\t\t')]
    ];

    test.each(files.map(path => [path.slice(examplesDir.length + 1), path]))(
        '%s is stored as the formatter lays it out, and is restored from bad indentation',
        async (_name, path) => {
            const session = new OntologySession();
            const source = readFileSync(path, 'utf8');
            expect(await session.formatText(source)).toBe(source);
            for (const [how, disturb] of disturbed) {
                expect(await session.formatText(disturb(source)), how).toBe(source);
            }
        },
        120_000
    );

    test('validates without an error, every file with its workspace', async () => {
        // Hints and warnings are the models' own business; an error is a
        // check that turned on a model the language has always accepted.
        const reported = await new TontoSession({ workspace: [examplesDir] }).validateFiles([examplesDir]);
        const errors = reported.filter(entry => entry.severity === 'error');
        expect(errors.map(entry => `${entry.file}:${entry.line} ${entry.code} ${entry.message}`)).toEqual([]);
        // The corpus has hints of its own, so silence would mean nothing was read.
        expect(reported.length).toBeGreaterThan(0);
    }, 120_000);
});
