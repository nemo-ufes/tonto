import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AstUtils, EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import type { LangiumDocument } from 'langium';
import { CodeActionKind, CompletionItemKind, DiagnosticSeverity } from 'vscode-languageserver';
import type { Diagnostic } from 'vscode-languageserver';
import { createTontoServices } from '../src/tonto-module.js';
import { TontoSession } from '../src/api.js';
import { RELATION_NATURE_TABLE, TONTO_NATURE_NAMES } from '../src/validation/relation-nature-table.js';
import { IMMUTABLE_NATURES as IMMUTABLE } from '../src/validation/relation-nature-checks.js';
import type { Model } from '../src/generated/ast.js';
import { isRelation } from '../src/generated/ast.js';
import { defaultStereotypeFor } from '../src/validation/default-stereotype.js';
import { inOntologyInPlace, withoutOntology } from './in-ontology.js';

const all = createTontoServices(EmptyFileSystem);
const services = all.Tonto;

// Two of the quick fixes below answer anti-pattern diagnostics, which are off
// unless `tonto.antiPatterns` is set -- this is the notification an editor
// sends on startup and whenever the setting changes.
all.shared.workspace.ConfigurationProvider.updateConfiguration({ settings: { tonto: { antiPatterns: true } } });
const parseSource = parseHelper<Model>(services);
const parseDocument = (source: string, options?: Parameters<typeof parseSource>[1]): ReturnType<typeof parseSource> =>
    parseSource(inOntologyInPlace(source), options);
async function reparse(...args: Parameters<typeof parseDocument>): ReturnType<typeof parseDocument> {
    await all.shared.workspace.DocumentBuilder.update([], all.shared.workspace.LangiumDocuments.all
        .filter(doc => doc.uri.scheme === 'file').map(doc => doc.uri).toArray());
    return parseDocument(...args);
}
beforeEach(async () => {
    await all.shared.workspace.DocumentBuilder.update([], all.shared.workspace.LangiumDocuments.all
        .filter(doc => doc.uri.scheme === 'file').map(doc => doc.uri).toArray());
});

let packageCounter = 0;
function parse(source: string): ReturnType<typeof parseDocument> {
    return parseDocument(source.replace(/\bpackage p\b/g, `package p${++packageCounter}`), { validation: true });
}

/** Offset of the first occurrence of `needle`, plus an optional delta. */
function offsetOf(document: LangiumDocument, needle: string, delta = 0): { line: number; character: number } {
    const text = document.textDocument.getText();
    const index = text.indexOf(needle);
    if (index < 0) {
        throw new Error(`"${needle}" not found`);
    }
    return document.textDocument.positionAt(index + delta);
}

async function hoverAt(document: LangiumDocument, needle: string, delta = 0): Promise<string> {
    const hover = await services.lsp.HoverProvider!.getHoverContent(document, {
        textDocument: { uri: document.textDocument.uri },
        position: offsetOf(document, needle, delta)
    });
    const contents = hover?.contents;
    return contents && typeof contents === 'object' && 'value' in contents ? contents.value : '';
}

async function completeAt(document: LangiumDocument, needle: string, delta = 0) {
    const list = await services.lsp.CompletionProvider!.getCompletion(document, {
        textDocument: { uri: document.textDocument.uri },
        position: offsetOf(document, needle, delta)
    });
    return list?.items ?? [];
}

/** Completion at the very end of the document, i.e. at a fresh declaration. */
async function completeAtEnd(document: LangiumDocument) {
    const text = document.textDocument.getText();
    const list = await services.lsp.CompletionProvider!.getCompletion(document, {
        textDocument: { uri: document.textDocument.uri },
        position: document.textDocument.positionAt(text.length)
    });
    return list?.items ?? [];
}

/** The document text with the first action's edits applied, to check the result. */
function applyFirst(document: LangiumDocument, actions: { edit?: { changes?: Record<string, { range: { start: unknown; end: unknown }; newText: string }[]> } }[]): string {
    const edits = Object.values(actions[0].edit!.changes!)[0];
    const text = document.textDocument.getText();
    const offsets = edits
        .map(e => ({ start: document.textDocument.offsetAt(e.range.start as never), end: document.textDocument.offsetAt(e.range.end as never), newText: e.newText }))
        .sort((a, b) => b.start - a.start);
    return offsets.reduce((acc, e) => acc.slice(0, e.start) + e.newText + acc.slice(e.end), text);
}

async function fixesFor(document: LangiumDocument, code: string) {
    const diagnostics = (document.diagnostics ?? []).filter((d: Diagnostic) => d.code === code);
    expect(diagnostics.length, `no diagnostic with code ${code}`).toBeGreaterThan(0);
    const actions = await services.lsp.CodeActionProvider!.getCodeActions(document, {
        textDocument: { uri: document.textDocument.uri },
        range: diagnostics[0].range,
        context: { diagnostics }
    });
    // The repairs for that diagnostic, which is what these tests are about.
    // A request naming no kind is answered with the file's source actions
    // too -- `source.fixAll` and the rest -- and those have their own tests.
    return (actions ?? []).filter(action => 'kind' in action && action.kind === CodeActionKind.QuickFix);
}

describe('hover', () => {
    beforeAll(async () => {
        await all.shared.workspace.WorkspaceManager.initializeWorkspace([]);
    });

    test('computes a card for a class even without a doc comment', async () => {
        const document = await parse(`
            package p
            kind Person of functional-complexes
            role Student specializes Person
        `);
        const hover = await hoverAt(document, 'role Student', 5);
        expect(hover).toContain('**role** `Student`');
        expect(hover).toContain('*specializes* `Person`');
        // The identity provider is several hops away in real models; surfacing
        // it is the main reason this provider exists.
        expect(hover).toContain('*identity from* `Person`');
    });

    test('still shows the doc comment, after the computed facts', async () => {
        const document = await parse(`
            package p
            /** A human being. */
            kind Person
        `);
        const hover = await hoverAt(document, 'kind Person', 5);
        expect(hover).toContain('**kind** `Person`');
        expect(hover).toContain('A human being.');
    });

    test('describes a relation with its signature', async () => {
        const document = await parse(`
            package p
            kind Person
            kind Course
            relation Person [0..*] -- enrolsIn -- [1..*] Course
        `);
        const hover = await hoverAt(document, 'enrolsIn', 2);
        expect(hover).toContain('**relation** `enrolsIn`');
        expect(hover).toContain('[0..*]');
        expect(hover).toContain('Course');
    });

    test('describes an attribute with its type and flags', async () => {
        const document = await parse(`
            package p
            kind Person { age: derived number }
        `);
        // "age" also occurs inside "package", so anchor on the declaration.
        const hover = await hoverAt(document, 'age: derived number', 1);
        expect(hover).toContain('**attribute** `age`');
        expect(hover).toContain('derived');
    });

    test('shows every association touching a class, wherever it is written', async () => {
        const people = await parseDocument([
            'package hoverPeople in hoverdraft',
            'kind Person {',
            '    [*] -- knows -- [*] Person',
            '}',
            'kind Organization'
        ].join('\n'), { validation: true });
        await parseDocument([
            'use hoverPeople',
            'package hoverWork in hoverdraft',
            'kind Employment {',
            '    [1] -- employee -- [1] hoverPeople.Person',
            '}',
            'relation hoverPeople.Organization [*] -- employs -- [*] hoverPeople.Person'
        ].join('\n'), { validation: true });

        const hover = await hoverAt(people, 'kind Person', 5);
        expect(hover).toContain('Person [*] -- knows -- [*] Person');
        expect(hover).toContain('Employment [1] -- employee -- [1] hoverPeople.Person');
        expect(hover).toContain('Organization [*] -- employs -- [*] hoverPeople.Person');
        expect(hover.match(/-- knows --/g)).toHaveLength(1);
    });
});

describe('documentation comments', () => {
    test('a run of "///" lines above a declaration is its documentation', async () => {
        const document = await parse([
            'package p',
            '/// A person, in the everyday sense.',
            '///',
            '/// Identity comes from the individual, not from any role they play.',
            'kind Person'
        ].join('\n'));
        const hover = await hoverAt(document, 'kind Person', 5);
        expect(hover).toContain('A person, in the everyday sense.');
        expect(hover).toContain('Identity comes from the individual');
        // The blank `///` line survives as a paragraph break.
        expect(hover).toContain('sense.\n\nIdentity');
    });

    test('an ordinary "//" comment is not documentation', async () => {
        const document = await parse('package p\n// a note to the reader\nkind Person');
        expect(await hoverAt(document, 'kind Person', 5)).not.toContain('a note to the reader');
    });

    test('a blank line ends the run, so the prose was about something else', async () => {
        const document = await parse('package p\n/// Not about this.\n\nkind Person');
        expect(await hoverAt(document, 'kind Person', 5)).not.toContain('Not about this');
    });

    test('and only the run directly above is taken', async () => {
        const document = await parse('package p\n/// About A.\nkind A\n/// About B.\nkind B');
        const hover = await hoverAt(document, 'kind B', 5);
        expect(hover).toContain('About B.');
        expect(hover).not.toContain('About A.');
    });

    test('members are documented the same way', async () => {
        const document = await parse([
            'package p',
            'datatype date',
            'kind Person {',
            '    /// When they were born.',
            '    birthDate: const date',
            '}'
        ].join('\n'));
        expect(await hoverAt(document, 'birthDate: const date', 1)).toContain('When they were born.');
    });

    test('a block comment still documents, so nothing written before this breaks', async () => {
        const document = await parse('package p\n/** A human being. */\nkind Person');
        expect(await hoverAt(document, 'kind Person', 5)).toContain('A human being.');
    });

    test('a tag says the same thing in another language', async () => {
        const document = await parse([
            'package p',
            '/// A person, in the everyday sense.',
            '///',
            '/// @label Person',
            '/// @label:pt-br Pessoa',
            '/// @pt-br Uma pessoa, no sentido corrente.',
            '/// Segunda linha, ainda em português.',
            'kind Person'
        ].join('\n'));
        const hover = await hoverAt(document, 'kind Person', 5);
        expect(hover).toContain('A person, in the everyday sense.');
        expect(hover).toContain('Person · *pt-br* Pessoa');
        // The tag stays open, so the untagged line after it is part of it.
        expect(hover).toContain('*pt-br* — Uma pessoa, no sentido corrente.\nSegunda linha');
    });

    test('a line beginning with "@" is prose unless it names a tag', async () => {
        const document = await parse('package p\n/// @mediation is the stereotype to use here.\nkind Person');
        const hover = await hoverAt(document, 'kind Person', 5);
        expect(hover).toContain('@mediation is the stereotype to use here.');
    });

    test('and a label block says what "@label" says', async () => {
        const document = await parse('package p\nkind Person {\nlabel { @en "Person" }\ndescription { @en "A human being." }\n}');
        const hover = await hoverAt(document, 'kind Person', 5);
        expect(hover).toContain('*en* Person');
        expect(hover).toContain('*en* — A human being.');
    });

    test('the documentation reaches completion proposals', async () => {
        // The reason for the convention: what a name means travels with the
        // name, to whoever is choosing between them.
        const document = await parse('package p\n/// The kind every person draws identity from.\nkind Person\nrole Student specializes ');
        const item = (await completeAtEnd(document)).find(each => each.label === 'Person');
        expect(item?.documentation).toEqual({
            kind: 'markdown',
            value: 'The kind every person draws identity from.'
        });
    });
});

describe('completion', () => {
    test('does not propose the declaration being written', async () => {
        const document = await parse(`
            package p
            kind Person
            role Student specializes Person
        `);
        const labels = (await completeAt(document, 'specializes Person', 12)).map(i => i.label);
        expect(labels).toContain('Person');
        expect(labels).not.toContain('Student');
    });

    test('does not offer both the simple and package-qualified spelling', async () => {
        const document = await parse(`
            package p
            kind Person
            role Student specializes Person
        `);
        const labels = (await completeAt(document, 'specializes Person', 12)).map(i => i.label);
        expect(labels.filter(l => String(l).endsWith('Person'))).toEqual(['Person']);
    });

    describe('supertype proposals', () => {
        const universe = `
            kind Person
            collective Crowd
            relator Marriage
            subkind Undergrad specializes Person
            role Employee specializes Person
            category Agent of functional-complexes
            category SocialThing of relators
            mixin Mixed
            roleMixin Customer
            event Meeting
            class Unspecified
        `;

        /** Class names proposed after `<decl> specializes |`. */
        async function supertypesFor(declaration: string): Promise<string[]> {
            const source = `package p\n${universe}\n${declaration} specializes `;
            const document = await parseDocument(source.replace(/\bpackage p\b/g, `package p${++packageCounter}`));
            const list = await services.lsp.CompletionProvider!.getCompletion(document, {
                textDocument: { uri: document.textDocument.uri },
                position: document.textDocument.positionAt(document.textDocument.getText().length)
            });
            // Cross-reference proposals carry the target type as `detail`;
            // filtering on CompletionItemKind would not distinguish them from
            // other reference completions.
            return (list?.items ?? [])
                .filter(item => item.detail === 'ClassDeclaration')
                .map(item => String(item.label))
                .sort();
        }

        test('a category is only offered non-sortals', async () => {
            const proposals = await supertypesFor('category A');
            expect(proposals).toEqual(['Agent', 'Mixed', 'SocialThing', 'Unspecified']);
        });

        test('a kind is only offered non-sortals of a compatible nature', async () => {
            const proposals = await supertypesFor('kind K');
            // SocialThing is a category of relators, so a kind cannot sit under it.
            expect(proposals).toEqual(['Agent', 'Mixed', 'Unspecified']);
        });

        test('a relator is not offered a functional-complex category', async () => {
            const proposals = await supertypesFor('relator R');
            expect(proposals).toContain('SocialThing');
            expect(proposals).not.toContain('Agent');
        });

        test('an event is offered non-sortals, not other events', async () => {
            // Events form no taxonomy among themselves; a
            // specialization of an event is a subkind.
            expect(await supertypesFor('event E')).toEqual(['Mixed', 'Unspecified']);
        });

        test('a subkind is offered ultimate sortals but not anti-rigid types', async () => {
            const proposals = await supertypesFor('subkind S');
            expect(proposals).toContain('Person');
            expect(proposals).toContain('Crowd');
            // A subkind is rigid, so it cannot specialize a role.
            expect(proposals).not.toContain('Employee');
        });

        test('a role may specialize anti-rigid types', async () => {
            expect(await supertypesFor('role R2')).toContain('Employee');
        });

        test('a plain "class" is tolerated everywhere, and tolerates everything', async () => {
            expect(await supertypesFor('kind K2')).toContain('Unspecified');
            expect(await supertypesFor('class Anything')).toContain('Marriage');
        });

        test('an ultimate sortal is never offered another ultimate sortal', async () => {
            const proposals = await supertypesFor('kind K3');
            for (const ultimateSortal of ['Person', 'Crowd', 'Marriage']) {
                expect(proposals).not.toContain(ultimateSortal);
            }
        });
    });

    test('offers construct snippets where the keyword is legal', async () => {
        const document = await parse('package p\nkind Person\n');
        const items = await completeAtEnd(document);
        const snippets = items.filter(i => i.kind === CompletionItemKind.Snippet);
        expect(snippets.length).toBeGreaterThan(0);
        expect(snippets.map(s => s.label)).toContain('genset (short form)');
        expect(snippets.every(s => s.insertTextFormat === 2)).toBe(true);
    });

    test('publication snippets distinguish ontology files, package files, imports and package uses', async () => {
        const atStart = await completeAtEnd(await parse(''));
        const snippet = (items: typeof atStart, label: string): string | undefined =>
            items.find(item => item.kind === CompletionItemKind.Snippet && item.label === label)?.insertText;
        expect(snippet(atStart, 'ontology (one-file)')).toContain('/// @namespace');
        expect(snippet(atStart, 'ontology (with inline package)')).toContain('ontology ${2:model}');
        expect(snippet(atStart, 'package (package file)')).toContain('in ${2:model}');
        expect(snippet(atStart, 'import (ontology)')).toContain(' from <');
        expect(snippet(atStart, 'use (package)')).toContain('use ${1:core}');
        const afterHeader = await completeAtEnd(await parse('ontology shop '));
        expect(snippet(afterHeader, 'bundles (relative source)')).toContain('from <${2:core.tonto}>');
    });
});

describe('quick fixes', () => {
    test('removes an unnecessary use, whole line', async () => {
        // Two documents of one ontology, so that the use reaches across them.
        await parse(`
            package unusedByOther in unuseddraft
            kind Ghost
        `);
        const document = await parse(`use unusedByOther
package p in unuseddraft
kind A
`);
        const actions = await fixesFor(document, 'unnecessary-use');
        expect(actions.map(a => a.title)).toContain('Remove this "use"');
        const edit = Object.values(actions[0].edit!.changes!)[0][0];
        expect(edit.newText).toBe('');
        expect(edit.range.start).toEqual({ line: 0, character: 0 });
        expect(edit.range.end).toEqual({ line: 1, character: 0 });
    });

    test('swaps inverted cardinality bounds', async () => {
        const document = await parse(`
            package p
            kind A
            kind B { [5..2] -- r -- [1] A }
        `);
        const actions = await fixesFor(document, 'multiplicity-inverted');
        expect(actions.map(a => a.title)).toContain('Swap bounds to [2..5]');
        expect(Object.values(actions[0].edit!.changes!)[0][0].newText).toBe('[2..5]');
    });

    test('restricts a relator end for RepRel', async () => {
        const document = await parse(`
            package p
            kind Person
            kind Company
            relator Employment {
                @mediation [0..*] -- [1] Person
                @mediation [0..*] -- [1] Company
            }
        `);
        const actions = await fixesFor(document, 'RepRel');
        expect(actions.map(a => a.title)).toContain('Restrict this relator end to [1]');
        expect(Object.values(actions[0].edit!.changes!)[0][0].newText).toBe('[1]');
    });

    test('offers every compatible ultimate sortal for a sortal missing one', async () => {
        const document = await parse(`
            package p
            kind Person
            collective Crowd
            category Abstraction
            role Student specializes Abstraction
        `);
        const actions = await fixesFor(document, 'sortal-without-ultimate-sortal');
        const titles = actions.map(a => a.title);
        expect(titles).toContain('Specialize "Person" (kind)');
        expect(titles).toContain('Specialize "Crowd" (collective)');
        // A category is not an ultimate sortal, so it is never a candidate.
        expect(titles.some(t => t.includes('Abstraction'))).toBe(false);
    });

    test('filters candidates by compatible ontological nature', async () => {
        const document = await parse(`
            package p
            kind Person
            collective Crowd
            quantity Water
            role Student of functional-complexes
        `);
        const titles = (await fixesFor(document, 'sortal-without-ultimate-sortal')).map(a => a.title);
        // Only a kind yields functional complexes -- as the one thing to
        // specialize, and as the one thing to become.
        expect(titles).toEqual(['Specialize "Person" (kind)', 'Change "Student" to kind']);
    });

    test('or the class is the ultimate sortal, which nothing in scope has to be', async () => {
        // Reported case. A model early on has written no kinds yet, so there
        // was nothing to specialize and nothing to do: the identity is the
        // class's own, and saying which is the repair.
        const document = await parse([
            'package p',
            'category Birth of events',
            'category Surgery of events',
            'subkind CaesareanBirth specializes Birth, Surgery'
        ].join('\n'));
        const actions = await fixesFor(document, 'sortal-without-ultimate-sortal');
        expect(actions.map(a => a.title)).toEqual(['Change "CaesareanBirth" to event']);
        expect(applyFirst(document, actions)).toContain('event CaesareanBirth specializes Birth, Surgery');
    });

    test('and the ultimate sortal offered is the one the natures fit', async () => {
        const objects = await parse('package p\ncategory Party of functional-complexes\nsubkind Company specializes Party');
        expect((await fixesFor(objects, 'sortal-without-ultimate-sortal')).map(a => a.title))
            .toEqual(['Change "Company" to kind']);
        // `objects` is three natures, so it settles nothing between them.
        const spanning = await parse('package p\ncategory Alive of objects\nsubkind Child specializes Alive');
        expect((await fixesFor(spanning, 'sortal-without-ultimate-sortal')).map(a => a.title))
            .toEqual(['Change "Child" to kind', 'Change "Child" to collective', 'Change "Child" to quantity']);
    });

    test('appends to an existing specializes list rather than duplicating the keyword', async () => {
        const document = await parse(`
            package p
            kind Person
            category Abstraction
            role Student specializes Abstraction
        `);
        const actions = await fixesFor(document, 'sortal-without-ultimate-sortal');
        const edit = Object.values(actions[0].edit!.changes!)[0][0];
        expect(edit.newText).toBe(', Person');
    });

    test('inserts before the class body when one is present', async () => {
        const document = await parse(`
            package p
            kind Person
            role Student {
                enrolled: boolean
            }
        `);
        const actions = await fixesFor(document, 'sortal-without-ultimate-sortal');
        const edit = Object.values(actions[0].edit!.changes!)[0][0];
        expect(edit.newText).toBe('specializes Person ');
    });

    test('appends at the end of a bodyless declaration', async () => {
        const document = await parse('package p\nkind Person\nrole Student\n');
        const actions = await fixesFor(document, 'sortal-without-ultimate-sortal');
        const edit = Object.values(actions[0].edit!.changes!)[0][0];
        expect(edit.newText).toBe(' specializes Person');
        expect(edit.range.start).toEqual(edit.range.end);
    });

    test('never proposes a candidate that would close a cycle', async () => {
        // Ancestor is a kind, but it already specializes Student, so
        // specializing it back would make a cycle.
        const document = await parse(`
            package p
            role Student
            kind Ancestor specializes Student
        `);
        const actions = await fixesFor(document, 'sortal-without-ultimate-sortal');
        expect(actions.map(a => a.title).some(t => t.includes('Ancestor'))).toBe(false);
    });

    test('offers ultimate sortals from imported packages, package-qualified', async () => {
        await parse(`
            package core in coredraft
            kind Person
        `);
        const document = await parse('use core\npackage p in coredraft\nrole Student\n');
        const titles = (await fixesFor(document, 'sortal-without-ultimate-sortal')).map(a => a.title);
        expect(titles).toContain('Specialize "core.Person" (kind)');
    });

    test('applying the fix resolves the diagnostic', async () => {
        // The strongest check available: apply the edit and re-validate.
        const source = 'package applied\nkind Person\nrole Student\n';
        const document = await parseDocument(source, { validation: true });
        const actions = await fixesFor(document, 'sortal-without-ultimate-sortal');
        const edit = Object.values(actions[0].edit!.changes!)[0][0];

        const offset = document.textDocument.offsetAt(edit.range.start);
        const text = document.textDocument.getText();
        const patched = text.slice(0, offset) + edit.newText + text.slice(offset);
        expect(patched).toContain('role Student specializes Person');

        const revalidated = await reparse(patched.replace('ontology applied', 'ontology applied2'), { validation: true });
        const remaining = (revalidated.diagnostics ?? []).filter(d => d.code === 'sortal-without-ultimate-sortal');
        expect(remaining, JSON.stringify(revalidated.diagnostics)).toHaveLength(0);
    });

    test('replaces a "*" lower bound', async () => {
        const document = await parse(`
            package p
            kind A
            kind B { [*..2] -- r -- [1] A }
        `);
        const actions = await fixesFor(document, 'multiplicity-star-lower');
        expect(actions.map(a => a.title)).toContain('Change to [0..2]');
    });

    test('does not replace an invalid star lower bound with an impossible zero upper bound', async () => {
        const document = await parse('package p\nkind Person { names: string [*..0] }');
        expect((await fixesFor(document, 'multiplicity-star-lower')).map(action => action.title)).toEqual([]);
    });

    test('removes an illegal specialization', async () => {
        const document = await parse(`
            package p
            kind K
            role A specializes K
            kind B specializes A
        `);
        const actions = await fixesFor(document, 'stereotype-cannot-specialize');
        // A kind cannot sit under a role, but a role can, so both repairs
        // are offered -- keeping the hierarchy first. The ultimate sortal
        // above `A` is what makes the restereotypes offerable: a base sortal
        // with none is answered with `sortal-without-ultimate-sortal`, and a
        // repair that leaves an error is not offered.
        expect(actions.map(a => a.title))
            .toEqual(['Change "B" to role', 'Change "B" to historicalRole', 'Remove "specializes A"']);
    });

    test('removes only the offending entry from a specialization list', async () => {
        const document = await parse(`
            package p
            category Fine
            role Bad
            kind B specializes Fine, Bad
        `);
        const actions = await fixesFor(document, 'stereotype-cannot-specialize');
        expect(actions.map(a => a.title)).toContain('Remove "Bad" from the specialization list');
    });

    test('removes an invalid datatype nature restriction', async () => {
        const document = await parse(`
            package p
            datatype D of events
        `);
        const actions = await fixesFor(document, 'datatype-nature-not-abstract');
        expect(actions.map(a => a.title)).toContain('Remove the nature restriction');
        expect(Object.values(actions[0].edit!.changes!)[0][0].newText).toBe('');
    });

    test('removes a duplicate attribute', async () => {
        const document = await parse(`
            package p
            kind A {
                name: string
                name: string
            }
        `);
        const actions = await fixesFor(document, 'duplicate-member');
        expect(actions.map(a => a.title)).toContain('Remove the duplicate declaration');
    });

    test('removes a duplicate enum literal with its comma', async () => {
        const document = await parse(`
            package p
            enum E { red, red }
        `);
        const actions = await fixesFor(document, 'duplicate-member');
        expect(actions.map(a => a.title)).toContain('Remove the duplicate literal "red"');
    });

    test('retypes an instanceOf target as a type', async () => {
        const document = await parse(`
            package p
            kind NotAType
            kind A (instanceOf NotAType)
        `);
        // Its own code: the categorizer rule keeps `categorizer-not-higher-order`.
        const actions = await fixesFor(document, 'instance-of-not-higher-order');
        expect(actions.map(a => a.title)).toContain('Make "NotAType" a type');
        expect(Object.values(actions[0].edit!.changes!)[0][0].newText).toBe('type');
    });

    test('adds the suggested relation specialization for RelSpec', async () => {
        const document = await parse(`
            package p
            kind Person
            kind Vehicle
            role Driver specializes Person
            relation Person -- uses -- [0..*] Vehicle
            relation Driver -- drives -- [0..*] Vehicle
        `);
        const actions = await fixesFor(document, 'RelSpec');
        expect(actions.map(a => a.title)).toContain('Specialize "Person.uses"');
        expect(Object.values(actions[0].edit!.changes!)[0][0].newText).toBe(' specializes Person.uses');
    });

    test('offers both sides when widening a parent\'s nature restriction', async () => {
        // Either the child or the parent is wrong and only the modeler knows,
        // which is a reason to offer both repairs rather than neither.
        const document = await parse(`
            package p
            category A of functional-complexes
            category B of functional-complexes, collectives specializes A
        `);
        const diagnostics = document.diagnostics ?? [];
        const actions = await services.lsp.CodeActionProvider!.getCodeActions(document, {
            textDocument: { uri: document.textDocument.uri },
            range: diagnostics[0].range,
            context: { diagnostics }
        });
        expect((actions ?? []).map(a => (a as { title: string }).title)).toEqual([
            'Remove specialization of "A" (functional-complexes)',
            'Remove the nature restriction'
        ]);
    });
});

describe('semantic tokens', () => {
    test('classifies stereotypes, names, types and cardinalities', async () => {
        const document = await parse(`
            package p
            kind Person { age: number [0..1] }
        `);
        const tokens = await services.lsp.SemanticTokenProvider!.semanticHighlight(document, {
            textDocument: { uri: document.textDocument.uri }
        });
        // Five integers per token; a handful of distinct kinds should be present.
        expect(tokens.data.length % 5).toBe(0);
        expect(tokens.data.length / 5).toBeGreaterThan(5);
        const types = new Set<number>();
        for (let i = 3; i < tokens.data.length; i += 5) {
            types.add(tokens.data[i]);
        }
        expect(types.size).toBeGreaterThan(2);
    });
});

