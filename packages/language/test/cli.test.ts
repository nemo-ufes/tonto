import { describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { explainText, run } from '../src/cli/index.js';
import { SAMPLE } from '../src/cli/guide.js';
import { inOntologyInPlace } from './in-ontology.js';
import { canonicalPath } from '../src/utils/paths.js';

/** Captures whatever the command writes, and its exit code. */
async function tonto(...argv: string[]): Promise<{ code: number; out: string }> {
    const written: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
        written.push(String(chunk));
        return true;
    };
    try {
        const code = await run(argv);
        return { code, out: written.join('') };
    } finally {
        process.stdout.write = write;
    }
}

function project(source: string): string {
    const directory = canonicalPath(mkdtempSync(join(tmpdir(), 'tonto-cli-')));
    writeFileSync(join(directory, 'model.tonto'), inOntologyInPlace(source));
    return directory;
}

describe('the command-line interface', () => {
    test('publication checking/export and explicit fetch are available without network dependencies', async () => {
        const directory = project('/// @namespace https://example.org/people#\nontology people\nkind Person');
        const fetched = await tonto('fetch', directory, `--workspace=${directory}`, '--publication', '--json');
        expect(fetched.code).toBe(0);
        expect(JSON.parse(fetched.out)).toEqual({ retrieved: [], cached: [], added: [], changed: [], removed: [] });
        expect((await tonto('check', directory, `--workspace=${directory}`, '--publication', '--json')).code).toBe(0);
        const exported = await tonto('gufo', directory, `--workspace=${directory}`, '--publication', '--json');
        expect(exported.code).toBe(0);
        expect(JSON.parse(exported.out).publicationVerified).toBe(true);
    });

    test('reports nothing and exits zero on a model that holds', async () => {
        const { code, out } = await tonto('check', project('package ok\nkind Person\n'));
        expect(out).toContain('0 error');
        expect(code).toBe(0);
    });

    test('with no path at all, checks the working directory', async () => {
        // The files were found and the workspace was not, so the session
        // loaded nothing and the summary said `0 error` about a model with
        // one -- a silence indistinguishable from a clean bill of health.
        const directory = project('package cwd\nkind A\nkind B specializes A\n');
        const was = process.cwd();
        process.chdir(directory);
        try {
            const { code, out } = await tonto('check');
            expect(out).toContain('stereotype-cannot-specialize');
            expect(out).toContain('1 file: 1 error');
            expect(code).toBe(1);
        } finally {
            process.chdir(was);
        }
    });

    test('exits non-zero when something is an error', async () => {
        const { code, out } = await tonto('check', project('package bad\nkind A\nkind B specializes A\n'));
        expect(out).toContain('stereotype-cannot-specialize');
        expect(code).toBe(1);
    });

    test('--fix= says which code no rule has, rather than repairing nothing', async () => {
        // Repairing nothing is what a model with nothing to repair looks like,
        // so a typo in the code read as a clean run.
        const directory = project('package ty\nkind carro\n');
        const wrong = await tonto('check', directory, '--fix=type-name-cas');
        expect(wrong.code).toBe(2);
        expect(readFileSync(join(directory, 'model.tonto'), 'utf8')).toContain('kind carro');
        expect((await tonto('check', directory, '--fix=')).code).toBe(2);

        const right = await tonto('check', directory, '--fix=type-name-case');
        expect(right.out).toContain('1 repaired');
    });

    test('--isolated checks the file and not its neighbors', async () => {
        // It loaded the directory each named file sits in, which is the
        // model, not the file: an isolated check still reported what the
        // file beside it declares.
        // Two files of one ontology, a draft of it since no entry is written.
        const directory = project('package dup in shop\nkind Person\n');
        writeFileSync(join(directory, 'other.tonto'), 'package dup in shop\nkind Other\n');
        const file = join(directory, 'model.tonto');

        expect((await tonto('check', file, '--isolated')).out).toContain('0 error');
        expect((await tonto('check', file)).out).toContain('duplicate-package-across-files');
    });

    test('--workspace names that directory, and not one above it', async () => {
        // It was passed through `workspaceRootOf`, which walks up while the parent
        // still holds `.tonto` files -- so naming a directory could load a
        // tree far above it, and in a crowded parent (a temp directory, say)
        // that is a great deal of unrelated model.
        const directory = project('package ws\nkind Person\n');
        const nested = join(directory, 'inner');
        mkdirSync(nested);
        writeFileSync(join(nested, 'inner.tonto'), 'package inner\nkind Thing\n');

        const { out } = await tonto('check', nested, `--workspace=${nested}`, '--json');
        expect(JSON.parse(out).summary.files).toBe(1);
    });

    test('--json carries the code, the position and every repair', async () => {
        const { out } = await tonto('check', project('package js\nkind carro\n'), '--json');
        const { diagnostics, summary } = JSON.parse(out);
        expect(summary).toMatchObject({ files: 1, warning: 1 });
        expect(diagnostics[0]).toMatchObject({ line: 2, column: 6, severity: 'warning', code: 'type-name-case' });
        expect(diagnostics[0].fixes[0].title).toContain('Carro');
        expect(diagnostics[0].fixes[0].changes[0].edits[0].newText).toBe('Carro');
    });

    test('--fix applies a repair the rule forces, and leaves one that decides', async () => {
        // Two diagnostics, one repair each. Capitalizing a name is how the
        // model is written; dropping `isPowerType` from a type that
        // classifies nothing is a choice between that and writing the
        // instantiation nobody has written yet.
        const directory = project('ontology fx\nkind carro\ntype T isPowerType\n');
        const { out } = await tonto('check', directory, '--fix');
        expect(out).toContain('1 repaired');
        expect(readFileSync(join(directory, 'model.tonto'), 'utf8'))
            .toBe('ontology fx\nkind Carro\ntype T isPowerType\n');

        // Named, it is applied: naming a rule is choosing.
        await tonto('check', directory, '--fix=powertype-without-base');
        expect(readFileSync(join(directory, 'model.tonto'), 'utf8'))
            .toBe('ontology fx\nkind Carro\ntype T\n');
    });

    test('and leaves a choice alone', async () => {
        // Two diamonds are both admissible, so only the modeler can pick.
        const source = 'ontology ch\nkind Car\nkind Wheel\n@componenthood relation Car [1] -- [4] Wheel\n';
        const directory = project(source);
        const { out } = await tonto('check', directory, '--fix');
        expect(out).toContain('parthood-without-diamond');
        expect(readFileSync(join(directory, 'model.tonto'), 'utf8')).toBe(source);
    });

    test('the anti-patterns stay off unless asked for', async () => {
        const source = 'package ap\nkind Person\nrole Employee specializes Person\n'
            + 'relation Employee [0..*] -- reportsTo -- [0..*] Employee\n';
        expect((await tonto('check', project(source))).out).not.toContain('BinOver');
        expect((await tonto('check', project(source), '--anti-patterns')).out).toContain('BinOver');
    });

    test('tables prints what the checks consult', async () => {
        const { code, out } = await tonto('tables');
        const tables = JSON.parse(out);
        expect(code).toBe(0);
        expect(tables.relationEnds.membership).toContain('collective:functional-complex');
        expect(tables.classStereotypes.abstractum.natures).toEqual(['abstract-individuals']);
        // A process's parts are processes; what it gains from events is its
        // constitution, which is a different table entry.
        expect(tables.parthoodPairs).toContain('process:process');
        expect(tables.parthoodPairs).not.toContain('process:event');
        expect(tables.relationEnds.constitution).toContain('process:event');
    });

    test('the guide is generated from the tables, so it cannot drift', async () => {
        const { out } = await tonto('guide');
        expect(out).toContain('@membership           collective → substantial');
        expect(out).toContain('@instantiation        anything → type');
        expect(out).toContain('abstractum (abstract-individuals)');
        expect(out).toContain('@constitution');
        // A process's parts are processes, so the crossing list is the
        // collective's alone.
        expect(out).toContain('collective → functional-complex');
        expect(out).not.toContain('process → event');
    });

    test('and its worked example validates', async () => {
        // The first tonto anyone reads. Documentation that does not parse is
        // worse than none.
        const { code, out } = await tonto('check', project(SAMPLE));
        expect(out).toContain('0 error, 0 warning, 0 information, 0 hint');
        expect(code).toBe(0);
    });

    test('rules takes a code, and refuses one it does not have', async () => {
        const { out } = await tonto('rules', 'parthood-crosses-natures');
        expect(out).toContain('parthood-crosses-natures  [Relations, error]');
        expect(out).not.toContain('type-name-case');

        const written: string[] = [];
        const write = process.stderr.write.bind(process.stderr);
        process.stderr.write = (chunk: string | Uint8Array): boolean => (written.push(String(chunk)), true);
        try {
            expect(await run(['rules', 'nope'])).toBe(2);
        } finally {
            process.stderr.write = write;
        }
        expect(written.join('')).toContain('no rule "nope"');
    });

    test('check reads a model from stdin', async () => {
        const restore = process.stdin;
        Object.defineProperty(process, 'stdin', {
            value: Readable.from([Buffer.from('ontology p\nkind carro\n')]), configurable: true
        });
        try {
            const { code, out } = await tonto('check', '-');
            expect(out).toContain('-:2:6');
            expect(out).toContain('type-name-case');
            expect(code).toBe(0);
        } finally {
            Object.defineProperty(process, 'stdin', { value: restore, configurable: true });
        }
    });

    /** Runs a command with `source` on stdin, restoring the real one after. */
    async function piped(source: string, ...argv: string[]): Promise<{ code: number; out: string }> {
        const restore = process.stdin;
        Object.defineProperty(process, 'stdin', {
            value: Readable.from([Buffer.from(inOntologyInPlace(source))]), configurable: true
        });
        try {
            return await tonto(...argv);
        } finally {
            Object.defineProperty(process, 'stdin', { value: restore, configurable: true });
        }
    }

    test('a draft on stdin resolves its imports against the workspace', async () => {
        // The case `--workspace` exists for: a draft with no file of its own,
        // so nothing else can say which model its imports belong to. The flag
        // was read on the path form and ignored here, which answered a
        // resolvable import with a linking error.
        const directory = project('package base in school\nkind Person\n');
        const draft = 'use base\npackage draft in school\nrole Student specializes base.Person\n';
        const { code, out } = await piped(draft, 'check', '-', `--workspace=${directory}`);
        expect(out).not.toContain('linking-error');
        expect(out).not.toContain('parsing-error');
        expect(code).toBe(0);
    });

    test('and --fix still exits 1 on an error it could not repair', async () => {
        // Repairing a model does not make an error no repair answers go away.
        const broken = 'package p\nkind A\nkind B specializes A\n';
        expect((await piped(broken, 'check', '-')).code).toBe(1);
        expect((await piped(broken, 'check', '-', '--fix')).code).toBe(1);
        expect((await piped('package p\nkind A\n', 'check', '-', '--fix')).code).toBe(0);
    });

    test('stdin --fix --json returns the repaired model inside one JSON value', async () => {
        const { code, out } = await piped('ontology fx\nkind carro\n', 'check', '-', '--fix', '--json');
        const result = JSON.parse(out);
        expect(code).toBe(0);
        expect(result.text).toBe('ontology fx\nkind Carro\n');
        expect(result.diagnostics).toEqual([]);
        expect(result.summary).toMatchObject({ files: 1, error: 0, warning: 0 });
    });

    test('help after a command is the usage, not a file to read', async () => {
        for (const command of ['format', 'check', 'gufo']) {
            const { code, out } = await tonto(command, '--help');
            expect(code).toBe(0);
            expect(out).toContain('tonto check [paths...]');
        }
    });

    test('format lays a model out canonically', async () => {
        const directory = project('ontology p\n  kind   Person{name:String}\ndatatype String\n');
        const { out } = await tonto('format', join(directory, 'model.tonto'));
        expect(out).toBe('ontology p\nkind Person {\n    name: String\n}\ndatatype String\n');
    });

    test('ast prints the parsed model', async () => {
        const directory = project('package p\nkind Person\n');
        const { out } = await tonto('ast', join(directory, 'model.tonto'));
        const model = JSON.parse(out);
        expect(model.packages[0].declarations[0]).toMatchObject({ stereotype: 'kind', name: 'Person' });
    });

    test('gufo writes Turtle or an atomic output file', async () => {
        const directory = project('package p\nkind Person\n');
        const direct = await tonto('gufo', directory, '--namespace-iri=https://example.org/model#');
        expect(direct.code).toBe(0);
        expect(direct.out).toContain('<https://example.org/model> a owl:Ontology');
        expect(direct.out).toContain('p:Person a owl:Class, gufo:Kind');

        const output = join(directory, 'model.ttl');
        const written = await tonto('gufo', directory, '--namespace-iri=https://example.org/model#', `--out=${output}`, '--json');
        expect(written.code).toBe(0);
        expect(JSON.parse(written.out).output).toBe(output);
        expect(readFileSync(output, 'utf8')).toBe(direct.out);
    });

    test('gufo accepts an exact namespace for one ontology whose header has none', async () => {
        const directory = project('package conferences\nkind Person\n');
        const result = await tonto('gufo', directory,
            '--namespace-iri=http://nemo.inf.ufes.br/jpalmeida/conferences#');
        expect(result.code).toBe(0);
        expect(result.out).toContain('<http://nemo.inf.ufes.br/jpalmeida/conferences> a owl:Ontology');
        expect(result.out).toContain('@prefix conferences: <http://nemo.inf.ufes.br/jpalmeida/conferences#>');
        expect(result.err ?? '').not.toContain('gufo-placeholder-namespace');
    });

    test('gufo writes the direct specializations only when asked', async () => {
        const directory = project('package p\nkind Person\nclass Agentive of functional-complexes specializes Person\nsubkind Worker specializes Agentive\n');
        const plain = await tonto('gufo', directory, '--namespace-iri=https://example.org/model#');
        const asked = await tonto('gufo', directory, '--namespace-iri=https://example.org/model#', '--direct-specializations');
        expect(plain.code).toBe(0);
        expect(asked.code).toBe(0);
        // Within the block about Worker, which ends at a blank line.
        expect(plain.out).not.toMatch(/p:Worker a(?:(?!\n\n)[\s\S])*rdfs:subClassOf[^;.]*p:Person/);
        expect(asked.out).toMatch(/p:Worker a(?:(?!\n\n)[\s\S])*rdfs:subClassOf p:Agentive, p:Person/);
    });

    test('gufo writes an ontology of several packages as one document', async () => {
        const directory = project('ontology model\npackage p\nkind Person\npackage q\nkind Car\n');
        const plain = await tonto('gufo', directory, '--namespace-iri=https://example.org/model#');
        expect(plain.code).toBe(0);
        expect(plain.out).toContain('model:Car a owl:Class');
        const output = join(directory, 'out');
        const written = await tonto('gufo', directory, '--namespace-iri=https://example.org/model#', `--out-dir=${output}`, '--json');
        expect(written.code).toBe(0);
        expect(JSON.parse(written.out).outputs.map((entry: { path: string }) => basename(entry.path)))
            .toEqual(['model.ttl']);
        expect(readFileSync(join(output, 'model.ttl'), 'utf8')).toContain('<https://example.org/model> a owl:Ontology');
    });

    test('gufo --write puts each ontology beside its ontology file, whichever of its files was named', async () => {
        const directory = canonicalPath(realpathSync(mkdtempSync(join(tmpdir(), 'tonto-cli-'))));
        mkdirSync(join(directory, 'parts'));
        writeFileSync(join(directory, 'shop.tonto'), '/// @namespace https://example.org/shop#\nontology shop bundles\n    core from <parts/core.tonto>\n');
        writeFileSync(join(directory, 'parts', 'core.tonto'), 'package core in shop\nkind Person\n');
        writeFileSync(join(directory, 'people.tonto'), '/// @namespace https://example.org/people#\nontology people\nkind Human\n');
        const written = await tonto('gufo', join(directory, 'parts', 'core.tonto'), '--write', '--json');
        expect(written.code).toBe(0);
        expect(JSON.parse(written.out).outputs.map((entry: { path: string }) => entry.path)).toEqual([join(directory, 'shop.ttl')]);
        expect(readFileSync(join(directory, 'shop.ttl'), 'utf8')).toContain('<https://example.org/shop> a owl:Ontology');
        const both = await tonto('gufo', directory, '--write', '--json');
        expect(JSON.parse(both.out).outputs.map((entry: { path: string }) => entry.path).sort())
            .toEqual([join(directory, 'people.ttl'), join(directory, 'shop.ttl')]);
        expect((await tonto('gufo', directory, '--write', `--out-dir=${directory}`)).code).toBe(2);
    });

    test('ontologies lists what the workspace authors', async () => {
        const directory = canonicalPath(mkdtempSync(join(tmpdir(), 'tonto-cli-')));
        writeFileSync(join(directory, 'shop.tonto'), '/// @namespace https://example.org/shop#\nontology shop\nkind Product\n');
        writeFileSync(join(directory, 'people.tonto'), 'ontology people\nkind Human\n');
        const listed = await tonto('ontologies', directory, '--json');
        expect(listed.code).toBe(0);
        expect(JSON.parse(listed.out).map((ontology: { name: string; namespace?: string }) => [ontology.name, ontology.namespace]))
            .toEqual([['people', undefined], ['shop', 'https://example.org/shop#']]);
    });

    test('gufo --snapshot writes each ontology\'s snapshot module beside it', async () => {
        const directory = project('package p\nkind Person {\nname: string\n}\n');
        const output = join(directory, 'out');
        const written = await tonto('gufo', directory, '--namespace-iri=https://example.org/model#', '--snapshot',
            `--out-dir=${output}`, '--json');
        expect(written.code).toBe(0);
        expect(JSON.parse(written.out).outputs.map((entry: { path: string }) => basename(entry.path)))
            .toEqual(['p.ttl', 'p.snapshot.ttl', 'p.shapes.ttl']);
        expect(readFileSync(join(output, 'p.snapshot.ttl'), 'utf8'))
            .toContain('owl:imports <https://example.org/model>');
    });

    test('and carries the documentation, which is a hidden token otherwise', async () => {
        const directory = project('package p\n/// Someone who buys, or could.\n/// Identity is their own.\nkind Person\nkind Plain\n');
        const { out } = await tonto('ast', join(directory, 'model.tonto'));
        const declarations = JSON.parse(out).packages[0].declarations;
        expect(declarations[0].$documentation).toEqual({
            text: 'Someone who buys, or could.\nIdentity is their own.'
        });
        expect(declarations[1]).not.toHaveProperty('$documentation');
    });

    test('--fix takes codes, so one repair does not drag the others in', async () => {
        const directory = project('package p\nkind Person {\nlabel { @en "Person" }\n}\nkind Place\nevent Wedding {\n-- [1] Place\n}\n');
        const { out } = await tonto('check', join(directory, 'model.tonto'), '--fix=legacy-text-block');
        expect(out).toContain('1 repaired');
        const written = readFileSync(join(directory, 'model.tonto'), 'utf8');
        expect(written).toContain('/// @label:en Person');
        // The immutable end is still unmarked: it was not asked for.
        expect(written).toContain('-- [1] Place');
        expect(written).not.toContain('{const}');
    });

    test('a file is checked as part of the model it belongs to', async () => {
        // Half the checks read what points at a class, and that is usually
        // written in another file: `Student` has a relator, one directory up.
        const directory = project('package base in school\nkind Person\n');
        mkdirSync(join(directory, 'sub'));
        writeFileSync(join(directory, 'sub', 'roles.tonto'),
            'use base\npackage roles in school\nrole Student specializes base.Person\n'
            + 'relator Enrollment {\n@mediation [1..*] -- [1] (const) Student\n'
            + '@mediation [0..*] -- [1] (const) base.Person\n}\n');
        const one = await tonto('check', join(directory, 'sub', 'roles.tonto'), '--json');
        expect(JSON.parse(one.out).summary).toMatchObject({ files: 1, error: 0, hint: 0 });

        // And `--isolated` asks for the file alone, where the supertype is out
        // of reach and the model looks broken.
        const alone = await tonto('check', join(directory, 'sub', 'roles.tonto'), '--isolated', '--json');
        expect(JSON.parse(alone.out).summary.error).toBeGreaterThan(0);
    });

    test.each(['check', 'format', 'ast'])('%s says so when a path is not there', async command => {
        // It used to reach the terminal as a Node stack trace, which is noise
        // for a person and unparseable for an agent expecting a diagnostic.
        const written: string[] = [];
        const write = process.stderr.write.bind(process.stderr);
        process.stderr.write = (chunk: string | Uint8Array): boolean => (written.push(String(chunk)), true);
        try {
            expect(await run([command, join(tmpdir(), 'tonto-nothing-here.tonto')])).toBe(2);
        } finally {
            process.stderr.write = write;
        }
        expect(written.join('')).toContain('cannot read');
    });

    test('explain refuses a word that is not a nature, rather than answering "no"', async () => {
        // "kind" is a stereotype. Passed where a nature belongs, it was not
        // found in the table and the answer came back as a fact about
        // mediation rather than a question that could not be read.
        expect((await tonto('explain', '@mediation', 'relator', 'kind')).code).toBe(2);
        expect((await tonto('explain', '@mediation', 'relator', 'functional-complex')).code).toBe(0);
    });

    test('and answers without printing, which is what the MCP server needs', async () => {
        // That server speaks its protocol over stdout, so an answer collected
        // by borrowing the stream swallowed whatever the transport wrote.
        const written: string[] = [];
        const write = process.stdout.write.bind(process.stdout);
        process.stdout.write = (chunk: string | Uint8Array): boolean => (written.push(String(chunk)), true);
        try {
            expect((await explainText(['subkind', 'kind'])).text).toContain('Yes');
        } finally {
            process.stdout.write = write;
        }
        expect(written).toEqual([]);
    });

    test('explain answers from the tables, and its exit code is the answer', async () => {
        expect(await tonto('explain', 'subkind', 'kind')).toMatchObject({ code: 0 });
        const refused = await tonto('explain', 'phase', 'role');
        expect(refused.code).toBe(1);
        expect(refused.out).toContain('intrinsic condition cannot narrow one that depends on something else');

        const association = await tonto('explain', '@membership', 'functional-complexes', 'collectives');
        expect(association.code).toBe(1);
        // A functional complex is at neither end of a membership as its
        // whole, so what it runs from is the answer.
        expect(association.out).toContain('It runs from collective.');
        expect((await tonto('explain', '@membership', 'collectives', 'quantities')).code).toBe(0);
    });

    test('and it answers by the pairs, not by the two margins', async () => {
        // What may bear an extrinsic mode is narrower than what may bear a
        // quality, so the union of the firsts and the union of the seconds
        // says something the table denies: that an extrinsic mode may inhere
        // in a process.
        const refused = await tonto('explain', '@characterization', 'extrinsic-mode', 'process');
        expect(refused.code).toBe(1);
        const reaches = refused.out.split('\n').find(line => line.includes('it runs to')) ?? '';
        expect(reaches).toContain('From an extrinsic-mode it runs to');
        expect(reaches).not.toContain('process');
        expect((await tonto('explain', '@characterization', 'quality', 'process')).code).toBe(0);

        // And the listing keeps the two apart.
        const listed = await tonto('explain', '@characterization');
        expect(listed.out).toMatch(/from extrinsic-mode\n\s+to [^\n]*(?<!process)\n/);
        expect(listed.out).toContain('from intrinsic-mode, quality');
    });

    test('an unknown option is refused rather than ignored', async () => {
        const written: string[] = [];
        const write = process.stderr.write.bind(process.stderr);
        process.stderr.write = (chunk: string | Uint8Array): boolean => (written.push(String(chunk)), true);
        try {
            expect(await run(['check', '--nope'])).toBe(2);
        } finally {
            process.stderr.write = write;
        }
        expect(written.join('')).toContain('unknown option --nope');
    });

    test('malformed --locations is a usage error, not a crash', async () => {
        const written: string[] = [];
        const write = process.stderr.write.bind(process.stderr);
        process.stderr.write = (chunk: string | Uint8Array): boolean => (written.push(String(chunk)), true);
        const directory = project('package ok\nkind Person\n');
        try {
            expect(await run(['check', directory, '--locations={bad'])).toBe(2);
            expect(await run(['gufo', directory, '--locations={"example.org/x":"y"}'])).toBe(2);
            expect(await run(['fetch', directory, '--locations=[]'])).toBe(2);
        } finally {
            process.stderr.write = write;
        }
        expect(written.join('')).toMatch(/--locations is not JSON[\s\S]*mapping key "example\.org\/x" is not an absolute HTTP\(S\) URL[\s\S]*must be a JSON object/);
    });
});
