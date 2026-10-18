import { describe, expect, test } from 'vitest';
import { catalog as rules } from '../src/cli/rules.js';
import { catalog as patterns } from '../src/cli/patterns.js';
import { TontoSession } from '../src/api.js';
import type { Reported } from '../src/api.js';
import type { Position, Range } from 'vscode-languageserver-types';

/**
 * Every model the project publishes, put through the formatter and the fixer.
 *
 * The rules reference and the pattern catalog are already validated as
 * documentation; this asks the other question -- what happens when a reader
 * acts on them. A repair that leaves text which does not parse is worse than
 * no repair, and four did: `(const)` and `(addOnly)` written into one
 * decorator at once, `specializes X` inserted twice at one point, a decorator
 * landing on the wrong side of a multiplicity, and a generalization set left
 * with no specifics. All four were found here, none by a unit test.
 */
const session = new TontoSession({ antiPatterns: true });

/**
 * Correcting a mistyped stereotype uncovers what the typo was hiding: nothing
 * checked the ends of `@mediaton`, and `@mediation` between two kinds is not
 * admissible. The repair is right and the second diagnostic is the truth.
 */
const UNCOVERS = new Set(['unknown-relation-stereotype']);

/** Count occurrences by stable code: draft URIs and class names in messages may change. */
function introducedErrors(before: Reported[], after: Reported[]): Reported[] {
    const counts = new Map<string, number>();
    for (const one of before.filter(one => one.severity === 'error')) {
        counts.set(one.code, (counts.get(one.code) ?? 0) + 1);
    }
    const introduced: Reported[] = [];
    for (const one of after.filter(one => one.severity === 'error')) {
        const left = counts.get(one.code) ?? 0;
        if (left === 0) introduced.push(one);
        else counts.set(one.code, left - 1);
    }
    return introduced;
}

/** Applies non-overlapping edits, back to front. */
function applyTo(text: string, edits: Array<{ range: Range; newText: string }>): string {
    const lines = text.split('\n');
    const offsetOf = (position: Position): number =>
        lines.slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) + position.character;
    return [...edits]
        .sort((left, right) => offsetOf(right.range.start) - offsetOf(left.range.start))
        .reduce((text, edit) =>
            text.slice(0, offsetOf(edit.range.start)) + edit.newText + text.slice(offsetOf(edit.range.end)), text);
}

async function models(): Promise<Array<[string, string]>> {
    const preamble = 'ontology repairs\ndatatype string\ndatatype date\ndatatype number\n';
    return [
        ...(await rules())
            // A multi-document case is written as one commented blob, which is
            // documentation rather than a model.
            .filter(rule => !rule.example.includes('// another file'))
            .map(rule => [`rule ${rule.code}`, `ontology repairs\n${rule.example}\n`] as [string, string]),
        ...(await patterns())
            .map(pattern => [`pattern ${pattern.name}`, `${preamble}${pattern.model}\n`] as [string, string])
    ];
}

