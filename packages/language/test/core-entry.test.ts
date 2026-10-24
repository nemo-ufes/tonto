import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

/**
 * `tonto-language/core` and `tonto-language/patterns` are loaded by hosts that
 * are not Node: an editor and diagram in a browser page, which stand in for
 * the few Node modules listed here and nothing else. A new Node import
 * anywhere these entries reach would break such a host the next time it
 * updates, with nothing here noticing. So the modules they reach are walked,
 * and the Node modules found are compared with the list below.
 *
 * The list names each file and what it takes from Node. It records what
 * exists, not what is welcome: a new Node import belongs behind the CLI
 * (`api.ts`, `exports.ts`, `cli/`), not in a module the services use. When an
 * import is removed, remove it here too, so that it cannot come back unseen.
 */
const NODE_IMPORTS: Record<string, string[]> = {
    'lsp/ontology-actions.ts': ['node:fs', 'node:path'],
    'lsp/tonto-file-operation-handler.ts': ['node:path'],
    'publication/document-validator.ts': ['node:path'],
    'publication/workspace.ts': ['node:async_hooks', 'node:crypto', 'node:fs', 'node:path'],
    'utils/paths.ts': ['node:fs', 'node:path']
};

const ENTRIES = ['core.ts', 'cli/patterns.ts'];

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const BUILTINS = new Set(builtinModules);

interface Reached {
    /** Node modules imported at runtime, by file relative to `src`. */
    node: Record<string, string[]>;
    /** Package imports of Node-only entry points, such as `langium/node`. */
    nodeEntryPoints: string[];
    /** Files that read the `process` global directly. */
    process: string[];
}

function walk(entries: readonly string[]): Reached {
    const reached: Reached = { node: {}, nodeEntryPoints: [], process: [] };
    const seen = new Set<string>();
    const pending = entries.map(entry => join(SOURCE, entry));
    while (pending.length > 0) {
        const file = pending.pop()!;
        if (seen.has(file)) continue;
        seen.add(file);
        const name = relative(SOURCE, file).split('\\').join('/');
        const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
        for (const specifier of runtimeImports(source)) {
            if (specifier.startsWith('.')) {
                pending.push(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
            } else if (specifier.startsWith('node:') || BUILTINS.has(specifier)) {
                const module = specifier.startsWith('node:') ? specifier : `node:${specifier}`;
                const modules = reached.node[name] ??= [];
                if (!modules.includes(module)) modules.push(module);
            } else if (/\/node$/.test(specifier)) {
                reached.nodeEntryPoints.push(`${name}: ${specifier}`);
            }
        }
        if (readsProcess(source)) reached.process.push(name);
    }
    for (const modules of Object.values(reached.node)) modules.sort();
    return reached;
}

/**
 * Module specifiers this file loads when it runs. A type-only import or
 * export is erased by the compiler, so it does not count.
 */
function runtimeImports(source: ts.SourceFile): string[] {
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            const clause = node.importClause;
            const typeOnly = clause?.isTypeOnly || (clause !== undefined && clause.name === undefined
                && clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)
                && clause.namedBindings.elements.length > 0
                && clause.namedBindings.elements.every(element => element.isTypeOnly));
            if (!typeOnly) found.push(node.moduleSpecifier.text);
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            if (!node.isTypeOnly) found.push(node.moduleSpecifier.text);
        } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            const [argument] = node.arguments;
            if (argument && ts.isStringLiteral(argument)) found.push(argument.text);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
}

/** `process.cwd()` and the like; `globalThis.process?.…` is a guarded read and does not count. */
function readsProcess(source: ts.SourceFile): boolean {
    let found = false;
    const visit = (node: ts.Node): void => {
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'process') {
            found = true;
        }
        if (!found) ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
}

describe('the entries hosts without Node load', () => {
    const reached = walk(ENTRIES);

    test('reach only the Node modules already listed', () => {
        expect(reached.node).toEqual(NODE_IMPORTS);
    });

    test('reach no Node-only entry point of a dependency', () => {
        expect(reached.nodeEntryPoints).toEqual([]);
    });

    test('do not read the process global unguarded', () => {
        expect(reached.process).toEqual([]);
    });
});
