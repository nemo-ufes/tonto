import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { claudeHookAnswer, withClaudeHook } from '../src/agent-hook.js';

/** A project with one file, and the event Claude Code sends after editing it. */
function edited(source: string, tool = 'Edit', name = 'shop.tonto'): { event: unknown; project: string } {
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'tonto-hook-')));
    writeFileSync(join(project, name), source);
    return { project, event: { hook_event_name: 'PostToolUse', tool_name: tool, tool_input: { file_path: join(project, name) }, cwd: project } };
}

describe('the Claude Code hook that validates each edit', () => {
    test('blocks an edit that leaves errors, saying what they are and how to repair them', async () => {
        const { event, project } = edited('ontology shop\nkind Person\nkind Student specializes Person\n');
        const answer = await claudeHookAnswer(event, project);
        expect(answer?.decision).toBe('block');
        expect(answer?.reason).toMatch(/^shop\.tonto has 1 error after this edit:\n3:\d+ {2}error {2}stereotype-cannot-specialize/);
        expect(answer?.reason).toContain('tonto_apply');
    });

    test('adds warnings as context, and says nothing of a clean file', async () => {
        const warned = edited('ontology shop\n/// @version 1\nkind Person\n', 'Write');
        expect(await claudeHookAnswer(warned.event, warned.project)).toEqual({
            hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: expect.stringMatching(/^shop\.tonto validates, with 1 warning:\n.*ontology-tag-not-on-header/) }
        });
        const clean = edited('ontology shop\nkind Person\n', 'MultiEdit');
        expect(await claudeHookAnswer(clean.event, clean.project)).toBeUndefined();
    });

    test('checks a file with the rest of its ontology, and reports only that file', async () => {
        const { project } = edited('ontology shop bundles\n    core from <core.tonto>\n');
        writeFileSync(join(project, 'core.tonto'), 'package core in shop\nkind Person\nkind Person\n');
        writeFileSync(join(project, 'other.tonto'), 'ontology other\nkind Thing\nkind Thing\n');
        const answer = await claudeHookAnswer({ tool_name: 'Edit', tool_input: { file_path: 'core.tonto' }, cwd: project }, project);
        expect(answer?.reason).toMatch(/^core\.tonto has/);
        expect(answer?.reason).not.toContain('Thing');
    });

    test('leaves other tools and other files alone', async () => {
        const { event, project } = edited('ontology shop\nkind Student specializes Person\n');
        expect(await claudeHookAnswer({ ...(event as object), tool_name: 'Read' }, project)).toBeUndefined();
        expect(await claudeHookAnswer({ tool_name: 'Edit', tool_input: { file_path: join(project, 'notes.md') } }, project)).toBeUndefined();
        expect(await claudeHookAnswer('not an event', project)).toBeUndefined();
    });

    test('is added to Claude Code\'s settings beside what is there, replacing an earlier one', () => {
        const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] };
        const first = withClaudeHook({ model: 'opus', hooks: { PostToolUse: [mine], Stop: [] } }, 'node /old/tonto-hook.mjs');
        const second = withClaudeHook(first, 'node /new/tonto-hook.mjs');
        expect(second).toEqual({
            model: 'opus',
            hooks: { Stop: [], PostToolUse: [mine, { matcher: 'Edit|MultiEdit|Write', hooks: [{ type: 'command', command: 'node /new/tonto-hook.mjs', timeout: 60 }] }] }
        });
    });
});
