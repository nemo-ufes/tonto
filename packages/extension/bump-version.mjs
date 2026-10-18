// Every packaged extension gets a version that distinguishes it from the one
// before it.
//
// The patch number moves on every package, and a build metadata suffix -- a
// UTC timestamp, which SemVer allows after a `+` and does not compare on --
// says when. Nothing here decides a minor or major bump; those stay a person's
// call, made by editing the version this script reads rather than by running
// it.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('package.json', import.meta.url));
const pkg = JSON.parse(readFileSync(path, 'utf8'));

const [base] = pkg.version.split('+');
const [major, minor, patch] = base.split('.').map(Number);

const now = new Date();
const pad = (part) => String(part).padStart(2, '0');
const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
    + `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;

pkg.version = `${major}.${minor}.${patch + 1}+${stamp}`;
writeFileSync(path, `${JSON.stringify(pkg, null, 4)}\n`);
console.log(`tonto-vscode -> ${pkg.version}`);
