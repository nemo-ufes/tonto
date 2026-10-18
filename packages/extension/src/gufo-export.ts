import * as path from 'node:path';
import { TontoSession, fetchSummary, validGufoNamespaceIri } from 'tonto-language';
import type { GufoDiagnostic, GufoOptions, GufoResult, GufoSeverity } from 'tonto-language';
import type { ExtensionContext, Uri } from 'vscode';
import * as vscode from 'vscode';
import {
    chooseOntologies, count, displayPath, displayUri, saveChangedModelFiles, targetDocument, workspaceRoot, writeBeside
} from './ontology-export.js';
import type { Target } from './ontology-export.js';

const COMMAND = 'tonto.exportGufo';
/** The same export, with the snapshot layer written whatever the setting says. */
const SNAPSHOT_COMMAND = 'tonto.exportGufoSnapshot';
const PUBLICATION_COMMAND = 'tonto.exportGufoPublication';
const NAMESPACES_KEY = 'tonto.gufo.namespaceIris';

/** Where the ontology header that needs a namespace is written. */
interface PackageLocation {
    file: string;
    line: number;
    column: number;
}

/** Adds the command here rather than to the server: choosing and writing a file is editor UI. */
export function registerGufoExport(context: ExtensionContext): void {
    const output = vscode.window.createOutputChannel('tonto gUFO');
    const problems = vscode.languages.createDiagnosticCollection('tonto-gufo');
    context.subscriptions.push(
        output,
        problems,
        vscode.commands.registerCommand(COMMAND, (resource?: Uri) =>
            exportGufo(context, output, problems, resource)),
        vscode.commands.registerCommand(SNAPSHOT_COMMAND, (resource?: Uri) =>
            exportGufo(context, output, problems, resource, { snapshot: true })),
        vscode.commands.registerCommand(PUBLICATION_COMMAND, (resource?: Uri) =>
            exportGufo(context, output, problems, resource, {}, true)),
        // Mapping notes describe the model at export time. Any tonto edit can
        // invalidate a note in another file, so stale notes all leave together.
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document.languageId === 'tonto') problems.clear();
        }),
        // So does closing a tonto file: the export is no longer being looked
        // at, and its notes would stay in Problems until the next one.
        // Watched on the tabs, not on `onDidCloseTextDocument`, which fires
        // when VS Code disposes of a document -- often minutes after its tab
        // closed, sometimes not at all.
        vscode.window.tabGroups.onDidChangeTabs(event => {
            if (closesATontoFile(event.closed)) problems.clear();
        }),
        vscode.window.tabGroups.onDidChangeTabGroups(event => {
            if (closesATontoFile(event.closed.flatMap(group => group.tabs))) problems.clear();
        })
    );
}

/** Whether these closed tabs leave some `.tonto` file shown in no tab at all. */
function closesATontoFile(closed: readonly vscode.Tab[]): boolean {
    const open = new Set(vscode.window.tabGroups.all
        .flatMap(group => group.tabs)
        .flatMap(tab => tab.input instanceof vscode.TabInputText ? [tab.input.uri.toString()] : []));
    return closed.some(tab => tab.input instanceof vscode.TabInputText
        && tab.input.uri.path.endsWith('.tonto')
        && !open.has(tab.input.uri.toString()));
}

/**
 * Exports ontologies, each beside the file that declares it.
 *
 * Asked about a file -- the editor's context menu passes one -- the export is
 * that file's ontology. Asked from the Command Palette, it is the workspace's
 * ontologies, listed with every one that can be exported already checked, so
 * Enter exports them all.
 */
