// Installs the package `npm run package` just wrote into the local VS Code,
// to see the extension as a user gets it: a file the .vsix leaves out, the
// Details tab, the servers running from the installed location. For anything
// else, F5 is the faster loop.
//
// `code` is VS Code's command-line launcher; TONTO_VSCODE_CLI names another,
// such as `code-insiders` or `cursor`. Not VSCODE_CLI: VS Code's integrated
// terminal sets that to "1" for its own use, and running "1" fails.
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = new URL('.', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', directory), 'utf8'));
const vsix = fileURLToPath(new URL(`tonto-${pkg.version}.vsix`, directory));
if (!existsSync(vsix)) {
    console.error(`${basename(vsix)} does not exist; run "npm run package" first.`);
    process.exit(1);
}

// On Windows the launcher is a .cmd script, which Node runs only through a
// shell -- and a shell splits an unquoted path at its spaces.
const windows = process.platform === 'win32';
const cli = process.env.TONTO_VSCODE_CLI || 'code';
const args = [];
if (process.env.VSCODE_USER_DATA_DIR) args.push('--user-data-dir', process.env.VSCODE_USER_DATA_DIR);
if (process.env.VSCODE_EXTENSIONS_DIR) args.push('--extensions-dir', process.env.VSCODE_EXTENSIONS_DIR);
args.push('--install-extension', vsix, '--force');
const run = spawnSync(cli, windows ? args.map(argument => `"${argument.replaceAll('"', '\\"')}"`) : args,
    { stdio: 'inherit', shell: windows });
if (run.error) {
    console.error(`Could not run "${cli}" (${run.error.message}). In VS Code, run "Shell Command: Install 'code' command in PATH", or set TONTO_VSCODE_CLI.`);
    process.exit(1);
}
if (run.status !== 0) {
    process.exit(run.status ?? 1);
}
console.log('Installed. Run "Developer: Reload Window" in each open VS Code window to load it,');
console.log('then restart each agent\'s tonto MCP server: /mcp in Claude Code, or a new Codex session.');
