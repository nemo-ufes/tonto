/**
 * How an agent run is scored, apart from running it: what the agent's event
 * stream shows it did, and whether that and the final model make a pass. A
 * live run costs money and minutes, and its scoring was checked by reading;
 * kept here, it is tested against recorded and made-up streams in
 * packages/language/test/agent-evals.test.ts, and every change to it is.
 *
 * Three streams are read: Claude Code's stream-json, Codex's exec --json, and
 * Copilot CLI's JSON. Each says when a tool call started and when it
 * completed, and the order of those is what matters -- a validation started
 * before a write completed checked the model before the write.
 */

/** The events of a JSON-lines stream; a line that is not JSON is skipped. */
export function parseEvents(stdout) {
    return stdout.split('\n').filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
    });
}

export const cliCheck = /\btonto\s+check\b/;

/**
 * Whether a shell command writes a model, as an agent's edit. A redirect to
 * any file was counted before, so saving a check's JSON report was an edit
 * after the check. A tonto check is never one, though --fix writes: what it
 * reports is the model as it left it.
 */
export function writesModel(command) {
    return typeof command === 'string' && !cliCheck.test(command)
        && (/(?:^|[\s;|&])>{1,2}\s*['"]?[^\s'";|&]*\.tonto\b/.test(command)
            || /\b(?:tee|cp|mv|sed\s+-i|perl\s+-\w*i|python3?|node|apply_patch)\b[^;|&]*\.tonto\b/.test(command));
}

/** What the transcript shows: the tonto tools and commands that ran, the edits, and the validation after them. */
export function scoreTranscript(events, { agentInterface }) {
    const observedModels = [...new Set(events.flatMap(event =>
        [event.message?.model, event.data?.model, event.model].filter(value => typeof value === 'string' && value.length > 0)))];
    const calls = [];
    const attempted = [];
    const commandsRun = [];
    const successfulCliCommands = [];
    const claudeUses = new Map();
    const copilotUses = new Map();
    const codexUses = new Map();
    const codexCommands = new Map();
    let editRevision = 0;
    // The edit revision each successful tonto_validate started at. It counts
    // only if no edit completed after it started.
    const validatedAt = [];
    for (const event of events) {
        if (event.type === 'assistant') {
            for (const part of event.message?.content ?? []) {
                if (part.type !== 'tool_use') continue;
                if (typeof part.name === 'string') {
                    attempted.push(part.name);
                    claudeUses.set(part.id, {
                        name: part.name, editRevision,
                        command: part.name === 'Bash' ? part.input?.command : undefined,
                        writes: part.name === 'Bash' && writesModel(part.input?.command)
                    });
                }
                if (part.name === 'Bash' && typeof part.input?.command === 'string') commandsRun.push(part.input.command);
            }
        }
        if (event.type === 'user') {
            for (const part of event.message?.content ?? []) {
                if (part.type !== 'tool_result' || part.is_error) continue;
                const use = claudeUses.get(part.tool_use_id);
                if (use) {
                    calls.push(use.name);
                    if (['Edit', 'Write', 'MultiEdit'].includes(use.name) || use.writes) editRevision++;
                    if (use.name.endsWith('tonto_validate')) validatedAt.push(use.editRevision);
                    if (use.command?.includes('tonto ')) successfulCliCommands.push({ command: use.command, editRevision: use.editRevision });
                }
            }
        }
        if (event.type === 'item.started' && event.item?.type === 'mcp_tool_call') {
            attempted.push(event.item.tool ?? event.item.name ?? '');
            codexUses.set(event.item.id, editRevision);
        }
        if (event.type === 'item.started' && event.item?.type === 'command_execution') {
            codexCommands.set(event.item.id, editRevision);
        }
        if (event.type === 'item.completed') {
            if (event.item?.type === 'file_change' && event.item.status === 'completed') editRevision++;
            if (event.item?.type === 'mcp_tool_call' && event.item.status === 'completed' && !event.item.error) {
                const name = event.item.tool ?? event.item.name ?? '';
                calls.push(name);
                if (name.endsWith('tonto_validate')) validatedAt.push(codexUses.get(event.item.id));
            }
            if (event.item?.type === 'command_execution' && typeof event.item.command === 'string') {
                commandsRun.push(event.item.command);
                // Counted whatever the exit: a later command in the line may fail after the write.
                if (writesModel(event.item.command)) editRevision++;
                // A later command in one shell line may fail after a clean tonto JSON result.
                const checkedCleanly = /"diagnostics"\s*:\s*\[\s*\]/.test(event.item.aggregated_output ?? '')
                    && /"error"\s*:\s*0/.test(event.item.aggregated_output ?? '');
                if ((event.item.exit_code === 0 || checkedCleanly) && event.item.command.includes('tonto '))
                    successfulCliCommands.push({ command: event.item.command, editRevision: codexCommands.get(event.item.id) });
            }
        }
        if (event.type === 'tool.execution_start') {
            const name = event.data?.toolName;
            if (typeof name === 'string') {
                copilotUses.set(event.data.toolCallId, {
                    name, editRevision,
                    command: name === 'bash' ? event.data?.arguments?.command : undefined,
                    writes: name === 'bash' && writesModel(event.data?.arguments?.command)
                });
                attempted.push(name);
            }
        }
        if (event.type === 'tool.execution_complete' && event.data?.success === true) {
            const use = copilotUses.get(event.data.toolCallId);
            if (use) {
                calls.push(use.name);
                if (['create', 'edit', 'write'].includes(use.name) || use.writes) editRevision++;
                if (use.name.endsWith('tonto_validate')) validatedAt.push(use.editRevision);
                if (use.command?.includes('tonto ')) successfulCliCommands.push({ command: use.command, editRevision: use.editRevision });
            }
        }
    }
    const tontoTool = /tonto_(guide|validate|patterns|rules|apply|diff|format)$/;
    const observedTontoTools = [...new Set(calls.filter(name => tontoTool.test(name)))];
    const attemptedTontoTools = [...new Set(attempted.filter(name => tontoTool.test(name)))];
    const observedAnyTontoTools = [...new Set(calls.filter(name => /tonto_[a-z_]+$/.test(name)))];
    const observedCliCommands = [...new Set(successfulCliCommands.flatMap(({ command }) =>
        [...command.matchAll(/\btonto\s+(guide|check|patterns|rules|format|explain|ast|ontologies)\b/g)].map(match => match[1])))];
    const validationObserved = agentInterface === 'cli'
        ? observedCliCommands.includes('check')
        : observedTontoTools.some(name => name.endsWith('tonto_validate'))
            || commandsRun.some(command => cliCheck.test(command));
    // Validated after the last edit, by either interface: validating once
    // after the first of two edits leaves the second unchecked.
    const validationAfterEdit = editRevision > 0 && (agentInterface === 'cli'
        ? successfulCliCommands.some(use => use.editRevision === editRevision && cliCheck.test(use.command))
        : validatedAt.includes(editRevision));
    // The tonto hook is the fixture's only PostToolUse hook; it says nothing
    // about a clean edit, so an answer is an edit it found diagnostics in.
    const hookResponses = events.filter(event => event.type === 'system' && event.subtype === 'hook_response'
        && event.hook_event === 'PostToolUse');
    const hook = { runs: hookResponses.length, answers: hookResponses.filter(event => (event.stdout ?? '').trim() !== '').length };
    return {
        observedModels, attemptedTontoTools, observedTontoTools, observedAnyTontoTools, observedCliCommands,
        validationObserved, validationAfterEdit, edits: editRevision, hook
    };
}

/**
 * The verdict. The model passes when the agent finished, the independent
 * check is clean, the expected structure is there and the codes the case is
 * about are gone; the run passes when, besides, the agent validated after its
 * last edit -- and, over the CLI, used no tonto tool, which would mean the
 * isolation failed.
 */
export function verdict({ transcript, agentInterface, agentExit, validatorExit, diagnostics, expected, unresolved }) {
    const modelPass = agentExit === 0 && validatorExit === 0 && diagnostics.length === 0
        && expected.every(check => check.pass) && unresolved.length === 0;
    return {
        modelPass,
        pass: modelPass && transcript.validationObserved && transcript.validationAfterEdit
            && (agentInterface !== 'cli' || transcript.observedAnyTontoTools.length === 0)
    };
}
