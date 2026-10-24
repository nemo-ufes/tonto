import * as path from 'node:path';
import { guide } from 'tonto-language/guide';
import type { ExtensionContext, TextDocumentContentProvider, Uri, WorkspaceFolder } from 'vscode';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { withClaudeHook } from 'tonto-language/agent-hook';
import { ontologyNameProblem } from 'tonto-language';
import {
    AGENTS_IMPORT, EDITOR_INSTRUCTIONS_START, ONTOLOGY_NAME_HINT, defaultOntologyName, starterOntology, validOntologyName,
    withAgentsImport, withTontoInstructions
} from 'tonto-language/onboarding';

const WALKTHROUGH = 'nemo-ufes.tonto-vscode#tonto.getStarted';
const GUIDE_URI = vscode.Uri.from({ scheme: 'tonto-reference', path: '/tonto Language Guide.md' });

const DONT_ASK_KEY = 'tonto.agents.dontAsk';

/** Commands used by the automatically opened Getting Started walkthrough, and the setup they share. */
export function registerOnboarding(context: ExtensionContext, client: () => LanguageClient | undefined): void {
    // Project MCP configuration points at this stable copy rather than into a
    // versioned extension installation. Refresh it on every activation so a
    // VSIX upgrade also upgrades existing Codex and Claude integrations.
    void stageMcpRuntime(context).catch(error => {
        console.error(`tonto could not refresh its bundled MCP runtime: ${messageOf(error)}`);
    });
    const guideProvider: TextDocumentContentProvider = {
        provideTextDocumentContent: () => guide()
    };
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(GUIDE_URI.scheme, guideProvider),
        vscode.commands.registerCommand('tonto.getStarted', () =>
            vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH, false)),
        vscode.commands.registerCommand('tonto.openGuide', openGuide),
        vscode.commands.registerCommand('tonto.newOntology', (resource?: Uri) => newOntology(context, client(), resource)),
        vscode.commands.registerCommand('tonto.addAgentInstructions', () => setupAgents(context))
    );
    void offerAgentSetup(context);
}

async function openGuide(): Promise<void> {
    await vscode.workspace.openTextDocument(GUIDE_URI);
    await vscode.commands.executeCommand('markdown.showPreview', GUIDE_URI);
}

/**
 * A new one-file ontology, `<name>.tonto`, in the folder the Explorer was
 * asked about or the workspace's. The first ontology of a workspace starts
 * with a sample declaration; later ones start empty. A workspace's agent
 * setup goes with it: when Codex and Claude are not yet set up for the
 * workspace, they are now, unless `tonto.agents.setUpOnCreate` is off -- an
 * empty folder made into a tonto project from the Command Palette would
 * otherwise leave agents without the language's tools and instructions.
 */
export async function newOntology(context: ExtensionContext, client: LanguageClient | undefined, resource?: Uri): Promise<void> {
    const hadWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    const folder: WorkspaceFolder | undefined = resource
        ? { uri: resource, name: path.basename(resource.fsPath), index: 0 }
        : await chooseFolder();
    if (!folder) return;
    const existing = hadWorkspace && client ? (await client.sendRequest<Array<{ name: string }>>('tonto/ontologies').catch(() => [])).map(one => one.name) : [];

    // A one-file ontology: one document, its header and its declarations.
    // It grows packages when it needs them, by New Package... or the refactoring on its header.
    const ontologyName = await vscode.window.showInputBox({
        title: 'New tonto ontology',
        prompt: 'Name of the ontology',
        value: existing.length ? '' : defaultOntologyName(folder.uri.fsPath, name => !ontologyNameProblem(name)),
        ignoreFocusOut: true,
        // The header is read as well as the name's shape: a keyword such as
        // "event" has the shape and would write a file that does not parse.
        validateInput: value => !validOntologyName(value)
            ? ONTOLOGY_NAME_HINT
            : ontologyNameProblem(value)
                ?? (existing.includes(value) ? `This workspace already has an ontology "${value}".` : undefined)
    });
    if (!ontologyName) return;

    const filename = `${ontologyName}.tonto`;
    const target = vscode.Uri.joinPath(folder.uri, filename);
    const root = vscode.workspace.getWorkspaceFolder(target)?.uri ?? folder.uri;
    if (await exists(target)) {
        await setupStarterAgents(context, root);
        void vscode.window.showInformationMessage(`${filename} already exists; tonto will open it without changing it.`);
        if (hadWorkspace) {
            await openDocument(target);
        } else {
            await vscode.commands.executeCommand('vscode.openFolder', folder.uri, false);
        }
        return;
    }

    const source = starterOntology(ontologyName, existing.length === 0);
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(source));
    const configured = await setupStarterAgents(context, root);
    void vscode.window.showInformationMessage(`Created ${filename}${configured ? ', and set up Codex and Claude for this folder' : ''}.`);

    if (hadWorkspace) {
        await openDocument(target);
    } else {
        // Opening a folder restarts the extension host. The new workspace's
        // Explorer shows the new model, and opening it activates tonto again.
        await vscode.commands.executeCommand('vscode.openFolder', folder.uri, false);
    }
}

