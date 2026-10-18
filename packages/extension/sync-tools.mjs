// Writes the `languageModelTools` contribution from the tool definitions in
// tonto-language/tools, which the MCP server registers from too. VS Code reads
// the declarations from package.json before the extension runs, so they are
// written here rather than computed; a test in packages/language fails while
// the two differ. Run after changing a tool: npm run tools:sync.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VSCODE_CAPABILITIES, vscodeToolContributions } from 'tonto-language/tools';

const path = fileURLToPath(new URL('package.json', import.meta.url));
const pkg = JSON.parse(readFileSync(path, 'utf8'));
pkg.contributes.languageModelTools = vscodeToolContributions(VSCODE_CAPABILITIES);
writeFileSync(path, `${JSON.stringify(pkg, null, 4)}\n`);
console.log(`${pkg.contributes.languageModelTools.length} language-model tools declared`);
