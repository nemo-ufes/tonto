import { beforeAll, describe, expect, test } from 'vitest';
import { URI } from 'langium';
import { VirtualFileSystemProvider } from 'langium/test';
import type { Diagnostic } from 'vscode-languageserver';
import { createTontoServices } from '../src/tonto-module.js';

/**
 * Regression tests for information derived by following resolved references.
 *
 * When a document changes, Langium re-links every dependent document *without
 * re-parsing it*, so those documents keep their AST nodes while the targets
 * their references point at change underneath. Anything cached against those
 * nodes has to be dropped, or a stale answer silently suppresses a
 * diagnostic -- these tests drive the real `update()` path, which is the only
 * way that shows up.
 */
const fileSystem = new VirtualFileSystemProvider();
// The files are one ontology, so that they can use one another: a draft of
// it, since no entry is written, which checks them together all the same.
const insertModel = (uri: URI, source: string): void => {
    fileSystem.insert(uri, source.replace(/^(package [\w.]+)$/m, '$1 in incremental'));
};
const services = createTontoServices({ fileSystemProvider: () => fileSystem });
const workspace = services.shared.workspace;

const baseUri = URI.file('/base.tonto');
const dependentUri = URI.file('/dependent.tonto');

const dependent = 'use base\npackage dependent\nrole Student specializes base.Person\n';

async function writeBase(content: string): Promise<void> {
    insertModel(baseUri, content);
    await workspace.DocumentBuilder.update([baseUri], []);
}

function errorsOfDependent(): string[] {
    const document = workspace.LangiumDocuments.getDocument(dependentUri);
    return (document?.diagnostics ?? [])
        .filter((d: Diagnostic) => d.severity === 1)
        .map((d: Diagnostic) => d.message);
}

