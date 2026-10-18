import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem, URI } from 'langium';
import { parseHelper } from 'langium/test';
import type { LangiumDocument } from 'langium';
import { createTontoServices } from '../src/tonto-module.js';
import type { Model } from '../src/generated/ast.js';
import { isClassDeclaration, isDatatype, isExternalRelation, isInternalRelation } from '../src/generated/ast.js';

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

    test('parses the showcase example with no errors', async () => {
        const text = readFileSync(resolve(examplesDir, 'showcase.tonto'), 'utf-8');
        const document = await parse(text, { validation: true });
        expect(document.parseResult.parserErrors, diagnosticsText(document)).toHaveLength(0);
        expect(document.parseResult.lexerErrors, diagnosticsText(document)).toHaveLength(0);

        const errors = (document.diagnostics ?? []).filter(d => d.severity === 1);
        expect(errors, diagnosticsText(document)).toHaveLength(0);
    });

    test('produces the redesigned AST shape', async () => {
        const text = readFileSync(resolve(examplesDir, 'showcase.tonto'), 'utf-8');
        const document = await parse(text, { validation: true });
        const model = document.parseResult.value;

        const showcase = model.packages.find(p => p.name === 'showcase');
        expect(showcase).toBeDefined();

        const person = showcase!.declarations.find(d => d.name === 'Person');
        expect(person && isClassDeclaration(person)).toBe(true);
        if (person && isClassDeclaration(person)) {
            // Stereotype and natures are flattened directly onto the node,
            // not nested in wrapper objects.
            expect(person.stereotype).toBe('kind');
            expect(Array.isArray(person.natures)).toBe(true);
        }

        const marriage = showcase!.declarations.find(d => d.name === 'Marriage' && isClassDeclaration(d));
        expect(marriage && isClassDeclaration(marriage)).toBe(true);
        if (marriage && isClassDeclaration(marriage)) {
            expect(marriage.relations).toHaveLength(1);
            expect(isInternalRelation(marriage.relations[0])).toBe(true);
        }

        const involvesSpouse = showcase!.declarations.find(d => d.name === 'involvesSpouse');
        expect(involvesSpouse && isExternalRelation(involvesSpouse)).toBe(true);

        const fullName = showcase!.declarations.find(d => d.name === 'FullName');
        expect(fullName && isDatatype(fullName)).toBe(true);
    });
});

describe('parsing a multi-package workspace', () => {
    test('resolves cross-package references via import and global visibility', async () => {
        const allServices = createTontoServices(EmptyFileSystem);
        const services = allServices.Tonto;
        await allServices.shared.workspace.WorkspaceManager.initializeWorkspace([]);
        const fileNames = ['academia.tonto', 'PersonAndOrganizationDatatypes.tonto', 'Person.tonto', 'University.tonto'];

        const documents = fileNames.map(fileName => {
            const text = readFileSync(resolve(examplesDir, 'university', fileName), 'utf-8');
            const uri = URI.file(resolve(examplesDir, 'university', fileName));
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
