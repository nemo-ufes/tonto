import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { TontoSession } from '../src/api.js';
import { CLI_HOOK_COMMAND } from '../src/agent-hook.js';
import { run } from '../src/cli/index.js';
import { cliInstructions } from '../src/cli/init.js';
import {
    CLI_INSTRUCTIONS_START, EDITOR_INSTRUCTIONS_START, INSTRUCTIONS_END, defaultOntologyName, instructionsIn, starterOntology,
    withAgentsImport, withTontoInstructions
} from '../src/onboarding.js';
import { canonicalPath } from '../src/utils/paths.js';

function folder(): string {
    return canonicalPath(mkdtempSync(join(tmpdir(), 'tonto-onboarding-')));
}

async function tonto(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const written: string[] = [];
    const complained: string[] = [];
    const writeOut = process.stdout.write.bind(process.stdout);
    const writeErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (chunk: string | Uint8Array): boolean => { written.push(String(chunk)); return true; };
    process.stderr.write = (chunk: string | Uint8Array): boolean => { complained.push(String(chunk)); return true; };
    try {
        const code = await run(argv);
        return { code, out: written.join(''), err: complained.join('') };
    } finally {
        process.stdout.write = writeOut;
        process.stderr.write = writeErr;
    }
}

async function errorsIn(workspace: string): Promise<string[]> {
    const reported = await new TontoSession({ workspace }).validateFiles([workspace]);
    return reported.filter(one => one.severity === 'error' || one.severity === 'warning').map(one => `${one.code}: ${one.message}`);
}

describe('what starting a workspace writes', () => {
    test('a starter ontology that validates, with or without its sample', async () => {
        for (const sample of [true, false]) {
            const reported = await new TontoSession().validateText(starterOntology('shop', sample));
            expect(reported.filter(one => one.severity === 'error' || one.severity === 'warning'), String(sample)).toEqual([]);
        }
    });

    test('a folder\'s name, as an ontology name', () => {
        expect(defaultOntologyName('/models/Car Rentals')).toBe('car_rentals');
        expect(defaultOntologyName('/models/Ação')).toBe('acao');
        expect(defaultOntologyName('/models/2026')).toBe('model_2026');
        expect(defaultOntologyName('/models/---')).toBe('model');
    });

    test('instructions added once, brought up to date in place, and the editor\'s preferred to the command line\'s', () => {
        const cli = `${CLI_INSTRUCTIONS_START}\nCLI\n${INSTRUCTIONS_END}\n`;
        const editor = `${EDITOR_INSTRUCTIONS_START}\nEditor\n${INSTRUCTIONS_END}\n`;
        const theirs = '# Project rules\n\nBe kind.\n';
        const added = withTontoInstructions(theirs, cli);
        expect(added).toBe(`${theirs}\n${cli}`);
        expect(withTontoInstructions(added, cli)).toBe(added);
        expect(instructionsIn(added)).toBe('cli');
        const upgraded = withTontoInstructions(`${added}\nAfter.\n`, editor);
        expect(upgraded).toBe(`${theirs}\n${editor.trim()}\n\nAfter.\n`);
        expect(instructionsIn(upgraded)).toBe('editor');
        expect(withTontoInstructions('', cli)).toBe(cli);
        // An editor block from before the end marker ends at the line every version ended with.
        expect(withTontoInstructions(`${EDITOR_INSTRUCTIONS_START}\nold\nchanging the source model.\nmine\n`, cli)).toBe(`${cli.trim()}\nmine\n`);
    });

    test('CLAUDE.md importing AGENTS.md once', () => {
        expect(withAgentsImport('')).toBe('@AGENTS.md\n');
        expect(withAgentsImport('Read me.\n')).toBe('Read me.\n\n@AGENTS.md\n');
        expect(withAgentsImport('Read me.\n\n@AGENTS.md\n')).toBe('Read me.\n\n@AGENTS.md\n');
    });

    test('the command line\'s instructions are its own block, and name no tool', () => {
        const text = cliInstructions();
        expect(text.startsWith(CLI_INSTRUCTIONS_START)).toBe(true);
        expect(text.trimEnd().endsWith(INSTRUCTIONS_END)).toBe(true);
        expect(text).not.toMatch(/\btonto_[a-z]/);
        expect(text).toContain('tonto new ontology');
    });
});

