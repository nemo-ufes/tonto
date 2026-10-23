import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { collectFiles, TontoSession, workspaceRootOf } from '../api.js';
import type { NewOntologyResult } from '../api.js';
import { CLI_HOOK_COMMAND, hasClaudeHook, withClaudeHook } from '../agent-hook.js';
import { defaultOntologyName, instructionsIn, withAgentsImport, withTontoInstructions } from '../onboarding.js';

/**
 * `tonto init`: a folder set up for coding agents with the installed CLI
 * alone, and a first ontology when it has none.
 *
 * The editor's Set Up Codex and Claude does this with the tools the extension
 * serves. Outside the editor there are none, so the instructions are the ones
 * written for the CLI, and Claude Code's hook runs the CLI too. Codex and
 * Claude Code both read `AGENTS.md`; `CLAUDE.md` imports it. Everything here
 * can be run again: what is already there is kept, tonto's own block is
 * brought up to date, and nothing else in a file is touched.
 */

export interface InitResult {
    folder: string;
    /** Files written, relative to the folder. */
    changed: string[];
    /** Files left as they were because the editor's setup is already in them. */
    kept: string[];
    ontology?: NewOntologyResult;
}

export interface InitOptions {
    /** The first ontology's name; by default the folder's. `false` writes none. */
    ontology?: string | false;
}

/** The CLI's agent instructions, read when they are written rather than when this module loads. */
export function cliInstructions(): string {
    return readFileSync(new URL('../../templates/agent-instructions.md', import.meta.url), 'utf8');
}

export async function initWorkspace(folder: string, options: InitOptions = {}): Promise<InitResult> {
    const root = resolve(folder);
    mkdirSync(root, { recursive: true });
    // Everything read, and the ontology written, before any agent file: a
    // settings file that is not JSON, or a name the ontology refuses, stops
    // the setup before it has written half of itself.
    const settingsFile = join(root, '.claude', 'settings.json');
    const settings = readJsonObject(settingsFile);
    let ontology: NewOntologyResult | undefined;
    if (options.ontology !== false && (options.ontology !== undefined || collectFiles([root]).length === 0)) {
        const session = new TontoSession({ workspace: workspaceRootOf(root) });
        ontology = await session.newOntology(options.ontology ?? defaultOntologyName(root), root);
    }
    const changed: string[] = [];
    const kept: string[] = [];

    const agents = readText(join(root, 'AGENTS.md'));
    if (instructionsIn(agents) === 'editor') {
        // The editor's block has a section for the CLI already.
        kept.push('AGENTS.md');
    } else if (write(root, 'AGENTS.md', agents, withTontoInstructions(agents, cliInstructions()))) {
        changed.push('AGENTS.md');
    }

    const claude = readText(join(root, 'CLAUDE.md'));
    if (write(root, 'CLAUDE.md', claude, withAgentsImport(claude))) changed.push('CLAUDE.md');

    if (hasClaudeHook(settings, CLI_HOOK_COMMAND)) {
        // Ours, and up to date already.
    } else if (hasClaudeHook(settings)) {
        kept.push('.claude/settings.json');
    } else {
        write(root, '.claude/settings.json', '', `${JSON.stringify(withClaudeHook(settings, CLI_HOOK_COMMAND), undefined, 2)}\n`);
        changed.push('.claude/settings.json');
    }
    return { folder: root, changed, kept, ...(ontology ? { ontology } : {}) };
}

function readText(path: string): string {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** Writes `revised` where it differs from `current`; whether it did. */
function write(root: string, file: string, current: string, revised: string): boolean {
    if (revised === current) return false;
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, revised);
    return true;
}

function readJsonObject(path: string): Record<string, unknown> {
    const text = readText(path);
    if (text.trim().length === 0) return {};
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (error) {
        throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path} must hold a JSON object.`);
    return value as Record<string, unknown>;
}
