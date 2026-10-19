import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const files = {
    language: 'packages/language/package.json',
    extension: 'packages/extension/package.json',
    mcp: 'packages/mcp/package.json',
    lock: 'package-lock.json'
};
const lockKeys = {
    language: 'packages/language',
    extension: 'packages/extension',
    mcp: 'packages/mcp'
};

function readJson(file) {
    return JSON.parse(readFileSync(resolve(root, file), 'utf8'));
}

function writeJson(file, value) {
    writeFileSync(resolve(root, file), `${JSON.stringify(value, null, 4)}\n`);
}

function isStableSemver(version) {
    return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version);
}

function compareVersions(left, right) {
    const a = left.split('.').map(Number);
    const b = right.split('.').map(Number);
    for (let index = 0; index < 3; index += 1) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return 0;
}

function verify(tag) {
    const language = readJson(files.language);
    const extension = readJson(files.extension);
    const mcp = readJson(files.mcp);
    const lock = readJson(files.lock);
    const expected = language.version;
    const errors = [];

    for (const [name, manifest] of [['extension', extension], ['MCP', mcp]]) {
        if (manifest.version !== expected) {
            errors.push(`${name} version ${manifest.version} does not match CLI version ${expected}`);
        }
        if (manifest.dependencies?.['tonto-language'] !== expected) {
            errors.push(`${name} dependency on tonto-language must be exactly ${expected}`);
        }
    }

    for (const [name, key] of [['language', lockKeys.language], ['extension', lockKeys.extension], ['MCP', lockKeys.mcp]]) {
        if (lock.packages?.[key]?.version !== expected) {
            errors.push(`package-lock.json has a different ${name} workspace version`);
        }
    }
    if (lock.packages?.[lockKeys.extension]?.dependencies?.['tonto-language'] !== expected) {
        errors.push('package-lock.json has a different extension dependency on tonto-language');
    }
    if (lock.packages?.[lockKeys.mcp]?.dependencies?.['tonto-language'] !== expected) {
        errors.push('package-lock.json has a different MCP dependency on tonto-language');
    }
    if (tag && tag !== `v${expected}`) {
        errors.push(`release tag ${tag} does not match expected tag v${expected}`);
    }

    if (errors.length) {
        console.error(`Version consistency failed:\n- ${errors.join('\n- ')}`);
        process.exitCode = 1;
    } else {
        console.log(`CLI, extension, MCP, dependencies, and lockfile agree on ${expected}${tag ? ` (${tag})` : ''}.`);
    }
}

const [action, argument] = process.argv.slice(2);
if (action === 'check') {
    verify(argument);
} else if (action === 'prepare') {
    const version = argument;
    if (!version || !isStableSemver(version)) {
        console.error('Usage: npm run release:prepare -- <stable-semver, for example 0.2.0>');
        process.exitCode = 1;
    } else {
        const language = readJson(files.language);
        if (!isStableSemver(language.version) || compareVersions(version, language.version) < 0) {
            console.error(`Release version ${version} must be stable SemVer and no lower than the current CLI version ${language.version}.`);
            process.exitCode = 1;
        } else {
            const extension = readJson(files.extension);
            const mcp = readJson(files.mcp);
            const lock = readJson(files.lock);

            language.version = version;
            extension.version = version;
            extension.dependencies['tonto-language'] = version;
            mcp.version = version;
            mcp.dependencies['tonto-language'] = version;
            lock.packages[lockKeys.language].version = version;
            lock.packages[lockKeys.extension].version = version;
            lock.packages[lockKeys.extension].dependencies['tonto-language'] = version;
            lock.packages[lockKeys.mcp].version = version;
            lock.packages[lockKeys.mcp].dependencies['tonto-language'] = version;

            writeJson(files.language, language);
            writeJson(files.extension, extension);
            writeJson(files.mcp, mcp);
            writeJson(files.lock, lock);
            verify();
        }
    }
} else {
    console.error('Usage: node scripts/versioning.mjs <check [tag]|prepare <version>>');
    process.exitCode = 1;
}
