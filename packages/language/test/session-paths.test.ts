import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TontoSession } from '../src/api.js';
import { canonicalPath } from '../src/utils/paths.js';

/** A temporary folder, removed whatever the test does. */
async function inFolder(run: (root: string) => Promise<void>): Promise<void> {
    const root = canonicalPath(mkdtempSync(join(tmpdir(), 'tonto-session-')));
    try {
        await run(root);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

describe('one file under two spellings of its folder', () => {
    // The MCP server resolved the files it was given and not its workspace,
    // so under a linked folder each file was loaded beside itself.
    test('is one document, whichever spelling names the workspace', () => inFolder(async root => {
        const real = join(root, 'real');
        const link = join(root, 'link');
        mkdirSync(real);
        symlinkSync(real, link);
        writeFileSync(join(real, 'shop.tonto'), 'ontology shop\n\nkind Person\n');

        for (const [workspace, file] of [[link, real], [real, link]]) {
            const session = new TontoSession({ workspace });
            const reported = await session.validateFiles([join(file, 'shop.tonto')]);
            expect(reported.filter(one => one.severity === 'error')).toEqual([]);
            expect((await session.ontologies()).map(one => one.errors)).toEqual([0]);
        }
    }));
});

describe('a draft beside the files of a workspace', () => {
    test('does not fail on a file that has the draft\'s name', () => inFolder(async root => {
        writeFileSync(join(root, 'draft.tonto'), 'ontology a\n\nkind A\n');
        writeFileSync(join(root, 'draft-1.tonto'), 'ontology c\n\nkind C\n');
        writeFileSync(join(root, 'draft-2.tonto'), 'ontology d\n\nkind D\n');
        const session = new TontoSession({ workspace: root });
        expect(await session.validateText('ontology b\n\nkind B\n')).toEqual([]);
    }));

    // A repair is taken by the title validation gave it, and this one quoted
    // a name that counted the calls.
    test('offers a repair under the same title each time it is asked', async () => {
        const session = new TontoSession();
        const source = 'package sales\n\nkind A\n';
        const titles = async (): Promise<string[]> => (await session.validateText(source))
            .flatMap(one => one.fixes.map(fix => fix.title));
        const first = await titles();
        expect(await titles()).toEqual(first);
        const header = first.find(title => title.startsWith('Write "ontology'))!;
        const applied = await session.applyFix(source, 'package-without-ontology', header);
        expect(applied.left.filter(one => one.severity === 'error')).toEqual([]);
    });
});

describe('a remote location a URI spells with codes', () => {
    // "+" is "%2B" in a document's URI, so what was remembered under the
    // location as written -- its redirect -- was never found again, and the
    // bundle was looked for beside the address that redirects.
    test('resolves its bundle from where it was redirected to', () => inFolder(async root => {
        const hash = (source: string): string => createHash('sha256').update(source).digest('hex');
        const entry = (requested: string, effective: string, source: string): object =>
            ({ requested, mapped: requested, effective, retrieved: '2026-01-01T00:00:00.000Z', sha256: hash(source), source });
        const requested = 'https://example.org/a+b/shop.tonto';
        const pkg = 'https://cdn.example.net/x/core.tonto';
        mkdirSync(join(root, '.tonto'));
        writeFileSync(join(root, '.tonto', 'development.json'), JSON.stringify({ entries: {
            [requested]: entry(requested, 'https://cdn.example.net/x/shop.tonto',
                '/// @namespace https://example.org/shop#\nontology shop bundles\n    core from <core.tonto>\n'),
            [pkg]: entry(pkg, pkg, 'package core in shop\n\nkind Customer\n')
        } }));
        writeFileSync(join(root, 'tonto.json'), '{}');
        const mine = join(root, 'mine.tonto');
        writeFileSync(mine, `ontology mine\n\nimport shop from <${requested}>\n\nsubkind Preferred specializes shop.Customer\n`);

        const reported = await new TontoSession({ workspace: root }).validateFiles([mine]);
        expect(reported.filter(one => one.severity === 'error')).toEqual([]);
    }));
});

describe('the gUFO export of ontologies named alike but for case', () => {
    // One file on the file systems of macOS and Windows.
    test('gives them file names that differ without it', () => inFolder(async root => {
        writeFileSync(join(root, 'a.tonto'), 'ontology Shop\n\nkind A\n');
        writeFileSync(join(root, 'b.tonto'), 'ontology shop\n\nkind B\n');
        const result = await new TontoSession({ workspace: root }).gufoFiles([root]);
        const names = result.files.map(file => file.file.toLowerCase());
        expect(names).toHaveLength(2);
        expect(new Set(names).size).toBe(2);
    }));
});

describe('a repair to a file whose lines end "\\r\\n"', () => {
    test('writes its own lines the same way', () => inFolder(async root => {
        const file = join(root, 'shop.tonto');
        writeFileSync(file, 'ontology shop\r\n\r\nkind Person {\r\n    label { @en "Person" }\r\n    name: string\r\n}\r\n');
        const applied = await new TontoSession({ workspace: root }).fixFiles([file], new Set(['legacy-text-block']));
        expect(applied).toHaveLength(1);
        expect(readFileSync(file, 'utf8')).not.toMatch(/[^\r]\n/);
    }));
});
