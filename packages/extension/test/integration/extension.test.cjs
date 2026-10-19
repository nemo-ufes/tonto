/**
 * The extension as an editor runs it: activated by a workspace with a model,
 * talking to its language server, offering its tools to VS Code's agents, and
 * setting up Codex and Claude so that what it writes actually runs. Each of
 * these was checked only by reading until now; none of them can be reached
 * from the language package's tests.
 */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { existsSync, readFileSync, unlinkSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const workspace = process.env.TONTO_TEST_WORKSPACE;
const hiring = vscode.Uri.file(path.join(workspace, 'hiring.tonto'));
const extension = () => vscode.extensions.getExtension('nemo-ufes.tonto-vscode');

/** Polls until `check` returns something, or fails after `ms`. */
async function eventually(check, ms = 60_000, what = 'the condition') {
    const end = Date.now() + ms;
    for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
        await new Promise(resolve => setTimeout(resolve, 250));
    }
}

const codeOf = diagnostic => typeof diagnostic.code === 'object' ? String(diagnostic.code.value) : String(diagnostic.code);

async function invoke(name, input = {}) {
    const result = await vscode.lm.invokeTool(name, { input, toolInvocationToken: undefined },
        new vscode.CancellationTokenSource().token);
    return result.content.map(part => part.value ?? '').join('');
}

/** `${NAME:-default}`, as Claude Code expands it, with nothing set. */
const expand = text => text.replace(/\$\{[A-Z_]+:-([^}]*)\}/g, '$1');

