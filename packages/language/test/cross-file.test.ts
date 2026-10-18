import { describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Position, Range } from 'vscode-languageserver';
import { catalog as rules } from '../src/cli/rules.js';
import { catalog as patterns } from '../src/cli/patterns.js';
import type { Reported } from '../src/api.js';
import { bundled } from './in-ontology.js';
import { TontoSession } from '../src/api.js';
import { canonicalPath } from '../src/utils/paths.js';

/**
 * Every published model, cut in two and checked again.
 *
 * A model split across files is the normal case and the one the checks keep
 * getting wrong: the evidence a rule reads -- a generalization set, a sibling
 * phase, a subtype -- is often written in a different file from the class it
 * is about, and a check that walks the local document alone then says that
 * something is missing when it is present. Two of those were found here
 * (`lone-phase` and `phases-without-partition`, both false positives across
 * files) and one silence (`non-sortal-without-sortal-subtype`).
 *
 * The split is mechanical: the declarations up to some top-level boundary
 * stay in one package, the rest move to a second file that imports the first.
 * Nothing else changes, so the two models say the same thing and any
 * difference in what is reported is a difference the file boundary made.
 */

/** Codes that a file boundary legitimately changes. */
const EXPECTED = new Set([
    // Two packages, so two declarations of a name are two different names.
    'duplicate-declaration',
    // Scoped to the document on purpose: it reads a language written once
    // against one written repeatedly nearby, and "nearby" is the file.
    'doubtful-doc-language',
    // Artefacts of the split itself.
    'unnecessary-use', 'duplicate-package-across-files', 'linking-error', 'parsing-error', 'lexing-error'
]);

/** A model that does not parse, or names something it does not declare. */
const UNRESOLVED = ['linking-error', 'parsing-error', 'lexing-error'];

