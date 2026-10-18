import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { TontoSession } from '../src/api.js';
import { EVERY_NATURE } from '../src/validation/natures.js';
import { TIME_POINT_STEREOTYPES } from '../src/validation/attribute-checks.js';
import { readFileSync } from 'node:fs';
import { EmptyFileSystem } from 'langium';
import { createTontoServices } from '../src/tonto-module.js';
import { TontoGrammar } from '../src/generated/grammar.js';
import { STEREOTYPES } from '../src/validation/stereotype-model.js';
import { RELATION_NATURE_TABLE } from '../src/validation/relation-nature-table.js';
import {
    adviseOnStereotype, inverseKeepsStereotype, RELATION_STEREOTYPES, RENAMED_STEREOTYPES, RETIRED_STEREOTYPES
} from '../src/validation/relation-stereotypes.js';

/**
 * The relation stereotype list cannot be a grammar type, because the rule ends
 * with `ID | STRING` so that a slip is reported with a suggestion rather than
 * as a parse error. That leaves two copies, so this asserts they agree.
 */
describe('the stereotype vocabulary matches the grammar', () => {
    const grammar = readFileSync(new URL('../src/grammar/relations.langium', import.meta.url), 'utf8');

    test('every stereotype in the grammar rule is in RELATION_STEREOTYPES', () => {
        const rule = /RelationStereotype returns string:([\s\S]*?);/.exec(grammar)![1];
        const inGrammar = [...rule.matchAll(/'(\w+)'/g)].map(m => m[1]).sort();
        expect(inGrammar).toEqual([...RELATION_STEREOTYPES].sort());
    });

    test('only the current spelling is a stereotype; the older one is advice', () => {
        for (const [older, newer] of Object.entries(RENAMED_STEREOTYPES)) {
            expect(RELATION_STEREOTYPES).not.toContain(older);
            expect(RELATION_STEREOTYPES).toContain(newer);
            expect(adviseOnStereotype(older).replacement).toBe(newer);
        }
    });

    test('a retired stereotype is explained, not replaced', () => {
        for (const name of Object.keys(RETIRED_STEREOTYPES)) {
            expect(RELATION_STEREOTYPES).not.toContain(name);
            const advice = adviseOnStereotype(name);
            expect(advice.replacement).toBeUndefined();
            expect(advice.because).toBeTruthy();
        }
    });

    test('the soft keywords are exactly the stereotypes written after "@"', () => {
        // They are soft precisely because a stereotype is always written after
        // `@`; a class stereotype begins a declaration and must stay reserved.
        // `begin` and `end` join them as the two property stereotypes, which
        // are written the same way -- and are far too ordinary as words to
        // take out of circulation as attribute names. `in` and `use` are soft
        // for the same reason: `package core in shop` and `use core` were
        // added to a language whose models may already name things so.
        const terminals = readFileSync(new URL('../src/grammar/terminals.langium', import.meta.url), 'utf8');
        const rule = /SoftKeyword returns string:([\s\S]*?);/.exec(terminals)![1];
        const soft = [...rule.matchAll(/'(\w+)'/g)].map(m => m[1]).sort();
        expect(soft).toEqual([...RELATION_STEREOTYPES, ...TIME_POINT_STEREOTYPES, 'global', 'from', 'in', 'use'].sort());
    });
});

describe('association stereotypes on an inverse', () => {
    test('keeps only relationship classifications and diamond-oriented parthood', () => {
        expect(RELATION_STEREOTYPES.filter(inverseKeepsStereotype)).toEqual([
            'material', 'comparative',
            'componenthood', 'membership', 'subCollection', 'subQuantity',
            'structural', 'temporal', 'participational'
        ]);
    });
});

