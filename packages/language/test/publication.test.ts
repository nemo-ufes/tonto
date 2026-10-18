import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { workspaceRootOf } from '../src/api.js';
import type { Reported } from '../src/api.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'langium';
import { VirtualFileSystemProvider } from 'langium/test';
import { createTontoServices } from '../src/tonto-module.js';
import { fetchSummary, publicationWorkspace } from '../src/publication/workspace.js';
import { inOntologyInPlace, OntologySession } from './in-ontology.js';
import { canonicalPath } from '../src/utils/paths.js';

/**
 * Every package belongs to a declared ontology, so a file written as bare
 * packages is given one, as `inOntologyInPlace` does -- unless an entry
 * bundles it, which makes it a member and keeps it a package. Names are paths
 * in a workspace or URLs on a host, and bundle locations resolve against the
 * entry's either way.
 */
function declared(files: Record<string, string>): Record<string, string> {
    const bundled = new Set<string>();
    for (const [name, source] of Object.entries(files)) {
        if (!/^\s*ontology\s/m.test(source)) continue;
        const base = /^https?:/.test(name) ? name : `file:///${name}`;
        for (const [, location] of source.matchAll(/[\w.]+ from <([^>]+)>/g)) {
            const target = new URL(location, base);
            bundled.add(target.protocol === 'file:' ? target.pathname.slice(1) : target.href);
        }
    }
    return Object.fromEntries(Object.entries(files).map(([name, source]) =>
        [name, name.endsWith('.tonto') && !bundled.has(name) ? inOntologyInPlace(source) : source]));
}

