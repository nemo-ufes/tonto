import { describe, expect, test } from 'vitest';
import { catalog, missingPattern, patternSnippet, PATTERNS } from '../src/cli/patterns.js';
import { guide } from '../src/cli/guide.js';
import { RULES } from '../src/cli/rules.js';

/**
 * The pattern catalog, checked against the implementation.
 *
 * Every pattern is drawn from the literature and every one must validate in
 * silence -- no error, no warning, not even a hint. That makes this the
 * strongest single test the checks have: a rule that fires on a textbook
 * pattern is wrong about the pattern or wrong about itself, and either way the
 * catalog is where it shows.
 */
describe('the pattern catalog', () => {
    const patterns = catalog();

    test('every pattern validates without a word', async () => {
        const noisy = (await patterns)
            .filter(pattern => pattern.diagnostics.length > 0)
            .map(pattern => `${pattern.name}: ${pattern.diagnostics.join(' | ')}`);
        expect(noisy).toEqual([]);
    });

    test('each one says what it is for, what is easy to get wrong, and where it comes from', () => {
        for (const pattern of PATTERNS) {
            expect(pattern.intent.length, pattern.name).toBeGreaterThan(20);
            expect(pattern.note.length, pattern.name).toBeGreaterThan(40);
            expect(pattern.source.length, pattern.name).toBeGreaterThan(8);
            expect(pattern.model.length, pattern.name).toBeGreaterThan(10);
        }
    });

    test('names are unique and stable', () => {
        const names = PATTERNS.map(pattern => pattern.name);
        expect(new Set(names).size).toBe(names.length);
        expect(names.every(name => /^[a-z][a-z-]*[a-z]$/.test(name))).toBe(true);
    });

    test('the kind-and-subkind pattern uses bicycle design kinds without claiming completeness', () => {
        const model = PATTERNS.find(pattern => pattern.name === 'kind-and-subkind')!.model;
        expect(model).toBe([
            'kind Bicycle',
            'subkind MountainBike specializes Bicycle',
            'subkind RoadBike specializes Bicycle'
        ].join('\n'));
        expect(model).not.toContain('genset');
    });

    test('every editor snippet defaults to the validated catalog model', async () => {
        for (const pattern of PATTERNS) {
            const defaults = new Map<string, string>();
            const materialized = (await patternSnippet(pattern))
                .replace(/\$\{(\d+):([^}]*)\}/g, (_whole, stop: string, value: string) => {
                    defaults.set(stop, value);
                    return value;
                })
                .replace(/\$\{(\d+)\}/g, (_whole, stop: string) => defaults.get(stop) ?? '')
                .replace(/\$(\d+)/g, (_whole, stop: string) => defaults.get(stop) ?? '')
                .replace(/\\([\\$}])/g, '$1');
            expect(materialized, pattern.name).toBe(pattern.model);
        }
    });

    test('pattern snippets link references but keep same-spelled symbols independent', async () => {
        const pattern = PATTERNS.find(candidate => candidate.name === 'role-and-relator')!;
        const snippet = await patternSnippet(pattern);
        const employee = /\$\{(\d+):Employee\}/.exec(snippet)?.[1];
        expect(employee).toBeDefined();
        expect(snippet.match(new RegExp(`\\$\\{${employee}\\}`, 'g'))).toHaveLength(1);
        expect(snippet).toContain('role ');
        expect(snippet).toContain(' specializes ');
        expect(snippet).toContain('@mediation [1..*] -- [1] (const)');
        expect(snippet).not.toMatch(/\$\{\d+:(?:role|specializes|mediation|const)\}/);

        const subcollection = await patternSnippet(PATTERNS.find(candidate => candidate.name === 'subcollection')!);
        const memberStops = [...subcollection.matchAll(/\$\{(\d+):members\}/g)].map(match => match[1]);
        expect(memberStops).toHaveLength(2);
        expect(new Set(memberStops).size).toBe(2);

        const values = await patternSnippet(PATTERNS.find(candidate => candidate.name === 'quality-value-space')!);
        expect(values).toContain('enum ');
        const structured = await patternSnippet(PATTERNS.find(candidate => candidate.name === 'structured-datatype')!);
        expect(structured).toContain('datatype ');
        expect(`${values}\n${structured}`).not.toMatch(/\$\{\d+:(?:enum|datatype|string|number)\}/);

        const manyStops = await patternSnippet(PATTERNS.find(candidate => candidate.name === 'phase-mixin')!);
        expect(manyStops).toContain('${10:activeThings}');
        expect(manyStops.endsWith('$0')).toBe(true);
        expect(manyStops.slice(0, -2)).not.toMatch(/\$\d+/);
    });

    test('the Cardelli powertype makes each specialization an explicit instance', () => {
        const model = PATTERNS.find(pattern => pattern.name === 'powertype-cardelli')!.model;
        expect(model).toContain('type PersonType isPowerType');
        expect(model).toContain('@instantiation relation Person [1..*] -- [1..*] PersonType');
        expect(model).toContain('subkind Man (instanceOf PersonType) specializes Person');
    });

    test('the process pattern does not restate participation as historical dependence', () => {
        const process = PATTERNS.find(pattern => pattern.name === 'process-and-its-events')!;
        expect(process.model).toContain('@participation relation Person');
        expect(process.model).not.toContain('@historicalDependence');
        expect(process.note).toContain('do not restate that as historical dependence');

        const historical = PATTERNS.find(pattern => pattern.name === 'historical-dependence')!;
        expect(historical.model).toContain('@historicalDependence relation Baking');
        expect(historical.model).toContain('tookPlaceIn -- [1] (const) Oven');
    });

    test('teaches past-tense names for participation in occurred events', () => {
        expect(guide()).toContain('Person -- delivered -- KeynoteSpeech');
        expect(guide()).toContain('Do not write `delivers`');
        expect(guide()).toContain('`participatesIn`.');
        const eventModels = PATTERNS.filter(pattern => [
            'event-participation', 'event-properties', 'event-parthood', 'situation-causation'
        ].includes(pattern.name)).map(pattern => pattern.model).join('\n');
        expect(eventModels).toContain('-- marriedIn --');
        expect(eventModels).toContain('-- participatedIn --');
        expect(eventModels).toContain('-- vowedIn --');
        expect(eventModels).toContain('-- signed --');
        expect(eventModels).not.toMatch(/-- (?:marriesIn|takesPartIn|vows|signs) --/);
    });

    test('distinguishes the three criteria for event parthood', () => {
        const page = guide();
        expect(page).toContain('projected from the whole');
        expect(page).toMatch(/before and\s+after noon/);
        expect(page).toMatch(/exclusive\s+dependence on one endurant/);

        const structural = PATTERNS.find(pattern => pattern.name === 'event-parthood');
        const temporal = PATTERNS.find(pattern => pattern.name === 'temporal-event-segmentation');
        const participational = PATTERNS.find(pattern => pattern.name === 'participational-event-decomposition');
        expect(structural?.model).toContain('@structural');
        expect(structural?.model).not.toContain('@temporal');
        expect(temporal?.model).toContain('@temporal');
        expect(temporal?.note).toContain('before and after noon');
        expect(participational?.model).toContain('@participational');
        expect(participational?.model).toContain('Person (const) [1] -- attended');
    });

    test('names the parts of an ontology with one word each', () => {
        const page = guide();
        for (const word of ['one-file ontology', 'ontology file', 'package file', 'Packages are **used**; ontologies are **imported**']) {
            expect(page).toContain(word);
        }
        // Retired: "manifest" was read as a configuration file, and the
        // others were second names for the ontology file and the one-file ontology.
        const retired = /\bmanifests?\b|entry documents?|monolithic|development mappings?/i;
        expect(page).not.toMatch(retired);
        for (const rule of RULES) expect(rule.rationale, rule.code).not.toMatch(retired);
    });

    test('the catalog covers every part of the language', () => {
        const groups = new Set(PATTERNS.map(pattern => pattern.group));
        expect(groups).toEqual(new Set([
            'Identity and taxonomy', 'Relators and roles', 'Aspects',
            'Matter and parts', 'Events and situations', 'Multi-level', 'Values'
        ]));
        expect(PATTERNS.length).toBeGreaterThanOrEqual(31);
    });

    test('and reaches every class stereotype it claims to teach', async () => {
        // A stereotype no pattern demonstrates is one an agent has to guess at.
        // Except the bare `class`, which is the one stereotype this catalog
        // should not model: `unspecific-stereotype` asks a modeler to replace
        // it, and a page of things to write is no place to write one.
        const written = (await patterns).map(pattern => pattern.model).join('\n');
        for (const stereotype of [
            'kind', 'subkind', 'role', 'phase', 'roleMixin', 'phaseMixin', 'category', 'mixin',
            'collective', 'quantity', 'relator', 'quality', 'intrinsicMode', 'extrinsicMode',
            'event', 'situation', 'process', 'type', 'datatype', 'enum', 'historicalRole'
        ]) {
            expect(written, stereotype).toMatch(new RegExp(`\\b${stereotype}\\b`));
        }
        expect(written, 'a bare "class" is what the rules ask you to replace')
            .not.toMatch(/^\s*class\s/m);
    });
});

describe('a pattern asked for by a name it does not have', () => {
    const closest = (name: string): string[] =>
        /Closest: ([^.]*)\./.exec(missingPattern(name))?.[1].split(', ') ?? [];

    test('is answered with the closest, by OntoUML stereotype names too', () => {
        // The guess a live agent made, for what is component-parthood here.
        expect(closest('componentOf')[0]).toBe('component-parthood');
        expect(closest('memberOf')[0]).toBe('member-parthood');
        expect(closest('subCollectionOf')[0]).toBe('subcollection');
        expect(closest('roleMixin')[0]).toBe('role-mixin');
        expect(closest('mediation')[0]).toBe('role-and-relator');
    });

    test('and with every name, rather than the whole catalog', () => {
        const answer = missingPattern('nothing-like-it');
        expect(closest('nothing-like-it')).toEqual([]);
        for (const pattern of PATTERNS) expect(answer).toContain(pattern.name);
        expect(answer).not.toContain(PATTERNS[0].model);
        expect(answer.length).toBeLessThan(1500);
    });
});