describe('completion narrows to what is admissible', () => {
    test('an "of" clause offers only natures the stereotype takes', async () => {
        expect((await completeAtEnd(await parse('package p\nkind A of '))).map(i => i.label))
            .toEqual(['functional-complexes']);
        expect((await completeAtEnd(await parse('package p\nevent E of '))).map(i => i.label))
            .toEqual(['events']);
        expect((await completeAtEnd(await parse('package p\ndatatype D of '))).map(i => i.label))
            .toEqual(['abstract-individuals']);
        // A category commits to nothing, so nothing is withheld from it.
        expect((await completeAtEnd(await parse('package p\ncategory C of '))).length).toBeGreaterThan(10);
    });

    test('"instanceOf" offers only classes whose instances are types', async () => {
        const document = await parse('package p\ntype T\nkind A\nkind B (instanceOf ');
        expect((await completeAtEnd(document)).map(i => i.label)).toEqual(['T']);
    });

    test('a stereotype proposal carries what it relates', async () => {
        const items = await completeAtEnd(await parse('package p\nrelator R {\n@'));
        // `@mediation` has a snippet, which carries more than the word does;
        // the rest of the vocabulary is proposed with its signature.
        expect(items.find(i => i.label === '@manifestation')?.detail).toBe('aspect → perdurant');
        expect(items.find(i => i.label === '@mediation (with ends)')?.kind).toBe(CompletionItemKind.Snippet);
        // And the plain word stands beside its snippet, or `@medi` could not
        // complete to the stereotype it is plainly heading for.
        expect(items.find(i => i.label === '@mediation')?.detail).toBe('relator → endurant');
        // Written with the `@`, or the prefix already typed excludes it.
        expect(items.filter(i => i.label.startsWith('@')).length).toBeGreaterThan(20);
    });

    test('and says where the class cannot open one', async () => {
        // The word stays proposable -- `@medi` is heading somewhere -- but a
        // kind does not mediate, and the list says so rather than pretending.
        const items = await completeAtEnd(await parse('package p\nkind A {\n@'));
        expect(items.find(i => i.label === '@mediation')?.detail)
            .toBe('relator → endurant -- not from a "kind"');
        expect(items.find(i => i.label === '@componenthood')?.detail)
            .toBe('functional-complex → functional-complex');
        expect(items.map(i => i.label)).not.toContain('@mediation (with ends)');
    });

    test('a class stereotype proposal says what it is', async () => {
        const kind = (await completeAtEnd(await parse('package p\n'))).find(i => i.label === 'kind');
        expect(kind?.detail).toBe('ultimate-sortal, rigid');
        expect(kind?.documentation).toEqual({
            kind: 'markdown',
            value: '**kind** — ultimate-sortal, rigid\n\n*classifies* functional-complexes\n\n*may specialize* category, mixin'
        });
    });

    test('a stereotype word is not proposed where a name is being written', async () => {
        // The disruptive case: an editor that accepts a suggestion on Enter
        // turned `kind Boat` + Enter into `kind bringingAbout`, because
        // `bringingAbout` is a legal name and so a legal continuation.
        expect(await completeAtEnd(await parse('package p\nkind Bo'))).toEqual([]);
        expect(await completeAtEnd(await parse('package p\nkind Boat'))).toEqual([]);
        expect(await completeAtEnd(await parse('package p\nkind Person\nrole Stu'))).toEqual([]);
        expect(await completeAtEnd(await parse('package p\nkind '))).toEqual([]);
        expect(await completeAtEnd(await parse('package p\ndatatype string\nkind A {\n  wheels'))).toEqual([]);
        // Still proposed where the word is a stereotype rather than a name.
        expect((await completeAtEnd(await parse('package p\nkind A {\n@mate'))).map(i => i.label))
            .toContain('@material');
    });

    test('and the editor does not fill the silence with words from the file', async () => {
        // The half the language server cannot do alone. With nothing proposed
        // at a name, VS Code falls back to words already in the file, and in
        // `package animals` Enter after `kind Animal` accepted `animals`.
        expect(await completeAtEnd(await parse('package animals\nkind Animal'))).toEqual([]);
        const manifest = JSON.parse(readFileSync(
            resolve(import.meta.dirname, '../../extension/package.json'), 'utf8'));
        expect(manifest.contributes.configurationDefaults['[tonto]']['editor.wordBasedSuggestions']).toBe('off');
    });

    test('and a name being written does not lose the proposals that are about names', async () => {
        expect((await completeAtEnd(await parse('package p\nkind Person\nrole Student specializes Per'))).map(i => i.label))
            .toEqual(['Person']);
        expect((await completeAtEnd(await parse('package p\ndatatype date\nkind K {\n  born: da'))).map(i => i.label))
            .toContain('date');
    });

    test('inside a "///" line the tags are proposed, in the languages the document writes', async () => {
        expect(services.lsp.CompletionProvider!.completionOptions?.triggerCharacters).toContain('@');
        const document = await parse('package p\n/// @pt-br Uma pessoa.\nkind Person\n/// @');
        expect((await completeAtEnd(document)).map(i => i.label))
            .toEqual(['@label', '@label:en', '@label:pt-br', '@en', '@pt-br']);

        const bare = await parse('package p\n/// ');
        const proposals = await completeAtEnd(bare);
        expect(proposals.map(i => i.label))
            .toEqual(['@label', '@label:en', '@label:pt-br', '@en', '@pt-br']);
        expect(proposals[0].textEdit).toEqual({
            range: { start: { line: 1, character: 4 }, end: { line: 1, character: 4 } },
            newText: '@label'
        });
    });
});

describe('completion at relation positions', () => {
    /** Cross-reference proposals at the end of a snippet. */
    async function referencesAtEnd(source: string): Promise<string[]> {
        const document = await parseDocument(source.replace(/\bpackage p\b/g, `package p${++packageCounter}`));
        const list = await services.lsp.CompletionProvider!.getCompletion(document, {
            textDocument: { uri: document.textDocument.uri },
            position: document.textDocument.positionAt(document.textDocument.getText().length)
        });
        return (list?.items ?? [])
            .filter(item => item.detail && item.detail !== 'Keyword')
            .map(item => String(item.label));
    }

    const universe = 'package p\nkind Person\nkind Car\ncollective Team\n';

    // Langium could not derive the reference type at these positions, so
    // completion silently produced nothing at all.
    /** Every proposal, keywords included. */
    async function allAtEnd(source: string): Promise<string[]> {
        const document = await parseDocument(source.replace(/\bpackage p\b/g, `package p${++packageCounter}`));
        const list = await services.lsp.CompletionProvider!.getCompletion(document, {
            textDocument: { uri: document.textDocument.uri },
            position: document.textDocument.positionAt(document.textDocument.getText().length)
        });
        return (list?.items ?? []).map(item => String(item.label));
    }

    describe('and nothing else is proposed until the class at the end is written', () => {
        // Reported case. The target is optional in the grammar so that a
        // half-written relation still parses, and the price was that
        // everything which may follow a *finished* relation was proposed
        // where the finishing had not happened: `specializes`, `inverseOf`,
        // and every class-body proposal, after `[0..1]`.
        test('after a multiplicity, only the classes admissible there', async () => {
            const labels = await allAtEnd(universe + 'quantity LumpOfSteel {\n@constitution [1] -- [0..1] ');
            expect(labels).not.toContain('specializes');
            expect(labels).not.toContain('inverseOf');
            expect(labels).not.toContain('attribute');
            expect(labels.filter(label => label.startsWith('@'))).toEqual([]);
        });

        test('and after the class, what may follow one', async () => {
            const labels = await allAtEnd(universe + 'kind Statue {\n@constitution [1] -- [0..1] Person ');
            expect(labels).toContain('specializes');
            expect(labels).toContain('inverseOf');
        });

        test('but a body written under an unfinished relation is an ordinary place', async () => {
            // The suppression is for the relation's own line: on the next one
            // the class body is what is being written.
            const labels = await allAtEnd(universe + 'kind Statue {\n@constitution [1] -- [0..1]\n');
            expect(labels).toContain('attribute');
        });
    });

    describe('and a proposal has to be able to stand where it is offered', () => {
        // Reported case: the list was everything the parser would accept,
        // which is not the same as everything a modeler can write.
        test('a comment holds prose, so nothing is proposed inside one', async () => {
            expect(await allAt('package p\n// a note \u2038\nkind Person')).toEqual([]);
            expect(await allAt('package p\n/// what it is \u2038\nkind Person')).toEqual([]);
            expect(await allAt('package p\n/* a note \u2038 */\nkind Person')).toEqual([]);
        });

        test('a package takes a name, and the name is the writer\u2019s', async () => {
            // The name is optional in the grammar only so that a half-written
            // `package ` still parses; the parser will take a declaration
            // straight after the keyword, and all forty were proposed.
            expect(await allAtEnd('package ')).toEqual([]);
            expect(await allAtEnd('global package ')).toEqual([]);
        });

        test('a declaration begins a line, so its header proposes what continues it', async () => {
            expect(await allAtEnd(universe + 'kind Person ')).toEqual(['of', 'isPowerType', 'specializes']);
            expect(await allAtEnd(universe + 'category Agent ')).toEqual(['of', 'isPowerType', 'specializes']);
        });

        test('and a historical role\u2019s header proposes its derivation too', async () => {
            expect(await allAtEnd(universe + 'historicalRole Graduate ')).toContain('derivedFrom');
        });

        test('and a member begins one too', async () => {
            const blank = await allAtEnd(universe + 'kind Person {\n');
            expect(blank).toContain('attribute');
            expect(blank).toContain('@componenthood (with ends)');
            // Past the colon the attribute is under way, and a snippet writing
            // a second member alongside it is noise.
            const written = await allAtEnd(universe + 'kind Person {\nage: number ');
            expect(written).not.toContain('attribute');
            expect(written.filter(label => label.endsWith('(with ends)'))).toEqual([]);
        });
    });

    describe('and a relation with no multiplicity still says what may follow it', () => {
        // Reported case. `<>-- Person` leaves the parser reading `Person` as
        // the relation's *name*, with a second `--` and a class still to come,
        // so `specializes` and `inverseOf` were reachable only through the
        // rules that readmit a keyword where a name is written -- and those
        // are dropped. Writing a multiplicity in front of the class settled
        // the reading, which is what made it look like it happened only after
        // some relations.
        test('after the class, whichever way the line is written', async () => {
            for (const line of [
                '@componenthood <>-- Person ', '@componenthood -- Person ',
                '@componenthood [1] <>-- Person ', '@componenthood <>-- [1] Person ',
                '@componenthood <>-- has -- Person ', '@componenthood <>-- (const) Person '
            ]) {
                const labels = await allAtEnd(universe + `kind Team {\n${line}`);
                expect(labels, line).toContain('specializes');
                expect(labels, line).toContain('inverseOf');
            }
        });

        test('and not before it, where there is no relation to specialize yet', async () => {
            expect(await allAtEnd(universe + 'kind Team {\n@componenthood <>-- ')).not.toContain('specializes');
        });

        test('and the line after one proposes what a body holds', async () => {
            // The same ambiguity leaves the parser expecting a name on the
            // next line, and a name is the writer\u2019s -- so the list came
            // out empty inside a class body, where a member may always begin.
            const labels = await allAtEnd(universe + 'kind Team {\n@componenthood <>-- Person\n');
            expect(labels).toContain('attribute');
            expect(labels).toContain('@componenthood (with ends)');
        });

        test('but a name being typed is still nobody else\u2019s to finish', async () => {
            expect(await allAtEnd(universe + 'kind Team {\n@componenthood <>-- Person\n  wheels')).toEqual([]);
        });
    });

    describe('and "subsets" or "redefines" proposes an end it could narrow', () => {
        // Reported case: every named end in the workspace was proposed. Two
        // rules already say which of them could stand there, and a third says
        // parthood is inherited.
        const world = [
            'package p', 'kind Person', 'role Employee specializes Person',
            'kind Team {', '-- [0..*] (staff) Person', '<>-- [1..*] (members) Person', '}',
            'kind Club {', '-- [0..*] (fans) Person', '}', ''
        ].join('\n');

        test('only ends of a classifier this one specializes', async () => {
            // Named plainly: what the class inherits needs no class in front
            // of it, and completion offers the spelling a modeler would write.
            expect(await allAtEnd(world + 'subkind Squad specializes Team {\n-- [0..*] (players subsets '))
                .toEqual(['staff']);
            // "Club" is nobody's supertype here, so its end cannot be narrowed.
            expect(await allAtEnd(world + 'kind Other {\n-- [0..*] (x subsets '))
                .toEqual([]);
        });

        test('and parthood is inherited, so a diamond asks for a diamond', async () => {
            expect(await allAtEnd(world + 'subkind Squad specializes Team {\n<>-- [1..*] (players subsets '))
                .toEqual(['members']);
        });

        test('"redefines" is asked the same questions', async () => {
            expect(await allAtEnd(world + 'subkind Squad specializes Team {\n-- [0..*] (players redefines '))
                .toEqual(['staff']);
        });

        test('and an end may only narrow a type, never widen it', async () => {
            // `Team.hired` is typed by `Employee`; an end typed `Person`
            // cannot subset it, which `override-type-not-narrower` says the
            // moment it is written.
            const narrow = [
                'package p', 'kind Person', 'role Employee specializes Person',
                'kind Team {', '-- [0..*] (hired) Employee', '}', ''
            ].join('\n');
            // Written with the type in place, which is where the rule bites.
            expect(await allAt(narrow + 'subkind Squad specializes Team {\n-- [0..*] (people subsets \u2038) Person\n}'))
                .toEqual([]);
            expect(await allAt(narrow + 'subkind Squad specializes Team {\n-- [0..*] (people subsets \u2038) Employee\n}'))
                .toEqual(['hired']);
        });
    });

    describe('and an end decorator proposes the four words it takes', () => {
        // Reported case: `HardKeyword` and `EndSafeKeyword` readmit every word
        // of the language where a name is written, so an empty `()` proposed
        // sixty things, `kind` and `package` among them.
        test('inside an empty decorator', async () => {
            expect(await allAtEnd(universe + 'kind Statue {\n@constitution [1] -- [0..1] ('))
                .toEqual(['const', 'addOnly', 'subsets', 'redefines']);
        });

        test('and after a flag, the two clauses that may still follow', async () => {
            expect(await allAtEnd(universe + 'kind Statue {\n@constitution [1] -- [0..1] (const '))
                .toEqual(['subsets', 'redefines']);
        });

        test('a name position proposes no keywords at all', async () => {
            // `kind ` used to offer every word in the language, and accepting
            // one on Enter replaced the name being typed.
            expect(await allAtEnd(universe + 'kind ')).toEqual([]);
        });
    });

    /** Every proposal where `\u2038` stands, which may be anywhere in the text. */
    async function allAt(marked: string): Promise<string[]> {
        // Converted first, so the offset is taken in the text that is parsed.
        const source = inOntologyInPlace(marked.replace(/\bpackage p\b/g, `package p${++packageCounter}`));
        const offset = source.indexOf('\u2038');
        const document = await parseDocument(source.replace('\u2038', ''));
        const list = await services.lsp.CompletionProvider!.getCompletion(document, {
            textDocument: { uri: document.textDocument.uri },
            position: document.textDocument.positionAt(offset)
        });
        return (list?.items ?? []).map(item => String(item.label));
    }

    describe('and the shape of a relation is offered where the stereotype ends', () => {
        // Reported case: the list after `@constitution ` made no sense. It was
        // everything that may follow a finished relation, and once that went,
        // nothing at all -- Langium proposes no punctuation, and a
        // multiplicity is what comes next.
        test('the ends the stereotype takes, tuned to the class it is written in', async () => {
            expect(await allAtEnd(universe + 'kind Statue {\n@constitution '))
                .toEqual(['[0..1] -- [1] Constituent']);
            expect(await allAtEnd(universe + 'kind Car {\n@componenthood '))
                .toEqual(['[0..1] <>-- [1..*] Part']);
        });

        test('and nothing where the class cannot open one', async () => {
            // A kind does not mediate; only a relator binds.
            expect(await allAtEnd(universe + 'kind Car {\n@mediation ')).toEqual([]);
        });

        test('it is the same relation the "(with ends)" snippet writes', async () => {
            const document = await parseDocument(`package p${++packageCounter}\nrelator R {\n\n}\n`);
            const inTheBody = await services.lsp.CompletionProvider!.getCompletion(document, {
                textDocument: { uri: document.textDocument.uri },
                position: { line: 2, character: 0 }
            });
            for (const stereotype of ['mediation', 'material', 'comparative']) {
                const whole = (inTheBody?.items ?? [])
                    .find(item => item.label === `@${stereotype} (with ends)`)?.insertText;
                const afterTheTag = await allAtEnd(`package p${++packageCounter}\nrelator R {\n@${stereotype} `);
                expect(afterTheTag, stereotype).toHaveLength(1);
                expect(`@${stereotype} ${afterTheTag[0]}`, stereotype)
                    .toBe(whole?.replace(/\$\{\d+:([^}]*)\}/g, '$1'));
            }
        });

        test('and an instant is offered the same way, since a tag takes an attribute', async () => {
            expect(await allAtEnd(universe + 'event Wedding {\n@begin '))
                .toEqual(['startedAt: const date']);
            expect(await allAtEnd(universe + 'kind Person {\n@end '))
                .toEqual(['finishedAt: const date [0..1]']);
        });
    });

    describe('and a relation being edited in the middle of a document is read the same way', () => {
        // The first fix read the parsed relation, which has a target
        // everywhere in a finished document -- so it only ever fired at the
        // end of the file. What Langium answers with comes from re-parsing
        // the text up to the cursor, and that is what has to be read.
        const before = 'package p\nkind Person\nquantity Clay\nquantity Lump {\n@constitution [1] -- [0..1] \u2038Clay\n}\nkind Tail\n';
        const after = 'package p\nkind Person\nquantity Clay\nquantity Lump {\n@constitution [1] -- [0..1] Clay \u2038\n}\nkind Tail\n';

        test('before the class at the end, only the classes', async () => {
            const labels = await allAt(before);
            expect(labels).not.toContain('specializes');
            expect(labels).not.toContain('attribute');
            expect(labels).toContain('Clay');
        });

        test('and after it, what may follow a relation', async () => {
            expect(await allAt(after)).toContain('specializes');
        });
    });

    describe('and a generalization set takes classes or relations, never both', () => {
        test('a set whose members are relations proposes relations', async () => {
            const document = 'package p\nkind Person\nkind Car\n'
                + 'relation Person -- owns -- [*] Car\nrelation Person -- rents -- [*] Car\n'
                + 'genset G where \u2038owns specializes rents\nkind Tail\n';
            expect(await allAt(document)).toEqual(['owns', 'rents']);
        });

        test('but a set of relations takes no categorizer at all', async () => {
            // The filter asked `classifiesTypes` of classes only and let every
            // relation through, and a set of relations has no categorizer
            // (`categorizer-on-relation-set`), so nothing belongs here.
            const document = 'package p\nkind Person\nkind Car\ntype Ownership\n'
                + 'relation Person -- owns -- [*] Car\nrelation Person -- leases -- [*] Car specializes Person.owns\n'
                + 'genset G {\ngeneral Person.owns\ncategorizer \u2038\nspecifics Person.leases\n}\nkind Tail\n';
            expect((await allAt(document)).filter(label => /Ownership|owns|leases|Person|Car|Tail/.test(label))).toEqual([]);
        });

        test('while a set of classes is offered its higher-order types only', async () => {
            const document = 'package p\nkind Person\nsubkind Man specializes Person\ntype Gender\n'
                + 'genset G {\ngeneral Person\ncategorizer \u2038\nspecifics Man\n}\nkind Tail\n';
            const labels = await allAt(document);
            expect(labels).toContain('Gender');
            expect(labels.filter(label => /^(Person|Man|Tail)$/.test(label))).toEqual([]);
        });
    });

    test('suggests classes after "relation"', async () => {
        const proposals = await referencesAtEnd(universe + 'relation ');
        expect(proposals).toContain('Person');
        expect(proposals).toContain('Team');
    });

    test('suggests classes after a stereotyped "relation"', async () => {
        expect(await referencesAtEnd(universe + '@mediation relation ')).toContain('Person');
    });

    test('suggests classes at a relation target', async () => {
        expect(await referencesAtEnd(universe + 'relation Person -- r -- [1] ')).toContain('Car');
    });

    test('suggests classes at an internal relation target', async () => {
        expect(await referencesAtEnd(universe + 'kind K { [1] -- r -- [1] ')).toContain('Car');
    });
});

describe('create a missing declaration', () => {
    async function creationsFor(source: string): Promise<string[]> {
        const document = await parse(source);
        const diagnostic = (document.diagnostics ?? []).find(d =>
            (d.data as { code?: string } | undefined)?.code === 'linking-error');
        expect(diagnostic, 'no unresolved reference').toBeDefined();
        const actions = await services.lsp.CodeActionProvider!.getCodeActions(document, {
            textDocument: { uri: document.textDocument.uri },
            range: diagnostic!.range,
            context: { diagnostics: [diagnostic!] }
        });
        return (actions ?? [])
            .filter(action => 'kind' in action && action.kind === CodeActionKind.QuickFix)
            .map(action => action.title);
    }

    /** The document text after applying the first "create ..." action. */
    async function createdInto(source: string): Promise<string> {
        const document = await parse(source);
        const diagnostic = (document.diagnostics ?? []).find(d =>
            (d.data as { code?: string } | undefined)?.code === 'linking-error');
        const actions = await services.lsp.CodeActionProvider!.getCodeActions(document, {
            textDocument: { uri: document.textDocument.uri },
            range: diagnostic!.range,
            context: { diagnostics: [diagnostic!] }
        });
        return applyFirst(document, actions as { edit?: never }[]);
    }

    describe('where the declaration lands', () => {
        test('a non-sortal lands above what referenced it', async () => {
            // It exists to be specialized -- it supplies no identity, so
            // something below it must -- and a taxonomy reads downwards.
            const applied = await createdInto('package p\nkind Person specializes Missing\nkind Dog\nkind Cat\n');
            expect(applied).toMatch(/ontology p\d*\ncategory Missing\nkind Person specializes Missing\nkind Dog/);
        });

        test('and above the documentation of what referenced it, not between them', async () => {
            const applied = await createdInto(
                'package p\n/// A person, in the everyday sense.\n/// @label Person\nkind Person specializes Missing\n');
            expect(applied).toContain('category Missing\n/// A person, in the everyday sense.');
            expect(applied).not.toMatch(/@label Person\ncategory Missing/);
        });

        test('a sortal lands directly after it', async () => {
            const applied = await createdInto('package p\nkind Person {\n@mediation [1] -- [1] Absent\n}\nkind Dog\n');
            expect(applied).toContain('}\nkind Absent\nkind Dog');
        });

        test('after the whole class when the reference is inside its body', async () => {
            // Not in the middle of the class: the anchor is the package-level
            // declaration, not the relation that names the missing element.
            const applied = await createdInto('package p\nkind Person {\n@mediation [1] -- [1] Absent\n}\nkind Dog\n');
            expect(applied).toContain('}\nkind Absent\nkind Dog');
        });

        test('a general named by a generalization set lands above the set', async () => {
            const applied = await createdInto('package p\nkind Person\ngenset G where Person specializes Nowhere\nkind Dog\n');
            expect(applied).toContain('kind Person\ncategory Nowhere\ngenset G where Person specializes Nowhere');
        });

        test('no blank line is introduced', async () => {
            const applied = await createdInto('package p\nkind Person specializes Missing\nkind Dog\n');
            expect(applied).not.toMatch(/\n\s*\n/);
        });
    });

    test('narrows by the natures the subject is restricted to', async () => {
        // A subkind may specialize a mode in general, but not one restricted
        // to functional complexes -- nothing is both.
        const offered = await creationsFor('package p\nsubkind Hospital of functional-complexes specializes Organization\n');
        expect(offered).not.toContain('Create mode "Organization"');
        expect(offered).not.toContain('Create collective "Organization"');
        expect(offered).toContain('Create kind "Organization"');
    });

    test('offers only stereotypes the subject may specialize', async () => {
        expect(await creationsFor('package p\nkind K specializes Missing\n'))
            .toEqual(['Create category "Missing"', 'Create mixin "Missing"']);
    });

    test('offers a high-order type for instanceOf', async () => {
        // One stereotype now: whether it is a Cardelli power type is a
        // modifier on the class, not a different kind of class.
        expect(await creationsFor('package p\nkind K (instanceOf Missing)\n'))
            .toEqual(['Create type "Missing"']);
    });

    test('offers a datatype or enum for an attribute type', async () => {
        expect(await creationsFor('package p\nkind K { f: Missing }\n'))
            .toEqual(['Create datatype "Missing"', 'Create enum "Missing"']);
    });

    test('infers from the relation stereotype: instantiation targets a type', async () => {
        const titles = await creationsFor('package p\nkind K { @instantiation [*] -- [1] Missing }\n');
        expect(titles[0]).toBe('Create type "Missing"');
    });

    test('infers from the relation stereotype: memberOf parts', async () => {
        const titles = await creationsFor('package p\ncollective C { @membership [1] <>-- [2..*] Missing }\n');
        expect(titles.slice(0, 2)).toEqual(['Create kind "Missing"', 'Create collective "Missing"']);
    });

    test('an end open to everything concrete offers one of each family', async () => {
        // Reported case. `@historicalDependence` admits every concrete
        // individual at both ends, and answering by familiarity alone gave
        // five ways of saying "an endurant" -- kind, collective, quantity,
        // relator, quality -- for a relation that is about the past.
        const titles = await creationsFor(
            'package p\nkind Person\nrole Spouse specializes Person {\n@historicalDependence (addOnly) [*] -- [1] (const) Ceremony\n}\n');
        expect(titles.slice(0, 3))
            .toEqual(['Create kind "Ceremony"', 'Create event "Ceremony"', 'Create situation "Ceremony"']);
    });

    test('while an end that admits one family is left in its own order', async () => {
        // A mediated end is an endurant, so there is nothing to span and the
        // familiar answers keep the front.
        const titles = await creationsFor(
            'package p\nrelator Employment {\n@mediation [*] -- [1] (const) Employee\n}\n');
        expect(titles.slice(0, 3))
            .toEqual(['Create kind "Employee"', 'Create collective "Employee"', 'Create quantity "Employee"']);
    });

    /** The repairs alone, without the refactorings offered wherever the cursor is. */
    async function repairsFor(source: string): Promise<string[]> {
        return (await creationsFor(source)).filter(title => !title.startsWith('Write this'));
    }

    test('an event end offers the event already there, and what it creates says what it classifies', async () => {
        // Reported case: a participation in an unresolved `Meeting`, beside
        // an `event Reunião`. A mixin, role mixin or phase mixin of things
        // that happen was offered, and a category that said nothing of what
        // it classifies.
        expect(await repairsFor([
            'package p', 'kind Person {',
            '@participation (const) [2..*] -- participatedIn -- [*] Meeting', '}', 'event Reunião'
        ].join('\n'))).toEqual([
            'Change to "Reunião"', 'Create event "Meeting"', 'Create process "Meeting"',
            'Create category "Meeting" of events, processes'
        ]);
    });

    test('an end that takes endurants does not offer every class there is', async () => {
        const titles = await creationsFor('package p\nkind Product\nrelator Purchase {\n@mediation [1..*] -- [1] (const) Customer\n@mediation [0..*] -- [1] (const) Product\n}\n');
        expect(titles.filter(title => title.startsWith('Change to'))).toEqual([]);
    });

    test('what names a relation is not answered with a class', async () => {
        // Reported case: `inverseOf joinedByParticipant` offered a kind, an
        // event, a situation, an abstractum and a category of that name, none
        // of which would resolve it.
        expect(await repairsFor('package p\nevent Meeting\nkind Person {\n@participation (const) [2..*] -- participatedIn -- [*] Meeting inverseOf joinedByParticipant\n}\n'))
            .toEqual(['Write the inverse "joinedByParticipant"', 'Remove "inverseOf"']);
        expect(await repairsFor('package p\nkind Person\nhistoricalRole Graduate specializes Person derivedFrom Student.graduatedIn\n'))
            .toEqual(['Remove "derivedFrom"']);
    });

    describe('an inverse that is not there yet is written', () => {
        /** The model with the first repair for its unresolved reference applied. */
        async function withTheInverse(source: string): Promise<string> {
            const document = await parse(source);
            const diagnostic = (document.diagnostics ?? []).find(d =>
                (d.data as { code?: string } | undefined)?.code === 'linking-error');
            const actions = await services.lsp.CodeActionProvider!.getCodeActions(document, {
                textDocument: { uri: document.textDocument.uri },
                range: diagnostic!.range,
                context: { diagnostics: [diagnostic!] }
            });
            const repairs = (actions ?? []).filter(action => 'kind' in action && action.kind === CodeActionKind.QuickFix);
            expect(repairs[0]?.title).toMatch(/^Write the inverse/);
            return applyFirst(document, repairs as never);
        }
        async function cleanly(applied: string): Promise<void> {
            const reparsed = await reparse(applied.replace(/package p\d*/, `package q${++packageCounter}`), { validation: true });
            // Errors and warnings: the anti-patterns these services report
            // are about the model the inverse was written into.
            expect((reparsed.diagnostics ?? []).filter(d => (d.severity ?? 1) <= 2).map(d => d.message)).toEqual([]);
        }

        test('a material relation, read the other way with what it is derived from', async () => {
            // Reported case.
            const applied = await withTheInverse([
                'package p', 'kind Pessoa', 'kind Escola',
                'role Estudante specializes Pessoa {',
                '    @material [*] -- estudaEm -- [1..*] Escola  inverseOf ensina derivedFrom Matrícula', '}',
                'relator Matrícula {', '    @mediation [1..*] -- [1] (const) Estudante', '    @mediation [0..*] -- [1] (const) Escola', '}'
            ].join('\n'));
            expect(applied).toContain('kind Escola {\n    @material [1..*] -- ensina -- [*] Estudante '
                + 'inverseOf Estudante.estudaEm derivedFrom Matrícula\n}');
            expect(applied).toContain('inverseOf Escola.ensina derivedFrom Matrícula');
            await cleanly(applied);
        });

        test('a participation as a plain association, since an event takes part in nothing', async () => {
            const applied = await withTheInverse(
                'package p\nevent Reunião\nkind Pessoa {\n@participation (const) [2..*] -- participouEm -- [*] Reunião inverseOf teveParticipante\n}\n');
            expect(applied).toContain('event Reunião {\n    [*] -- teveParticipante -- [2..*] (const) Pessoa '
                + 'inverseOf Pessoa.participouEm\n}');
            expect(applied).toContain('inverseOf Reunião.teveParticipante');
            await cleanly(applied);
        });

        test('a parthood with the diamond on the other side, and the end names kept', async () => {
            const applied = await withTheInverse(
                'package p\nkind Roda\nkind Carro {\n@componenthood [1] <>-- temRoda -- [4] (const rodas) Roda inverseOf éRodaDe\n}\n');
            expect(applied).toContain('kind Roda {\n    @componenthood (const rodas) [4] -- éRodaDe --<> [1] Carro '
                + 'inverseOf Carro.temRoda\n}');
            expect(applied).toContain('inverseOf Roda.éRodaDe');
            await cleanly(applied);
        });

        test('a package-level relation keeps its inverse at package level', async () => {
            const applied = await withTheInverse(
                'package p\nkind Person\nkind Organization\nrelation Person [*] -- worksFor -- [1] Organization inverseOf employs\n');
            expect(applied).toContain('\nrelation Organization [1] -- employs -- [*] Person inverseOf worksFor');
            await cleanly(applied);
        });
    });

    test('a derived relation is offered what it can be derived from', async () => {
        expect(await repairsFor('package p\nkind Person\nkind Organization\n@material relation Person [0..*] -- worksFor -- [0..*] Organization derivedFrom Employment\n'))
            .toEqual([
                'Create relator "Employment"',
                'Create extrinsicMode "Employment" borne by "Person"',
                'Create extrinsicMode "Employment" borne by "Organization"'
            ]);
    });

    test('creating its missing relator writes the same complete pattern as extracting one', async () => {
        const source = [
            'package p', 'kind Person', 'role Employee specializes Person', 'kind Organization',
            '@material relation Employee [0..*] -- worksFor -- [1..*] Organization derivedFrom Employment'
        ].join('\n');
        const document = await parse(source);
        const diagnostic = (document.diagnostics ?? []).find(d =>
            (d.data as { code?: string } | undefined)?.code === 'linking-error')!;
        const actions = await services.lsp.CodeActionProvider!.getCodeActions(document, {
            textDocument: { uri: document.textDocument.uri },
            range: diagnostic.range,
            context: { diagnostics: [diagnostic] }
        });
        const create = (actions ?? []).find(action => action.title === 'Create relator "Employment"')!;
        const applied = applyFirst(document, [create] as never);
        expect(applied).toContain('relator Employment {\n'
            + '    @mediation [1..*] -- [1] (const) Employee\n'
            + '    @mediation [0..*] -- [1] (const) Organization\n}');
        expect(await new TontoSession().validateText(applied)).toEqual([]);
    });

    test('creating its missing extrinsic mode asks which end bears it and writes both dependencies', async () => {
        const source = [
            'package p', 'kind Person', 'kind Organization',
            '@material relation Person [0..*] -- isLoyalTo -- [1..*] Organization derivedFrom Loyalty'
        ].join('\n');
        const document = await parse(source);
        const diagnostic = (document.diagnostics ?? []).find(d =>
            (d.data as { code?: string } | undefined)?.code === 'linking-error')!;
        const actions = await services.lsp.CodeActionProvider!.getCodeActions(document, {
            textDocument: { uri: document.textDocument.uri },
            range: diagnostic.range,
            context: { diagnostics: [diagnostic] }
        });
        const create = (actions ?? []).find(action =>
            action.title === 'Create extrinsicMode "Loyalty" borne by "Person"')!;
        const applied = applyFirst(document, [create] as never);
        expect(applied).toContain('extrinsicMode Loyalty {\n'
            + '    @characterization [1..*] -- [1] (const) Person\n'
            + '    @externalDependence [0..*] -- [1] (const) Organization\n}');
        expect(await new TontoSession().validateText(applied)).toEqual([]);
    });

    test('infers a generalization set specific from the general', async () => {
        // Reported case. An event is specialized by a subkind, not by another
        // event -- events form no taxonomy among themselves.
        const titles = await creationsFor(
            'package p\nevent Meeting\n\ndisjoint complete genset Name where GoodMeeting, BadMeeting specializes Meeting\n'
        );
        expect(titles[0]).toBe('Create subkind "GoodMeeting"');
        expect(titles.some(t => /Create kind/.test(t))).toBe(false);
    });

    test('infers a generalization set specific under a kind general', async () => {
        const titles = await creationsFor('package p\nkind Person\ngenset G where Child specializes Person\n');
        expect(titles[0]).toBe('Create subkind "Child"');
        expect(titles.some(t => /Create category/.test(t))).toBe(false);
    });

    test('infers a generalization set general from its specifics', async () => {
        const titles = await creationsFor('package p\nevent E1\ngenset G where E1 specializes MissingGeneral\n');
        // An event's only supertypes are the non-sortals.
        expect(titles[0]).toBe('Create category "MissingGeneral"');
    });

    test('infers a specific in the block form too', async () => {
        const titles = await creationsFor('package p\nevent Meeting\ngenset G {\n general Meeting\n specifics Missing\n}\n');
        expect(titles[0]).toBe('Create subkind "Missing"');
    });

    test('the created generalization set member resolves and validates', async () => {
        const source = 'package gensetFix\nevent Meeting\n\ndisjoint complete genset Name where GoodMeeting specializes Meeting\n';
        const document = await parseDocument(source, { validation: true });
        const diagnostic = (document.diagnostics ?? []).find(d =>
            (d.data as { code?: string } | undefined)?.code === 'linking-error')!;
        const actions = await services.lsp.CodeActionProvider!.getCodeActions(document, {
            textDocument: { uri: document.textDocument.uri },
            range: diagnostic.range,
            context: { diagnostics: [diagnostic] }
        });
        const edit = Object.values(actions![0].edit!.changes!)[0][0];
        const offset = document.textDocument.offsetAt(edit.range.start);
        const patched = source.slice(0, offset) + edit.newText + source.slice(offset);

        const rebuilt = await reparse(patched.replace('package gensetFix', 'package gensetFix2'), { validation: true });
        const errors = (rebuilt.diagnostics ?? []).filter(d => d.severity === 1);
        expect(errors.map(d => d.message), patched).toHaveLength(0);
    });

    test('the created declaration resolves the reference', async () => {
        const source = 'package created\nkind K specializes Missing\n';
        const document = await parseDocument(source, { validation: true });
        const diagnostic = (document.diagnostics ?? []).find(d =>
            (d.data as { code?: string } | undefined)?.code === 'linking-error')!;
        const actions = await services.lsp.CodeActionProvider!.getCodeActions(document, {
            textDocument: { uri: document.textDocument.uri },
            range: diagnostic.range,
            context: { diagnostics: [diagnostic] }
        });
        const edit = Object.values(actions![0].edit!.changes!)[0][0];
        const offset = document.textDocument.offsetAt(edit.range.start);
        const patched = source.slice(0, offset) + edit.newText + source.slice(offset);
        expect(patched).toContain('category Missing');

        const rebuilt = await reparse(patched.replace('package created', 'package created2'), { validation: true });
        const unresolved = (rebuilt.diagnostics ?? []).filter(d =>
            (d.data as { code?: string } | undefined)?.code === 'linking-error');
        expect(unresolved).toHaveLength(0);
    });
});

