import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { fetchSummary } from 'tonto-language';
import type { FetchResult } from 'tonto-language';

/** Network access is always a named user action, never an editor side effect. */
export function registerPublication(context: vscode.ExtensionContext, client: LanguageClient): void {
    const changed = new vscode.EventEmitter<vscode.Uri>();
    context.subscriptions.push(changed, vscode.workspace.registerTextDocumentContentProvider('tonto-cache', {
        onDidChange: changed.event,
        provideTextDocumentContent: uri => client.sendRequest<string>('tonto/cachedSource', { uri: decodeURIComponent(uri.query) })
    }));
    const configuration = vscode.workspace.createFileSystemWatcher('**/tonto.json');
    const cache = vscode.workspace.createFileSystemWatcher('**/.tonto/{development,publication}.json');
    context.subscriptions.push(configuration, cache);
    for (const watcher of [configuration, cache]) for (const event of [watcher.onDidChange, watcher.onDidCreate, watcher.onDidDelete]) {
        context.subscriptions.push(event(() => { void client.sendRequest('tonto/reloadPublication').catch(() => undefined); }));
    }
    for (const [command, refresh, publication] of [
        ['tonto.fetchOntologies', false, false],
        ['tonto.refreshOntologies', true, false],
        ['tonto.fetchPublication', false, true],
        ['tonto.refreshPublication', true, true]
    ] as const) {
        context.subscriptions.push(vscode.commands.registerCommand(command, async () => {
            const document = vscode.window.activeTextEditor?.document;
            if (!document || document.languageId !== 'tonto' || document.uri.scheme !== 'file') {
                void vscode.window.showErrorMessage('Open a saved tonto ontology file first.');
                return;
            }
            if (document.isDirty && !await document.save()) return;
            try {
                const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
                    title: publication ? 'Fetching original ontology imports' : 'Fetching ontology dependencies' },
                () => client.sendRequest<FetchResult>('tonto/fetch', {
                    paths: [document.uri.fsPath], refresh, publication
                }));
                void vscode.window.showInformationMessage(fetchSummary(result).split('\n')[0]);
                vscode.workspace.textDocuments.filter(doc => doc.uri.scheme === 'tonto-cache').forEach(doc => changed.fire(doc.uri));
            } catch (error) {
                void vscode.window.showErrorMessage(`Ontology retrieval failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }));
    }
}
