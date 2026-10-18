import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
// The live agent evaluations' scoring, which runs nothing and costs nothing to test.
// @ts-expect-error -- a plain ES module of the evaluations, not part of this package.
import { parseEvents, scoreTranscript, verdict, writesModel } from '../../../evals/agents/score.mjs';

type Event = Record<string, unknown>;
interface Transcript {
    validationObserved: boolean; validationAfterEdit: boolean; edits: number;
    observedTontoTools: string[]; attemptedTontoTools: string[]; observedAnyTontoTools: string[];
    observedCliCommands: string[]; observedModels: string[]; hook: { runs: number; answers: number };
}
const score = scoreTranscript as (events: Event[], options: { agentInterface: string }) => Transcript;

const recorded = (name: string): Event[] =>
    parseEvents(readFileSync(new URL(`../../../evals/agents/fixtures/${name}`, import.meta.url), 'utf8'));

/** Claude Code's stream: a tool use, and later its result. */
const claude = {
    use: (id: string, name: string, command?: string): Event =>
        ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: command ? { command } : {} }] } }),
    result: (id: string, isError = false): Event =>
        ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] } })
};
const validate = 'mcp__tonto-vscode__tonto_validate';

/** Codex's stream: items that start and complete. */
const codex = {
    started: (id: string, item: Event): Event => ({ type: 'item.started', item: { id, ...item } }),
    completed: (id: string, item: Event): Event => ({ type: 'item.completed', item: { id, status: 'completed', ...item } })
};

/** Copilot CLI's stream: executions that start and complete. */
const copilot = {
    start: (id: string, toolName: string, command?: string): Event =>
        ({ type: 'tool.execution_start', data: { toolCallId: id, toolName, arguments: command ? { command } : {} } }),
    complete: (id: string, success = true): Event => ({ type: 'tool.execution_complete', data: { toolCallId: id, success } })
};

describe('scoring a recorded Claude Code run', () => {
    test('the repair run validated after its edit, and the hook ran on it', () => {
        const transcript = score(recorded('claude-mcp-repair.jsonl'), { agentInterface: 'mcp' });
        expect(transcript).toMatchObject({ edits: 1, validationObserved: true, validationAfterEdit: true,
            hook: { runs: 1, answers: 0 }, observedModels: ['claude-opus-5-5'] });
        // A denied or failed call is attempted, not observed: tonto_patterns was asked a name it has not.
        expect(transcript.attemptedTontoTools).toContain('mcp__tonto-vscode__tonto_patterns');
        expect(transcript.observedTontoTools).not.toContain('mcp__tonto-vscode__tonto_patterns');
    });

    test('the split-workspace run did too', () => {
        expect(score(recorded('claude-mcp-workspace.jsonl'), { agentInterface: 'mcp' }))
            .toMatchObject({ edits: 1, validationAfterEdit: true, hook: { runs: 1 } });
    });
});

describe('validation after the last edit', () => {
    test('a validation started beside a write checked the model before it', () => {
        const events = [claude.use('w', 'Write'), claude.use('v', validate), claude.result('v'), claude.result('w')];
        expect(score(events, { agentInterface: 'mcp' }).validationAfterEdit).toBe(false);
    });

    test('a validation after the first of two edits leaves the second unchecked', () => {
        const events = [claude.use('e1', 'Edit'), claude.result('e1'), claude.use('v', validate), claude.result('v'),
            claude.use('e2', 'Edit'), claude.result('e2')];
        expect(score(events, { agentInterface: 'mcp' })).toMatchObject({ edits: 2, validationAfterEdit: false });
    });

    test('and one after the last edit counts', () => {
        const events = [claude.use('e1', 'Edit'), claude.result('e1'), claude.use('e2', 'Edit'), claude.result('e2'),
            claude.use('v', validate), claude.result('v')];
        expect(score(events, { agentInterface: 'mcp' }).validationAfterEdit).toBe(true);
    });

    test('a failed validation is not one', () => {
        const events = [claude.use('e', 'Edit'), claude.result('e'), claude.use('v', validate), claude.result('v', true)];
        expect(score(events, { agentInterface: 'mcp' })).toMatchObject({ validationObserved: false, validationAfterEdit: false });
    });

    test('a run with no edit has validated nothing after one', () => {
        const events = [claude.use('v', validate), claude.result('v')];
        expect(score(events, { agentInterface: 'mcp' }).validationAfterEdit).toBe(false);
    });

    test('Codex: a file change, then the tool', () => {
        const events = [codex.completed('f', { type: 'file_change' }),
            codex.started('v', { type: 'mcp_tool_call', tool: 'tonto_validate' }),
            codex.completed('v', { type: 'mcp_tool_call', tool: 'tonto_validate' })];
        expect(score(events, { agentInterface: 'mcp' })).toMatchObject({ edits: 1, validationAfterEdit: true });
    });

    test('Copilot: a validation started before the write completed does not count', () => {
        const events = [copilot.start('w', 'edit'), copilot.start('v', 'tonto-vscode-tonto_validate'),
            copilot.complete('v'), copilot.complete('w')];
        expect(score(events, { agentInterface: 'mcp' }).validationAfterEdit).toBe(false);
    });
});