describe('the stereotype table describes the whole language', () => {
    test('every stereotype the grammar accepts is described', () => {
        // Enforced by the compiler -- STEREOTYPES is keyed by ClassStereotype,
        // the union the grammar generates -- so this asserts the key type is
        // still doing that job rather than having drifted to `string`.
        const grammar = readFileSync(new URL('../src/grammar/stereotypes.langium', import.meta.url), 'utf8');
        const declared = /type ClassStereotype =([\s\S]*?);/.exec(grammar)![1];
        const inGrammar = [...declared.matchAll(/'(\w+)'/g)].map(m => m[1]).sort();
        expect(Object.keys(STEREOTYPES).sort()).toEqual(inGrammar);
    });

    test('every stereotype is classified in both taxonomies', () => {
        for (const [name, f] of Object.entries(STEREOTYPES)) {
            expect(f.sortality, name).toBeTruthy();
            expect(f.rigidity, name).toBeTruthy();
        }
    });

    test('only the bare "class" is left unconstrained', () => {
        const unconstrained = Object.entries(STEREOTYPES)
            .filter(([, f]) => f.natures === null || f.specializes === null)
            .map(([name]) => name);
        expect(unconstrained).toEqual(['class']);
    });

    test('a stereotype may only specialize stereotypes that exist', () => {
        for (const [name, f] of Object.entries(STEREOTYPES)) {
            for (const supertype of f.specializes ?? []) {
                expect(Object.keys(STEREOTYPES), `${name} specializes ${supertype}`).toContain(supertype);
            }
        }
    });
});

/**
 * Every word-shaped keyword must be usable as a name somewhere. A keyword
 * added to the grammar and to neither list is a word no end may be called,
 * which is how `of` came to be unwritable in the first place.
 */
describe('identifiers', () => {
    const services = createTontoServices(EmptyFileSystem).Tonto;
    const tokens = (text: string): string =>
        services.parser.Lexer.tokenize(text).tokens.map(token => `${token.tokenType.name}(${token.image})`).join(' ');

    test('a name that begins with a keyword is one name', () => {
        // The lexer resolves a keyword against a longer identifier. It stops
        // doing so under a `u`-flagged pattern, which is why the Unicode
        // ranges below are written out: `@subQuantityOf` had lexed as the
        // keyword `subQuantity` followed by `Of`.
        expect(tokens('subQuantityOf')).toBe('ID(subQuantityOf)');
        expect(tokens('constant')).toBe('ID(constant)');
        expect(tokens('roleplay')).toBe('ID(roleplay)');
        expect(tokens('subQuantity')).toBe('subQuantity(subQuantity)');
    });

    test('and may be written in a script other than this one', () => {
        expect(tokens('Ação')).toBe('ID(Ação)');
        expect(tokens('Órgão')).toBe('ID(Órgão)');
        expect(tokens('日本語')).toBe('ID(日本語)');
        expect(tokens('Кириллица')).toBe('ID(Кириллица)');
    });
});

describe('every keyword is readmitted as a name', () => {
    const grammar = TontoGrammar();

    /** Keywords that look like identifiers, so nothing punctuation-shaped. */
    function wordKeywords(): Set<string> {
        const words = new Set<string>();
        const seen = new Set<object>();
        (function walk(node: unknown): void {
            if (!node || typeof node !== 'object' || seen.has(node)) {
                return;
            }
            seen.add(node);
            if (Array.isArray(node)) {
                node.forEach(walk);
                return;
            }
            const record = node as Record<string, unknown>;
            if (record.$type === 'Keyword' && typeof record.value === 'string'
                && /^[a-zA-Z_][\w_-]*$/.test(record.value)) {
                words.add(record.value);
            }
            for (const [key, value] of Object.entries(record)) {
                if (key !== '$container' && key !== '$containerProperty') {
                    walk(value);
                }
            }
        })(grammar);
        return words;
    }

    function alternativesOf(rule: string): string[] {
        const terminals = readFileSync(new URL('../src/grammar/terminals.langium', import.meta.url), 'utf8');
        const body = new RegExp(`${rule} returns string:([\\s\\S]*?);`).exec(terminals)![1];
        return [...body.matchAll(/'([\w-]+)'/g)].map(match => match[1]);
    }

    test('as a soft keyword, usable anywhere, or a hard one, usable where delimited', () => {
        const readmitted = new Set([...alternativesOf('SoftKeyword'), ...alternativesOf('HardKeyword')]);
        expect([...wordKeywords()].filter(word => !readmitted.has(word))).toEqual([]);
    });

    test('and the two lists do not overlap', () => {
        const soft = new Set(alternativesOf('SoftKeyword'));
        expect(alternativesOf('HardKeyword').filter(word => soft.has(word))).toEqual([]);
    });

    test('and an end name may be any of them but the four a decorator spends', () => {
        // `(const father)` is a flag and a name, so `const` cannot also *be*
        // the name. The exception is deliberate and this is where it is
        // written down: a keyword added to `HardKeyword` and forgotten here
        // fails, and so does one of the six quietly becoming nameable again.
        const spent = ['const', 'addOnly', 'subsets', 'redefines'];
        const hard = alternativesOf('HardKeyword');
        const endSafe = new Set(alternativesOf('EndSafeKeyword'));
        expect(hard.filter(word => !endSafe.has(word)).sort()).toEqual([...spent].sort());
        expect([...endSafe].filter(word => !hard.includes(word))).toEqual([]);
    });
});

