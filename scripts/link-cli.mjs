import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { developmentVersion } from './dev-version.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const language = resolve(root, 'packages/language');
const languageManifest = resolve(language, 'package.json');
const marker = resolve(language, '.tonto-dev-version');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(args, cwd) {
    const result = spawnSync(npm, args, {
        cwd,
        stdio: 'inherit',
        shell: process.platform === 'win32'
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        const error = new Error(`npm ${args.join(' ')} failed with exit code ${result.status ?? 1}`);
        error.exitCode = result.status ?? 1;
        throw error;
    }
}

const hadMarker = existsSync(marker);
const previousMarker = hadMarker ? readFileSync(marker) : undefined;

try {
    run(['run', 'build', '--workspace=tonto-language'], root);
    const { version } = JSON.parse(readFileSync(languageManifest, 'utf8'));
    const devVersion = developmentVersion(version);
    writeFileSync(marker, `${devVersion}\n`);
    run(['link'], language);
    console.log('Linked tonto-language globally. The tonto command now uses this checkout.');
    console.log(`tonto --version reports ${devVersion} for this local build.`);
    console.log('To remove the link, run: npm run dev:unlink-cli');
} catch (error) {
    if (hadMarker) writeFileSync(marker, previousMarker);
    else rmSync(marker, { force: true });
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
}