async function exportGufo(
    context: ExtensionContext,
    output: vscode.OutputChannel,
    problems: vscode.DiagnosticCollection,
    resource?: Uri,
    overrides: Partial<GufoOptions> = {}, publication = false
): Promise<void> {
    const document = resource ? await targetDocument(resource) : undefined;
    if (resource && !document) return;
    const root = await workspaceRoot(document ?? vscode.window.activeTextEditor?.document);
    if (!root) return;
    if (!await saveChangedModelFiles(root)) return;

    problems.clear();
    output.clear();
    output.appendLine(`Model: ${root}`);

    try {
        let session = new TontoSession({ workspace: root, publication });
        const listed = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification, title: 'Reading the ontologies of the workspace…'
        }, () => session.ontologies());
        let targets: Target[] | undefined;
        if (document) {
            // A package file exports the ontology it belongs to, beside its ontology file.
            const file = document.uri.fsPath;
            const owner = listed.find(ontology => ontology.files.includes(file));
            targets = [owner ?? { name: path.basename(file, '.tonto'), file }];
        } else {
            targets = await chooseOntologies(listed, 'Export to gUFO',
                ontology => ontology.namespace ?? 'no namespace yet: asked for on export');
        }
        if (!targets?.length) return;

        if (!publication) {
            const substituted = await session.substitutedImports(targets.map(target => target.file));
            if (substituted.length) {
                const choice = await vscode.window.showQuickPick([
                    { label: 'Use configured substitutes', description: 'Export the working model', publication: false },
                    { label: 'Use original imports', description: 'Verify the ontology for publication', publication: true }
                ], { placeHolder: `${substituted.length} imported ${substituted.length === 1 ? 'ontology uses' : 'ontologies use'} a configured substitute` });
                if (!choice) return;
                publication = choice.publication;
                if (publication) session = new TontoSession({ workspace: root, publication: true });
            }
        }
        const configuration = vscode.workspace.getConfiguration('tonto', vscode.Uri.file(targets[0]!.file));
        const options: GufoOptions = {
            directSpecializations: configuration.get<boolean>('gufo.directSpecializations', false),
            snapshot: configuration.get<boolean>('gufo.snapshot', false),
            ...overrides
        };

        const reported: GufoDiagnostic[] = [];
        const written: Array<{ name: string; uris: Uri[] }> = [];
        const skipped: string[] = [];
        let fetched = false;
        for (const target of targets) {
            output.appendLine('');
            output.appendLine(`Ontology "${target.name}" (${displayPath(target.file)})`);
            let result = await runExport(session, target.file, options);
            const unavailableOriginal = publication && !fetched && result.diagnostics.find(entry => entry.code === 'publication-location'
                && (entry.message.includes('not cached') || entry.message.includes('failed its SHA-256 check')));
            if (unavailableOriginal) {
                const action = await vscode.window.showInformationMessage(
                    'Original imports must be downloaded before these ontologies can be exported for publication.',
                    'Download and Continue'
                );
                if (action !== 'Download and Continue') return;
                const summary = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
                    title: 'Downloading original ontology imports' }, () => session.fetch(targets!.map(one => one.file), {
                    refresh: unavailableOriginal.message.includes('failed its SHA-256 check')
                }));
                fetched = true;
                output.appendLine(fetchSummary(summary));
                result = await runExport(session, target.file, options);
            }
            // An ontology whose header gives no namespace is asked for one,
            // the same value `@namespace` takes, which is then written there.
            // Not while it has errors: it is not exported, and would be asked
            // again once they are fixed.
            const missingIri = result.diagnostics.find(entry => entry.code === 'gufo-placeholder-namespace');
            let namespaceIri: string | undefined;
            if (missingIri && !result.diagnostics.some(entry => entry.severity === 'error')) {
                namespaceIri = await askForNamespaceIri(context, root, target.name);
                if (!namespaceIri) {
                    skipped.push(target.name);
                    output.appendLine('Not exported: no namespace was given.');
                    continue;
                }
                result = await runExport(session, target.file, { ...options, namespaceIri });
            }
            output.appendLine(namespaceIri ? `Namespace: ${namespaceIri}` : 'Namespace: declared by @namespace');
            reported.push(...result.diagnostics);
            const errors = result.diagnostics.filter(entry => entry.severity === 'error');
            if (errors.length > 0 || result.files.length === 0) {
                skipped.push(target.name);
                output.appendLine(`Not exported: ${count(errors.length, 'error')}.`);
                continue;
            }
            const uris = await writeBeside(result.files, target);
            for (const uri of uris) output.appendLine(`Written: ${displayUri(uri)}`);
            written.push({ name: target.name, uris });
            if (namespaceIri && missingIri) {
                const annotated = await addNamespaceAnnotation(missingIri, namespaceIri);
                if (annotated) output.appendLine(`Namespace saved in: ${displayPath(missingIri.file)}`);
                await rememberNamespaceIri(context, root, target.name, namespaceIri);
            }
            if (result.publicationVerified) output.appendLine('Publication verified against the original import locations.');
        }
        output.appendLine('');
        reportDiagnostics(reported, output, problems);

        if (written.length === 0) {
            output.show(true);
            const action = await vscode.window.showErrorMessage(
                skipped.length === 1 ? `"${skipped[0]}" was not exported; see the gUFO output.`
                    : `None of the ${skipped.length} ontologies was exported; see the gUFO output.`,
                'Show gUFO Output'
            );
            if (action) output.show(true);
            return;
        }
        if (written.length === 1 && skipped.length === 0) {
            const generated = await vscode.workspace.openTextDocument(written[0]!.uris[0]!);
            await vscode.window.showTextDocument(generated, { preview: false });
        }
        const warnings = reported.filter(entry => entry.severity === 'warning').length;
        const what = written.length === 1 ? path.basename(written[0]!.uris[0]!.path) : count(written.length, 'ontology');
        const message = `Exported ${what} beside ${written.length === 1 ? 'its ontology file' : 'their ontology files'}`
            + (skipped.length ? `; not exported: ${skipped.map(name => `"${name}"`).join(', ')}` : '')
            + (warnings ? `; ${count(warnings, 'warning')} in Problems` : '') + '.';
        const show = written.length > 1 || skipped.length ? ['Show gUFO Output'] : [];
        const action = skipped.length || warnings
            ? await vscode.window.showWarningMessage(message, ...show)
            : await vscode.window.showInformationMessage(message, ...show);
        if (action) output.show(true);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`error       gufo-export-failed                         ${message}`);
        output.show(true);
        void vscode.window.showErrorMessage(`gUFO export failed: ${message}`);
    }
}