/**
 * The end-nature table is a table of *categories*, written out pair by pair
 * because a lookup wants pairs. Each entry is one named UFO category by
 * another, except `constitution`, which is the closure of a partition -- what
 * constitutes something belongs to its own category.
 *
 * Asserting it here means a pair added by hand that does not complete a
 * category fails the build, rather than sitting in the table as an exception
 * nobody can account for.
 */
describe('every association stereotype relates two named categories', () => {
    const SUBSTANTIALS = ['functional-complex', 'collective', 'quantity'];
    const ASPECTS = ['relator', 'intrinsic-mode', 'extrinsic-mode', 'quality'];
    const ENDURANTS = [...SUBSTANTIALS, ...ASPECTS, 'type'];
    const CATEGORIES: Record<string, readonly string[]> = {
        substantial: SUBSTANTIALS,
        aspect: ASPECTS,
        'aspect that inheres in one bearer': ['intrinsic-mode', 'extrinsic-mode', 'quality'],
        endurant: ENDURANTS,
        perdurant: ['event', 'process'],
        concrete: [...ENDURANTS, 'event', 'process', 'situation'],
        // What an aspect may inhere in, and what an extrinsic mode may depend
        // on: neither lines up with a category, and both are named here.
        bearer: [...ENDURANTS, 'process'],
        dependable: [...ENDURANTS, 'process', 'situation'],
        everything: [...ENDURANTS, 'event', 'process', 'situation', 'abstract'],
        ...Object.fromEntries(['functional-complex', 'collective', 'quantity', 'relator',
            'extrinsic-mode', 'event', 'process', 'situation', 'type'].map(one => [one, [one]]))
    };
    const named = (natures: Set<string>): string | undefined => Object.entries(CATEGORIES)
        .find(([, members]) => members.length === natures.size && members.every(m => natures.has(m)))?.[0];

    const table = Object.entries(RELATION_NATURE_TABLE).filter(([name]) => name !== 'constitution');

    test.each(table)('@%s relates one category to another', (name, pairs) => {
        const firsts = new Set(pairs.map(pair => pair.split(':')[0]));
        const seconds = new Set(pairs.map(pair => pair.split(':')[1]));
        if (name === 'characterization') {
            // Two signatures rather than one: what may bear an extrinsic mode
            // is narrower than what may bear a quality, so the pairs are a
            // union of two products and not a product.
            expect(pairs).toContain('quality:process');
            expect(pairs).not.toContain('extrinsic-mode:process');
            expect(pairs).not.toContain('quality:event');
            expect(pairs.length).toBeLessThan(firsts.size * seconds.size);
            return;
        }
        expect(pairs.length).toBe(firsts.size * seconds.size);
        expect({ first: named(firsts), second: named(seconds) })
            .toEqual({ first: expect.any(String), second: expect.any(String) });
    });

    test('and constitution closes over the categories instead', () => {
        const blocks = [SUBSTANTIALS, ASPECTS, ['event'], ['process']];
        const closure = blocks.flatMap(block => block.flatMap(a => block.map(b => `${a}:${b}`)));
        // Plus the one crossing, and the only entry in the table whose
        // direction is fixed: a process is constituted by events.
        expect([...RELATION_NATURE_TABLE.constitution].sort())
            .toEqual([...closure, 'process:event'].sort());
    });
});