const roots: string[] = [];
function workspace(files: Record<string, string>): string {
    const root = canonicalPath(mkdtempSync(join(tmpdir(), 'tonto-publication-')));
    roots.push(root);
    for (const [name, source] of Object.entries(declared(files))) put(root, name, source);
    return root;
}
function put(root: string, name: string, source: string): void {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source, 'utf8');
}
function errors(diagnostics: Reported[]): string[] {
    return diagnostics.filter(diag => diag.severity === 'error').map(diag => `${diag.code}: ${diag.message}`);
}
function manifest(name: string, bundles = 'core from <core.tonto>', namespace = `https://example.org/${name}#`): string {
    return `/// @namespace ${namespace}\nontology ${name} bundles\n    ${bundles}\n`;
}
function serve(served: Record<string, string>): ReturnType<typeof vi.fn> {
    // Read at each request: a test changes what is served to make a refresh find it.
    const mock = vi.fn(async (url: string) => {
        const value = declared(served)[url];
        const response = new Response(value ?? 'Missing', { status: value === undefined ? 404 : 200 });
        Object.defineProperty(response, 'url', { value: url });
        return response;
    });
    vi.stubGlobal('fetch', mock);
    return mock;
}
afterEach(() => {
    vi.unstubAllGlobals();
    roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

describe('ontology ownership and publication', () => {
    test('reports only local substitutes used by the selected ontology', async () => {
        const root = workspace({
            'tonto.json': JSON.stringify({ locations: { 'https://example.org/people.tonto': 'people.tonto' } }),
            'shop.tonto': manifest('shop') + 'import people from <https://example.org/people.tonto>\n',
            'core.tonto': 'package core in shop\nsubkind Customer specializes people.Person',
            'people.tonto': 'ontology people\nkind Person',
            'other.tonto': 'ontology other\nkind Bicycle'
        });
        const session = new OntologySession({ workspace: root });
        expect(await session.substitutedImports([join(root, 'shop.tonto')]))
            .toEqual(['https://example.org/people.tonto']);
        expect(await session.substitutedImports([join(root, 'other.tonto')])).toEqual([]);
    });

    test('an entry import supplies its alias to every bundled package and exports the dependency', async () => {
        const root = workspace({
            'shop.tonto': manifest('shop', 'core from <core.tonto>\n    sales from <sales.tonto>')
                + 'import people from <people.tonto>\n',
            'core.tonto': 'package core in shop\nsubkind Customer specializes people.Person',
            'sales.tonto': 'package sales in shop\nsubkind Seller specializes people.Person',
            'people.tonto': '/// @namespace https://example.org/people#\nontology people\nkind Person'
        });
        const session = new OntologySession({ workspace: root });
        expect(errors(await session.validateFiles([join(root, 'shop.tonto')]))).toEqual([]);
        expect((await session.gufoFiles([join(root, 'shop.tonto')])).turtle).toContain('owl:imports <http://purl.org/nemo/gufo#>, <https://example.org/people>');
    });

    test('a bundled source cannot redeclare an ontology alias from its ontology file', async () => {
        const root = workspace({
            'shop.tonto': manifest('shop') + 'import people from <people.tonto>\n',
            'core.tonto': 'package core in shop\nimport people from <other.tonto>\nkind Person',
            'people.tonto': 'ontology people\nkind Human',
            'other.tonto': 'ontology other\nkind Bicycle'
        });
        const session = new OntologySession({ workspace: root });
        expect((await session.validateFiles([join(root, 'shop.tonto')])).map(diag => diag.code)).toContain('duplicate-alias');
        put(root, 'core.tonto', 'import people from <other.tonto>\npackage core in shop\nkind Person');
        expect((await new OntologySession({ workspace: root }).validateFiles([join(root, 'shop.tonto')])).map(diag => diag.code))
            .toContain('duplicate-alias');
    });

    test('an entry import alias cannot shadow a bundled package name', async () => {
        const root = workspace({
            'shop.tonto': manifest('shop') + 'import core from <people.tonto>\n',
            'core.tonto': 'package core in shop\nkind Product',
            'people.tonto': 'ontology people\nkind Person'
        });
        const result = await new OntologySession({ workspace: root }).validateFiles([join(root, 'shop.tonto')]);
        expect(result.map(diag => diag.code)).toContain('alias-shadows-package');
    });

    test('reloading an external dependency relinks unchanged clients', async () => {
        const files = new VirtualFileSystemProvider();
        const services = createTontoServices({ fileSystemProvider: () => files });
        publicationWorkspace(services.shared).configure(['/project']);
        const builder = services.shared.workspace.DocumentBuilder;
        builder.updateBuildOptions = { validation: true };
        const client = URI.file('/project/client.tonto');
        const other = URI.file('/project/other.tonto');
        const dependency = URI.file('/external/people.tonto');
        files.insert(dependency, 'ontology people\nkind Person');
        files.insert(client, 'ontology clients\nimport people from <../external/people.tonto>\nsubkind Visitor specializes people.Person');
        files.insert(other, 'ontology other\nkind Bicycle');
        await builder.update([client, other], []);
        const errors = (): string[] => (services.shared.workspace.LangiumDocuments.getDocument(client)!.diagnostics ?? [])
            .filter(diag => diag.severity === 1).map(diag => diag.message);
        expect(errors()).toEqual([]);

        files.insert(dependency, 'ontology people\nkind Human');
        await builder.update([other], []);
        expect(errors().some(message => message.includes('Could not resolve reference') && message.includes('people.Person'))).toBe(true);

        files.insert(dependency, 'ontology people\nkind Person');
        await builder.update([other], []);
        expect(errors()).toEqual([]);
    });

    test('the loader honors the configured filesystem provider', async () => {
        const filesystem = new VirtualFileSystemProvider();
        const services = createTontoServices({ fileSystemProvider: () => filesystem });
        filesystem.insert(URI.file('/project/shop.tonto'), manifest('shop'));
        filesystem.insert(URI.file('/project/core.tonto'), 'package core\nkind Person');
        await services.shared.workspace.DocumentBuilder.update([URI.file('/project/shop.tonto')], []);
        expect(services.shared.workspace.LangiumDocuments.getDocument(URI.file('/project/core.tonto'))).toBeDefined();
        expect(services.shared.workspace.LangiumDocuments.all.toArray().flatMap(doc => doc.diagnostics ?? []).filter(diag => diag.severity === 1)).toEqual([]);
    });

    test('renaming a package updates bundle selectors but leaves external ontology aliases alone', async () => {
        const filesystem = new VirtualFileSystemProvider();
        const services = createTontoServices({ fileSystemProvider: () => filesystem });
        publicationWorkspace(services.shared).configure(['/project']);
        filesystem.insert(URI.file('/project/shop.tonto'), manifest('shop'));
        filesystem.insert(URI.file('/project/core.tonto'), 'package core\nkind Person');
        filesystem.insert(URI.file('/project/client.tonto'), 'ontology clients\nimport core from <shop.tonto>\nsubkind Visitor specializes core.Person');
        await services.shared.workspace.DocumentBuilder.update([URI.file('/project/shop.tonto'), URI.file('/project/client.tonto')], []);
        const source = services.shared.workspace.LangiumDocuments.getDocument(URI.file('/project/core.tonto'))!;
        const edit = await services.Tonto.lsp.RenameProvider!.rename(source, {
            textDocument: { uri: source.uri.toString() }, position: { line: 0, character: 9 }, newName: 'foundation'
        });
        expect(Object.keys(edit?.changes ?? {}).sort()).toEqual(['file:///project/core.tonto', 'file:///project/shop.tonto']);
        for (const [uri, changes] of Object.entries(edit!.changes!)) {
            const doc = services.shared.workspace.LangiumDocuments.getDocument(URI.parse(uri))!;
            filesystem.insert(doc.uri, TextDocument.applyEdits(doc.textDocument, changes));
        }
        await services.shared.workspace.DocumentBuilder.update(Object.keys(edit!.changes!).map(uri => URI.parse(uri)), []);
        expect(services.shared.workspace.LangiumDocuments.all.toArray().flatMap(doc => doc.diagnostics ?? []).filter(diag => diag.severity === 1)).toEqual([]);
    });

    test('unannotated, unimported packages share one identifier space', async () => {
        const result = await new OntologySession().validateText('package a\nkind Person\npackage b\nkind Person');
        expect(result.filter(diag => diag.code === 'namespace-name-clash')).toHaveLength(2);
    });

    test('generated property names participate in ordinary validation', async () => {
        const result = await new OntologySession().validateText('package cars\nkind Car { hasComponentWheel: string\n @componenthood [1] <>-- [4] Wheel }\nkind Wheel');
        expect(result.map(diag => diag.code)).toContain('namespace-member-clash');
    });

    test('global is an ordinary name, not a visibility modifier; builtins need no imports', async () => {
        const session = new OntologySession();
        expect(errors(await session.validateText('package global\nkind Person { name: string }'))).toEqual([]);
        expect(errors(await session.validateText('global package people\nkind Person')).length).toBeGreaterThan(0);
    });

    test('same-file visibility requires an architectural import and offers a validated opt-in repair', async () => {
        const source = 'package core\nkind Person\npackage details\n/// Someone who rides.\nsubkind Cyclist specializes core.Person';
        const session = new OntologySession();
        const before = await session.validateText(source);
        const diagnostic = before.find(diag => diag.code === 'missing-package-use')!;
        expect(diagnostic.fixes.map(fix => fix.title)).toEqual(['Use "core"']);
        expect(diagnostic.fixes[0].batchSafe).toBe(false);
        const fixed = TextDocument.applyEdits(TextDocument.create('file:///draft.tonto', 'tonto', 0, source), diagnostic.fixes[0].changes[0].edits);
        expect(fixed).toContain('/// Someone who rides.\nsubkind Cyclist');
        expect(errors(await session.validateText(fixed))).toEqual([]);
        expect((await session.fixText(source)).applied).not.toContain('Use "core"');
    });

    test('a use is direct and does not re-export dependencies', async () => {
        const source = 'package a\nkind Person\npackage b\nuse a\nkind Bicycle\npackage c\nuse b\nsubkind Cyclist specializes Person';
        expect((await new OntologySession().validateText(source)).map(diag => diag.code)).toContain('missing-package-use');
    });

    test('use repairs preserve already-loaded external local dependencies', async () => {
        const external = workspace({ 'vehicles.tonto': 'package vehicles\nkind Vehicle' });
        const source = `package core\nimport vehicles from <${URI.file(join(external, 'vehicles.tonto'))}>\n`
            + 'subkind Car specializes vehicles.Vehicle\npackage details\nsubkind Sedan specializes core.Car';
        const root = workspace({ 'model.tonto': source });
        const session = new OntologySession({ workspace: root });
        const diagnostic = (await session.validateFiles([root])).find(diag => diag.code === 'missing-package-use')!;
        expect(diagnostic.fixes.map(fix => fix.title)).toContain('Use "core"');
        const fix = diagnostic.fixes.find(fix => fix.title === 'Use "core"')!;
        put(root, 'model.tonto', inOntologyInPlace(TextDocument.applyEdits(TextDocument.create('file:///model.tonto', 'tonto', 0, source), fix.changes[0].edits)));
        expect(errors(await session.validateFiles([root]))).toEqual([]);
    });

    test('completion marks hidden declarations and supplies an atomic use edit', async () => {
        const session = new OntologySession();
        // Two documents of one ontology, a draft of it since no entry is written.
        await session.hold('core', 'package core in model\nkind Person');
        const source = 'package details in model\nsubkind Cyclist specializes ';
        const proposals = await session.completionsAt(source, 1, source.split('\n')[1].length);
        const proposal = proposals.find(item => item.label === 'core.Person')!;
        expect(proposal?.detail).toBe('Adds "use core"');
        expect(proposal?.additionalTextEdits).toHaveLength(1);
        const completed = TextDocument.applyEdits(TextDocument.create('file:///draft.tonto', 'tonto', 0, source + proposal.label), proposal.additionalTextEdits!);
        expect(errors(await session.validateText(completed)), completed).toEqual([]);
    });

    test('a use repair that would introduce a semantic error is withheld', async () => {
        const source = 'package core\nkind Person\npackage details\nkind Invalid specializes core.Person';
        const diagnostic = (await new OntologySession().validateText(source)).find(diag => diag.code === 'missing-package-use');
        expect(diagnostic?.fixes).toEqual([]);
    });

    test('member import assistance follows the relation declaration, not the source classifier package', async () => {
        const source = 'package core\nkind Person\nkind Team\npackage links\nuse core\nrelation Team [*] -- hasMembers -- [*] (members) Person\npackage details\nuse core\nsubkind Squad specializes Team { [*] -- leaders -- [*] (subsets Team.members) Person }';
        const result = await new OntologySession().validateText(source);
        const missing = result.find(diag => diag.code === 'missing-package-use');
        expect(missing?.fixes.map(fix => fix.title)).toEqual(['Use "links"']);
    });

    test('manifest formatting is idempotent and preserves relative source locations', async () => {
        const session = new OntologySession();
        const source = '/// @namespace https://example.org/shop#\nontology shop bundles core from <foundation/core.tonto> sales from <commerce/sales.tonto>';
        const formatted = await session.formatText(source);
        expect(formatted).toContain('\n    core from <foundation/core.tonto>');
        expect(formatted).toContain('\n    sales from <commerce/sales.tonto>');
        expect(await session.formatText(formatted)).toBe(formatted);
    });

    test('mutual package references resolve once their direct imports are declared', async () => {
        const result = await new OntologySession().validateText('package a\nuse b\nkind Person { [*] -- owns -- [*] Bicycle }\npackage b\nuse a\nkind Bicycle { [*] -- usedBy -- [*] Person }');
        expect(errors(result)).toEqual([]);
    });

    test('lowercase ontology aliases are repaired together with their references', async () => {
        const root = workspace({
            'people.tonto': '/// @namespace https://example.org/people#\nontology people\nkind Person',
            'client.tonto': 'package client\nimport People from <people.tonto>\nsubkind Visitor specializes People.Person'
        });
        const session = new OntologySession({ workspace: root });
        const diagnostic = (await session.validateFiles([join(root, 'client.tonto')])).find(diag => diag.code === 'ontology-name-case');
        expect(diagnostic?.fixes[0]?.changes[0].edits.map(edit => edit.newText)).toEqual(['people', 'people.Person']);
        await session.fixFiles([join(root, 'client.tonto')], new Set(['ontology-name-case']));
        expect(errors(await session.validateFiles([root]))).toEqual([]);
    });

    test('manifests select arbitrary folders and external names omit the packages', async () => {
        const root = workspace({
            'shop.tonto': manifest('shop', 'core from <foundation/core.tonto>\n    commerce from <domains/sales.tonto>'),
            'foundation/core.tonto': 'package core\nkind Person',
            'domains/sales.tonto': 'package commerce\nuse core\nsubkind Cyclist specializes Person',
            'client.tonto': 'package client\nimport shop from <shop.tonto>\nsubkind Commuter specializes shop.Cyclist'
        });
        const session = new OntologySession({ workspace: root });
        expect(errors(await session.validateFiles([join(root, 'client.tonto')]))).toEqual([]);
        const result = await session.gufoFiles([join(root, 'shop.tonto')]);
        expect(result.files.map(file => file.file)).toEqual(['shop.ttl']);
        expect(result.turtle).toContain('<https://example.org/shop#>');
        expect(result.turtle).not.toContain('shop#commerce');
        expect(result.turtle).toContain('# Written by `tonto gufo` from the tonto ontology shop, packages commerce, core.');
    });

    test('independent ontologies may each have core.Person', async () => {
        const root = workspace({
            'one.tonto': manifest('one', 'core from <one/core.tonto>'),
            'two.tonto': manifest('two', 'core from <two/core.tonto>'),
            'one/core.tonto': 'package core\nkind Person',
            'two/core.tonto': 'package core\nkind Person'
        });
        expect(errors(await new OntologySession({ workspace: root }).validateFiles([root]))).toEqual([]);
    });

    test('ontology import cycles terminate, with separate ownership and namespaces', async () => {
        const root = workspace({
            'one.tonto': manifest('one', 'core from <one/core.tonto>'),
            'two.tonto': manifest('two', 'core from <two/core.tonto>'),
            'one/core.tonto': 'package core\nimport two from <../two.tonto>\nkind Person { [*] -- owns -- [*] two.Bicycle }',
            'two/core.tonto': 'package core\nimport one from <../one.tonto>\nkind Bicycle { [*] -- usedBy -- [*] one.Person }'
        });
        const session = new OntologySession({ workspace: root });
        expect(errors(await session.validateFiles([root]))).toEqual([]);
        const result = await session.gufoFiles([join(root, 'one.tonto')]);
        expect(result.files.map(file => file.file)).toEqual(['one.ttl']);
        expect(result.turtle).toContain('owl:imports <http://purl.org/nemo/gufo#>, <https://example.org/two>');
    });

    test('unused declared ontology dependencies remain OWL imports', async () => {
        const root = workspace({ 'one.tonto': manifest('one'), 'core.tonto': 'package core\nimport two from <two.tonto>\nkind Person', 'two.tonto': '/// @namespace https://example.org/two#\npackage other\nkind Bicycle' });
        const result = await new OntologySession({ workspace: root }).gufoFiles([join(root, 'one.tonto')]);
        expect(result.turtle).toContain('<https://example.org/two>');
        expect(result.turtle).not.toContain('two:Bicycle a');
    });

    test('a downstream mediation cannot make a dependency relator complete', async () => {
        const root = workspace({
            'people.tonto': '/// @namespace https://example.org/people#\nontology people\nkind Person\nrelator Employment { @mediation [*] -- [1] (const) Person }',
            'client.tonto': 'package client\nimport people from <people.tonto>\nkind Organization\n@mediation relation people.Employment [*] -- [1] (const) Organization'
        });
        const report = await new OntologySession({ workspace: root }).validateFiles([join(root, 'people.tonto')]);
        expect(report.filter(diag => diag.file.endsWith('people.tonto')).map(diag => diag.code)).toContain('relator-mediates-one');
    });

    test('imported standalone sources are document-bounded and excluded from the default ontology', async () => {
        const root = workspace({
            'people.tonto': '/// @namespace https://example.org/people#\nontology people\nkind Person',
            'client.tonto': 'package client\nimport people from <people.tonto>\nkind Person\nsubkind Visitor specializes people.Person'
        });
        const result = await new OntologySession({ workspace: root }).validateFiles([root]);
        expect(errors(result)).toEqual([]);
    });

    test('bundle selectors fail closed, and never absorb an unlisted package', async () => {
        const root = workspace({
            'shop.tonto': manifest('shop'),
            'core.tonto': 'package core\nkind Person\npackage hidden\nkind Person'
        });
        const session = new OntologySession({ workspace: root });
        expect(errors(await session.validateFiles([join(root, 'shop.tonto')]))).toEqual([]);
        put(root, 'shop.tonto', manifest('shop', 'absent from <core.tonto>'));
        expect((await session.validateFiles([join(root, 'shop.tonto')])).map(diag => diag.code)).toContain('ontology-bundle');
    });

    test('a package cannot belong to two roots', async () => {
        const root = workspace({ 'one.tonto': manifest('one'), 'two.tonto': manifest('two'), 'core.tonto': 'package core\nkind Person' });
        expect((await new OntologySession({ workspace: root }).validateFiles([root])).map(diag => diag.code)).toContain('package-bundled-twice');
    });

    test('a package cannot give its ontology a namespace or a version: only the header can', async () => {
        const root = workspace({
            'shop.tonto': '/// @version 1\n' + manifest('shop'),
            'core.tonto': '/// @namespace https://example.org/elsewhere#\n/// @version 2\npackage core in shop\nkind Person'
        });
        const codes = (await new OntologySession({ workspace: root }).validateFiles([root])).map(diag => diag.code);
        expect(codes.filter(code => code === 'ontology-tag-not-on-header')).toHaveLength(2);
        const exported = await new OntologySession({ workspace: root }).gufoFiles([join(root, 'shop.tonto')]);
        expect(exported.turtle).toContain('<https://example.org/shop> a owl:Ontology');
        expect(exported.turtle).toContain('owl:versionInfo "1"');
    });

    test('incremental unreferenced clashes appear and disappear', async () => {
        const root = workspace({ 'a.tonto': 'package a in model\nkind Person', 'b.tonto': 'package b in model\nkind Car' });
        const session = new OntologySession({ workspace: root });
        expect(errors(await session.validateFiles([join(root, 'a.tonto')]))).toEqual([]);
        put(root, 'b.tonto', 'package b in model\nkind Person');
        expect((await session.validateFiles([join(root, 'a.tonto')])).map(diag => diag.code)).toContain('namespace-name-clash');
        put(root, 'b.tonto', 'package b in model\nkind Car');
        expect(errors(await session.validateFiles([join(root, 'a.tonto')]))).toEqual([]);
    });

    test('without tonto.json, use does not join two implicit ontologies', async () => {
        const root = workspace({ 'a.tonto': 'package a\nkind Person', 'b.tonto': 'package b\nkind Person' });
        const session = new OntologySession({ workspace: root });
        expect(errors(await session.validateFiles([root]))).toEqual([]);
        put(root, 'shared.tonto', 'package shared\nkind Thing');
        put(root, 'a.tonto', 'package a\nuse shared\nkind Person');
        put(root, 'b.tonto', 'package b\nuse shared\nkind Person');
        const clashes = errors(await session.validateFiles([join(root, 'a.tonto')]));
        expect(clashes.some(error => error.startsWith('namespace-name-clash'))).toBe(false);
        expect(clashes.some(error => error.startsWith('cross-ontology-package-use'))).toBe(true);
        put(root, 'b.tonto', 'package b\nkind Person');
        expect(errors(await session.validateFiles([join(root, 'a.tonto')])).some(error => error.startsWith('namespace-name-clash'))).toBe(false);
    });

    test('without tonto.json, a reference into another ontology does not offer use', async () => {
        const root = workspace({ 'a.tonto': 'package a\nsubkind Student specializes Person', 'b.tonto': 'package b\nkind Person' });
        const [missing] = (await new OntologySession({ workspace: root }).validateFiles([join(root, 'a.tonto')]))
            .filter(diag => diag.severity === 'error');
        expect(missing.code).toBe('linking-error');
        expect(missing.fixes.map(fix => fix.title)).not.toContain('Use "b"');
    });

    test('a draft ontology never spans the roots of a multi-root workspace', async () => {
        const files = new VirtualFileSystemProvider();
        files.insert(URI.file('/one/a.tonto'), 'package a in model\nuse b\nkind Person\n');
        files.insert(URI.file('/two/b.tonto'), 'package b in model\nkind Person\n');
        const services = createTontoServices({ fileSystemProvider: () => files });
        const workspace = services.shared.workspace;
        await workspace.WorkspaceManager.initializeWorkspace([
            { name: 'one', uri: URI.file('/one').toString() }, { name: 'two', uri: URI.file('/two').toString() }]);
        await workspace.DocumentBuilder.build(workspace.LangiumDocuments.all.toArray(), { validation: true });
        const codes = workspace.LangiumDocuments.all.toArray().filter(doc => doc.uri.scheme === 'file')
            .flatMap(doc => (doc.diagnostics ?? []).filter(diag => diag.severity === 1).map(diag => diag.code));
        // Only the cross-root import fails to resolve; the two Persons never clash.
        expect(codes).not.toContain('namespace-name-clash');
        expect(codes).toHaveLength(1);
    });

    test('an editor update reaches unchanged peers, whether or not ownership changes', async () => {
        const files = new VirtualFileSystemProvider();
        const a = URI.file('/m/a.tonto'), b = URI.file('/m/b.tonto');
        files.insert(URI.file('/m/shared.tonto'), 'package shared\nkind Thing\n');
        files.insert(a, 'package a\nuse shared\nkind Person\n');
        files.insert(b, 'package b\nkind Car\n');
        const services = createTontoServices({ fileSystemProvider: () => files });
        const workspace = services.shared.workspace;
        workspace.DocumentBuilder.updateBuildOptions = { validation: true };
        await workspace.WorkspaceManager.initializeWorkspace([{ name: 'm', uri: URI.file('/m').toString() }]);
        await workspace.DocumentBuilder.build(workspace.LangiumDocuments.all.toArray(), { validation: true });
        const clashesIn = (uri: URI): string[] => (workspace.LangiumDocuments.getDocument(uri)!.diagnostics ?? [])
            .map(diag => String(diag.code)).filter(code => code === 'namespace-name-clash');
        const edit = async (text: string): Promise<void> => {
            files.insert(b, text);
            await workspace.DocumentBuilder.update([b], []);
        };
        // An unrelated use does not change either package's owner.
        await edit('package b\nuse shared\nkind Person\n');
        expect(clashesIn(a)).toEqual([]);
        await edit('package b\nuse shared\nkind Car\n');
        expect(clashesIn(a)).toEqual([]);
        await edit('package b\nuse shared\nkind Person\n');
        expect(clashesIn(a)).toEqual([]);
        await edit('package b\nkind Person\n');
        expect(clashesIn(a)).toEqual([]);
    });

    test('discovery takes the nearest tonto.json over the highest folder of models', () => {
        const root = workspace({ 'tonto.json': '{}', 'src/a.tonto': 'package a\nkind Person', 'loose.tonto': 'package loose' });
        expect(workspaceRootOf(join(root, 'src/a.tonto'))).toBe(root);
    });

    test('a malformed tonto.json is a diagnostic, not a crash, and keeps its valid mappings', async () => {
        const broken = workspace({ 'tonto.json': '{ "locations": { } , }', 'a.tonto': 'package a\nkind Person' });
        const reported = await new OntologySession({ workspace: broken }).validateFiles([broken]);
        expect(reported.map(diag => diag.code)).toEqual(['publication-configuration']);
        expect(reported[0].message).toMatch(/^tonto\.json cannot be read: /);

        const partly = workspace({
            'tonto.json': JSON.stringify({ locations: { 'example.org/x': 'x.tonto', 'https://example.org/people.tonto': 'people.tonto' } }),
            'people.tonto': '/// @namespace https://example.org/people#\nontology people\nkind Person',
            'client.tonto': 'package client\nimport people from <https://example.org/people.tonto>\nsubkind Visitor specializes people.Person'
        });
        const codes = errors(await new OntologySession({ workspace: partly }).validateFiles([join(partly, 'client.tonto')]));
        expect(codes).toEqual(['publication-configuration: tonto.json: mapping key "example.org/x" is not an absolute HTTP(S) URL; it is ignored.']);
    });

    test('a mapping to a missing file names the mapping', async () => {
        const root = workspace({
            'tonto.json': JSON.stringify({ locations: { 'https://example.org/people.tonto': 'gone.tonto' } }),
            'client.tonto': 'package client\nimport people from <https://example.org/people.tonto>\nkind Visitor'
        });
        const [problem] = errors(await new OntologySession({ workspace: root }).validateFiles([root]));
        expect(problem).toMatch(/^publication-location: Location <https:\/\/example\.org\/people\.tonto> is mapped to .*gone\.tonto, which cannot be read\./);
    });

    test('an uncached dependency is reported once, and the importer is not checked as though it were absent', async () => {
        const root = workspace({
            'shop.tonto': manifest('shop'),
            'core.tonto': 'package core\nimport people from <https://example.org/people.tonto>\nsubkind Visitor specializes people.Person'
        });
        const reported = errors(await new OntologySession({ workspace: root }).validateFiles([root]));
        expect(reported).toHaveLength(1);
        expect(reported[0]).toMatch(/^publication-location: Document <https:\/\/example\.org\/people\.tonto> is not cached\. Run tonto fetch\. Until it loads/);
    });

    test.each([
        ['missing file', undefined, 'publication-location'],
        ['missing package', 'package other in elsewhere', 'ontology-bundle']
    ])('a bundle with a %s suspends semantic checks until its evidence loads', async (_reason, source, code) => {
        const root = workspace({
            'shop.tonto': manifest('shop', 'core from <core.tonto>\n    links from <links.tonto>'),
            'core.tonto': 'package core in shop\nkind Person\nkind Organization\nrelator Employment'
        });
        if (source !== undefined) put(root, 'links.tonto', source);
        const session = new OntologySession({ workspace: root });
        const before = await session.validateFiles([root]);
        expect(errors(before).map(error => error.split(':')[0])).toEqual([code]);

        put(root, 'links.tonto', 'package links in shop\nuse core\n'
            + '@mediation relation core.Employment [*] -- [1] (const) core.Person\n'
            + '@mediation relation core.Employment [*] -- [1] (const) core.Organization');
        expect(errors(await session.validateFiles([root]))).toEqual([]);
    });

    test('a use across an ownership boundary says which ontology owns the package', async () => {
        const root = workspace({
            'shop.tonto': manifest('shop'),
            'core.tonto': 'package core\nkind Person',
            'drafts/client.tonto': 'package client\nuse core\nkind Visitor'
        });
        const [crossing] = (await new OntologySession({ workspace: root }).validateFiles([join(root, 'drafts/client.tonto')]))
            .filter(diag => diag.severity === 'error');
        expect(crossing.code).toBe('cross-ontology-package-use');
        expect(crossing.message).toBe('Package "core" belongs to ontology "shop", which a "use" cannot reach. '
            + 'Import the ontology by location, as in `import shop from <../shop.tonto>`, and qualify its names with `shop.`.');
        expect(crossing.fixes).toEqual([]);
    });

    test('location mappings may supply a URL import without network access', async () => {
        const root = workspace({
            'tonto.json': JSON.stringify({ locations: { 'https://example.org/people.tonto': 'people.tonto' } }),
            'people.tonto': '/// @namespace https://example.org/people#\nontology people\nkind Person',
            'client.tonto': 'package client\nimport people from <https://example.org/people.tonto>\nsubkind Visitor specializes people.Person'
        });
        const network = serve({});
        expect(errors(await new OntologySession({ workspace: root }).validateFiles([root]))).toEqual([]);
        expect(network).not.toHaveBeenCalled();
    });

    test('a folder holding a tonto.json inside the open one is a workspace of its own', async () => {
        const root = workspace({
            'sub/tonto.json': JSON.stringify({ locations: { 'https://example.org/people.tonto': 'people.tonto' } }),
            'sub/people.tonto': '/// @namespace https://example.org/people#\nontology people\nkind Person',
            'sub/client.tonto': 'ontology client\nimport people from <https://example.org/people.tonto>\nsubkind Visitor specializes people.Person',
            'outside.tonto': 'ontology outside\nimport people from <https://example.org/people.tonto>\nsubkind Guest specializes people.Person',
            'shop.tonto': 'ontology shop\nkind Product',
            'sub/shop.tonto': 'ontology shop\nkind Offer'
        });
        const network = serve({});
        const reported = await new OntologySession({ workspace: root }).validateFiles([root]);
        const at = (file: string) => reported.filter(diag => diag.file === join(root, file) && diag.severity === 'error').map(diag => diag.code);
        // Its mappings apply to its own files, as the command line run there would apply them, and not beside it.
        expect(at('sub/client.tonto')).toEqual([]);
        expect(at('outside.tonto')).toContain('publication-location');
        // And its ontology names need only differ from each other.
        expect(reported.map(diag => diag.code)).not.toContain('ontology-name-clash');
        expect(network).not.toHaveBeenCalled();
    });

    test('manifest documentation, not package prose, supplies the exported header', async () => {
        const root = workspace({
            'shop.tonto': '/// A vocabulary of people.\n/// @label Shop\n/// @version 1.2.0\n' + manifest('shop'),
            'core.tonto': '/// Internal implementation details.\n/// @label Core\npackage core\nkind Person'
        });
        const result = await new OntologySession({ workspace: root }).gufoFiles([join(root, 'shop.tonto')]);
        expect(result.diagnostics.filter(diag => diag.severity === 'error')).toEqual([]);
        expect(result.turtle).toContain('rdfs:label "Shop"');
        expect(result.turtle).toContain('owl:versionInfo "1.2.0"');
        expect(result.turtle).not.toContain('Internal implementation details');
    });

    test('a complete selected root can publish without absorbing a draft sibling in the same source', async () => {
        const root = workspace({ 'shop.tonto': manifest('shop'), 'core.tonto': 'package core in shop\nkind Person\npackage draft in returns\nkind Bicycle' });
        const session = new OntologySession({ workspace: root, publication: true });
        const result = await session.gufoFiles([join(root, 'shop.tonto')]);
        expect(result.publicationVerified).toBe(true);
        expect(result.turtle).toContain('shop:Person');
        expect(result.turtle).not.toContain('Bicycle');
        expect((await session.validateFiles([root])).map(diag => diag.code)).toContain('ontology-file-missing');
    });

    test('an explicit namespace override can publish a simple ontology', async () => {
        const result = await new OntologySession({ publication: true }).gufoText('ontology people\nkind Person', { namespaceIri: 'https://example.org/people#' });
        expect(result.diagnostics.filter(diag => diag.severity === 'error')).toEqual([]);
        expect(result.publicationVerified).toBe(true);
    });

    test('an ontology with no declarations still exports its header', async () => {
        const preview = await new OntologySession().gufoText('ontology example');
        expect(preview.files.map(file => file.file)).toEqual(['example.ttl']);
        expect(preview.turtle).toContain('<https://example.org/example> a owl:Ontology');
        expect(preview.diagnostics.map(diag => diag.code)).toContain('gufo-placeholder-namespace');

        const root = workspace({ 'example.tonto': '/// @namespace https://example.org/example#\n/// @label Example\nontology example\n' });
        const published = await new OntologySession({ workspace: root, publication: true }).gufoFiles([join(root, 'example.tonto')]);
        expect(published.publicationVerified).toBe(true);
        expect(published.files.map(file => file.file)).toEqual(['example.ttl']);
        expect(published.turtle).toContain('<https://example.org/example> a owl:Ontology');
        expect(published.turtle).toContain('rdfs:label "Example"');
    });

    test('an unannotated ontology file is the location offered for persisting an export namespace', async () => {
        const root = workspace({ 'shop.tonto': 'ontology shop bundles core from <core.tonto>', 'core.tonto': 'package core\nkind Person' });
        const session = new OntologySession({ workspace: root });
        const preview = await session.gufoFiles([join(root, 'shop.tonto')]);
        expect(preview.diagnostics.find(diag => diag.code === 'gufo-placeholder-namespace')?.file).toBe(join(root, 'shop.tonto'));
        const supplied = await session.gufoFiles([join(root, 'shop.tonto')], { namespaceIri: 'https://example.org/shop#' });
        expect(supplied.diagnostics.filter(diag => diag.severity === 'error')).toEqual([]);
        expect(supplied.turtle).toContain('<https://example.org/shop> a owl:Ontology');
    });

    test('relative imports in draft text resolve from its configured workspace', async () => {
        const root = workspace({ 'people.tonto': '/// @namespace https://example.org/people#\nontology people\nkind Person' });
        const result = await new OntologySession({ workspace: root }).validateText('package clients\nimport people from <people.tonto>\nsubkind Visitor specializes people.Person');
        expect(errors(result)).toEqual([]);
    });

    test('publication rejects slash namespaces, uppercase names and unbundled packages', async () => {
        const files = { 'shop.tonto': manifest('Shop', undefined, 'https://example.org/shop/'), 'core.tonto': 'package core\nkind Person', 'returns.tonto': 'package returns in refunds\nkind Bicycle' };
        const root = workspace(files);
        const published = await new OntologySession({ workspace: root, publication: true }).validateFiles([root]);
        const codes = published.map(diag => diag.code);
        expect(codes).toContain('ontology-name-case');
        expect(codes).toContain('publication-namespace');
        expect(published.find(diag => diag.code === 'ontology-file-missing')?.severity).toBe('error');
        const editing = await new OntologySession({ workspace: root }).validateFiles([root]);
        expect(editing.find(diag => diag.code === 'ontology-file-missing')?.severity).toBe('warning');
    });
});

describe('explicit retrieval and unmapped publication', () => {
    test('a repeated fetch reads edited location mappings', async () => {
        const requested = 'https://example.org/people.tonto';
        const first = 'https://example.org/one.tonto';
        const second = 'https://example.org/two.tonto';
        const config = (target: string): string => JSON.stringify({ locations: { [requested]: target } });
        const root = workspace({
            'tonto.json': config(first),
            'client.tonto': `package client\nimport people from <${requested}>`
        });
        const network = serve({
            [first]: '/// @namespace https://example.org/people#\nontology people\nkind Person',
            [second]: '/// @namespace https://example.org/people#\nontology people\nkind Human'
        });
        const session = new OntologySession({ workspace: root });
        await session.fetch([root]);
        put(root, 'tonto.json', config(second));
        network.mockClear();
        await session.fetch([root], { refresh: true });
        expect(network.mock.calls.map(call => call[0])).toEqual([second]);
        expect(errors(await session.validateFiles([root]))).toEqual([]);
    });

    test('a partial fetch preserves dependencies cached by another session', async () => {
        const first = 'https://example.org/people.tonto';
        const second = 'https://example.org/places.tonto';
        const root = workspace({
            'a.tonto': `package a\nimport people from <${first}>`,
            'b.tonto': `package b\nimport places from <${second}>`
        });
        const network = serve({
            [first]: '/// @namespace https://example.org/people#\nontology people\nkind Person',
            [second]: '/// @namespace https://example.org/places#\npackage core\nkind Place'
        });
        const session = new OntologySession({ workspace: root });
        await session.fetch([join(root, 'a.tonto')]);
        await new OntologySession({ workspace: root }).fetch([join(root, 'b.tonto')]);
        await session.fetch([join(root, 'a.tonto')]);
        network.mockClear();
        expect(errors(await new OntologySession({ workspace: root }).validateFiles([root]))).toEqual([]);
        expect(network).not.toHaveBeenCalled();
    });

    test('refresh keeps aliases of one mapped document on the same revision regardless of import order', async () => {
        const first = 'https://example.org/first.tonto';
        const second = 'https://example.org/second.tonto';
        const mapped = 'https://cdn.example.org/people.tonto';
        const client = (aliases: string[]): string => 'ontology client\n' + aliases
            .map((url, index) => `import people${index} from <${url}>`).join('\n');
        const root = workspace({
            'tonto.json': JSON.stringify({ locations: { [first]: mapped, [second]: mapped } }),
            'client.tonto': client([first, second])
        });
        const files = { [mapped]: '/// @namespace https://example.org/people#\nontology people\nkind Person' };
        const network = serve(files);
        const session = new OntologySession({ workspace: root });
        await session.fetch([root]);
        put(root, 'client.tonto', client([second, first]));
        files[mapped] = '/// @namespace https://example.org/people#\nontology people\nkind Human';
        network.mockClear();
        await session.fetch([root], { refresh: true });
        expect(network).toHaveBeenCalledTimes(1);
        const snapshot = JSON.parse(readFileSync(join(root, '.tonto/development.json'), 'utf8'));
        expect(snapshot.entries[first].source).toBe(files[mapped]);
        expect(snapshot.entries[second].source).toBe(files[mapped]);
        put(root, 'client.tonto', client([first, second]) + '\nsubkind Visitor specializes people0.Human');
        network.mockClear();
        expect(errors(await new OntologySession({ workspace: root }).validateFiles([root]))).toEqual([]);
        expect(network).not.toHaveBeenCalled();
    });

    test('a cache refreshed by another session updates redirect bases even when the entry text is unchanged', async () => {
        const entry = 'https://example.org/people.tonto';
        const root = workspace({ 'client.tonto': `package client\nimport people from <${entry}>` });
        let release = 'one';
        const network = serve({});
        network.mockImplementation(async (url: string) => {
            const response = new Response(url === entry ? manifest('people') : 'package core\nkind Person');
            Object.defineProperty(response, 'url', { value: url === entry ? `https://cdn.example.org/${release}/people.tonto` : url });
            return response;
        });
        const session = new OntologySession({ workspace: root });
        await session.fetch([root]);
        expect(errors(await session.validateFiles([root]))).toEqual([]);
        release = 'two';
        await new OntologySession({ workspace: root }).fetch([root], { refresh: true });
        network.mockClear();
        expect(errors(await session.validateFiles([root]))).toEqual([]);
        expect(network).not.toHaveBeenCalled();
    });

    test('prefix mappings use the longest match, and API mappings override configured exact keys', async () => {
        const root = workspace({
            'tonto.json': JSON.stringify({ locations: { 'https://example.org/': 'wrong/', 'https://example.org/people/': 'models/' } }),
            'models/people.tonto': '/// @namespace https://example.org/people#\nontology people\nkind Person',
            'client.tonto': 'package client\nimport people from <https://example.org/people/people.tonto>\nsubkind Visitor specializes people.Person'
        });
        const network = serve({});
        expect(errors(await new OntologySession({ workspace: root }).validateFiles([root]))).toEqual([]);
        const overrides = { 'https://example.org/people/': 'missing/' };
        expect((await new OntologySession({ workspace: root, locations: overrides }).validateFiles([root])).map(diag => diag.code)).toContain('publication-location');
        expect(network).not.toHaveBeenCalled();
    });

    test('ordinary checks stay offline; explicit fetch caches the complete closure', async () => {
        const root = workspace({ 'client.tonto': 'package client\nimport people from <https://example.org/people.tonto>\nsubkind Visitor specializes people.Person' });
        const network = serve({ 'https://example.org/people.tonto': manifest('people', 'core from <data/core.tonto>'), 'https://example.org/data/core.tonto': 'package core\nkind Person' });
        const session = new OntologySession({ workspace: root });
        expect((await session.validateFiles([root])).map(diag => diag.code)).toContain('publication-location');
        expect(network).not.toHaveBeenCalled();
        expect((await session.fetch([root])).retrieved).toHaveLength(2);
        network.mockClear();
        expect(errors(await new OntologySession({ workspace: root }).validateFiles([root]))).toEqual([]);
        expect(network).not.toHaveBeenCalled();
    });

    test('bundle retrieval ignores ontology imports in unselected packages', async () => {
        const root = workspace({ 'client.tonto': 'package client\nimport people from <https://example.org/people.tonto>' });
        const network = serve({
            'https://example.org/people.tonto': manifest('people'),
            'https://example.org/core.tonto': 'package core\nkind Person\npackage hidden\nimport missing from <https://example.org/missing.tonto>\nkind Bicycle'
        });
        const session = new OntologySession({ workspace: root });
        await session.fetch([root]);
        expect(network.mock.calls.map(call => call[0])).not.toContain('https://example.org/missing.tonto');
        expect(errors(await session.validateFiles([root]))).toEqual([]);
    });

    test('relative package locations use the effective redirect URL', async () => {
        const root = workspace({ 'client.tonto': 'package client\nimport people from <https://example.org/people.tonto>\nsubkind Visitor specializes people.Person' });
        const network = serve({ 'https://cdn.example.org/releases/core.tonto': 'package core\nkind Person' });
        network.mockImplementation(async (url: string) => {
            const redirected = url === 'https://example.org/people.tonto';
            const response = new Response(redirected ? manifest('people') : 'package core\nkind Person');
            Object.defineProperty(response, 'url', { value: redirected ? 'https://cdn.example.org/releases/people.tonto' : url });
            return response;
        });
        const session = new OntologySession({ workspace: root });
        await session.fetch([root]);
        expect(network.mock.calls.map(call => call[0])).toContain('https://cdn.example.org/releases/core.tonto');
        expect(errors(await session.validateFiles([root]))).toEqual([]);
    });

    test('remote sources cannot introduce direct file dependencies', async () => {
        const root = workspace({ 'client.tonto': 'package client\nimport people from <https://example.org/people.tonto>' });
        serve({ 'https://example.org/people.tonto': manifest('people', 'core from <file:///private/secrets.tonto>') });
        await expect(new OntologySession({ workspace: root }).fetch([root])).rejects.toThrow('must use a relative source path');
    });

    test('cached remote sources are read-only, including repairs and rename', async () => {
        const root = workspace({ 'client.tonto': 'package client\nimport people from <https://example.org/people.tonto>' });
        serve({ 'https://example.org/people.tonto': '/// @namespace https://example.org/people#\nontology people\npackage Core\nkind Person' });
        const session = new OntologySession({ workspace: root });
        await session.fetch([root]);
        const report = await session.validateFiles([root]);
        const diagnostic = report.find(diag => diag.code === 'package-name-case')!;
        expect(diagnostic.severity).toBe('error');
        expect(diagnostic.file).toBe('https://example.org/people.tonto');
        expect(diagnostic.fixes).toEqual([]);
    });

    test('refresh invalidates loaded sources in an already-open session', async () => {
        const root = workspace({ 'client.tonto': 'package client\nimport people from <https://example.org/people.tonto>\nsubkind Visitor specializes people.Person' });
        const files = { 'https://example.org/people.tonto': '/// @namespace https://example.org/people#\nontology people\nkind Person' };
        serve(files);
        const session = new OntologySession({ workspace: root });
        await session.fetch([root]);
        expect(errors(await session.validateFiles([root]))).toEqual([]);
        files['https://example.org/people.tonto'] = '/// @namespace https://example.org/people#\nontology people\nkind Human';
        await session.fetch([root], { refresh: true });
        expect(errors(await session.validateFiles([root])).some(message => message.includes('Person'))).toBe(true);
    });

    test('refresh reports new, changed and no-longer-needed documents and drops the last', async () => {
        const root = workspace({
            'client.tonto': 'package client\nimport people from <https://example.org/people.tonto>',
            'other.tonto': 'package other\nimport places from <https://example.org/places.tonto>'
        });
        const files: Record<string, string> = {
            'https://example.org/people.tonto': '/// @namespace https://example.org/people#\nontology people\nkind Person',
            'https://example.org/places.tonto': '/// @namespace https://example.org/places#\npackage core\nkind Place'
        };
        serve(files);
        const session = new OntologySession({ workspace: root });
        const first = await session.fetch([root]);
        expect(first.added).toEqual(['https://example.org/people.tonto', 'https://example.org/places.tonto']);
        files['https://example.org/people.tonto'] += '\nkind Human';
        put(root, 'other.tonto', 'package other');
        // A fetch of one file cannot know what the rest of the workspace needs.
        expect(await session.fetch([join(root, 'client.tonto')], { refresh: true }))
            .toMatchObject({ changed: ['https://example.org/people.tonto'], removed: [] });
        const refreshed = await session.fetch([root], { refresh: true });
        expect(refreshed).toMatchObject({ added: [], changed: [], removed: ['https://example.org/places.tonto'] });
        expect(Object.keys(JSON.parse(readFileSync(join(root, '.tonto/development.json'), 'utf8')).entries))
            .toEqual(['https://example.org/people.tonto']);
        files['https://example.org/people.tonto'] += '\nkind Robot';
        const changed = await session.fetch([root], { refresh: true });
        expect(changed.changed).toEqual(['https://example.org/people.tonto']);
        expect(fetchSummary(changed)).toBe('Retrieved 1 document(s) (1 changed); reused 0 cached document(s).\n  changed  https://example.org/people.tonto');
    });

    test('two cached releases of one namespace are a conflict', async () => {
        const root = workspace({ 'client.tonto': 'package client\nimport old from <https://example.org/v1.tonto>\nimport current from <https://example.org/v2.tonto>' });
        serve({
            'https://example.org/v1.tonto': '/// @namespace https://example.org/people#\nontology people\nkind Person',
            'https://example.org/v2.tonto': '/// @namespace https://example.org/people#\nontology people\nkind Human'
        });
        const session = new OntologySession({ workspace: root });
        await session.fetch([root]);
        expect((await session.validateFiles([root])).map(diag => diag.code)).toContain('ontology-namespace-conflict');
    });

    test('refresh is all-or-nothing and persists provenance and content digests', async () => {
        const root = workspace({ 'client.tonto': 'package client\nimport people from <https://example.org/people.tonto>' });
        const files = { 'https://example.org/people.tonto': '/// @namespace https://example.org/people#\nontology people\nkind Person' };
        serve(files);
        const session = new OntologySession({ workspace: root });
        await session.fetch([root]);
        const previous = readFileSync(join(root, '.tonto/development.json'), 'utf8');
        expect(previous).toContain('sha256');
        expect(previous).toContain('retrieved');
        files['https://example.org/people.tonto'] = manifest('people', 'core from <missing.tonto>');
        await expect(session.fetch([root], { refresh: true })).rejects.toThrow('HTTP 404');
        expect(readFileSync(join(root, '.tonto/development.json'), 'utf8')).toBe(previous);
    });

    test('a mapped newer release cannot certify publication of references absent from the original', async () => {
        const root = workspace({
            'tonto.json': JSON.stringify({ locations: { 'https://example.org/v1.tonto': 'https://example.org/v2.tonto' } }),
            'client.tonto': '/// @namespace https://example.org/client#\npackage client\nimport people from <https://example.org/v1.tonto>\nsubkind Visitor specializes people.NewPerson'
        });
        const network = serve({
            'https://example.org/v1.tonto': '/// @namespace https://example.org/people#\nontology people\nkind Person',
            'https://example.org/v2.tonto': '/// @namespace https://example.org/people#\nontology people\nkind NewPerson'
        });
        const development = new OntologySession({ workspace: root });
        await development.fetch([root]);
        expect(errors(await new OntologySession({ workspace: root }).validateFiles([root]))).toEqual([]);
        const publication = new OntologySession({ workspace: root, publication: true });
        expect((await publication.validateFiles([root])).map(diag => diag.code)).toContain('publication-location');
        await publication.fetch([root]);
        network.mockClear();
        const result = await new OntologySession({ workspace: root, publication: true }).validateFiles([root]);
        expect(errors(result).some(message => message.includes('NewPerson'))).toBe(true);
        expect(network).not.toHaveBeenCalled();
    });
});
