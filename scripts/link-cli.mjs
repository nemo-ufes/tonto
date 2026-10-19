import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const language = resolve(root, 'packages/language');
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

try {
    run(['run', 'build', '--workspace=tonto-language'], root);
    run(['link'], language);
    console.log('Linked tonto-language globally. The tonto command now uses this checkout.');
    console.log('To remove the link, run: npm uninstall --global tonto-language');
} catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
}