/**
 * Every diagnostic carries a stable code.
 *
 * A message is prose and gets reworded; a code is what a reader -- or a tool
 * reading the JSON output -- can suppress, group or look up. Thirteen rules
 * once had none, which is why the rules reference had to key them by a
 * fragment of their message.
 */
describe('every diagnostic has a code', () => {
    test('no accept() call omits one', () => {
        const sources = ['classifier-checks', 'datatype-checks', 'genset-checks', 'import-checks',
            'member-checks', 'mlt-checks', 'naming-checks', 'package-checks', 'relation-checks',
            'relation-nature-checks', 'cardinality-checks', 'ufo-checks', 'anti-patterns',
            'default-stereotype'];
        const uncoded: string[] = [];
        for (const name of sources) {
            const text = readFileSync(new URL(`../src/validation/${name}.ts`, import.meta.url), 'utf8');
            for (const call of text.split(/\baccept\(/).slice(1)) {
                // Up to the end of the options object literal that closes the call.
                const options = call.slice(0, call.indexOf('\n    );') + 1 || call.length);
                if (!options.includes('code')) {
                    uncoded.push(`${name}: ${options.slice(0, 60).replace(/\s+/g, ' ')}`);
                }
            }
        }
        expect(uncoded).toEqual([]);
    });
});

describe('the natures the grammar accepts', () => {
    test('are the natures the rules describe', async () => {
        // The one home of this vocabulary that cannot be derived: a grammar
        // is text. Everything else -- the unions, what endures, what can
        // change, how the association tables spell it -- now reads off
        // `natures.ts`, and this holds the words themselves to it. They had
        // drifted before, in a comment that called a process an endurant.
        const grammar = await readFile(new URL('../src/grammar/natures.langium', import.meta.url), 'utf8');
        const rule = grammar.slice(grammar.indexOf('OntologicalNature returns string:'));
        const body = rule.slice(0, rule.indexOf(';')).split('\n')
            .filter(line => !line.trim().startsWith('//'))
            .join('\n');
        const written = [...body.matchAll(/'([\w-]+)'/g)].map(([, word]) => word);
        expect([...written].sort()).toEqual([...EVERY_NATURE].sort());
    });
});

describe('what a declaration may be called', () => {
    // A dotted name is how a reference reaches into another package. In a
    // declaration it is not a name at all, and three of them took one:
    // `datatype A.B` and `some.attr: string` parsed and validated in silence,
    // exporting a symbol under a name nothing could resolve.
    const session = new TontoSession();
    const refuses = async (source: string): Promise<boolean> =>
        (await session.validateText(source)).some(diagnostic => ['linking-error', 'parsing-error'].includes(diagnostic.code));

    test.each([
        ['a datatype', 'package p\ndatatype A.B\n'],
        ['an enumeration', 'package p\nenum C.D { x }\n'],
        ['an attribute', 'package p\ndatatype string\nkind K {\n  some.attr: string\n}\n']
    ])('%s is one name, not a path', async (_what, source) => {
        expect(await refuses(source)).toBe(true);
    });

    test('and an end names something that classifies individuals', async () => {
        // A relation was admissible at an end, which nothing needed and no
        // rule refused: `relation A [1] -- odd -- [1] knows` described
        // nothing and said so nowhere.
        expect(await refuses('package p\nkind A\nkind B\n'
            + 'relation A [1] -- knows -- [1] B\nrelation A [1] -- odd -- [1] knows\n')).toBe(true);
        // What does name a relation still may: `specializes` and `inverseOf`.
        expect(await refuses('package p\nkind A\nkind B\n'
            + 'relation A [1] -- knows -- [1] B\n'
            + 'relation A [1] -- also -- [1] B specializes knows\n')).toBe(false);
    });

    test('while a package is a path, and a reference may be one', async () => {
        expect(await refuses('package core.animals\nkind Dog\n')).toBe(false);
        expect(await refuses('package p\ndatatype string\nkind K {\n  attr: tonto.builtindatatypes.string\n}\n'))
            .toBe(false);
    });
});
