import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { TontoSession } from '../src/api.js';
import { TOOLS, ToolError, VSCODE_CAPABILITIES, runTool, vscodeToolContributions } from '../src/tools.js';
import type { ToolHost } from '../src/tools.js';

/** A host as the MCP server is one: files named relative to a workspace, none by default. */
function hostFor(workspace?: string): ToolHost {
    const session = new TontoSession({ workspace });
    return {
        antiPatterns: false,
        files(paths) {
            if (!paths) throw new ToolError('Give either source or paths.');
            return paths.map(path => resolve(workspace ?? '.', path));
        },
        session: () => session,
        sessionWith: options => new TontoSession({ workspace, ...options }),
        workspaceRoot() {
            if (!workspace) throw new ToolError('No workspace.');
            return workspace;
        },
        display: file => workspace ? relative(workspace, file) : file
    };
}

describe('the tools agents call, defined once for every host', () => {
    test('are what VS Code declares: npm run tools:sync in packages/extension writes them', () => {
        const manifest = JSON.parse(readFileSync(new URL('../../extension/package.json', import.meta.url), 'utf8'));
        expect(manifest.contributes.languageModelTools).toEqual(vscodeToolContributions(VSCODE_CAPABILITIES));
    });

    test('say first when to use them, and fit in a small part of an agent\'s context', () => {
        expect(new Set(TOOLS.map(tool => tool.name)).size).toBe(TOOLS.length);
        for (const tool of TOOLS) {
            expect(tool.description(VSCODE_CAPABILITIES), tool.name).toMatch(/^(Use|Read|Run)\b/);
            expect(tool.description(VSCODE_CAPABILITIES).length, tool.name).toBeLessThan(600);
        }
        const declared = JSON.stringify(TOOLS.map(tool => ({ name: tool.name, description: tool.description(VSCODE_CAPABILITIES), input: tool.input })));
        expect(declared.length).toBeLessThan(12_000);
    });

    test('answer in compact text, with the whole structure as data', async () => {
        const validated = await runTool('tonto_validate', { source: 'ontology shop\nkind Person\nkind Student specializes Person\n' }, hostFor());
        expect(validated.text).toMatch(/^3:\d+ {2}error {2}stereotype-cannot-specialize\n {4}.*\n {4}repairs: Change "Student" to subkind/);
        expect(validated.text.length).toBeLessThan(800);
        expect(JSON.stringify(validated.data)).toContain('"changes"');
    });

    test('do not return a partial AST as structured data when the source has errors', async () => {
        const result = await runTool('tonto_ast', { source: 'package p\nkind' }, hostFor());
        expect(result.isError).toBe(true);
        expect(result.text).toContain('partial tree is not returned as a model');
        expect(result.data).toHaveProperty('diagnostics');
        expect(result.data).not.toHaveProperty('ast');
    });

    test('say what is wrong with a call rather than failing', async () => {
        const host = hostFor();
        expect(await runTool('tonto_validate', { source: 'ontology a', paths: ['a.tonto'] }, host)).toMatchObject({ isError: true, text: expect.stringContaining('not both') });
        expect(await runTool('tonto_validate', {}, host)).toMatchObject({ isError: true, text: 'Give either source or paths.' });
        expect(await runTool('tonto_gufo', { source: 'ontology a', write: true }, host)).toMatchObject({ isError: true, text: expect.stringContaining('saved files') });
        expect(await runTool('tonto_rules', { code: 'no-such-rule' }, host)).toMatchObject({ isError: true });
        expect(await runTool('tonto_apply', { source: 'ontology a' }, host)).toMatchObject({ isError: true, text: '"code" is required.' });
        expect(await runTool('tonto_nothing', {}, host)).toMatchObject({ isError: true });
    });

    test('write an export beside its ontology file, and list the workspace\'s ontologies', async () => {
        const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'tonto-tools-')));
        mkdirSync(join(workspace, 'parts'));
        writeFileSync(join(workspace, 'shop.tonto'), '/// @namespace https://example.org/shop#\nontology shop bundles\n    core from <parts/core.tonto>\n');
        writeFileSync(join(workspace, 'parts', 'core.tonto'), 'package core in shop\nkind Person\n');
        const host = hostFor(workspace);
        expect((await runTool('tonto_ontologies', {}, host)).text).toBe('shop  shop.tonto  https://example.org/shop#');
        const written = await runTool('tonto_gufo', { paths: ['parts/core.tonto'], write: true }, host);
        expect(written.text).toMatch(/^Wrote 1 file:\n- shop\.ttl/);
        expect(readFileSync(join(workspace, 'shop.ttl'), 'utf8')).toContain('<https://example.org/shop> a owl:Ontology');
    });

    test('fence the model text they return, so the text cannot end the fence', async () => {
        const formatted = await runTool('tonto_format', { source: 'ontology shop\n/// ```\nkind Person' }, hostFor());
        expect(formatted.text.startsWith('````tonto\n')).toBe(true);
    });
});
