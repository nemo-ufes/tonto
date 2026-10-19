import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const language = resolve(root, 'packages/language');
const marker = resolve(language, '.tonto-dev-version');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const result = spawnSync(npm, ['unlink', '--global', 'tonto-language'], {
    cwd: language,
    stdio: 'inherit',
    shell: process.platform === 'win32'
});

if (result.error) throw result.error;
if (result.status !== 0) {
    console.error(`npm unlink --global tonto-language failed with exit code ${result.status ?? 1}`);
    process.exit(result.status ?? 1);
}

rmSync(marker, { force: true });
console.log('Removed the global tonto-language link and its local development version marker.');
console.log('To use a registry release again, install it with: npm install --global tonto-language');
