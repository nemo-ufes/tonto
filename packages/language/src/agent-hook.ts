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

/** The answer to one PostToolUse event, or nothing for an edit of another file or a clean one. */
export async function claudeHookAnswer(event: unknown, project = process.env.CLAUDE_PROJECT_DIR): Promise<ClaudeHookAnswer | undefined> {
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
                + 'Repair them before going on: read a code with tonto_rules, and take a repair with tonto_apply.'
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
 * Claude Code's settings with tonto's PostToolUse hook in them, replacing an
 * earlier one -- found by its command naming the hook runtime -- and leaving
 * every other setting and hook as it was.
 */
export function withClaudeHook(settings: Record<string, unknown>, command: string, marker = 'tonto-hook'): Record<string, unknown> {
    const hooks = typeof settings.hooks === 'object' && settings.hooks !== null && !Array.isArray(settings.hooks)
        ? { ...settings.hooks as Record<string, unknown> } : {};
    const existing = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse as Array<{ hooks?: Array<{ command?: unknown }> }> : [];
    const others = existing.filter(entry => !entry.hooks?.some(hook => typeof hook.command === 'string' && hook.command.includes(marker)));
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
export async function runClaudeHook(): Promise<void> {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    let event: unknown;
    try { event = JSON.parse(text); } catch { return; }
    const answer = await claudeHookAnswer(event);
    if (answer) process.stdout.write(JSON.stringify(answer));
}