describe('resolving disjoint supertypes', () => {
    // `CrazyMeeting` sits under two specifics of a disjoint partition, so it
    // could never be instantiated. Which of the three repairs is right is a
    // modeling decision, so all three are offered.
    const source = [
        'package p',
        'event Meeting',
        'disjoint complete genset Name where GoodMeeting, BadMeeting specializes Meeting',
        'subkind BadMeeting',
        'subkind CrazyMeeting specializes BadMeeting, GoodMeeting',
        'subkind GoodMeeting specializes Meeting'
    ].join('\n') + '\n';

    async function fixes() {
        const document = await parse(source);
        return { document, actions: await fixesFor(document, 'disjoint-supertypes') };
    }

    test('offers dropping either specialization, or the disjointness', async () => {
        const { actions } = await fixes();
        // Which of the two removals comes first carries no meaning.
        expect(actions.map(a => a.title).sort()).toEqual([
            'Make generalization set "Name" non-disjoint',
            'Remove specialization of "BadMeeting"',
            'Remove specialization of "GoodMeeting"'
        ]);
    });

    test('every one of them leaves the model valid', async () => {
        const { document, actions } = await fixes();
        const text = document.textDocument.getText();
        let variant = 0;
        for (const action of actions) {
            const edit = Object.values(action.edit!.changes!)[0][0];
            const start = document.textDocument.offsetAt(edit.range.start);
            const end = document.textDocument.offsetAt(edit.range.end);
            const patched = (text.slice(0, start) + edit.newText + text.slice(end))
                .replace('package p', `package variant${++variant}`);
            const rebuilt = await reparse(patched, { validation: true });
            const errors = (rebuilt.diagnostics ?? []).filter(d => d.severity === 1);
            expect(errors.map(d => d.message), `${action.title}\n${patched}`).toHaveLength(0);
        }
    });

    test('names the entry the conflict is reached through, not the conflicting class', async () => {
        // `CrazyMeeting` writes `VeryBadMeeting`, which is what has to go --
        // `BadMeeting` appears nowhere in its specializes list.
        const document = await parse(`
            package p
            event Meeting
            disjoint complete genset Name where GoodMeeting, BadMeeting specializes Meeting
            subkind BadMeeting
            subkind VeryBadMeeting specializes BadMeeting
            subkind CrazyMeeting specializes VeryBadMeeting, GoodMeeting
            subkind GoodMeeting specializes Meeting
        `);
        const actions = await fixesFor(document, 'disjoint-supertypes');
        expect(actions.map(a => a.title).sort()).toEqual([
            'Make generalization set "Name" non-disjoint',
            'Remove specialization of "GoodMeeting"',
            'Remove specialization of "VeryBadMeeting", which inherits "BadMeeting"'
        ]);
    });

    test('resolves both sides through their intermediates', async () => {
        const document = await parse(`
            package p
            event Meeting
            disjoint complete genset N where G1, B1 specializes Meeting
            event B1
            subkind G1 specializes Meeting
            subkind B2 specializes B1
            subkind G2 specializes G1
            subkind Crazy specializes B2, G2
        `);
        const titles = (await fixesFor(document, 'disjoint-supertypes')).map(a => a.title);
        expect(titles).toContain('Remove specialization of "B2", which inherits "B1"');
        expect(titles).toContain('Remove specialization of "G2", which inherits "G1"');
    });
});

describe('specifying a bare class stereotype', () => {
    test.each([
        'kind Person specializes foundation.Entity',
        'kind Person\nkind Organization\ngenset Entities where Person, Organization specializes foundation.Entity'
    ])('takes cross-file subtypes into account: %s', async declarations => {
        const session = new TontoSession();
        // Two documents of one ontology, so that the use reaches across them.
        const source = 'package foundation in foundations\ncategory Object of functional-complexes\nclass Entity specializes Object';
        const before = await session.hold('foundation', source);
        expect(before.find(diag => diag.code === 'unspecific-stereotype')!.fixes.map(fix => fix.title)).toContain('Change to kind');
        const people = `package people in foundations\nuse foundation\n${declarations}`;
        await session.hold('people', people);
        const reported = await session.hold('foundation', source);
        const diagnostic = reported.find(diag => diag.code === 'unspecific-stereotype')!;
        expect(diagnostic.fixes.map(fix => fix.title)).toEqual(['Change to category', 'Change to mixin']);
        for (const fix of diagnostic.fixes) {
            const updated = source.replace('class Entity', fix.title.replace('Change to ', '') + ' Entity');
            expect((await session.hold('foundation', updated)).filter(diag => diag.severity === 'error')).toEqual([]);
            expect((await session.hold('people', people)).filter(diag => diag.severity === 'error')).toEqual([]);
        }
    });

    async function suggestionsFor(source: string): Promise<string[]> {
        const document = await parse(source);
        const actions = await fixesFor(document, 'unspecific-stereotype');
        return actions.map(a => a.title.replace('Change to ', ''));
    }

    test('narrows to base sortals under a kind', async () => {
        expect(await suggestionsFor('package p\nkind Person\nclass Thing specializes Person\n'))
            .toEqual(['subkind', 'role', 'phase', 'historicalRole']);
    });

    test('leads with the stereotype whose nature matches exactly', async () => {
        // Under a category restricted to relators, `relator` is the obvious
        // answer; the base sortals merely permit relators among many natures.
        const suggestions = await suggestionsFor(
            'package p\ncategory SocialThing of relators\nclass Thing specializes SocialThing\n'
        );
        expect(suggestions[0]).toBe('relator');
        expect(suggestions).not.toContain('kind');
    });

    test('narrows from below, by what specializes it', async () => {
        // A non-sortal also says what it classifies, read off what is under it,
        // or the repair would leave `non-sortal-natures-unstated` behind.
        expect(await suggestionsFor('package p\nclass Thing\nkind Person specializes Thing\n'))
            .toEqual(['category of functional-complexes', 'mixin of functional-complexes']);
    });

    test('an event supertype leaves only subkind', async () => {
        expect(await suggestionsFor('package p\nevent Meeting\nclass Thing specializes Meeting\n'))
            .toEqual(['subkind']);
    });

    test('offers nothing when the model constrains nothing', async () => {
        const document = await parse('package p\nclass Thing\n');
        const diagnostic = (document.diagnostics ?? []).find(d => d.code === 'unspecific-stereotype');
        expect(diagnostic, 'expected the warning').toBeDefined();
        const actions = await services.lsp.CodeActionProvider!.getCodeActions(document, {
            textDocument: { uri: document.textDocument.uri },
            range: diagnostic!.range,
            context: { diagnostics: [diagnostic!] }
        });
        // Every stereotype is equally possible; listing twenty would not help.
        expect(actions ?? []).toHaveLength(0);
    });

    test('the chosen stereotype leaves the model valid', async () => {
        const source = 'package specify\nkind Person\nclass Thing specializes Person\n';
        const document = await parseDocument(source, { validation: true });
        const diagnostic = (document.diagnostics ?? []).find(d => d.code === 'unspecific-stereotype')!;
        const actions = await services.lsp.CodeActionProvider!.getCodeActions(document, {
            textDocument: { uri: document.textDocument.uri },
            range: diagnostic.range,
            context: { diagnostics: [diagnostic] }
        });
        const edit = Object.values(actions![0].edit!.changes!)[0][0];
        const start = document.textDocument.offsetAt(edit.range.start);
        const end = document.textDocument.offsetAt(edit.range.end);
        const text = document.textDocument.getText();
        const patched = (text.slice(0, start) + edit.newText + text.slice(end))
            .replace('ontology specify', 'ontology specify2');
        expect(patched).toContain('subkind Thing specializes Person');

        const rebuilt = await reparse(patched, { validation: true });
        expect((rebuilt.diagnostics ?? []).filter(d => d.severity === 1)).toHaveLength(0);
    });
});

describe('supertype proposals and disjointness', () => {
    const taxonomy = `
        event Meeting
        disjoint complete genset meetingGoodness where GoodMeeting, BadMeeting specializes Meeting
        event BadMeeting
        subkind GoodMeeting specializes Meeting
        subkind VeryBadMeeting specializes BadMeeting
        subkind EvenWorseMeeting specializes VeryBadMeeting
    `;

    async function supertypesAfter(declaration: string): Promise<string[]> {
        const document = await parse(`package p\n${taxonomy}\n${declaration}`);
        return (await completeAtEnd(document))
            .filter(item => item.detail === 'ClassDeclaration')
            .map(item => String(item.label))
            .sort();
    }

    test('excludes descendants of a class disjoint from one already chosen', async () => {
        // Neither VeryBadMeeting nor EvenWorseMeeting is *itself* declared
        // disjoint from GoodMeeting; the conflict is with BadMeeting above them.
        const proposals = await supertypesAfter('subkind CrazyMeeting specializes GoodMeeting, ');
        expect(proposals).not.toContain('BadMeeting');
        expect(proposals).not.toContain('VeryBadMeeting');
        expect(proposals).not.toContain('EvenWorseMeeting');
    });

    test('excludes a supertype already listed on the same line', async () => {
        const proposals = await supertypesAfter('subkind CrazyMeeting specializes GoodMeeting, ');
        expect(proposals).not.toContain('GoodMeeting');
        expect(proposals).toEqual(['Meeting']);
    });

    test('offers both branches while nothing has been chosen yet', async () => {
        const proposals = await supertypesAfter('subkind NewMeeting specializes ');
        expect(proposals).toContain('GoodMeeting');
        expect(proposals).toContain('BadMeeting');
        expect(proposals).toContain('EvenWorseMeeting');
    });

    test('applies to a bare class too, whose stereotype constrains nothing', async () => {
        // Disjointness is about instances, so it holds whatever the stereotypes
        // are -- this used to be skipped by the `class` shortcut.
        const proposals = await supertypesAfter('class Anything specializes GoodMeeting, ');
        expect(proposals).not.toContain('EvenWorseMeeting');
    });

    test('excludes a class disjoint from an inherited ancestor, not just a direct one', async () => {
        const proposals = await supertypesAfter('subkind Deep specializes EvenWorseMeeting, ');
        expect(proposals).not.toContain('GoodMeeting');
    });
});

describe('widening the powertype end', () => {
    test('inserts a multiplicity where none was written', async () => {
        const document = await parse('package p\ntype CarType isPowerType\nkind Car {\n@instantiation -- CarType\n}');
        const actions = await fixesFor(document, 'powertype-instantiation-multiplicity');
        expect(actions.map(a => (a as { title: string }).title)).toEqual(['Set the powertype end to [1..*]']);
        expect(applyFirst(document, actions)).toContain('@instantiation -- [1..*] CarType');
    });

    test('replaces an explicit one', async () => {
        const document = await parse('package p\ntype CarType isPowerType\nkind Car {\n@instantiation -- [0..1] CarType\n}');
        const actions = await fixesFor(document, 'powertype-instantiation-multiplicity');
        expect(applyFirst(document, actions)).toContain('@instantiation -- [1..*] CarType');
    });
});

describe('supertype proposals and ultimate sortals', () => {
    const universe = `
        kind A
        kind B
        subkind SubOfB specializes B
        role RoleOfA specializes A
        category Cat
    `;

    async function supertypesAfter(declaration: string): Promise<string[]> {
        const document = await parse(`package p\n${universe}\n${declaration}`);
        return (await completeAtEnd(document))
            .filter(item => item.detail === 'ClassDeclaration')
            .map(item => String(item.label))
            .sort();
    }

    test('offers every ultimate sortal while none has been chosen', async () => {
        expect(await supertypesAfter('phase C specializes ')).toEqual(['A', 'B', 'Cat', 'SubOfB']);
    });

    test('drops the other kinds once one is fixed', async () => {
        // Ultimate sortals are pairwise disjoint, so a lineage holds one.
        expect(await supertypesAfter('phase C specializes A, ')).toEqual(['Cat']);
    });

    test('drops anything under another kind, not just the kind itself', async () => {
        expect(await supertypesAfter('phase C specializes A, ')).not.toContain('SubOfB');
    });

    test('keeps classes under the same kind', async () => {
        // RoleOfA fixes the kind to A, which is then still a legal supertype.
        expect(await supertypesAfter('phase C specializes RoleOfA, ')).toContain('A');
    });
});

describe('dropping a second ultimate sortal', () => {
    const universe = 'package p\nkind A\nkind B\nsubkind SubOfB specializes B\n';

    test('offers to remove either side', async () => {
        const document = await parse(universe + 'phase C specializes A, B');
        const actions = await fixesFor(document, 'multiple-ultimate-sortals');
        expect(actions.map(a => a.title).sort()).toEqual([
            'Remove specialization of "A"',
            'Remove specialization of "B"'
        ]);
        expect(applyFirst(document, actions)).toContain('phase C specializes B');
    });

    test('names the entry an ultimate sortal is reached through', async () => {
        const document = await parse(universe + 'phase C specializes A, SubOfB');
        const actions = await fixesFor(document, 'multiple-ultimate-sortals');
        expect(actions.map(a => a.title)).toContain('Remove specialization of "SubOfB", which inherits "B"');
    });
});

describe('dropping an incompatible supertype', () => {
    // Both supertypes are non-sortals and so is what sits under them, which
    // is what makes *either* removal a repair: drop the only ultimate sortal
    // above a base sortal and the nature clash is answered with
    // `sortal-without-ultimate-sortal`, so that side is not offered at all.
    const universe = 'package p\ncategory Alive of objects\ncategory Social of relators\n';

    test('offers to remove either side, naming the natures each brings', async () => {
        const document = await parse(universe + 'mixin AAA specializes Alive, Social');
        const actions = await fixesFor(document, 'incompatible-supertype-natures');
        expect(actions.map(a => a.title).sort()).toEqual([
            'Remove specialization of "Alive" (functional-complexes, collectives, quantities)',
            'Remove specialization of "Social" (relators)'
        ]);
    });

    test('applying one clears the contradiction', async () => {
        const document = await parse(universe + 'mixin AAA specializes Alive, Social');
        const actions = await fixesFor(document, 'incompatible-supertype-natures');
        const applied = applyFirst(document, actions);
        expect(applied).toContain('mixin AAA specializes Social');
        expect(applied).not.toContain('Alive,');
    });

    test('but not the side that supplies the only identity principle', async () => {
        // Dropping the relator leaves `role AAA specializes Alive`, which has
        // no ultimate sortal above it: that trades one error for another.
        const document = await parse(
            'package p\ncategory Alive of objects\nrelator TutoringSession\n'
            + 'role AAA specializes Alive, TutoringSession');
        const actions = await fixesFor(document, 'incompatible-supertype-natures');
        expect(actions.map(a => a.title))
            .toEqual(['Remove specialization of "Alive" (functional-complexes, collectives, quantities)']);
    });

    test('offers only the removable side when the other comes from a genset', async () => {
        // A generalization set declares the edge elsewhere, so there is no
        // `specializes` entry to delete for that side.
        const document = await parse(universe + 'mixin AAA specializes Social\ngenset G where AAA specializes Alive');
        const actions = await fixesFor(document, 'incompatible-supertype-natures');
        expect(actions.map(a => a.title)).toEqual(['Remove specialization of "Social" (relators)']);
    });
});

describe('and "addOnly" with nothing to add has two readings', () => {
    // Reported case: only one repair was offered, and the modeler who
    // wrote the flag on purpose meant the other one.
    test('the flag is wrong, or the bound is', async () => {
        const document = await parse(
            'package p\nkind Person\nkind Statue {\n@material -- hasAuthor -- [1] (addOnly) Person\n}');
        const actions = await fixesFor(document, 'add-only-with-nothing-to-add');
        expect(actions.map(action => action.title))
            .toEqual(['Remove "addOnly"', 'Let it grow: "[1..*]"']);
        expect(applyFirst(document, [actions[1]])).toContain('[1..*] (addOnly) Person');
    });

    test('the lower bound is kept, since how many are required is another claim', async () => {
        const document = await parse('package p\nkind Person\nkind Team {\n<>-- [2] (addOnly members) Person\n}');
        const actions = await fixesFor(document, 'add-only-with-nothing-to-add');
        expect(applyFirst(document, [actions[1]])).toContain('[2..*] (addOnly members)');
    });

    test('and an end that writes no multiplicity holds one, so there is one to write', async () => {
        const document = await parse('package p\nkind Person\nkind Statue {\n-- (addOnly) Person\n}');
        const actions = await fixesFor(document, 'add-only-with-nothing-to-add');
        expect(applyFirst(document, [actions[1]])).toContain('-- [1..*] (addOnly) Person');
    });

    test('an attribute is answered the same way', async () => {
        const document = await parse('package p\nkind Person {\nname: addOnly string\n}\ndatatype string');
        const actions = await fixesFor(document, 'add-only-with-nothing-to-add');
        expect(actions.map(action => action.title))
            .toEqual(['Remove "addOnly"', 'Let it grow: "[1..*]"']);
        expect(applyFirst(document, [actions[1]])).toContain('name: addOnly string [1..*]');
    });
});