/** Sets up the agents when the setting allows it; whether anything was written. */
async function setupStarterAgents(context: ExtensionContext, folder: Uri): Promise<boolean> {
    if (!vscode.workspace.getConfiguration('tonto', folder).get<boolean>('agents.setUpOnCreate', true)) return false;
    try {
        return (await setupAgentWorkspace(context, folder, true)).length > 0;
    } catch (error) {
        void vscode.window.showWarningMessage(
            `The ontology is ready, but tonto could not configure Codex and Claude: ${messageOf(error)}`
        );
        return false;
    }
}

/**
 * Once per workspace folder that holds tonto files and has no agent setup,
 * asks whether to set it up: a project that was cloned, or whose first file
 * was written by hand, never passed through New Ontology... Never silently,
 * since the files it writes would appear in someone else's repository.
 */
async function offerAgentSetup(context: ExtensionContext): Promise<void> {
    const declined = context.workspaceState.get<string[]>(DONT_ASK_KEY) ?? [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (declined.includes(folder.uri.toString())) continue;
        const tonto = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.tonto'), '**/{node_modules,.tonto}/**', 1);
        if (tonto.length === 0 || await agentsSetUp(folder.uri)) continue;
        const answer = await vscode.window.showInformationMessage(
            `Set up Codex and Claude for ${folder.name}? They get the tonto instructions and tools, and write better models with them.`,
            'Set Up', 'Not Now', "Don't Ask Again"
        );
        if (answer === 'Set Up') {
            try {
                const changed = await setupAgentWorkspace(context, folder.uri, true);
                void vscode.window.showInformationMessage(`Configured tonto in ${changed.join(', ') || 'nothing new'}. Trust the MCP server when asked, then start new agent chats.`);
            } catch (error) {
                void vscode.window.showErrorMessage(`tonto could not configure the agents: ${messageOf(error)}`);
            }
        } else if (answer === "Don't Ask Again") {
            await context.workspaceState.update(DONT_ASK_KEY, [...declined, folder.uri.toString()]);
        }
    }
}

/** Whether a folder has the tonto instructions, both agents' MCP entries, and Claude Code's validation hook. */
async function agentsSetUp(folder: Uri): Promise<boolean> {
    const instructions = await readText(vscode.Uri.joinPath(folder, 'AGENTS.md'));
    const claude = await readText(vscode.Uri.joinPath(folder, '.mcp.json'));
    const codex = await readText(vscode.Uri.joinPath(folder, '.codex', 'config.toml'));
    const hook = await readText(vscode.Uri.joinPath(folder, '.claude', 'settings.json'));
    return instructions.includes(EDITOR_INSTRUCTIONS_START) && claude.includes('"tonto-vscode"') && codex.includes(CODEX_BLOCK_START)
        && hook.includes('tonto-hook');
}

async function setupAgents(context: ExtensionContext): Promise<void> {
    const folder = await chooseFolder();
    if (!folder) return;

    let changed: string[];
    try {
        changed = await setupAgentWorkspace(context, folder.uri, true);
    } catch (error) {
        void vscode.window.showErrorMessage(`tonto could not configure the agents: ${messageOf(error)}`);
        return;
    }
    if (changed.length === 0) {
        void vscode.window.showInformationMessage(
            'tonto instructions and tools are already configured for Codex and Claude.'
        );
        await openDocument(vscode.Uri.joinPath(folder.uri, 'AGENTS.md'));
        return;
    }

    await openDocument(vscode.Uri.joinPath(folder.uri, changed[0]));
    void vscode.window.showInformationMessage(
        `Configured tonto in ${changed.join(', ')}. Trust the MCP server when asked, then start new agent chats.`
    );
}

async function setupAgentWorkspace(
    context: ExtensionContext,
    folder: Uri,
    mergeExisting: boolean
): Promise<string[]> {
    const instructions = await installAgentInstructions(context, folder, mergeExisting);
    const tools = await installAgentTools(context, folder);
    return [...instructions, ...tools];
}

async function installAgentInstructions(
    context: ExtensionContext,
    folder: Uri,
    mergeExisting: boolean
): Promise<string[]> {
    const template = vscode.Uri.joinPath(context.extensionUri, 'templates', 'agent-instructions.md');
    const contents = await vscode.workspace.fs.readFile(template);
    const templateText = new TextDecoder().decode(contents);
    const changed: string[] = [];

    const agents = vscode.Uri.joinPath(folder, 'AGENTS.md');
    if (!await exists(agents)) {
        await vscode.workspace.fs.writeFile(agents, contents);
        changed.push('AGENTS.md');
    } else if (mergeExisting) {
        const current = new TextDecoder().decode(await vscode.workspace.fs.readFile(agents));
        const updated = withTontoInstructions(current, templateText);
        if (updated !== current) {
            await vscode.workspace.fs.writeFile(agents, new TextEncoder().encode(updated));
            changed.push('AGENTS.md');
        }
    }

    const claude = vscode.Uri.joinPath(folder, 'CLAUDE.md');
    if (!await exists(claude)) {
        await vscode.workspace.fs.writeFile(claude, new TextEncoder().encode(AGENTS_IMPORT));
        changed.push('CLAUDE.md');
    } else if (mergeExisting) {
        const current = new TextDecoder().decode(await vscode.workspace.fs.readFile(claude));
        const updated = withAgentsImport(current);
        if (updated !== current) {
            await vscode.workspace.fs.writeFile(claude, new TextEncoder().encode(updated));
            changed.push('CLAUDE.md');
        }
    }
    return changed;
}

async function installAgentTools(context: ExtensionContext, folder: Uri): Promise<string[]> {
    const runtime = await stageMcpRuntime(context);
    const changed: string[] = [];
    if (await installClaudeMcp(folder, runtime)) changed.push('.mcp.json');
    if (await installClaudeHook(folder, hookRuntime(context))) changed.push('.claude/settings.json');
    if (await installCodexMcp(folder, runtime)) changed.push('.codex/config.toml');
    return changed;
}

async function stageMcpRuntime(context: ExtensionContext): Promise<Uri> {
    await stageRuntime(context, 'tonto-hook.mjs');
    return stageRuntime(context, 'tonto-mcp.mjs');
}

/** The hook Claude Code runs after each edit, staged with the MCP runtime and upgraded with it. */
function hookRuntime(context: ExtensionContext): Uri {
    return vscode.Uri.joinPath(context.globalStorageUri, 'runtime', 'tonto-hook.mjs');
}

async function stageRuntime(context: ExtensionContext, name: string): Promise<Uri> {
    const directory = vscode.Uri.joinPath(context.globalStorageUri, 'runtime');
    const target = vscode.Uri.joinPath(directory, name);
    const source = vscode.Uri.joinPath(context.extensionUri, 'out', name);
    const temporary = vscode.Uri.joinPath(directory, `.${name}.${process.pid}.${Date.now()}.tmp`);
    await vscode.workspace.fs.createDirectory(directory);
    try {
        await vscode.workspace.fs.copy(source, temporary, { overwrite: true });
        await vscode.workspace.fs.rename(temporary, target, { overwrite: true });
    } catch (error) {
        try { await vscode.workspace.fs.delete(temporary); } catch { /* Copy did not begin, or rename completed. */ }
        throw error;
    }
    return target;
}

async function installClaudeMcp(folder: Uri, runtime: Uri): Promise<boolean> {
    const target = vscode.Uri.joinPath(folder, '.mcp.json');
    const root = await readJsonObject(target);
    const servers = root.mcpServers === undefined ? {} : requireObject(root.mcpServers, 'mcpServers');
    root.mcpServers = servers;

    const definition = {
        type: 'stdio',
        // Claude expands these when it starts the server. The defaults keep
        // VSIX-only installation working; another machine can supply its own
        // VS Code runtime paths without rewriting the shared JSON entry.
        command: `\${TONTO_VSCODE_NODE:-${process.execPath}}`,
        args: [`\${TONTO_MCP_RUNTIME:-${runtime.fsPath}}`],
        env: { ELECTRON_RUN_AS_NODE: '1' }
    };
    if (JSON.stringify(servers['tonto-vscode']) === JSON.stringify(definition)) return false;

    servers['tonto-vscode'] = definition;
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(`${JSON.stringify(root, undefined, 2)}\n`));
    return true;
}

/**
 * Claude Code's PostToolUse hook: each `.tonto` file Claude edits is
 * validated, and its errors go back to Claude at once (tonto-language's
 * agent-hook). The command names VS Code's own Node.js runtime as the MCP
 * entry does, with the same overrides for another machine.
 */
async function installClaudeHook(folder: Uri, runtime: Uri): Promise<boolean> {
    const directory = vscode.Uri.joinPath(folder, '.claude');
    const target = vscode.Uri.joinPath(directory, 'settings.json');
    const current = await readJsonObject(target);
    const command = `ELECTRON_RUN_AS_NODE=1 "\${TONTO_VSCODE_NODE:-${process.execPath}}" "\${TONTO_HOOK_RUNTIME:-${runtime.fsPath}}"`;
    const revised = withClaudeHook(current, command);
    if (JSON.stringify(revised) === JSON.stringify(current)) return false;
    await vscode.workspace.fs.createDirectory(directory);
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(`${JSON.stringify(revised, undefined, 2)}\n`));
    return true;
}

