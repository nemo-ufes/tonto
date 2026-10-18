import * as path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { TontoSession, workspaceRootOf } from 'tonto-language';
import { TOOLS, ToolError, VSCODE_CAPABILITIES, runTool } from 'tonto-language/tools';
import type { ToolHost } from 'tonto-language/tools';
import type { ExtensionContext, LanguageModelTool } from 'vscode';
import * as vscode from 'vscode';

type Input = Record<string, unknown>;

/**
 * The tonto tools for agents inside VS Code, as tonto-language/tools defines
 * them for every host -- the MCP server serves the same ones. package.json
 * declares them from the same definitions (`npm run tools:sync`). What is
 * this host's own is the editor: a call about no file is about the active
 * model, files with unsaved changes are refused rather than read stale, and
 * a call can be canceled.
 */
export function registerLanguageModelTools(context: ExtensionContext): void {
    const sessions = new Sessions();
    for (const definition of TOOLS) {
        const tool: LanguageModelTool<Input> = {
            async invoke(options, token) {
                if (token.isCancellationRequested) throw new vscode.CancellationError();
                const answer = await runTool(definition.name, options.input ?? {}, editorHost(sessions));
                if (token.isCancellationRequested) throw new vscode.CancellationError();
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(answer.isError ? `tonto tool error: ${answer.text}` : answer.text)
                ]);
            },
            prepareInvocation: () => ({ invocationMessage: definition.progress })
        };
        context.subscriptions.push(vscode.lm.registerTool(definition.name, tool));
    }
}

/** The editor as a host: its folders, its active model, its unsaved files. */
function editorHost(sessions: Sessions): ToolHost {
    const antiPatterns = vscode.workspace.getConfiguration('tonto').get<boolean>('antiPatterns', false);
    return {
        ...VSCODE_CAPABILITIES,
        files(paths) {
            const targets = paths ? paths.map(resolveWorkspacePath) : resolveTargets();
            ensureSaved(workspaceFor(targets));
            return targets;
        },
        session: files => sessions.current(files ? workspaceFor(files) : sourceWorkspace()),
        sessionWith: (options, files) => new TontoSession({ workspace: files ? workspaceFor(files) : sourceWorkspace(), antiPatterns, ...options }),
        workspaceRoot(files) {
            const roots = files ? workspaceFor(files) : sourceWorkspace();
            if (roots.length !== 1) throw new ToolError('This needs exactly one open workspace; name a file inside it.');
            return roots[0]!;
        },
        display: file => vscode.workspace.asRelativePath(file, false)
    };
}

/** Reuse a loaded workspace until its folders or validation setting change. */
class Sessions {
    private readonly values = new Map<string, TontoSession>();

    current(workspace = sourceWorkspace()): TontoSession {
        const antiPatterns = vscode.workspace.getConfiguration('tonto').get<boolean>('antiPatterns', false);
        const key = JSON.stringify({ workspace, antiPatterns });
        let session = this.values.get(key);
        if (!session) {
            session = new TontoSession({ workspace, antiPatterns });
            this.values.set(key, session);
        }
        return session;
    }
}

/** The active model is the least surprising default; otherwise use the open workspace. */
function resolveTargets(): string[] {
    const active = vscode.window.activeTextEditor?.document;
    if (active?.languageId === 'tonto' && active.uri.scheme === 'file') {
        return [openModelRoot(active.uri.fsPath)];
    }
    if (active?.languageId === 'tonto') {
        throw new ToolError('Save the untitled tonto file first, or provide its text as source.');
    }
    const folders = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
    if (folders.length === 0) {
        throw new ToolError('Open a tonto file or workspace, pass a workspace-relative path, or provide source text.');
    }
    return folders;
}

/** Each named file is checked as part of the model it belongs to. */
function workspaceFor(targets: string[]): string[] {
    return [...new Set(targets.map(openModelRoot))];
}

/** Draft text resolves imports against the active model when there is one. */
function sourceWorkspace(): string[] {
    const active = vscode.window.activeTextEditor?.document;
    if (active?.languageId === 'tonto' && active.uri.scheme === 'file' && existsSync(active.uri.fsPath)) {
        return [openModelRoot(active.uri.fsPath)];
    }
    return vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
}

/** Keep inference inside the VS Code folder that gave the tool its scope. */
function openModelRoot(target: string): string {
    const absolute = path.resolve(target);
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(absolute));
    const boundary = folder?.uri.fsPath
        ?? (statSync(absolute).isDirectory() ? absolute : path.dirname(absolute));
    return workspaceRootOf(absolute, boundary);
}

function resolveWorkspacePath(given: string): string {
    if (path.isAbsolute(given)) {
        throw new ToolError('Path must be relative to an open workspace folder.');
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) throw new ToolError('Open the workspace that contains the requested path.');
    const candidates = folders.map(folder => path.resolve(folder.uri.fsPath, given))
        .filter((candidate, index) => isInside(folders[index]!.uri.fsPath, candidate) && existsSync(candidate));
    if (candidates.length === 0) throw new ToolError(`Path "${given}" does not exist in the open workspace.`);
    if (candidates.length > 1) throw new ToolError(`Path "${given}" exists in more than one open workspace folder.`);
    return candidates[0]!;
}

/** File tools deliberately refuse to validate stale on-disk text. */
function ensureSaved(targets: string[]): void {
    const dirty = vscode.workspace.textDocuments.filter(document => document.isDirty
        && document.languageId === 'tonto'
        && document.uri.scheme === 'file'
        && targets.some(target => isInside(target, document.uri.fsPath) || target === document.uri.fsPath));
    if (dirty.length > 0) {
        throw new ToolError(`Save the changed tonto ${dirty.length === 1 ? 'file' : 'files'} first: `
            + dirty.map(document => vscode.workspace.asRelativePath(document.uri, false)).join(', '));
    }
}

function isInside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
