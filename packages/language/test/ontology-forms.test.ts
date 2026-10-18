import { afterEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { URI } from 'langium';
import type { LangiumDocument } from 'langium';
import { VirtualFileSystemProvider } from 'langium/test';
import { CodeActionKind } from 'vscode-languageserver';
import type { CodeAction, Diagnostic, TextEdit, WorkspaceEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { createTontoServices } from '../src/tonto-module.js';
import { publicationWorkspace } from '../src/publication/workspace.js';
import { TontoSession } from '../src/api.js';
import { patternInsertionProblem } from '../src/cli/patterns.js';
import { authoredOntologies, newPackageEdit } from '../src/lsp/ontology-actions.js';
import { canonicalPath } from '../src/utils/paths.js';

/**
 * The three forms an ontology's documents take -- one-file, packaged with
 * inline packages and bundles, and member packages that say `in` -- and the
 * repairs and refactoring that move a model between them. A workspace here is
 * a virtual one, so that a repair reaching into a second document, or one
 * creating a document, can be applied and the result checked again.
 */
class Workspace {
    readonly files = new VirtualFileSystemProvider();
    readonly services = createTontoServices({ fileSystemProvider: () => this.files });
    private readonly written = new Set<string>();

    constructor(files: Record<string, string>) {
        publicationWorkspace(this.services.shared).configure(['/project']);
        for (const [name, source] of Object.entries(files)) this.put(name, source);
    }

    put(name: string, source: string): void {
        const uri = name.startsWith('file:') ? URI.parse(name) : URI.file(`/project/${name}`);
        this.files.insert(uri, source);
        this.written.add(uri.toString());
    }

    async build(): Promise<void> {
        const builder = this.services.shared.workspace.DocumentBuilder;
        const documents = this.services.shared.workspace.LangiumDocuments;
        const uris = [...this.written].map(uri => URI.parse(uri));
        // Changed documents are re-read from the filesystem; new ones loaded.
        await builder.update(uris.filter(uri => documents.hasDocument(uri)), []);
        for (const uri of uris.filter(uri => !documents.hasDocument(uri))) {
            documents.addDocument(this.services.shared.workspace.LangiumDocumentFactory.fromString(this.files.readFileSync(uri), uri));
        }
        await builder.update(uris, []);
    }

    document(name: string): LangiumDocument {
        return this.services.shared.workspace.LangiumDocuments.getDocument(URI.file(`/project/${name}`))!;
    }

    text(name: string): string {
        return this.document(name).textDocument.getText();
    }

    /** Every diagnostic in the workspace, as `file code`. */
    diagnostics(severity?: number): string[] {
        return this.services.shared.workspace.LangiumDocuments.all.toArray()
            .filter(doc => doc.uri.scheme === 'file')
            .flatMap(doc => (doc.diagnostics ?? []).filter(diag => severity === undefined || diag.severity! <= severity)
                .map(diag => `${basename(doc.uri.path)} ${diag.code}`)).sort();
    }

    async actions(name: string, code: string): Promise<CodeAction[]> {
        const document = this.document(name);
        const diagnostics = (document.diagnostics ?? []).filter((diag: Diagnostic) => diag.code === code);
        expect(diagnostics.length, `no ${code} in ${name}: ${this.diagnostics().join(', ')}`).toBeGreaterThan(0);
        const actions = await this.services.Tonto.lsp.CodeActionProvider!.getCodeActions(document, {
            textDocument: { uri: document.textDocument.uri }, range: diagnostics[0].range, context: { diagnostics, only: [CodeActionKind.QuickFix] }
        });
        return (actions ?? []) as CodeAction[];
    }

    async refactorings(name: string, line: number): Promise<CodeAction[]> {
        const document = this.document(name);
        const actions = await this.services.Tonto.lsp.CodeActionProvider!.getCodeActions(document, {
            textDocument: { uri: document.textDocument.uri },
            range: { start: { line, character: 0 }, end: { line, character: 0 } },
            context: { diagnostics: [], only: [CodeActionKind.RefactorRewrite] }
        });
        return (actions ?? []) as CodeAction[];
    }

    /** Applies a workspace edit the way an editor does, then checks again. */
    async apply(edit: WorkspaceEdit): Promise<void> {
        const sources = new Map<string, string>();
        const read = (uri: string): string => sources.get(uri)
            ?? this.services.shared.workspace.LangiumDocuments.getDocument(URI.parse(uri))?.textDocument.getText() ?? '';
        const change = (uri: string, edits: TextEdit[]): void => {
            sources.set(uri, TextDocument.applyEdits(TextDocument.create(uri, 'tonto', 0, read(uri)), edits));
        };
        for (const [uri, edits] of Object.entries(edit.changes ?? {})) change(uri, edits);
        for (const step of edit.documentChanges ?? []) {
            if ('kind' in step) {
                expect(step.kind).toBe('create');
                if (step.kind === 'create') {
                    expect(this.services.shared.workspace.LangiumDocuments.hasDocument(URI.parse(step.uri))).toBe(false);
                    sources.set(step.uri, '');
                }
            } else {
                change(step.textDocument.uri, step.edits as TextEdit[]);
            }
        }
        for (const [uri, source] of sources) this.put(uri, source);
        await this.build();
    }

    /**
     * Moves a file or folder the way an editor does: asks for the edits that
     * go with the move, applies them, then moves what is under it.
     */
    async move(from: string, to: string): Promise<void> {
        const oldUri = URI.file(`/project/${from}`).toString();
        const edit = await this.services.shared.lsp.FileOperationHandler!.willRenameFiles!({
            files: [{ oldUri, newUri: URI.file(`/project/${to}`).toString() }]
        });
        if (edit) await this.apply(edit);
        const documents = this.services.shared.workspace.LangiumDocuments;
        const gone: URI[] = [];
        for (const document of documents.all.toArray()) {
            const uri = document.uri.toString();
            if (uri !== oldUri && !uri.startsWith(`${oldUri}/`)) continue;
            const source = document.textDocument.getText();
            this.files.delete(document.uri);
            this.written.delete(uri);
            gone.push(document.uri);
            this.put(`${to}${uri.slice(oldUri.length)}`, source);
        }
        await this.services.shared.workspace.DocumentBuilder.update([], gone);
        await this.build();
    }
}

async function workspace(files: Record<string, string>): Promise<Workspace> {
    const result = new Workspace(files);
    await result.build();
    return result;
}

/** Applies the one repair offered for a code, and returns what is reported after. */
async function repaired(files: Record<string, string>, file: string, code: string, title?: RegExp): Promise<{ after: string[]; action: CodeAction; workspace: Workspace }> {
    const model = await workspace(files);
    const actions = (await model.actions(file, code)).filter(action => !title || title.test(action.title));
    expect(actions.map(action => action.title)).toHaveLength(1);
    await model.apply(actions[0].edit!);
    return { after: model.diagnostics(2), action: actions[0], workspace: model };
}

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function onDisk(files: Record<string, string>): string {
    const root = canonicalPath(mkdtempSync(join(tmpdir(), 'tonto-forms-')));
    roots.push(root);
    for (const [name, source] of Object.entries(files)) {
        mkdirSync(dirname(join(root, name)), { recursive: true });
        writeFileSync(join(root, name), source, 'utf8');
    }
    return root;
}

const ONE_FILE = [
    '/// Products and their prices.',
    '///',
    '/// @namespace https://example.org/shop#',
    'ontology shop',
    '',
    'import money from <money.tonto>',
    '',
    '/// Something for sale.',
    'kind Product {',
    '    price: money.Amount',
    '}',
    '',
    '// What tax applies to.',
    'role TaxedProduct specializes Product',
    'kind Authority',
    'relator Taxation {',
    '    @mediation [1..*] -- [1] (const) TaxedProduct',
    '    @mediation [0..*] -- [1] (const) Authority',
    '}',
    ''
].join('\n');
const MONEY = '/// @namespace https://example.org/money#\nontology money\ndatatype Amount\n';

describe('a one-file ontology', () => {
    test('is one document: a header and its declarations, with no package to name', async () => {
        const model = await workspace({ 'shop.tonto': ONE_FILE, 'money.tonto': MONEY });
        expect(model.diagnostics(2)).toEqual([]);
    });

    test('documents its first declaration, not the package its declarations make', async () => {
        const root = onDisk({ 'shop.tonto': ONE_FILE, 'money.tonto': MONEY });
        const result = await new TontoSession({ workspace: root }).gufoFiles([join(root, 'shop.tonto')]);
        expect(result.turtle).toContain('Something for sale.');
        expect(result.turtle).toContain('Products and their prices.');
        expect(result.turtle).toContain('# Written by `tonto gufo` from the tonto ontology shop.\n');
    });

    test('names itself where a message would name a package', async () => {
        const result = await new TontoSession().validateText('ontology shop\nkind Product\nkind Product\n');
        expect(result.find(diag => diag.code === 'duplicate-declaration')?.message).toContain('in ontology "shop"');
    });

    test('is imported by its ontology file like any other ontology', async () => {
        const model = await workspace({
            'shop.tonto': '/// @namespace https://example.org/shop#\nontology shop\nkind Product\n',
            'books.tonto': 'ontology books\nimport shop from <shop.tonto>\nsubkind Book specializes shop.Product\n'
        });
        expect(model.diagnostics(2)).toEqual([]);
    });

    test('is closed: a package elsewhere cannot join it', async () => {
        const model = await workspace({ 'shop.tonto': 'ontology shop\nkind Product\n', 'extra.tonto': 'package extra in shop\nkind Thing\n' });
        expect(model.diagnostics(2)).toEqual(['extra.tonto package-not-bundled']);
        expect(await model.actions('extra.tonto', 'package-not-bundled')).toEqual([]);
    });

    test('is listed by its name in a digest', async () => {
        const digest = await new TontoSession().digestOf('ontology shop\nkind Product\n');
        expect(digest.packages).toEqual(['ontology shop']);
    });

    test('folds its declarations, never the body they begin', async () => {
        const services = createTontoServices({ fileSystemProvider: () => new VirtualFileSystemProvider() });
        const document = services.shared.workspace.LangiumDocumentFactory.fromString(
            'ontology shop\n\nkind Product {\n    name: string\n}\nkind Price\n', URI.file('/fold.tonto'));
        const ranges = await services.Tonto.lsp.FoldingRangeProvider!.getFoldingRanges(document,
            { textDocument: { uri: document.uri.toString() } });
        expect(ranges.map(range => [range.startLine, range.endLine])).toEqual([[2, 3]]);
    });
});

describe('moving files', () => {
    const SHOP = {
        'shop.tonto': '/// @namespace https://example.org/shop#\nontology shop bundles\n    core from <core.tonto>\n    sales from <sales/orders.tonto>\n',
        'core.tonto': 'package core in shop\nkind Person\n',
        'sales/orders.tonto': 'package sales in shop\nuse core\nimport money from <../money.tonto>\nrole Customer specializes core.Person {\n    owes: money.Amount\n}\n',
        'money.tonto': MONEY
    };

    test('a renamed member stays bundled', async () => {
        const model = await workspace(SHOP);
        await model.move('core.tonto', 'parties.tonto');
        expect(model.text('shop.tonto')).toContain('core from <parties.tonto>');
        expect(model.diagnostics(2)).toEqual([]);
    });

    test('a member moved to another folder keeps its own imports', async () => {
        const model = await workspace(SHOP);
        await model.move('sales/orders.tonto', 'trade/sales/orders.tonto');
        expect(model.text('shop.tonto')).toContain('sales from <trade/sales/orders.tonto>');
        expect(model.text('trade/sales/orders.tonto')).toContain('import money from <../../money.tonto>');
        expect(model.diagnostics(2)).toEqual([]);
    });

    test('a moved entry keeps its bundles', async () => {
        const model = await workspace(SHOP);
        await model.move('shop.tonto', 'release/shop.tonto');
        expect(model.text('release/shop.tonto')).toContain('core from <../core.tonto>');
        expect(model.text('release/shop.tonto')).toContain('sales from <../sales/orders.tonto>');
        expect(model.diagnostics(2)).toEqual([]);
    });

    test('a renamed folder moves every location into it, and none within it', async () => {
        const model = await workspace(SHOP);
        await model.move('sales', 'selling');
        expect(model.text('shop.tonto')).toContain('sales from <selling/orders.tonto>');
        expect(model.text('selling/orders.tonto')).toContain('import money from <../money.tonto>');
        expect(model.diagnostics(2)).toEqual([]);
    });

    test('a move that changes no location edits nothing', async () => {
        const model = await workspace(SHOP);
        const edit = await model.services.shared.lsp.FileOperationHandler!.willRenameFiles!({
            files: [{ oldUri: URI.file('/project/notes.tonto').toString(), newUri: URI.file('/project/old/notes.tonto').toString() }]
        });
        expect(edit).toBeNull();
    });
});

describe('navigating from "in"', () => {
    const files = {
        'shop.tonto': '/// What the shop sells.\nontology shop bundles\n    core from <core.tonto>\n    sales from <sales.tonto>\n',
        'core.tonto': 'package core in shop\nkind Person\n',
        'sales.tonto': 'package sales in shop\nuse core\nrole Customer specializes core.Person\n'
    };
    const at = (model: Workspace, name: string, line: number, character: number) => {
        const document = model.document(name);
        return { document, params: { textDocument: { uri: document.uri.toString() }, position: { line, character } } };
    };

    test('goes to the ontology it names, and hovers it', async () => {
        const model = await workspace(files);
        const { document, params } = at(model, 'sales.tonto', 0, 18);
        const links = await model.services.Tonto.lsp.DefinitionProvider!.getDefinition(document, params);
        expect(links?.map(link => [link.targetUri.split('/').pop(), link.targetSelectionRange.start.line])).toEqual([['shop.tonto', 1]]);
        const hover = await model.services.Tonto.lsp.HoverProvider!.getHoverContent(document, params);
        expect(JSON.stringify(hover?.contents)).toContain('**ontology** `shop`');
        expect(JSON.stringify(hover?.contents)).toContain('What the shop sells.');
    });

    test('says when no document declares the ontology', async () => {
        const model = await workspace({ 'loose.tonto': 'package loose in nowhere\nkind Thing\n' });
        const { document, params } = at(model, 'loose.tonto', 0, 20);
        const hover = await model.services.Tonto.lsp.HoverProvider!.getHoverContent(document, params);
        expect(JSON.stringify(hover?.contents)).toContain('No document of this workspace declares it.');
    });

    test('finds the members of an ontology, from its name or from any "in"', async () => {
        const model = await workspace(files);
        const references = async (name: string, line: number, character: number, includeDeclaration: boolean) => {
            const { document, params } = at(model, name, line, character);
            const found = await model.services.Tonto.lsp.ReferencesProvider!.findReferences(document, { ...params, context: { includeDeclaration } });
            return found.map(location => `${location.uri.split('/').pop()}:${location.range.start.line}`).sort();
        };
        expect(await references('shop.tonto', 1, 10, false)).toEqual(['core.tonto:0', 'sales.tonto:0']);
        expect(await references('core.tonto', 0, 17, true)).toEqual(['core.tonto:0', 'sales.tonto:0', 'shop.tonto:1']);
    });
});

describe('completing the words of headers', () => {
    const offered = async (source: string, line: number, character: number): Promise<string[]> => {
        const labels = (await new TontoSession().completionsAt(source, line, character)).map(proposal => proposal.label);
        return ['bundles', 'in', 'use'].filter(word => labels.includes(word));
    };

    test.each([
        ['on the line of an ontology with nothing after it', 'ontology shop ', 0, 14, ['bundles']],
        ['on the line of an ontology that declares its content', 'ontology shop \n\nkind Product\n', 0, 14, []],
        ['below an ontology header', 'ontology shop\n\nkind Product\n', 1, 0, []],
        ['at the end of a one-file ontology', 'ontology shop\n\nkind Product\n\n', 3, 0, []],
        ['on the line of a package', 'package core ', 0, 13, ['in']],
        ['below a package', 'package core\n\n', 1, 0, ['use']],
        ['in an inline package', 'ontology shop\n\npackage core\nkind A\n\npackage sales\n\n', 6, 0, ['use']]
    ] as const)('%s', async (_, source, line, character, expected) => {
        expect(await offered(source, line, character)).toEqual(expected);
    });
});

describe('where a modeling pattern can go', () => {
    const at = (source: string): string | undefined => patternInsertionProblem(source.replace('|', ''), source.indexOf('|'));

    test.each([
        ['a one-file ontology', 'ontology shop\n\nkind Product\n|\n'],
        ['a documented one-file ontology', '/// Shop.\nontology shop // the shop\n\n|\n'],
        ['a package', 'package core\n|\n'],
        ['a member package', 'package core in shop\n|\n'],
        ['an inline package', 'ontology shop\n\npackage core\nkind Product\n|\n']
    ])('after %s', (_, source) => {
        expect(at(source)).toBeUndefined();
    });

    test.each([
        ['before any header', '|\nontology shop\n', /declaration before/],
        ['in an ontology file that bundles', 'ontology shop bundles\n    core from <core.tonto>\n|\n', /ontology file only lists/],
        ['in an ontology file whose list starts below its name', 'ontology shop\nbundles\n    core from <core.tonto>\n|\n', /ontology file only lists/],
        ['inside a declaration', 'ontology shop\nkind Product {\n|\n}\n', /not inside/]
    ])('not %s', (_, source, problem) => {
        expect(at(source)).toMatch(problem);
    });
});

describe('the ontologies a workspace authors', () => {
    test('are its headers, with where each is written and what would stop its export', async () => {
        const outside = onDisk({ 'people.tonto': '/// @namespace https://example.org/people#\nontology people\nkind Person\n' });
        const root = onDisk({
            'shop.tonto': '/// @namespace https://example.org/shop#\nontology shop\nkind Product\n',
            'bikes/bikes.tonto': 'ontology bikes bundles\n    parts from <parts/parts.tonto>\n',
            'bikes/parts/parts.tonto': 'package parts in bikes\nkind Wheel\nkind Saddle specializes Wheel\n',
            // A location is a URL: a Windows path, C:\..., would read as a scheme.
            'clients.tonto': `ontology clients\nimport people from <${pathToFileURL(join(outside, 'people.tonto')).href}>\nrole Client specializes people.Person\n`,
            'returns.tonto': 'package returns in refunds\nkind Parcel\n',
            'loose.tonto': 'package loose\nkind Thing\n'
        });
        const listed = await new TontoSession({ workspace: root }).ontologies();
        expect(listed.map(one => [one.name, relative(root, one.file).split(sep).join('/'), one.namespace, one.errors])).toEqual([
            ['bikes', 'bikes/bikes.tonto', undefined, 1],
            ['clients', 'clients.tonto', undefined, 0],
            ['shop', 'shop.tonto', 'https://example.org/shop#', 0]
        ]);
        expect(listed[0].files.map(file => relative(root, file).split(sep).join('/'))).toEqual(['bikes/bikes.tonto', 'bikes/parts/parts.tonto']);
    });
});

describe('a package of no ontology', () => {
    test('is an error while editing and at publication, with a tonto.json or without', async () => {
        for (const config of [{}, { 'tonto.json': '{}' }]) {
            for (const publication of [false, true]) {
                const root = onDisk({ ...config, 'orders.tonto': 'package sales\nkind Order\n' });
                const reported = await new TontoSession({ workspace: root, publication }).validateFiles([root]);
                expect(reported.filter(diag => diag.severity === 'error').map(diag => diag.code)).toContain('package-without-ontology');
            }
        }
    });

    test('becomes a one-file ontology', async () => {
        const { after, workspace } = await repaired({ 'orders.tonto': 'package sales\nkind Order\n' }, 'orders.tonto', 'package-without-ontology', /one-file/);
        expect(after).toEqual([]);
        expect(workspace.text('orders.tonto')).toBe('ontology sales\nkind Order\n');
    });

    test('or an inline package of a header written above it, named after its file', async () => {
        const { after, workspace } = await repaired({ 'orders.tonto': 'package sales\nkind Order\n' }, 'orders.tonto', 'package-without-ontology', /above/);
        expect(after).toEqual([]);
        expect(workspace.text('orders.tonto')).toBe('ontology orders\n\npackage sales\nkind Order\n');
    });

    test('or a member of an ontology that bundles packages, written in both documents at once', async () => {
        const { after, workspace, action } = await repaired({
            'shop.tonto': 'ontology shop bundles\n    core from <core.tonto>\n',
            'core.tonto': 'package core in shop\nkind Person\n',
            'orders.tonto': 'package sales\nkind Order\n'
        }, 'orders.tonto', 'package-without-ontology', /Bundle/);
        expect(action.title).toBe('Bundle "sales" into ontology "shop" (shop.tonto)');
        expect(after).toEqual([]);
        expect(workspace.text('orders.tonto')).toBe('package sales in shop\nkind Order\n');
        expect(workspace.text('shop.tonto')).toContain('    sales from <orders.tonto>');
    });

    test('of several, or one that uses another, is offered only the header', async () => {
        const model = await workspace({ 'two.tonto': 'package a\nkind A\npackage b\nuse a\nkind B\n' });
        const titles = (await model.actions('two.tonto', 'package-without-ontology')).map(action => action.title);
        expect(titles).toEqual(['Write "ontology two" above its packages']);
    });

    test('is apart from every other, whatever names or namespace they share', async () => {
        const shared = '/// @namespace https://example.org/x#\npackage common\nkind Person\n';
        const model = await workspace({ 'a.tonto': shared, 'b.tonto': shared });
        const reported = model.diagnostics(1);
        expect(reported).toContain('a.tonto package-without-ontology');
        expect(reported).toContain('b.tonto package-without-ontology');
        // Two claims on one namespace, not one ontology of two packages.
        expect(reported.filter(code => /name-clash|duplicate-package/.test(code))).toEqual([]);
    });

    test('cannot be imported, since its document declares no ontology', async () => {
        const model = await workspace({
            'shop.tonto': 'ontology shop\nimport legacy from <legacy.tonto>\nkind Product\n',
            'legacy.tonto': 'package legacy\nkind Person\n'
        });
        expect(model.diagnostics(1)).toEqual(['legacy.tonto package-without-ontology', 'shop.tonto ontology-file-required']);
    });
});

describe('a packaged ontology', () => {
    test('owns its inline packages and its bundled ones', async () => {
        const model = await workspace({
            'shop.tonto': 'ontology shop bundles\n    catalog from <catalog.tonto>\npackage core\nkind Person\npackage sales\nuse core\nuse catalog\nrole Customer specializes core.Person\nkind Order { [*] -- [1..*] catalog.Product }\n',
            'catalog.tonto': 'package catalog in shop\nkind Product\n'
        });
        expect(model.diagnostics(1)).toEqual([]);
    });

    test('compares identifiers across inline and bundled packages', async () => {
        const model = await workspace({
            'shop.tonto': 'ontology shop bundles catalog from <catalog.tonto>\npackage core\nkind Product\n',
            'catalog.tonto': 'package catalog in shop\nkind Product\n'
        });
        expect(model.diagnostics(1)).toEqual(['catalog.tonto namespace-name-clash', 'shop.tonto namespace-name-clash']);
    });

    test('has packages or loose declarations, and wraps the loose ones in a package', async () => {
        const { after, workspace } = await repaired({ 'shop.tonto': 'ontology shop\n/// Loose.\nkind Loose\npackage core\nkind Person\n' },
            'shop.tonto', 'ontology-loose-declarations');
        expect(after).toEqual([]);
        expect(workspace.text('shop.tonto')).toBe('ontology shop\npackage shop\n\n/// Loose.\nkind Loose\npackage core\nkind Person\n');
    });

    test('lists at least one bundle when it says "bundles"', async () => {
        const model = await workspace({ 'shop.tonto': 'ontology shop bundles\n' });
        expect(model.diagnostics(1)).toEqual(['shop.tonto ontology-header']);
    });
});

describe('a member package', () => {
    const entry = '/// @namespace https://example.org/shop#\nontology shop bundles catalog from <catalog.tonto>\n';

    test('a missing local bundle source can be created as a member package', async () => {
        const model = await workspace({ 'shop.tonto': entry });
        expect(model.diagnostics(1)).toEqual(['shop.tonto publication-location']);
        const actions = await model.actions('shop.tonto', 'publication-location');
        expect(actions.map(action => action.title)).toEqual(['Create package "catalog" in catalog.tonto']);
        expect(actions[0].data).toEqual({ batchSafe: false });
        await model.apply(actions[0].edit!);
        expect(model.text('catalog.tonto')).toBe('package catalog in shop\n');
        expect(model.diagnostics(1)).toEqual([]);
    });

    test('bundle sources must be relative to their entry', async () => {
        const model = await workspace({ 'shop.tonto': 'ontology shop bundles core from <https://example.org/core.tonto>\n' });
        expect(model.diagnostics(1)).toEqual(['shop.tonto ontology-bundle-location']);
    });

    test('says which ontology bundles it, and is told when it does not', async () => {
        const { after, workspace } = await repaired({ 'shop.tonto': entry, 'catalog.tonto': 'package catalog\nkind Product\n' },
            'catalog.tonto', 'package-file-without-in');
        expect(after).toEqual([]);
        expect(workspace.text('catalog.tonto')).toBe('package catalog in shop\nkind Product\n');
    });

    test('must say so before publication', async () => {
        const root = onDisk({ 'shop.tonto': entry, 'catalog.tonto': 'package catalog\nkind Product\n' });
        const reported = await new TontoSession({ workspace: root, publication: true }).validateFiles([root]);
        expect(reported.find(diag => diag.code === 'package-file-without-in')?.severity).toBe('error');
    });

    test('cannot name another ontology than the one bundling it', async () => {
        const { after, workspace } = await repaired({ 'shop.tonto': entry, 'catalog.tonto': 'package catalog in store\nkind Product\n' },
            'catalog.tonto', 'package-in-mismatch');
        expect(after).toEqual([]);
        expect(workspace.text('catalog.tonto')).toBe('package catalog in shop\nkind Product\n');
    });

    test('needs no owner inside the entry, and cannot have another one there', async () => {
        const { after, workspace: fixed } = await repaired({ 'shop.tonto': 'ontology shop\npackage core in shop\nkind Person\n' },
            'shop.tonto', 'package-in-redundant');
        expect(after).toEqual([]);
        expect(fixed.text('shop.tonto')).toBe('ontology shop\npackage core\nkind Person\n');
        const other = await workspace({ 'shop.tonto': 'ontology shop\npackage core in store\nkind Person\n' });
        expect(other.diagnostics(1)).toEqual(['shop.tonto package-in-mismatch']);
    });

    test('that the entry does not bundle is offered to it, as a decision', async () => {
        const { after, action, workspace } = await repaired({
            'shop.tonto': entry, 'catalog.tonto': 'package catalog in shop\nkind Product\n',
            'more/extra.tonto': 'package extra in shop\nkind Thing\n'
        }, 'more/extra.tonto', 'package-not-bundled');
        expect(after).toEqual([]);
        expect((action.data as { batchSafe?: boolean }).batchSafe).toBe(false);
        expect(workspace.text('shop.tonto')).toBe(entry.replace('<catalog.tonto>', '<catalog.tonto>\n    extra from <more/extra.tonto>'));
    });

    test('repoints a bundle left at the old location when its package moves', async () => {
        const { after, action, workspace } = await repaired({
            'shop.tonto': 'ontology shop bundles\n    core from <old/core.tonto>\n',
            'new/core.tonto': 'package core in shop\nkind Person\n'
        }, 'new/core.tonto', 'package-not-bundled');
        expect(after).toEqual([]);
        expect(action.title).toContain('Update bundle for "core"');
        expect((action.data as { batchSafe?: boolean }).batchSafe).toBe(false);
        expect(workspace.text('shop.tonto')).toBe('ontology shop bundles\n    core from <new/core.tonto>\n');
    });

    test('does not offer a bundle that would duplicate a package name', async () => {
        const model = await workspace({
            'shop.tonto': 'ontology shop\npackage core\nkind Person\n',
            'member.tonto': 'package core in shop\nkind Car\n'
        });
        expect(model.diagnostics(1)).toEqual(['member.tonto package-not-bundled']);
        expect(await model.actions('member.tonto', 'package-not-bundled')).toEqual([]);
    });

    test('with no entry in the workspace is a draft of its ontology, checked with the others', async () => {
        const model = await workspace({
            'a.tonto': 'package a in store\nkind Person\n',
            'b.tonto': 'package b in store\nuse a\nrole Customer specializes a.Person\nkind Person\n'
        });
        expect(model.diagnostics(2)).toEqual([
            'a.tonto namespace-name-clash', 'a.tonto ontology-file-missing',
            'b.tonto namespace-name-clash', 'b.tonto ontology-file-missing'
        ]);
    });

    test('is not an ontology of its own to import', async () => {
        const model = await workspace({
            'shop.tonto': entry, 'catalog.tonto': 'package catalog in shop\nkind Product\n',
            'client.tonto': 'ontology client\nimport catalog from <catalog.tonto>\nkind Visitor\n'
        });
        expect(model.diagnostics(1)).toEqual(['client.tonto package-file-import']);
    });

    test('leaves the namespace to the ontology file', async () => {
        const { after, action } = await repaired({
            'shop.tonto': entry, 'catalog.tonto': '/// The catalog.\n/// @namespace https://example.org/shop#\npackage catalog in shop\nkind Product\n'
        }, 'catalog.tonto', 'ontology-tag-not-on-header');
        expect(action.title).toBe('Remove "@namespace", which the header of "shop" already gives');
        expect(after).toEqual([]);
    });

    test('moves what the header does not say yet into it, and leaves a contradiction to the header', async () => {
        const files = { 'shop.tonto': entry, 'catalog.tonto': '/// @version 1.2.0\npackage catalog in shop\nkind Product\n' };
        const { after, workspace: moved } = await repaired(files, 'catalog.tonto', 'ontology-tag-not-on-header', /^Move/);
        expect(after).toEqual([]);
        expect(moved.text('shop.tonto')).toContain('/// @version 1.2.0\nontology shop bundles');
        expect(moved.text('catalog.tonto')).toBe('package catalog in shop\nkind Product\n');
        const contradicted = await workspace({ ...files, 'shop.tonto': `/// @version 2.0.0\n${entry}` });
        expect((await contradicted.actions('catalog.tonto', 'ontology-tag-not-on-header')).map(action => action.title))
            .toEqual(['Remove "@version"; the header of "shop" gives 2.0.0']);
    });
});

describe('ontology names', () => {
    test('are distinct within a workspace, since members name them', async () => {
        const model = await workspace({ 'a.tonto': 'ontology shop\nkind A\n', 'b.tonto': 'ontology shop\nkind B\n' });
        expect(model.diagnostics(1)).toEqual(['a.tonto ontology-name-clash', 'b.tonto ontology-name-clash']);
    });

    test('renamed to lowercase take their members along', async () => {
        const { after, workspace } = await repaired({
            'shop.tonto': 'ontology Shop bundles catalog from <catalog.tonto>\n', 'catalog.tonto': 'package catalog in Shop\nkind Product\n'
        }, 'shop.tonto', 'ontology-name-case');
        expect(after).toEqual([]);
        expect(workspace.text('catalog.tonto')).toBe('package catalog in shop\nkind Product\n');
    });
});

describe('use', () => {
    test('is how a package is reached; "import" of one is an error, rewritten to "use"', async () => {
        const files = {
            'model.tonto': 'ontology model bundles\n    a from <a.tonto>\n    b from <b.tonto>\n',
            'a.tonto': 'package a in model\nkind Person\n', 'b.tonto': 'package b in model\nimport a\nrole Customer specializes a.Person\n'
        };
        const { after, workspace } = await repaired(files, 'b.tonto', 'import-for-use');
        expect(after).toEqual([]);
        expect(workspace.text('b.tonto')).toBe('package b in model\nuse a\nrole Customer specializes a.Person\n');
    });

    test('between packages of no ontology says how to make them one', async () => {
        const model = await workspace({ 'parties.tonto': 'package parties\nkind Person\n', 'billing.tonto': 'use parties\npackage billing\nrole Customer specializes parties.Person\n' });
        const reported = model.document('billing.tonto').diagnostics!.find(diag => diag.code === 'cross-ontology-package-use');
        expect(reported?.message).toBe('Package "parties" and this package belong to no ontology, so "use" cannot join them. '
            + 'Write an ontology file that bundles both; a folder or a tonto.json does not make them one ontology.');
    });

    test('of a draft from an ontology says to bundle the draft into it', async () => {
        const model = await workspace({ 'parties.tonto': 'package parties\nkind Person\n', 'billing.tonto': 'ontology shop\npackage billing\nuse parties\nrole Customer specializes parties.Person\n' });
        const reported = model.document('billing.tonto').diagnostics!.find(diag => diag.code === 'cross-ontology-package-use');
        expect(reported?.message).toContain('Bundle it into "shop"');
    });

    test('is what a missing-package repair writes', async () => {
        const model = await workspace({ 'shop.tonto': 'ontology shop\npackage core\nkind Person\npackage sales\nrole Customer specializes core.Person\n' });
        const actions = await model.actions('shop.tonto', 'missing-package-use');
        expect(actions.map(action => action.title)).toEqual(['Use "core"']);
        await model.apply(actions[0].edit!);
        expect(model.text('shop.tonto')).toContain('package sales\n\nuse core\n');
        expect(model.diagnostics(2)).toEqual([]);
    });

    test('is written after a member package\'s whole header, "in" included', async () => {
        const { after, workspace } = await repaired({
            'model.tonto': 'ontology model bundles\n    core from <core.tonto>\n    details from <details.tonto>\n',
            'core.tonto': 'package core in model\nkind Person\n',
            'details.tonto': 'package details in model\nsubkind Cyclist specializes core.Person\n'
        }, 'details.tonto', 'missing-package-use');
        expect(after).toEqual([]);
        expect(workspace.text('details.tonto')).toBe('package details in model\n\nuse core\n\nsubkind Cyclist specializes core.Person\n');
    });

    test('says "use" when it reports one', async () => {
        const result = await new TontoSession().validateText('package a\nkind Person\npackage b\nuse a\nkind Car\n');
        expect(result.find(diag => diag.code === 'unnecessary-use')?.message).toBe('`use a` is unnecessary: nothing here refers to "a".');
    });

    test('leaves "in" and "use" free to be names', async () => {
        const result = await new TontoSession().validateText('ontology p\nkind Thing {\n  in: string\n  use: number\n}\n');
        expect(result.filter(diag => diag.severity === 'error')).toEqual([]);
    });
});

describe('adding a package to an ontology', () => {
    const add = (model: Workspace, file: string, name: string, folder = '/project') => newPackageEdit(model.document(file), name, folder,
        publicationWorkspace(model.services.shared), uri => model.services.shared.workspace.LangiumDocuments.hasDocument(uri));

    test('lists the ontologies a package can join, saying which are one file', async () => {
        const model = await workspace({ 'shop.tonto': ONE_FILE, 'money.tonto': MONEY, 'people.tonto': 'ontology people bundles core from <core.tonto>\n', 'core.tonto': 'package core in people\nkind Person\n' });
        expect(authoredOntologies(publicationWorkspace(model.services.shared)).map(ontology => [ontology.name, ontology.oneFile]))
            .toEqual([['money', true], ['people', false], ['shop', true]]);
    });

    test('writes the package file and its bundle entry together', async () => {
        const model = await workspace({ 'people.tonto': 'ontology people bundles\n    core from <core.tonto>\n', 'core.tonto': 'package core in people\nkind Person\n' });
        const added = add(model, 'people.tonto', 'sales', '/project/trade');
        if ('problem' in added) throw new Error(added.problem);
        await model.apply(added.edit);
        expect(model.text('people.tonto')).toBe('ontology people bundles\n    core from <core.tonto>\n    sales from <trade/sales.tonto>\n');
        expect(model.text('trade/sales.tonto')).toBe('package sales in people\n\n');
        expect(model.diagnostics(2)).toEqual([]);
    });

    test('starts the bundle list of an ontology file that has only inline packages', async () => {
        const model = await workspace({ 'people.tonto': 'ontology people\npackage core\nkind Person\n' });
        const added = add(model, 'people.tonto', 'sales');
        if ('problem' in added) throw new Error(added.problem);
        await model.apply(added.edit);
        expect(model.text('people.tonto')).toBe('ontology people bundles\n    sales from <sales.tonto>\npackage core\nkind Person\n');
        expect(model.diagnostics(2)).toEqual([]);
    });

    test('splits a one-file ontology first, in the same edit', async () => {
        const model = await workspace({ 'shop.tonto': 'ontology shop\nkind Product\n' });
        const added = add(model, 'shop.tonto', 'core');
        if ('problem' in added) throw new Error(added.problem);
        expect(added.split).toBe('core2');
        await model.apply(added.edit);
        expect(model.text('shop.tonto')).toBe('ontology shop bundles\n    core2 from <core2.tonto>\n    core from <core.tonto>\n');
        expect(model.text('core2.tonto')).toBe('package core2 in shop\n\nkind Product\n');
        expect(model.text('core.tonto')).toBe('package core in shop\n\n');
        expect(model.diagnostics(2)).toEqual([]);
    });

    test('says what stops it', async () => {
        const model = await workspace({ 'people.tonto': 'ontology people bundles\n    core from <core.tonto>\n', 'core.tonto': 'package core in people\nkind Person\n' });
        expect(add(model, 'people.tonto', 'Sales')).toMatchObject({ problem: expect.stringContaining('not a package name') });
        expect(add(model, 'people.tonto', 'core')).toMatchObject({ problem: 'Ontology "people" already has a package "core".' });
        expect(add(model, 'people.tonto', 'people')).toMatchObject({ problem: 'people.tonto already exists.' });
        expect(add(model, 'core.tonto', 'sales')).toMatchObject({ problem: expect.stringContaining('declares no ontology') });
    });
});

describe('splitting a one-file ontology', () => {
    test('is offered on its header, and nowhere else', async () => {
        const model = await workspace({ 'shop.tonto': ONE_FILE, 'money.tonto': MONEY });
        expect((await model.refactorings('shop.tonto', 0)).map(action => action.title))
            .toContain('Split "shop" into an ontology file and package "core" (core.tonto)');
        expect((await model.refactorings('shop.tonto', 3)).some(action => action.title.startsWith('Split'))).toBe(true);
        expect((await model.refactorings('shop.tonto', 9)).some(action => action.title.startsWith('Split'))).toBe(false);
        const packaged = await workspace({ 'shop.tonto': 'ontology shop\npackage core\nkind Person\n' });
        expect((await packaged.refactorings('shop.tonto', 0)).some(action => action.title.startsWith('Split'))).toBe(false);
    });

    test('moves the declarations and their local imports into a member package', async () => {
        const model = await workspace({ 'shop.tonto': ONE_FILE, 'money.tonto': MONEY });
        const split = (await model.refactorings('shop.tonto', 3)).find(action => action.title.startsWith('Split'))!;
        await model.apply(split.edit!);
        expect(model.text('shop.tonto')).toBe([
            '/// Products and their prices.', '///', '/// @namespace https://example.org/shop#',
            'ontology shop bundles', '    core from <core.tonto>', ''
        ].join('\n'));
        expect(model.text('core.tonto')).toBe([
            'package core in shop', '', 'import money from <money.tonto>', '', '/// Something for sale.', 'kind Product {',
            '    price: money.Amount', '}', '', '// What tax applies to.', 'role TaxedProduct specializes Product',
            'kind Authority', 'relator Taxation {', '    @mediation [1..*] -- [1] (const) TaxedProduct',
            '    @mediation [0..*] -- [1] (const) Authority', '}', ''
        ].join('\n'));
        expect(model.diagnostics(2)).toEqual([]);
    });

    test('keeps imports written above the header in the entry', async () => {
        const model = await workspace({ 'shop.tonto': 'import money from <money.tonto>\nontology shop\nkind Product { price: money.Amount }\n', 'money.tonto': MONEY });
        const split = (await model.refactorings('shop.tonto', 1)).find(action => action.title.startsWith('Split'))!;
        await model.apply(split.edit!);
        expect(model.text('shop.tonto')).toBe('import money from <money.tonto>\nontology shop bundles\n    core from <core.tonto>\n');
        expect(model.text('core.tonto')).toBe('package core in shop\n\nkind Product { price: money.Amount }\n');
        expect(model.diagnostics(2)).toEqual([]);
    });

    test('changes no public name or IRI', async () => {
        const model = await workspace({ 'shop.tonto': ONE_FILE, 'money.tonto': MONEY });
        const split = (await model.refactorings('shop.tonto', 3)).find(action => action.title.startsWith('Split'))!;
        await model.apply(split.edit!);
        const before = onDisk({ 'shop.tonto': ONE_FILE, 'money.tonto': MONEY });
        const after = onDisk({ 'shop.tonto': model.text('shop.tonto'), 'core.tonto': model.text('core.tonto'), 'money.tonto': MONEY });
        // Everything but the provenance comment, which names the package the
        // split created.
        const turtle = async (root: string): Promise<string> =>
            (await new TontoSession({ workspace: root }).gufoFiles([join(root, 'shop.tonto')])).turtle!.replace(/^# Written by .*\n/m, '');
        expect(await turtle(after)).toBe(await turtle(before));
        expect(await turtle(before)).toContain('shop:TaxedProduct');
    });
});