describe('every published model survives its own repairs', () => {
    test('there are enough of them for this to mean anything', async () => {
        expect((await models()).length).toBeGreaterThan(120);
    });

    test('formatting is idempotent and changes no model', async () => {
        const broken: string[] = [];
        for (const [name, source] of await models()) {
            const once = await session.formatText(source);
            if (await session.formatText(once) !== once) {
                broken.push(`${name}: not idempotent`);
            }
            if (JSON.stringify(await session.astOf(once)) !== JSON.stringify(await session.astOf(source))) {
                broken.push(`${name}: formatting changed the model`);
            }
        }
        expect(broken).toEqual([]);
    }, 120_000);

    test('and repairing leaves text that parses', async () => {
        const broken: string[] = [];
        for (const [name, source] of await models()) {
            const fixed = await session.fixText(source);
            const unparsed = fixed.left.filter(diagnostic =>
                diagnostic.code === 'parsing-error' || diagnostic.code === 'lexing-error');
            if (unparsed.length > 0) {
                broken.push(`${name}: ${unparsed[0].message.split('\n')[0]}`);
            }
        }
        expect(broken).toEqual([]);
    }, 120_000);

    test('and introduces no error the model did not already have', async () => {
        const worse: string[] = [];
        for (const [name, source] of await models()) {
            const before = await session.validateText(source);
            const fixed = await session.fixText(source);
            const fresh = introducedErrors(before, fixed.left).map(diagnostic => diagnostic.code);
            if (fresh.length > 0 && !UNCOVERS.has(name.replace('rule ', ''))) {
                worse.push(`${name} -> ${fresh.join(', ')}`);
            }
        }
        expect(worse).toEqual([]);
    }, 120_000);

    /**
     * The same question of the repairs a batch will not take.
     *
     * `fixText` applies a repair only where its rule offers exactly one, so
     * every rule offering a choice went through the tests above untouched --
     * and a choice is precisely where the reader is being asked to decide,
     * which they cannot do well if one of the options is wrong. Three were:
     * restereotyping to a base sortal with no ultimate sortal above it,
     * offering an ancestor as a part of its own subtype, and both of those
     * only ever reachable by name.
     */
    test('and neither does any single repair, including the ones a batch leaves', async () => {
        const worse: string[] = [];
        for (const [name, source] of await models()) {
            if (UNCOVERS.has(name.replace('rule ', ''))) {
                continue;
            }
            const before = await session.validateText(source);
            for (const diagnostic of before) {
                for (const fix of diagnostic.fixes) {
                    const applied = await session.applyFix(
                        source, diagnostic.code, fix.title, diagnostic.line, diagnostic.column);
                    const fresh = introducedErrors(before, applied.left).map(one => one.code);
                    if (fresh.length > 0) {
                        worse.push(`${name}: "${fix.title}" -> ${[...new Set(fresh)].join(', ')}`);
                    }
                }
            }
        }
        expect(worse).toEqual([]);
    }, 180_000);
});

describe('a duplicate name is not always a duplicate claim', () => {
    /**
     * Deleting the second of two declarations is the repair when they say the
     * same thing, and a loss of what the model said when they do not. A
     * blanket `--fix` used to take `relation Car -- has -- Wheel` out of a
     * model whose only fault was that a relation to `Engine` had the same
     * name.
     */
    const survives = async (source: string): Promise<boolean> =>
        (await session.fixText(source)).text.trim() === source.trim();

    test('written twice, the second goes', async () => {
        const twice = 'package p\ndatatype string\nkind Person {\nname: string\nname: string\n}\n';
        expect(await survives(twice)).toBe(false);
    });

    test('but two claims under one name are left to be told apart', async () => {
        const attributes = 'package p\ndatatype string\ndatatype number\nkind Person {\nname: string\nname: number\n}\n';
        const relations = 'package p\nkind Car\nkind Engine\nkind Wheel\n'
            + 'relation Car -- has -- Engine\nrelation Car -- has -- Wheel\n';
        expect(await survives(attributes)).toBe(true);
        expect(await survives(relations)).toBe(true);
        for (const source of [attributes, relations]) {
            const reported = (await session.validateText(source)).find(one => one.code === 'duplicate-member');
            expect(reported?.fixes.map(fix => fix.batchSafe)).toEqual([false]);
        }
    });
});

describe('what a batch may decide', () => {
    /**
     * One available repair is not the same as one possible reading.
     *
     * A lone phase has two: the sibling has not been written yet, or the
     * stereotype is wrong. Only the second can be written as an edit, so
     * counting actions saw one repair and applied it -- turning a stage of a
     * life into a rigid subdivision, in silence.
     */
    const lonePhase = 'package p\nkind Person\nphase Adult specializes Person\n';

    test('a repair that decides is offered, marked, and not applied', async () => {
        const reported = await session.validateText(lonePhase);
        const hint = reported.find(diagnostic => diagnostic.code === 'lone-phase');
        expect(hint?.fixes.map(fix => [fix.title, fix.batchSafe]))
            .toEqual([['Change to "subkind"', false]]);
        expect((await session.fixText(lonePhase)).text).toBe(lonePhase);
    });

    test('unless the rule is named, which is someone choosing', async () => {
        const fixed = await session.fixText(lonePhase, 'draft', new Set(['lone-phase']));
        expect(fixed.text).toContain('subkind Adult');
    });

    test('while a repair the rule forces is applied and says so', async () => {
        const reported = await session.validateText('ontology p\nkind carro\n');
        expect(reported[0].fixes.map(fix => [fix.title, fix.batchSafe]))
            .toEqual([['Rename to "Carro"', true]]);
        expect((await session.fixText('ontology p\nkind carro\n')).text).toBe('ontology p\nkind Carro\n');
    });
});

