// VS Code reads the version inside the archive, but a private build is passed
// around as a file. Put the same identity in its name so two builds remain
// distinguishable before either is installed.
import { readFileSync, renameSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = new URL('.', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', directory), 'utf8'));
const source = fileURLToPath(new URL('tonto.vsix', directory));
const target = fileURLToPath(new URL(`tonto-${pkg.version}.vsix`, directory));

renameSync(source, target);
console.log(`Versioned package: ${basename(target)}`);
