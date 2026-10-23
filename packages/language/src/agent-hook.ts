import { existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { TontoSession, workspaceRootOf } from './api.js';
import { renderDiagnostics } from './tools.js';
import { canonicalRealPath } from './utils/paths.js';

/**
 * Claude Code's PostToolUse hook for tonto: after Claude edits a `.tonto`
 * file, the file is validated, and what is wrong goes back to Claude at once.
 *
 * "Validate after every edit" is in the agent instructions, and an agent can
 * forget an instruction -- late in a long session, or sure of an edit. A hook
 * cannot be forgotten: it runs on every edit, whatever the agent remembers.
 * Errors block, which returns them to Claude as the edit's outcome; warnings
 * are added as context; a clean file says nothing, so a good edit costs no
 * tokens. Hints, which are what a model has not said yet, are left to
 * tonto_validate.
 */

/** The tools whose edits are checked: Claude Code's file-writing tools. */
export const CLAUDE_HOOK_MATCHER = 'Edit|MultiEdit|Write';

/** What the hook prints for Claude Code to read, when there is anything to say. */
export interface ClaudeHookAnswer {
    decision?: 'block';
    reason?: string;
    hookSpecificOutput?: { hookEventName: 'PostToolUse'; additionalContext: string };
}

/**
 * How Claude is told to go on from an error: with the tools, where the
 * editor's setup serves them, or with the CLI, where `tonto init` set the
 * folder up and there are no tools to name.
 */
const NEXT = {
    tools: 'Repair them before going on: read a code with tonto_rules, and take a repair with tonto_apply.',
    cli: 'Repair them before going on: read a code with `tonto rules <code>`, and see each repair\'s edits with '
        + '`tonto check <file> --json`.'
} as const;

/** The answer to one PostToolUse event, or nothing for an edit of another file or a clean one. */
export async function claudeHookAnswer(
    event: unknown, project = process.env.CLAUDE_PROJECT_DIR, setup: keyof typeof NEXT = 'tools'
): Promise<ClaudeHookAnswer | undefined> {
    if (typeof event !== 'object' || event === null) return undefined;
    const { tool_name: tool, tool_input: input, cwd } = event as { tool_name?: unknown; tool_input?: { file_path?: unknown }; cwd?: unknown };
    if (typeof tool !== 'string' || !new RegExp(`^(${CLAUDE_HOOK_MATCHER})$`).test(tool)) return undefined;
    const given = input?.file_path;
    if (typeof given !== 'string' || !given.endsWith('.tonto')) return undefined;
    const base = typeof cwd === 'string' ? cwd : project ?? process.cwd();
    const file = isAbsolute(given) ? given : resolve(base, given);
    if (!existsSync(file)) return undefined;
    const real = canonicalRealPath(file);
    // The project bounds the walk up to the workspace, as the editor's folder does.
    const boundary = project && existsSync(project) && inside(canonicalRealPath(project), real) ? canonicalRealPath(project) : dirname(real);
    const workspace = workspaceRootOf(real, boundary);
    const reported = await new TontoSession({ workspace }).validateFiles([real]);
    const own = reported.filter(diagnostic => sameFile(diagnostic.file, real));
    const errors = own.filter(diagnostic => diagnostic.severity === 'error');
    const warnings = own.filter(diagnostic => diagnostic.severity === 'warning');
    const name = relative(workspace, real) || real;
    if (errors.length > 0) {
        return {
            decision: 'block',
            reason: `${name} has ${count(errors.length, 'error')} after this edit:\n${renderDiagnostics([...errors, ...warnings])}\n`
                + NEXT[setup]
        };
    }
    if (warnings.length > 0) {
        return {
            hookSpecificOutput: {
                hookEventName: 'PostToolUse',
                additionalContext: `${name} validates, with ${count(warnings.length, 'warning')}:\n${renderDiagnostics(warnings)}`
            }
        };
    }
    return undefined;
}

/**
 * The hook as the command line installs it, `tonto init`: the installed CLI,
 * global or this project's. `--no` makes npx refuse to download a package it
 * does not find, so the hook never runs a CLI nobody installed.
 */
export const CLI_HOOK_COMMAND = 'npx --no -- tonto hook';

/**
 * Whether a hook command is tonto's: the editor's names its staged runtime,
 * `tonto-hook.mjs`, and the command line's runs `tonto hook`. Either replaces
 * the other, so a folder set up both ways validates each edit once.
 */
function isTontoHook(command: unknown): boolean {
    return typeof command === 'string' && (command.includes('tonto-hook') || /\btonto hook\b/.test(command));
}

type PostToolUseEntry = { hooks?: Array<{ command?: unknown }> };

function postToolUse(settings: Record<string, unknown>): PostToolUseEntry[] {
    const hooks = settings.hooks;
    if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return [];
    const entries = (hooks as Record<string, unknown>).PostToolUse;
    return Array.isArray(entries) ? entries as PostToolUseEntry[] : [];
}

/** Whether Claude Code's settings already run a tonto hook: this command, or else the editor's or the command line's. */
export function hasClaudeHook(settings: Record<string, unknown>, command?: string): boolean {
    return postToolUse(settings).some(entry => entry.hooks?.some(hook =>
        command === undefined ? isTontoHook(hook.command) : hook.command === command));
}

/**
 * Claude Code's settings with tonto's PostToolUse hook in them, replacing an
 * earlier one -- found by its command -- and leaving every other setting and
 * hook as it was.
 */
export function withClaudeHook(settings: Record<string, unknown>, command: string): Record<string, unknown> {
    const hooks = typeof settings.hooks === 'object' && settings.hooks !== null && !Array.isArray(settings.hooks)
        ? { ...settings.hooks as Record<string, unknown> } : {};
    const others = postToolUse(settings).filter(entry => !entry.hooks?.some(hook => isTontoHook(hook.command)));
    hooks.PostToolUse = [...others, { matcher: CLAUDE_HOOK_MATCHER, hooks: [{ type: 'command', command, timeout: 60 }] }];
    return { ...settings, hooks };
}

function sameFile(reported: string, file: string): boolean {
    return reported === file || canonicalRealPath(reported) === file;
}

function inside(root: string, file: string): boolean {
    return file === root || file.startsWith(root + sep);
}

function count(amount: number, singular: string): string {
    return `${amount} ${singular}${amount === 1 ? '' : 's'}`;
}

/** Reads the event from standard input and prints the answer: how Claude Code runs the hook. */
export async function runClaudeHook(setup: keyof typeof NEXT = 'tools'): Promise<void> {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    let event: unknown;
    try { event = JSON.parse(text); } catch { return; }
    const answer = await claudeHookAnswer(event, undefined, setup);
    if (answer) process.stdout.write(JSON.stringify(answer));
}