describe('mechanical repairs', () => {
    /** The document text after applying the first fix offered for `code`. */
    async function repaired(source: string, code: string): Promise<string> {
        const document = await parse(source);
        return applyFirst(document, await fixesFor(document, code));
    }

    async function titles(source: string, code: string): Promise<string[]> {
        const document = await parse(source);
        return (await fixesFor(document, code)).map(a => a.title);
    }

    test('an upper bound of 0 becomes [0..1] or [0..*]', async () => {
        expect(await titles('package p\nkind A\nkind B { [0..0] -- r -- [1] A }', 'multiplicity-zero-upper'))
            .toEqual(['Change to [0..1]', 'Change to [0..*]']);
    });

    test('a characterization bearer end becomes [1]', async () => {
        const source = 'package p\nkind Person\nquality Weight\n@characterization relation Weight -- [0..*] Person';
        expect(await repaired(source, 'characterization-bearer-multiplicity')).toContain('-- [1] Person');
    });

    test('a participational portion is restricted to one participant', async () => {
        const source = [
            'package p', 'kind Person',
            'event Meeting {',
            '@participational (const) [1] <>-- [2..*] (const) AttendeeParticipation',
            '}', 'event AttendeeParticipation',
            '@participation relation Person (const) [1..*] -- attended -- [0..*] (const) AttendeeParticipation'
        ].join('\n');
        expect(await repaired(source, 'participational-portion-multiple-participants'))
            .toContain('Person (const) [1] -- attended');
    });

    test('a non-sortal is given the natures of what is beneath it', async () => {
        const source = 'package p\ncategory Agent\nkind Person specializes Agent\ncollective Team specializes Agent';
        expect(await titles(source, 'non-sortal-natures-unstated'))
            .toEqual(['Write "of functional-complexes, collectives"']);
        expect(await repaired(source, 'non-sortal-natures-unstated'))
            .toContain('category Agent of functional-complexes, collectives\n');
    });

    test('but not where that would break a relation it is an end of', async () => {
        const source = 'package p\ncategory Thing\nkind Car specializes Thing\n@mediation relation Thing [0..*] -- [1] (const) Car';
        expect(await titles(source, 'non-sortal-natures-unstated')).toEqual([]);
    });

    test('and nothing is offered where nothing is beneath it', async () => {
        expect(await titles('package p\nmixin Lonely', 'non-sortal-natures-unstated')).toEqual([]);
    });

    describe('a historical role is derived from what happened', () => {
        const university = [
            'package p', 'kind Person', 'role Student specializes Person', 'role Employee specializes Person',
            'kind University',
            'relator Enrollment {', '@mediation [1..*] -- [1] (const) Student', '@mediation [0..*] -- [1] (const) University', '}',
            'relator Employment {', '@mediation [1..*] -- [1] (const) Employee', '@mediation [0..*] -- [1] (const) University', '}',
            'event Graduation', 'event Retirement',
            '@participation relation Student (const) [1..*] -- graduatedIn -- [0..*] (addOnly) Graduation',
            '@participation relation Employee (const) [1] -- retiredIn -- [0..1] (const) Retirement'
        ];
        const model = (...lines: string[]): string => [...university, ...lines].join('\n');

        test('rather than told to take part in it again', async () => {
            const source = model('historicalRole Graduate specializes Person');
            const offered = await titles(source, 'historical-role-without-event');
            expect(offered[0]).toBe('Derive from "Student.graduatedIn"');
            expect(await repaired(source, 'historical-role-without-event'))
                .toContain('historicalRole Graduate specializes Person derivedFrom Student.graduatedIn');
        });

        test('an ambiguous event is replaced by the relation meant', async () => {
            const source = model('@participation relation Person (const) [0..*] -- attended -- [0..*] (const) Graduation',
                'historicalRole Graduate specializes Person derivedFrom Graduation');
            expect(await titles(source, 'historical-derivation-ambiguous'))
                .toEqual(['Derive from "Student.graduatedIn"', 'Derive from "Person.attended"']);
            expect(await repaired(source, 'historical-derivation-ambiguous'))
                .toContain('derivedFrom Student.graduatedIn');
        });

        test('a derivation on a role is dropped, or the role made historical', async () => {
            const source = model('role Graduate specializes Person derivedFrom Student.graduatedIn');
            expect(await titles(source, 'class-derivation-not-historical'))
                .toEqual(['Remove "derivedFrom"', 'Change to "historicalRole"']);
            expect(await repaired(source, 'class-derivation-not-historical'))
                .toMatch(/\nrole Graduate specializes Person$/);
        });

        test('a historical role under a role that lapses specializes the rigid type, derived from the role', async () => {
            const source = model('historicalRole FormerEmployee specializes Employee');
            expect(await repaired(source, 'historical-role-specializes-anti-rigid'))
                .toContain('historicalRole FormerEmployee specializes Person derivedFrom Employee.retiredIn');
        });
    });

    test('a portion with two required participants is read either way', async () => {
        const source = [
            'package p', 'kind Person', 'kind Message',
            'event Disorder {',
            '@participational (const) [1] <>-- [2..*] (const) AgentParticipation',
            '}', 'event AgentParticipation',
            '@participation relation Person (const) [1] -- acted -- [0..*] (const) AgentParticipation',
            '@participation relation Message (const) [1] -- figured -- [0..*] (const) AgentParticipation'
        ].join('\n');
        expect(await titles(source, 'participational-portion-two-participants')).toEqual([
            'Make the parthood "@structural"',
            'Move the participation of "Person" to "Disorder"',
            'Move the participation of "Message" to "Disorder"'
        ]);
        expect(await repaired(source, 'participational-portion-two-participants'))
            .toContain('@structural (const) [1] <>-- [2..*] (const) AgentParticipation');
    });

    test('a participation into a type above the portion is not moved', async () => {
        const source = [
            'package p', 'kind Person', 'kind Message',
            'event Involvement',
            '@participation relation Person (const) [1] -- wasInvolvedIn -- [0..*] (const) Involvement',
            'event Disorder {',
            '@participational (const) [1] <>-- [2..*] (const) AgentParticipation',
            '}', 'subkind AgentParticipation specializes Involvement',
            '@participation relation Message (const) [1] -- figured -- [0..*] (const) AgentParticipation'
        ].join('\n');
        expect(await titles(source, 'participational-portion-two-participants')).toEqual([
            'Make the parthood "@structural"',
            'Move the participation of "Message" to "Disorder"'
        ]);
    });

    test('an ineffective "ordered" takes its braces with it', async () => {
        const source = 'package p\ndatatype string\nkind A { name: ordered string }';
        const applied = await repaired(source, 'ordered-single-valued');
        expect(applied).toContain('name: string');
        // And nothing left where the modifier was.
        expect(applied).not.toMatch(/:\s\s/);
    });

    test('an ineffective "ordered" beside another modifier leaves it', async () => {
        const source = 'package p\ndatatype string\nkind A { name: ordered const string }';
        expect(await repaired(source, 'ordered-single-valued')).toContain('name: const string');
    });

    test('a self-inverse loses the inverseOf clause', async () => {
        const source = 'package p\nkind A\nkind B\nrelation A [1] -- r -- [1] B inverseOf r';
        expect(await repaired(source, 'self-inverse')).not.toContain('inverseOf');
    });

    test('an end subsetting itself loses the clause, braces included', async () => {
        const source = 'package p\nkind A\nkind B { -- [1] (q subsets B.q) A }';
        expect(await repaired(source, 'end-self-reference')).toContain('(q) A');
    });

    test('a capitalized package name is lower-cased', async () => {
        const document = await parseDocument('ontology shop\npackage Uppercase\nkind A', { validation: true });
        const actions = await fixesFor(document, 'package-name-case');
        expect(actions.map(a => a.title)).toEqual(['Rename to "uppercase"']);
    });

    test('and so is every segment of a qualified one', async () => {
        const document = await parseDocument('package Shop.Retail\nkind A', { validation: true });
        const actions = await fixesFor(document, 'package-name-case');
        expect(actions.map(a => a.title)).toEqual(['Rename to "shop.retail"']);
        expect(applyFirst(document, actions)).toContain('package shop.retail');
    });

    test('a label block is lifted out as "///" documentation', async () => {
        const source = 'package p\nkind A {\nlabel { @en "x" }\n}';
        const applied = await repaired(source, 'legacy-text-block');
        // The body held nothing else, so the braces went with the block.
        expect(applied).toMatch(/^ontology p\d*\n\/\/\/ @label:en x\nkind A$/);
    });

    test('a specialization cycle offers the entries that close it', async () => {
        expect(await titles('package p\nkind A specializes B\nsubkind B specializes A', 'specialization-cycle'))
            .toContain('Remove specialization of "B", which closes the cycle');
    });

    test('an invalid generalization-set specific is removed with its comma', async () => {
        const source = 'package p\nkind A\nkind B\nsubkind S specializes A\ngenset G where S, B specializes A';
        const document = await parse(source);
        const actions = await fixesFor(document, 'genset-stereotype-cannot-specialize');
        const removal = actions.findIndex(a => a.title === 'Remove "B" from the specifics');
        expect(removal, actions.map(a => a.title).join(', ')).toBeGreaterThanOrEqual(0);
        expect(applyFirst(document, [actions[removal]])).toContain('genset G where S specializes A');
    });

    test('a single-specific partition loses "complete"', async () => {
        const source = 'package p\nkind A\nsubkind B specializes A\ndisjoint complete genset G where B specializes A';
        expect(await repaired(source, 'partition-single-specific')).toContain('disjoint genset G');
    });

    test('a datatype specializing a class loses the clause', async () => {
        expect(await repaired('package p\nkind A\ndatatype D specializes A', 'datatype-specializes-non-abstract'))
            .toContain('datatype D');
    });

    test('an overriding end is brought inside the one it draws from, and no further', async () => {
        // Reported case, in the other spelling: only the bound the rule is
        // about moves. `[0..*]` under `[1]` becomes `[0..1]`, not `[1]` --
        // copying the general's multiplicity turned an optional end into a
        // mandatory one, which no rule here asks for.
        const source = 'package p\nkind A\nkind B { -- [1] (q) A\n-- [0..*] (subsets B.q) A }';
        expect(await repaired(source, 'end-holds-more-than-general')).toContain('-- [0..1] (subsets B.q)');

        // And a redefinition, where it is the lower bound that has to move.
        const redefining = [
            'package p', 'kind Person', 'kind Team {', '-- [2..*] (members) Person', '}',
            'subkind Squad specializes Team {', '-- [0..*] (redefines Team.members) Person', '}'
        ].join('\n');
        expect(await repaired(redefining, 'redefinition-weakens-lower-bound'))
            .toContain('-- [2..*] (redefines Team.members)');
    });

    test('a bare class with a contradictory "of" clause offers both repairs', async () => {
        const offered = await titles('package p\nkind K of relators', 'stereotype-nature-mismatch');
        expect(offered[0]).toBe('Change to relator');
        expect(offered).toContain('Remove the nature restriction');
    });

    describe('relations written the wrong way round', () => {
        test('an external relation has its ends swapped', async () => {
            const source = 'package p\nkind Person\nrelator Marriage\n@mediation relation Person [1] -- m -- [1] Marriage';
            expect(await repaired(source, 'relation-ends-reversed'))
                .toContain('relation Marriage [1] -- m -- [1] Person');
        });

        test('a parthood relation has its diamond turned round instead', async () => {
            // The classes stay put, so each multiplicity stays beside the class
            // it constrains; only the whole/part roles change.
            const source = 'package p\ncollective Forest\nkind Tree\n@membership relation Tree [1] <>-- m -- [1] Forest';
            expect(await titles(source, 'relation-ends-reversed'))
                .toEqual(['Turn the diamond round, making "Forest" the whole']);
            expect(await repaired(source, 'relation-ends-reversed')).toContain('[1] -- m --<> [1] Forest');
        });

        test('the diamond and the relation name trade places, as the grammar requires', async () => {
            // [2..*] members, or weak supplementation would object to a
            // collective with a single member.
            const source = 'package p\ncollective Forest\nkind Tree { @membership [2..*] <>-- parts -- [1] Forest }';
            const applied = await repaired(source, 'relation-ends-reversed');
            expect(applied).toContain('[2..*] -- parts --<> [1] Forest');
            const reparsed = await reparse(applied.replace('package p', 'package p0'), { validation: true });
            expect(reparsed.diagnostics ?? []).toEqual([]);
        });

        test('nothing is offered when the direction is simply wrong', async () => {
            // No reverse is permitted here, so there is no mechanical repair
            // and the diagnostic carries no code at all.
            const document = await parse('package p\nkind Person\nkind Other\n@mediation relation Person [1] -- m -- [1] Other');
            expect((document.diagnostics ?? []).some(d => d.code === 'relation-ends-reversed')).toBe(false);
        });
    });
});

describe('resolving an inherited-nature conflict', () => {
    async function offered(source: string, code: string): Promise<string[]> {
        const document = await parse(source);
        return (await fixesFor(document, code)).map(a => a.title);
    }

    async function firstApplied(source: string, code: string): Promise<string> {
        const document = await parse(source);
        return applyFirst(document, await fixesFor(document, code));
    }

    test('an event under a class of objects can drop the specialization', async () => {
        const source = 'package p\nclass Carro of objects\nevent Meeting specializes Carro';
        expect(await offered(source, 'stereotype-nature-unreachable'))
            .toContain('Remove specialization of "Carro" (functional-complexes, collectives, quantities)');
        expect(await firstApplied(source, 'stereotype-nature-unreachable')).toContain('event Meeting');
    });

    test('or keep the hierarchy and change the stereotype', async () => {
        const source = 'package p\nclass Carro of objects\nevent Meeting specializes Carro';
        expect(await offered(source, 'stereotype-nature-unreachable')).toContain('Change to kind');
    });

    test('the whole clause goes when every supertype offends', async () => {
        // Removing one of two would only report the other.
        const source = 'package p\nclass Carro of objects\nclass Barco of objects\nevent M specializes Carro, Barco';
        const titles = await offered(source, 'stereotype-nature-unreachable');
        expect(titles[0]).toBe('Remove all the specializations');
        expect(await firstApplied(source, 'stereotype-nature-unreachable')).toContain('event M');
    });

    test('only offending supertypes are offered for removal', async () => {
        // Wide permits events, so it is not what makes the event impossible;
        // only Narrow is offered, and the whole-clause action is not.
        const source = 'package p\nclass Wide of events, functional-complexes\nclass Narrow of functional-complexes\nevent M specializes Wide, Narrow';
        const titles = await offered(source, 'stereotype-nature-unreachable');
        expect(titles).not.toContain('Remove all the specializations');
        expect(titles.filter(t => t.startsWith('Remove'))).toEqual(['Remove specialization of "Narrow" (functional-complexes)']);
    });

    test('a diverging "of" clause offers both repairs when both work', async () => {
        // Non-sortals throughout, so dropping the supertype is a genuine
        // repair rather than a trade of one error for another.
        const source = 'package p\ncategory Wide of functional-complexes\nmixin Odd of relators specializes Wide';
        expect(await offered(source, 'declared-nature-incompatible-with-inherited')).toEqual([
            'Remove specialization of "Wide" (functional-complexes)',
            'Remove the nature restriction'
        ]);
    });

    test('a supertype is offered when dropping it does resolve the clash', async () => {
        const source = 'package p\ncategory Wide of relators\nmixin Odd of functional-complexes specializes Wide';
        expect(await offered(source, 'declared-nature-incompatible-with-inherited'))
            .toContain('Remove specialization of "Wide" (relators)');
    });

    test('and withheld when dropping it would leave the class with no identity', async () => {
        // `subkind Odd of events` alone draws identity from nothing, so only
        // the nature restriction is offered for removal.
        const source = 'package p\nkind Person\nsubkind Odd of events specializes Person';
        expect(await offered(source, 'declared-nature-incompatible-with-inherited'))
            .toEqual(['Remove the nature restriction']);
    });
});

describe('one rule decides which repairs are offered', () => {
    async function offered(source: string, code: string): Promise<string[]> {
        const document = await parse(source);
        return (await fixesFor(document, code)).map(a => a.title);
    }

    test('a supertype reached through an intermediate is named', async () => {
        const titles = await offered('package p\nrelator R\nsubkind Mid specializes R\nevent E specializes Mid', 'stereotype-nature-unreachable');
        expect(titles[0]).toBe('Remove specialization of "Mid" (relators)');
    });

    test('neither of two jointly-guilty supertypes is blamed alone', async () => {
        // Dropping either leaves the other contradicting the stereotype just
        // as flatly, so only the whole clause is offered.
        const titles = await offered('package p\nclass Carro of objects\nclass Barco of objects\nevent M specializes Carro, Barco', 'stereotype-nature-unreachable');
        expect(titles.filter(t => t.startsWith('Remove'))).toEqual(['Remove all the specializations']);
    });

    test('a stereotype change is offered only when it resolves the clash', async () => {
        const titles = await offered('package p\nclass Carro of objects\nevent Meeting specializes Carro', 'stereotype-nature-unreachable');
        expect(titles).toContain('Change to kind');
        // An event is the one thing it cannot stay.
        expect(titles).not.toContain('Change to event');
    });
});

describe('completion applies the nature rules', () => {
    test('offers historical founding relations and their events after a historical role derivedFrom', async () => {
        const source = 'package p\nkind Person\nevent Birth\nsubkind BirthInBrazil specializes Birth\n'
            + '@creation relation Person (const) [1] -- wasBornIn -- [1] (const) Birth\n'
            + 'kind Vehicle\nevent Manufacture\n'
            + '@creation relation Vehicle (const) [1] -- wasManufacturedIn -- [1] (const) Manufacture\n'
            + 'historicalRole BornInBrazil specializes Person derivedFrom ';
        const document = await parse(source);
        const labels = (await completeAtEnd(document)).map(item => String(item.label));
        expect(labels).toContain('wasBornIn');
        expect(labels).toContain('Birth');
        expect(labels).toContain('BirthInBrazil');
        expect(labels).not.toContain('Person');
        expect(labels).not.toContain('Manufacture');
        expect(labels).not.toContain('wasManufacturedIn');
        const checked = await new TontoSession().validateText(inOntologyInPlace(source + 'BirthInBrazil'));
        expect(checked.filter(diag => diag.severity === 'error')).toEqual([]);
    });

    test('an ambiguous event is not offered as the ground of a historical role', async () => {
        const source = 'package p\nkind Person\nevent Meeting\n'
            + '@participation relation Person (const) [1..*] -- attended -- [*] (addOnly) Meeting\n'
            + '@participation relation Person (const) [1..*] -- chaired -- [*] (addOnly) Meeting\n'
            + 'historicalRole FormerAttendee specializes Person derivedFrom ';
        const document = await parse(source);
        const labels = (await completeAtEnd(document)).map(item => String(item.label));
        expect(labels).toContain('attended');
        expect(labels).toContain('chaired');
        expect(labels).not.toContain('Meeting');
    });

    const universe = `
        class Carro of objects
        class Vago
        event Reuniao
        subkind Sessao specializes Reuniao
        relator Casamento
        category Coisa of relators
        kind Pessoa
    `;

    async function proposals(trailing: string, needle?: string, delta = 0): Promise<string[]> {
        const document = await parse(`package p\n${universe}\n${trailing}`);
        const items = needle === undefined
            ? await completeAtEnd(document)
            : await completeAt(document, needle, delta);
        return items.filter(i => i.detail === 'ClassDeclaration').map(i => String(i.label)).sort();
    }

    test('a stereotyped "class" still restricts what may specialize it', async () => {
        // `class` commits to nothing by stereotype, but `of objects` does, and
        // an event cannot be an object. Nor can it specialize another event, so
        // only the unconstrained `class` survives.
        expect(await proposals('event Meeting specializes ')).toEqual(['Vago']);
    });

    test('an unconstrained "class" is still offered everywhere', async () => {
        expect(await proposals('relator R specializes ')).toContain('Vago');
    });

    test('a kind may sit under a class of objects', async () => {
        expect(await proposals('kind K specializes ')).toEqual(['Carro', 'Vago']);
    });

    test('a bare class is offered everything, having no commitments of its own', async () => {
        expect(await proposals('class Anything specializes '))
            .toEqual(['Carro', 'Casamento', 'Coisa', 'Pessoa', 'Reuniao', 'Sessao', 'Vago']);
    });

    describe('generalization sets get the same reasoning', () => {
        test('a specific must be able to specialize the general', async () => {
            // Carro is out; Vago stays, having no commitments to violate.
            expect(await proposals('genset G where Sessao specializes Reuniao', 'where Sessao', 6))
                .toEqual(['Sessao', 'Vago']);
        });

        test('the general must be specializable by every specific', async () => {
            expect(await proposals('genset G where Sessao specializes Reuniao', 'specializes Reuniao', 12))
                .toEqual(['Reuniao', 'Vago']);
        });
    });
});

describe('fixes for the UFO and naming checks', () => {
    async function firstFix(source: string, code: string): Promise<{ title: string; applied: string }> {
        const document = await parse(source);
        const actions = await fixesFor(document, code);
        return { title: actions[0].title, applied: applyFirst(document, actions) };
    }

    test('a diamond on a stereotype that is not parthood comes off', async () => {
        // The converse marks the whole; this is the same edit the other way,
        // and the two cannot both stay.
        const { title, applied } = await firstFix(
            'package p\nkind Person\nkind Org\n@material relation Org [1] <>-- employs -- [0..*] Person',
            'diamond-without-parthood');
        expect(title).toBe('Drop the diamond');
        expect(applied).toContain('relation Org [1] -- employs -- [0..*] Person');
    });

    test('and so does an inverted one', async () => {
        const { applied } = await firstFix(
            'package p\ncollective Fleet\nkind Car\n@material relation Car [1] --<> [0..*] Fleet',
            'diamond-without-parthood');
        expect(applied).toContain('relation Car [1] -- [0..*] Fleet');
    });

    test('a documentation tag with nothing after it is deleted', async () => {
        const { title, applied } = await firstFix(
            'package p\n/// @en A person.\n/// @label\nkind Person', 'empty-doc-tag');
        expect(title).toBe('Remove this documentation line');
        expect(applied).toContain('/// @en A person.\nkind Person');
        expect(applied).not.toContain('@label');
    });

    test('and so is a language said twice', async () => {
        const { applied } = await firstFix(
            'package p\n/// @en A person.\n/// @en Someone.\nkind Person', 'duplicate-doc-language');
        expect(applied).toContain('/// @en A person.\nkind Person');
        expect(applied).not.toContain('Someone');
    });

    test('an extrinsic mode with nothing outside to depend on may be an intrinsic one', async () => {
        // The message already names the stereotype; the repair writes it.
        const document = await parse(
            'package p\nkind Person\nextrinsicMode Love {\n@characterization [1] -- [1] (const) Person\n}');
        const actions = await fixesFor(document, 'extrinsic-mode-without-dependence');
        expect(actions.map(action => action.title)).toContain('Change to "intrinsicMode"');
        expect(applyFirst(document, actions.filter(a => /intrinsicMode/.test(a.title))))
            .toContain('intrinsicMode Love');
    });

    test('a role with no relator behind it may be a phase', async () => {
        const document = await parse('package p\nkind Person\nrole Employee specializes Person');
        const actions = await fixesFor(document, 'role-without-relator');
        expect(actions.map(action => action.title)).toContain('Change to "phase"');
        expect(applyFirst(document, actions.filter(a => /phase/.test(a.title))))
            .toContain('phase Employee specializes Person');
    });

    test('and the four "nothing says what this is" checks stereotype an association', async () => {
        // The helper the bearer and mediation repairs already used, pointed at
        // the rest of the family.
        for (const [code, stereotype, source] of [
            ['process-without-constitution', 'constitution',
                'package p\nevent Step\nprocess Baking {\n-- [1..*] Step\n}'],
            ['event-without-participation', 'participation',
                'package p\nevent Wedding\nkind Person {\n-- [1] Wedding\n}'],
            ['collective-without-members', 'membership',
                'package p\nkind Person\ncollective Choir {\n[1] <>-- [2..*] Person\n}']
        ] as const) {
            const document = await parse(source);
            const actions = await fixesFor(document, code);
            expect(actions.map(action => action.title).join(' '), code).toContain(`Add "@${stereotype}"`);
            expect(applyFirst(document, actions), code).toContain(`@${stereotype} `);
        }
    });

    test('and a material relation with no relator offers to extract one', async () => {
        const { title, applied } = await firstFix(
            'package p\nkind Person\nrole Employee specializes Person\nkind Org\n'
            + '@material relation Employee [0..*] -- worksFor -- [1..*] Org',
            'material-without-relator');
        expect(title).toBe('Write the relator "WorksFor" this is derived from');
        expect(applied).toContain('relator WorksFor {');
    });

    test('a chain that climbs is answered at the bound beside the whole', async () => {
        // Reported case. Dropping the lower bound stops the climb at a root
        // and leaves the rest of the line alone.
        const { title, applied } = await firstFix(
            'package p\nkind Node {\n@componenthood <>-- [0..1] Node\n}', 'parthood-climbs-forever');
        expect(title).toBe('Let "Node" have no whole: "[0..1]"');
        expect(applied).toContain('@componenthood [0..1] <>-- [0..1] Node');
    });

    test('and keeps the upper bound it found', async () => {
        const { applied } = await firstFix(
            'package p\nkind Node {\n@componenthood [1..*] <>-- [*] Node\n}', 'parthood-climbs-forever');
        expect(applied).toContain('@componenthood [0..*] <>-- [*] Node');
    });

    test('and one that descends at the bound beside the part', async () => {
        const { title, applied } = await firstFix(
            'package p\nkind Node {\n@componenthood [0..1] <>-- [1] Node\n}', 'parthood-descends-forever');
        expect(title).toBe('Let "Node" have no parts: "[0..1]"');
        expect(applied).toContain('@componenthood [0..1] <>-- [0..1] Node');
    });

    test('and a bound written at a supertype is the one the repair drops', async () => {
        // Nothing at `ComplexNode` says parthood; the line to change is the
        // one it inherits, and the title names the end it sits beside.
        const { title, applied } = await firstFix(
            'package p\nkind Node\nsubkind ComplexNode specializes Node {\n'
            + '@componenthood [1] <>-- [0..1] Node\n}\nsubkind LeafNode specializes Node',
            'parthood-climbs-forever');
        expect(title).toBe('Let "Node" have no whole: "[0..1]"');
        expect(applied).toContain('@componenthood [0..1] <>-- [0..1] Node');
    });

    test('and a model that claims both is reported and repaired twice', async () => {
        // `<>-- Node` writes neither bound, and an omitted one is exactly one
        // at either end: every node contains one and belongs to one.
        const document = await parse('package p\nkind Node {\n@componenthood <>-- Node\n}');
        const climbs = await fixesFor(document, 'parthood-climbs-forever');
        const descends = await fixesFor(document, 'parthood-descends-forever');
        expect(climbs.map(action => action.title)).toEqual(['Let "Node" have no whole: "[0..1]"']);
        expect(descends.map(action => action.title)).toEqual(['Let "Node" have no parts: "[0..1]"']);
        expect(applyFirst(document, climbs)).toContain('@componenthood [0..1] <>-- Node');
        expect(applyFirst(document, descends)).toContain('@componenthood <>-- [0..1] Node');
    });

    describe('a generalization set and an instantiation that disagree', () => {
        const model = [
            'package p', 'type CarType isPowerType', 'subkind CarModel specializes CarType',
            'kind Car (instanceOf CarType) {',
            '@instantiation [*] -- [1..*] CarType', '@instantiation [*] -- %s CarModel', '}',
            '%g genset carModels {', 'general Car', 'categorizer CarModel', 'specifics VWBug, Golf', '}',
            'subkind VWBug specializes Car', 'subkind Golf specializes Car'
        ].join('\n');

        test('a complete set cannot start at zero, so the bound rises', async () => {
            // Reported case.
            const document = await parse(model.replace('%s', '[*]').replace('%g', 'disjoint complete'));
            const actions = await fixesFor(document, 'genset-contradicts-instantiation');
            expect(actions.map(action => action.title))
                .toEqual(['Instantiate at least one: "[1..*]"', 'Drop "complete"']);
            expect(applyFirst(document, actions)).toContain('@instantiation [*] -- [1..*] CarModel');
        });

        test('and an overlapping set cannot stop at one, so it widens', async () => {
            const document = await parse(model.replace('%s', '[1]').replace('%g ', ''));
            const actions = await fixesFor(document, 'genset-contradicts-instantiation');
            expect(actions.map(action => action.title))
                .toEqual(['Let it instantiate more than one: "[1..*]"', 'Make the set "disjoint"']);
            expect(applyFirst(document, actions)).toContain('@instantiation [*] -- [1..*] CarModel');
            expect(applyFirst(document, [actions[1]])).toContain('disjoint genset carModels');
        });

        test('a set that is complete and overlapping constrains both bounds', async () => {
            // Only one shape satisfies both, so it is said once rather than as
            // two complaints that fix each other in turn -- and neither word
            // may go on its own: dropping "complete" leaves an upper bound of
            // one under an overlapping set, and writing "disjoint" leaves a
            // lower bound of zero under a complete one.
            const document = await parse(model.replace('%s', '[0..1]').replace('%g', 'complete'));
            const actions = await fixesFor(document, 'genset-contradicts-instantiation');
            expect(actions.map(action => action.title))
                .toEqual(['Instantiate one of them, or more: "[1..*]"']);
            expect(applyFirst(document, actions)).toContain('@instantiation [*] -- [1..*] CarModel');
        });

        test('and "disjoint" is written in front of what the set already says', async () => {
            // The grammar takes `disjoint` before `complete`, so writing it
            // against `genset` gave `complete disjoint genset`.
            const document = await parse(model.replace('%s', '[1]').replace('%g', 'complete'));
            const actions = await fixesFor(document, 'genset-contradicts-instantiation');
            const written = applyFirst(document, actions.filter(action => /disjoint/.test(action.title)));
            expect(written).toContain('disjoint complete genset carModels');
        });

        test('and either repair leaves a model with nothing to say', async () => {
            for (const [written, general] of [
                ['[*]', 'disjoint complete'], ['[1]', ''], ['[0..1]', 'complete'], ['[1]', 'complete']
            ] as const) {
                const source = model.replace('%s', written).replace(general === '' ? '%g ' : '%g', general);
                const document = await parse(source);
                for (const action of await fixesFor(document, 'genset-contradicts-instantiation')) {
                    const after = await new TontoSession().validateText(applyFirst(document, [action]));
                    expect(after.map(one => one.code), action.title).toEqual([]);
                }
            }
        });
    });

    test('an end whose stereotype is the only thing wrong is offered the right word', async () => {
        // Reported case: an intrinsic mode depends on nothing beyond its
        // bearer, and this one declares an `@externalDependence`.
        const { title, applied } = await firstFix(
            'package p\nkind Car\nintrinsicMode CarCapacity {\n@characterization [*] -- [1] (const) Car\n'
            + '@externalDependence -- (const) Car\n}',
            'relation-end-nature-mismatch');
        expect(title).toBe('Change "CarCapacity" to "extrinsicMode"');
        expect(applied).toContain('extrinsicMode CarCapacity');
        expect((await new TontoSession().validateText(applied)).map(one => one.code)).toEqual([]);
    });

    test('and the same wherever one word would do it', async () => {
        expect((await fixesFor(
            await parse('package p\nkind Person\nkind Marriage {\n@mediation [1] -- [2] (const) Person\n}'),
            'relation-end-nature-mismatch')).map(action => action.title))
            .toEqual(['Change "Marriage" to "relator"']);
        expect((await fixesFor(
            await parse('package p\nkind Person\nkind Team {\n@membership [1] <>-- [2..*] Person\n}'),
            'relation-end-nature-mismatch')).map(action => action.title))
            .toEqual(['Change "Team" to "collective"']);
    });

    test('but not where several words would satisfy the table', async () => {
        // A relator mediating an event: what the event *is* is the question,
        // and "kind", "collective", "quantity", "relator" in turn is no help.
        const document = await parse(
            'package p\nrelator Marriage {\n@mediation [1] -- [2] (const) Wedding\n}\nevent Wedding');
        expect(await fixesFor(document, 'relation-end-nature-mismatch')).toEqual([]);
    });

    test('a categorizer outside its powertype is offered the generalization', async () => {
        // Reported case. The categorizer classifies specializations of the
        // base, and those are instances of the powertype, so the taxonomy has
        // only to say what the model means -- and a "type" under a "type"
        // becomes a subkind, which is how MLT writes a mirrored hierarchy.
        const { title, applied } = await firstFix(
            'package p\ntype CarType isPowerType\ntype CarModel\nkind Car {\n'
            + '@instantiation [*] -- [1..*] CarType\n@instantiation [*] -- [*] CarModel\n}',
            'categorizer-not-under-powertype');
        expect(title).toBe('Make "CarModel" a subkind of "CarType"');
        expect(applied).toContain('subkind CarModel specializes CarType');
    });

    test('an ambiguous short reference offers to say which was meant', async () => {
        const document = await parse(
            'package p\nkind Person\nmixin A {\n-- [0..*] (parts) Person\n}\n'
            + 'mixin B {\n-- [0..*] (parts) Person\n}\n'
            + 'kind X specializes A, B {\n-- [0..1] (mine subsets parts) Person\n}');
        const actions = await fixesFor(document, 'short-reference-ambiguous');
        // One per branch, nearest first -- which is what it resolves to today.
        expect(actions.map(action => action.title)).toEqual(['Write "B.parts"', 'Write "A.parts"']);
        expect(applyFirst(document, actions)).toContain('(mine subsets B.parts)');
    });

    test('an end that subsets a wider type offers the generalization it is missing', async () => {
        // Reported case. The taxonomy has not caught up with what the end
        // says: `LionHeart` was always meant to be a physical object.
        const document = await parse([
            'package p',
            'category PhysicalObject of functional-complexes',
            'mixin ComplexPhysicalObject specializes PhysicalObject {',
            '@componenthood (wholes) [0..*] <>-- hasPart -- [2..*] (parts) PhysicalObject',
            '}',
            'kind Lion specializes ComplexPhysicalObject {',
            '@componenthood (whole) <>-- [1] (heart subsets ComplexPhysicalObject.parts) LionHeart'
            + ' specializes ComplexPhysicalObject.hasPart',
            '}',
            'kind LionHeart'
        ].join('\n'));
        const actions = await fixesFor(document, 'override-type-not-narrower');
        expect(actions.map(action => action.title))
            .toEqual(['Specialize "PhysicalObject"', 'Remove "subsets"']);
        const applied = applyFirst(document, actions);
        expect(applied).toContain('kind LionHeart specializes PhysicalObject');
        // The relation specialization was making the same complaint, so the
        // one generalization answers both.
        expect((await new TontoSession().validateText(applied)).map(one => one.code)).toEqual([]);
    });

    test('and an end whose owner is unrelated offers the same', async () => {
        const document = await parse(
            'package p\nkind Person\nkind Team {\n-- [0..*] (staff) Person\n}\n'
            + 'kind Club {\n-- [0..*] (fans subsets Team.staff) Person\n}');
        const actions = await fixesFor(document, 'override-owner-not-subtype');
        // A kind cannot specialize a kind, so the repair re-stereotypes with
        // the clause -- which is what `addSupertype` does everywhere else.
        expect(actions.map(action => action.title))
            .toEqual(['Make "Club" a subkind of "Team"', 'Remove "subsets"']);
        expect(applyFirst(document, actions)).toContain('subkind Club specializes Team');
    });

    test('a deprecated "mode" is offered the reading the model supports', async () => {
        // No external dependence anywhere in its lineage, so the intrinsic
        // pair -- the ultimate sortal first, the category second.
        const document = await parse(
            'package p\nkind Person\nmode Skill {\n@characterization [1] -- [1] (const) Person\n}');
        const actions = await fixesFor(document, 'deprecated-stereotype');
        expect(actions.map(action => action.title))
            .toEqual(['Change to "intrinsicMode"', 'Change to "category of intrinsic-modes"']);
        expect(applyFirst(document, actions)).toContain('intrinsicMode Skill {');
        expect(applyFirst(document, [actions[1]])).toContain('category Skill of intrinsic-modes {');
    });

    test('and the extrinsic pair where something outside is depended on', async () => {
        const document = await parse(
            'package p\nkind Person\nmode Love {\n@characterization [1] -- [1] (const) Person\n'
            + '@externalDependence [1] -- [1] (const) Person\n}');
        const actions = await fixesFor(document, 'deprecated-stereotype');
        expect(actions.map(action => action.title))
            .toEqual(['Change to "extrinsicMode"', 'Change to "category of extrinsic-modes"']);
    });

    test('a class that says it classifies both can only become a category', async () => {
        // Which is the one thing the word was for, and the clause already
        // says which natures -- so only the word changes.
        const document = await parse(
            'package p\nkind Person\nmode Aspect of intrinsic-modes, extrinsic-modes {\n'
            + '@characterization [1] -- [1] (const) Person\n}');
        const actions = await fixesFor(document, 'deprecated-stereotype');
        expect(actions.map(action => action.title)).toEqual(['Change to "category"']);
        expect(applyFirst(document, actions)).toContain('category Aspect of intrinsic-modes, extrinsic-modes {');
    });

    test('and it is never proposed, in any list', async () => {
        const atTop = await completeAtEnd(await parse('package p\n'));
        expect(atTop.map(item => item.label)).not.toContain('mode');
        // Nor part-way through the word it shares a prefix with.
        const typing = await completeAtEnd(await parse('package p\nmo'));
        expect(typing.map(item => item.label)).toEqual(['intrinsicMode', 'extrinsicMode']);
    });

    test('a lowercase type name is capitalized', async () => {
        const { title, applied } = await firstFix('package p\nkind pessoa', 'type-name-case');
        expect(title).toBe('Rename to "Pessoa"');
        expect(applied).toContain('kind Pessoa');
    });

    test('an uppercase attribute name is lowered', async () => {
        const { applied } = await firstFix('package p\ndatatype String\nkind A { Nome: String }', 'member-name-case');
        expect(applied).toContain('nome: String');
    });

    test('the missing phase partition is written out', async () => {
        const { title, applied } = await firstFix(
            'package p\nkind Person\nphase Child specializes Person\nphase Adult specializes Person',
            'phases-without-partition');
        expect(title).toBe('Add a disjoint complete generalization set over "Child", "Adult"');
        expect(applied).toContain('disjoint complete genset PersonPhase where Child, Adult specializes Person');
    });

    test('beside an existing partition, the new one holds only the phases outside it', async () => {
        const { title, applied } = await firstFix([
            'package p', 'kind Person',
            'phase Child specializes Person', 'phase Adult specializes Person',
            'disjoint complete genset PersonPhase where Child, Adult specializes Person',
            'phase IllPerson specializes Person', 'phase HealthyPerson specializes Person'
        ].join('\n'), 'phases-without-partition');
        // Named, since which phases go in is the point.
        expect(title).toBe('Add a disjoint complete generalization set over "IllPerson", "HealthyPerson"');
        expect(applied).toContain('disjoint complete genset PersonPhase2 where IllPerson, HealthyPerson specializes Person');
    });

    test('and so is the missing partition of phase mixins', async () => {
        const source = [
            'package p', 'category Device of functional-complexes',
            'phaseMixin FunctionalDevice specializes Device', 'phaseMixin BrokenDevice specializes Device',
            'kind Phone specializes Device',
            'phase WorkingPhone specializes Phone, FunctionalDevice', 'phase BrokenPhone specializes Phone, BrokenDevice',
            'disjoint complete genset phoneStatus where WorkingPhone, BrokenPhone specializes Phone',
            'kind Printer specializes Device',
            'phase WorkingPrinter specializes Printer, FunctionalDevice', 'phase BrokenPrinter specializes Printer, BrokenDevice',
            'disjoint complete genset printerStatus where WorkingPrinter, BrokenPrinter specializes Printer',
            'disjoint complete genset working where WorkingPhone, WorkingPrinter specializes FunctionalDevice',
            'disjoint complete genset broken where BrokenPhone, BrokenPrinter specializes BrokenDevice'
        ].join('\n');
        const { title, applied } = await firstFix(source, 'phase-mixins-without-partition');
        expect(title).toBe('Add a disjoint complete generalization set over "FunctionalDevice", "BrokenDevice"');
        expect(applied).toContain('disjoint complete genset DevicePhase where FunctionalDevice, BrokenDevice specializes Device');
        const reparsed = await reparse(applied.replace('package p', 'package q'), { validation: true });
        expect(reparsed.diagnostics ?? []).toEqual([]);
    });

    test('the generated partition satisfies the check it came from', async () => {
        const { applied } = await firstFix(
            'package p\nkind Person\nphase Child specializes Person\nphase Adult specializes Person',
            'phases-without-partition');
        const reparsed = await reparse(applied.replace('package p', 'package q'), { validation: true });
        expect(reparsed.diagnostics ?? []).toEqual([]);
    });
});

