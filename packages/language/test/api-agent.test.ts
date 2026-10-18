import { describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectFiles, workspaceRootOf, TontoSession } from '../src/api.js';
import { OntologySession } from './in-ontology.js';
import { canonicalPath } from '../src/utils/paths.js';

// Packages of one ontology across documents: a draft of it, since no entry is written.
const sameOntology = (source: string): string => source.replace(/^(package [\w.]+)$/m, '$1 in review');

describe('bounded model discovery', () => {
    test('does not follow directory links found inside a workspace', () => {
        const root = canonicalPath(mkdtempSync(join(tmpdir(), 'tonto-links-')));
        try {
            const workspace = join(root, 'workspace');
            const outside = join(root, 'outside');
            mkdirSync(workspace);
            mkdirSync(outside);
            const model = join(workspace, 'model.tonto');
            writeFileSync(model, 'package p\nkind Person\n');
            writeFileSync(join(outside, 'other.tonto'), 'package q\nkind Other\n');
            symlinkSync(outside, join(workspace, 'outside'));
            symlinkSync(workspace, join(workspace, 'loop'));

            expect(collectFiles([workspace])).toEqual([model]);
            expect(collectFiles([join(workspace, 'outside')])).toEqual([join(workspace, 'outside', 'other.tonto')]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test('does not leave an opened workspace when its parent has tonto files', async () => {
        // This is the shape that made the VS Code export command traverse the
        // whole home folder: model.tonto in an opened child folder, plus loose
        // tonto files in Downloads and home. The editor knows the boundary.
        const outside = canonicalPath(mkdtempSync(join(tmpdir(), 'tonto-outside-')));
        writeFileSync(join(outside, 'unrelated.tonto'), 'package unrelated\nkind Other\n');
        const workspace = join(outside, 'conferences');
        const model = join(workspace, 'model.tonto');
        mkdirSync(workspace);
        writeFileSync(model, 'ontology conferences\n\n/// A person, in the everyday sense.\nkind Person\n');

        expect(workspaceRootOf(model, workspace)).toBe(workspace);
        const session = new TontoSession({ workspace });
        const exported = await session.gufoFiles([model], { namespaceIri: 'https://example.org/conferences#' });
        expect(exported.files[0]?.content).toContain('conferences:Person a owl:Class, gufo:Kind');
        expect(exported.files[0]?.content).not.toContain('unrelated:Other');
    });
});

/**
 * The services an agent has that an editor gives a person for free: choosing
 * one repair, asking what may be written here, checking its own edit, reading
 * a model rather than a syntax tree, and holding the neighbors of a draft.
 */
describe('choosing one repair', () => {
    const twoReadings = 'package p\nkind Person\nkind Department {\n-- [1] (addOnly) Person\n}';

    test('applies the one named, and says what it left', async () => {
        const session = new OntologySession();
        const applied = await session.applyFix(twoReadings, 'add-only-with-nothing-to-add', 'Let it grow: "[1..*]"');
        expect(applied.text).toContain('-- [1..*] (addOnly) Person');
        expect(applied.left).toEqual([]);
    });

    test('and the other one, since the choice is the caller’s', async () => {
        const session = new OntologySession();
        const applied = await session.applyFix(twoReadings, 'add-only-with-nothing-to-add', 'Remove "addOnly"');
        expect(applied.text).toContain('-- [1] Person');
    });

    test('refuses to choose between two of the same complaint, and takes a line', async () => {
        // One code, two attributes: repairing "the first one" is a guess, and
        // the caller could not reach the second at all.
        const session = new OntologySession();
        const twice = 'package p\nkind Person\nkind A {\n-- [1] (addOnly) Person\n}\n'
            + 'kind B {\n-- [1] (addOnly) Person\n}';
        await expect(session.applyFix(twice, 'add-only-with-nothing-to-add', 'Let it grow: "[1..*]"'))
            .rejects.toThrow(/reported 2 times here, at 4:9, 7:9; say which line and column/);
        const second = await session.applyFix(twice, 'add-only-with-nothing-to-add', 'Let it grow: "[1..*]"', 7);
        expect(second.text).toContain('kind B {\n-- [1..*] (addOnly) Person');
        expect(second.text).toContain('kind A {\n-- [1] (addOnly) Person');
        expect(second.left).toHaveLength(1);
    });

    test('and says where a code is reported when the line names none of them', async () => {
        const session = new OntologySession();
        await expect(session.applyFix('package p\nkind pessoa', 'type-name-case', undefined, 9))
            .rejects.toThrow(/not reported at line 9. It is reported at 2:6/);
    });

    test('uses the column when two occurrences are on the same line', async () => {
        const session = new OntologySession();
        const twice = 'package p\nkind A {\n[0] -- [0] A\n}';
        await expect(session.applyFix(twice, 'multiplicity-zero-upper', 'Change to [0..1]', 3))
            .rejects.toThrow(/reported 2 times here, at 3:1, 3:8; say which line and column/);
        const second = await session.applyFix(twice, 'multiplicity-zero-upper', 'Change to [0..1]', 3, 8);
        expect(second.text).toContain('[0] -- [0..1] A');
        expect(second.text).not.toContain('[0..1] -- [0] A');
        expect(second.left).toHaveLength(1);
    });

    test('refuses to choose where a rule offers two', async () => {
        const session = new OntologySession();
        await expect(session.applyFix(twoReadings, 'add-only-with-nothing-to-add'))
            .rejects.toThrow(/offers 2 repairs here; name one/);
    });

    test('applies the only one without being told which', async () => {
        const session = new OntologySession();
        const applied = await session.applyFix('package p\nkind pessoa', 'type-name-case');
        expect(applied.text).toContain('kind Pessoa');
    });

    test('and says so when nothing reports that code', async () => {
        const session = new OntologySession();
        await expect(session.applyFix('package p\nkind Person', 'type-name-case'))
            .rejects.toThrow(/Nothing reports "type-name-case"/);
    });
});

describe('checking an edit against the model it came from', () => {
    test('counts repeated diagnostics rather than collapsing them', async () => {
        // The same complaint about two attributes is two complaints, and
        // repairing one resolves one. Matched as a multiset: keyed by code and
        // message alone, fixing one of two said nothing had happened.
        const session = new OntologySession();
        const twice = 'package p\nkind Person\nkind A {\n-- [1] (addOnly) Person\n}\n'
            + 'kind B {\n-- [1] (addOnly) Person\n}';
        const once = twice.replace('kind A {\n-- [1] (addOnly)', 'kind A {\n-- [1..*] (addOnly)');
        const fixed = await session.compareText(twice, once);
        expect(fixed.resolved).toHaveLength(1);
        expect(fixed.introduced).toHaveLength(0);
        expect(fixed.left).toHaveLength(1);
        // And the other way round, which is the same arithmetic reversed.
        const undone = await session.compareText(once, twice);
        expect(undone.introduced).toHaveLength(1);
        expect(undone.resolved).toHaveLength(0);
        expect(undone.left).toHaveLength(1);
    });

    test('says what it introduced, resolved and left', async () => {
        const session = new OntologySession();
        const before = 'package p\nkind Person\nkind Department {\n-- [1] (addOnly) Person\n}';
        const after = before.replace('[1] (addOnly)', '[1..*] (addOnly)');
        const difference = await session.compareText(before, after);
        expect(difference.resolved.map(one => one.code)).toEqual(['add-only-with-nothing-to-add']);
        expect(difference.introduced).toEqual([]);
    });

    test('and catches an edit that trades one complaint for another', async () => {
        const session = new OntologySession();
        const before = 'package p\nkind Person\nkind Node {\n@componenthood [0..1] <>-- [0..1] Node\n}';
        const after = before.replace('[0..1] <>--', '[1] <>--');
        const difference = await session.compareText(before, after);
        expect(difference.introduced.map(one => one.code)).toEqual(['parthood-climbs-forever']);
    });
});

describe('text that is a saved file being edited', () => {
    const write = (files: Record<string, string>): string => {
        const root = canonicalPath(mkdtempSync(join(tmpdir(), 'tonto-standin-')));
        for (const [name, content] of Object.entries(files)) {
            mkdirSync(join(root, name, '..'), { recursive: true });
            writeFileSync(join(root, name), content);
        }
        return root;
    };

    test('takes the place of that file rather than clashing with it', async () => {
        // A live agent evaluation found this: a draft of hiring.tonto beside
        // the saved hiring.tonto was two ontologies called hiring.
        const root = write({ 'hiring.tonto': 'ontology hiring\n\nkind Person\nkind Organization\n' });
        const session = new TontoSession({ workspace: root });
        const before = 'ontology hiring\n\nkind Person\nkind Organization\n';
        expect(await session.validateText(before)).toEqual([]);
        const difference = await session.compareText(before, before + 'role Employee specializes Person\n');
        expect(difference.introduced.map(one => one.code)).toEqual(['role-without-relator']);
        expect(difference.left).toEqual([]);
        expect((await session.fixText('ontology hiring\nkind person\n')).left).toEqual([]);
        rmSync(root, { recursive: true, force: true });
    });

    test('is what its siblings see, and the saved file is back afterward', async () => {
        const root = write({
            'shop.tonto': 'ontology shop bundles\n    core from <core.tonto>\n    sales from <sales.tonto>\n',
            'core.tonto': 'package core in shop\n\nkind Person\nkind Organization\n',
            'sales.tonto': 'package sales in shop\n\nuse core\n'
        });
        const session = new TontoSession({ workspace: root });
        const saved = (await session.validateFiles([root])).map(one => one.code);
        expect(saved).toEqual(['unnecessary-use']);
        const draft = 'package sales in shop\n\nuse core\n\nrole Customer specializes Person\n'
            + 'relator Purchase {\n  @mediation -- [1..*] (const) Customer\n  @mediation -- [1..*] (const) Organization\n}\n';
        expect(await session.validateText(draft)).toEqual([]);
        expect((await session.validateFiles([root])).map(one => one.code)).toEqual(saved);
        rmSync(root, { recursive: true, force: true });
    });

    test('resolves its locations from the folder of the file it stands for', async () => {
        const root = write({
            'shop/shop.tonto': 'ontology shop bundles\n    core from <core.tonto>\n',
            'shop/core.tonto': 'package core in shop\n\nkind Person\n'
        });
        const session = new TontoSession({ workspace: root });
        const draft = 'ontology shop bundles\n    core from <core.tonto>\n';
        expect((await session.validateText(draft)).filter(one => one.severity === 'error')).toEqual([]);
        rmSync(root, { recursive: true, force: true });
    });

    test('and text that is no saved file still joins beside them', async () => {
        const root = write({ 'hiring.tonto': 'ontology hiring\n\nkind Person\n' });
        const session = new TontoSession({ workspace: root });
        expect(await session.validateText('ontology other\n\nkind Person\n')).toEqual([]);
        const named = await session.validateText('ontology hiring\n\nkind Person\n', 'copy');
        expect(named).toEqual([]);
        rmSync(root, { recursive: true, force: true });
    });
});

describe('what may be written here', () => {
    test('the classes a parthood end admits, and nothing else', async () => {
        const session = new OntologySession();
        const proposals = await session.completionsAt(
            'package p\nkind Person\nevent Wedding\nkind Team {\n<>-- \n}', 4, 5);
        expect(proposals.map(one => one.label)).toEqual(['Person', 'Team']);
        expect(proposals[0].kind).toBe('reference');
    });

    test('and the shape a stereotype writes, where the parser expects punctuation', async () => {
        const session = new OntologySession();
        const proposals = await session.completionsAt('package p\nkind Car {\n@componenthood \n}', 2, 15);
        expect(proposals.map(one => one.label)).toEqual(['[0..1] <>-- [1..*] Part']);
    });

    test('and refuses positions outside the source instead of moving the cursor', async () => {
        const session = new OntologySession();
        await expect(session.completionsAt('package p\nkind Person', 9, 0))
            .rejects.toThrow(/Line 9 is outside the source/);
        await expect(session.completionsAt('package p\nkind Person', 1, 99))
            .rejects.toThrow(/Character 99 is outside line 1/);
    });
});

describe('a model read for review', () => {
    test('names the ultimate sortals, what hangs off them, and what each relator binds', async () => {
        const session = new OntologySession();
        const digest = await session.digestOf([
            'package p', 'kind Person', 'role Employee specializes Person', 'kind Org',
            'relator Employment {', '@mediation [1..*] -- [1] (const) Employee',
            '@mediation [1..*] -- [1] (const) Org', '}',
            'disjoint genset Roles where Employee specializes Person'
        ].join('\n'));
        expect(digest.packages).toEqual(['p']);
        expect(digest.stereotypes).toEqual({ kind: 2, role: 1, relator: 1 });
        expect(digest.ultimateSortals.find(one => one.name === 'Person')?.under).toEqual(['Employee']);
        expect(digest.relators).toEqual([{ name: 'Employment', mediates: ['Employee', 'Org'] }]);
        expect(digest.relations).toEqual({ mediation: 2 });
        expect(digest.gensets).toEqual([
            { name: 'Roles', general: 'Person', specifics: ['Employee'], disjoint: true, complete: false }
        ]);
    });

    test('and says when it is reading a model that does not validate', async () => {
        // The tree behind a digest of a broken model is half of what the
        // author wrote, and the counts are of what survived. Saying nothing
        // made wreckage read like a model.
        const session = new OntologySession();
        const digest = await session.digestOf('package p\nkind Person specializes Missing');
        expect(digest.errors).toBeGreaterThan(0);
        const clean = await session.digestOf('package p\nkind Person');
        expect(clean.errors).toBe(0);
        expect(clean.warnings).toBe(0);
    });

    test('and carries the hints, which are the model’s own list of what it has not said', async () => {
        const session = new OntologySession();
        const digest = await session.digestOf('package p\nkind Person\nrole Employee specializes Person');
        expect(digest.unsaid.map(one => one.code)).toContain('role-without-relator');
    });

    test('and includes the held files that complete the model', async () => {
        const session = new OntologySession();
        await session.hold('parties', sameOntology('package parties\nkind Person'));
        const digest = await session.digestOf(sameOntology(
            'use parties\npackage billing\nrole Customer specializes parties.Person'));
        expect(digest.errors).toBe(0);
        expect(digest.packages).toEqual(['billing', 'parties']);
        expect(digest.stereotypes).toEqual({ role: 1, kind: 1 });
        expect(digest.ultimateSortals).toEqual([
            { name: 'Person', stereotype: 'kind', under: ['Customer'] }
        ]);
    });

    test('and includes the configured workspace files that complete the model', async () => {
        const workspace = canonicalPath(mkdtempSync(join(tmpdir(), 'tonto-digest-')));
        try {
            writeFileSync(join(workspace, 'parties.tonto'), sameOntology('package parties\nkind Person'));
            const session = new TontoSession({ workspace });
            const digest = await session.digestOf(
                sameOntology('use parties\npackage billing\nrole Customer specializes parties.Person'));
            expect(digest.errors).toBe(0);
            expect(digest.packages).toEqual(['billing', 'parties']);
            expect(digest.ultimateSortals).toEqual([
                { name: 'Person', stereotype: 'kind', under: ['Customer'] }
            ]);
        } finally {
            rmSync(workspace, { recursive: true, force: true });
        }
    });
});

describe('holding the neighbors of a draft', () => {
    test('a held document is what the draft imports', async () => {
        const session = new OntologySession();
        // Reported from the held document itself: validating the same text as
        // a draft would put two copies of its package in the store.
        expect((await session.hold('parties', sameOntology('package parties\nkind Person'))).filter(one => one.severity === 'error')).toEqual([]);
        expect(session.holding()).toEqual([{ name: 'parties', lines: 2 }]);
        const reported = await session.validateText(sameOntology(
            'use parties\npackage billing\nrole Customer specializes parties.Person'));
        expect(reported.filter(one => one.severity === 'error')).toEqual([]);
    });

    test('and releasing it takes the import with it', async () => {
        const session = new OntologySession();
        await session.hold('parties', 'package parties\nkind Person');
        await session.release('parties');
        expect(session.holding()).toEqual([]);
        const reported = await session.validateText(
            'use parties\npackage billing\nrole Customer specializes parties.Person');
        expect(reported.some(one => /Could not resolve/.test(one.message))).toBe(true);
    });

    test('and the order of holding does not decide the answer', async () => {
        // The dependent held first, its import held after. Langium rebuilds
        // what *references* a changed document, and a reference that failed to
        // resolve is not one -- so without a rebuild of everything held, the
        // dependent kept its failed links for the life of the session.
        const session = new OntologySession();
        const billing = sameOntology('use parties\npackage billing\nrole Customer specializes parties.Person');
        expect((await session.hold('billing', billing)).some(one => /Could not resolve/.test(one.message)))
            .toBe(true);
        await session.hold('parties', sameOntology('package parties\nkind Person'));
        const reported = await session.validateText(sameOntology(
            'use billing\npackage reports\nrole Debtor specializes billing.Customer'));
        expect(reported.filter(one => one.severity === 'error')).toEqual([]);
    });

    test('and releasing an import takes the resolution with it', async () => {
        const session = new OntologySession();
        const billing = 'use parties\npackage billing\nrole Customer specializes parties.Person';
        await session.hold('parties', 'package parties\nkind Person');
        await session.hold('billing', billing);
        await session.release('parties');
        expect((await session.hold('billing', billing)).some(one => /Could not resolve/.test(one.message)))
            .toBe(true);
    });

    test('a name that is no name is refused, rather than Langium answering for it', async () => {
        // `/held/.tonto` is a file with no extension as far as the registry is
        // concerned, and it answered with "no services for the extension ''".
        const session = new OntologySession();
        await expect(session.hold('', 'package p\nkind A')).rejects.toThrow(/A held file needs a name/);
        await expect(session.hold('   ', 'package p\nkind A')).rejects.toThrow(/A held file needs a name/);
    });

    test('releasing says whether anything went', async () => {
        const session = new OntologySession();
        await session.hold('parties', 'package parties\nkind Person');
        expect(await session.release('ghost')).toBe(false);
        expect(await session.release('parties')).toBe(true);
    });

    test('a held file is named in diagnostics by the name it was held under', async () => {
        // Its URI is one this file invented, and a diagnostic about two files
        // naming one package quoted the invention back.
        const session = new OntologySession();
        await session.hold('a/b', sameOntology('package p\nkind Person'));
        const reported = await session.validateText(sameOntology('package p\nkind Other'));
        expect(reported.map(one => one.message).join(' ')).toContain('also declared in a/b');
        expect(reported.map(one => one.message).join(' ')).not.toContain('/held/');
    });

    test('two names that differ only in an unsafe character are two files', async () => {
        // `a/b` and `a?b` both became `a_b`, so one document answered to two
        // names and releasing either took the other with it.
        const session = new OntologySession();
        await session.hold('a/b', 'package one\nkind X');
        await session.hold('a?b', sameOntology('package two\nkind Y'));
        await session.release('a/b');
        expect(session.holding()).toEqual([{ name: 'a?b', lines: 2 }]);
        const reported = await session.validateText(sameOntology('use two\npackage z\nsubkind W specializes two.Y'));
        expect(reported.some(one => /Could not resolve/.test(one.message))).toBe(false);
    });

    test('an ontology is held as its ontology file and the package files it bundles, in folders too', async () => {
        const session = new OntologySession();
        await session.hold('sales/orders', 'package sales in shop\nuse parties\nrole Customer specializes parties.Person');
        await session.hold('parties', 'package parties in shop\nkind Person');
        const entry = await session.hold('shop', 'ontology shop bundles\n    parties from <parties.tonto>\n    sales from <sales/orders.tonto>');
        expect(entry.filter(one => one.severity === 'error')).toEqual([]);
        const member = await session.hold('sales/orders', 'package sales in shop\nuse parties\nrole Customer specializes parties.Person');
        expect(member.filter(one => one.severity === 'error')).toEqual([]);
    });

    test('a held name cannot climb out of its folder', async () => {
        const session = new OntologySession();
        await session.hold('../outside', 'package one\nkind X');
        await session.hold('outside', 'package two\nkind Y');
        expect(session.holding().map(one => one.name)).toEqual(['../outside', 'outside']);
        await session.release('outside');
        expect(session.holding().map(one => one.name)).toEqual(['../outside']);
    });

    test('holding the same name twice is an edit to it, not a second copy', async () => {
        const session = new OntologySession();
        await session.hold('parties', sameOntology('package parties\nkind Person'));
        await session.hold('parties', sameOntology('package parties\nkind Person\nkind Company'));
        const reported = await session.validateText(sameOntology(
            'use parties\npackage billing\nrole Client specializes parties.Company'));
        expect(reported.filter(one => one.severity === 'error')).toEqual([]);
    });
});