function runExport(
    session: TontoSession, sourcePath: string, options: GufoOptions
): Thenable<GufoResult> {
    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Exporting ${path.basename(sourcePath)} to gUFO…`
    }, async () => session.gufoFiles([sourcePath], options));
}

async function askForNamespaceIri(
    context: ExtensionContext, root: string, packageName: string
): Promise<string | undefined> {
    const saved = context.workspaceState.get<Record<string, string>>(NAMESPACES_KEY) ?? {};
    const key = `${root}\u0000${packageName}`;
    return vscode.window.showInputBox({
        title: `Namespace IRI for ontology "${packageName}"`,
        prompt: 'Exact namespace; this is the same value as /// @namespace',
        value: saved[key] ?? `https://example.org/${encodeURIComponent(packageName)}#`,
        ignoreFocusOut: true,
        validateInput: value => validGufoNamespaceIri(value)
            ? undefined
            : 'Enter an absolute HTTP(S) namespace ending in # or /, without spaces or a query.'
    });
}

async function rememberNamespaceIri(
    context: ExtensionContext, root: string, packageName: string, namespaceIri: string
): Promise<void> {
    const saved = context.workspaceState.get<Record<string, string>>(NAMESPACES_KEY) ?? {};
    await context.workspaceState.update(NAMESPACES_KEY, {
        ...saved, [`${root}\u0000${packageName}`]: namespaceIri
    });
}