describe('incremental rebuilds', () => {
    beforeAll(async () => {
        insertModel(baseUri, 'package base\nkind Person\n');
        insertModel(dependentUri, dependent);
        await workspace.WorkspaceManager.initializeWorkspace([
            { name: 'root', uri: URI.file('/').toString() }
        ]);
    });

    test('starts clean', () => {
        expect(errorsOfDependent(), errorsOfDependent().join('\n')).toHaveLength(0);
    });

    test('re-checks a dependent when its supertype changes stereotype', async () => {
        // A category is not an ultimate sortal, so Student loses its identity
        // provider -- but only ancestry recomputed from the *new* AST shows it.
        await writeBase('package base\ncategory Person of relators\n');
        expect(errorsOfDependent().some(m => /draws identity from exactly one ultimate sortal/.test(m)),
            errorsOfDependent().join('\n')).toBe(true);
    });

    test('clears the diagnostic when the supertype is restored', async () => {
        await writeBase('package base\nkind Person\n');
        expect(errorsOfDependent(), errorsOfDependent().join('\n')).toHaveLength(0);
    });

    test('re-checks a dependent when the supertype is renamed away', async () => {
        await writeBase('package base\nkind Human\n');
        expect(errorsOfDependent().some(m => /Could not resolve reference/.test(m)),
            errorsOfDependent().join('\n')).toBe(true);
    });

    test('recovers once the name comes back', async () => {
        await writeBase('package base\nkind Person\n');
        expect(errorsOfDependent(), errorsOfDependent().join('\n')).toHaveLength(0);
    });

    test('a generalization set in another document states an edge all the same', async () => {
        // Nothing in /dependent.tonto says Student specializes an Organization;
        // a genset in a third file does, and ancestry has to see it or the two
        // ultimate sortals in Student's lineage go unreported.
        const gensetUri = URI.file('/genset.tonto');
        insertModel(baseUri, 'package base\nkind Person\nkind Organization\n');
        insertModel(gensetUri,
            'use dependent\nuse base\npackage sets\ngenset Odd where dependent.Student specializes base.Organization\n');
        await workspace.DocumentBuilder.update([baseUri, gensetUri], []);

        expect(errorsOfDependent().some(m => /specializes more than one ultimate sortal/.test(m)),
            errorsOfDependent().join('\n')).toBe(true);
    });

    test('and stops stating it once the dependent is rebuilt', async () => {
        // Dropping the set does not itself rebuild /dependent.tonto: Langium
        // rebuilds documents that reference a changed one, and this reference
        // runs the other way. The edge is seen whenever validation runs, but
        // what makes it run is a change the dependent can see -- the same
        // asymmetry the workspace-wide UFO checks have.
        insertModel(URI.file('/genset.tonto'), 'package sets\n');
        insertModel(baseUri, 'package base\nkind Person\nkind Organization\n');
        await workspace.DocumentBuilder.update([URI.file('/genset.tonto'), baseUri], []);
        expect(errorsOfDependent(), errorsOfDependent().join('\n')).toHaveLength(0);
    });

    describe('evidence that lives in another file', () => {
        // The checks that read what points *at* a class -- a relator's
        // mediations, a moment's bearer, a role's relator -- put the
        // diagnostic in one file and its evidence in another, so a change to
        // the evidence has to reach back.
        const roleUri = URI.file('/role.tonto');
        const relatorUri = URI.file('/relator.tonto');
        const mediating = 'use roles\npackage rel\nrelator Enrollment {\n'
            + '@mediation [0..*] -- [1] (const) roles.Student\n'
            + '@mediation [0..*] -- [1] (const) roles.Person\n}\n';

        const hintsOnTheRole = (): string[] =>
            (workspace.LangiumDocuments.getDocument(roleUri)?.diagnostics ?? [])
                .filter((d: Diagnostic) => d.code === 'role-without-relator')
                .map((d: Diagnostic) => d.message);

        test('is found when the workspace opens', async () => {
            insertModel(roleUri, 'package roles\nkind Person\nrole Student specializes Person\n');
            insertModel(relatorUri, mediating);
            await workspace.DocumentBuilder.update([roleUri, relatorUri], []);
            expect(hintsOnTheRole()).toEqual([]);
        });

        test('and its loss reaches the file that needed it', async () => {
            insertModel(relatorUri, 'use roles\npackage rel\nkind Other\n');
            await workspace.DocumentBuilder.update([relatorUri], []);
            expect(hintsOnTheRole()).toHaveLength(1);
        });

        test('and so does its return, which is the half Langium cannot see', async () => {
            // Nothing in /role.tonto references /relator.tonto, so the default
            // affected set is empty and the hint would have stood for ever.
            insertModel(relatorUri, mediating);
            await workspace.DocumentBuilder.update([relatorUri], []);
            expect(hintsOnTheRole()).toEqual([]);
        });

        test('and a deleted file is a loss like any other', async () => {
            insertModel(relatorUri, mediating);
            await workspace.DocumentBuilder.update([relatorUri], []);
            expect(hintsOnTheRole()).toEqual([]);
            await workspace.DocumentBuilder.update([], [relatorUri]);
            expect(hintsOnTheRole()).toHaveLength(1);
        });
    });

    describe('a set in a third document', () => {
        // The set names classes that live somewhere else, and is itself
        // somewhere else again -- so neither the class asked about nor its
        // supertypes have it in their own document.
        const kindsUri = URI.file('/kinds.tonto');
        const setsUri = URI.file('/sets.tonto');
        const usesUri = URI.file('/uses.tonto');

        const errorsOf = (uri: URI): string[] =>
            (workspace.LangiumDocuments.getDocument(uri)?.diagnostics ?? [])
                .filter((d: Diagnostic) => d.severity === 1)
                .map((d: Diagnostic) => String(d.code));

        test('declares the disjointness its specifics do not', async () => {
            insertModel(kindsUri,
                'package kinds\nkind Person\nsubkind Man specializes Person\nsubkind Woman specializes Person\n');
            insertModel(setsUri,
                'use kinds\npackage sets\ndisjoint genset sexes where kinds.Man, kinds.Woman specializes kinds.Person\n');
            insertModel(usesUri, 'use kinds\npackage uses\nrole Odd specializes kinds.Man, kinds.Woman\n');
            await workspace.DocumentBuilder.update([kindsUri, setsUri, usesUri], []);
            expect(errorsOf(usesUri)).toContain('disjoint-supertypes');
        });

        test('and stops declaring it when the set goes', async () => {
            insertModel(setsUri, 'package sets\n');
            await workspace.DocumentBuilder.update([setsUri], []);
            expect(errorsOf(usesUri)).toEqual([]);
        });
    });
});