describe('repairing a forbidden generalization', () => {
    const hierarchy = 'package p\nkind LegalObject\nkind Norm specializes LegalObject\nkind Rule specializes Norm';

    async function actionsAt(source: string, code: string, which = 0) {
        const document = await parse(source);
        const diagnostics = (document.diagnostics ?? []).filter((d: Diagnostic) => d.code === code);
        expect(diagnostics.length, `no diagnostic with code ${code}`).toBeGreaterThan(which);
        const actions = await services.lsp.CodeActionProvider!.getCodeActions(document, {
            textDocument: { uri: document.textDocument.uri },
            range: diagnostics[which].range,
            context: { diagnostics: [diagnostics[which]] }
        });
        const repairs = (actions ?? [])
            .filter(action => 'kind' in action && action.kind === CodeActionKind.QuickFix);
        return { document, actions: repairs as { title: string; edit?: never }[] };
    }

    test('offers every sortal the parent admits, before the removal', async () => {
        const { actions } = await actionsAt(hierarchy, 'stereotype-cannot-specialize', 1);
        expect(actions.map(a => a.title)).toEqual([
            'Change "Rule" to subkind',
            'Change "Rule" to role',
            'Change "Rule" to phase',
            'Change "Rule" to historicalRole',
            'Remove "specializes Norm"'
        ]);
    });

    test('applying the first keeps the hierarchy', async () => {
        const { document, actions } = await actionsAt(hierarchy, 'stereotype-cannot-specialize', 1);
        expect(applyFirst(document, actions)).toContain('subkind Rule specializes Norm');
    });

    test('subtypes narrow what the parent may become', async () => {
        // With Rule a rigid subkind, Norm cannot become an anti-rigid role or
        // phase, so only subkind is left.
        const fixed = 'package p\nkind LegalObject\nkind Norm specializes LegalObject\nsubkind Rule specializes Norm';
        const { actions } = await actionsAt(fixed, 'stereotype-cannot-specialize');
        expect(actions.map(a => a.title)).toEqual([
            'Change "Norm" to subkind',
            'Remove "specializes LegalObject"'
        ]);
    });

    test('a generalization set gets the same choices', async () => {
        const { actions } = await actionsAt(
            'package p\nkind Norm\nkind Rule\nkind Other\ngenset G where Rule, Other specializes Norm',
            'genset-stereotype-cannot-specialize');
        expect(actions.map(a => a.title)).toContain('Change "Rule" to subkind');
        expect(actions.map(a => a.title)).toContain('Remove "Rule" from the specifics');
    });

    test('and the last specific takes the set with it', async () => {
        // `genset G where  specializes Norm` does not parse: a set that states
        // no generalization is a leftover, not a repair.
        const { actions } = await actionsAt(
            'package p\nkind Norm\nkind Rule\ngenset G where Rule specializes Norm', 'genset-stereotype-cannot-specialize');
        expect(actions.map(a => a.title)).toContain('Remove the generalization set "G"');
    });

    test('a repeated supertype still offers only removal', async () => {
        // Same shape, different cause: restereotyping would repair nothing.
        const { actions } = await actionsAt(
            'package p\nkind A\nsubkind B specializes A, A', 'duplicate-supertype');
        expect(actions.map(a => a.title).every(t => t.startsWith('Remove'))).toBe(true);
    });
});

describe('a case fix renames the references too', () => {
    test('the reported case: specializes no longer dangles', async () => {
        const document = await parse('package p\nkind carro\nsubkind Sedan specializes carro');
        const actions = await fixesFor(document, 'type-name-case');
        const applied = applyFirst(document, actions);
        expect(applied).toContain('kind Carro');
        expect(applied).toContain('specializes Carro');
        // The whole point: the result still links.
        const reparsed = await reparse(applied.replace('package p', 'package q'), { validation: true });
        expect(reparsed.diagnostics ?? []).toEqual([]);
    });

    test('the title says how much it touches', async () => {
        const document = await parse('package p\nkind carro\nsubkind Sedan specializes carro');
        const actions = await fixesFor(document, 'type-name-case');
        expect(actions[0].title).toBe('Rename to "Carro" and its one reference');
    });

    test('a declaration nothing names is renamed on its own', async () => {
        const document = await parse('package p\nkind carro');
        const actions = await fixesFor(document, 'type-name-case');
        expect(actions[0].title).toBe('Rename to "Carro"');
    });

    test('an attribute rename reaches its references', async () => {
        const document = await parse('package p\nkind A\nkind B { -- [1] (Membros) A\n-- [1] (subsets B.Membros) A }');
        const actions = await fixesFor(document, 'member-name-case');
        const applied = applyFirst(document, actions);
        expect(applied).toContain('(membros)');
        expect(applied).toContain('subsets B.membros');
    });

    test('references in another document are rewritten, keeping the qualifier', async () => {
        // Distinct names: other tests in this file also declare `carro`.
        const owner = await parseDocument('package motors in motoring\nkind veiculo\n', { validation: true });
        const importer = await parseDocument('use motors\npackage importer in motoring\nsubkind Coupe specializes motors.veiculo\n',
            { validation: true });
        const diagnostic = (owner.diagnostics ?? []).find((d: Diagnostic) => d.code === 'type-name-case')!;
        const actions = await services.lsp.CodeActionProvider!.getCodeActions(owner, {
            textDocument: { uri: owner.textDocument.uri },
            range: diagnostic.range,
            context: { diagnostics: [diagnostic] }
        });
        const changes = (actions![0] as { edit: { changes: Record<string, unknown[]> } }).edit.changes;
        expect(Object.keys(changes)).toContain(importer.textDocument.uri);
        expect(JSON.stringify(changes[importer.textDocument.uri])).toContain('motors.Veiculo');
    });
});

describe('hover on anonymous relations', () => {
    const model = `package p
kind Person
relator Marriage {
@mediation [1] -- [2] Person
}
kind Wheel
kind Car {
@componenthood [1] <>-- [4] Wheel
}
collective Forest {
@membership [1] <>-- trees -- [2..*] Wheel
}`;

    test('hovering the dashes of an unnamed relation describes it', async () => {
        const document = await parse(model);
        const content = await hoverAt(document, '[1] -- [2] Person', 4);
        expect(content).toContain('*(unnamed)*');
        expect(content).toContain('@mediation Marriage [1] -- [2] Person');
    });

    test('hovering the stereotype works too', async () => {
        const document = await parse(model);
        expect(await hoverAt(document, '@mediation', 2)).toContain('@mediation Marriage');
    });

    test('hovering a multiplicity works too', async () => {
        const document = await parse(model);
        expect(await hoverAt(document, '[2] Person', 1)).toContain('@mediation Marriage');
    });

    test('an unnamed relation renders one marker, not two', async () => {
        const document = await parse(model);
        expect(await hoverAt(document, '[1] -- [2] Person', 4)).not.toContain('-- --');
    });

    test('the aggregation diamond is carried into the signature', async () => {
        const document = await parse(model);
        expect(await hoverAt(document, '<>--', 1)).toContain('Car [1] <>-- [4] Wheel');
    });

    test('a named end keeps its name between the dashes', async () => {
        const document = await parse(model);
        expect(await hoverAt(document, '<>-- trees', 1)).toContain('Forest [1] <>-- trees -- [2..*] Wheel');
    });

    test('the target reference still hovers the class it names', async () => {
        const document = await parse(model);
        // The fallback must not shadow what the default provider answers.
        expect(await hoverAt(document, '[2] Person', 4)).toContain('**kind** `Person`');
    });
});

describe('MLT quick fixes', () => {
    test('a powertype end is opened to [1..*]', async () => {
        const document = await parse('package p\ntype CarType isPowerType\nkind Car { @instantiation -- [2..*] CarType }');
        const actions = await fixesFor(document, 'powertype-instantiation-multiplicity');
        expect(applyFirst(document, actions)).toContain('[1..*] CarType');
    });

    test('a powertype categorizer is removed, leaving the set intact', async () => {
        const source = 'package p\ntype PersonType isPowerType\nkind Person { @instantiation -- [1..*] PersonType }\nsubkind Man specializes Person\ngenset G {\ngeneral Person\ncategorizer PersonType\nspecifics Man\n}';
        const document = await parse(source);
        const applied = applyFirst(document, await fixesFor(document, 'powertype-as-categorizer'));
        expect(applied).not.toContain('categorizer');
        expect(applied).toContain('specifics Man');
        const reparsed = await reparse(applied.replace(/package p\d*/, 'package q'), { validation: true });
        expect(reparsed.diagnostics ?? []).toEqual([]);
    });
});

describe('correcting a mistyped stereotype', () => {
    test('offers the suggested stereotype', async () => {
        const document = await parse('package p\nkind A\nkind B\n@mediaton relation A [1] -- r -- [1] B');
        const actions = await fixesFor(document, 'unknown-relation-stereotype');
        expect(actions.map(a => a.title)).toEqual(['Change to "@mediation"']);
        expect(applyFirst(document, actions)).toContain('@mediation relation A');
    });
});

describe('a keyword may name a relation end', () => {
    async function parseErrors(source: string): Promise<number> {
        return (await parse(source)).parseResult.parserErrors.length;
    }

    test.each(['of', 'where', 'specializes', 'kind', 'const', 'functional-complexes'])(
        '"(%s)" is a name, not a keyword, inside the brackets', async keyword => {
            expect(await parseErrors(`package p\nkind A {\n-- [1] (${keyword}) B\n}\nkind B`)).toBe(0);
        });

    test('and between the two dashes of a relation name', async () => {
        expect(await parseErrors('package p\nkind A\nkind B\nrelation A [1] -- of -- [1] B')).toBe(0);
    });

    test('an end so named can still be subset', async () => {
        // A name nothing may refer to would be no better than no name.
        const document = await parse(
            'package p\nkind B {\n-- [1] (of) C\n}\nkind A specializes B {\n-- [1] (narrower subsets B.of) C\n}\nkind C');
        expect(document.parseResult.parserErrors).toEqual([]);
        expect((document.diagnostics ?? []).filter(d => /Could not resolve/.test(d.message))).toEqual([]);
    });

    test('but a class still cannot be called "of"', async () => {
        // `kind of objects` has to keep meaning what it says.
        expect(await parseErrors('package p\nkind of\nkind B')).toBeGreaterThan(0);
    });
});

describe('repairs for the multi-level and end rules', () => {
    /** Applies every edit of the first action, not just the first edit. */
    function applyAll(document: LangiumDocument, actions: { edit?: { changes?: Record<string, { range: { start: unknown; end: unknown }; newText: string }[]> } }[]): string {
        const edits = Object.values(actions[0].edit!.changes!)[0]
            .map(edit => ({
                start: document.textDocument.offsetAt(edit.range.start as never),
                end: document.textDocument.offsetAt(edit.range.end as never),
                newText: edit.newText
            }))
            .sort((a, b) => b.start - a.start);
        return edits.reduce((text, edit) => text.slice(0, edit.start) + edit.newText + text.slice(edit.end),
            document.textDocument.getText());
    }

    async function settles(source: string, code: string): Promise<{ title: string; text: string; errors: string[] }> {
        const document = await parse(source);
        const actions = await fixesFor(document, code);
        const text = applyAll(document, actions);
        // `parse` numbers each package, so the patched text needs the bare
        // name back or the re-parse collides with the document above.
        const applied = await reparse(text.replace(/^package \S+/, 'package p'));
        return {
            title: actions[0].title,
            text,
            errors: (applied.diagnostics ?? []).filter(d => d.severity === 1).map(d => d.code ?? d.message)
        };
    }

    test('a power type that classifies no types drops the modifier', async () => {
        const { title, text, errors } = await settles('package p\nkind Car isPowerType', 'powertype-does-not-classify-types');
        expect(title).toBe('Remove "isPowerType"');
        expect(text).toContain('kind Car');
        expect(errors).toEqual([]);
    });

    test('and so does one with no base', async () => {
        const { title, errors } = await settles('package p\ntype PersonType isPowerType', 'powertype-without-base');
        expect(title).toBe('Remove "isPowerType"');
        expect(errors).toEqual([]);
    });

    test('a base that instantiates its own higher type marks it as a power type', async () => {
        // Cardelli's reading is the one that includes the base itself.
        const { title, text, errors } = await settles(
            'package p\nkind Person (instanceOf PersonGender)\ntype PersonGender\n@instantiation relation Person [0..*] -- [0..*] PersonGender',
            'instance-is-its-own-base');
        expect(title).toBe('Mark "PersonGender" as "isPowerType"');
        expect(text).toContain('type PersonGender isPowerType');
        expect(errors).toEqual([]);
    });

    test('an instance outside its base becomes a subkind of it', async () => {
        // The clause alone would leave a kind under a kind, so the stereotype
        // moves with it.
        const { title, text, errors } = await settles(
            'package p\nkind Person\ntype PersonGender\n@instantiation relation Person [0..*] -- [1] PersonGender\nkind Elephant (instanceOf PersonGender)',
            'instance-not-specializing-base');
        expect(title).toBe('Make "Elephant" a subkind of "Person"');
        expect(text).toContain('subkind Elephant (instanceOf PersonGender) specializes Person');
        expect(errors).toEqual([]);
    });

    test('and a power type hierarchy is mirrored the same way', async () => {
        const { title, text, errors } = await settles(
            'package p\ntype PersonType isPowerType\ntype EmployeeType isPowerType\nkind Person { @instantiation -- [1..*] PersonType }\nrole Employee specializes Person { @instantiation -- [1..*] EmployeeType }',
            'powertype-hierarchy-mismatch');
        expect(title).toBe('Make "EmployeeType" a subkind of "PersonType"');
        expect(text).toContain('subkind EmployeeType isPowerType specializes PersonType');
        expect(errors).toEqual([]);
    });

    test('an inverse that runs the wrong way drops the clause', async () => {
        const { title, errors } = await settles(
            'package p\nkind Person\nkind Company\nrelation Person [1] -- worksAt -- [1] Company\n'
            + 'relation Person [1] -- alsoAt -- [1] Company inverseOf worksAt', 'inverse-signature-mismatch');
        expect(title).toBe('Remove "inverseOf"');
        expect(errors).toEqual([]);
    });

    test('and two ends of one name give one up', async () => {
        const { title, errors } = await settles(
            'package p\nkind Person\nrelation Person (peer) [1] -- knows -- [1] (peer) Person', 'duplicate-end-name');
        expect(title).toBe('Remove the duplicate end name');
        expect(errors).toEqual([]);
    });
});

describe('parthood across a specialization', () => {
    const parts = '@componenthood relation Car [1] <>-- fits -- [4] Wheel';
    const plain = 'relation Car [1] -- has -- [4] Wheel';
    const classes = 'package p\nkind Car\nkind Wheel\n';

    test('a parthood may not specialize an ordinary association', async () => {
        const document = await parse(`${classes}${plain}\n${parts} specializes Car.has`);
        const message = (document.diagnostics ?? [])
            .find(d => d.code === 'parthood-specialization-mismatch')?.message;
        expect(message).toContain('a parthood may only specialize a parthood');
    });

    test('nor may an ordinary association specialize a parthood', async () => {
        const document = await parse(`${classes}${parts}\n${plain} specializes Car.fits`);
        const message = (document.diagnostics ?? [])
            .find(d => d.code === 'parthood-specialization-mismatch')?.message;
        expect(message).toContain('states parthood, so a relation specializing it states parthood too');
    });

    test('and either can be repaired by marking a whole or dropping the clause', async () => {
        const document = await parse(`${classes}${plain}\n${parts} specializes Car.has`);
        const actions = await fixesFor(document, 'parthood-specialization-mismatch');
        expect(actions.map(a => a.title)).toEqual([
            'Mark the whole of "Car.has" with "<>--"',
            'Remove the specialization'
        ]);
        expect(applyFirst(document, actions)).toContain('relation Car [1] <>-- has -- [4] Wheel');
    });

    test('the implied specialization of a redefinition carries the rule', async () => {
        // No `specializes` clause anywhere: redefining the end is what makes
        // this a specialization, so it is what makes parthood disagree.
        const document = await parse(`${classes}relation Car [1] -- has -- [4] (w) Wheel\n`
            + 'subkind Sports specializes Car\n@componenthood relation Sports [1] <>-- [4] (redefines Car.w) Wheel');
        const actions = await fixesFor(document, 'parthood-specialization-mismatch');
        expect(actions.map(a => a.title)).toEqual(['Mark the whole of "Car.has" with "<>--"']);
    });

    test('and agreement is silent', async () => {
        const document = await parse(`${classes}${parts}\n`
            + '@componenthood relation Car [1] <>-- bolts -- [4] Wheel specializes Car.fits');
        expect((document.diagnostics ?? []).map(d => d.code)).not.toContain('parthood-specialization-mismatch');
    });
});

describe('a parthood stereotype written without a diamond', () => {
    test('is reported, since only the diamond marks the whole', async () => {
        const document = await parse('package p\ncollective Fleet\nkind Car\n@membership relation Fleet [1] -- [2..*] Car');
        const warning = (document.diagnostics ?? []).find(d => d.code === 'parthood-without-diamond');
        expect(warning?.severity).toBe(DiagnosticSeverity.Warning);
        expect(warning?.message).toContain('Mark the whole with a diamond: "<>--".');
    });

    test('and the whole is marked where the natures put it', async () => {
        const document = await parse('package p\ncollective Fleet\nkind Car\n@membership relation Fleet [1] -- [2..*] Car');
        const actions = await fixesFor(document, 'parthood-without-diamond');
        // One diamond now: whether the part is exclusive is the multiplicity
        // at the whole end, not a second glyph.
        expect(actions.map(a => a.title)).toEqual(['Mark the whole with "<>--"']);
        expect(applyFirst(document, actions)).toContain('Fleet [1] <>-- [2..*] Car');
    });

    test('on the side the natures put the whole', async () => {
        // Only a collective may be the whole of a membership, so writing the
        // collective second means the diamond belongs at the target.
        const document = await parse('package p\ncollective Fleet\nkind Car\n@membership relation Car [2..*] -- [1] Fleet');
        const actions = await fixesFor(document, 'parthood-without-diamond');
        expect(actions.map(a => a.title)).toEqual(['Mark the whole with "--<>"']);
        const applied = await parse(applyFirst(document, actions));
        // The ends were never reversed; the diamond was missing, and marking
        // it answers the nature error too.
        expect((applied.diagnostics ?? []).map(d => d.code)).not.toContain('relation-ends-reversed');
    });

    test('replacing the marker before the name, where the relation has one', async () => {
        const document = await parse('package p\nkind Car\nkind Wheel\n@componenthood relation Car [1] -- owns -- [4] Wheel');
        const actions = await fixesFor(document, 'parthood-without-diamond');
        expect(applyFirst(document, actions)).toContain('Car [1] <>-- owns -- [4] Wheel');
    });

    test('and nothing is said once a diamond is there', async () => {
        const document = await parse('package p\nkind Car\nkind Wheel\n@componenthood relation Car [1] <>-- [4] Wheel');
        expect((document.diagnostics ?? []).map(d => d.code)).not.toContain('parthood-without-diamond');
    });
});

describe('the specialization an override implies', () => {
    const general = 'package p\nclass Entity {\n[*] <>-- hasProperPartOf -- [*] (parts) Entity\n}\n';
    const override = general
        + 'class Object specializes Entity {\n[*] -- hasObjectPart -- [*] (objectParts redefines Entity.parts) Object\n}';

    test('is not required: the end reference already names the relation', async () => {
        const hint = (await parse(override)).diagnostics
            ?.find(d => d.code === 'implied-relation-specialization');
        expect(hint?.severity).toBe(DiagnosticSeverity.Hint);
        expect(hint?.message).toContain('implies that this relation specializes it');
    });

    test('but may be stated, and the fix writes it after the target', async () => {
        const document = await parse(override);
        const actions = await fixesFor(document, 'implied-relation-specialization');
        expect(actions.map(a => a.title)).toEqual(['Add "specializes Entity.hasProperPartOf"']);
        expect(applyFirst(document, actions))
            .toContain('Object specializes Entity.hasProperPartOf');
    });

    test('and is not mentioned once it is written, directly or indirectly', async () => {
        const direct = await parse(general
            + 'class Object specializes Entity {\n[*] -- p -- [*] (redefines Entity.parts) Object specializes Entity.hasProperPartOf\n}');
        const indirect = await parse(general
            + 'class Object specializes Entity {\n[*] -- a -- [*] (x) Object specializes Entity.hasProperPartOf\n}\n'
            + 'class Thing specializes Object {\n[*] -- b -- [*] (subsets Entity.parts) Thing specializes Object.a\n}');
        for (const document of [direct, indirect]) {
            expect((document.diagnostics ?? []).map(d => d.code)).not.toContain('implied-relation-specialization');
        }
    });

    test('nor where the relation narrowed is anonymous, having no name to state', async () => {
        const document = await parse(
            'package p\nkind Person\nkind Staff { <>-- [1..*] (members) Person }\n'
            + 'role Senior specializes Staff { <>-- [1..2] (m subsets Staff.members) Person }');
        expect((document.diagnostics ?? []).map(d => d.code)).not.toContain('implied-relation-specialization');
    });

    test('and an end with no name cannot be overridden at all', async () => {
        // Nothing exports it, so no spelling reaches it -- the grammar and the
        // scope enforce this, not a check.
        const document = await parse(
            'package p\nkind Person\nkind Staff { <>-- [1..*] (const) Person }\n'
            + 'role Senior specializes Staff { <>-- [1..2] (subsets Staff.members) Person }');
        expect((document.diagnostics ?? []).filter(d => /Could not resolve/.test(d.message))).toHaveLength(1);
    });
});

describe('an end reference written without its owner', () => {
    const model = 'package p\nclass Entity {\n[*] <>-- hasProperPartOf -- [*] (parts) Entity\n}\n'
        + 'class Aspect specializes Entity {\n[*] <>-- hasAspectProperPart -- [*] (redefines %s) Aspect specializes Entity.hasProperPartOf\n}';
    // The same reference from a class that inherits nothing of the sort.
    const stranger = 'package p\nclass Entity {\n[*] <>-- hasProperPartOf -- [*] (parts) Entity\n}\n'
        + 'class Aspect {\n[*] <>-- hasAspectProperPart -- [*] (redefines %s) Aspect\n}';

    test('resolves where the class inherits it', async () => {
        const document = await parse(model.replace('%s', 'parts'));
        expect((document.diagnostics ?? []).filter(d => /Could not resolve/.test(d.message))).toEqual([]);
    });

    test('and resolves when the owner is written too', async () => {
        const document = await parse(model.replace('%s', 'Entity.parts'));
        expect((document.diagnostics ?? []).filter(d => /Could not resolve/.test(d.message))).toEqual([]);
    });

    test('but not where nothing in the lineage declares it', async () => {
        const document = await parse(stranger.replace('%s', 'parts'));
        expect((document.diagnostics ?? []).filter(d => /Could not resolve/.test(d.message))).toHaveLength(1);
    });

    test('the fix qualifies it rather than offering to create a class', async () => {
        // An end is not a declaration, so nothing could be created to satisfy
        // the reference; "Create kind \"parts\"" was doubly wrong.
        const document = await parse(stranger.replace('%s', 'parts'));
        const diagnostic = (document.diagnostics ?? []).find(d => /Could not resolve/.test(d.message))!;
        const actions = await services.lsp.CodeActionProvider!.getCodeActions(document, {
            textDocument: { uri: document.textDocument.uri },
            range: diagnostic.range,
            context: { diagnostics: [diagnostic] }
        });
        expect((actions ?? []).filter(a => 'kind' in a && a.kind === CodeActionKind.QuickFix)
            .map(a => a.title)).toEqual(['Change to "Entity.parts"']);
    });

    test('and a near miss is offered too, the closest first', async () => {
        // Writing the end's name from memory is the other way to get this
        // wrong: "objectPart" where the end is "objectParts".
        const document = await parse(model.replace('%s', 'part'));
        const diagnostic = (document.diagnostics ?? []).find(d => /Could not resolve/.test(d.message))!;
        const actions = await services.lsp.CodeActionProvider!.getCodeActions(document, {
            textDocument: { uri: document.textDocument.uri },
            range: diagnostic.range,
            context: { diagnostics: [diagnostic] }
        });
        expect((actions ?? []).filter(a => 'kind' in a && a.kind === CodeActionKind.QuickFix)
            .map(a => a.title)).toEqual(['Change to "Entity.parts"']);
    });
});