/**
 * Every way an end can be written, against every repair that writes a
 * multiplicity into one.
 *
 * The published models write both multiplicities at every end, so nothing
 * exercised the case where a repair has to *insert* one -- and the two ends
 * are not mirror images. The grammar reads a source end as decorator then
 * multiplicity and a target end as multiplicity then decorator, so a repair
 * that anchored both at the class produced `(const) [2..*] Engine`, which
 * does not parse. What follows generates the shapes rather than listing the
 * ones anybody thought of.
 */
describe('a repair writes a multiplicity where the grammar reads one', () => {
    /** What may stand at a source end, in grammar order: decorator, then bound. */
    const SOURCES = ['', '[1] ', '(const) ', '(const) [1] ', '(const whole) [1] '];
    /** And at a target end, in the other order: bound, then decorator. */
    const TARGETS = ['', '[1] ', '(const) ', '[1] (const) ', '[1] (const parts) '];

    /** `{S}`, `{N}` and `{T}` are the source end, the notation, and the target end. */
    const SEEDS: Array<[string, string, string[]]> = [
        ['whole-with-one-part', 'kind Engine\nkind Car {\n@componenthood {S}{N} {T}Engine\n}',
            ['<>--', '<>--', '<>-- assembles --', '--<>', '-- carries --<>']],
        ['relator-mediates-one', 'kind Person\nrelator Marriage {\n@mediation {S}{N} {T}Person\n}',
            ['--', '-- joins --']],
        ['powertype-instantiation-multiplicity',
            'type CarModel isPowerType\nkind Car {\n@instantiation {S}{N} {T}CarModel\n}',
            ['--', '-- follows --']],
        // Parthood written without its diamond: the repair puts one into the
        // notation, which is the other thing an end can be written around.
        ['parthood-without-diamond', 'kind Engine\nkind Car {\n@componenthood {S}{N} {T}Engine\n}',
            ['--', '-- assembles --']],
        // And the decorators: what a past has gained it keeps, so the repair
        // writes `addOnly` into an end that may already say something.
        ['accumulating-end-not-add-only',
            'event Wedding\nkind Person\nrole Spouse specializes Person {\n@historicalDependence {S}{N} {T}Wedding\n}',
            ['--', '-- since --']],
        // The two parthoods whose part end another rule fixes at `[1]`:
        // `whole-with-one-part` used to answer itself by widening it, which
        // was one rule repaired by breaking another.
        ['sub-collection', 'collective Choir\ncollective Section {\n@subCollection {S}{N} {T}Choir\n}',
            ['<>--', '--<>']],
        ['sub-quantity', 'quantity Alcohol\nquantity Wine {\n@subQuantity {S}{N} {T}Alcohol\n}',
            ['<>--', '--<>']]
    ];

    test('at either end, however the other end is written', async () => {
        const broken: string[] = [];
        let applied = 0;
        for (const [seed, template, notations] of SEEDS) {
            for (const notation of notations) {
                for (const source of SOURCES) {
                    for (const target of TARGETS) {
                        const model = template
                            .replace('{S}', source).replace('{N}', notation).replace('{T}', target);
                        const text = `package p\n${model}\n`;
                        const before = await session.validateText(text);
                        if (before.some(one => ['linking-error', 'parsing-error', 'lexing-error'].includes(one.code))) {
                            // Not every shape is a model: `--<>` puts the
                            // whole at the target, and a decorator there names
                            // an end that the seed's other end may subset.
                            continue;
                        }
                        const already = new Set(before.filter(one => one.severity === 'error')
                            .map(one => one.code));
                        for (const diagnostic of before) {
                            for (const fix of diagnostic.fixes) {
                                const edits = fix.changes.flatMap(change => change.edits);
                                const after = await session.validateText(applyTo(text, edits));
                                applied++;
                                const fresh = [...new Set(after
                                    .filter(one => one.severity === 'error' && !already.has(one.code))
                                    .map(one => one.code))];
                                if (fresh.length > 0) {
                                    broken.push(`${seed} "${source}${notation} ${target}" `
                                        + `[${diagnostic.code}] "${fix.title}" -> ${fresh.join(', ')}`);
                                }
                            }
                        }
                    }
                }
            }
        }
        expect(broken).toEqual([]);
        // Enough shapes for the claim to mean something, over every end shape
        // the grammar admits at both ends of six seeds. It was 435 while the
        // grammar had a filled diamond as well as a hollow one.
        expect(applied).toBeGreaterThan(350);
    }, 300_000);
});