/**
 * How far a change is followed.
 *
 * One hop was not enough. The evidence these checks read chains: a relator
 * mediates a role, and a sub-role of that role is a role with a relator
 * because of it. Editing the relator reached the role's file and stopped,
 * leaving the sub-role's file saying what it said before -- for as long as
 * nobody touched it, which could be for ever. And two files declaring one
 * package conflict without either referring to the other, so nothing
 * connected them at all.
 */
describe('a change reaches as far as it goes', () => {
    const services = createTontoServices({ fileSystemProvider: () => fileSystem });
    const built = services.shared.workspace;

    const write = async (files: Array<[string, string]>): Promise<void> => {
        for (const [name, text] of files) {
            insertModel(URI.file(name), text);
        }
        await built.DocumentBuilder.update(files.map(([name]) => URI.file(name)), []);
    };
    const codesOf = (name: string): string[] =>
        (built.LangiumDocuments.getDocument(URI.file(name))?.diagnostics ?? [])
            .map((diagnostic: Diagnostic) => String(diagnostic.code));

    test('to a sub-role two files away from the relator', async () => {
        await write([
            ['/hops-a.tonto', 'package hopsA\nkind Person\nkind Other\nrole Student specializes Person\n'],
            ['/hops-b.tonto', 'use hopsA\npackage hopsB\nrole GradStudent specializes hopsA.Student\n'],
            ['/hops-c.tonto', 'use hopsA\npackage hopsC\nrelator Enrollment {\n'
                + '  @mediation [1] -- [1] hopsA.Student\n  @mediation [1] -- [1] hopsA.Other\n}\n']
        ]);
        expect(codesOf('/hops-b.tonto')).not.toContain('role-without-relator');

        // The relator stops mediating the role. Neither the role's file nor
        // the sub-role's file is touched.
        await write([['/hops-c.tonto', 'use hopsA\npackage hopsC\nrelator Enrollment {\n'
            + '  @mediation [1] -- [1] hopsA.Other\n  @mediation [0..1] -- [1] hopsA.Other\n}\n']]);
        expect(codesOf('/hops-a.tonto')).toContain('role-without-relator');
        expect(codesOf('/hops-b.tonto')).toContain('role-without-relator');
    });

    test('and to two files declaring one package, which nothing connects', async () => {
        await write([
            ['/dup-a.tonto', 'package dup\nkind X\n'],
            ['/dup-b.tonto', 'package dup\nkind Y\n']
        ]);
        expect(codesOf('/dup-b.tonto')).toContain('duplicate-package-across-files');

        // Renaming one clears the other, which no reference reaches.
        await write([['/dup-a.tonto', 'package notDup\nkind X\n']]);
        expect(codesOf('/dup-b.tonto')).not.toContain('duplicate-package-across-files');
    });

    test('and to two files whose packages share a namespace, which nothing connects either', async () => {
        await write([
            ['/ns-a.tonto', '/// @namespace https://example.org/incremental#\npackage nsA\nkind Customer\n'],
            ['/ns-b.tonto', '/// @namespace https://example.org/incremental#\npackage nsB\nkind Invoice\n']
        ]);
        expect(codesOf('/ns-a.tonto')).not.toContain('namespace-name-clash');

        // b comes to declare a Customer too: a hears of it, untouched.
        await write([['/ns-b.tonto', '/// @namespace https://example.org/incremental#\npackage nsB\nkind Customer\n']]);
        expect(codesOf('/ns-a.tonto')).toContain('namespace-name-clash');

        // Renaming the classifier clears it; changing namespace alone no
        // longer splits packages into separate ontologies.
        await write([['/ns-b.tonto', '/// @namespace https://example.org/incremental#\npackage nsB\nkind Invoice\n']]);
        expect(codesOf('/ns-a.tonto')).not.toContain('namespace-name-clash');
    });
});