describe('a new ontology, and a package of it, written to disk', () => {
    test('the first ontology has the sample; a package splits it; the model still validates', async () => {
        const workspace = folder();
        const session = new TontoSession({ workspace });
        const shop = await session.newOntology('shop');
        expect(shop).toEqual({ ontology: 'shop', file: join(workspace, 'shop.tonto'), sample: true });
        expect(readFileSync(shop.file, 'utf8')).toBe(starterOntology('shop', true));

        const sales = await session.newPackage('sales');
        expect(sales).toEqual({
            ontology: 'shop', packageName: 'sales', packageFile: join(workspace, 'sales.tonto'), ontologyFile: shop.file,
            split: { packageName: 'core', packageFile: join(workspace, 'core.tonto') }
        });
        expect(readFileSync(shop.file, 'utf8')).toBe('ontology shop bundles\n    core from <core.tonto>\n    sales from <sales.tonto>\n');
        expect(readFileSync(join(workspace, 'core.tonto'), 'utf8')).toContain('package core in shop\n\n/// A person');

        const billing = await session.newPackage('billing', { ontology: 'shop', folder: join(workspace, 'finance', 'billing') });
        expect(billing.split).toBeUndefined();
        expect(readFileSync(shop.file, 'utf8')).toContain('    billing from <finance/billing/billing.tonto>');

        const later = await session.newOntology('pricing', join(workspace, 'pricing'));
        expect(later.sample).toBe(false);
        expect(readFileSync(later.file, 'utf8')).toBe('ontology pricing\n\n');
        expect(await errorsIn(workspace)).toEqual([]);
    });

    test('refuses what it cannot write, and writes nothing then', async () => {
        const workspace = folder();
        const session = new TontoSession({ workspace });
        await expect(session.newPackage('sales')).rejects.toThrow(/no ontology yet/);
        await expect(session.newOntology('Shop')).rejects.toThrow(/not an ontology name/);
        await expect(session.newOntology('package')).rejects.toThrow(/does not read/);
        await expect(session.newOntology('shop', join(workspace, '..', 'elsewhere'))).rejects.toThrow(/outside the workspace/);
        await session.newOntology('shop');
        await session.newOntology('pricing');
        await expect(session.newOntology('shop', join(workspace, 'again'))).rejects.toThrow(/already has an ontology "shop"/);
        await expect(session.newPackage('sales')).rejects.toThrow(/Name the ontology the package joins: the workspace has "pricing", "shop"/);
        await expect(session.newPackage('sales', { ontology: 'nope' })).rejects.toThrow(/no ontology "nope"/);
        await session.newPackage('sales', { ontology: 'shop' });
        await expect(session.newPackage('sales', { ontology: 'shop' })).rejects.toThrow(/already has a package "sales"/);
        await expect(session.newPackage('Sales', { ontology: 'shop' })).rejects.toThrow(/not a package name/);
        writeFileSync(join(workspace, 'orders.tonto'), '// someone else\'s\n');
        await expect(session.newPackage('orders', { ontology: 'pricing' })).rejects.toThrow(/orders\.tonto already exists/);
        expect(readFileSync(join(workspace, 'pricing.tonto'), 'utf8')).toBe('ontology pricing\n\n');
        expect(existsSync(join(workspace, 'again'))).toBe(false);
    });
});