/** Writes the supplied namespace into the ontology's or package's documentation and saves it. */
async function addNamespaceAnnotation(location: PackageLocation, namespaceIri: string): Promise<boolean> {
    if (!location.file) throw new Error('The ontology that needs a namespace has no source file.');
    const uri = vscode.Uri.file(location.file);
    const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString())
        ?? await vscode.workspace.openTextDocument(uri);
    const lineNumber = location.line - 1;
    const character = location.column - 1;
    if (lineNumber < 0 || lineNumber >= document.lineCount) {
        throw new Error(`Could not locate the ontology header in ${displayPath(location.file)}.`);
    }

    const packageLine = document.lineAt(lineNumber);
    const beforePackage = packageLine.text.slice(0, character);
    const packageText = packageLine.text.slice(character);
    if (!/^(?:package|ontology)\b/u.test(packageText)) {
        throw new Error(`The ontology header moved while the gUFO export was running; export it again to save its namespace.`);
    }

    // Do not duplicate an annotation added while the save dialog was open.
    for (let line = lineNumber - 1; line >= 0; line--) {
        const text = document.lineAt(line).text.trimStart();
        if (!text.startsWith('///')) break;
        if (/^\/\/\/\s*@namespace(?:\s|$)/u.test(text)) return false;
    }

    const newline = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const edit = new vscode.WorkspaceEdit();
    if (beforePackage.trim().length === 0) {
        // Add to any existing contiguous documentation run immediately above
        // the package, retaining the indentation used by its declaration.
        edit.insert(uri, new vscode.Position(lineNumber, 0),
            `${beforePackage}/// @namespace ${namespaceIri}${newline}`);
    } else {
        // The grammar permits declarations on one line. End the preceding
        // construct before beginning a line-level package annotation.
        edit.insert(uri, new vscode.Position(lineNumber, character),
            `${newline}/// @namespace ${namespaceIri}${newline}`);
    }
    if (!await vscode.workspace.applyEdit(edit)) {
        throw new Error(`Could not add @namespace to ${displayPath(location.file)}.`);
    }
    if (!await document.save()) {
        throw new Error(`Could not save ${displayPath(location.file)} after adding @namespace.`);
    }
    return true;
}

function reportDiagnostics(
    diagnostics: readonly GufoDiagnostic[],
    output: vscode.OutputChannel,
    problems: vscode.DiagnosticCollection
): void {
    if (diagnostics.length === 0) {
        output.appendLine('No gUFO mapping diagnostics.');
        return;
    }

    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const entry of diagnostics) {
        const place = entry.file ? `${displayPath(entry.file)}:${entry.line}:${entry.column}  ` : '';
        output.appendLine(`${place}${entry.severity.padEnd(11)} ${entry.code.padEnd(42)} ${entry.message}`);
        if (!entry.file) continue;

        const diagnostic = new vscode.Diagnostic(rangeOf(entry), entry.message, severityOf(entry.severity));
        diagnostic.code = entry.code;
        diagnostic.source = 'tonto gUFO';
        const entries = byFile.get(entry.file) ?? [];
        entries.push(diagnostic);
        byFile.set(entry.file, entries);
    }
    for (const [file, entries] of byFile) problems.set(vscode.Uri.file(file), entries);
    output.appendLine('');
}

function rangeOf(entry: GufoDiagnostic): vscode.Range {
    const startLine = Math.max(0, entry.line - 1);
    const startColumn = Math.max(0, entry.column - 1);
    const endLine = Math.max(startLine, entry.endLine - 1);
    const endColumn = endLine === startLine
        ? Math.max(startColumn, entry.endColumn - 1)
        : Math.max(0, entry.endColumn - 1);
    return new vscode.Range(startLine, startColumn, endLine, endColumn);
}

function severityOf(severity: GufoSeverity): vscode.DiagnosticSeverity {
    switch (severity) {
        case 'error': return vscode.DiagnosticSeverity.Error;
        case 'warning': return vscode.DiagnosticSeverity.Warning;
        case 'information': return vscode.DiagnosticSeverity.Information;
        case 'hint': return vscode.DiagnosticSeverity.Hint;
    }
}