describe('stereotyping an existing association', () => {
    const session = new TontoSession();
    const fixesFor = async (source: string, code: string): Promise<string[]> =>
        (await session.validateText(source)).filter(one => one.code === code).flatMap(one => one.fixes.map(fix => fix.title));

    test('puts the reported class at the end the rule is about', async () => {
        // The constituent end: "Baking" would be constituted, "Fold" still not.
        expect(await fixesFor('package p\nprocess Fold\nprocess Baking {\n-- [1..*] Fold\n}\n', 'process-without-constitution'))
            .not.toContain('Add "@constitution" to the association with "Baking"');
        // The relator end: a role mixin is what is mediated, never the relator.
        expect(await fixesFor('package p\nroleMixin Person of functional-complexes\nkind Department\n'
            + 'relation Person [1] -- worksIn -- [1] Department\n', 'role-without-relator'))
            .not.toContain('Add "@mediation" to the association with "Department"');
        // And where the class does stand there, the repair is still offered.
        expect(await fixesFor('package p\nkind Person\nquality Weight {\n-- [1] (const) Person\n}\n', 'moment-without-bearer'))
            .toContain('Add "@characterization" to the association with "Person"');
    });
});

describe('a repair does not answer one diagnostic with the next', () => {
    const session = new TontoSession();
    const titles = async (source: string, code: string): Promise<string[]> =>
        (await session.validateText(source)).filter(one => one.code === code).flatMap(one => one.fixes.map(fix => fix.title));

    test('a stereotype is offered only where the taxonomy takes it', async () => {
        expect(await titles('package p\nhistoricalRoleMixin Person of functional-complexes\nphase Adult specializes Person\n', 'lone-phase'))
            .not.toContain('Change to "subkind"');
        expect(await titles('package p\nkind Person\nphase Adult specializes Person\n', 'lone-phase'))
            .toContain('Change to "subkind"');
    });

    test('a bare class made a non-sortal says what it classifies', async () => {
        expect(await titles('package p\nclass LegalEntity\nkind Company specializes LegalEntity\nkind Person specializes LegalEntity\n',
            'unspecific-stereotype')).toContain('Change to category of functional-complexes');
    });

    test('marking a power type opens the instantiation ends into it', async () => {
        const applied = await session.applyFix(
            'package p\nkind Car (instanceOf CarModel)\ntype CarModel\n@instantiation relation Car [0..*] -- [0..*] CarModel\n',
            'instance-is-its-own-base');
        expect(applied.text).toContain('@instantiation relation Car [0..*] -- [1..*] CarModel');
        expect(applied.left.map(one => one.code)).not.toContain('powertype-instantiation-multiplicity');
    });

    test('a historical role over a process is not made a participant', async () => {
        expect(await titles('package p\nevent Kneading\nprocess Baking {\n@constitution (const) [1] -- [1..*] (addOnly) Kneading\n}\n'
            + 'historicalRole Ongoing specializes Baking\n', 'historical-role-without-event'))
            .not.toContain('Participate in "Kneading"');
    });

    test('a redefining end is moved to what both bounds allow', async () => {
        const source = 'package p\nkind Person\nkind Team {\n-- [1] (members) Person\n}\n'
            + 'subkind Squad specializes Team {\n-- [0..*] (redefines Team.members) Person\n}\n';
        expect(await titles(source, 'end-holds-more-than-general')).toEqual(['Change to [1]']);
        expect(await titles(source, 'redefinition-weakens-lower-bound')).toEqual(['Change to [1]']);
    });

    test('an aspect recorded as a property goes, where nothing else names it', async () => {
        const applied = await session.applyFix('package p\nevent Wedding\n/// How long.\nquality Duration {\n    hours: number\n'
            + '    @characterization -- [1] (const) Wedding\n}\n', 'characterization-bearer-not-reifiable');
        expect(applied.text).toBe('package p\nevent Wedding {\n    duration: const number\n}\n');
    });
});