describe('tonto new and tonto init', () => {
    test('tonto new writes here, and a package beside its ontology', async () => {
        const workspace = folder();
        const before = process.cwd();
        process.chdir(workspace);
        try {
            expect(await tonto('new', 'ontology', 'shop')).toMatchObject({ code: 0, out: 'Created shop.tonto, the one-file ontology "shop".\n' });
            const added = await tonto('new', 'package', 'sales', '--json');
            expect(added.code).toBe(0);
            expect(JSON.parse(added.out)).toMatchObject({ packageFile: 'sales.tonto', ontologyFile: 'shop.tonto', split: { packageName: 'core' } });
            mkdirSync(join(workspace, 'nested'));
            process.chdir(join(workspace, 'nested'));
            // The workspace is the one the ontology is in, not the folder the package goes to.
            expect(await tonto('new', 'package', 'x', join(workspace, '..'), '--in=shop')).toMatchObject({ code: 1, err: expect.stringMatching(/outside the workspace/) });
            expect(await tonto('new', 'ontology', 'shop')).toMatchObject({ code: 1, err: expect.stringMatching(/already has an ontology/) });
            expect((await tonto('new', 'ontology', 'x', '--in=shop')).code).toBe(2);
            expect((await tonto('new', 'thing', 'x')).code).toBe(2);
        } finally {
            process.chdir(before);
        }
        expect(await errorsIn(workspace)).toEqual([]);
    });

    test('tonto init sets up an empty folder, and changes nothing the second time', async () => {
        const project = join(folder(), 'Car Rentals');
        const first = await tonto('init', project, '--json');
        expect(first.code).toBe(0);
        expect(JSON.parse(first.out)).toMatchObject({
            changed: ['AGENTS.md', 'CLAUDE.md', '.claude/settings.json'], kept: [], ontology: { ontology: 'car_rentals', sample: true }
        });
        expect(readFileSync(join(project, 'AGENTS.md'), 'utf8')).toBe(cliInstructions());
        expect(readFileSync(join(project, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n');
        expect(JSON.parse(readFileSync(join(project, '.claude', 'settings.json'), 'utf8')).hooks.PostToolUse[0].hooks[0].command).toBe(CLI_HOOK_COMMAND);
        expect(await errorsIn(project)).toEqual([]);

        const again = await tonto('init', project, '--json');
        expect(JSON.parse(again.out)).toMatchObject({ changed: [], kept: [] });
        expect(JSON.parse(again.out).ontology).toBeUndefined();
    });

    test('tonto init leaves the editor\'s setup and everything else in the files alone', async () => {
        const project = folder();
        mkdirSync(join(project, '.claude'));
        const agents = `# Ours\n\n${EDITOR_INSTRUCTIONS_START}\nEditor\n${INSTRUCTIONS_END}\n`;
        writeFileSync(join(project, 'AGENTS.md'), agents);
        writeFileSync(join(project, 'CLAUDE.md'), 'Read me.\n');
        const settings = { model: 'opus', hooks: { PostToolUse: [{ matcher: 'Edit|MultiEdit|Write', hooks: [{ type: 'command', command: 'node /x/tonto-hook.mjs' }] }] } };
        writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify(settings));
        writeFileSync(join(project, 'model.tonto'), 'ontology model\nkind Person\n');
        const result = await tonto('init', project, '--json');
        expect(JSON.parse(result.out)).toMatchObject({ changed: ['CLAUDE.md'], kept: ['AGENTS.md', '.claude/settings.json'] });
        expect(JSON.parse(result.out).ontology).toBeUndefined();
        expect(readFileSync(join(project, 'AGENTS.md'), 'utf8')).toBe(agents);
        expect(readFileSync(join(project, 'CLAUDE.md'), 'utf8')).toBe('Read me.\n\n@AGENTS.md\n');
        expect(JSON.parse(readFileSync(join(project, '.claude', 'settings.json'), 'utf8'))).toEqual(settings);
    });

    test('tonto init stops before writing anything it cannot finish', async () => {
        const project = folder();
        mkdirSync(join(project, '.claude'));
        writeFileSync(join(project, '.claude', 'settings.json'), '{oops');
        expect(await tonto('init', project)).toMatchObject({ code: 1, err: expect.stringMatching(/is not valid JSON/) });
        expect(existsSync(join(project, 'AGENTS.md'))).toBe(false);
        const named = folder();
        expect(await tonto('init', named, '--ontology=Bad')).toMatchObject({ code: 1, err: expect.stringMatching(/not an ontology name/) });
        expect(existsSync(join(named, 'AGENTS.md'))).toBe(false);
        expect((await tonto('init', project, '--ontology=x', '--no-ontology')).code).toBe(2);
    });
});
