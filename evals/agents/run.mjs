#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEvents, scoreTranscript, verdict } from './score.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tonto = join(repository, 'packages/language/bin/tonto.js');
const server = join(repository, 'packages/mcp/out/index.js');
const hookRuntime = join(repository, 'packages/language/out/claude-hook.js');
const instructions = join(repository, 'packages/extension/templates/agent-instructions.md');
const cases = {
    draft: {
        files: { 'hiring.tonto': 'ontology hiring\n\nkind Person\nkind Organization\n' },
        prompt: 'In hiring.tonto, model Employee and Employer as roles founded by an Employment relator. Make the smallest valid tonto model, then validate the saved model.',
        expected: [{ file: 'hiring.tonto', pattern: /role Employee specializes Person/ },
            { file: 'hiring.tonto', pattern: /role Employer specializes Organization/ },
            { file: 'hiring.tonto', pattern: /relator Employment/ },
            { file: 'hiring.tonto', pattern: /@mediation[\s\S]*Employee/ },
            { file: 'hiring.tonto', pattern: /@mediation[\s\S]*Employer/ }]
    },
    repair: {
        files: { 'vehicles.tonto': 'ontology vehicles\n\nkind Bicycle\nkind Wheel\n\n@componenthood relation Bicycle [1] -- [2] Wheel\n' },
        prompt: 'In vehicles.tonto, a wheel is a component of a bicycle. Repair the parthood notation to put the diamond at the whole, preserve the intended multiplicities, and validate the saved model.',
        expected: [{ file: 'vehicles.tonto', pattern: /Bicycle[^\n]*<>--[^\n]*Wheel/ }],
        resolvedCodes: ['parthood-without-diamond']
    },
    workspace: {
        files: {
            'shop.tonto': 'ontology shop bundles\n    core from <core.tonto>\n    sales from <sales.tonto>\n',
            'core.tonto': 'package core in shop\n\nkind Person\nkind Organization\n',
            'sales.tonto': 'package sales in shop\n\nuse core\n'
        },
        prompt: 'In this existing shop ontology, add a Customer role of Person and a Purchase relator that binds a Customer and an Organization. Put declarations in the appropriate existing package file, keep the ontology structure, and validate the saved workspace.',
        expected: [{ file: 'sales.tonto', pattern: /role Customer specializes Person/ },
            { file: 'sales.tonto', pattern: /relator Purchase/ }],
        resolvedCodes: ['unnecessary-use']
    }
};

function usage() {
    throw new Error('Usage: node evals/agents/run.mjs <codex|claude|copilot|vscode> <draft|repair|workspace> [--interface=mcp|cli] [--out=DIR] [--model=ID] [--prepare-only]');
}

const [harness, caseName, ...options] = process.argv.slice(2);
if (!['codex', 'claude', 'copilot', 'vscode'].includes(harness) || !cases[caseName]) usage();
const outOption = options.find(option => option.startsWith('--out='));
const modelOption = options.find(option => option.startsWith('--model='));
const interfaceOption = options.find(option => option.startsWith('--interface='));
const agentInterface = interfaceOption?.slice('--interface='.length) ?? 'mcp';
const model = modelOption?.slice('--model='.length);
const prepareOnly = options.includes('--prepare-only');
if (options.some(option => !option.startsWith('--out=') && !option.startsWith('--model=') && !option.startsWith('--interface=') && option !== '--prepare-only')
    || modelOption && !model || !['mcp', 'cli'].includes(agentInterface) || harness === 'vscode' && interfaceOption) usage();
const run = outOption ? resolve(outOption.slice('--out='.length)) : mkdtempSync(join(tmpdir(), 'tonto-agent-eval-'));
if (existsSync(join(run, 'workspace'))) throw new Error(`Refusing to replace ${join(run, 'workspace')}`);
const workspace = join(run, 'workspace');
mkdirSync(workspace, { recursive: true });

const scenario = cases[caseName];
for (const [name, content] of Object.entries(scenario.files)) writeFileSync(join(workspace, name), content);
copyFileSync(instructions, join(workspace, 'AGENTS.md'));
if (harness !== 'vscode') {
    writeFileSync(join(workspace, 'CLAUDE.md'), '@AGENTS.md\n');
}
if (harness !== 'vscode' && agentInterface === 'mcp') {
    mkdirSync(join(workspace, '.codex'));
    writeFileSync(join(workspace, '.codex/config.toml'),
        `[mcp_servers.tonto_vscode]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(server)}, "."]\nstartup_timeout_sec = 30\n`);
    writeFileSync(join(workspace, '.mcp.json'), JSON.stringify({ mcpServers: {
        'tonto-vscode': { type: 'stdio', command: process.execPath, args: [server, workspace] }
    } }, null, 2) + '\n');
}
// What tonto: Set Up Codex and Claude in Workspace gives Claude Code: the
// validation hook beside the MCP server. A Claude run without it measured the
// instructions alone, and those tell Claude the hook is there.
const claudeHook = harness === 'claude' && agentInterface === 'mcp';
if (claudeHook) {
    const { withClaudeHook } = await import(pathToFileURL(join(repository, 'packages/language/out/agent-hook.js')).href);
    mkdirSync(join(workspace, '.claude'));
    writeFileSync(join(workspace, '.claude/settings.json'), JSON.stringify(
        withClaudeHook({}, `${JSON.stringify(process.execPath)} ${JSON.stringify(hookRuntime)}`), null, 2) + '\n');
}
if (agentInterface === 'cli' && harness !== 'vscode') {
    const bin = join(workspace, '.local-bin');
    mkdirSync(bin);
    symlinkSync(tonto, join(bin, 'tonto'));
}
writeFileSync(join(run, 'case.json'), JSON.stringify({ harness, interface: agentInterface, case: caseName, model: model ?? null, claudeHook, prompt: scenario.prompt, workspace }, null, 2) + '\n');
if (prepareOnly || harness === 'vscode') {
    process.stdout.write(`${workspace}\n`);
    process.exit(0);
}