describe('marking an end read-only', () => {
    test('into a decorator that is not there yet', async () => {
        const document = await parse('package p\nkind Place\nevent Wedding {\n-- [1] Place\n}');
        const actions = await fixesFor(document, 'immutable-end-not-const');
        expect(actions.map(a => a.title)).toEqual(['Mark the end "const"']);
        expect(applyFirst(document, actions)).toContain('-- [1] (const) Place');
    });

    test('beside a name that is', async () => {
        const document = await parse('package p\nkind Place\nevent Wedding {\n-- [1] (venue) Place\n}');
        expect(applyFirst(document, await fixesFor(document, 'immutable-end-not-const')))
            .toContain('(const venue)');
    });

    test('and beside the name an end already carries', async () => {
        const document = await parse('package p\nkind Place\nevent Wedding {\n-- [1..*] (venue) Place\n}');
        expect(applyFirst(document, await fixesFor(document, 'immutable-end-not-const')))
            .toContain('(const venue)');
    });

    test('at the source end it goes before the multiplicity, where the grammar takes it', async () => {
        const document = await parse('package p\nkind Place\nevent W\nrelation Place [1] -- [1] W');
        const applied = await parse(applyFirst(document, await fixesFor(document, 'immutable-end-not-const')));
        expect(applied.textDocument.getText()).toContain('relation Place (const) [1] -- [1] W');
        expect(applied.parseResult.parserErrors).toEqual([]);
    });

    test('replaces "addOnly" where this rule really requires "const"', async () => {
        const document = await parse('package p\nevent Birth\nkind Person {\n@creation [1] -- [1] (addOnly) Birth\n}');
        const applied = await parse(applyFirst(document, await fixesFor(document, 'creation-end-not-const')));
        expect(applied.textDocument.getText()).toContain('[1] (const) Birth');
        expect(applied.textDocument.getText()).not.toContain('const addOnly');
        expect(applied.parseResult.parserErrors).toEqual([]);
    });

    test('offers both readings for a plural dependence end', async () => {
        const document = await parse([
            'package p', 'kind Person', 'kind Organization', 'relator Grouping {',
            '@mediation [0..*] -- [1..*] Person',
            '@mediation [0..*] -- [1] (const) Organization', '}'
        ].join('\n'));
        const actions = await fixesFor(document, 'dependence-end-not-const');
        expect(actions.map(action => action.title)).toEqual([
            'Mark the end "const"', 'Mark the end "addOnly"'
        ]);
        expect(applyFirst(document, [actions[1]])).toContain('[1..*] (addOnly) Person');
    });
});

describe('repairs for begin and end points', () => {
    const preamble = 'package p\ndatatype Date\n';

    test('"const" is written in front of the type', async () => {
        const document = await parse(preamble + 'kind Person {\n@begin birth: Date\n}');
        const actions = await fixesFor(document, 'time-point-not-const');
        expect(actions.map(a => a.title)).toEqual(['Mark it "const"']);
        expect(applyFirst(document, actions)).toContain('@begin birth: const Date');
    });

    test('and beside the modifiers already there', async () => {
        const document = await parse(preamble + 'kind Person {\n@begin birth: derived Date [0..1]\n}');
        expect(applyFirst(document, await fixesFor(document, 'time-point-not-const')))
            .toContain('birth: derived const Date');
    });

    test('replaces an incompatible "addOnly" modifier', async () => {
        const document = await parse(preamble + 'kind Person {\n@begin birth: addOnly Date\n}');
        const applied = await parse(applyFirst(document, await fixesFor(document, 'time-point-not-const')));
        expect(applied.textDocument.getText()).toContain('@begin birth: const Date');
        expect(applied.parseResult.parserErrors).toEqual([]);
    });

    test('an end point on an endurant is made optional', async () => {
        const document = await parse(preamble + 'kind Person {\n@end death: const Date\n}');
        expect(applyFirst(document, await fixesFor(document, 'end-time-point-not-optional')))
            .toContain('@end death: const Date [0..1]');
        const written = await parse(preamble + 'kind Person {\n@end death: const Date [1..1]\n}');
        expect(applyFirst(written, await fixesFor(written, 'end-time-point-not-optional')))
            .toContain('[0..1]');
    });

    test('a repeated stereotype goes, with its "@"', async () => {
        const document = await parse(preamble + 'kind Person {\n@begin @begin birth: const Date\n}');
        const applied = await parse(applyFirst(document, await fixesFor(document, 'duplicate-attribute-stereotype')));
        expect(applied.textDocument.getText()).toContain('@begin birth: const Date');
        expect(applied.parseResult.parserErrors).toEqual([]);
    });

    test('and a mistyped one is corrected', async () => {
        const document = await parse(preamble + 'kind Person {\n@bgin birth: const Date\n}');
        const actions = await fixesFor(document, 'unknown-attribute-stereotype');
        expect(actions.map(a => a.title)).toEqual(['Change to "@begin"']);
        expect(applyFirst(document, actions)).toContain('@begin birth: const Date');
    });
});

describe('repairs for what the rules ask', () => {
    test('a lone phase may become a subkind', async () => {
        const document = await parse('package p\nkind Person\nphase Adult specializes Person');
        const actions = await fixesFor(document, 'lone-phase');
        expect(actions.map(a => a.title)).toEqual(['Change to "subkind"']);
        expect(applyFirst(document, actions)).toContain('subkind Adult specializes Person');
    });

    test('and the odd specific of a phase partition may become a phase', async () => {
        const document = await parse([
            'package p', 'kind Person', 'phase Adult specializes Person',
            'phase Child specializes Person', 'subkind Man specializes Person',
            'disjoint complete genset ages where Adult, Child, Man specializes Person'
        ].join('\n'));
        const actions = await fixesFor(document, 'partition-mixes-phases');
        expect(actions.map(a => a.title)).toEqual(['Change "Man" to phase']);
        expect(applyFirst(document, actions)).toContain('phase Man specializes Person');
    });

    test('and a historical role is offered the events in scope', async () => {
        const document = await parse(
            'package p\nkind Person\nevent Graduation\nevent Enrolling\nhistoricalRole FormerStudent specializes Person');
        const actions = await fixesFor(document, 'historical-role-without-event');
        expect(actions.map(a => a.title)).toEqual(['Participate in "Graduation"', 'Participate in "Enrolling"']);
        expect(applyFirst(document, actions))
            .toContain('@participation relation FormerStudent (const) [0..*] -- [1] Graduation');
    });
});

describe('recording an aspect as a property', () => {
    test('the characterization becomes a "const" property of the event', async () => {
        const document = await parse([
            'package p', 'datatype number', 'event Wedding',
            'quality Duration {', '    value: number', '}',
            '@characterization relation Duration [1] -- [1] (const) Wedding'
        ].join('\n'));
        const actions = await fixesFor(document, 'characterization-bearer-not-reifiable');
        // Nothing else names the aspect, so it goes rather than being left a
        // quality with no bearer.
        expect(actions.map(a => a.title)).toEqual(['Record it as a "const" property of "Wedding", in place of "Duration"']);
        const applied = applyFirst(document, actions);
        expect(applied).toContain('event Wedding {\n    duration: const number\n}');
        expect(applied).not.toContain('@characterization');
        expect(applied).not.toContain('quality Duration');
    });

    test('and nothing is offered where the aspect says no value', async () => {
        // What the property would be typed by is the question, and an aspect
        // with no attribute does not answer it.
        const document = await parse('package p\nsituation Ready\nintrinsicMode Urgency {\n@characterization -- [1] (const) Ready\n}');
        expect(await fixesFor(document, 'characterization-bearer-not-reifiable')).toEqual([]);
    });
});

describe('repairs for "addOnly"', () => {
    test('a pointless one is removed, braces and all', async () => {
        const document = await parse('package p\ndatatype string\nkind K {\n    name: addOnly string\n}');
        // The braces go with it; the trailing space is the formatter's to take.
        expect(applyFirst(document, await fixesFor(document, 'add-only-with-nothing-to-add')))
            .toMatch(/name: string ?\n/);
    });

    test('one on an immutable owner becomes "const"', async () => {
        const document = await parse('package p\nkind Place\nevent Wedding {\n    -- [2..*] (addOnly venues) Place\n}');
        const actions = await fixesFor(document, 'add-only-on-immutable');
        expect(actions.map(a => a.title)).toEqual(['Write "const" instead']);
        expect(applyFirst(document, actions)).toContain('(const venues)');
    });

    test('one relaxing a const end is replaced rather than combined with it', async () => {
        const document = await parse([
            'package p', 'kind Person', 'kind Team {',
            '-- [1..*] (const members) Person', '}',
            'subkind Squad specializes Team {',
            '-- [1..*] (addOnly players redefines Team.members) Person', '}'
        ].join('\n'));
        const applied = await parse(applyFirst(document, await fixesFor(document, 'const-not-propagated')));
        expect(applied.textDocument.getText()).toContain('(const players redefines Team.members)');
        expect(applied.parseResult.parserErrors).toEqual([]);
    });

    test('an event end point becomes [1]', async () => {
        const document = await parse('package p\ndatatype date\nevent Wedding {\n    @end finishedAt: const date [0..1]\n}');
        const actions = await fixesFor(document, 'end-time-point-not-mandatory');
        expect(actions.map(a => a.title)).toEqual(['Change to [1]']);
        expect(applyFirst(document, actions)).toContain('@end finishedAt: const date [1]');
    });

    test('and an event property is marked const', async () => {
        const document = await parse('package p\ndatatype date\nevent Wedding {\n    heldAt: date\n}');
        expect(applyFirst(document, await fixesFor(document, 'immutable-attribute-not-const')))
            .toContain('heldAt: const date');
    });

    test('and so is a component of a value', async () => {
        const document = await parse('package p\ndatatype Address {\n    street: string\n}');
        expect(applyFirst(document, await fixesFor(document, 'immutable-attribute-not-const')))
            .toContain('street: const string');
    });

    test('and a process is offered the word for what it does', async () => {
        const document = await parse('package p\nprocess Baking\nevent Fold\n@constitution relation Baking (const) [1] -- [1..*] Fold');
        const actions = await fixesFor(document, 'accumulating-end-not-add-only');
        expect(actions.map(a => a.title)).toEqual(['Mark the end "addOnly"']);
        expect(applyFirst(document, actions)).toContain('[1..*] (addOnly) Fold');
    });
});

describe('a relator that binds only one individual', () => {
    test('offers to mediate two of them', async () => {
        const document = await parse('package p\nrelator Marriage {\n@mediation [0..*] -- [1] Person\n}\nkind Person');
        const actions = await fixesFor(document, 'relator-mediates-one');
        expect(actions[0].title).toBe('Mediate two of "Person": "[2]"');
        expect(applyFirst(document, actions)).toContain('[0..*] -- [2] Person');
    });

    test('carrying the upper bound over rather than replacing it', async () => {
        // Widening "[0..*]" to "[2]" would silently forbid a third spouse.
        const document = await parse('package p\nrelator Marriage {\n@mediation [0..*] -- [0..*] Person\n}\nkind Person');
        const actions = await fixesFor(document, 'relator-mediates-one');
        expect(actions[0].title).toBe('Mediate two of "Person": "[2..*]"');
        expect(applyFirst(document, actions)).toContain('[0..*] -- [2..*] Person');
    });

    test('and where the multiplicity was left out, meaning one', async () => {
        const document = await parse('package p\nrelator Marriage {\n@mediation [0..*] -- Person\n}\nkind Person');
        const actions = await fixesFor(document, 'relator-mediates-one');
        expect(applyFirst(document, actions)).toContain('[0..*] -- [2] Person');
    });

    test('or to mediate something else, from what the natures allow', async () => {
        const document = await parse(
            'package p\nrelator Employment {\n@mediation [0..*] -- [1] Person\n}\nkind Person\nkind Org\nevent Hiring');
        const actions = await fixesFor(document, 'relator-mediates-one');
        // A mediation runs from a relator to an endurant, never to an event,
        // and Person is already mediated.
        expect(actions.map(a => a.title)).toEqual([
            'Mediate two of "Person": "[2]"',
            'Mediate "Org" as well'
        ]);
        expect(applyFirst(document, actions.slice(1)))
            .toContain('@mediation relation Employment [0..*] -- [1] Org');
    });

    test('and either one settles it', async () => {
        for (const index of [0, 1]) {
            const document = await parse(
                'package p\nrelator Employment {\n@mediation [0..*] -- [1] Person\n}\nkind Person\nkind Org');
            const actions = await fixesFor(document, 'relator-mediates-one');
            const applied = await parse(applyFirst(document, actions.slice(index)));
            expect((applied.diagnostics ?? []).map(d => d.code)).not.toContain('relator-mediates-one');
        }
    });
});

describe('a whole with a single modeled part', () => {
    test('offers to say the part comes in numbers', async () => {
        const document = await parse('package p\nkind Engine\nkind Car { @componenthood [1] <>-- [1] Engine }');
        const actions = await fixesFor(document, 'whole-with-one-part');
        expect(actions[0].title).toBe('Require more than one "Engine": "[2..*]"');
        expect(applyFirst(document, actions)).toContain('<>-- [2..*] Engine');
    });

    test('even where the multiplicity was left out, meaning one', async () => {
        const document = await parse('package p\nkind Engine\nkind Car { <>-- Engine }');
        const actions = await fixesFor(document, 'whole-with-one-part');
        expect(applyFirst(document, actions)).toContain('<>-- [2..*] Engine');
    });

    test('and at the source end, where the diamond points the other way', async () => {
        // The diamond marks the whole, so "--<>" puts it at the *target*:
        // a wheel is part of a car, and the part end is the source.
        const document = await parse('package p\nkind Car\nkind Wheel { --<> [1] Car }');
        const actions = await fixesFor(document, 'whole-with-one-part');
        expect(actions[0].title).toBe('Require more than one "Wheel": "[2..*]"');
        expect(applyFirst(document, actions)).toContain('[2..*] --<> [1] Car');
    });

    test('or to give the whole another part, from what the natures allow', async () => {
        const document = await parse(
            'package p\ncollective Fleet { <>-- [1] Car }\nkind Car\nquantity Fuel\nevent Trip');
        const actions = await fixesFor(document, 'whole-with-one-part');
        // A collective takes substantials as members, so Fuel qualifies and
        // Trip does not; Car is already a part.
        expect(actions.map(a => a.title)).toEqual([
            'Require more than one "Car": "[2..*]"',
            'Add "Fuel" as another part'
        ]);
        expect(applyFirst(document, actions.slice(1))).toContain('relation Fleet [1] <>-- [1..*] Fuel');
    });

    test('and either one settles it', async () => {
        for (const index of [0, 1]) {
            const document = await parse('package p\nkind Engine\nkind Wheel\nkind Car { @componenthood [1] <>-- [1] Engine }');
            const actions = await fixesFor(document, 'whole-with-one-part');
            const applied = await parse(applyFirst(document, actions.slice(index)));
            expect((applied.diagnostics ?? []).map(d => d.code)).not.toContain('whole-with-one-part');
        }
    });
});

describe('a moment with nothing to inhere in', () => {
    test('a relator that mediates nothing is reported, like any other moment', async () => {
        const document = await parse('package p\nrelator Marriage\nkind Person');
        const warning = (document.diagnostics ?? []).find(d => d.code === 'relator-without-mediation');
        expect(warning?.message).toContain('mediates nothing');
    });

    test('and the fix stereotypes the association already written', async () => {
        const document = await parse('package p\nrelator Marriage {\n[1] -- [2] (spouses) Person\n}\nkind Person');
        const actions = await fixesFor(document, 'relator-without-mediation');
        expect(actions.map(a => a.title)).toEqual(['Add "@mediation" to the association with "Person"']);
        expect(applyFirst(document, actions)).toContain('@mediation [1] -- [2] (spouses) Person');
    });

    test('one fix per association, named by what it reaches', async () => {
        const document = await parse(
            'package p\nrelator Employment {\n[1] -- [1] (employee) Person\n[1] -- [1] (employer) Org\n}\nkind Person\nkind Org');
        const actions = await fixesFor(document, 'relator-without-mediation');
        expect(actions.map(a => a.title)).toEqual([
            'Add "@mediation" to the association with "Person"',
            'Add "@mediation" to the association with "Org"'
        ]);
    });

    test('a quality gets the same treatment with "@characterization"', async () => {
        const document = await parse(
            'package p\nquality Intensity {\n[1] -- [1] (intensityOf) Headache\n}\n'
            + 'intrinsicMode Headache { @characterization -- [1] Person }\nkind Person');
        const actions = await fixesFor(document, 'moment-without-bearer');
        expect(actions.map(a => a.title)).toEqual(['Add "@characterization" to the association with "Headache"']);
    });

    test('but never on an association the natures would reject', async () => {
        // The bearer end of a characterization is the target, so an
        // association pointing at the quality is not the one to stereotype.
        const document = await parse('package p\nkind Person {\n[1] -- [1] (weight) Weight\n}\nquality Weight');
        const actions = await fixesFor(document, 'moment-without-bearer');
        expect(actions).toEqual([]);
    });

    test('both messages name what the class classifies, not its stereotype', async () => {
        // The checks judge by nature, so naming the stereotype would name the
        // one thing they did not look at.
        const document = await parse('package p\nextrinsicMode Duty\nrelator Enrollment');
        const messages = (document.diagnostics ?? [])
            .filter(d => d.code === 'moment-without-bearer' || d.code === 'relator-without-mediation')
            .map(d => d.message);
        expect(messages).toEqual([
            '"Duty" classifies extrinsic modes, which inhere in something, but nothing bears it. Add a "@characterization" to its bearer.',
            '"Enrollment" classifies relators, which exist by binding the individuals they relate, but it mediates nothing. Add a "@mediation" to each mediated individual.'
        ]);
    });

    test('a relator by nature is asked too, whatever its stereotype says', async () => {
        // The stereotype `relator` implies the nature, but so does a category
        // of relators, and it floats just as freely.
        const document = await parse('package p\ncategory Bond of relators {\n[1] -- [2] (parties) Person\n}\nkind Person');
        const actions = await fixesFor(document, 'relator-without-mediation');
        expect(actions.map(a => a.title)).toEqual(['Add "@mediation" to the association with "Person"']);
    });

    test('and a relator-natured ancestor is reported in its place, not beside it', async () => {
        const document = await parse('package p\nrelator Marriage\nrole Spouse specializes Marriage');
        const reported = (document.diagnostics ?? [])
            .filter(d => d.code === 'relator-without-mediation')
            .map(d => d.message.match(/"(\w+)"/)![1]);
        expect(reported).toEqual(['Marriage']);
    });

    test('nothing is offered when there is no association to name', async () => {
        const document = await parse('package p\nrelator Marriage\nkind Person');
        expect(await fixesFor(document, 'relator-without-mediation')).toEqual([]);
    });
});

describe('parthood does not cross natures', () => {
    async function verdict(source: string): Promise<string | undefined> {
        const document = await parse(source);
        return (document.diagnostics ?? []).find(d => d.code === 'parthood-crosses-natures')?.message;
    }

    test.each([
        ['an event cannot have an object as part', 'event Wedding {\n<>-- Person\n}\nkind Person'],
        ['nor a situation', 'situation Ready {\n<>-- Thing\n}\nkind Thing'],
        ['nor a relator', 'relator Marriage {\n<>-- Person\n}\nkind Person'],
        ['nor a quality', 'quality Color {\n<>-- Person\n}\nkind Person'],
        ['nor an intrinsic mode', 'intrinsicMode Belief {\n<>-- Person\n}\nkind Person'],
        ['nor an extrinsic mode', 'extrinsicMode Debt {\n<>-- Person\n}\nkind Person']
    ])('%s', async (_, body) => {
        expect(await verdict(`package p\n${body}`)).toBeDefined();
    });

    test.each([
        ['a relator has relators as parts', 'relator Marriage {\n<>-- Commitment\n}\nrelator Commitment'],
        ['a situation situations', 'situation Whole {\n<>-- Part\n}\nsituation Part'],
        ['a functional complex functional complexes', 'kind Car {\n<>-- Wheel\n}\nkind Wheel'],
        ['and a collective any substantial', 'collective Cellar {\n<>-- Wine\n}\nquantity Wine']
    ])('%s', async (_, body) => {
        expect(await verdict(`package p\n${body}`)).toBeUndefined();
    });

    test('a stereotyped parthood is left to the stereotype check', async () => {
        // One complaint, not two, and the more specific one.
        const document = await parse('package p\nevent Wedding {\n@structural <>-- Person\n}\nkind Person');
        const codes = (document.diagnostics ?? []).map(d => d.code);
        expect(codes).not.toContain('parthood-crosses-natures');
    });

    test('and the diamond on the wrong end has a fix', async () => {
        const document = await parse('package p\nkind Car {\n<>-- Fleet\n}\ncollective Fleet');
        const actions = await fixesFor(document, 'parthood-crosses-natures');
        expect(actions.map(a => a.title)).toEqual(['Put the diamond at the other end']);
        expect(applyFirst(document, actions)).toContain('--<> Fleet');
    });

    test('but not where flipping it would not help', async () => {
        // Neither direction admits an event beside a functional complex.
        const document = await parse('package p\nkind Person {\n<>-- Wedding\n}\nevent Wedding');
        const actions = await fixesFor(document, 'parthood-crosses-natures');
        expect(actions).toEqual([]);
    });
});

describe('what may stand at a relation end', () => {
    const universe = 'package p\nkind Car\nkind Person\ncollective Fleet\nquantity Wine\n'
        + 'relator Marriage\nquality Weight\nevent VowReading\nprocess Baking\nsituation Ready\ntype PersonType\n';

    describe('completion proposes only classes the end-nature table admits', () => {
        async function proposalsAt(source: string): Promise<string[]> {
            const document = await parse(source);
            const list = await services.lsp.CompletionProvider!.getCompletion(document, {
                textDocument: { uri: document.textDocument.uri },
                position: document.textDocument.positionAt(document.textDocument.getText().length)
            });
            const named = ['Car', 'Person', 'Fleet', 'Wine', 'Marriage', 'Weight', 'VowReading', 'Baking', 'Ready', 'PersonType'];
            const labels = new Set((list?.items ?? []).map(item => item.label));
            return named.filter(name => labels.has(name));
        }

        test('a part of an event can only be an event', async () => {
            // The whole is an event, the only parthood admitting an event as
            // whole is "@structural", and its part is an event too.
            // "Baking" is a process, which endures and gains events as parts
            // -- it is not itself a part of one.
            expect(await proposalsAt(universe + 'event Wedding {\n<>-- ')).toEqual(['VowReading']);
        });

        test('a part of a functional complex is a functional complex', async () => {
            expect(await proposalsAt(universe + 'kind Engine {\n<>-- ')).toEqual(['Car', 'Person']);
        });

        test('a member of a collective is any substantial', async () => {
            expect(await proposalsAt(universe + 'collective Herd {\n<>-- ')).toEqual(['Car', 'Person', 'Fleet', 'Wine']);
        });

        test('what a relator mediates excludes events and situations', async () => {
            expect(await proposalsAt(universe + '@mediation relation Marriage [0..*] -- [1] P'))
                .toEqual(['Person', 'PersonType']);
        });

        test('from the first keystroke, since a half-written relation still parses', async () => {
            // The target is optional in the grammar precisely so that this
            // works: a mandatory one made the parser discard the declaration.
            // No `Baking` among them: a relator mediates endurants, and a
            // process is an occurrent.
            expect(await proposalsAt(universe + '@mediation relation Marriage [0..*] -- [1] '))
                .toEqual(['Car', 'Person', 'Fleet', 'Wine', 'Marriage', 'Weight', 'PersonType']);
        });

        test('and nothing is narrowed where nothing is known', async () => {
            expect(await proposalsAt(universe + 'relation Person [0..*] -- knows -- [0..*] '))
                .toEqual(['Car', 'Person', 'Fleet', 'Wine', 'Marriage', 'Weight', 'VowReading', 'Baking', 'Ready', 'PersonType']);
        });

        test('a datatype is not a member of a collective, and is not proposed as one', async () => {
            // An end may name a datatype or an enumeration, so the filter has
            // to judge them too: `date` was proposed as a member because the
            // narrowing asked only about classes.
            const values = 'datatype Point {\nx: number\n}\nenum Color {\nred\n}\n';
            const labels = await allProposalsAt(universe + values + 'collective Herd {\n@membership [1] <>-- [2..*] ');
            expect(labels).toContain('Person');
            expect(labels).not.toContain('Point');
            expect(labels).not.toContain('Color');
        });

        test('but an unstereotyped relation may reach one, and proposes it', async () => {
            const values = 'datatype Point {\nx: number\n}\nenum Color {\nred\n}\n';
            const labels = await allProposalsAt(universe + values + 'kind Building {\n-- [1] ');
            expect(labels).toContain('Point');
            expect(labels).toContain('Color');
        });

        /** Every proposal, where a test asks about something outside the universe. */
        async function allProposalsAt(source: string): Promise<string[]> {
            const document = await parse(source);
            const list = await services.lsp.CompletionProvider!.getCompletion(document, {
                textDocument: { uri: document.textDocument.uri },
                position: document.textDocument.positionAt(document.textDocument.getText().length)
            });
            return (list?.items ?? []).map(item => String(item.label));
        }
    });

    describe('and the "create the missing class" fixes agree with it', () => {
        async function createdBy(source: string): Promise<string[]> {
            const document = await parse(source);
            const diagnostic = (document.diagnostics ?? []).find(d => /Could not resolve/.test(d.message));
            const actions = await services.lsp.CodeActionProvider!.getCodeActions(document, {
                textDocument: { uri: document.textDocument.uri },
                range: diagnostic!.range,
                context: { diagnostics: [diagnostic!] }
            });
            return (actions ?? []).map(action => action.title.replace(/^Create (\S+) .*/, '$1'));
        }

        test('a part of an event is not offered as a kind', async () => {
            const offered = await createdBy('package p\nevent Wedding {\n<>-- VowReading\n}');
            expect(offered).toContain('event');
            expect(offered).not.toContain('kind');
        });

        test('a part of a functional complex is', async () => {
            expect(await createdBy('package p\nkind Car {\n<>-- Wheel\n}')).toContain('kind');
        });

        test('what mediates a class is a relator, and never an event', async () => {
            const offered = await createdBy('package p\nkind Person\n@mediation relation Employment [0..*] -- [1] Person');
            expect(offered[0]).toBe('relator');
            expect(offered).not.toContain('event');
        });

        test('and no base sortal is offered, having nothing to specialize', async () => {
            // "subkind Wheel" on its own fails sortal-without-ultimate-sortal,
            // so it would answer one error with another.
            const offered = await createdBy('package p\nkind Car {\n<>-- Wheel\n}');
            expect(offered).not.toContain('subkind');
            expect(offered).not.toContain('role');
        });
    });
});

