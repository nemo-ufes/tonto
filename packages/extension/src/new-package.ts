import * as path from 'node:path';
import type { ExtensionContext, Uri } from 'vscode';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import type { WorkspaceEdit } from 'vscode-languageclient/node';

/** An ontology a package can be added to, as the language server lists it. */
interface AuthoredOntology {
    name: string;
    uri: string;
    oneFile: boolean;
}

type NewPackage = { edit: WorkspaceEdit; uri: string; split?: string } | { problem: string };

/**
 * New Package...: a package of one of the workspace's ontologies, as the two
 * statements its membership takes -- a package file starting `package sales
 * in shop`, and the ontology file's bundle entry for it -- written together.
 * The language server computes the edit (and splits a one-file ontology
 * first); here are only the questions and the applying.
 *
 * Asked about a folder in the Explorer, the package file goes there; about
 * an ontology file in the editor, the package joins that ontology.
 */
export function registerNewPackage(context: ExtensionContext, client: () => LanguageClient | undefined): void {
    context.subscriptions.push(vscode.commands.registerCommand('tonto.newPackage', (resource?: Uri) => newPackage(client(), resource)));
}

async function newPackage(client: LanguageClient | undefined, resource?: Uri): Promise<void> {
    if (!client) {
        void vscode.window.showErrorMessage('The tonto language server is not running.');
        return;
    }
    const listed = await client.sendRequest<AuthoredOntology[]>('tonto/ontologies');
    if (listed.length === 0) {
        const answer = await vscode.window.showInformationMessage(
            'This workspace has no ontology yet, and a package belongs to one. Create an ontology first?', 'New Ontology...');
        if (answer) await vscode.commands.executeCommand('tonto.newOntology');
        return;
    }
    const isFolder = resource ? (await vscode.workspace.fs.stat(resource)).type === vscode.FileType.Directory : false;
    const ontology = (!isFolder && resource ? listed.find(one => one.uri === resource.toString()) : undefined)
        ?? (listed.length === 1 ? listed[0] : await pickOntology(listed));
    if (!ontology) return;

    const name = await vscode.window.showInputBox({
        title: `New package in ontology "${ontology.name}"`,
        prompt: 'Name of the package',
        ignoreFocusOut: true,
        validateInput: value => /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(value)
            ? undefined : 'Use lower-case words, joined by "." if it has several parts, for example "sales" or "commerce.sales".'
    });
    if (!name) return;

    const ontologyFile = vscode.Uri.parse(ontology.uri);
    const folder = isFolder ? resource!.fsPath : path.dirname(ontologyFile.fsPath);
    await saveIfChanged(ontologyFile);
    const result = await client.sendRequest<NewPackage>('tonto/newPackage', { ontology: ontology.uri, name, folder });
    if ('problem' in result) {
        void vscode.window.showErrorMessage(result.problem);
        return;
    }
    if (result.split) {
        const answer = await vscode.window.showWarningMessage(
            `"${ontology.name}" is a one-file ontology, which bundles no packages. Split it first? Its declarations move to `
            + `package "${result.split}" (${result.split}.tonto), the header stays in ${path.basename(ontologyFile.fsPath)}, `
            + `and "${name}" is added beside "${result.split}". No public name changes.`,
            { modal: true }, 'Split and Add'
        );
        if (answer !== 'Split and Add') return;
    }
    const edit = await client.protocol2CodeConverter.asWorkspaceEdit(result.edit);
    if (!await vscode.workspace.applyEdit(edit)) {
        void vscode.window.showErrorMessage(`Could not add package "${name}".`);
        return;
    }
    // The other files the ontology is checked from are on disk, so these are saved too.
    for (const uri of edit.entries().map(([uri]) => uri)) await saveIfChanged(uri);
    const created = vscode.Uri.parse(result.uri);
    const document = await vscode.workspace.openTextDocument(created);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const end = document.lineAt(document.lineCount - 1).range.end;
    editor.selection = new vscode.Selection(end, end);
}

async function pickOntology(listed: readonly AuthoredOntology[]): Promise<AuthoredOntology | undefined> {
    const chosen = await vscode.window.showQuickPick(listed.map(ontology => ({
        label: ontology.name,
        description: vscode.workspace.asRelativePath(vscode.Uri.parse(ontology.uri), false),
        detail: ontology.oneFile ? 'One file: it is split into an ontology file and a package first' : undefined,
        ontology
    })), { title: 'New package', placeHolder: 'The ontology the package belongs to' });
    return chosen?.ontology;
}

async function saveIfChanged(uri: Uri): Promise<void> {
    const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString());
    if (document?.isDirty) await document.save();
}
