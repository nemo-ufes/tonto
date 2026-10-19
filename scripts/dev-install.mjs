import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const extensionManifest = resolve(root, 'packages/extension/package.json');
const languageManifest = resolve(root, 'packages/language/package.json');
const originalManifest = readFileSync(extensionManifest);
const language = JSON.parse(readFileSync(languageManifest, 'utf8'));
const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(language.version);

if (!match) {
    console.error(`The CLI release version must be stable SemVer before a local install; got ${language.version}.`);
    process.exit(1);
}

const [, major, minor, patch] = match;
const timestamp = Date.now().toString();
const devVersion = `${major}.${minor}.${Number(patch) + 1}-dev.${timestamp}`;
let restored = false;

function restoreManifest() {
    if (restored) return;
    writeFileSync(extensionManifest, originalManifest);
    restored = true;
}

function run(command, args, cwd = root) {
    const result = spawnSync(command, args, {
        cwd,
        env: { ...process.env, TONTO_VERSION: devVersion },
        stdio: 'inherit',
        shell: process.platform === 'win32'
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        const error = new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 1}`);
        error.exitCode = result.status ?? 1;
        throw error;
    }
}

process.once('SIGINT', () => {
    restoreManifest();
    process.exit(130);
});
process.once('SIGTERM', () => {
    restoreManifest();
    process.exit(143);
});

try {
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'versions:check']);

    const extension = JSON.parse(originalManifest.toString('utf8'));
    extension.version = devVersion;
    writeFileSync(extensionManifest, `${JSON.stringify(extension, null, 4)}\n`);

    console.log(`Building local tonto ${devVersion}...`);
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build']);
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'package', '--workspace=tonto-vscode']);
    run(process.execPath, ['install-vsix.mjs'], resolve(root, 'packages/extension'));
} catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
} finally {
    restoreManifest();
}