/** Where a top-level declaration begins, with any `///` run above it. */
function boundaries(lines: string[]): number[] {
    const starts: number[] = [];
    let depth = 0;
    for (const [index, line] of lines.entries()) {
        const text = line.trim();
        const isTop = depth === 0 && text.length > 0 && !text.startsWith('//')
            && !text.startsWith('}') && !/^[({]/.test(text) && !/^\s/.test(line);
        if (isTop) {
            // A documentation run belongs to what it is written above, so the
            // cut goes above the run rather than between the two.
            let start = index;
            while (start > 0 && lines[start - 1].trim().startsWith('///')) {
                start--;
            }
            starts.push(start);
        }
        for (const character of line) {
            depth += character === '{' || character === '(' ? 1 : character === '}' || character === ')' ? -1 : 0;
        }
    }
    return starts;
}

async function codesOf(files: Array<[string, string]>, antiPatterns = false, configured = true): Promise<string[]> {
    const directory = canonicalPath(mkdtempSync(join(tmpdir(), 'tonto-split-')));
    try {
        const paths = (configured ? bundled(files) : files).map(([name, text]) => {
            const path = join(directory, name);
            writeFileSync(path, text);
            return path;
        });
        const session = new TontoSession({ workspace: directory, antiPatterns });
        return (await session.validateFiles(paths.filter(path => path.endsWith('.tonto')))).map(diagnostic => diagnostic.code);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

function tally(codes: string[]): Map<string, number> {
    const counted = new Map<string, number>();
    for (const code of codes.filter(code => !EXPECTED.has(code))) {
        counted.set(code, (counted.get(code) ?? 0) + 1);
    }
    return counted;
}

async function models(): Promise<Array<[string, string]>> {
    const preamble = 'datatype string\ndatatype date\ndatatype number\n';
    return [
        ...(await rules())
            // An example that writes its own package is about the package
            // declaration, and is not one to put inside another.
            .filter(rule => !rule.example.includes('// another file')
                && !/^\s*(package|ontology)\s/m.test(rule.example))
            .map(rule => [`rule ${rule.code}`, `package split\n${rule.example}\n`] as [string, string]),
        ...(await patterns())
            .map(pattern => [`pattern ${pattern.name}`, `package split\n${preamble}${pattern.model}\n`] as [string, string])
    ];
}

describe('a model split across files says what one file says', () => {
    test('at every declaration boundary of every published model', async () => {
        const differing: string[] = [];
        let compared = 0;
        for (const [name, source] of await models()) {
            const [header, ...lines] = source.split('\n');
            const whole = tally(await codesOf([['model.tonto', source]]));
            for (const start of boundaries(lines).slice(1)) {
                const second = lines.slice(start).join('\n');
                if (second.trim().length === 0) {
                    continue;
                }
                const split = await codesOf([
                    ['a.tonto', `${header}\nuse splittwo\n${lines.slice(0, start).join('\n')}\n`],
                    ['b.tonto', `use split\npackage splittwo\n${second}\n`]
                ]);
                if (split.some(code => UNRESOLVED.includes(code))) {
                    // The cut separated a reference from what it names, which
                    // is a different model rather than a split one.
                    continue;
                }
                compared++;
                const after = tally(split);
                const lost = [...whole].filter(([code, n]) => (after.get(code) ?? 0) < n).map(([code]) => `-${code}`);
                const gained = [...after].filter(([code, n]) => (whole.get(code) ?? 0) < n).map(([code]) => `+${code}`);
                if (lost.length + gained.length > 0) {
                    differing.push(`${name} at line ${start + 1}: ${[...lost, ...gained].join(' ')}`);
                }
            }
        }
        expect(compared).toBeGreaterThan(250);
        expect(differing).toEqual([]);
    }, 180_000);
});

describe('the anti-patterns, which are scanned per document', () => {
    test('report fewer across a boundary and never more', async () => {
        // Deliberate, and worth pinning: they are pairwise loops over a
        // document, so a split model gives up hints. What must not happen is
        // the other direction -- a heuristic that invents a finding because
        // what answers it is in the next file.
        const gained: string[] = [];
        for (const [name, source] of await models()) {
            const [header, ...lines] = source.split('\n');
            const whole = tally(await codesOf([['model.tonto', source]], true));
            for (const start of boundaries(lines).slice(1)) {
                const second = lines.slice(start).join('\n');
                if (second.trim().length === 0) {
                    continue;
                }
                const split = await codesOf([
                    ['a.tonto', `${header}\nuse splittwo\n${lines.slice(0, start).join('\n')}\n`],
                    ['b.tonto', `use split\npackage splittwo\n${second}\n`]
                ], true);
                if (split.some(code => UNRESOLVED.includes(code))) {
                    continue;
                }
                const after = tally(split);
                gained.push(...[...after]
                    .filter(([code, count]) => (whole.get(code) ?? 0) < count)
                    .map(([code]) => `${name} at line ${start + 1}: +${code}`));
            }
        }
        expect(gained).toEqual([]);
    }, 180_000);
});

describe('what a check can see in another file', () => {
    const write = (files: Array<[string, string]>): string[] => {
        const directory = canonicalPath(mkdtempSync(join(tmpdir(), 'tonto-parts-')));
        return bundled(files).map(([name, text]) => {
            const path = join(directory, name);
            writeFileSync(path, text);
            return path;
        });
    };

    test('a sibling phase, and a partition written in a third file', async () => {
        const paths = write([
            ['kinds.tonto', 'package kinds\nkind Person\nphase Child specializes Person\n'],
            ['more.tonto', 'use kinds\npackage more\nphase Adult specializes kinds.Person\n'],
            ['sets.tonto', 'use kinds\nuse more\npackage sets\n'
                + 'disjoint complete genset ages where kinds.Child, more.Adult specializes kinds.Person\n']
        ]);
        const session = new TontoSession({ workspace: join(paths[0], '..') });
        expect((await session.validateFiles(paths)).map(diagnostic => diagnostic.code)).toEqual([]);
    }, 30_000);

    test('and the repair is withheld when it could not name them', async () => {
        // The set is written beside the parent and names its phases
        // unqualified, which it cannot do for a phase in another package.
        const paths = write([
            ['kinds.tonto', 'package kinds\nkind Person\nphase Child specializes Person\n'],
            ['more.tonto', 'use kinds\npackage more\nphase Adult specializes kinds.Person\n']
        ]);
        const session = new TontoSession({ workspace: join(paths[0], '..') });
        const reported = await session.validateFiles(paths);
        expect(reported.map(diagnostic => diagnostic.code)).toEqual(['phases-without-partition']);
        expect(reported[0].fixes).toEqual([]);
    }, 30_000);
});

/**
 * Repairs that a repair uncovers: the model was already wrong, the offered
 * alternative is right, and what it leaves is the next thing to decide.
 * Turning a non-sortal into a sortal asks for an ultimate sortal above it;
 * dropping a supertype drops what an end override was narrowing.
 */
const UNCOVERS = new Set([
    'incompatible-supertype-natures', 'stereotype-nature-unreachable', 'unspecific-stereotype',
    'stereotype-cannot-specialize', 'unknown-relation-stereotype'
]);

describe('every repair is an edit to the file it names', () => {
    /** Applies non-overlapping edits, back to front. */
    function applyTo(text: string, edits: Array<{ range: Range; newText: string }>): string {
        const lines = text.split('\n');
        const offsetOf = (position: Position): number =>
            lines.slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) + position.character;
        return [...edits]
            .sort((left, right) => offsetOf(right.range.start) - offsetOf(left.range.start))
            .reduce((text, edit) =>
                text.slice(0, offsetOf(edit.range.start)) + edit.newText + text.slice(offsetOf(edit.range.end)), text);
    }

    test('applied there, it leaves a model that still parses', async () => {
        // A repair reported on one file can be an edit to another -- what a
        // generalization set says is repaired where the class is written. The
        // edits carried the reported file's name, so a consumer applied one
        // file's coordinates to another and deleted whatever sat at them.
        const broken: string[] = [];
        let applied = 0;
        for (const [name, source] of await models()) {
            const [header, ...lines] = source.split('\n');
            for (const start of boundaries(lines).slice(1)) {
                const rest = lines.slice(start).join('\n');
                if (rest.trim().length === 0) {
                    continue;
                }
                const texts: Array<[string, string]> = bundled([
                    ['a.tonto', `${header}\nuse splittwo\n${lines.slice(0, start).join('\n')}\n`],
                    ['b.tonto', `use split\npackage splittwo\n${rest}\n`]
                ]);
                const directory = canonicalPath(mkdtempSync(join(tmpdir(), 'tonto-repair-')));
                try {
                    const paths = texts.map(([file, text]) => {
                        const path = join(directory, file);
                        writeFileSync(path, text);
                        return path;
                    });
                    const before = await new TontoSession({ workspace: directory }).validateFiles(paths);
                    if (before.some(diagnostic => UNRESOLVED.includes(diagnostic.code))) {
                        continue;
                    }
                    const already = new Set(before.filter(one => one.severity === 'error').map(one => one.code));
                    for (const diagnostic of before) {
                        for (const fix of diagnostic.fixes) {
                            applied++;
                            texts.forEach(([file, text]) => writeFileSync(join(directory, file), text));
                            // Every file the repair writes to: a repair that
                            // spans files goes in whole.
                            for (const change of fix.changes) {
                                writeFileSync(change.file,
                                    applyTo(readFileSync(change.file, 'utf8'), change.edits));
                            }
                            const after = await new TontoSession({ workspace: directory }).validateFiles(paths);
                            const fresh = [...new Set(after
                                .filter(one => one.severity === 'error' && !already.has(one.code))
                                .map(one => one.code))];
                            if (fresh.length > 0 && !UNCOVERS.has(diagnostic.code)) {
                                broken.push(`${name} [${diagnostic.code}] "${fix.title}" -> ${fresh.join(', ')}`);
                            }
                        }
                    }
                } finally {
                    rmSync(directory, { recursive: true, force: true });
                }
            }
        }
        expect(applied).toBeGreaterThan(200);
        expect(broken).toEqual([]);
    }, 180_000);
});

describe('a session held open', () => {
    /**
     * The MCP server keeps one for the life of the connection, so what it
     * says has to keep up with the files. Re-reading the files asked about
     * was not enough: half the checks read what points *at* a class, so a
     * relator written in a sibling file changes the answer about a role
     * whose own file has not been touched -- and a file appearing or going
     * changes it without any file being edited at all.
     *
     * The measure is a session created from scratch on the same directory:
     * whatever it says, the one held open must say too.
     */
    test('answers what a session created now would answer', async () => {
        const directory = canonicalPath(mkdtempSync(join(tmpdir(), 'tonto-open-')));
        const role = join(directory, 'role.tonto');
        const relators = join(directory, 'relators.tonto');
        writeFileSync(role, 'package r\nkind Person\nrole Student specializes Person\n');

        const held = new TontoSession({ workspace: directory });
        const codesOf = async (session: TontoSession): Promise<string[]> =>
            (await session.validateFiles([role])).map(diagnostic => diagnostic.code).sort();
        const agree = async (what: string): Promise<void> => {
            const fresh = new TontoSession({ workspace: directory });
            expect([what, await codesOf(held)]).toEqual([what, await codesOf(fresh)]);
        };

        await agree('to begin with');
        // The evidence arrives in a file the request never mentions.
        writeFileSync(relators, 'use r\npackage m\nrelator Enrollment {\n'
            + '  @mediation [1] -- [1] r.Student\n  @mediation [1] -- [1] r.Person\n}\n');
        await agree('after a relator appeared');
        // It stops mediating the role.
        writeFileSync(relators, 'use r\npackage m\nrelator Enrollment {\n'
            + '  @mediation [1] -- [1] r.Person\n  @mediation [0..1] -- [1] r.Person\n}\n');
        await agree('after it stopped mediating the role');
        // And goes.
        rmSync(relators);
        await agree('after the file went');

        rmSync(directory, { recursive: true, force: true });
    }, 60_000);

    test('including when the edit left the timestamp where it found it', async () => {
        // An unchanged file is recognized by its stat rather than re-read, so
        // the session has to notice an edit that puts the timestamp back:
        // `cp -p`, `rsync --times` and `tar -x` all do, and a filesystem
        // whose mtime is coarser than the gap between two writes reports the
        // same instant for both. Reading the time alone, the session went on
        // answering about text that was no longer on disk.
        const directory = canonicalPath(mkdtempSync(join(tmpdir(), 'tonto-mtime-')));
        const model = join(directory, 'model.tonto');
        const pinned = new Date('2020-01-01T00:00:00.000Z');
        const write = (text: string): void => {
            writeFileSync(model, text);
            utimesSync(model, pinned, pinned);
        };

        write('package p\nkind Person\n');
        const held = new TontoSession({ workspace: directory });
        const codesOf = async (session: TontoSession): Promise<string[]> =>
            (await session.validateFiles([model])).map(diagnostic => diagnostic.code).sort();
        const agree = async (what: string): Promise<void> => {
            const fresh = new TontoSession({ workspace: directory });
            expect([what, await codesOf(held)]).toEqual([what, await codesOf(fresh)]);
        };

        await agree('to begin with');
        write('package p\nkind Person\nkind Person\n');
        expect(statSync(model).mtimeMs).toBe(pinned.getTime());
        await agree('after an edit under the same timestamp');
        write('package p\nkind Person\n');
        await agree('and after it was put back');

        rmSync(directory, { recursive: true, force: true });
    }, 60_000);
});

describe('a classifier\'s member namespace', () => {
    /**
     * The namespace is the classifier's, not the file's. An end belongs to
     * the classifier at the *opposite* side, so a relation written anywhere
     * can put a name into this class's namespace -- and the scope provider
     * exports `Person.foo` for both. Only the relations nested in the class
     * were read, so the same model written beside the class rather than
     * inside it collided in silence.
     */
    const write = (files: Array<[string, string]>): string[] => {
        const directory = canonicalPath(mkdtempSync(join(tmpdir(), 'tonto-members-')));
        return bundled(files).map(([name, text]) => {
            const path = join(directory, name);
            writeFileSync(path, text);
            return path;
        });
    };

    test('holds the ends of relations written elsewhere', async () => {
        const paths = write([
            ['a.tonto', 'package p\ndatatype string\nkind Person {\n  foo: string\n}\nkind Car\n'],
            ['b.tonto', 'use p\npackage q\nrelation p.Person [1] -- [*] (foo) p.Car\n']
        ]);
        const session = new TontoSession({ workspace: join(paths[0], '..') });
        const reported = await session.validateFiles(paths);
        expect(reported.map(diagnostic => diagnostic.code)).toEqual(['duplicate-member']);
        // Reported where it can be pointed at, and with no repair: which of
        // the two is the redundant one is not the check's to say.
        expect(reported[0].file).toBe(paths[0]);
        expect(reported[0].fixes).toEqual([]);
    }, 30_000);

    test('and repairs the collision that is written in one file', async () => {
        const session = new TontoSession();
        const reported = await session.validateText(
            'ontology p\ndatatype string\nkind Person {\n  foo: string\n}\nkind Car\n'
            + 'relation Person [1] -- [*] (foo) Car\n');
        expect(reported.map(diagnostic => diagnostic.code)).toEqual(['duplicate-member']);
        // An attribute and a relation end are never two writings of one
        // thing, so the deletion discards a claim and is not applied unread.
        expect(reported[0].fixes.map(fix => fix.title))
            .toEqual(['Remove this declaration of "foo", and what it says']);
        expect(reported[0].fixes.map(fix => fix.batchSafe)).toEqual([false]);
    });
});

describe('the packages of one ontology', () => {
    test('may not both declare a classifier of one name, wherever each is written', async () => {
        const codes = await codesOf([
            ['a.tonto', 'package sales\nkind Customer\nkind Order\n'],
            ['b.tonto', 'package billing\nkind Customer\nkind Invoice\n']
        ]);
        expect(codes.filter(code => code === 'namespace-name-clash')).toHaveLength(2);
    }, 30_000);

    test('share its namespace, which a package of its own cannot change', async () => {
        const distinct = await codesOf([
            ['a.tonto', 'package sales\nkind Order\n'],
            ['b.tonto', 'package billing\nkind Invoice\n']
        ]);
        const annotated = await codesOf([
            ['a.tonto', '/// @namespace https://example.org/sales#\npackage sales\nkind Customer\n'],
            ['b.tonto', '/// @namespace https://example.org/billing#\npackage billing\nkind Customer\n']
        ]);
        expect(distinct).not.toContain('namespace-name-clash');
        expect(annotated).toContain('namespace-name-clash');
        expect(annotated.filter(code => code === 'ontology-tag-not-on-header')).toHaveLength(2);
    }, 30_000);

    test('are only those of a declared ontology: packages of none stay apart, and say so', async () => {
        const unconnected = await codesOf([
            ['a.tonto', 'package sales\nkind Customer\n'],
            ['b.tonto', 'package billing\nkind Customer\n']
        ], false, false);
        expect(unconnected).not.toContain('namespace-name-clash');
        expect(unconnected.filter(code => code === 'package-without-ontology')).toHaveLength(2);
    }, 30_000);
});

describe('uses, which belong to a scope and not to a file', () => {
    /**
     * A package sees the file's imports and its own. Flattening the two into
     * one list per document got both questions wrong: two packages in one
     * file, each importing what it uses, were reported as a duplicate, and an
     * import used by one of them counted as used by the other.
     */
    const codesOf = async (files: Array<[string, string]>): Promise<string[]> => {
        const directory = canonicalPath(mkdtempSync(join(tmpdir(), 'tonto-imports-')));
        const paths = bundled(files).map(([name, text]) => {
            const path = join(directory, name);
            writeFileSync(path, text);
            return path;
        });
        const session = new TontoSession({ workspace: directory });
        const found = (await session.validateFiles(paths)).map(diagnostic => diagnostic.code);
        rmSync(directory, { recursive: true, force: true });
        return found;
    };

    const other = ['other.tonto', 'package other\nkind Thing\nkind Item\n'] as [string, string];

    test('each package uses what it refers to, and that is not a duplicate', async () => {
        expect(await codesOf([other, ['uses.tonto',
            'package b\nuse other\nsubkind X specializes other.Thing\n\n'
            + 'package c\nuse other\nsubkind Y specializes other.Item\n']])).toEqual([]);
    });

    test('and a package that imports what it never uses is told so', async () => {
        expect(await codesOf([other, ['uses.tonto',
            'package b\nuse other\nsubkind X specializes other.Thing\n\n'
            + 'package c\nuse other\nkind Y\n']])).toEqual(['unnecessary-use']);
    });

    test('while repeating the file\'s own import is a duplicate', async () => {
        expect(await codesOf([other, ['uses.tonto',
            'use other\npackage b\nuse other\nsubkind X specializes other.Thing\n']]))
            .toEqual(['duplicate-use']);
    });

    test('two imports under one alias name two things', async () => {
        expect(await codesOf([other, ['second.tonto', 'package second\nkind Thing\n'], ['uses.tonto',
            'package b\nuse other as Z\nuse second as Z\nsubkind X specializes Z.Thing\n']]))
            .toContain('duplicate-alias');
    });

    test('and so does an alias spelled like a package already in scope', async () => {
        expect(await codesOf([other, ['second.tonto', 'package second\nkind Thing\n'], ['uses.tonto',
            'package b\nuse other\nuse second as other\nsubkind X specializes other.Thing\n']]))
            .toContain('alias-shadows-package');
    });
});

describe('a repair reaches as far as the rule that asked for it', () => {
    /**
     * The checks read the workspace; several repairs read one file, and
     * declined -- or offered nothing -- whenever what they had to edit was
     * written elsewhere. A model in more than one file is the ordinary case,
     * so the repair for a diagnostic about it has to be too.
     */
    const reportedFor = async (files: Array<[string, string]>): Promise<Reported[]> => {
        const directory = canonicalPath(mkdtempSync(join(tmpdir(), 'tonto-reach-')));
        const paths = bundled(files).map(([name, text]) => {
            const path = join(directory, name);
            writeFileSync(path, text);
            return path;
        });
        const session = new TontoSession({ workspace: directory });
        return session.validateFiles(paths);
    };
    const fixesOf = (reported: Reported[], code: string): Array<[string, string[]]> =>
        (reported.find(diagnostic => diagnostic.code === code)?.fixes ?? [])
            .map(fix => [fix.title, fix.changes.map(change => basename(change.file))]);

    test('retyping an instanceOf target writes in the file that declares it', async () => {
        const reported = await reportedFor([
            ['a.tonto', 'package typology\nkind PersonKind\n'],
            ['b.tonto', 'use typology\npackage uses\nkind Person (instanceOf typology.PersonKind)\n']
        ]);
        expect(fixesOf(reported, 'instance-of-not-higher-order'))
            .toEqual([['Make "PersonKind" a type', ['a.tonto']]]);
    }, 30_000);

    test('lower-casing a package renames what spells it, in every file', async () => {
        const reported = await reportedFor([
            ['a.tonto', 'package Shop\nkind Car\n'],
            ['b.tonto', 'use Shop\nuse Shop as S\npackage uses\nkind Ferrari specializes Shop.Car\nkind Fiat specializes S.Car\n']
        ]);
        const fix = reported.find(diagnostic => diagnostic.code === 'package-name-case')?.fixes[0];
        // Both imports and the qualified name; the alias does not spell the package.
        expect(fix?.title).toBe('Rename to "shop" and its 3 references');
        const written = fix?.changes.find(change => change.file.endsWith('b.tonto'))?.edits.map(edit => edit.newText);
        expect(written?.sort()).toEqual(['shop', 'shop', 'shop.Car']);
    }, 30_000);

    test('and leaves alone a class spelled like its package', async () => {
        // Reported case: `specializes Person` inside `package Person` names the
        // class, and was renamed with the package.
        const reported = await reportedFor([
            ['a.tonto', 'package Person\nkind Person\nrole Employee specializes Person\n'],
            ['b.tonto', 'use Person\npackage uses\nrole Driver specializes Person.Person\n']
        ]);
        const fix = reported.find(diagnostic => diagnostic.code === 'package-name-case')?.fixes[0];
        const written = (file: string) => fix?.changes.find(change => change.file.endsWith(file))?.edits
            .map(edit => edit.newText).sort();
        expect(written('a.tonto')).toEqual(['person']);
        expect(written('b.tonto')).toEqual(['person', 'person.Person']);
    }, 30_000);

    test('widening a mediation writes where the mediation is', async () => {
        const reported = await reportedFor([
            ['a.tonto', 'package a\nkind Person\nrelator Marriage\n'],
            ['b.tonto', 'use a\npackage b\n@mediation relation a.Marriage [1] -- [1] a.Person\n']
        ]);
        expect(fixesOf(reported, 'relator-mediates-one'))
            .toEqual([['Mediate two of "Person": "[2]"', ['b.tonto']]]);
    }, 30_000);

    test('and an inherited end is named plainly, across files as within one', async () => {
        const reported = await reportedFor([
            ['c.tonto', 'package base\nclass Entity {\n  [*] <>-- hasPart -- [*] (parts) Entity\n}\n'],
            ['d.tonto', 'use base\npackage deep\nclass Obj specializes base.Entity {\n'
                + '  [*] <>-- hasObjPart -- [*] (objParts redefines parts) Obj\n}\n']
        ]);
        expect(reported.filter(one => one.code === 'linking-error')).toEqual([]);
    }, 30_000);

    test('while one nothing declares is still looked for wherever it is written', async () => {
        const reported = await reportedFor([
            ['c.tonto', 'package base\nclass Entity {\n  [*] <>-- hasPart -- [*] (parts) Entity\n}\n'],
            ['d.tonto', 'use base\npackage deep\nclass Obj {\n'
                + '  [*] <>-- hasObjPart -- [*] (objParts redefines parts) Obj\n}\n']
        ]);
        // Spelled so it resolves from here, which for an imported package
        // means qualified.
        expect(fixesOf(reported, 'linking-error')).toEqual([['Change to "base.Entity.parts"', ['d.tonto']]]);
    }, 30_000);
});