describe('over the CLI', () => {
    test('a shell write is an edit, and a check after it counts', () => {
        const events = [claude.use('w', 'Bash', 'cat > hiring.tonto <<EOF\nontology hiring\nEOF'), claude.result('w'),
            claude.use('c', 'Bash', 'tonto check hiring.tonto --json'), claude.result('c')];
        expect(score(events, { agentInterface: 'cli' }))
            .toMatchObject({ edits: 1, observedCliCommands: ['check'], validationAfterEdit: true });
    });

    test('saving a check\'s report is not an edit after the check', () => {
        const events = [claude.use('e', 'Edit'), claude.result('e'),
            claude.use('c', 'Bash', 'tonto check hiring.tonto --json > report.json'), claude.result('c')];
        expect(score(events, { agentInterface: 'cli' })).toMatchObject({ edits: 1, validationAfterEdit: true });
    });

    test('Codex: a clean check followed by a failing command in one line still counts', () => {
        const command = 'tonto check hiring.tonto --json && git diff';
        const events = [codex.completed('f', { type: 'file_change' }),
            codex.started('c', { type: 'command_execution', command }),
            codex.completed('c', { type: 'command_execution', command, exit_code: 1,
                aggregated_output: '{"diagnostics": [], "summary": {"files": 1, "error": 0}}' })];
        expect(score(events, { agentInterface: 'cli' }).validationAfterEdit).toBe(true);
    });

    test('a tonto tool used over the CLI interface fails the isolation', () => {
        const transcript = score([claude.use('e', 'Edit'), claude.result('e'), claude.use('v', validate), claude.result('v'),
            claude.use('c', 'Bash', 'tonto check m.tonto --json'), claude.result('c')], { agentInterface: 'cli' });
        const result = verdict({ transcript, agentInterface: 'cli', agentExit: 0, validatorExit: 0,
            diagnostics: [], expected: [{ pass: true }], unresolved: [] }) as { modelPass: boolean; pass: boolean };
        expect(result).toEqual({ modelPass: true, pass: false });
    });
});

describe('what counts as writing a model', () => {
    test.each([
        ['cat > hiring.tonto <<EOF', true],
        ['echo x >> a.tonto', true],
        ['sed -i "" s/a/b/ sales.tonto', true],
        ['tonto format a.tonto > a.tmp && mv a.tmp a.tonto', true],
        ['cat a.tonto', false],
        ['tonto check a.tonto --json > out.json', false],
        ['tonto check a.tonto --fix=parthood-without-diamond', false],
        ['git diff 2>&1', false]
    ])('%s', (command, writes) => {
        expect(writesModel(command)).toBe(writes);
    });
});

describe('the verdict', () => {
    const transcript = { validationObserved: true, validationAfterEdit: true, observedAnyTontoTools: [] };
    const passing = { transcript, agentInterface: 'mcp', agentExit: 0, validatorExit: 0, diagnostics: [],
        expected: [{ pass: true }], unresolved: [] };

    test('needs a clean model with the expected structure', () => {
        expect(verdict(passing)).toEqual({ modelPass: true, pass: true });
        expect(verdict({ ...passing, diagnostics: [{ code: 'role-without-relator' }] }).pass).toBe(false);
        expect(verdict({ ...passing, expected: [{ pass: false }] }).pass).toBe(false);
        expect(verdict({ ...passing, unresolved: ['parthood-without-diamond'] }).pass).toBe(false);
        expect(verdict({ ...passing, agentExit: 1 }).pass).toBe(false);
    });

    test('and a model that is right is still no pass without validation after the edit', () => {
        expect(verdict({ ...passing, transcript: { ...transcript, validationAfterEdit: false } }))
            .toEqual({ modelPass: true, pass: false });
    });
});
