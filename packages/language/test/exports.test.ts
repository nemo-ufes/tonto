import {
    existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { writeBeside, writeInto } from '../src/exports.js';

// Fails file-system steps on demand, in order: keeping a backup of a target,
// putting a new file over it, or putting the backup back. `watched` records,
// at every rename, whether each watched target was there.
const fault = vi.hoisted(() => ({ queue: [] as Array<[string, string]>, watched: [] as string[], seen: [] as boolean[] }));
vi.mock('node:fs', async importOriginal => {
    const fs = await importOriginal<typeof import('node:fs')>();
    const fail = (phase: string, path: string): void => {
        const [next] = fault.queue;
        if (next && next[0] === phase && next[1] === path) {
            fault.queue.shift();
            throw new Error(`injected ${phase} failure`);
        }
    };
    return {
        ...fs,
        linkSync: (...args: Parameters<typeof fs.linkSync>) => {
            fail('backup', String(args[0]));
            return fs.linkSync(...args);
        },
        copyFileSync: (...args: Parameters<typeof fs.copyFileSync>) => {
            fail('backup', String(args[0]));
            return fs.copyFileSync(...args);
        },
        renameSync: (...args: Parameters<typeof fs.renameSync>) => {
            const [source, target] = args.map(String);
            fault.seen.push(...fault.watched.map(path => fs.existsSync(path)));
            fail(source.endsWith('.bak') ? 'restore' : 'install', target);
            return fs.renameSync(...args);
        }
    };
});

describe('what every export writes, whatever its format', () => {
    const roots: string[] = [];
    afterEach(() => {
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    const project = (): string => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), 'tonto-exports-')));
        roots.push(root);
        mkdirSync(join(root, 'shop'));
        writeFileSync(join(root, 'shop', 'shop.tonto'), 'ontology shop\nkind Product\n');
        return root;
    };

    test('puts each file beside its ontology file, named as the format names it', () => {
        const root = project();
        const source = join(root, 'shop', 'shop.tonto');
        const written = writeBeside([
            { ontology: 'shop', file: 'shop.ttl', content: 'turtle', source },
            { ontology: 'shop', file: 'shop.json', content: 'json', source }
        ], root);
        expect(written.map(file => file.path)).toEqual([join(root, 'shop', 'shop.ttl'), join(root, 'shop', 'shop.json')]);
        expect(readFileSync(join(root, 'shop', 'shop.json'), 'utf8')).toBe('json');
    });

    test('never overwrites a model, and needs an ontology file on disk to write beside', () => {
        const root = project();
        const source = join(root, 'shop', 'shop.tonto');
        expect(() => writeBeside([{ ontology: 'shop', file: 'shop.tonto', content: 'x', source }], root)).toThrow(/not a safe file name/);
        expect(() => writeInto(root, 'out', [{ ontology: 'shop', file: '../shop.ttl', content: 'x' }])).toThrow(/not a safe file name/);
        expect(() => writeBeside([{ ontology: 'shop', file: 'shop.ttl', content: 'x' }], root)).toThrow(/no ontology file on disk/);
        expect(readFileSync(source, 'utf8')).toBe('ontology shop\nkind Product\n');
    });

    test('rejects duplicate output paths before replacing an existing export', () => {
        const root = project();
        const target = join(root, 'shop', 'shop.ttl');
        writeFileSync(target, 'previous');
        expect(() => writeInto(root, 'shop', [
            { ontology: 'first', file: 'shop.ttl', content: 'first' },
            { ontology: 'second', file: 'shop.ttl', content: 'second' }
        ])).toThrow(/same output file/);
        expect(readFileSync(target, 'utf8')).toBe('previous');
    });

    test('rejects a directory target before replacing any export', () => {
        const root = project();
        const target = join(root, 'shop', 'shop.ttl');
        writeFileSync(target, 'previous');
        mkdirSync(join(root, 'shop', 'other.ttl'));
        expect(() => writeInto(root, 'shop', [
            { ontology: 'shop', file: 'shop.ttl', content: 'new' },
            { ontology: 'other', file: 'other.ttl', content: 'new' }
        ])).toThrow(/not a file/);
        expect(readFileSync(target, 'utf8')).toBe('previous');
    });

    const twoExports = () => [
        { ontology: 'shop', file: 'shop.ttl', content: 'new turtle' },
        { ontology: 'shop', file: 'shop.json', content: 'new json' }
    ];

    const failing = (queue: Array<[string, string]>, write: () => void): Error | undefined => {
        fault.queue = queue;
        try {
            write();
        } catch (error) {
            return error as Error;
        } finally {
            fault.queue = [];
        }
        return undefined;
    };

    test.each([
        ['backing up the second file', 'backup'],
        ['installing the second file', 'install']
    ])('restores every previous file when %s fails', (_step, phase) => {
        const root = project();
        const directory = join(root, 'shop');
        writeFileSync(join(directory, 'shop.ttl'), 'old turtle');
        writeFileSync(join(directory, 'shop.json'), 'old json');
        // A backup that cannot be a hard link is a copy, so failing it fails both.
        const steps: Array<[string, string]> = phase === 'backup'
            ? [['backup', join(directory, 'shop.json')], ['backup', join(directory, 'shop.json')]]
            : [[phase, join(directory, 'shop.json')]];
        const thrown = failing(steps, () => writeInto(root, 'shop', twoExports()));
        expect(thrown?.message).toBe(`injected ${phase} failure`);
        expect(readFileSync(join(directory, 'shop.ttl'), 'utf8')).toBe('old turtle');
        expect(readFileSync(join(directory, 'shop.json'), 'utf8')).toBe('old json');
        expect(readdirSync(directory).sort()).toEqual(['shop.json', 'shop.tonto', 'shop.ttl']);
    });

    test('throws the first failure when putting a file back fails too, and says where the old file is', () => {
        const root = project();
        const directory = join(root, 'shop');
        writeFileSync(join(directory, 'shop.ttl'), 'old turtle');
        writeFileSync(join(directory, 'shop.json'), 'old json');
        const thrown = failing([['install', join(directory, 'shop.json')], ['restore', join(directory, 'shop.ttl')]],
            () => writeInto(root, 'shop', twoExports()));
        expect(thrown?.message).toMatch(/^injected install failure\. Putting the previous files back also failed/);
        const kept = readdirSync(directory).find(name => name.endsWith('.bak'));
        expect(kept).toBeDefined();
        expect(thrown?.message).toContain(join(directory, kept!));
        expect(readFileSync(join(directory, kept!), 'utf8')).toBe('old turtle');
        // The rest was still put back.
        expect(readFileSync(join(directory, 'shop.json'), 'utf8')).toBe('old json');
    });

    test('leaves no backup or staged file after replacing an export', () => {
        const root = project();
        const directory = join(root, 'shop');
        writeFileSync(join(directory, 'shop.ttl'), 'old turtle');
        writeInto(root, 'shop', twoExports());
        expect(readFileSync(join(directory, 'shop.ttl'), 'utf8')).toBe('new turtle');
        expect(readdirSync(directory).sort()).toEqual(['shop.json', 'shop.tonto', 'shop.ttl']);
    });

    test('keeps every existing export in place until the new one replaces it', () => {
        // A reader watching the file sees the old export or the new one, never none.
        const root = project();
        const directory = join(root, 'shop');
        writeFileSync(join(directory, 'shop.ttl'), 'old turtle');
        writeFileSync(join(directory, 'shop.json'), 'old json');
        fault.watched = [join(directory, 'shop.ttl'), join(directory, 'shop.json')];
        fault.seen = [];
        try {
            writeInto(root, 'shop', twoExports());
        } finally {
            fault.watched = [];
        }
        expect(fault.seen.length).toBeGreaterThan(0);
        expect(fault.seen.every(Boolean)).toBe(true);
    });

    test('replaces a symlinked export with a file, leaving what it pointed at alone', () => {
        const root = project();
        const directory = join(root, 'shop');
        writeFileSync(join(root, 'elsewhere.ttl'), 'not an export');
        symlinkSync(join(root, 'elsewhere.ttl'), join(directory, 'shop.ttl'));
        writeInto(root, 'shop', [{ ontology: 'shop', file: 'shop.ttl', content: 'new turtle' }]);
        expect(lstatSync(join(directory, 'shop.ttl')).isSymbolicLink()).toBe(false);
        expect(readFileSync(join(directory, 'shop.ttl'), 'utf8')).toBe('new turtle');
        expect(readFileSync(join(root, 'elsewhere.ttl'), 'utf8')).toBe('not an export');
    });

    test('removes staged files if writing a later file fails', () => {
        const root = project();
        const directory = join(root, 'shop');
        writeFileSync(join(directory, 'shop.ttl'), 'old turtle');
        const failing = { ontology: 'shop', file: 'shop.json', get content(): string { throw new Error('injected content failure'); } };
        expect(() => writeInto(root, 'shop', [
            { ontology: 'shop', file: 'shop.ttl', content: 'new turtle' },
            failing
        ])).toThrow('injected content failure');
        expect(readFileSync(join(directory, 'shop.ttl'), 'utf8')).toBe('old turtle');
        expect(existsSync(join(directory, 'shop.json'))).toBe(false);
        expect(readdirSync(directory).sort()).toEqual(['shop.tonto', 'shop.ttl']);
    });
});
