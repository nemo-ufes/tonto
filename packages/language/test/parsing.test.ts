import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, URI } from 'langium';
import { parseHelper } from 'langium/test';
import type { LangiumDocument } from 'langium';
import { createTontoServices } from '../src/tonto-module.js';
import type { Model } from '../src/generated/ast.js';
import { isClassDeclaration, isDatatype, isEnumeration, isExternalRelation, isInternalRelation } from '../src/generated/ast.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const examplesDir = resolve(__dirname, 'fixtures/models');

function diagnosticsText(document: LangiumDocument): string {
    return (document.diagnostics ?? []).map(d => `${d.severity}: ${d.message}`).join('\n');
}

describe('parsing single files', () => {
    const allServices = createTontoServices(EmptyFileSystem);
    const services = allServices.Tonto;
    const parse = parseHelper<Model>(services);

    beforeAll(async () => {
        // Triggers loadAdditionalDocuments(), which registers the builtin
        // datatypes document (see TontoWorkspaceManager).
        await allServices.shared.workspace.WorkspaceManager.initializeWorkspace([]);
    });

    test.each(['relators/relators.tonto', 'qualities/qualities.tonto'])(
        'parses the %s example with no errors', async fileName => {
            const text = readFileSync(resolve(examplesDir, fileName), 'utf-8');
            const document = await parse(text, { validation: true });
            expect(document.parseResult.parserErrors, diagnosticsText(document)).toHaveLength(0);
            expect(document.parseResult.lexerErrors, diagnosticsText(document)).toHaveLength(0);

            const errors = (document.diagnostics ?? []).filter(d => d.severity === 1);
            expect(errors, diagnosticsText(document)).toHaveLength(0);
        }
    );

    test('represents classes and both relation forms in the relators example', async () => {
        const text = readFileSync(resolve(examplesDir, 'relators/relators.tonto'), 'utf-8');
        const document = await parse(text, { validation: true });
        const declarations = document.parseResult.value.packages.flatMap(p => p.declarations);

        const person = declarations.find(d => d.name === 'Person');
        expect(person && isClassDeclaration(person)).toBe(true);
        if (person && isClassDeclaration(person)) {
            expect(person.stereotype).toBe('kind');
            expect(Array.isArray(person.natures)).toBe(true);
        }

        const employment = declarations.find(d => d.name === 'Employment');
        expect(employment && isClassDeclaration(employment)).toBe(true);
        if (employment && isClassDeclaration(employment)) {
            expect(employment.relations.some(isInternalRelation)).toBe(true);
        }

        const employedBy = declarations.find(d => d.name === 'employedBy');
        expect(employedBy && isExternalRelation(employedBy)).toBe(true);
    });

    test('represents datatypes and enumerations in the qualities example', async () => {
        const text = readFileSync(resolve(examplesDir, 'qualities/qualities.tonto'), 'utf-8');
        const document = await parse(text, { validation: true });
        const declarations = document.parseResult.value.packages.flatMap(p => p.declarations);
        expect(declarations.some(d => d.name === 'ColorValueInRGB' && isDatatype(d))).toBe(true);
        expect(declarations.some(d => d.name === 'ShirtSize' && isEnumeration(d))).toBe(true);
    });
});

describe('parsing a multi-package workspace', () => {
    test('resolves references among the scientific-publications packages', async () => {
        const allServices = createTontoServices(EmptyFileSystem);
        const services = allServices.Tonto;
        await allServices.shared.workspace.WorkspaceManager.initializeWorkspace([]);
        const fileNames = ['scientific-publications.tonto', 'publications.tonto', 'authorship.tonto', 'publishers.tonto'];

        const documents = fileNames.map(fileName => {
            const text = readFileSync(resolve(examplesDir, 'scientific-publications', fileName), 'utf-8');
            const uri = URI.file(resolve(examplesDir, 'scientific-publications', fileName));
            return services.shared.workspace.LangiumDocumentFactory.fromString<Model>(text, uri);
        });

        for (const document of documents) {
            services.shared.workspace.LangiumDocuments.addDocument(document);
        }

        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });

        for (const document of documents) {
            expect(document.parseResult.parserErrors, diagnosticsText(document)).toHaveLength(0);
            const errors = (document.diagnostics ?? []).filter(d => d.severity === 1);
            expect(errors, `${document.uri.toString()}:\n${diagnosticsText(document)}`).toHaveLength(0);
        }
    });
});