const CODEX_BLOCK_START = '# >>> tonto-vscode MCP (managed by the tonto extension)';
const CODEX_BLOCK_END = '# <<< tonto-vscode MCP';

async function installCodexMcp(folder: Uri, runtime: Uri): Promise<boolean> {
    const directory = vscode.Uri.joinPath(folder, '.codex');
    const target = vscode.Uri.joinPath(directory, 'config.toml');
    const current = await readText(target);
    // Without cwd, Codex starts the server in the session directory. This
    // avoids pinning the config to the checkout's original absolute path.
    const block = `${CODEX_BLOCK_START}\n`
        + '[mcp_servers.tonto_vscode]\n'
        + `command = ${tomlString(process.execPath)}\n`
        + `args = [${tomlString(runtime.fsPath)}, "."]\n`
        + 'env = { ELECTRON_RUN_AS_NODE = "1" }\n'
        + 'startup_timeout_sec = 30\n'
        + `${CODEX_BLOCK_END}`;
    const revised = replaceManagedBlock(current, block);
    if (revised === current) return false;

    await vscode.workspace.fs.createDirectory(directory);
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(revised));
    return true;
}

async function readJsonObject(uri: Uri): Promise<Record<string, unknown>> {
    const text = await readText(uri);
    if (!text) return {};
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (error) {
        throw new Error(`${uri.fsPath} is not valid JSON: ${messageOf(error)}`);
    }
    return requireObject(value, uri.fsPath);
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${name} must be a JSON object.`);
    }
    return value as Record<string, unknown>;
}

async function readText(uri: Uri): Promise<string> {
    if (!await exists(uri)) return '';
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

function replaceManagedBlock(current: string, block: string): string {
    const start = current.indexOf(CODEX_BLOCK_START);
    const end = current.indexOf(CODEX_BLOCK_END);
    if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) {
        throw new Error('.codex/config.toml contains an incomplete tonto-managed block.');
    }
    if (start >= 0) {
        const after = end + CODEX_BLOCK_END.length;
        const revised = `${current.slice(0, start)}${block}${current.slice(after)}`;
        return revised.endsWith('\n') ? revised : `${revised}\n`;
    }
    if (/^\s*\[mcp_servers\.tonto_vscode\]\s*$/m.test(current)) {
        throw new Error('.codex/config.toml already defines mcp_servers.tonto_vscode outside the managed block.');
    }
    return current.trim().length === 0 ? `${block}\n` : `${current.trimEnd()}\n\n${block}\n`;
}

function tomlString(value: string): string {
    return JSON.stringify(value);
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function chooseFolder(): Promise<WorkspaceFolder | undefined> {
    const open = vscode.workspace.workspaceFolders ?? [];
    if (open.length === 1) return open[0];
    if (open.length > 1) {
        return vscode.window.showWorkspaceFolderPick({
            placeHolder: 'tonto creates the ontology file at this folder’s root'
        });
    }
    const selected = await vscode.window.showOpenDialog({
        title: 'Choose a folder for the tonto model',
        openLabel: 'Create Model Here',
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false
    });
    const uri = selected?.[0];
    return uri ? { uri, name: path.basename(uri.fsPath), index: 0 } : undefined;
}

async function exists(uri: Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

async function openDocument(uri: Uri): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
}