/** Runs a command line as Claude Code would, feeding it `input`. */
function runShell(command, input, env) {
    return new Promise((resolve, reject) => {
        const child = spawn('sh', ['-c', command], { cwd: workspace, env: { ...process.env, ...env } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', code => resolve({ code, stdout, stderr }));
        child.stdin.end(input);
    });
}

describe('the tonto extension in VS Code', () => {
    before(async () => {
        await eventually(() => extension(), 30_000, 'the extension to be installed');
        await extension().activate();
    });

    it('activates for a workspace with a model', () => {
        assert.equal(extension().isActive, true);
    });

    it('reports the language server\'s diagnostics in the Problems panel', async () => {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(hiring));
        const codes = await eventually(() => {
            const found = vscode.languages.getDiagnostics(hiring).map(codeOf);
            return found.includes('role-without-relator') && found;
        }, 90_000, 'role-without-relator on hiring.tonto');
        assert.ok(codes.includes('role-without-relator'));
    });

    it('offers every agent tool it declares', async () => {
        const declared = extension().packageJSON.contributes.languageModelTools.map(tool => tool.name);
        assert.ok(declared.length >= 17, `only ${declared.length} tools declared`);
        const offered = await eventually(() => {
            const names = vscode.lm.tools.map(tool => tool.name);
            return declared.every(name => names.includes(name)) && names;
        }, 30_000, 'the tonto tools to be registered');
        for (const name of declared) assert.ok(offered.includes(name), `${name} is not offered`);
    });

    it('validates the active model when a tool names no file', async () => {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(hiring));
        const unrelated = vscode.Uri.file(path.join(workspace, 'unrelated.tonto'));
        writeFileSync(unrelated.fsPath, 'ontology unrelated\nkind Student specializes Missing\n');
        try {
            const text = await invoke('tonto_validate');
            assert.match(text, /role-without-relator/);
            assert.doesNotMatch(text, /Missing/);
            assert.doesNotMatch(text, /^tonto tool error/);
        } finally {
            unlinkSync(unrelated.fsPath);
        }
    });

    it('refuses a model with unsaved changes rather than read it stale', async () => {
        const document = await vscode.workspace.openTextDocument(hiring);
        await vscode.window.showTextDocument(document);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(hiring, new vscode.Position(document.lineCount, 0), 'kind Organization\n');
        await vscode.workspace.applyEdit(edit);
        try {
            assert.equal(document.isDirty, true);
            assert.match(await invoke('tonto_validate', { paths: ['hiring.tonto'] }),
                /^tonto tool error: Save the changed tonto file first: hiring\.tonto/);
        } finally {
            await vscode.commands.executeCommand('workbench.action.files.revert');
        }
        assert.equal(document.isDirty, false);
    });

    describe('setting up Codex and Claude', () => {
        before(async () => {
            await vscode.commands.executeCommand('tonto.addAgentInstructions');
            await eventually(() => existsSync(path.join(workspace, '.claude', 'settings.json')), 30_000, 'the agent setup');
        });

        it('writes the instructions and both agents\' configuration', () => {
            assert.match(readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8'), /<!-- tonto-model-instructions -->/);
            assert.equal(readFileSync(path.join(workspace, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
            assert.match(readFileSync(path.join(workspace, '.codex', 'config.toml'), 'utf8'), /tonto/);
            const mcp = JSON.parse(readFileSync(path.join(workspace, '.mcp.json'), 'utf8'));
            assert.ok(mcp.mcpServers['tonto-vscode']);
        });

        it('configures an MCP server that starts and lists the tools', async function () {
            const server = JSON.parse(readFileSync(path.join(workspace, '.mcp.json'), 'utf8')).mcpServers['tonto-vscode'];
            const child = spawn(expand(server.command), server.args.map(expand),
                { cwd: workspace, env: { ...process.env, ...server.env } });
            try {
                const replies = new Map();
                let buffer = '';
                child.stdout.on('data', chunk => {
                    buffer += chunk;
                    let newline;
                    while ((newline = buffer.indexOf('\n')) >= 0) {
                        const line = buffer.slice(0, newline);
                        buffer = buffer.slice(newline + 1);
                        try { const message = JSON.parse(line); if (message.id) replies.set(message.id, message); } catch { /* Not ours. */ }
                    }
                });
                const send = message => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
                send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {},
                    clientInfo: { name: 'tonto-integration-test', version: '0' } } });
                await eventually(() => replies.get(1), 30_000, 'the MCP server to initialize');
                send({ method: 'notifications/initialized' });
                send({ id: 2, method: 'tools/list' });
                const listed = await eventually(() => replies.get(2), 30_000, 'the MCP tool list');
                const names = listed.result.tools.map(tool => tool.name);
                const declared = extension().packageJSON.contributes.languageModelTools.map(tool => tool.name);
                assert.deepEqual([...names].sort(), [...declared].sort());
            } finally {
                child.kill();
            }
        });

        it('installs a Claude Code hook that runs and blocks a broken edit', async function () {
            if (process.platform === 'win32') this.skip();
            const settings = JSON.parse(readFileSync(path.join(workspace, '.claude', 'settings.json'), 'utf8'));
            const entry = settings.hooks.PostToolUse.find(one => one.hooks.some(hook => hook.command.includes('tonto-hook')));
            assert.equal(entry.matcher, 'Edit|MultiEdit|Write');
            const broken = path.join(workspace, 'broken.tonto');
            writeFileSync(broken, 'ontology broken\n\nkind A specializes Missing\n');
            const event = { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: broken }, cwd: workspace };
            const { code, stdout, stderr } = await runShell(entry.hooks[0].command, JSON.stringify(event),
                { CLAUDE_PROJECT_DIR: workspace });
            assert.equal(code, 0, stderr);
            const answer = JSON.parse(stdout);
            assert.equal(answer.decision, 'block');
            assert.match(answer.reason, /broken\.tonto has \d+ errors? after this edit/);
        });

        it('and running it again changes nothing', async () => {
            const before = ['AGENTS.md', '.mcp.json', '.claude/settings.json', '.codex/config.toml']
                .map(file => readFileSync(path.join(workspace, file), 'utf8'));
            await vscode.commands.executeCommand('tonto.addAgentInstructions');
            const after = ['AGENTS.md', '.mcp.json', '.claude/settings.json', '.codex/config.toml']
                .map(file => readFileSync(path.join(workspace, file), 'utf8'));
            assert.deepEqual(after, before);
        });
    });
});
