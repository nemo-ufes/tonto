/**
 * The program Claude Code runs after each file edit (agent-hook.ts): it reads
 * the event from standard input and prints what Claude should hear. A failure
 * here is the hook's, not the edit's, so it is reported to the user and never
 * blocks Claude.
 */
import { runClaudeHook } from './agent-hook.js';

runClaudeHook().catch(error => {
    process.stderr.write(`tonto's validation hook failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
