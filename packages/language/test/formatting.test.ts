import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';
import { AstUtils, EmptyFileSystem } from 'langium';
import type { AstNode } from 'langium';
import { parseHelper } from 'langium/test';

import { createTontoServices } from '../src/tonto-module.js';
import type { Model } from '../src/generated/ast.js';

const all = createTontoServices(EmptyFileSystem);
const services = all.Tonto;
const parse = parseHelper<Model>(services);
const examplesDir = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/models');

async function format(source: string): Promise<string> {
    const document = await parse(source);
    const edits = await services.lsp.Formatter!.formatDocument(document, {
        textDocument: { uri: document.textDocument.uri },
        options: { tabSize: 4, insertSpaces: true }
    });
    const doc = document.textDocument;
    const ordered = [...edits].sort((a, b) => doc.offsetAt(b.range.start) - doc.offsetAt(a.range.start));
    let text = doc.getText();
    for (const edit of ordered) {
        text = text.slice(0, doc.offsetAt(edit.range.start)) + edit.newText + text.slice(doc.offsetAt(edit.range.end));
    }
    return text;
}

/**
 * A structural fingerprint that formatting must never change.
 *
 * Reaches inside bodies, and records the documentation attached to each
 * member. Both are here because neither was: a fingerprint of package and
 * declaration names alone said nothing about a body, and a blank line
 * collapsed inside one turned a detached `///` run into the documentation of
 * whatever followed -- a different parsed model, under an identical
 * fingerprint.
 */
async function fingerprint(source: string): Promise<string> {
    const document = await parse(source, { validation: true });
    const model = document.parseResult.value;
    const parts: string[] = [];
    const documented = (node: AstNode): string => {
        const text = (node as { $documentation?: { text?: string } }).$documentation?.text;
        return text ? ` /// ${text.replace(/\s+/g, ' ').trim()}` : '';
    };
    for (const pkg of model.packages) {
        parts.push(`package ${pkg.name}`);
        for (const declaration of pkg.declarations) {
            parts.push(`  ${declaration.$type} ${declaration.name ?? '<anon>'}${documented(declaration)}`);
            for (const member of AstUtils.streamContents(declaration)) {
                parts.push(`    ${member.$type} ${(member as { name?: string }).name ?? '<anon>'}${documented(member)}`);
            }
        }
    }
    return parts.join('\n');
}

async function parseErrors(source: string): Promise<number> {
    const document = await parse(source);
    return document.parseResult.parserErrors.length + document.parseResult.lexerErrors.length;
}

