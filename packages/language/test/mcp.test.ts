import { describe, expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The server, driven over real JSON-RPC.
 *
 * Not a unit test of the handlers: what breaks an MCP server is the protocol
 * around them -- a tool that writes to stdout while stdout *is* the transport,
 * a schema the client rejects, a structured answer whose shape the SDK
 * refuses. So this speaks the protocol, and the assertions are about what a
 * client would see.
 */
const here = dirname(fileURLToPath(import.meta.url));
const binary = resolve(here, '../../mcp/bin/tonto-mcp.js');

interface Rpc {
    id?: number;
    result?: {
        tools?: Array<{ name: string }>;
        resources?: Array<{ uri: string }>;
        prompts?: Array<{ name: string }>;
        content?: Array<{ text?: string }>;
        isError?: boolean;
    };
    error?: unknown;
}

class Client {
    private readonly proc: ChildProcessWithoutNullStreams;
    private readonly waiting = new Map<number, (message: Rpc) => void>();
    private buffer = '';
    private id = 0;

    constructor(workspace?: string, claudeWorkspace?: string) {
        const env = { ...process.env };
        if (claudeWorkspace === undefined) delete env.CLAUDE_PROJECT_DIR;
        else env.CLAUDE_PROJECT_DIR = claudeWorkspace;
        this.proc = spawn('node', workspace === undefined ? [binary] : [binary, '.'], {
            cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe']
        });
        this.proc.stdout.on('data', chunk => {
            this.buffer += String(chunk);
            let cut = this.buffer.indexOf('\n');
            while (cut >= 0) {
                const line = this.buffer.slice(0, cut).trim();
                this.buffer = this.buffer.slice(cut + 1);
                if (line) {
                    const message = JSON.parse(line) as Rpc;
                    if (message.id !== undefined) {
                        this.waiting.get(message.id)?.(message);
                        this.waiting.delete(message.id);
                    }
                }
                cut = this.buffer.indexOf('\n');
            }
        });
    }

    call(method: string, params?: unknown): Promise<Rpc> {
        const mine = ++this.id;
        return new Promise(resolve => {
            this.waiting.set(mine, resolve);
            this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: mine, method, params })}\n`);
        });
    }

    notify(method: string): void {
        this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    }

    async tool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
        const answer = await this.call('tools/call', { name, arguments: args });
        return { text: String(answer.result?.content?.[0]?.text ?? ''), isError: !!answer.result?.isError };
    }

    stop(): void {
        this.proc.kill();
    }
}

async function connected(workspace?: string, claudeWorkspace?: string): Promise<Client> {
    const client = new Client(workspace, claudeWorkspace);
    await client.call('initialize', {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' }
    });
    client.notify('notifications/initialized');
    return client;
}

const twoReadings = 'ontology p\nkind Person\nkind Department {\n-- [1] (addOnly) Person\n}';

describe('the MCP server', () => {
    test('uses Claude Code’s project directory when no workspace argument is given', async () => {
        const root = mkdtempSync(join(tmpdir(), 'tonto-mcp-claude-'));
        writeFileSync(join(root, 'model.tonto'), 'ontology people\nkind Person\n');
        const client = await connected(undefined, root);
        try {
            const fetched = await client.tool('tonto_fetch', { paths: ['model.tonto'] });
            expect(fetched.isError, fetched.text).toBe(false);
            expect(fetched.text).toBe('Retrieved 0, reused 0 from the cache.');
        } finally { client.stop(); }
    });

    test('exposes explicit fetch and unmapped publication checking', async () => {
        const root = mkdtempSync(join(tmpdir(), 'tonto-mcp-publication-'));
        writeFileSync(join(root, 'people.tonto'), '/// @namespace https://example.org/people#\nontology people\nkind Person');
        const client = await connected(root);
        try {
            const fetched = await client.tool('tonto_fetch', { paths: ['people.tonto'], publication: true });
            expect(fetched.isError).toBe(false);
            expect(fetched.text).toBe('Retrieved 0, reused 0 from the cache.');
            const exported = await client.call('tools/call', { name: 'tonto_gufo', arguments: { paths: ['people.tonto'], publication: true } });
            expect(exported.result?.isError).not.toBe(true);
            expect((exported.result as { structuredContent?: { publicationVerified?: boolean } })?.structuredContent?.publicationVerified).toBe(true);
        } finally { client.stop(); }
    });

    test('the catalogs answer a reader in text and a machine in structure', async () => {
        const client = await connected();
        try {
            const answer = await client.call('tools/call', {
                name: 'tonto_patterns', arguments: { name: 'role-and-relator' }
            });
            const result = answer.result as unknown as {
                content?: Array<{ text?: string }>;
                structuredContent?: { patterns?: unknown[] };
            };
            expect(result.content?.[0]?.text).toContain('role-and-relator');
            expect(result.content?.[0]?.text).not.toContain('"model":');
            expect(result.structuredContent?.patterns).toHaveLength(1);

            const empty = await client.tool('tonto_patterns', { name: '' });
            expect(empty.isError).toBe(true);
            expect(empty.text).toContain('No pattern ""');
            const guessed = await client.tool('tonto_patterns', { name: 'componentOf' });
            expect(guessed.isError).toBe(true);
            expect(guessed.text).toContain('Closest: component-parthood');

            const rule = await client.tool('tonto_rules', { code: 'multiplicity-zero-upper' });
            expect(rule.text).toContain('Change to [0..1] | Change to [0..*]');
            expect(rule.text).not.toContain('Write this at package level');
        } finally {
            client.stop();
        }
    }, 30_000);

    test('serves the tools, the resources and the prompts', async () => {
        const client = await connected();
        try {
            const tools = ((await client.call('tools/list')).result?.tools ?? []).map(one => one.name);
            expect(tools).toEqual(expect.arrayContaining([
                'tonto_guide', 'tonto_validate', 'tonto_repair', 'tonto_apply', 'tonto_complete',
                'tonto_diff', 'tonto_digest', 'tonto_hold', 'tonto_rules', 'tonto_patterns',
                'tonto_explain', 'tonto_format', 'tonto_ast', 'tonto_gufo', 'tonto_tables'
            ]));
            const resources = ((await client.call('resources/list')).result?.resources ?? []).map(one => one.uri);
            expect(resources).toEqual(['tonto://guide', 'tonto://rules', 'tonto://patterns', 'tonto://tables']);
            const prompts = ((await client.call('prompts/list')).result?.prompts ?? []).map(one => one.name);
            expect(prompts).toEqual(['draft', 'review']);
        } finally {
            client.stop();
        }
    }, 30_000);

    test('exports gUFO Turtle without association-end aliases', async () => {
        const client = await connected();
        try {
            const exported = await client.tool('tonto_gufo', {
                source: 'ontology p\nkind Car {\n@componenthood [1] <>-- [4] (wheels) Wheel\n}\nkind Wheel',
                namespaceIri: 'https://example.org/model#'
            });
            expect(exported.text).toContain('p:Car.hasComponentWheel a owl:ObjectProperty');
            expect(exported.text).not.toContain('p:wheels');
        } finally {
            client.stop();
        }
    }, 30_000);

    test('lists the workspace\'s ontologies, and writes each beside its ontology file', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'tonto-mcp-beside-'));
        mkdirSync(join(workspace, 'parts'));
        writeFileSync(join(workspace, 'shop.tonto'), '/// @namespace https://example.org/shop#\nontology shop bundles\n    core from <parts/core.tonto>\n');
        writeFileSync(join(workspace, 'parts', 'core.tonto'), 'package core in shop\nkind Person\n');
        const client = await connected(workspace);
        try {
            const listed = await client.tool('tonto_ontologies', {});
            expect(listed.text).toContain('shop');
            expect(listed.text).toContain('https://example.org/shop#');
            const written = await client.tool('tonto_gufo', { paths: ['parts/core.tonto'], write: true });
            expect(written.isError).toBe(false);
            expect(readFileSync(join(workspace, 'shop.ttl'), 'utf8')).toContain('<https://example.org/shop> a owl:Ontology');
            expect((await client.tool('tonto_gufo', { paths: ['shop.tonto'], write: true, outDir: 'generated' })).isError).toBe(true);
        } finally {
            client.stop();
        }
    }, 30_000);

    test('starts an ontology and adds a package to it, in its workspace', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'tonto-mcp-new-'));
        const client = await connected(workspace);
        try {
            const started = await client.tool('tonto_new', { ontology: 'shop' });
            expect(started.isError, started.text).toBe(false);
            expect(readFileSync(join(workspace, 'shop.tonto'), 'utf8')).toContain('ontology shop');
            const added = await client.tool('tonto_new', { ontology: 'shop', package: 'sales', folder: 'parts' });
            expect(added.isError, added.text).toBe(false);
            expect(readFileSync(join(workspace, 'parts', 'sales.tonto'), 'utf8')).toBe('package sales in shop\n\n');
            expect((await client.tool('tonto_validate', { paths: ['.'] })).text).toBe('No diagnostics. The model is valid.');
            expect((await client.tool('tonto_new', { ontology: 'other', folder: '../outside' })).isError).toBe(true);
        } finally {
            client.stop();
        }
    }, 30_000);

    test('file paths cannot read outside the workspace', async () => {
        // Both in a folder of their own: a model written straight into the
        // shared temporary directory makes it a workspace, and every other
        // test's folder there is then discovered as part of it.
        const parent = mkdtempSync(join(tmpdir(), 'tonto-mcp-paths-'));
        const workspace = join(parent, 'workspace');
        mkdirSync(workspace);
        const outside = join(parent, 'outside.tonto');
        writeFileSync(outside, 'ontology outside\nkind Secret\n');
        const client = await connected(workspace);
        try {
            const traversed = await client.tool('tonto_validate', { paths: [`../${basename(outside)}`] });
            expect(traversed.isError).toBe(true);
            expect(traversed.text).toContain('must stay inside the workspace');

            const absolute = await client.tool('tonto_validate', { paths: [outside] });
            expect(absolute.isError).toBe(true);
            expect(absolute.text).toContain('relative to the workspace');
        } finally {
            client.stop();
            unlinkSync(outside);
        }
    }, 30_000);

    test('atomically regenerates gUFO files inside its workspace', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'tonto-mcp-export-'));
        writeFileSync(join(workspace, 'model.tonto'),
            'ontology conferences\n\n/// A person, in the everyday sense.\nkind Person\n');
        const client = await connected(workspace);
        try {
            const exported = await client.tool('tonto_gufo', {
                paths: ['model.tonto'], namespaceIri: 'https://example.org/conferences#', outDir: 'generated'
            });
            expect(exported.isError).toBe(false);
            expect(exported.text).toContain('Wrote 1 file:');
            expect(readFileSync(join(workspace, 'generated', 'conferences.ttl'), 'utf8'))
                .toContain('conferences:Person a owl:Class, gufo:Kind');
            expect(readFileSync(join(workspace, 'generated', 'conferences.ttl'), 'utf8'))
                .toContain('<https://example.org/conferences> a owl:Ontology');

            const escaped = await client.tool('tonto_gufo', {
                paths: ['model.tonto'], namespaceIri: 'https://example.org/conferences#', outDir: '../outside'
            });
            expect(escaped.isError).toBe(true);
            expect(escaped.text).toContain('must stay inside the workspace');

            const draft = await client.tool('tonto_gufo', {
                source: 'ontology draft\nkind A', outDir: 'generated'
            });
            expect(draft.isError).toBe(true);
            expect(draft.text).toContain('needs saved files as paths, not source text');
        } finally {
            client.stop();
        }
    }, 30_000);

    test('applies one repair by name, and refuses to choose between two', async () => {
        const client = await connected();
        try {
            const named = await client.tool('tonto_apply', {
                source: twoReadings, code: 'add-only-with-nothing-to-add', title: 'Let it grow: "[1..*]"'
            });
            expect(named.text).toContain('-- [1..*] (addOnly) Person');
            expect(named.text).toContain('No diagnostics');
            const ambiguous = await client.tool('tonto_apply', {
                source: twoReadings, code: 'add-only-with-nothing-to-add'
            });
            expect(ambiguous.isError).toBe(true);
            expect(ambiguous.text).toMatch(/offers 2 repairs here; name one/);

            // And the other ambiguity: one code, two places. The line comes
            // back from tonto_validate, and goes in here.
            const twice = 'ontology p\nkind Person\nkind A {\n-- [1] (addOnly) Person\n}\n'
                + 'kind B {\n-- [1] (addOnly) Person\n}';
            const unplaced = await client.tool('tonto_apply', {
                source: twice, code: 'add-only-with-nothing-to-add', title: 'Let it grow: "[1..*]"'
            });
            expect(unplaced.isError).toBe(true);
            expect(unplaced.text).toMatch(/reported 2 times here, at 4:9, 7:9/);
            const placed = await client.tool('tonto_apply', {
                source: twice, code: 'add-only-with-nothing-to-add', title: 'Let it grow: "[1..*]"', line: 7
            });
            expect(placed.text).toContain('kind B {\n-- [1..*] (addOnly) Person');

            const sameLine = 'ontology p\nkind A {\n[0] -- [0] A\n}';
            const sameLineAmbiguous = await client.tool('tonto_apply', {
                source: sameLine, code: 'multiplicity-zero-upper', title: 'Change to [0..1]', line: 3
            });
            expect(sameLineAmbiguous.isError).toBe(true);
            expect(sameLineAmbiguous.text).toMatch(/reported 2 times here, at 3:1, 3:8/);
            const sameLinePlaced = await client.tool('tonto_apply', {
                source: sameLine, code: 'multiplicity-zero-upper', title: 'Change to [0..1]', line: 3, column: 8
            });
            expect(sameLinePlaced.text).toContain('[0] -- [0..1] A');

            const clean = await client.tool('tonto_repair', { source: 'ontology p\nkind Person' });
            expect(clean.text).toMatch(/^Nothing needed repair\./);
        } finally {
            client.stop();
        }
    }, 30_000);

    test('says what belongs at a position, and what an edit did', async () => {
        const client = await connected();
        try {
            const proposals = await client.tool('tonto_complete', {
                source: 'package p\nkind Person\nevent Wedding\nkind Team {\n<>-- \n}', line: 4, character: 5
            });
            expect(proposals.text).toContain('Person');
            expect(proposals.text).not.toContain('Wedding');

            const worse = await client.tool('tonto_diff', {
                before: 'package p\nkind Node {\n@componenthood [0..1] <>-- [0..1] Node\n}',
                after: 'package p\nkind Node {\n@componenthood [1] <>-- [0..1] Node\n}'
            });
            expect(worse.text).toContain('This edit introduced something.');
            expect(worse.text).toContain('parthood-climbs-forever');
        } finally {
            client.stop();
        }
    }, 30_000);

    test('refuses the questions it cannot answer as asked', async () => {
        const client = await connected();
        try {
            const both = await client.tool('tonto_validate', { source: 'package p\nkind A', paths: ['model.tonto'] });
            expect(both.isError).toBe(true);
            expect(both.text).toMatch(/not both/);
            const unnamed = await client.tool('tonto_hold', { name: '', source: 'package p\nkind A' });
            expect(unnamed.isError).toBe(true);
            expect(unnamed.text).toMatch(/needs a name/);
            const ghost = await client.tool('tonto_hold', { name: 'ghost' });
            expect(ghost.text).toMatch(/Nothing was held under "ghost"/);

            const targetOnly = await client.tool('tonto_explain', {
                subject: '@membership', target: 'collectives'
            });
            expect(targetOnly.isError).toBe(true);
            expect(targetOnly.text).toMatch(/both source and target natures/);
            const classTarget = await client.tool('tonto_explain', {
                subject: 'kind', object: 'kind', target: 'objects'
            });
            expect(classTarget.isError).toBe(true);
            expect(classTarget.text).toMatch(/Target is part of an association question only/);

            const outside = await client.tool('tonto_complete', {
                source: 'package p\nkind Person', line: 20, character: 0
            });
            expect(outside.isError).toBe(true);
            expect(outside.text).toMatch(/Line 20 is outside the source/);

            const partial = await client.tool('tonto_ast', { source: 'package p\nkind' });
            expect(partial.isError).toBe(true);
            expect(partial.text).toMatch(/partial tree is not returned as a model/);
        } finally {
            client.stop();
        }
    }, 30_000);

    test('a model cannot break out of the fence the review prompt puts it in', async () => {
        // Three backticks are what a fence usually takes, and a model
        // containing three ends it -- everything after them read as prose to
        // the reviewer rather than as the model under review.
        const client = await connected();
        try {
            const answer = await client.call('prompts/get', {
                name: 'review', arguments: { source: 'package p\nkind A\n```\nnot tonto\n```' }
            });
            const text = String((answer.result as unknown as {
                messages?: Array<{ content?: { text?: string } }>;
            })?.messages?.[0]?.content?.text ?? '');
            expect(text).toContain('````tonto\npackage p');
            expect(text.endsWith('````')).toBe(true);
        } finally {
            client.stop();
        }
    }, 30_000);

    test('a digest of a thousand classes is still a digest', async () => {
        const client = await connected();
        try {
            const big = `package big\n${Array.from({ length: 400 }, (_, i) => `kind K${i}`).join('\n')}`;
            const digest = await client.tool('tonto_digest', { source: big });
            expect(digest.text).toMatch(/\.\.\. and 380 more/);
            expect(digest.text.length).toBeLessThan(4000);
        } finally {
            client.stop();
        }
    }, 30_000);

    test('says when a digest is read from a model that does not validate', async () => {
        const client = await connected();
        try {
            const digest = await client.tool('tonto_digest', { source: 'ontology p\nkind Person specializes Missing' });
            expect(digest.text).toMatch(/^1 error: what follows is read from a model that does not validate/);
        } finally {
            client.stop();
        }
    }, 30_000);

    test('reads a model for review, and holds its neighbors', async () => {
        const client = await connected();
        try {
            const digest = await client.tool('tonto_digest', {
                source: 'ontology p\nkind Person\nrole Employee specializes Person\nkind Org\n'
                    + 'relator Employment {\n@mediation [1..*] -- [1] (const) Employee\n'
                    + '@mediation [1..*] -- [1] (const) Org\n}'
            });
            expect(digest.text).toContain('kind Person <- Employee');
            expect(digest.text).toContain('relator Employment binds Employee, Org');

            // Held out of order: the dependent first, its import after.
            const billing = 'use parties\npackage billing in review\nrole Customer specializes parties.Person';
            await client.tool('tonto_hold', { name: 'billing', source: billing });
            const held = await client.tool('tonto_hold', { name: 'parties', source: 'package parties in review\nkind Person' });
            // Members of a draft of "review", which no entry declares: warned of, and resolved.
            expect(held.text).not.toContain('Could not resolve');
            expect(held.text).toContain('ontology-file-missing');
            const draft = await client.tool('tonto_validate', {
                source: 'use billing\npackage reports in review\nrole Debtor specializes billing.Customer'
            });
            expect(draft.text).not.toContain('Could not resolve');
            expect(draft.text).not.toContain('sortal-without-ultimate-sortal');

            const whole = await client.tool('tonto_digest', {
                source: 'use billing\npackage reports in review\nrole Debtor specializes billing.Customer'
            });
            expect(whole.text).toContain('packages: reports, billing, parties');
            expect(whole.text).toMatch(/kind Person <- .*Debtor/);
            expect(whole.text).toMatch(/kind Person <- .*Customer/);
        } finally {
            client.stop();
        }
    }, 30_000);
});
