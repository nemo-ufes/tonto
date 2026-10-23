import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'tonto-cli-package-'));
const npmLogs = join(temporaryDirectory, 'npm-logs');
mkdirSync(npmLogs);

function run(command, args, cwd) {
    const result = spawnSync(command, args, {
        cwd,
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, npm_config_logs_dir: npmLogs }
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.stdout}${result.stderr}`);
    }
    return result.stdout;
}

try {
    const packOutput = run('npm', [
        'pack', '--json', '--pack-destination', temporaryDirectory
    ], packageDirectory);
    // npm writes prepack lifecycle output before its JSON result.
    const jsonStart = packOutput.lastIndexOf('\n[');
    const packed = JSON.parse(packOutput.slice(jsonStart >= 0 ? jsonStart + 1 : 0));
    const tarball = join(temporaryDirectory, basename(packed[0].filename));
    run('npm', [
        'install', '--prefix', temporaryDirectory, '--no-save', '--no-audit', '--no-fund', tarball
    ], packageDirectory);

    const cli = join(temporaryDirectory, 'node_modules', 'tonto-language', 'bin', 'tonto.js');
    const version = run(process.execPath, [cli, '--version'], temporaryDirectory).trim();
    if (version !== `tonto ${packed[0].version}`) {
        throw new Error(`Expected package version ${packed[0].version}, got ${version}`);
    }

    const guide = run(process.execPath, [cli, 'guide'], temporaryDirectory);
    if (!guide.startsWith('# tonto in one page')) {
        throw new Error('Installed CLI guide did not contain its expected heading');
    }

    writeFileSync(join(temporaryDirectory, 'sample.tonto'), 'ontology sample\nkind Person\n');
    run(process.execPath, [cli, 'check', 'sample.tonto'], temporaryDirectory);

    // The CLI's agent instructions are a file of the package, read when init runs.
    const project = join(temporaryDirectory, 'project');
    run(process.execPath, [cli, 'init', project], temporaryDirectory);
    if (!readFileSync(join(project, 'AGENTS.md'), 'utf8').startsWith('<!-- tonto-model-instructions (cli) -->')) {
        throw new Error('Installed CLI init did not write its agent instructions');
    }
    run(process.execPath, [cli, 'check', project], temporaryDirectory);
} finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
}
