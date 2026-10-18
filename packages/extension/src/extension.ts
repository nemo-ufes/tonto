import * as path from 'node:path';
import type { ExtensionContext } from 'vscode';
import * as vscode from 'vscode';
import type { LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';
import { DidChangeConfigurationNotification, LanguageClient, TransportKind } from 'vscode-languageclient/node';
import { registerGufoExport } from './gufo-export.js';
import { registerLanguageModelTools } from './language-model-tools.js';
import { registerNewPackage } from './new-package.js';
import { registerOnboarding } from './onboarding.js';
import { registerPatternInsertion } from './pattern-insertion.js';
import { registerPublication } from './publication.js';

let client: LanguageClient | undefined;

export function activate(context: ExtensionContext): void {
    registerOnboarding(context, () => client);
    registerNewPackage(context, () => client);
    registerGufoExport(context);
    registerPatternInsertion(context);
    registerLanguageModelTools(context);
    client = startLanguageClient(context);
    registerPublication(context, client);
}

export async function deactivate(): Promise<void> {
    if (client) {
        await client.stop();
    }
}

function startLanguageClient(context: ExtensionContext): LanguageClient {
    const serverModule = context.asAbsolutePath(path.join('out', 'language-server.cjs'));
    // The debug options are only used when the extension is run from the
    // Extension Development Host (F5), so `--inspect` doesn't collide with
    // anything when the extension is installed normally.
    const debugOptions = { execArgv: ['--nolazy', `--inspect=${6009}`] };

    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'tonto' }],
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher('**/*.tonto')
        }
    };

    const client = new LanguageClient('tonto', 'tonto', serverOptions, clientOptions);
    client.start();

    // The server fetches the configuration itself when it initializes, but a
    // later change never reaches it: the client's own didChangeConfiguration
    // carries `settings: null`, which Langium's provider ignores. So the
    // settings are pushed whenever they change, which is what makes toggling
    // `tonto.antiPatterns` re-validate the open documents.
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('tonto')) {
            void client.sendNotification(DidChangeConfigurationNotification.type, { settings: settings() });
        }
    }));
    return client;
}

/** The `tonto` section as plain data, which is what the notification carries. */
function settings(): { tonto: Record<string, unknown> } {
    const configuration = vscode.workspace.getConfiguration('tonto');
    return { tonto: { antiPatterns: configuration.get<boolean>('antiPatterns') ?? false } };
}
