import { describe, expect, test } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { catalog, RULES } from '../src/cli/rules.js';

/**
 * The rules reference is documentation that runs.
 *
 * Each entry is the smallest plausible model that trips its rule, and this
 * validates every one. A rule whose example stops tripping it -- because the
 * rule moved, or the language did -- fails here rather than quietly becoming
 * a paragraph that is no longer true. That has happened twice: an example
 * built on `event X specializes Meeting` after ultimate sortals became
 * pairwise disjoint, and one that predated parthood inheritance.
 */
/**
 * The `code:` expression alone.
 *
 * What follows a comma is the next property, and what follows a `)` is not a
 * diagnostic at all -- `(message: string, code: string): void =>` is a
 * signature, and reading past the parenthesis found the `'error'` in the call
 * after it.
 */
function codeExpression(expression: string): string {
    let quote: string | undefined;
    for (let index = 0; index < expression.length; index++) {
        const character = expression[index];
        if (quote) {
            quote = character === quote ? undefined : quote;
        } else if (character === '\'' || character === '"') {
            quote = character;
        } else if (character === ',' || character === ')') {
            return expression.slice(0, index);
        }
    }
    return expression;
}

describe('the rules reference', () => {
    const rules = catalog();

    test('every rule is still tripped by its own example', async () => {
        const silent = (await rules).filter(rule => rule.severity === undefined).map(rule => rule.code);
        expect(silent).toEqual([]);
    });

    test('and none of them says something else instead', async () => {
        // The example must produce *that* diagnostic, not merely some
        // diagnostic: a code is matched against the code, not the message.
        const wrong = (await rules).filter(rule =>
            !rule.code.includes(' ') && !(rule.message ?? '').length);
        expect(wrong).toEqual([]);
    });

    test('the catalog covers every group and carries no duplicates', async () => {
        const codes = (await rules).map(rule => rule.code);
        expect(new Set(codes).size).toBe(codes.length);
        expect(new Set((await rules).map(rule => rule.group)).size).toBeGreaterThan(8);
    });

    test('every entry is keyed by the code its diagnostic carries', async () => {
        // Not by a fragment of the message: a fragment cannot be looked up
        // with `tonto rules <code>`, and two fragments for one code are two
        // entries for one rule, which is how three duplicates went unnoticed
        // -- the uniqueness test above compares keys, and the keys differed.
        const mismatched = (await rules)
            .filter(rule => rule.reported !== undefined && rule.reported !== rule.code)
            .map(rule => `${rule.code} -> ${rule.reported}`);
        expect(mismatched).toEqual([]);
    });

    test('and no two entries resolve to one diagnostic', async () => {
        const reported = (await rules).map(rule => rule.reported ?? rule.code);
        const twice = reported.filter((code, index) => reported.indexOf(code) !== index);
        expect(twice).toEqual([]);
    });

    test('a rule with a repair names it', async () => {
        const withFixes = (await rules).filter(rule => rule.fixes.length > 0);
        expect(withFixes.length).toBeGreaterThan(50);
        expect(withFixes.every(rule => rule.fixes.every(title => title.length > 0))).toBe(true);
    });

    test('repairs do not include unrelated source actions', async () => {
        const multiplicity = (await rules).find(rule => rule.code === 'multiplicity-zero-upper');
        expect(multiplicity?.fixes).toEqual(['Change to [0..1]', 'Change to [0..*]']);
        const caseRepair = (await rules).find(rule => rule.code === 'type-name-case');
        expect(caseRepair?.fixes).toEqual(['Rename to "Automovel"']);
    });

    test('and every code a check writes has an entry', async () => {
        // The direction the audit missed: it compared entries against codes and
        // never codes against entries, so `duplicate-use` and
        // `diamond-without-parthood` fired for months undocumented -- invisible
        // to `tonto rules <code>` and to the reference page.
        const sources = await readdir(new URL('../src/validation', import.meta.url), { recursive: true });
        const emitted = new Set<string>();
        for (const name of sources.filter(entry => String(entry).endsWith('.ts'))) {
            const text = await readFile(new URL(`../src/validation/${name}`, import.meta.url), 'utf8');
            // Every string in the `code:` expression, not just a literal one:
            // a code written as `a ? 'x' : 'y'` was invisible to this, and
            // `invalid-specialization-in-genset` fired for months behind that
            // blindness, uncataloged and with no repair.
            for (const [, expression] of text.matchAll(/\bcode: ([^\n]*)/g)) {
                for (const [, code] of codeExpression(expression).matchAll(/'([\w-]+)'/g)) {
                    emitted.add(code);
                }
            }
        }
        const cataloged = new Set(RULES.map(rule => rule.code));
        expect([...emitted].filter(code => !cataloged.has(code)).sort()).toEqual([]);
    });

    test('every case is documented', () => {
        expect(RULES.every(rule => rule.rationale.length > 20 && rule.group.length > 0)).toBe(true);
    });

    test('and an example shows the repair its rule has', async () => {
        // The example is the smallest model that trips the rule, and that was
        // sometimes smaller than the model a repair needs to exist: nine
        // rules had a handler and an example that showed none, so
        // `tonto rules <code>` told a reader there was nothing to apply --
        // `sortal-without-ultimate-sortal` among them, which is one of the
        // first errors anyone writing tonto hits. The example has to be big
        // enough to demonstrate the repair as well as the fault.
        const sources = await readdir(new URL('../src/lsp', import.meta.url));
        const provider = await readFile(new URL('../src/lsp/tonto-code-action-provider.ts', import.meta.url), 'utf8');
        expect(sources.length).toBeGreaterThan(0);
        const handled = new Set([...provider.matchAll(/case '([\w-]+)':/g)].map(([, code]) => code));
        const silent = (await rules)
            .filter(rule => handled.has(rule.code) && rule.fixes.length === 0)
            .map(rule => rule.code);
        expect(silent).toEqual([]);
    });
});
