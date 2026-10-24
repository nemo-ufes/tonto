// Prepares a release from a clean main branch, then pushes its signed tag and
// dispatches the release workflow. Each operation stops the sequence on error;
// a partially completed release is left visible for a deliberate retry.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const [version, ...flags] = process.argv.slice(2);
const tag = version ? `v${version}` : undefined;
const publishNpm = flags.includes('--publish-npm');
const publishMarketplace = flags.includes('--publish-marketplace');
const yes = flags.includes('--yes');
const dryRun = flags.includes('--dry-run');
const knownFlags = ['--publish-npm', '--publish-marketplace', '--yes', '--dry-run'];
const unknownFlags = flags.filter(flag => !knownFlags.includes(flag));

function fail(message) {
    throw new Error(message);
}

function run(command, args, { capture = false, allowFailure = false } = {}) {
    const result = spawnSync(command, args, {
        cwd: root,
        encoding: 'utf8',
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        shell: process.platform === 'win32'
    });
    if (result.error) {
        throw result.error;
    }
    if (!allowFailure && result.status !== 0) {
        const error = new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 1}`);
        error.exitCode = result.status ?? 1;
        throw error;
    }
    return capture
        ? { status: result.status ?? 1, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
        : undefined;
}

function output(command, args) {
    return run(command, args, { capture: true }).stdout;
}

function isStableSemver(value) {
    return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
}

function compareVersions(left, right) {
    const a = left.split('.').map(Number);
    const b = right.split('.').map(Number);
    for (let index = 0; index < 3; index += 1) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return 0;
}

function preflight() {
    if (version === '--help' || version === '-h' || flags.includes('--help') || flags.includes('-h')) {
        console.log('Usage: npm run release -- <stable-version> [--dry-run] [--yes] [--publish-npm] [--publish-marketplace]');
        console.log('npm and Marketplace publishing are disabled unless their flags are supplied.');
        process.exit(0);
    }
    if (!version || !isStableSemver(version) || unknownFlags.length > 0) {
        fail('Usage: npm run release -- <stable-version> [--dry-run] [--yes] [--publish-npm] [--publish-marketplace]');
    }

    const language = JSON.parse(readFileSync(resolve(root, 'packages/language/package.json'), 'utf8'));
    if (!isStableSemver(language.version) || compareVersions(version, language.version) <= 0) {
        fail(`Release version ${version} must be greater than the current stable version ${language.version}.`);
    }
    if (!dryRun && output('git', ['status', '--porcelain'])) {
        fail('The working tree must be clean. Commit the release-ready source before preparing a release.');
    }
    const branch = output('git', ['branch', '--show-current']);
    if (branch !== 'main') {
        fail(`Releases must be prepared from main; current branch is ${branch || '(detached HEAD)'}.`);
    }

    console.log('Checking origin/main and release tag availability...');
    run('git', ['fetch', 'origin']);
    const local = output('git', ['rev-parse', 'HEAD']);
    const remote = output('git', ['rev-parse', 'origin/main']);
    if (local !== remote) {
        fail('Local main must match origin/main. Push or pull the release-ready source first.');
    }
    const remoteTag = run('git', ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`], {
        capture: true,
        allowFailure: true
    });
    if (remoteTag.status === 0 && remoteTag.stdout) {
        fail(`Tag ${tag} already exists on origin.`);
    }
    if (remoteTag.status !== 0 && remoteTag.status !== 2) {
        fail(`Could not check whether ${tag} exists on origin: ${remoteTag.stderr || 'git ls-remote failed'}`);
    }
    if (output('git', ['tag', '--list', tag])) {
        fail(`Tag ${tag} already exists locally.`);
    }
    run('gh', ['auth', 'status']);
    run(npm, ['run', 'versions:check']);
}

async function main() {
    preflight();
    console.log(`\nRelease plan for ${tag}:`);
    console.log('  1. Set and check the shared workspace version.');
    console.log('  2. Commit the version change.');
    console.log('  3. Create a signed, annotated tag.');
    console.log('  4. Push main and the tag to origin.');
    console.log(`  5. Dispatch Release tonto (npm: ${publishNpm ? 'on' : 'off'}, Marketplace: ${publishMarketplace ? 'on' : 'off'}).`);
    if (dryRun) {
        console.log('\nDry run only; no version, commit, tag, push, or workflow changes made.');
        return;
    }
    if (!yes) {
        if (!process.stdin.isTTY) {
            fail('Use --yes to confirm the release sequence in a non-interactive shell.');
        }
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await prompt.question('Proceed with this release? [y/N] ');
        prompt.close();
        if (!/^y(?:es)?$/i.test(answer.trim())) {
            console.log('Release cancelled.');
            return;
        }
    }

    run(npm, ['run', 'release:prepare', '--', version]);
    run(npm, ['run', 'versions:check', '--', tag]);
    run('git', ['add', 'package-lock.json', 'packages/language/package.json', 'packages/extension/package.json', 'packages/mcp/package.json']);
    run('git', ['commit', '-m', `Prepare release ${tag}`]);
    run('git', ['tag', '-s', tag, '-m', `Release ${tag}`]);
    run('git', ['push', 'origin', 'main']);
    run('git', ['push', 'origin', tag]);
    run('gh', [
        'workflow', 'run', '.github/workflows/release.yml', '--ref', tag,
        '-f', `release_tag=${tag}`,
        '-f', `publish_npm=${publishNpm}`,
        '-f', `publish_marketplace=${publishMarketplace}`
    ]);
    console.log(`\nDispatched the ${tag} release workflow.`);
    run('gh', ['run', 'list', '--workflow', 'release.yml', '--limit', '1']);
}

try {
    await main();
} catch (error) {
    console.error(`Release stopped: ${error.message}`);
    process.exitCode = error.exitCode ?? 1;
}
