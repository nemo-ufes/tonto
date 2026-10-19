#!/usr/bin/env node
/**
 * The extension inside a real VS Code: downloads one (cached in .vscode-test),
 * opens a fresh workspace with a model in it, and runs test/integration in
 * the extension host. Build first; this tests out/, as the .vsix ships it.
 *
 * On Linux without a display, run it under `xvfb-run -a`.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const here = dirname(fileURLToPath(import.meta.url));
const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'tonto-vscode-')));
// A role nothing mediates: a warning the language server reports and the
// agent tools repeat, in a model that is otherwise clean.
writeFileSync(join(workspace, 'hiring.tonto'), 'ontology hiring\n\nkind Person\nrole Employee specializes Person\n');

const userData = mkdtempSync(join(tmpdir(), 'tonto-ud-'));
try {
    await runTests({
        // Set this to an installed VS Code executable to run offline; otherwise
        // @vscode/test-electron downloads its default stable build.
        vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
        extensionDevelopmentPath: resolve(here, '..'),
        extensionTestsPath: resolve(here, 'integration', 'index.cjs'),
        extensionTestsEnv: { TONTO_TEST_WORKSPACE: workspace },
        // A user-data folder of its own, and short: VS Code's IPC socket is
        // made in it, and a socket path over 103 characters cannot be bound.
        launchArgs: [workspace, `--user-data-dir=${userData}`,
            '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes']
    });
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
} finally {
    for (const folder of [workspace, userData]) rmSync(folder, { recursive: true, force: true });
}
