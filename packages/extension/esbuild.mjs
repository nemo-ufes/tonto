// Bundles both the extension host code and the language server into this
// package's out/ directory, so the packaged extension is self-contained
// (no reliance on node_modules/tonto-language being present at runtime).
import * as esbuild from 'esbuild';
import languagePackage from '../language/package.json' with { type: 'json' };

const watch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');
const mcpVersion = process.env.TONTO_VERSION ?? languagePackage.version;

const commonOptions = {
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    sourcemap: true,
    minify,
    external: ['vscode']
};

const contexts = await Promise.all([
    esbuild.context({
        ...commonOptions,
        entryPoints: ['src/extension.ts'],
        outfile: 'out/extension.cjs'
    }),
    esbuild.context({
        ...commonOptions,
        entryPoints: ['../language/src/main.ts'],
        outfile: 'out/language-server.cjs'
    }),
    esbuild.context({
        ...commonOptions,
        format: 'esm',
        define: { 'process.env.TONTO_VERSION': JSON.stringify(mcpVersion) },
        entryPoints: ['../mcp/src/index.ts'],
        outfile: 'out/tonto-mcp.mjs'
    }),
    // Claude Code's PostToolUse hook, staged beside the MCP runtime.
    esbuild.context({
        ...commonOptions,
        format: 'esm',
        entryPoints: ['../language/src/claude-hook.ts'],
        outfile: 'out/tonto-hook.mjs'
    })
]);

if (watch) {
    await Promise.all(contexts.map(ctx => ctx.watch()));
    console.log('esbuild watching for changes...');
} else {
    await Promise.all(contexts.map(ctx => ctx.rebuild()));
    await Promise.all(contexts.map(ctx => ctx.dispose()));
    console.log('esbuild build complete.');
}