describe('the stereotype an unstereotyped relation means', () => {
    /** What `defaultStereotypeFor` says about the last relation in the source. */
    async function suggestion(source: string): Promise<string | undefined> {
        const document = await parse(source);
        const relations = [...AstUtils.streamAllContents(document.parseResult.value)].filter(isRelation);
        return defaultStereotypeFor(relations[relations.length - 1]);
    }

    const universe = 'package p\nkind Person\nrelator Marriage\nquality Weight\nevent Wedding\n'
        + 'situation Married\ntype PersonType\nkind Wheel\nquantity Wine\n'
        + 'kind Anchor { @instantiation -- [1..*] PersonType }\n';

    test.each([
        ['relation Marriage [1] -- [2] Person', 'mediation'],
        ['relation Weight [0..*] -- [1] Person', 'characterization'],
        ['relation Person [0..*] -- [1] PersonType', 'instantiation'],
        ['relation Married [0..*] -- [1] Wedding', 'triggering'],
        ['relation Wedding [0..*] -- [1] Married', 'bringingAbout'],
        ['relation Married [0..*] -- [1] Person', 'presence']
    ])('%s means @%s', async (line, expected) => {
        expect(await suggestion(universe + line)).toBe(expected);
    });

    test('a diamond decides which parthood, from the whole', async () => {
        expect(await suggestion(universe + 'kind Car { <>-- [4] Wheel }')).toBe('componenthood');
        expect(await suggestion(universe + 'collective Fleet { <>-- [2..*] Person }')).toBe('membership');
        expect(await suggestion(universe + 'collective Cellar { <>-- [1..*] Wine }')).toBe('membership');
        expect(await suggestion(universe + 'quantity Portion { <>-- [1..*] Wine }')).toBe('subQuantity');
        expect(await suggestion(universe + 'event Half { <>-- [2] Wedding }')).toBe('structural');
    });

    test('two events without a diamond are still structural', async () => {
        expect(await suggestion('package p\nevent Goal\nevent Match\nrelation Goal [1..*] -- [1] Match'))
            .toBe('structural');
    });

    test('nothing where a stereotype is written', async () => {
        expect(await suggestion(universe + '@mediation relation Marriage [1] -- [2] Person')).toBeUndefined();
    });

    test('nor where the natures leave the reading open', async () => {
        // Two functional complexes and no diamond: most often a material
        // relation, but nothing here settles it.
        expect(await suggestion('package p\nkind Person\nrelation Person [0..*] -- knows -- [0..*] Person'))
            .toBeUndefined();
    });

    test('reported at hint severity, so the editor draws it faintly', async () => {
        const document = await parse('package p\nrelator Marriage\nkind Person\nrelation Marriage [1] -- [2] Person');
        const hint = (document.diagnostics ?? []).find(d => d.code === 'implied-relation-stereotype');
        expect(hint?.severity).toBe(DiagnosticSeverity.Hint);
        expect(hint?.message).toContain('"@mediation"');
    });

    test('and the code action writes it, before the "relation" keyword', async () => {
        const document = await parse('package p\nrelator Marriage\nkind Person\nrelation Marriage [1] -- [2] Person');
        const actions = await fixesFor(document, 'implied-relation-stereotype');
        expect(actions[0].title).toBe('Add "@mediation"');
        expect(applyFirst(document, actions)).toContain('@mediation relation Marriage [1] -- [2] Person');
    });

    test('with every other stereotype the ends admit offered after it', async () => {
        // The natures rarely single one out: `event:event` parthood fits three
        // stereotypes equally, so naming only one would be a claim too strong.
        const document = await parse('package p\nevent A\nevent B\nrelation A [1] <>-- [2..*] B');
        const actions = await fixesFor(document, 'implied-relation-stereotype');
        // Offered in the vocabulary's own order, the recommendation first.
        expect(actions.map(a => a.title)).toEqual([
            'Add "@structural"', 'Add "@temporal"', 'Add "@participational"'
        ]);
    });

    test('and the message no longer claims the natures single one out', async () => {
        const document = await parse('package p\ncollective A\ncollective B\nrelation A [1] <>-- [2..*] B');
        const hint = (document.diagnostics ?? []).find(d => d.code === 'implied-relation-stereotype');
        expect(hint?.message).toBe('The natures at the ends fit "@membership" or "@subCollection".');
    });

    test('and the end that does not specialize is offered the specialization', async () => {
        // Reported case. Two readings: the taxonomy has not caught up with
        // what the relation says, or the relation says something it should
        // not. The first is usually the one meant, so it comes first.
        const document = await parse([
            'package p', 'kind Statue', 'category Stuff of quantities {',
            '@constitution [1] -- constitutes -- [0..1] Statue', '}',
            'quantity LumpOfWood {',
            '@constitution [0..1] -- constitutes -- [0..1] Statue specializes Stuff.constitutes', '}'
        ].join('\n'));
        const actions = await fixesFor(document, 'relation-specialization-not-narrower');
        expect(actions.map(action => action.title)).toEqual(['Specialize "Stuff"', 'Remove "specializes"']);
        expect(applyFirst(document, actions)).toContain('quantity LumpOfWood specializes Stuff');
    });

    test('and a clause that cannot hold is offered for removal', async () => {
        // Three rules whose subject is a clause stating a relationship that
        // does not hold, and which had no repair at all: there is nothing to
        // correct them *to* -- what the clause should point at instead is
        // modeling -- but dropping it leaves a relation that says less
        // rather than something false.
        const specialization = await parse([
            'package p', 'kind Person', 'kind Car', 'kind Boat',
            'relation Person [1] -- owns -- [0..*] Car',
            'relation Person [1] -- sails -- [0..*] Boat specializes owns'
        ].join('\n'));
        const actions = await fixesFor(specialization, 'relation-specialization-not-narrower');
        // A boat is not a car, so the taxonomy reading is offered and reads
        // oddly -- which is why neither is applied unread. The removal is the
        // one this test is about.
        expect(actions.map(action => action.title)).toContain('Remove "specializes"');
        const removal = actions.find(action => action.title === 'Remove "specializes"')!;
        expect(applyFirst(specialization, [removal] as never).trimEnd())
            .toMatch(/relation Person \[1\] -- sails -- \[0\.\.\*\] Boat$/);

        const override = await parse([
            'package p', 'kind Person', 'role Employee specializes Person',
            'kind Team {', '-- [0..*] (staff) Employee', '-- [0..*] (subsets Team.staff) Person', '}'
        ].join('\n'));
        expect((await fixesFor(override, 'override-type-not-narrower')).map(action => action.title))
            .toEqual(['Remove "subsets"']);
    });

    test('and the ends of an inverse are written as the ends they are', async () => {
        // Reported case, with the repair the report asked for: the whole span
        // between the source and the class at the far end is rewritten, the
        // notation and its name kept as they were.
        const document = await parse([
            'package p',
            'kind Person {',
            '@historicalDependence (addOnly children) [*] -- hasFather -- [1] (const father) Man',
            '}',
            'subkind Man specializes Person {',
            '-- hasChildren -- Person inverseOf Person.hasFather',
            '}'
        ].join('\n'));
        const actions = await fixesFor(document, 'inverse-ends-differ');
        expect(actions.map(action => action.title)).toEqual(['Match the ends of "hasFather"']);
        expect(applyFirst(document, actions)).toContain(
            '(const father) [1] -- hasChildren -- [*] (addOnly children) Person inverseOf Person.hasFather');
    });

    test('and a name only this side has is carried over, not dropped', async () => {
        // Something may reference `Man.kids`; mirroring is not a reason to
        // delete a name.
        const document = await parse([
            'package p',
            'kind Person {',
            '@historicalDependence (addOnly) [*] -- hasFather -- [1] (const) Man',
            '}',
            'subkind Man specializes Person {',
            '(dad) [0..*] -- hasChildren -- [*] (kids) Person inverseOf Person.hasFather',
            '}'
        ].join('\n'));
        const actions = await fixesFor(document, 'inverse-ends-differ');
        expect(applyFirst(document, actions)).toContain(
            '(const dad) [1] -- hasChildren -- [*] (addOnly kids) Person');
    });

    test('and matching associations can be declared reciprocal inverses', async () => {
        const document = await parse([
            'package p',
            'kind Organization {',
            '    [1] -- employs -- [0..*] Person',
            '}',
            'kind Person {',
            '    [0..*] -- worksFor -- [1] Organization',
            '}'
        ].join('\n'));
        const actions = await fixesFor(document, 'matching-inverse');
        expect(actions.map(action => action.title)).toEqual(['Make "employs" and "worksFor" inverses']);
        const text = applyFirst(document, actions);
        expect(text).toContain('employs -- [0..*] Person inverseOf Person.worksFor');
        expect(text).toContain('worksFor -- [1] Organization inverseOf Organization.employs');
        expect(await new TontoSession().validateText(text)).toEqual([]);
    });

    test('and before the diamond, on an internal relation', async () => {
        const document = await parse('package p\nkind Wheel\nkind Car { <>-- [4] Wheel }');
        const actions = await fixesFor(document, 'implied-relation-stereotype');
        expect(applyFirst(document, actions)).toContain('@componenthood <>-- [4] Wheel');
    });

    test('nothing to fix where the reading is open', async () => {
        const document = await parse('package p\nkind Person\nrelation Person [0..*] -- knows -- [0..*] Person');
        expect((document.diagnostics ?? []).some(d => d.code === 'implied-relation-stereotype')).toBe(false);
    });

    test('nor a characterization whose bearer end is not exactly one', async () => {
        // Inherence is to one bearer, so a [0..*] bearer says this is not it.
        expect(await suggestion('package p\nquality Weight\nkind Person\nrelation Weight [0..*] -- [0..*] Person'))
            .toBeUndefined();
    });

    test('nor a stereotype the end natures would reject', async () => {
        // The rule reads only the whole, so it would name `componenthood`;
        // the end-nature table rejects that pair, so nothing is suggested.
        expect(await suggestion('package p\nrelator Marriage\nkind Car { <>-- [1] Marriage }')).toBeUndefined();
    });
});

describe('source actions, which answer for the file rather than a diagnostic', () => {
    const actionsFor = async (
        source: string, only?: string[], position = { line: 0, character: 0 }
    ): Promise<{ document: LangiumDocument; actions: Array<{ kind?: string; title: string; edit?: unknown }> }> => {
        const document = await parse(source, { validation: true });
        const actions = await services.lsp.CodeActionProvider!.getCodeActions(document, {
            textDocument: { uri: document.textDocument.uri },
            range: { start: position, end: position },
            context: { diagnostics: document.diagnostics ?? [], ...(only ? { only } : {}) }
        });
        return { document, actions: (actions ?? []) as Array<{ kind?: string; title: string; edit?: unknown }> };
    };
    const applied = (document: LangiumDocument, action: { edit?: unknown }): string =>
        applyFirst(document, [action as never]);

    describe('fix all', () => {
        const messy = [
            'package p', 'datatype string', 'kind carro',
            'kind Person {', 'name: addOnly string', '}',
            'relator Marriage {', '@mediation [1] -- [2] Person', '}'
        ].join('\n');

        test('applies every repair that decides nothing, in one edit', async () => {
            const { document, actions } = await actionsFor(messy, ['source.fixAll']);
            expect(actions.map(action => action.kind)).toEqual(['source.fixAll.tonto']);
            expect(actions[0].title).toBe('Apply the 2 repairs that decide nothing');
            const text = applied(document, actions[0]);
            expect(text).toContain('kind Carro');
            expect(text).toContain('@mediation [1] -- [2] (const) Person');
            // `addOnly` on a single-valued attribute has two readings -- the
            // flag is wrong, or the bound is -- so the batch leaves it, and
            // the diagnostic is still there to see.
            expect(text).toContain('name: addOnly string');
        });

        test('and nothing that does', async () => {
            // A lone phase has two readings and only one of them can be
            // written, so `--fix` leaves it and so does this.
            const { actions } = await actionsFor(
                'package p\nkind Person\nphase Adult specializes Person', ['source.fixAll']);
            expect(actions).toEqual([]);
        });

        test('leaves conflicting same named members for a person to choose', async () => {
            const source = 'package p\ndatatype string\ndatatype number\nkind Person {\nname: string\nname: number\n}';
            const { actions } = await actionsFor(source, ['source.fixAll']);
            expect(actions).toEqual([]);
            const quick = await actionsFor(source, ['quickfix']);
            expect(quick.actions.map(action => action.title)).toContain('Remove this declaration of "name", and what it says');
        });

        test('still removes a member written twice in exactly the same way', async () => {
            const source = 'package p\ndatatype string\nkind Person {\nname: string\nname: string\n}';
            const { document, actions } = await actionsFor(source, ['source.fixAll']);
            expect(actions).toHaveLength(1);
            expect(applied(document, actions[0]).match(/name: string/g)).toHaveLength(1);
        });

        test('while a request for it alone is not answered with quick fixes', async () => {
            const { actions } = await actionsFor(messy, ['source.fixAll']);
            expect(actions.every(action => action.kind === 'source.fixAll.tonto')).toBe(true);
            const everything = await actionsFor(messy);
            expect(everything.actions.some(action => action.kind === 'quickfix')).toBe(true);
        });
    });

    describe('organize imports', () => {
        test('sorts them, and drops the lines the rules say say nothing', async () => {
            const source = 'use model\nuse model\n// the model\npackage model\nkind Person\n';
            const { document, actions } = await actionsFor(source, ['source.organizeImports']);
            expect(actions.map(action => action.title)).toEqual(['Sort the uses and imports, and drop what says nothing']);
            expect(withoutOntology(applied(document, actions[0]))).toBe('// the model\npackage model\nkind Person\n');
        });

        test('and is not offered where the imports are already in order', async () => {
            const { actions } = await actionsFor('package p\nkind Person\n', ['source.organizeImports']);
            expect(actions).toEqual([]);
        });
    });

    describe("writing a relator's derived material relation", () => {
        const employment = [
            'package p', 'kind Person', 'role Employee specializes Person', 'kind Organization',
            'relator Employment {',
            '    @mediation [1..*] -- [1] (const) Employee',
            '    @mediation [0..*] -- [1] (const) Organization',
            '}'
        ].join('\n');

        test('crosses the two mediation cardinalities and follows the paths', async () => {
            const source = [
                'package p', 'kind A', 'kind B', 'relator R {',
                '    @mediation [2..3] -- [4..5] (const) A',
                '    @mediation [6..7] -- [8..9] (const) B',
                '}'
            ].join('\n');
            const { document, actions } = await actionsFor(source, undefined, { line: 3, character: 8 });
            const action = actions.find(candidate => candidate.title === 'Create derived material relation "r"');
            expect(action?.kind).toBe('refactor.rewrite');
            const text = applied(document, action!);
            expect(text).toContain('@material relation A [4..35] -- r -- [8..27] B derivedFrom R');
            expect(await new TontoSession().validateText(text)).toEqual([]);
        });

        test('uses package-level mediations too', async () => {
            const source = [
                'package p', 'kind Person', 'kind Organization', 'relator Contract',
                '@mediation relation Contract [1] -- [1] (const) Person',
                '@mediation relation Contract [0..*] -- [1] (const) Organization'
            ].join('\n');
            const { document, actions } = await actionsFor(source, undefined, { line: 3, character: 8 });
            const action = actions.find(candidate => candidate.title === 'Create derived material relation "contract"');
            const text = applied(document, action!);
            expect(text).toContain(
                '@material relation Person [0..*] -- contract -- [1] Organization derivedFrom Contract');
            expect(await new TontoSession().validateText(text)).toEqual([]);
        });

        test('uses the first and second mediation as the two roles of a self relation', async () => {
            const source = [
                'package p', 'kind A', 'relator Pairing {',
                '    @mediation [2..3] -- first -- [4..5] (const) A',
                '    @mediation [6..7] -- second -- [8..9] (const) A',
                '}'
            ].join('\n');
            const { document, actions } = await actionsFor(source, undefined, { line: 2, character: 8 });
            const action = actions.find(candidate =>
                candidate.title === 'Create derived material relation "pairing"');
            const text = applied(document, action!);
            expect(text).toContain('@material relation A [4..35] -- pairing -- [8..27] A derivedFrom Pairing');
            expect(await new TontoSession().validateText(text)).toEqual([]);
        });

        test('is offered only for exactly two mediations, and only before one is derived', async () => {
            for (const source of [
                'package p\nkind A\nkind B\nrelator R',
                'package p\nkind A\nkind B\nrelator R { @mediation [1] -- [1] (const) A }',
                'package p\nkind A\nkind B\nkind C\nrelator R {\n'
                    + '@mediation [1] -- [1] (const) A\n'
                    + '@mediation [1] -- [1] (const) B\n'
                    + '@mediation [1] -- [1] (const) C\n}'
            ]) {
                const line = source.split('\n').findIndex(one => one.includes('relator R'));
                const { actions } = await actionsFor(source, undefined, { line, character: 8 });
                expect(actions.filter(action => action.title.startsWith('Create derived material relation')), source)
                    .toEqual([]);
            }

            const withMaterial = `${employment}\n`
                + '@material relation Employee [0..*] -- worksFor -- [1..*] Organization derivedFrom Employment';
            const { actions } = await actionsFor(withMaterial, undefined, { line: 4, character: 8 });
            expect(actions.filter(action => action.title.startsWith('Create derived material relation'))).toEqual([]);
        });
    });

    test('names the derived relation apart from what its source class already has', async () => {
        const source = [
            'package p', 'kind Person {', '    [*] -- employment -- [*] Organization', '}', 'kind Organization',
            'relator Employment {',
            '    @mediation [1..*] -- [1] (const) Person',
            '    @mediation [0..*] -- [1] (const) Organization',
            '}'
        ].join('\n');
        const { document, actions } = await actionsFor(source, undefined, { line: 5, character: 10 });
        const action = actions.find(candidate => candidate.title.startsWith('Create derived material relation'));
        expect(action?.title).toBe('Create derived material relation "employment2"');
        const after = await new TontoSession().validateText(applied(document, action!));
        expect(after.map(one => one.code)).not.toContain('duplicate-member');
    });

    describe('writing an association in the inverse direction', () => {
        test('of a self material relation, reading the mediations crossed', async () => {
            const source = [
                'package p', 'kind Person', 'relator Mentoring {',
                '    @mediation [0..1] -- mentor -- [1] (const) Person',
                '    @mediation [0..*] -- mentee -- [1] (const) Person',
                '}',
                '@material relation Person [0..*] -- mentors -- [0..1] Person derivedFrom Mentoring'
            ].join('\n');
            const { document, actions } = await actionsFor(source, undefined, { line: 6, character: 40 });
            const inverse = actions.find(action => action.title === 'Create inverse "inverseMentors"');
            const after = await new TontoSession().validateText(applied(document, inverse!));
            expect(after.filter(one => ['error', 'warning'].includes(one.severity) || String(one.code).startsWith('material-cardinality'))
                .map(one => one.code)).toEqual([]);
        });

        test('writes a package-level inverse beside a package-level association', async () => {
            const source = [
                'package p', 'kind Wheel', 'kind Car',
                '@componenthood relation Car (const car) [1] <>-- contains -- [4..*] (addOnly wheels) Wheel'
            ].join('\n');
            const { document, actions } = await actionsFor(source, undefined, { line: 3, character: 45 });
            const inverse = actions.find(action => action.title === 'Create inverse "inverseContains"');
            expect(inverse?.kind).toBe('refactor.rewrite');
            const text = applied(document, inverse!);
            expect(text).toContain('contains -- [4..*] (addOnly wheels) Wheel inverseOf inverseContains');
            expect(text).toContain(
                '@componenthood relation Wheel (addOnly wheels) [4..*] -- inverseContains --<> [1] (const car) Car '
                + 'inverseOf contains');
            expect(await new TontoSession().validateText(text)).toEqual([]);
        });

        test('keeps a comparative stereotype and its derivation', async () => {
            const source = [
                'package p', 'quality Height', 'kind Person',
                '@comparative relation Person [*] -- tallerThan -- [*] Person derivedFrom Height'
            ].join('\n');
            const { document, actions } = await actionsFor(source, undefined, { line: 3, character: 42 });
            const inverse = actions.find(action => action.title === 'Create inverse "inverseTallerThan"');
            const text = applied(document, inverse!);
            expect(text).toContain('tallerThan -- [*] Person inverseOf inverseTallerThan derivedFrom Height');
            expect(text).toContain(
                '@comparative relation Person [*] -- inverseTallerThan -- [*] Person '
                + 'inverseOf tallerThan derivedFrom Height');
        });

        test('drops a directional stereotype even when the reversed natures also fit it', async () => {
            const source = [
                'package p', 'kind Person',
                '@historicalDependence relation Person (const dependedOnBy) [*] -- knew -- [*] (const known) Person'
            ].join('\n');
            const { document, actions } = await actionsFor(source, undefined, { line: 2, character: 68 });
            const inverse = actions.find(action => action.title === 'Create inverse "inverseKnew"');
            const text = applied(document, inverse!);
            expect(text).toContain('(const known) Person inverseOf inverseKnew');
            expect(text).toContain(
                'relation Person (const known) [*] -- inverseKnew -- [*] (const dependedOnBy) Person inverseOf knew');
            expect(text).not.toContain('@historicalDependence relation Person (const known)');
        });

        test("writes an internal inverse in the other end's class", async () => {
            const source = [
                'package p', 'kind Organization', 'kind Person {',
                '    [0..*] -- worksFor -- [1] Organization',
                '}'
            ].join('\n');
            const { document, actions } = await actionsFor(source, undefined, { line: 3, character: 18 });
            const inverse = actions.find(action => action.title === 'Create inverse "inverseWorksFor"');
            const text = applied(document, inverse!);
            expect(text).toContain('kind Organization {\n'
                + '    [1] -- inverseWorksFor -- [0..*] Person inverseOf Person.worksFor\n}');
            expect(text).toContain('kind Person {\n'
                + '    [0..*] -- worksFor -- [1] Organization inverseOf Organization.inverseWorksFor\n}');
            expect(await new TontoSession().validateText(text)).toEqual([]);
        });

        test('uses a free name in the other end namespace', async () => {
            const source = [
                'package p', 'datatype string', 'kind Organization {',
                '    inverseWorksFor: string',
                '}', 'kind Person {',
                '    [0..*] -- worksFor -- [1] Organization',
                '}'
            ].join('\n');
            const { actions } = await actionsFor(source, undefined, { line: 6, character: 18 });
            expect(actions.map(action => action.title)).toContain('Create inverse "inverseWorksFor2"');
        });

        test('is not offered when either side already declares the inverse', async () => {
            const source = [
                'package p', 'kind Organization {',
                '    [1] -- employs -- [0..*] Person inverseOf Person.worksFor',
                '}', 'kind Person {',
                '    [0..*] -- worksFor -- [1] Organization',
                '}'
            ].join('\n');
            const { actions } = await actionsFor(source, undefined, { line: 5, character: 18 });
            expect(actions.map(action => action.title).filter(title => title.startsWith('Create inverse'))).toEqual([]);
            const direct = await actionsFor(source, undefined, { line: 2, character: 18 });
            expect(direct.actions.map(action => action.title).filter(title => title.startsWith('Create inverse')))
                .toEqual([]);
        });
    });

    describe('moving a relation between the two ways of writing it', () => {
        const inside = [
            'package p', 'datatype string', 'kind Man',
            'kind Person {',
            '    name: string',
            '    @historicalDependence (addOnly children) [*] -- hasFather -- [1] (const father) Man',
            '}'
        ].join('\n');

        test('out of the class body, with the source written in', async () => {
            const { document, actions } = await actionsFor(inside, undefined, { line: 5, character: 10 });
            const move = actions.find(action => action.title === 'Write this at package level');
            expect(move?.kind).toBe('refactor.rewrite');
            const text = applied(document, move!);
            expect(text).toContain(
                '@historicalDependence relation Person (addOnly children) [*] -- hasFather -- [1] (const father) Man');
            expect(text).toContain('kind Person {\n    name: string\n}');
            // The same relation, so the same silence.
            expect(await new TontoSession().validateText(text)).toEqual([]);
        });

        test('and the braces go when the relation was all they held', async () => {
            const alone = [
                'package p', 'kind Man', 'kind Person {',
                '    @historicalDependence (addOnly children) [*] -- hasFather -- [1] (const father) Man',
                '}'
            ].join('\n');
            const { document, actions } = await actionsFor(alone, undefined, { line: 3, character: 10 });
            const text = applied(document, actions.find(a => a.title === 'Write this at package level')!);
            expect(text).toContain('kind Person\n@historicalDependence relation Person');
            expect(text).not.toMatch(/\{\s*\}/);
        });

        test('and reciprocal inverse declarations lose the source-class qualification', async () => {
            const source = [
                'package p',
                'kind Organization {',
                '    [1] -- employs -- [0..*] Person inverseOf Person.worksFor',
                '}',
                'kind Person {',
                '    [0..*] -- worksFor -- [1] Organization inverseOf Organization.employs',
                '}'
            ].join('\n');
            const { document, actions } = await actionsFor(source, undefined, { line: 5, character: 18 });
            const text = applied(document, actions.find(a => a.title === 'Write this at package level')!);
            expect(text).toContain('employs -- [0..*] Person inverseOf worksFor');
            expect(text).toContain(
                'relation Person [0..*] -- worksFor -- [1] Organization inverseOf Organization.employs');
            expect(await new TontoSession().validateText(text)).toEqual([]);
        });

        test('but keeps the qualification where an inherited relation shadows the short name', async () => {
            const source = [
                'package p', 'kind Place',
                'kind Base {',
                '    [1] -- worksFor -- [*] Person',
                '}',
                'subkind Organization specializes Base {',
                '    [1] -- employs -- [0..*] Person inverseOf Person.worksFor',
                '}',
                'kind Person {',
                '    [0..*] -- worksFor -- [1] Organization inverseOf Organization.employs',
                '}'
            ].join('\n');
            const { document, actions } = await actionsFor(source, undefined, { line: 9, character: 18 });
            const text = applied(document, actions.find(a => a.title === 'Write this at package level')!);
            expect(text).toContain('employs -- [0..*] Person inverseOf Person.worksFor');
            expect(await new TontoSession().validateText(text)).toEqual([]);
        });

        test('back into it, into a body made for it if there is none', async () => {
            const outside = [
                'package p', 'kind Man', 'kind Person',
                '/// Who fathered them.',
                '@historicalDependence relation Person (addOnly children) [*] -- hasFather -- [1] (const father) Man'
            ].join('\n');
            const { document, actions } = await actionsFor(outside, undefined, { line: 4, character: 40 });
            const move = actions.find(action => action.title === 'Write this inside "Person"');
            expect(move).toBeDefined();
            const text = applied(document, move!);
            // The documentation run travels with it, prefix and all.
            expect(text).toContain('kind Person {\n    /// Who fathered them.\n'
                + '    @historicalDependence (addOnly children) [*] -- hasFather -- [1] (const father) Man\n}');
            expect(await new TontoSession().validateText(text)).toEqual([]);
        });

        test('and after what the body already says', async () => {
            const outside = [
                'package p', 'datatype string', 'kind Man',
                'kind Person {', '    name: string', '}',
                '@historicalDependence relation Person (addOnly children) [*] -- hasFather -- [1] (const father) Man'
            ].join('\n');
            const { document, actions } = await actionsFor(outside, undefined, { line: 6, character: 40 });
            const text = applied(document, actions.find(a => a.title === 'Write this inside "Person"')!);
            expect(text).toContain('    name: string\n    @historicalDependence (addOnly children)');
        });

        test('and what named it plainly is renamed through the class, since inside one it is named that way', async () => {
            // Reported case: `inverseOf joinedByParticipant` stopped resolving.
            const outside = [
                'package p',
                'kind Person {',
                '    @participation (const) [2..*] -- participatedIn -- [*] Meeting inverseOf joinedByParticipant',
                '}',
                'relation Meeting [*] -- joinedByParticipant -- [2..*] (const) Person',
                'event Meeting'
            ].join('\n');
            const { document, actions } = await actionsFor(outside, undefined, { line: 4, character: 30 });
            const text = applied(document, actions.find(a => a.title === 'Write this inside "Meeting"')!);
            expect(text).toContain('inverseOf Meeting.joinedByParticipant');
            expect(await new TontoSession().validateText(text)).toEqual([]);
        });

        test('a specialization alike, but not a derivation where the relation is inherited', async () => {
            const outside = [
                'package p', 'kind Person', 'subkind Scholar specializes Person', 'event Graduation',
                '@participation relation Person (const) [1..*] -- tookPartIn -- [0..*] (addOnly) Graduation',
                '@participation relation Scholar (const) [1..*] -- graduatedIn -- [0..*] (addOnly) Graduation specializes tookPartIn',
                'historicalRole Attendee specializes Person derivedFrom tookPartIn',
                'kind Organization',
                'historicalRole Alumnus specializes Person derivedFrom graduatedIn'
            ].join('\n');
            const { document, actions } = await actionsFor(outside, undefined, { line: 4, character: 40 });
            const text = applied(document, actions.find(a => a.title === 'Write this inside "Person"')!);
            // A package-level relation is inside no class and inherits
            // nothing, so it says where to look; `Attendee` specializes
            // `Person`, inherits `tookPartIn`, and names it as it did.
            expect(text).toContain('Graduation specializes Person.tookPartIn');
            expect(text).toContain('historicalRole Attendee specializes Person derivedFrom tookPartIn');
            expect(await new TontoSession().validateText(text)).toEqual([]);
        });

        test('but not where the source is a datatype, which holds no relations', async () => {
            const toDatatype = [
                'package p', 'datatype string', 'kind Person',
                '@material relation string [0..*] -- names -- [0..*] Person'
            ].join('\n');
            const { actions } = await actionsFor(toDatatype, undefined, { line: 3, character: 30 });
            expect(actions.filter(action => /Write this inside/.test(action.title))).toEqual([]);
        });
    });

    describe('extract the relator a material relation is derived from', () => {
        const material = [
            'package p', 'kind Person', 'role Employee specializes Person', 'kind Organization',
            '@material relation Employee [0..*] -- worksFor -- [1..*] Organization'
        ].join('\n');

        test('writes it with the multiplicities crossed over', async () => {
            const { document, actions } = await actionsFor(material, undefined, { line: 4, character: 12 });
            // Offered twice over: as a refactoring at the cursor, and as the
            // repair for `material-without-relator`, which is the lightbulb a
            // reader is more likely to find.
            const extract = actions.find(action =>
                /Write the relator/.test(action.title) && action.kind === 'refactor.rewrite');
            expect(extract).toBeDefined();
            expect(actions.some(action =>
                /Write the relator/.test(action.title) && action.kind === 'quickfix')).toBe(true);
            const text = applied(document, extract!);
            // How many employments an employee has is how many organizations
            // they work for, which is what the far end of the material
            // relation says.
            expect(text).toContain('relator WorksFor {\n    @mediation [1..*] -- [1] (const) Employee');
            expect(text).toContain('@mediation [0..*] -- [1] (const) Organization');
        });

        test('and leaves a model with nothing left to say about it', async () => {
            const { document, actions } = await actionsFor(material, undefined, { line: 4, character: 12 });
            const text = applied(document, actions.find(action => /Write the relator/.test(action.title))!);
            // A session of its own: the shared test workspace already holds a
            // document declaring this package, which is a fact about the test
            // and not about the refactoring.
            const after = await new TontoSession().validateText(text);
            expect(after.map(one => `${one.severity}:${one.code}`)).toEqual([]);
        });

        test('and reads an end with no multiplicity written as exactly one', async () => {
            const omitted = 'package p\nkind Person\nkind Organization\n@material relation Person -- worksFor -- Organization';
            for (const title of [/Write the relator/, /Write the extrinsic mode .* borne by "Person"/]) {
                const { document, actions } = await actionsFor(omitted, undefined, { line: 3, character: 30 });
                const text = applied(document, actions.find(action => title.test(action.title))!);
                expect(text, String(title)).not.toContain('[0..*]');
                const after = await new TontoSession().validateText(text);
                expect(after.filter(one => ['error', 'warning'].includes(one.severity)).map(one => one.code), String(title)).toEqual([]);
            }
        });

        test('but not where the model already says what grounds it', async () => {
            const grounded = [
                'package p', 'kind Person', 'kind Organization',
                'relator Employment {',
                '@mediation [1..*] -- [1] (const) Person',
                '@mediation [0..*] -- [1] (const) Organization', '}',
                '@material relation Person [0..*] -- worksFor -- [1..*] Organization'
            ].join('\n');
            const { actions } = await actionsFor(grounded, undefined, { line: 7, character: 12 });
            expect(actions.filter(action => /Write the relator/.test(action.title))).toEqual([]);
        });
    });

    describe('extract the extrinsic mode a material relation is derived from', () => {
        const material = [
            'package p', 'kind Person', 'kind Organization',
            '@material relation Person [0..*] -- isLoyalTo -- [1..*] Organization'
        ].join('\n');

        test('offers each end as the bearer, as both a refactoring and a quick fix', async () => {
            const { actions } = await actionsFor(material, undefined, { line: 3, character: 12 });
            const titles = actions.filter(action => /Write the extrinsic mode/.test(action.title));
            expect(titles.filter(action => action.kind === 'refactor.rewrite').map(action => action.title)).toEqual([
                'Write the extrinsic mode "IsLoyalTo" this is derived from, borne by "Person"',
                'Write the extrinsic mode "IsLoyalTo" this is derived from, borne by "Organization"'
            ]);
            expect(titles.filter(action => action.kind === 'quickfix')).toHaveLength(2);
        });

        test('writes the source-borne mode with crossed multiplicities', async () => {
            const { document, actions } = await actionsFor(material, undefined, { line: 3, character: 12 });
            const action = actions.find(candidate => candidate.kind === 'refactor.rewrite'
                && candidate.title.endsWith('borne by "Person"'))!;
            const text = applied(document, action);
            expect(text).toContain('derivedFrom IsLoyalTo');
            expect(text).toContain('extrinsicMode IsLoyalTo {\n'
                + '    @characterization [1..*] -- [1] (const) Person\n'
                + '    @externalDependence [0..*] -- [1] (const) Organization\n}');
            expect(await new TontoSession().validateText(text)).toEqual([]);
        });

        test('reverses the two dependencies when the target is the bearer', async () => {
            const { document, actions } = await actionsFor(material, undefined, { line: 3, character: 12 });
            const action = actions.find(candidate => candidate.kind === 'refactor.rewrite'
                && candidate.title.endsWith('borne by "Organization"'))!;
            const text = applied(document, action);
            expect(text).toContain('extrinsicMode IsLoyalTo {\n'
                + '    @characterization [0..*] -- [1] (const) Organization\n'
                + '    @externalDependence [1..*] -- [1] (const) Person\n}');
            expect(await new TontoSession().validateText(text)).toEqual([]);
        });

        test('offers only one reading for a self relation', async () => {
            const self = 'package p\nkind Person\n@material relation Person [*] -- knows -- [*] Person';
            const { actions } = await actionsFor(self, undefined, { line: 2, character: 12 });
            expect(actions.filter(action =>
                action.kind === 'refactor.rewrite' && /Write the extrinsic mode/.test(action.title))).toHaveLength(1);
        });
    });
});