if (!existsSync(tonto)) throw new Error(`Build the language package first; missing ${tonto}`);
if (agentInterface === 'mcp' && !existsSync(server)) throw new Error(`Build the MCP package first; missing ${server}`);
if (claudeHook && !existsSync(hookRuntime)) throw new Error(`Build the language package first; missing ${hookRuntime}`);
const commands = {
    codex: ['codex', ['exec', '--json', '--approve-for-me', '--ignore-user-config',
        ...(agentInterface === 'mcp' ? [
            '-c', `mcp_servers.tonto_vscode.command=${JSON.stringify(process.execPath)}`,
            '-c', `mcp_servers.tonto_vscode.args=[${JSON.stringify(server)}, "."]`,
            '-c', 'mcp_servers.tonto_vscode.startup_timeout_sec=30'
        ] : []),
        '--skip-git-repo-check', '--ephemeral', '--cd', workspace,
        ...(model ? ['--model', model] : []), scenario.prompt]],
    // Project settings only, so the run does not depend on whose machine it
    // is: no user hooks, plugins or MCP servers. The MCP server
    // is named outright rather than left to project approval.
    claude: ['claude', ['-p', scenario.prompt, '--output-format', 'stream-json', '--verbose', '--include-hook-events',
        '--no-session-persistence', '--setting-sources', 'project', '--permission-mode', 'acceptEdits', '--max-turns', '18',
        ...(agentInterface === 'mcp' ? ['--mcp-config', join(workspace, '.mcp.json'), '--strict-mcp-config', '--allowedTools', ['tonto_guide', 'tonto_validate', 'tonto_patterns', 'tonto_format', 'tonto_diff', 'tonto_rules', 'tonto_repair', 'tonto_apply']
            .map(name => `mcp__tonto-vscode__${name}`).join(',')] : ['--strict-mcp-config', '--allowedTools', 'Bash']),
        ...(model ? ['--model', model] : [])]],
    copilot: ['copilot', ['-p', scenario.prompt, '--output-format=json', `--share=${join(run, 'copilot-session.md')}`,
        ...(agentInterface === 'mcp' ? ['--additional-mcp-config=@.mcp.json'] : ['--disable-mcp-server=tonto-vscode']),
        '--allow-tool=read', '--allow-tool=write', '--allow-tool=shell',
        ...(agentInterface === 'mcp' ? ['--allow-tool=tonto-vscode'] : []), '--disable-builtin-mcps',
        '--no-ask-user', '--no-auto-update',
        ...(model ? ['--model', model] : [])]]
};
const [command, args] = commands[harness];
const probe = spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' });
if (probe.status !== 0) throw new Error(`${command} is not installed`);
const agentVersion = spawnSync(command, ['--version'], { encoding: 'utf8' }).stdout.trim();
const child = spawn(command, args, { cwd: workspace, env: { ...process.env,
    ...(agentInterface === 'cli' ? { PATH: `${join(workspace, '.local-bin')}:${process.env.PATH ?? ''}` } : {}),
    CLAUDE_PROJECT_DIR: workspace }, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';
child.stdout.on('data', chunk => { stdout += chunk; });
child.stderr.on('data', chunk => { stderr += chunk; });
const timer = setTimeout(() => child.kill('SIGTERM'), 300_000);
const agentExit = await new Promise((done, fail) => { child.on('close', done); child.on('error', fail); });
clearTimeout(timer);
writeFileSync(join(run, 'agent.stdout'), stdout);
writeFileSync(join(run, 'agent.stderr'), stderr);

const validation = spawnSync(process.execPath, [tonto, 'check', workspace, '--json', `--workspace=${workspace}`],
    { cwd: repository, encoding: 'utf8' });
writeFileSync(join(run, 'validation.json'), validation.stdout);
writeFileSync(join(run, 'validation.stderr'), validation.stderr);
const expected = scenario.expected.map(({ file, pattern }) => ({ file, pattern: pattern.source,
    pass: existsSync(join(workspace, file)) && pattern.test(readFileSync(join(workspace, file), 'utf8')) }));
let diagnostics = [];
try { diagnostics = JSON.parse(validation.stdout).diagnostics ?? []; } catch { /* Validator failure is reported below. */ }
const unresolved = (scenario.resolvedCodes ?? []).filter(code => diagnostics.some(diagnostic => diagnostic.code === code));
const transcript = scoreTranscript(parseEvents(stdout), { agentInterface });
const { modelPass, pass } = verdict({ transcript, agentInterface, agentExit, validatorExit: validation.status,
    diagnostics, expected, unresolved });
const { hook, ...observed } = transcript;
const report = {
    harness, interface: agentInterface, case: caseName, model: model ?? null, observedModels: observed.observedModels, agentVersion, workspace, agentExit, validatorExit: validation.status,
    valid: validation.status === 0, diagnostics: diagnostics.map(({ code, severity, file, line }) => ({ code, severity, file, line })),
    expected, unresolved,
    attemptedTontoTools: observed.attemptedTontoTools, observedTontoTools: observed.observedTontoTools,
    observedAnyTontoTools: observed.observedAnyTontoTools, observedCliCommands: observed.observedCliCommands,
    validationObserved: observed.validationObserved, validationAfterEdit: observed.validationAfterEdit, edits: observed.edits,
    ...(claudeHook ? { hook } : {}), modelPass, pass
};
writeFileSync(join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify({ run, ...report }, null, 2) + '\n');
if (!report.pass) process.exitCode = 1;