describe('formatting', () => {
    beforeAll(async () => {
        await all.shared.workspace.WorkspaceManager.initializeWorkspace([]);
    });

    const messy = `package    messy
kind   Person{
name:string
age : number [0..1]
}
   role Student   specializes   Person {
label{@en "Student"}
}
datatype Address{street:string}
enum Color{red,green}
disjoint genset G where Student specializes Person`;

    test('formatted output still parses', async () => {
        const formatted = await format(messy);
        expect(await parseErrors(formatted), formatted).toBe(0);
    });

    test('formatting preserves the model structure', async () => {
        const before = await fingerprint(messy);
        const after = await fingerprint(await format(messy));
        expect(after).toBe(before);
    });

    test('formatting is idempotent', async () => {
        const once = await format(messy);
        const twice = await format(once);
        expect(twice).toBe(once);
    });

    test('indents class bodies', async () => {
        const formatted = await format('package p\nkind Person {\nname: string\n}\n');
        expect(formatted).toContain('\n    name: string');
    });

    test('normalizes spacing around specializes', async () => {
        const formatted = await format('package p\nkind Person\nrole Student    specializes     Person\n');
        expect(formatted).toContain('role Student specializes Person');
    });

    test('keeps a relation on one line', async () => {
        // `interior()` used to attach the indent to the `--` token and split
        // the relation across two lines.
        const formatted = await format('package p\nkind C\nkind Person {\n[1] -- worksAt -- [0..*] C\n}\n');
        expect(formatted).toContain('    [1] -- worksAt -- [0..*] C');
    });

    test('attaches every comma in a list, not just the first', async () => {
        const formatted = await format('package p\nenum Color{red,green,blue}\n');
        expect(formatted).toContain('    red,\n    green,\n    blue');
    });

    test('normalizes commas in a specializes list', async () => {
        const formatted = await format('package p\nkind A\ncategory B\ncategory C specializes  A ,  B\n');
        expect(formatted).toContain('specializes A, B');
    });

    test('normalizes the space after a stereotype', async () => {
        expect(await format('package p\nkind    Person\n')).toContain('kind Person');
    });

    test('binds "@" to its property stereotype and leaves one space after it', async () => {
        const formatted = await format('package p\ndatatype Date\nkind Person {\n@begin   birth : const Date\n}\n');
        expect(formatted).toContain('    @begin birth: const Date');
    });

    test('indents a documentation comment with the member it documents', async () => {
        const formatted = await format(
            'package p\ndatatype date\nkind Person {\n/// When they were born.\n/// Second line.\nbirthDate: date\n}\n');
        expect(formatted).toContain('    /// When they were born.\n    /// Second line.\n    birthDate: date');
    });

    test('but leaves a trailing comment on the line it annotates', async () => {
        const formatted = await format('package p\ndatatype date\nkind Person {\nname: date // the given name\n}\n');
        expect(formatted).toContain('    name: date // the given name');
    });

    test('keeps a blank line the author wrote between declarations', async () => {
        const source = 'package p\nkind A\n\nkind B\n';
        expect(await format(source)).toContain('kind A\n\nkind B');
    });

    test('and one inside a body, where it decides what the model says', async () => {
        // The blank line is what ends a `///` run, so collapsing it attaches
        // the comment to `y` and changes the parsed model -- which the
        // fingerprint above now records.
        const source = 'package p\ndatatype d\nkind K {\n/// detached\n\ny: d\n}\n';
        const formatted = await format(source);
        expect(formatted).toContain('/// detached\n\n    y: d');
        expect(await fingerprint(formatted)).toBe(await fingerprint(source));
    });

    test('what a relation is derived from is a list like any other', async () => {
        const formatted = await format('package p\nkind Person\nquality Height\nquality Weight\n'
            + '@comparative relation Person -- r -- Person   derivedFrom  Height ,Weight\n');
        expect(formatted).toContain('@comparative relation Person -- r -- Person derivedFrom Height, Weight');
    });

    test('keeps relation refinements and modifiers that the example corpus does not use', async () => {
        const source = `package refinement
            kind Person {
                nicknames: ordered string [*]
                age: derived number
                @componenthood [1] <>-- hasHeart -- [1] (heart) Heart
            }
            kind Heart
            subkind Athlete specializes Person {
                @componenthood [1] <>-- [1] (heart redefines Person.heart) Heart specializes Person.hasHeart
            }
            relation Person -- hasOtherHeart -- (otherHeart subsets heart) Heart
            relation Heart -- belongsTo -- Person inverseOf Person.hasHeart
            type PersonType isPowerType`;
        const formatted = await format(source);
        expect(await parseErrors(formatted), formatted).toBe(0);
        expect(await fingerprint(formatted)).toBe(await fingerprint(source));
        for (const spelling of ['ordered string', 'derived number', 'redefines Person.heart',
            'subsets heart', 'inverseOf Person.hasHeart', 'isPowerType']) {
            expect(formatted).toContain(spelling);
        }
    });

    test.each(['relators/relators.tonto', 'qualities/qualities.tonto',
        'scientific-publications/authorship.tonto', 'scientific-publications/publishers.tonto'])(
        'round-trips the %s example without changing its structure',
        async fileName => {
            const source = readFileSync(resolve(examplesDir, fileName), 'utf-8');
            const formatted = await format(source);
            expect(await parseErrors(formatted), formatted).toBe(0);
            expect(await fingerprint(formatted)).toBe(await fingerprint(source));
        }
    );
});