describe('what completion proposes, and where', () => {
    /**
     * A proposal is a recommendation. Two things were wrong with these: the
     * retired spelling of documentation was offered in every body -- an
     * enumeration's included, where the only thing to write is a literal --
     * and the snippets under `@` were offered wherever `@` was legal, which
     * is three places that want three different things.
     */
    // By line and column: `parse` renames the package to keep documents
    // apart, which moves every offset after it but no line.
    const itemsAt = async (source: string, line: number) => {
        const document = await parse(source);
        const list = await services.lsp.CompletionProvider!.getCompletion(document, {
            textDocument: { uri: document.textDocument.uri },
            position: { line, character: 0 }
        });
        return list?.items ?? [];
    };
    const labelsAt = async (source: string, line: number): Promise<string[]> =>
        (await itemsAt(source, line)).map(item => String(item.label));

    test('never the older label and description blocks', async () => {
        for (const source of [
            'package p\nkind Person {\n\n}\n',
            'package p\ndatatype Address {\n\n}\n',
            'package p\nenum Status {\n\n}\n'
        ]) {
            const labels = await labelsAt(source, 2);
            expect(labels, source).not.toContain('label');
            expect(labels, source).not.toContain('description');
        }
    });

    test('relations the class can open, and an attribute', async () => {
        // A kind is a functional complex: it has components, it takes part in
        // what happens, and it does not mediate -- only a relator binds.
        const labels = await labelsAt('package p\nkind Person {\n\n}\n', 2);
        expect(labels).toContain('attribute');
        expect(labels).toContain('@componenthood (with ends)');
        expect(labels).toContain('@participation (with ends)');
        expect(labels).toContain('@begin (attribute)');
        expect(labels).not.toContain('@mediation (with ends)');
        expect(labels).not.toContain('@characterization (with ends)');

        // Every stereotype the tables admit from here, not a chosen few: a
        // person is created and terminated by events like anything else that
        // endures.
        expect(labels).toContain('@creation (with ends)');
        expect(labels).toContain('@termination (with ends)');

        const inARelator = await labelsAt('package p\nrelator Employment {\n\n}\n', 2);
        expect(inARelator).toContain('@mediation (with ends)');
        expect(inARelator).not.toContain('@componenthood (with ends)');

        // Nothing outside time begins, so an abstractum is offered neither.
        const inAnAbstractum = await labelsAt('package p\nabstractum Number {\n\n}\n', 2);
        expect(inAnAbstractum).not.toContain('@begin (attribute)');
    });

    test('the same, on every line of a body that has something in it', async () => {
        // Reported case. The node under the cursor is whatever the parser
        // last attached the offset to, and each line of a written body
        // attached a different one: after a relation the body read as package
        // level, after `@begin born: const date` it read as a datatype's,
        // and past the closing brace it read as a body again.
        const body = [
            '    @historicalDependence (addOnly children) [*] -- hasFather -- [1] (const) Man',
            '    @begin birthDate: const date',
            '    @end deathDate: const date [0..1]',
            '    name: string'
        ];
        const header = 'package p\ndatatype string\ndatatype date\nkind Man\nkind Person {\n';
        // The snippets, which are what the body decides; the plain keywords
        // vary with what the parser could still be in the middle of, and
        // `specializes` after a relation is one it really could be.
        const snippetsAt = async (source: string, line: number): Promise<string[]> =>
            (await itemsAt(source, line)).filter(item => item.kind === CompletionItemKind.Snippet)
                .map(item => String(item.label));
        const empty = await snippetsAt(`${header}\n}\n`, 5);
        expect(empty).toContain('@componenthood (with ends)');
        for (let after = 0; after <= body.length; after++) {
            const lines = [...body.slice(0, after), '    ', ...body.slice(after)];
            const at = 5 + after;
            expect(await snippetsAt(`${header}${lines.join('\n')}\n}\n`, at), `line ${at}`).toEqual(empty);
        }
    });

    test('and package level again once the body has closed', async () => {
        const source = 'package p\nkind Person {\nname: string\n}\n\nkind Dog\n';
        const labels = await labelsAt(source, 4);
        expect(labels).toContain('@mediation (relation)');
        expect(labels).not.toContain('@mediation (with ends)');
    });

    test('and the ones that reach an event say so, with the event end fixed', async () => {
        // Reported case. Derived from the table these came out as
        // `[*] -- [0..*] Type`: a placeholder that does not say the far end
        // is something that happens, and the wrong end left open. The near
        // end is a property of the event, which is over, so it is
        // `(const) [1]`; what an endurant has been through accumulates.
        const items = await itemsAt('package p\nkind Person {\n\n}\n', 2);
        const body = (label: string): string | undefined =>
            items.find(item => item.label === label)?.insertText;
        expect(body('@change (with ends)')).toBe('@change (const) [${1:1}] -- [${2:0..*}] ${3:Event}');
        expect(body('@participation (with ends)'))
            .toBe('@participation (const) [${1:*}] -- ${2:participatedIn} -- [${3:0..*}] (addOnly) ${4:Event}');
        // An endurant that still exists has not been terminated, so both ends
        // of a termination are optional -- and the event end is `addOnly`
        // rather than `const`, since the link is made when the individual
        // ceases to exist and `const` would forbid the making of it.
        expect(body('@termination (with ends)'))
            .toBe('@termination (const) [${1:0..1}] -- ${2:name} -- [${3:0..1}] (addOnly) ${4:Event}');
        // And a creation has happened, so the event end is exactly one, and
        // fixed: `creation-end-not-const` asks for the word the snippet writes.
        expect(body('@creation (with ends)'))
            .toBe('@creation (const) [${1:1}] -- ${2:name} -- [${3:1}] (const) ${4:Event}');
    });

    test('and optional causal outcomes are acquired rather than pre-fixed', async () => {
        const situation = await itemsAt('package p\nsituation Ready {\n\n}\n', 2);
        expect(situation.find(item => item.label === '@triggering (with ends)')?.insertText)
            .toBe('@triggering (const) [${1:1}] -- [${2:0..1}] (addOnly) ${3:Event}');
        const event = await itemsAt('package p\nevent Signing {\n\n}\n', 2);
        expect(event.find(item => item.label === '@bringingAbout (with ends)')?.insertText)
            .toBe('@bringingAbout (const) [${1:1}] -- [${2:0..1}] (addOnly) ${3:Situation}');
    });

    test('and every snippet lands in a model that says nothing about its ends', async () => {
        // Reported case: `@subQuantity` offered `[*]` at the whole end, which
        // `sub-quantity-shared` rejects the moment it is written. The check is
        // mechanical over every stereotype rather than over the ones anyone
        // thought to look at, and it reads the table for what may stand at
        // each end.
        const forNature: Record<string, string> = {
            'functional-complex': 'kind', collective: 'collective', quantity: 'quantity',
            relator: 'relator', 'intrinsic-mode': 'intrinsicMode', 'extrinsic-mode': 'extrinsicMode',
            quality: 'quality', type: 'type', process: 'process', event: 'event',
            situation: 'situation', abstract: 'abstractum'
        };
        // What the end rules are about. A class-level omission -- a relator
        // that mediates one thing, a mode with no bearer -- is the model this
        // test builds being small, not the snippet being wrong.
        const aboutEnds = new Set([
            'sub-quantity-shared', 'sub-quantity-multiplicity', 'sub-collection-multiplicity',
            'immutable-end-not-const', 'dependence-end-not-const', 'dependence-end-not-mandatory',
            'add-only-with-nothing-to-add', 'add-only-on-immutable', 'end-holds-more-than-general',
            'multiplicity-inverted', 'multiplicity-star-lower', 'multiplicity-zero-upper',
            'characterization-bearer-multiplicity', 'parthood-crosses-natures',
            'relation-end-nature-mismatch', 'relation-ends-reversed', 'linking-error'
        ]);
        const session = new TontoSession();
        const noisy: string[] = [];
        for (const stereotype of Object.keys(RELATION_NATURE_TABLE)) {
            for (const pair of RELATION_NATURE_TABLE[stereotype] ?? []) {
                const [from, to] = pair.split(':');
                // The far class is one the snippet cannot see, so a rule about
                // *its* end is not the snippet's to answer.
                // The table spells a nature one way and the immutability set
                // another, so the names are translated before they are asked.
                if (!forNature[from] || !forNature[to] || IMMUTABLE.has(TONTO_NATURE_NAMES[to])) {
                    continue;
                }
                const document = await parse(`package p\n${forNature[from]} Source {\n\n}\n`);
                const items = await services.lsp.CompletionProvider!.getCompletion(document, {
                    textDocument: { uri: document.textDocument.uri },
                    position: { line: 2, character: 0 }
                });
                const snippet = (items?.items ?? []).find(item => item.label === `@${stereotype} (with ends)`);
                if (!snippet?.insertText) {
                    continue;
                }
                const written = snippet.insertText.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\d+/g, '');
                const target = /\b([A-Z][A-Za-z]*)\s*$/.exec(written)?.[1] ?? 'Type';
                const model = `package snippets\ndatatype date\n${forNature[from]} Source {\n    ${written}\n}\n`
                    + `${forNature[to]} ${target}\n`;
                const reported = (await session.validateText(model))
                    .filter(one => aboutEnds.has(String(one.code)));
                if (reported.length > 0) {
                    noisy.push(`@${stereotype} in a ${forNature[from]}: ${reported.map(one => one.code).join(', ')}`);
                }
                break;
            }
        }
        expect([...new Set(noisy)]).toEqual([]);
    }, 60_000);

    test('but a datatype holds values, so only the attribute', async () => {
        const labels = await labelsAt('package p\ndatatype Address {\n\n}\n', 2);
        expect(labels).toEqual(['attribute']);
    });

    test('and at package level a relation carries its source', async () => {
        const labels = await labelsAt('package p\nkind Person\n\n', 2);
        expect(labels).toContain('@mediation (relation)');
        expect(labels).not.toContain('@mediation (with ends)');
        expect(labels).toContain('kind (with attributes)');
    });

    test('the snippets say what the rules say', async () => {
        // A snippet is read as advice, so it cannot hold the mistakes the
        // checks are about: the relator end of a mediation is "[1..*]", and
        // the instants are typed by the built-in "date".
        const items = await itemsAt('package p\nrelator Employment {\n\n}\n', 2);
        // The weaker claim, since the mediated type is a placeholder: `[1..*]`
        // would say the relator founds it, which is true of a role and false
        // of a kind.
        expect(items.find(item => item.label === '@mediation (with ends)')?.insertText)
            .toContain('[${1:*}] -- [${2:1}] (const)');
        expect(items.find(item => item.label === '@begin (attribute)')?.insertText)
            .toBe('@begin ${1:startedAt}: const ${2:date}');

        // An event has ended, so its end point is not optional.
        const inAnEvent = await itemsAt('package p\nevent Wedding {\n\n}\n', 2);
        expect(inAnEvent.find(item => item.label === '@end (attribute)')?.insertText)
            .toBe('@end ${1:finishedAt}: const ${2:date}');

        // And a process is constituted by events rather than constituting.
        const inAProcess = await itemsAt('package p\nprocess Baking {\n\n}\n', 2);
        expect(inAProcess.map(item => item.label)).toContain('@constitution (the events that make this up)');
    });
});

describe('writing what a relation is derived from', () => {
    const employment = [
        'package p', 'kind Person', 'role Employee specializes Person', 'role Member specializes Person',
        'kind Organization', 'relator Employment {',
        '@mediation [1..*] -- [1] (const) Employee', '@mediation [0..*] -- [1] (const) Organization', '}',
        'relator Membership {',
        '@mediation [1..*] -- [1] (const) Member', '@mediation [0..*] -- [1] (const) Organization', '}',
        'quality Height {', '@characterization [1] -- [1] (const) Person', '}'
    ].join('\n');

    test('the relator that grounds a relation is named on it', async () => {
        const document = await parse(`${employment}\n@material relation Employee [0..*] -- worksFor -- [1..*] Organization`);
        const actions = await fixesFor(document, 'derivation-unstated');
        expect(actions.map(action => action.title)).toEqual(['Derive it from "Employment"']);
        const text = applyFirst(document, actions as never);
        expect(text).toContain('-- [1..*] Organization derivedFrom Employment');
        const after = await new TontoSession().validateText(text);
        expect(after.filter(one => /deriv|material/.test(one.code ?? ''))).toEqual([]);
    });

    test('does not ask an inverse to repeat the material derivation', async () => {
        const document = await parse([
            'package p', 'kind Person', 'relator ParentHood {',
            '    @mediation (childParenthoods) [*] -- [1] (const involvesParent) Person',
            '    @mediation (parentParenthoods) [2] -- [1] (const involvesChild) Person',
            '}',
            '@material relation Person [2] -- hasChild -- [0..*] Person inverseOf hasParent derivedFrom ParentHood',
            '@material relation Person (children) [0..*] -- hasParent -- [2] (parents) Person'
        ].join('\n'));
        expect((document.diagnostics ?? []).map(diagnostic => diagnostic.code)).not.toContain('derivation-unstated');
        expect((document.diagnostics ?? []).map(diagnostic => diagnostic.code)).not.toContain('material-without-relator');
    });

    test('and replaces one that binds only one end', async () => {
        const document = await parse(
            `${employment}\n@material relation Employee [0..*] -- worksFor -- [0..*] Organization derivedFrom Membership`);
        const text = applyFirst(document, await fixesFor(document, 'derivation-not-grounded') as never);
        expect(text).toContain('Organization derivedFrom Employment');
        expect(text).not.toContain('Membership\n');
    });

    test('narrows an end that admits what the two exact mediations rule out', async () => {
        const document = await parse(`${employment}\n@material relation Employee [0..*] -- worksFor -- [0..*] Organization derivedFrom Employment`);
        const actions = await fixesFor(document, 'material-cardinality-weaker');
        expect(actions.map(action => action.title)).toEqual(['Narrow the target end to "[1..*]"']);
        expect((actions[0].data as { batchSafe?: boolean }).batchSafe).toBe(true);
        const text = applyFirst(document, actions as never);
        expect(text).toContain('-- [1..*] Organization derivedFrom Employment');
        const after = await new TontoSession().validateText(text);
        expect(after.map(one => one.code)).not.toContain('material-cardinality-weaker');
    });

    test('offers the derived cardinality, unapplied, where the end contradicts or narrows it', async () => {
        const single = employment.replace('@mediation [1..*] -- [1] (const) Employee', '@mediation [1] -- [1] (const) Employee');
        for (const [model, end, code, derived] of [
            [single, '[2..*] ', 'material-cardinality-mismatch', '[1]'],
            [employment, '', 'material-cardinality-narrower', '[1..*]']
        ]) {
            const document = await parse(`${model}\n@material relation Employee [0..*] -- worksFor -- ${end}Organization derivedFrom Employment`);
            const actions = await fixesFor(document, code);
            expect(actions.map(action => action.title), code).toEqual([`Use the derived target cardinality "${derived}"`]);
            expect((actions[0].data as { batchSafe?: boolean }).batchSafe, code).toBe(false);
            expect(applyFirst(document, actions as never)).toContain(`-- ${derived} Organization derivedFrom Employment`);
        }
    });

    test('a relation derived from something is marked as the derived relation it is, or loses the clause', async () => {
        const document = await parse(`${employment}\nrelation Employee [0..*] -- worksFor -- [1..*] Organization derivedFrom Employment`);
        const actions = await fixesFor(document, 'derivation-on-underived-relation');
        expect(actions.map(action => action.title)).toEqual(['Mark it "@material"', 'Remove "derivedFrom"']);
        expect(applyFirst(document, actions as never)).toContain('@material relation Employee');
        expect(applyFirst(document, actions.slice(1) as never))
            .toMatch(/relation Employee \[0\.\.\*\] -- worksFor -- \[1\.\.\*\] Organization$/);
    });

    test('an entry of the wrong nature comes out of the list', async () => {
        const document = await parse(`${employment}\n@comparative relation Person [0..*] -- tallerThan -- [0..*] Person derivedFrom Employment, Height`);
        const actions = await fixesFor(document, 'derivation-source-nature');
        expect(actions.map(action => action.title)).toEqual(['Remove "Employment" from "derivedFrom"']);
        expect(applyFirst(document, actions as never)).toContain('Person derivedFrom Height');
    });

    test('the relator written for a material relation is named on it too', async () => {
        const document = await parse('package p\nkind Person\nrole Employee specializes Person\nkind Org\n'
            + '@material relation Employee [0..*] -- worksFor -- [1..*] Org');
        const text = applyFirst(document, await fixesFor(document, 'material-without-relator') as never);
        expect(text).toContain('-- [1..*] Org derivedFrom WorksFor\nrelator WorksFor {');
    });

    test('completion proposes only what the stereotype can be read off', async () => {
        const material = await parse(`${employment}\n@material relation Employee [0..*] -- worksFor -- [0..*] Organization derivedFrom `);
        const materialLabels = (await completeAtEnd(material)).map(item => String(item.label));
        expect(materialLabels).toContain('Employment');
        expect(materialLabels).not.toContain('Height');
        expect(materialLabels).not.toContain('Person');
        const comparative = await parse(`${employment}\n@comparative relation Person [0..*] -- tallerThan -- [0..*] Person derivedFrom `);
        const comparativeLabels = (await completeAtEnd(comparative)).map(item => String(item.label));
        expect(comparativeLabels).toContain('Height');
        expect(comparativeLabels).not.toContain('Employment');
    });

    test('and the clause is offered once the relation has its class', async () => {
        const document = await parse(`${employment}\n@material relation Employee [0..*] -- worksFor -- [0..*] Organization `);
        expect((await completeAtEnd(document)).map(item => String(item.label))).toContain('derivedFrom');
    });

    test('hover says what a relation is derived from', async () => {
        const document = await parse(`${employment}\n@material relation Employee [0..*] -- worksFor -- [1..*] Organization derivedFrom Employment`);
        expect(await hoverAt(document, 'worksFor')).toContain('*derived from* `Employment`');
    });
});

describe('requiring what founds a role', () => {
    test('the far end is raised to one, keeping its upper bound', async () => {
        const document = await parse('package p\nkind Person\nrole Student specializes Person\nkind University\n'
            + 'relator Enrollment {\n@mediation [0..*] -- [1] (const) Student\n@mediation [0..*] -- [1] (const) University\n}');
        const actions = await fixesFor(document, 'founding-relation-optional');
        expect(actions.map(action => action.title)).toEqual(['Require one: "[1..*]"']);
        const text = applyFirst(document, actions as never);
        expect(text).toContain('@mediation [1..*] -- [1] (const) Student');
        const after = await new TontoSession().validateText(text);
        expect(after.map(one => one.code)).not.toContain('founding-relation-optional');
    });
});

describe('a package\'s hover says what its ontology is published as', () => {
    test('its namespace, version, license and creators', async () => {
        const document = await parse('/// Who buys what.\n/// @namespace https://example.org/sales#\n/// @version 1.2.0\n'
            + '/// @license https://creativecommons.org/licenses/by/4.0/\n/// @creator Ana\n/// @creator Bruno\nontology sales\npackage p\nkind A');
        const hover = await hoverAt(document, 'package p', 9);
        expect(hover).toContain('Namespace: `https://example.org/sales#`');
        expect(hover).toContain('Version: 1.2.0');
        expect(hover).toContain('License: https://creativecommons.org/licenses/by/4.0/');
        expect(hover).toContain('Creators: Ana, Bruno');
    });
});

describe('rename, where references are qualified', () => {
    /** The model with what is named at the first occurrence of `at` renamed, every edit applied. */
    async function renamed(source: string, at: string, newName: string): Promise<string> {
        const document = await parse(source);
        const text = document.textDocument.getText();
        const offset = text.indexOf(at);
        expect(offset, `"${at}" is not in the model`).toBeGreaterThanOrEqual(0);
        const edit = await services.lsp.RenameProvider!.rename(document, {
            textDocument: { uri: document.textDocument.uri },
            position: document.textDocument.positionAt(offset),
            newName
        });
        const edits = Object.values(edit?.changes ?? {})[0] ?? [];
        return [...edits]
            .map(e => ({ start: document.textDocument.offsetAt(e.range.start), end: document.textDocument.offsetAt(e.range.end), newText: e.newText }))
            .sort((a, b) => b.start - a.start)
            .reduce((acc, e) => acc.slice(0, e.start) + e.newText + acc.slice(e.end), text);
    }
    const model = [
        'package p',
        'kind Person {',
        '    @participation (const) [2..*] -- participatedIn -- [*] Meeting inverseOf Meeting.joinedByParticipant',
        '}',
        'event Meeting {',
        '    [*] -- joinedByParticipant -- [2..*] (const) Person',
        '}',
        'historicalRole Attendee specializes Person derivedFrom Person.participatedIn'
    ].join('\n');

    test('a relation keeps the class it is named through', async () => {
        const text = await renamed(model, 'joinedByParticipant --', 'hadParticipant');
        expect(text).toContain('inverseOf Meeting.hadParticipant');
        expect(text).toContain('-- hadParticipant --');
        expect(await new TontoSession().validateText(text.replace('package p', 'package q1'))).toEqual([]);
    });

    test('a class carries the references through it to its relations', async () => {
        // Reported case: renaming the class left `Meeting.joinedByParticipant`
        // and `Person.participatedIn` naming classes that were gone.
        const meeting = await renamed(model, 'Meeting {', 'Encontro');
        expect(meeting).toContain('inverseOf Encontro.joinedByParticipant');
        const person = await renamed(model, 'Person {', 'Pessoa');
        expect(person).toContain('derivedFrom Pessoa.participatedIn');
        for (const [index, text] of [meeting, person].entries()) {
            expect(await new TontoSession().validateText(text.replace('package p', `package q${index + 2}`))).toEqual([]);
        }
    });

    test('and to the ends it owns', async () => {
        const team = [
            'package p', 'kind Person', 'kind Team {', '    [0..1] <>-- [2..*] (members) Person', '}',
            'subkind Squad specializes Team {', '    [0..1] <>-- [2..*] (players subsets Team.members) Person', '}'
        ].join('\n');
        const text = await renamed(team, 'Team {', 'Group');
        expect(text).toContain('(players subsets Group.members)');
        expect((await new TontoSession().validateText(text.replace('package p', 'package q4')))
            .filter(d => d.severity === 'error')).toEqual([]);
    });
});

describe('completing the general of a generalization set', () => {
    const session = new TontoSession();
    const labelsAt = async (source: string): Promise<string[]> => {
        const at = source.indexOf('|');
        const lines = source.slice(0, at).split('\n');
        return (await session.completionsAt(source.replace('|', ''), lines.length - 1, lines.at(-1)!.length))
            .map(proposal => proposal.label);
    };

    test('never offers the specifics themselves, nor what they cannot specialize', async () => {
        const model = 'package p\ncategory Agent of functional-complexes\nkind Person\nkind Car\nrelator Bond\n';
        expect(await labelsAt(`${model}disjoint complete genset g where Person, Car specializes |`)).toEqual(['Agent']);
        expect(await labelsAt(`${model}disjoint complete genset g {\n general |\n specifics Person, Car\n}`)).toEqual(['Agent']);
    });
});

describe('completing what a package reaches', () => {
    const session = new TontoSession();
    const labelsAt = async (source: string): Promise<string[]> => {
        const at = source.indexOf('|');
        const lines = source.slice(0, at).split('\n');
        return (await session.completionsAt(source.replace('|', ''), lines.length - 1, lines.at(-1)!.length))
            .map(proposal => proposal.label);
    };
    const model = 'ontology shop\npackage core\nkind Person\npackage sales\n';

    test('proposes packages after "use", and none after "import", which names an ontology', async () => {
        expect(await labelsAt(`${model}use |\nkind Order`)).toContain('core');
        expect(await labelsAt(`${model}import |\nkind Order`)).not.toContain('core');
    });
});

describe('completing a stereotype in front of a written member', () => {
    const session = new TontoSession();
    const at = async (source: string) => {
        const offset = source.indexOf('|');
        const lines = source.slice(0, offset).split('\n');
        return session.completionsAt(source.replace('|', ''), lines.length - 1, lines.at(-1)!.length);
    };

    test('offers no snippet that would write a second set of ends, and no instant tag', async () => {
        const proposals = await at('package p\nkind Person\nrole Employee specializes Person\n'
            + 'relator Employment {\n    @| [1..*] -- [1] (const) Employee\n}');
        const labels = proposals.map(proposal => proposal.label);
        expect(labels.filter(label => label.includes('(with ends)') || label.includes('(attribute)'))).toEqual([]);
        expect(labels).not.toContain('@begin');
        expect(labels).toContain('@mediation');
        // Still proposable, but said not to join these two ends.
        expect(proposals.find(proposal => proposal.label === '@creation')?.detail).toMatch(/not to a "role"/);
        expect(proposals.find(proposal => proposal.label === '@mediation')?.detail).not.toMatch(/not /);
    });

    test('and in front of an attribute offers the instant tags alone', async () => {
        const labels = (await at('package p\nkind Person {\n    @| birth: const date\n}')).map(proposal => proposal.label);
        expect(labels).toEqual(['@begin', '@end']);
    });
});
