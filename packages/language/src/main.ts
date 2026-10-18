import { startLanguageServer } from 'langium/lsp';
import { NodeFileSystem } from 'langium/node';
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { createTontoServices } from './tonto-module.js';
import { publicationWorkspace } from './publication/workspace.js';
import { URI } from 'langium';
import { authoredOntologies, newPackageEdit } from './lsp/ontology-actions.js';

const connection = createConnection(ProposedFeatures.all);

const { shared } = createTontoServices({ connection, ...NodeFileSystem });

connection.onRequest('tonto/fetch', async (params: { paths: string[]; refresh?: boolean; publication?: boolean }) => {
    let result: { retrieved: string[]; cached: string[] } | undefined;
    await shared.workspace.WorkspaceLock.write(async () => {
        const folders = shared.workspace.WorkspaceManager.workspaceFolders ?? [];
        const roots = folders.map(folder => URI.parse(folder.uri).fsPath);
        const publication = publicationWorkspace(shared);
        publication.configure(roots, { publication: params.publication });
        try { result = await publication.fetch(params.paths, params.refresh); }
        finally {
            publication.configure(roots, { publication: false });
            await shared.workspace.DocumentBuilder.build(shared.workspace.LangiumDocuments.all.toArray(), { validation: true });
        }
    });
    return result;
});

connection.onRequest('tonto/reloadPublication', async () => {
    await shared.workspace.WorkspaceLock.write(async () => {
        await shared.workspace.DocumentBuilder.build(shared.workspace.LangiumDocuments.all.toArray(), { validation: true });
    });
});

connection.onRequest('tonto/cachedSource', (params: { uri: string }) => shared.workspace.WorkspaceLock.read(() => {
    const source = shared.workspace.LangiumDocuments.getDocument(URI.parse(params.uri));
    if (!source || !/^https?:/.test(params.uri)) throw new Error('This remote source is not loaded in the offline cache.');
    return source.textDocument.getText();
}));

// The ontologies a package can be added to, for the editor's New Package... command.
connection.onRequest('tonto/ontologies', () => shared.workspace.WorkspaceLock.read(() =>
    authoredOntologies(publicationWorkspace(shared))));

// The edit New Package... applies: the package file and its bundle entry, the
// ontology split first when it is one file. The editor applies it, so it can be undone.
connection.onRequest('tonto/newPackage', (params: { ontology: string; name: string; folder: string }) =>
    shared.workspace.WorkspaceLock.read(() => {
        const documents = shared.workspace.LangiumDocuments;
        const document = documents.getDocument(URI.parse(params.ontology));
        if (!document) return { problem: 'That ontology file is not loaded.' };
        return newPackageEdit(document, params.name, params.folder, publicationWorkspace(shared), uri => documents.hasDocument(uri));
    }));

startLanguageServer(shared);
