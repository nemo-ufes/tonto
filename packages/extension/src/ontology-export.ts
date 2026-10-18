import * as path from 'node:path';
import { workspaceRootOf } from 'tonto-language';
import type { ExportedFile, WorkspaceOntology } from 'tonto-language';
import type { TextDocument, Uri } from 'vscode';
import * as vscode from 'vscode';

/*
 * What every export of ontologies does in the editor, whatever its format:
 * which ontologies it is of, which workspace it reads, saving the model
 * first, and writing each ontology's files beside its ontology file
 * (docs/ontology-publication.md, section 11). The gUFO export is the first
 * format; each format adds only what is its own.
 */

/** One ontology to export, and the file beside which its exported files go. */
export interface Target {
    name: string;
    /** The ontology file, which holds the header; its folder receives the export. */
    file: string;
}

/**
 * The ontologies to export, chosen from the workspace's. One is exported
 * without asking. Several are listed with each that can be exported
 * checked, and those with errors -- which would not be written -- unchecked.
 */
export async function chooseOntologies(
    listed: readonly WorkspaceOntology[], title: string, describe?: (ontology: WorkspaceOntology) => string | undefined
): Promise<Target[] | undefined> {
    if (listed.length === 0) {
        void vscode.window.showErrorMessage('This workspace declares no ontology. An export needs a file starting with an "ontology" header.');
        return undefined;
    }
    if (listed.length === 1) return [listed[0]!];
    const items = listed.map(ontology => ({
        label: ontology.name,
        description: displayPath(ontology.file),
        detail: [
            ontology.errors ? `$(error) ${count(ontology.errors, 'error')}` : undefined,
            describe?.(ontology)
        ].filter(Boolean).join('  \u00b7  '),
        picked: ontology.errors === 0,
        ontology
    }));
    const chosen = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title,
        placeHolder: 'Each ontology is written beside its ontology file. Press Enter to export the checked ones.'
    });
    return chosen?.map(item => item.ontology);
}

/**
 * The workspace an export reads. A file's own workspace folder, or the model
 * around it; with no file, the one workspace folder, or the one chosen.
 */
export async function workspaceRoot(document?: TextDocument): Promise<string | undefined> {
    if (document?.uri.scheme === 'file' && document.languageId === 'tonto') {
        // The open folder is the project boundary. Without it, a loose
        // `.tonto` file in Downloads (and another in the home directory) can
        // make model discovery climb into and traverse the entire home tree.
        const configured = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
        try {
            return configured ?? workspaceRootOf(document.uri.fsPath, path.dirname(document.uri.fsPath));
        } catch {
            void vscode.window.showErrorMessage('Save the tonto file before exporting its ontology.');
            return undefined;
        }
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
        void vscode.window.showErrorMessage('Open a folder with tonto ontologies before exporting.');
        return undefined;
    }
    if (folders.length === 1) return folders[0]!.uri.fsPath;
    return (await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Export the ontologies of which folder?' }))?.uri.fsPath;
}

export async function targetDocument(resource?: Uri): Promise<TextDocument | undefined> {
    const uri = resource ?? vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== 'file') {
        void vscode.window.showErrorMessage('Open a saved .tonto file before exporting its ontology.');
        return undefined;
    }
    let document: TextDocument;
    try {
        document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString())
            ?? await vscode.workspace.openTextDocument(uri);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Could not open the tonto file: ${message}`);
        return undefined;
    }
    if (document.languageId !== 'tonto') {
        void vscode.window.showErrorMessage('An export reads a tonto file.');
        return undefined;
    }
    return document;
}

export async function saveChangedModelFiles(root: string): Promise<boolean> {
    const changed = vscode.workspace.textDocuments.filter(document =>
        document.languageId === 'tonto'
        && document.uri.scheme === 'file'
        && document.isDirty
        && isInside(root, document.uri.fsPath));
    if (changed.length === 0) return true;

    const answer = await vscode.window.showWarningMessage(
        `The export reads the ontologies from disk. Save ${count(changed.length, 'changed tonto file')} and continue?`,
        { modal: true },
        'Save and Export'
    );
    if (answer !== 'Save and Export') return false;

    for (const document of changed) {
        if (!await document.save()) {
            void vscode.window.showErrorMessage(`Could not save ${path.basename(document.uri.fsPath)}.`);
            return false;
        }
    }
    return true;
}

/**
 * Writes each exported file beside the ontology file it came from, as every
 * format does, each one atomically.
 */
export async function writeBeside(files: readonly ExportedFile[], target: Target): Promise<Uri[]> {
    const uris: Uri[] = [];
    for (const file of files) {
        const uri = vscode.Uri.file(path.join(path.dirname(file.source ?? target.file), file.file));
        await writeAtomically(uri, file.content);
        uris.push(uri);
    }
    return uris;
}

export async function writeAtomically(target: Uri, contents: string): Promise<void> {
    const temporary = target.with({ path: `${target.path}.${process.pid}.${Date.now()}.tmp` });
    try {
        await vscode.workspace.fs.writeFile(temporary, new TextEncoder().encode(contents));
        await vscode.workspace.fs.rename(temporary, target, { overwrite: true });
    } catch (error) {
        try {
            await vscode.workspace.fs.delete(temporary);
        } catch {
            // Nothing was written, or the rename already completed.
        }
        throw error;
    }
}

export function isInside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function displayPath(file: string): string {
    return vscode.workspace.asRelativePath(file, false);
}

export function displayUri(uri: Uri): string {
    return uri.scheme === 'file' ? uri.fsPath : uri.toString(true);
}

export function count(amount: number, singular: string): string {
    return `${amount} ${singular}${amount === 1 ? '' : 's'}`;
}
