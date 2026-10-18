import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { TontoSession } from '../src/api.js';
import { writeInto } from '../src/exports.js';
import { asOntology, withNamespace } from './in-ontology.js';
import { catalog } from '../src/cli/patterns.js';
import { canonicalPath } from '../src/utils/paths.js';

/** Exports a snippet, its bare packages first given the ontology they belong to. */
function gufoOf(source: string, options?: Parameters<TontoSession['gufoText']>[1]): ReturnType<TontoSession['gufoText']> {
    return new TontoSession().gufoText(asOntology(source), options);
}

/** Exports a snippet whose ontology header, unless it says otherwise, publishes at `<namespace>#`. */
async function exportModel(source: string, namespace = 'https://example.org/test') {
    return gufoOf(withNamespace(source, `${namespace}#`));
}

/** Turtle with its line layout undone, each statement's continuations joined to it, for asserting on content. */
function flat(turtle: string): string {
    return turtle.replace(/\n +/g, ' ');
}

describe('the gUFO mapping', () => {
    test('pins the canonical gUFO 1.0.0 ontology used by conformance checks', () => {
        const fixture = readFileSync(new URL('fixtures/gufo-1.0.0.ttl', import.meta.url));
        expect(fixture.toString()).toContain('owl:versionIRI <http://purl.org/nemo/gufo#/1.0.0>');
        expect(createHash('sha256').update(fixture).digest('hex'))
            .toBe('b234c7a22d738b66dc8fcf735146fdbe828122e2a04bec43c8c9b08f34fd9027');
    });

    test('exports every published modeling pattern without error', async () => {
        for (const pattern of await catalog()) {
            const result = await exportModel(`package pattern\n${pattern.model}`,
                `https://example.org/patterns/${pattern.name}`);
            expect(result.diagnostics.filter(entry => entry.severity === 'error'), pattern.name).toEqual([]);
            expect(result.turtle, pattern.name).toContain('a owl:Ontology');
        }
    });

    test('keeps an exact bound on a datatype component, written const or not', async () => {
        // A value with another component is another value, so the component
        // is immutable and its upper bound survives the accumulated reading.
        for (const modifier of ['', 'const ']) {
            const result = await exportModel(`package p\ndatatype Address {\n    street: ${modifier}string\n}\n`);
            expect(flat(result.turtle), modifier || 'unwritten').toContain(
                '[ a owl:Restriction ; owl:onProperty p:Address.street ; owl:cardinality "1"^^xsd:nonNegativeInteger ]');
            expect(result.diagnostics.map(entry => entry.code), modifier || 'unwritten')
                .not.toContain('gufo-upper-bound-not-expressible');
        }
    });

    test('writes an export into a workspace whole, leaving no temporary behind', async () => {
        const workspace = canonicalPath(mkdtempSync(join(tmpdir(), 'tonto-gufo-write-')));
        const result = await exportModel('package p\nkind A\npackage q\nkind B\n');
        const written = writeInto(workspace, 'out', result.files);
        expect(written.map(file => basename(file.path))).toEqual(['p.ttl']);
        expect(readdirSync(join(workspace, 'out')).sort()).toEqual(['p.ttl']);
    });

    describe('writes Turtle as a careful author would', () => {
        const source = [
            'package p',
            '/// A car, as sold.',
            '/// Second line of the comment, with "quotes" and a backslash \\.',
            '/// @label Automobile',
            'kind Car {',
            '    @componenthood [1] <>-- [4] (const) Wheel',
            '}',
            'kind Wheel',
            ...Array.from({ length: 12 }, (_, index) => `kind LongEnoughKindName${index}`)
        ].join('\n');

        test('says what wrote it, and declares only the prefixes it uses', async () => {
            const { turtle } = await exportModel(source);
            expect(turtle.split('\n').slice(0, 2)).toEqual([
                '# Written by `tonto gufo` from the tonto ontology p.',
                '# Change the model and export it again, rather than this file.'
            ]);
            expect(turtle).not.toContain('@prefix rdf:');
            expect(turtle).toContain('@prefix xsd:');
        });

        test('types and annotations come before axioms, and a restriction takes a line per part', async () => {
            const { turtle } = await exportModel(source);
            const car = turtle.split('\n\n').find(chunk => chunk.startsWith('p:Car '))!;
            expect(car.split('\n').map(line => line.trim().split(' ')[0])).toEqual([
                'p:Car', 'rdfs:label', 'rdfs:comment', 'Second', 'rdfs:isDefinedBy', 'rdfs:subClassOf',
                'gufo:FunctionalComplex,', '[', 'owl:onProperty', 'owl:onClass', 'owl:qualifiedCardinality'
            ]);
            expect(car).toContain('        [ a owl:Restriction ;\n          owl:onProperty p:Car.hasComponentWheel ;');
        });

        test('a comment over lines keeps them, in the long form', async () => {
            const { turtle } = await exportModel(source);
            expect(turtle).toContain(
                'rdfs:comment """A car, as sold.\nSecond line of the comment, with \\"quotes\\" and a backslash \\\\.""" ;');
        });

        test('a list too long for a line takes a line per member, and a node nothing names is "[]"', async () => {
            const { turtle } = await exportModel(source);
            expect(turtle).toContain('[] a owl:AllDisjointClasses ;\n    owl:members (\n        p:Car\n        p:LongEnoughKindName0\n');
            expect(turtle).toMatch(/ {8}p:Wheel\n {4}\) \.\n/);
            expect(turtle).not.toContain('_:');
        });
    });

    test('writes the specification\'s worked example as the specification shows it', async () => {
        const specification = readFileSync(new URL('../../../docs/gufo-mapping.md', import.meta.url), 'utf8');
        const example = specification.slice(specification.indexOf('## 13. A worked example'));
        const fenced = (language: string) => example.split(`\`\`\`${language}\n`)[1]!.split('\`\`\`')[0]!;
        const { turtle } = await exportModel(fenced('tonto'), 'https://example.org/shop');
        const shown = turtle.split('\n')
            .filter(line => !line.startsWith('# ') && !/^@prefix (owl|rdfs|xsd):/.test(line))
            .join('\n').trim();
        expect(shown).toBe(fenced('turtle').trim());
    });

    describe('names every property and literal structurally through its owner', () => {
        const iris = (turtle: string) => [...turtle.matchAll(/^([a-z]+:[A-Za-z.]+) a owl:(?:Object|Datatype)Property/gm)]
            .map(match => match[1]).sort();

        test('a name used once still carries its owner', async () => {
            const result = await exportModel('package p\nkind Person { nickname: string }\nkind Car\nkind Garage { [*] -- stores -- [*] Car }\n');
            expect(iris(result.turtle)).toEqual(['p:Garage.stores', 'p:Person.nickname']);
        });

        test('the result is unchanged when another owner uses the same member name', async () => {
            const before = await exportModel('package p\nkind Person { name: string }\n');
            const after = await exportModel('package p\nkind Person { name: string }\nkind Product { name: string }\n');
            expect(iris(before.turtle)).toEqual(['p:Person.name']);
            expect(iris(after.turtle)).toEqual(['p:Person.name', 'p:Product.name']);
        });

        test('enumeration literals and a relation named like a class are structural too', async () => {
            const result = await exportModel(
                'package p\nenum Color { red, green }\nenum WineColor { red, white }\nkind Rack { [*] -- Color -- [*] WineColor }\n');
            expect(result.turtle).toContain('p:Color.red a owl:NamedIndividual, p:Color');
            expect(result.turtle).toContain('p:WineColor.red a owl:NamedIndividual, p:WineColor');
            expect(result.turtle).toContain('p:Color.green a owl:NamedIndividual, p:Color');
            expect(iris(result.turtle)).toEqual(['p:Rack.Color']);
        });

        test('two foreign and local owners with the same public name are not disambiguated by package', async () => {
            const result = await exportModel([
                'package core', 'kind Customer',
                'package sales', 'use core', 'kind Customer', 'kind Product',
                'relation Customer [*] -- [*] Product', 'relation core.Customer [*] -- [*] Product'
            ].join('\n'));
            expect(result.turtle).toBe('');
            expect(result.files).toEqual([]);
            expect(result.diagnostics.map(entry => entry.code)).toContain('namespace-name-clash');
        });

        test('an unstereotyped parthood is named from what is written, not from natures', async () => {
            for (const natures of ['functional-complexes', 'functional-complexes, relators']) {
                const result = await exportModel(
                    `package p\ncategory Part of ${natures}\nkind Machine { [1] <>-- [2..*] Part }\nkind Bolt specializes Part\n`);
                expect(iris(result.turtle), natures).toEqual(['p:Machine.hasProperPartPart']);
            }
        });

        test('and what owner qualification cannot tell apart is an error', async () => {
            const result = await exportModel('package p\nkind Person\nkind Team {\n[*] <>-- [2..*] (members) Person\n[*] <>-- [1] (captain) Person\n}\n');
            expect(result.turtle).toBe('');
            expect(result.diagnostics.map(entry => entry.code)).toContain('namespace-member-clash');
        });

        test('moving an owner between packages in one ontology leaves its member IRI unchanged', async () => {
            const shared = '/// @namespace https://example.org/shared#';
            const before = await exportModel([
                shared, 'package core', 'kind Customer', 'kind Product',
                shared, 'package sales', 'use core',
                'relation core.Customer [*] -- buys -- [*] core.Product'
            ].join('\n'));
            const after = await exportModel([
                shared, 'package core', 'kind Product',
                shared, 'package sales', 'use core', 'kind Customer',
                'relation Customer [*] -- buys -- [*] core.Product'
            ].join('\n'));
            expect(before.diagnostics.filter(entry => entry.severity === 'error')).toEqual([]);
            expect(after.diagnostics.filter(entry => entry.severity === 'error')).toEqual([]);
            expect(before.turtle).toContain('core:Customer.buys a owl:ObjectProperty');
            expect(after.turtle).toContain('core:Customer.buys a owl:ObjectProperty');
        });
    });

    describe('what gUFO shapes read (section 17)', () => {
        const block = (turtle: string, subject: string) =>
            turtle.split('\n\n').find(chunk => chunk.startsWith(`${subject} `)) ?? '';

        test('a partition\'s instances are stated disjoint, in one list when every pair is', async () => {
            // Disjoint through their lineage: Male and Female are, so Man and
            // Woman are, which the shape asks to see written for the pair.
            const result = await exportModel(`
                package p
                kind Person { @instantiation [*] -- [1] Gendered }
                type Gendered
                subkind Male specializes Person
                subkind Female specializes Person
                disjoint genset bySex where Male, Female specializes Person
                subkind Man (instanceOf Gendered) specializes Male
                subkind Woman (instanceOf Gendered) specializes Female
            `);
            expect(flat(result.turtle)).toContain('[] a owl:AllDisjointClasses ; owl:members ( p:Man p:Woman ) .');
            expect(result.turtle).not.toContain('owl:disjointWith');
        });

        test('and pair by pair, both ways, when some pair is not', async () => {
            const result = await exportModel(`
                package p
                kind Person { @instantiation [*] -- [1] Gendered }
                type Gendered
                subkind Male specializes Person
                subkind Female specializes Person
                disjoint genset bySex where Male, Female specializes Person
                subkind Man (instanceOf Gendered) specializes Male
                subkind Woman (instanceOf Gendered) specializes Female
                subkind Nun (instanceOf Gendered) specializes Woman
            `);
            expect(block(result.turtle, 'p:Man')).toContain('owl:disjointWith p:Nun, p:Woman');
            expect(block(result.turtle, 'p:Woman')).toContain('owl:disjointWith p:Man');
            expect(block(result.turtle, 'p:Nun')).toContain('owl:disjointWith p:Man');
            expect(block(result.turtle, 'p:Nun')).not.toMatch(/owl:disjointWith[^;.]*p:Woman/);
            expect(flat(result.turtle)).not.toContain('owl:members ( p:Man');
        });

        test('but not what may hold at different times, nor what the model left open', async () => {
            const phases = await exportModel(`
                package p
                kind Person
                phase Child specializes Person
                phase Adult specializes Person
                type AgeGroup
                disjoint complete genset byAge {
                    general Person
                    categorizer AgeGroup
                    specifics Child, Adult
                }
            `);
            expect(block(phases.turtle, 'p:AgeGroup')).toContain('gufo:partitions p:Person');
            expect(phases.turtle).not.toContain('owl:disjointWith');
            const open = await exportModel(`
                package p
                kind Car { @instantiation [*] -- [1] CarModel }
                type CarModel
                subkind Sedan (instanceOf CarModel) specializes Car
                subkind Hatch (instanceOf CarModel) specializes Car
            `);
            expect(open.turtle).not.toContain('owl:disjointWith');
        });

        test('direct specializations are written only when asked for', async () => {
            const source = `
                package p
                kind Person
                class Agentive of functional-complexes specializes Person
                subkind Worker specializes Agentive
                kind Car { @instantiation [*] -- [1..*] CarModel }
                type CarModel
                subkind Sedan specializes Car
                subkind CompactSedan (instanceOf CarModel) specializes Sedan
            `;
            const plain = await exportModel(source);
            const asked = await gufoOf(withNamespace(source, 'https://example.org/test#'), { directSpecializations: true });
            expect(block(plain.turtle, 'p:Worker')).not.toContain('p:Person');
            expect(block(asked.turtle, 'p:Worker')).toContain('rdfs:subClassOf p:Agentive, p:Person');
            expect(block(plain.turtle, 'p:CompactSedan')).toMatch(/rdfs:subClassOf p:Sedan[ ;.]*$/m);
            expect(block(asked.turtle, 'p:CompactSedan')).toContain('rdfs:subClassOf p:Sedan, p:Car');
        });
    });

    describe('what defines a term, and what describes the ontology', () => {
        const blocks = (turtle: string) => turtle.split('\n\n').filter(chunk => !chunk.startsWith('@prefix'));
        const header = (turtle: string) => blocks(turtle).find(chunk => chunk.includes('a owl:Ontology')) ?? '';

        test('every term the export mints is defined by the ontology, and nothing else is', async () => {
            const result = await exportModel(`
                package p
                kind Person { name: string }
                kind Car
                relation Person [*] -- [*] Car
                enum Color { red }
            `);
            const defined = blocks(result.turtle)
                .filter(chunk => chunk.includes('rdfs:isDefinedBy <https://example.org/test>'))
                .map(chunk => chunk.split(' ')[0]).sort();
            expect(defined).toEqual([
                'p:Car', 'p:Color', 'p:Color.red', 'p:Person', 'p:Person.hasCar', 'p:Person.name'
            ]);
            expect(header(result.turtle)).not.toContain('isDefinedBy');
        });

        test('labels come from "///" alone, and the name only when it gives none', async () => {
            const result = await exportModel([
                'package p',
                '/// @label:pt-br Pessoa', 'kind Person',
                '/// @label Automobile', 'kind Car',
                'kind Plain',
                'kind Legacy {', 'label { @en "Old name" }', 'description { @en "Old prose." }', '}'
            ].join('\n'));
            const block = (subject: string) => blocks(result.turtle).find(chunk => chunk.startsWith(`${subject} `)) ?? '';
            expect(block('p:Person')).toContain('rdfs:label "Pessoa"@pt-br ;');
            expect(block('p:Car')).toContain('rdfs:label "Automobile" ;');
            expect(block('p:Plain')).toContain('rdfs:label "Plain" ;');
            // The blocks are legacy: never exported, and said so.
            expect(block('p:Legacy')).toContain('rdfs:label "Legacy" ;');
            expect(block('p:Legacy')).not.toMatch(/Old name|Old prose/);
            expect(result.diagnostics.find(entry => entry.code === 'gufo-legacy-text-ignored')?.message)
                .toContain('--fix=legacy-text-block');
        });

        test('a lone package\'s documentation describes the ontology', async () => {
            const lone = await exportModel('/// Everything about people.\n/// @label People\npackage p\nkind Person\n');
            expect(header(lone.turtle)).toContain('rdfs:comment "Everything about people."');
            expect(header(lone.turtle)).toContain('rdfs:label "People"');
            expect(lone.diagnostics.map(entry => entry.code)).not.toContain('gufo-no-counterpart');
        });

        test('an ontology of several packages is described by its header', async () => {
            const several = await exportModel('/// Everything about people.\nontology people\npackage p\nkind Person\npackage q\nkind Car\n');
            expect(several.files).toHaveLength(1);
            expect(header(several.turtle)).toContain('rdfs:comment "Everything about people."');
        });
    });

    describe('documentation belongs to the outermost declaration on its line', () => {
        test('so a one-line enumeration or class keeps it from its members', async () => {
            const { turtle } = await exportModel([
                'package p', '/// Colors a car comes in.', '/// @label Color', 'enum Color { Red, Green }',
                '/// A car.', '/// @label Automobile', 'kind Car { name: string }'
            ].join('\n'));
            const block = (subject: string) => turtle.split('\n\n').find(chunk => chunk.startsWith(`${subject} `)) ?? '';
            expect(block('p:Color')).toContain('rdfs:label "Color"');
            expect(block('p:Color.Red')).toContain('rdfs:label "Red"');
            expect(block('p:Color.Red')).not.toContain('Colors a car');
            expect(block('p:Car')).toContain('rdfs:label "Automobile"');
            expect(block('p:Car.name')).toContain('rdfs:label "name"');
            expect(block('p:Car.name')).not.toContain('A car.');
        });
    });

    describe('ontology ownership determines export boundaries', () => {
        test('the packages of an ontology export together, as one ontology', async () => {
            const result = await exportModel('package core\nkind Person\npackage sales\nuse core\nkind Order { [*] -- [*] Person }');
            expect(result.files.map(file => file.ontology)).toEqual(['https://example.org/test']);
            expect(result.turtle).toContain('core:Order');
            expect(result.turtle).toContain('core:Person');
        });

        test('a package is published in its ontology\'s namespace, whatever it says above it', async () => {
            const result = await exportModel('/// @namespace https://example.org/one#\npackage a\nkind A\n/// @namespace https://example.org/two#\npackage b\nkind B');
            expect(result.files.map(file => file.ontology)).toEqual(['https://example.org/test']);
            expect(result.turtle).not.toContain('example.org/one');
            expect(result.turtle).not.toContain('example.org/two');
        });

        test('generic RDF export can still use a single slash namespace', async () => {
            const result = await exportModel('/// @namespace https://example.org/terms/\npackage terms\nkind Term');
            expect(result.files.map(file => file.ontology)).toEqual(['https://example.org/terms']);
        });

        test('an agreed namespace needs no inferred base', async () => {
            const result = await gufoOf('/// @namespace https://example.org/shop#\npackage shop\nkind A');
            expect(result.diagnostics.map(entry => entry.code)).not.toContain('gufo-placeholder-namespace');
            expect(result.files.map(file => file.file)).toEqual(['shop.ttl']);
        });

        test('an exact namespace applies to the entire implicit ontology', async () => {
            const result = await gufoOf('package a\nkind A\npackage b\nkind B', { namespaceIri: 'https://example.org/model#' });
            expect(result.diagnostics.filter(entry => entry.severity === 'error')).toEqual([]);
            expect(result.files).toHaveLength(1);
            expect(result.turtle).toContain('@prefix a: <https://example.org/model#>');
            expect(result.turtle).toContain('a:B');
        });

        test('an exact namespace means the same as an inherited annotation', async () => {
            const source = 'package conferences\nkind Person';
            const namespaceIri = 'https://example.org/conferences#';
            const supplied = await gufoOf(source, { namespaceIri });
            const declared = await gufoOf('/// @namespace ' + namespaceIri + '\n' + source);
            expect(supplied.turtle).toBe(declared.turtle);
        });

        test('an export override cannot replace an existing namespace', async () => {
            const result = await gufoOf('/// @namespace https://example.org/core#\npackage core\nkind Person', { namespaceIri: 'https://example.org/other#' });
            expect(result.files).toEqual([]);
            expect(result.diagnostics.map(entry => entry.code)).toContain('gufo-namespace-iri-ambiguous');
        });

        test('a missing namespace warning points to the ontology header', async () => {
            const result = await gufoOf('package z\nkind Z\npackage a\nkind A\nontology m');
            expect(result.diagnostics.find(entry => entry.code === 'gufo-placeholder-namespace')).toMatchObject({ file: 'draft', line: 5 });
            expect(result.turtle).toContain('<https://example.org/m#>');
        });

        test('an invalid namespace override is refused', async () => {
            const invalid = await gufoOf('package p\nkind Person', { namespaceIri: 'https://example.org/model' });
            expect(invalid.diagnostics.map(entry => entry.code)).toContain('gufo-invalid-namespace-iri');
        });

        test('an ontology of several packages is named after the ontology, not its namespace', async () => {
            const result = await exportModel('/// @namespace https://example.org/store#\nontology shop\npackage sales\nkind Order\npackage billing\nkind Invoice');
            expect(result.files.map(file => file.file)).toEqual(['shop.ttl']);
        });

        test('labels on packages label the packages, not their ontology', async () => {
            const result = await exportModel('ontology shop\n/// @label Sales\npackage sales\nkind Order\n/// @label Billing\npackage billing\nkind Invoice');
            expect(result.diagnostics.filter(entry => entry.severity === 'error')).toEqual([]);
            const ontology = result.turtle.split('\n\n').find(chunk => chunk.includes('a owl:Ontology')) ?? '';
            expect(ontology).toContain('a owl:Ontology');
            expect(ontology).not.toContain('rdfs:label');
        });

        test('identifier collisions are ordinary model errors, with no namespace needed', async () => {
            const result = await exportModel('package core\nkind Person\npackage sales\nkind Person');
            expect(result.files).toEqual([]);
            expect(result.diagnostics.map(entry => entry.code)).toContain('namespace-name-clash');
        });

        test('prefixes start with a letter and no package path is appended to a base', async () => {
            const result = await exportModel('package _internal\nkind A');
            expect(result.turtle).toContain('@prefix p_internal: <https://example.org/test#>');
        });
    });

    test('mints one semantic relation property and no end aliases', async () => {
        const result = await exportModel(`
            package sales
            kind Car {
                @componenthood [1] <>-- [1] (const engine) Engine
                @componenthood [1] <>-- [4] (wheels) Wheel
            }
            kind Engine
            kind Wheel
        `);
        expect(result.turtle).toContain('sales:Car.hasComponentEngine a owl:ObjectProperty');
        expect(result.turtle).toContain('sales:Car.hasComponentWheel a owl:ObjectProperty');
        expect(result.turtle).toContain('rdfs:subPropertyOf [ owl:inverseOf gufo:isComponentOf ]');
        expect(result.turtle).not.toContain('sales:engine');
        expect(result.turtle).not.toContain('sales:wheels');
        expect(result.diagnostics.map(entry => entry.code)).toContain('gufo-upper-bound-not-expressible');
    });

    describe('a historical role derived from what happened', () => {
        const university = [
            'package p', 'kind Person', 'role Student specializes Person', 'role Employee specializes Person',
            'kind University',
            'relator Enrollment {', '@mediation [1..*] -- [1] (const) Student', '@mediation [0..*] -- [1] (const) University', '}',
            'relator Employment {', '@mediation [1..*] -- [1] (const) Employee', '@mediation [0..*] -- [1] (const) University', '}',
            'event Graduation', 'event Retirement', 'event Dismissal', 'event Birth', 'subkind BirthInBrazil specializes Birth',
            '@participation relation Student (const) [1..*] -- graduatedIn -- [0..*] (addOnly) Graduation',
            '@participation relation Employee (const) [1] -- retiredIn -- [0..1] (const) Retirement',
            '@participation relation Employee (const) [1] -- wasDismissedIn -- [0..1] (const) Dismissal',
            '@creation relation Person (const) [1] -- wasBornIn -- [1] (const) Birth'
        ];
        const statement = (turtle: string, subject: string): string =>
            flat(turtle.split('\n\n').find(chunk => chunk.startsWith(`${subject} `)) ?? '');

        test('is defined by it, both ways', async () => {
            const result = await exportModel([...university,
                'historicalRole Graduate specializes Person derivedFrom Student.graduatedIn'].join('\n'));
            expect(result.diagnostics.filter(entry => entry.severity === 'error')).toEqual([]);
            expect(statement(result.turtle, 'p:Graduate')).toContain(
                'owl:equivalentClass [ a owl:Class ; owl:intersectionOf ( p:Person [ a owl:Restriction ; owl:onProperty p:Student.graduatedIn ; owl:someValuesFrom p:Graduation ] ) ]');
        });

        test('by any of several events, as a union', async () => {
            const result = await exportModel([...university,
                'historicalRole FormerEmployee specializes Person derivedFrom Employee.retiredIn, Employee.wasDismissedIn'].join('\n'));
            const definition = statement(result.turtle, 'p:FormerEmployee');
            expect(definition).toContain('owl:unionOf');
            expect(definition).toContain('owl:onProperty p:Employee.retiredIn ; owl:someValuesFrom p:Retirement');
            expect(definition).toContain('owl:onProperty p:Employee.wasDismissedIn ; owl:someValuesFrom p:Dismissal');
        });

        test('read for the event type named, narrower than the relation\'s', async () => {
            const result = await exportModel([...university,
                'historicalRole BornInBrazil specializes Person derivedFrom BirthInBrazil'].join('\n'));
            expect(statement(result.turtle, 'p:BornInBrazil'))
                .toContain('owl:onProperty p:Person.wasBornIn ; owl:someValuesFrom p:BirthInBrazil');
            expect(result.diagnostics.map(entry => entry.message)).toContain(
                'gUFO has no historical counterpart for "historicalRole"; its sortality is preserved, and its derivation from what happened is written as a definition, which is what keeps it from lapsing.');
        });
    });

    test('maps a participational portion to gufo:Participation', async () => {
        const result = await exportModel([
            'package p', 'kind Person',
            'event Meeting {',
            '@participational (const) [1] <>-- [2..*] (const) AttendeeParticipation',
            '}', 'event AttendeeParticipation',
            '@participation relation Person (const) [1] -- attended -- [0..*] (const) AttendeeParticipation'
        ].join('\n'));
        expect(result.diagnostics.filter(entry => entry.severity === 'error')).toEqual([]);
        const statement = (subject: string): string =>
            result.turtle.split('\n\n').find(chunk => chunk.startsWith(`${subject} `)) ?? '';
        expect(flat(statement('p:AttendeeParticipation')))
            .toContain('rdfs:subClassOf gufo:Event, gufo:Participation');
        expect(statement('p:Meeting')).not.toContain('gufo:Participation');
    });

    test('association-end renaming leaves the RDF unchanged', async () => {
        const withItems = await exportModel('package p\nkind A { -- [0..*] (items) B }\nkind B');
        const withThings = await exportModel('package p\nkind A { -- [0..*] (things) B }\nkind B');
        expect(withItems.turtle).toBe(withThings.turtle);
        expect(withItems.turtle).toContain('p:A.hasB a owl:ObjectProperty');
        expect(withItems.turtle).not.toContain('.items');
        expect(withThings.turtle).not.toContain('.things');
    });

    test('maps end subsetting between semantic relation expressions', async () => {
        const result = await exportModel(`
            package p
            kind Person
            collective Staff {
                @membership [1..*] <>-- [2..*] (members) Person
            }
            subkind SeniorStaff specializes Staff {
                @membership [1..*] <>-- [2..*] (seniorMembers subsets Staff.members) Person
            }
        `);
        expect(result.diagnostics.filter(entry => entry.severity === 'error')).toEqual([]);
        expect(flat(result.turtle)).toContain('rdfs:subPropertyOf [ owl:inverseOf gufo:isCollectionMemberOf ], p:Staff.hasCollectionMemberPerson');
        expect(result.turtle).toContain('p:SeniorStaff.hasCollectionMemberPerson a owl:ObjectProperty');
        expect(result.turtle).not.toContain('Staff.members');
        expect(result.turtle).not.toContain('SeniorStaff.seniorMembers');
    });

    test('refuses semantic-name collisions instead of using end names as aliases', async () => {
        const result = await exportModel(`
            package p
            kind A {
                -- [0..*] (first) B
                -- [0..*] (second) B
            }
            kind B
        `);
        expect(result.turtle).toBe('');
        expect(result.diagnostics.map(entry => entry.code)).toContain('namespace-member-clash');
    });

    test('uses the proposed directional vocabulary without importing gufoi', async () => {
        const result = await exportModel(`
            package p
            collective Team {
                @membership [1] <>-- [1..*] Person
            }
            kind Person
            quantity Clay
            kind Statue
            @constitution relation Statue [0..1] -- [1] Clay
            situation Configuration {
                @presence [0..*] -- [1..*] Person
            }
        `);
        expect(result.turtle).toContain('p:Team.hasCollectionMemberPerson');
        expect(result.turtle).toContain('p:Statue.isConstitutedByClay');
        expect(result.turtle).toContain('[ owl:inverseOf gufo:constitutes ]');
        expect(result.turtle).toContain('p:Configuration.involvesPerson');
        expect(result.turtle).not.toContain('gufoi:');
        expect(result.turtle).not.toContain('/gufo/inverse');
    });

    test('keeps presence alignment for every owl:Thing, including a type', async () => {
        const result = await exportModel(`
            package p
            situation Configuration {
                @presence [0..*] -- [1] VehicleType
            }
            type VehicleType
        `);
        expect(result.diagnostics.filter(entry => entry.severity === 'error')).toEqual([]);
        expect(result.turtle).toContain('p:Configuration.involvesVehicleType');
        expect(result.turtle).toContain('rdfs:subPropertyOf [ owl:inverseOf gufo:standsIn ]');
        expect(result.diagnostics.map(entry => entry.code)).not.toContain('gufo-alignment-dropped');
    });

    test('maps structured and literal datatype components differently', async () => {
        const result = await exportModel(`
            package values
            datatype Code
            datatype Address { street: string }
            datatype PostalAddress specializes Address
            enum Color { red, green }
        `);
        expect(result.turtle).toContain('values:Code a rdfs:Datatype');
        expect(result.turtle).toContain('owl:equivalentClass rdfs:Literal');
        expect(result.turtle).toContain('values:Address a owl:Class, gufo:AbstractIndividualType');
        expect(result.turtle).toContain('values:PostalAddress a owl:Class, gufo:AbstractIndividualType');
        expect(result.turtle).toContain('values:Color.red a owl:NamedIndividual, values:Color');
        expect(result.turtle).toContain('owl:distinctMembers ( values:Color.green values:Color.red )');
    });

    test('uses data cardinalities for literal-valued attributes', async () => {
        const result = await exportModel(`
            package p
            kind Person {
                code: const string [1]
            }
        `);
        expect(result.diagnostics.filter(entry => entry.severity === 'error')).toEqual([]);
        expect(flat(result.turtle)).toContain('owl:onProperty p:Person.code ; owl:cardinality "1"^^xsd:nonNegativeInteger');
        expect(result.turtle).not.toContain('owl:onClass xsd:string');
    });

    describe('a property with at most one value is declared so (section 10)', () => {
        const typesOf = (turtle: string, subject: string) =>
            flat(turtle.split('\n\n').find(chunk => chunk.startsWith(`${subject} `)) ?? '').split(' ;')[0] ?? '';

        test('where the export writes a max of one, and only there', async () => {
            const { turtle } = await exportModel(`
                package p
                kind Pessoa
                role Artista specializes Pessoa {
                    nomeArtistico: const string [1]
                }
                kind Banda {
                    nome: const string [1]
                    genero: string [1]
                    fundadaEm: const date [0..1]
                    apelidos: const string [0..2]
                }
            `);
            expect(typesOf(turtle, 'p:Banda.nome')).toBe('p:Banda.nome a owl:DatatypeProperty, owl:FunctionalProperty');
            expect(typesOf(turtle, 'p:Banda.fundadaEm')).toContain('owl:FunctionalProperty');
            // A second spell as an artist may bring a second name.
            expect(typesOf(turtle, 'p:Artista.nomeArtistico')).toBe('p:Artista.nomeArtistico a owl:DatatypeProperty');
            expect(typesOf(turtle, 'p:Banda.genero')).toBe('p:Banda.genero a owl:DatatypeProperty');
            expect(typesOf(turtle, 'p:Banda.apelidos')).toBe('p:Banda.apelidos a owl:DatatypeProperty');
        });

        test('and read from the source end, inverse-functional', async () => {
            const { turtle } = await exportModel(`
                package p
                kind Car {
                    @componenthood (const) [1] <>-- [1] (const) Engine
                    @componenthood [1] <>-- [4] Wheel
                }
                kind Engine
                kind Wheel
            `);
            expect(typesOf(turtle, 'p:Car.hasComponentEngine'))
                .toBe('p:Car.hasComponentEngine a owl:ObjectProperty, owl:FunctionalProperty, owl:InverseFunctionalProperty');
            expect(typesOf(turtle, 'p:Car.hasComponentWheel')).toBe('p:Car.hasComponentWheel a owl:ObjectProperty');
        });
    });

    test('writes what a derived relation is derived from (section 9.2)', async () => {
        const result = await exportModel(`
            package p
            kind Person
            role Employee specializes Person
            kind Organization
            relator Employment {
                @mediation [1..*] -- [1] (const) Employee
                @mediation [0..*] -- [1] (const) Organization
            }
            quality Height {
                @characterization [1] -- [1] (const) Person
            }
            @material relation Employee [0..*] -- worksFor -- [1..*] Organization derivedFrom Employment
            @comparative relation Person [0..*] -- tallerThan -- [0..*] Person derivedFrom Height
            @material relation Employee [0..*] -- employedBy -- [0..*] Organization
        `);
        expect(result.diagnostics.filter(entry => entry.severity === 'error')).toEqual([]);
        const turtle = flat(result.turtle);
        expect(turtle).toMatch(/p:Employee\.worksFor a owl:ObjectProperty, gufo:MaterialRelationshipType ;.* gufo:isDerivedFrom p:Employment [;.]/);
        expect(turtle).toMatch(/p:Person\.tallerThan a owl:ObjectProperty, gufo:ComparativeRelationshipType ;.* gufo:isDerivedFrom p:Height \./);
        // Not guessed where the model does not say it.
        expect(turtle.split('\n').find(line => line.startsWith('p:Employee.employedBy '))).not.toContain('isDerivedFrom');
    });

    describe('the snapshot layer states what holds at one instant (section 18)', () => {
        const specification = readFileSync(new URL('../../../docs/gufo-mapping.md', import.meta.url), 'utf8');
        const example = specification.slice(specification.indexOf('## 13. A worked example'))
            .split('```tonto\n')[1]!.split('```')[0]!;
        const layered = (source: string, namespace = 'https://example.org/shop') =>
            gufoOf(withNamespace(source, `${namespace}#`), { snapshot: true });

        test('is written only when asked for, and leaves the core as it was', async () => {
            const plain = await exportModel(example, 'https://example.org/shop');
            expect(plain.files.map(file => [file.file, file.snapshot])).toEqual([['sales.ttl', false]]);
            const result = await layered(example);
            expect(result.files.map(file => [file.file, file.ontology, file.snapshot, file.shapes])).toEqual([
                ['sales.ttl', 'https://example.org/shop', false, false],
                ['sales.snapshot.ttl', 'https://example.org/shop-snapshot', true, false],
                ['sales.shapes.ttl', 'https://example.org/shop-shapes', true, true]
            ]);
            expect(result.files[0]!.content).toBe(plain.files[0]!.content);
            expect(result.turtle).toBe('');
        });

        test('with the upper bounds and the disjointness the core withholds', async () => {
            const module = flat((await layered(example)).files[1]!.content);
            expect(module).toContain('<https://example.org/shop-snapshot> a owl:Ontology ;');
            expect(module).toContain('owl:imports <https://example.org/shop>');
            expect(module).toContain('[] a owl:AllDisjointClasses ; owl:members ( sales:Old sales:Young ) .');
            expect(module).toContain('sales:Person rdfs:subClassOf [ a owl:Restriction ; owl:onProperty sales:Person.name ;'
                + ' owl:maxCardinality "1"^^xsd:nonNegativeInteger ] .');
            expect(module).toContain('sales:Person.name a owl:FunctionalProperty .');
            expect(module).toContain('sales:Car rdfs:subClassOf [ a owl:Restriction ; owl:onProperty sales:Car.hasComponentWheel ;'
                + ' owl:onClass sales:Wheel ; owl:maxQualifiedCardinality "4"^^xsd:nonNegativeInteger ] .');
            expect(module).toContain('sales:Car.hasComponentWheel a owl:InverseFunctionalProperty .');
        });

        test('and each withheld axiom\'s note says the layer states it', async () => {
            const notes = (await layered(example)).diagnostics
                .filter(entry => ['gufo-upper-bound-not-expressible', 'gufo-disjointness-not-expressible'].includes(entry.code));
            expect(notes.length).toBeGreaterThan(0);
            expect(notes.every(entry => entry.message.includes('the snapshot layer states it'))).toBe(true);
        });

        test('a redefinition narrows what the general end reaches, at one instant', async () => {
            const result = await layered(`
                package r
                category Agent of functional-complexes
                kind Person specializes Agent
                collective Team {
                    @membership [*] <>-- [*] (members) Agent
                }
                phase SmallTeam specializes Team {
                    @membership [*] <>-- [*] (redefines Team.members) Person
                }
                phase BigTeam specializes Team`, 'https://example.org/test');
            expect(flat(result.files[0]!.content)).not.toContain('owl:allValuesFrom');
            expect(flat(result.files[1]!.content)).toContain('r:SmallTeam rdfs:subClassOf [ a owl:Restriction ;'
                + ' owl:onProperty r:Team.hasCollectionMemberAgent ; owl:allValuesFrom r:Person ] .');
        });

        test('but gives way to a chain, which the core keeps whatever layers are asked for', async () => {
            const result = await layered(`
                package w
                kind Person
                role Employee specializes Person
                kind Organization
                role Employer specializes Organization
                relator Employment {
                    @mediation [0..1] -- [1] (const) Employee
                    @mediation [0..*] -- [1] (const) Employer
                }
                @material relation Employee [0..*] -- worksFor -- [0..1] Employer derivedFrom Employment`, 'https://example.org/test');
            expect(result.files[0]!.content).toContain('owl:propertyChainAxiom');
            expect(result.files[1]!.content).not.toContain('w:Employee.worksFor');
            expect(result.diagnostics.find(entry => entry.code === 'gufo-snapshot-bound-withheld')?.message)
                .toContain('w:Employee.worksFor is implied by a chain');
        });

        test('one module for all packages of an ontology', async () => {
            const result = await layered('ontology m\npackage a\nkind A\npackage b\nuse a\nkind B {\n[*] -- [0..1] a.A\n}', 'https://example.org/m');
            expect(result.files.map(file => file.file)).toEqual(['m.ttl', 'm.snapshot.ttl', 'm.shapes.ttl']);
            const b = flat(result.files.find(file => file.file === 'm.snapshot.ttl')!.content);
            expect(b).toContain('owl:imports <https://example.org/m>');
            expect(b).toContain('owl:maxQualifiedCardinality "1"');
        });
    });

    describe('the snapshot layer\'s shapes check a graph of current state (section 18)', () => {
        const shapesOf = async (source: string) => flat((await gufoOf(withNamespace(source, 'https://example.org/t#'),
            { snapshot: true })).files.find(file => file.shapes)!.content);

        test('every multiplicity, with the class or datatypes at the end', async () => {
            const shapes = await shapesOf(`
                package p
                kind Person {
                    name: string
                    age: number [0..1]
                }
                kind Car {
                    @componenthood [1] <>-- [4] Wheel
                }
                kind Wheel`);
            expect(shapes).toContain('t-shapes:Person a sh:NodeShape ; sh:targetClass p:Person ; sh:property'
                + ' [ sh:path p:Person.name ; sh:name "name" ; sh:minCount 1 ; sh:maxCount 1 ; sh:datatype xsd:string ],'
                + ' [ sh:path p:Person.age ; sh:name "age" ; sh:maxCount 1 ; sh:or ( [ sh:datatype xsd:decimal ] [ sh:datatype xsd:integer ] ) ] .');
            expect(shapes).toContain('[ sh:path p:Car.hasComponentWheel ; sh:name "hasComponentWheel" ; sh:minCount 4 ; sh:maxCount 4 ; sh:class p:Wheel ]');
            expect(shapes).toContain('[ sh:path [ sh:inversePath p:Car.hasComponentWheel ] ; sh:name "hasComponentWheel" ;'
                + ' sh:minCount 1 ; sh:maxCount 1 ; sh:class p:Car ]');
        });

        test('counting a subsetting end\'s values toward the end it subsets', async () => {
            const shapes = await shapesOf(`
                package p
                kind Person
                collective Team {
                    @membership [*] <>-- hasMember -- [0..3] (members) Person
                    @membership [*] <>-- hasLeader -- [0..1] (leader subsets members) Person
                }`);
            expect(shapes).toContain('[ sh:path [ sh:alternativePath ( p:Team.hasLeader p:Team.hasMember ) ] ; sh:name "hasMember" ; sh:maxCount 3');
        });

        test('one specific of a set as the set says, at any one instant', async () => {
            const shapes = await shapesOf(`
                package p
                kind Person
                phase Young specializes Person
                phase Old specializes Person
                disjoint complete genset AgePhases where Young, Old specializes Person
                subkind Man specializes Person
                subkind Woman specializes Person
                disjoint genset Sex where Man, Woman specializes Person`);
            expect(shapes).toContain('t-shapes:AgePhases a sh:NodeShape ; sh:targetClass p:Person ;'
                + ' sh:xone ( [ sh:class p:Young ] [ sh:class p:Old ] ) ;');
            expect(shapes).toContain('t-shapes:Sex a sh:NodeShape ; sh:targetClass p:Person ; sh:xone ( [ sh:class p:Man ]'
                + ' [ sh:class p:Woman ] [ sh:not [ sh:or ( [ sh:class p:Man ] [ sh:class p:Woman ] ) ] ] ) ;');
        });

        test('and what founds a role, where no multiplicity says it', async () => {
            const shapes = await shapesOf(`
                package p
                kind Person
                event Retirement
                event Dismissal
                historicalRole FormerEmployee specializes Person {
                    @participation (const) [0..*] -- retiredIn -- [0..1] Retirement
                    @participation (const) [0..*] -- wasDismissedIn -- [0..1] Dismissal
                }`);
            expect(shapes).toContain('t-shapes:FormerEmployee_founded a sh:NodeShape ; sh:targetClass p:FormerEmployee ;'
                + ' sh:or ( [ sh:path p:FormerEmployee.retiredIn ; sh:minCount 1 ; sh:class p:Retirement ]'
                + ' [ sh:path p:FormerEmployee.wasDismissedIn ; sh:minCount 1 ; sh:class p:Dismissal ] ) ;');
        });

        test('including a bound the snapshot module had to leave to a chain', async () => {
            const shapes = await shapesOf(`
                package w
                kind Person
                role Employee specializes Person
                kind Organization
                role Employer specializes Organization
                relator Employment {
                    @mediation [0..1] -- [1] (const) Employee
                    @mediation [0..*] -- [1] (const) Employer
                }
                @material relation Employee [0..*] -- worksFor -- [0..1] Employer derivedFrom Employment`);
            expect(shapes).toContain('[ sh:path w:Employee.worksFor ; sh:name "worksFor" ; sh:maxCount 1 ; sh:class w:Employer ]');
        });
    });

    describe('an ontology says what it is, and under what terms (section 11)', () => {
        const headerOf = (turtle: string) => flat(turtle).split('\n').find(line => line.includes(' a owl:Ontology')) ?? '';

        test('a package\'s label, prose, version, license and creators, in the terms catalogs read', async () => {
            const result = await exportModel([
                '/// Who buys what.', '/// @label Sales', '/// @version 1.2.0',
                '/// @license https://creativecommons.org/licenses/by/4.0/',
                '/// @creator Bruno Costa', '/// @creator Ana Silva', 'package sales', 'kind Customer'
            ].join('\n'));
            const header = headerOf(result.turtle);
            expect(header).toContain('rdfs:label "Sales"');
            expect(header).toContain('dcterms:title "Sales"');
            expect(header).toContain('dcterms:description "Who buys what."');
            expect(header).toContain('owl:versionInfo "1.2.0"');
            expect(header).toContain('dcterms:license <https://creativecommons.org/licenses/by/4.0/>');
            expect(header).toContain('dcterms:creator "Ana Silva", "Bruno Costa"');
            expect(header).toContain('vann:preferredNamespacePrefix "sales" ; vann:preferredNamespaceUri "https://example.org/test#"');
            expect(result.turtle).toMatch(/dcterms:license a owl:AnnotationProperty \.\n/);
            expect(result.turtle).toContain('@prefix dcterms: <http://purl.org/dc/terms/> .');
        });

        test('a license that is not an IRI is written as text', async () => {
            const result = await exportModel('/// @license All rights reserved\npackage p\nkind A');
            expect(headerOf(result.turtle)).toContain('dcterms:license "All rights reserved"');
        });

        test('a package cannot give its ontology another version, and the header lists its creators', async () => {
            const clash = await exportModel('/// @namespace https://ex.org/m#\n/// @version 1\nontology m\n/// @version 2\npackage a\nkind A');
            expect(headerOf(clash.turtle)).toContain('owl:versionInfo "1"');
            const listed = await exportModel('/// @namespace https://ex.org/m#\n/// @creator Ana\n/// @creator Bruno\nontology m\npackage a\nkind A');
            expect(headerOf(listed.turtle)).toContain('dcterms:creator "Ana", "Bruno"');
        });

        test('an ontology is licensed by its header, not by a package', async () => {
            const license = '/// @license https://creativecommons.org/licenses/by/4.0/\n';
            expect(headerOf((await exportModel(`${license}ontology m\npackage a\nkind A`)).turtle))
                .toContain('dcterms:license <https://creativecommons.org/licenses/by/4.0/>');
            expect(headerOf((await exportModel(`ontology m\n${license}package a\nkind A`)).turtle))
                .not.toContain('dcterms:license');
        });

        test('and a property with a coined name is labeled with it, qualified as its IRI is', async () => {
            const result = await exportModel('package p\nkind Car {\n@componenthood [1] <>-- [4] Wheel\n}\nkind Wheel');
            expect(flat(result.turtle)).toMatch(/p:Car\.hasComponentWheel a owl:ObjectProperty ; rdfs:label "Car\.hasComponentWheel" ;/);
        });

        test('so two owners coining one name give two labels', async () => {
            // The subcollection pattern: ROBOT's report refuses two properties with one label.
            const result = await exportModel('package p\nkind Musician\ncollective Brass {\n@membership [1] <>-- [1..*] Musician\n}\n'
                + 'collective Strings {\n@membership [1] <>-- [1..*] Musician\n}');
            const labels = [...result.turtle.matchAll(/rdfs:label "([^"]*hasCollectionMember[^"]*)"/g)].map(match => match[1]);
            expect(labels.sort()).toEqual(['Brass.hasCollectionMemberMusician', 'Strings.hasCollectionMemberMusician']);
        });
    });

    describe('participation is carried up event parthood, for the classes (section 10.2)', () => {
        const source = `
            package p
            kind Person
            event Conference {
                @structural (const) [1] <>-- [2..*] (const) Meeting
            }
            event Meeting {
                @participational (const) [1] <>-- [2..*] (const) AttendeeParticipation
            }
            event AttendeeParticipation
            @participation relation Person (const) [1] -- attended -- [0..*] (const) AttendeeParticipation
            historicalRole Attendee specializes Person {
                @participation (const) [1] -- attendedAs -- [1..*] (const) AttendeeParticipation
            }`;
        const axiomsOf = (turtle: string, subject: string) =>
            flat(turtle).split('\n').find(line => line.startsWith(`${subject} `)) ?? '';

        test('whoever must attend took part in a meeting, and so in a conference', async () => {
            const { turtle } = await exportModel(source);
            const attendee = axiomsOf(turtle, 'p:Attendee');
            expect(attendee).toContain('[ a owl:Restriction ; owl:onProperty gufo:participatedIn ; owl:someValuesFrom p:Meeting ]');
            expect(attendee).toContain('[ a owl:Restriction ; owl:onProperty gufo:participatedIn ; owl:someValuesFrom p:Conference ]');
            // Person's own portion is optional, so nothing follows for every person.
            expect(axiomsOf(turtle, 'p:Person')).not.toContain('gufo:participatedIn');
        });

        test('a meeting with two portions has two participants, counted by the narrowest type each must be', async () => {
            const meeting = axiomsOf((await exportModel(source)).turtle, 'p:Meeting');
            expect(meeting).toContain('[ a owl:Restriction ; owl:onProperty [ owl:inverseOf gufo:participatedIn ] ;'
                + ' owl:onClass p:Attendee ; owl:minQualifiedCardinality "2"^^xsd:nonNegativeInteger ]');
            expect(meeting).not.toContain('owl:onClass p:Person');
        });

        test('but a structural part is not one per participant, so nothing is counted through it', async () => {
            expect(axiomsOf((await exportModel(source)).turtle, 'p:Conference')).not.toContain('gufo:participatedIn');
        });
    });

    describe('a role says what founds it (section 10.1)', () => {
        const conditionsOf = (turtle: string, subject: string) =>
            flat(turtle).split('\n').find(line => line.startsWith(`${subject} `)) ?? '';

        test('from the stereotype, where the multiplicity leaves it optional', async () => {
            const result = await exportModel(`
            package p
            kind Person
            role Student specializes Person
            kind University
            relator Enrollment {
                @mediation [0..*] -- [1] (const) Student
                @mediation [0..*] -- [1] (const) University
            }`);
            expect(conditionsOf(result.turtle, 'p:Student')).toContain('rdfs:subClassOf p:Person,'
                + ' [ a owl:Restriction ; owl:onProperty [ owl:inverseOf p:Enrollment.mediatesStudent ] ; owl:someValuesFrom p:Enrollment ] .');
        });

        test('as a union where any one of several founds it', async () => {
            const result = await exportModel(`
            package p
            kind Person
            event Retirement
            event Dismissal
            historicalRole FormerEmployee specializes Person {
                @participation (const) [0..*] -- retiredIn -- [0..1] Retirement
                @participation (const) [0..*] -- wasDismissedIn -- [0..1] Dismissal
            }`);
            expect(conditionsOf(result.turtle, 'p:FormerEmployee')).toContain('[ a owl:Class ; owl:unionOf ('
                + ' [ a owl:Restriction ; owl:onProperty p:FormerEmployee.retiredIn ; owl:someValuesFrom p:Retirement ]'
                + ' [ a owl:Restriction ; owl:onProperty p:FormerEmployee.wasDismissedIn ; owl:someValuesFrom p:Dismissal ] ) ]');
        });

        test('once, where a mandatory relation has already said it', async () => {
            const result = await exportModel(`
            package p
            kind Person
            event Graduation
            historicalRole FormerStudent specializes Person {
                @participation (const) [0..*] -- graduatedIn -- [1] Graduation
                @participation (const) [0..*] -- attended -- [0..*] Graduation
            }`);
            const line = conditionsOf(result.turtle, 'p:FormerStudent');
            expect(line.match(/owl:someValuesFrom/g)).toHaveLength(1);
            expect(line).not.toContain('owl:unionOf');
        });

        test('and not from what a supertype founded the same way already founds', async () => {
            const result = await exportModel(`
            package p
            category Agent of functional-complexes
            roleMixin Customer specializes Agent
            kind Person specializes Agent
            role PersonalCustomer specializes Person, Customer
            kind Shop
            relator Purchase {
                @mediation [0..*] -- [1] (const) Customer
                @mediation [0..*] -- [1] (const) Shop
            }
            relator LoyaltyCard {
                @mediation [0..*] -- [1] (const) PersonalCustomer
                @mediation [0..*] -- [1] (const) Shop
            }`);
            expect(conditionsOf(result.turtle, 'p:Customer')).toContain('owl:someValuesFrom p:Purchase');
            expect(conditionsOf(result.turtle, 'p:PersonalCustomer')).not.toContain('LoyaltyCard');
        });
    });

    describe('a material relation is implied by the chain through its relator (section 9.2)', () => {
        const people = `
            package p
            kind Person
            role Employee specializes Person
            role Spouse specializes Person
            kind Organization
            role Employer specializes Organization
            relator Employment {
                @mediation [0..*] -- [1] (const) Employee
                @mediation [0..*] -- [1] (const) Employer
            }
        `;
        const chains = (turtle: string) => flat(turtle).split('\n').filter(line => line.includes('owl:propertyChainAxiom'));
        const withheld = (result: Awaited<ReturnType<typeof exportModel>>) => result.diagnostics
            .filter(entry => entry.code === 'gufo-derivation-chain-withheld').map(entry => entry.message);

        test('from the employee back to the employment and on to the employer', async () => {
            const result = await exportModel(`${people}
            @material relation Employee [0..*] -- worksFor -- [0..*] Employer derivedFrom Employment
            @material relation Employee [0..*] -- employedBy -- [0..*] Employer`);
            expect(result.diagnostics.filter(entry => entry.severity === 'error')).toEqual([]);
            expect(chains(result.turtle)).toEqual([expect.stringMatching(/^p:Employee\.worksFor .* owl:propertyChainAxiom/)]);
            expect(flat(result.turtle)).toContain(
                'owl:propertyChainAxiom ( [ owl:inverseOf p:Employment.mediatesEmployee ] p:Employment.mediatesEmployer ) .');
            expect(withheld(result)).toEqual([]);
        });

        test('and from an extrinsic mode, through what it inheres in and what it depends on', async () => {
            const result = await exportModel(`
            package p
            kind Person
            kind Organization
            extrinsicMode Loyalty {
                @characterization [0..*] -- [1] (const) Person
                @externalDependence [0..*] -- [1] (const) Organization
            }
            @material relation Organization [0..*] -- hasLoyalist -- [0..*] Person derivedFrom Loyalty`);
            expect(flat(result.turtle)).toContain('owl:propertyChainAxiom'
                + ' ( [ owl:inverseOf p:Loyalty.externallyDependsOnOrganization ] p:Loyalty.inheresInPerson ) .');
        });

        test('but not where OWL 2 DL would then drop a bound the model states', async () => {
            const result = await exportModel(`
            package p
            kind Person
            role Employee specializes Person
            kind Organization
            role Employer specializes Organization
            relator Employment {
                @mediation [0..*] -- [2] (const) Employee
                @mediation [1..*] -- [1] (const) Employer
            }
            @material relation Employer [0..*] -- employs -- [2..*] Employee derivedFrom Employment`);
            expect(chains(result.turtle)).toEqual([]);
            expect(flat(result.turtle)).toContain('owl:minQualifiedCardinality "2"^^xsd:nonNegativeInteger');
            expect(withheld(result)).toEqual([expect.stringContaining('cardinality restriction or functional characteristic')]);
        });

        test('nor through one mediation read both ways, which relates each spouse to themselves', async () => {
            const result = await exportModel(`${people}
            relator Marriage {
                @mediation [0..1] -- [2] (const) Spouse
            }
            @material relation Spouse [0..1] -- isMarriedTo -- [0..1] Spouse derivedFrom Marriage`);
            expect(chains(result.turtle)).toEqual([]);
            expect(withheld(result)).toEqual([expect.stringContaining('relate each individual to itself')]);
        });

        test('nor through a mediation inherited from a relator every other contract shares', async () => {
            const result = await exportModel(`
            package p
            kind Person
            kind Organization
            relator Contract {
                @mediation [1..*] -- [1] (const) Person
                @mediation [0..*] -- [1] (const) Organization
            }
            subkind EmploymentContract specializes Contract
            @material relation Person [0..*] -- worksFor -- [0..*] Organization derivedFrom EmploymentContract`);
            expect(chains(result.turtle)).toEqual([]);
            expect(withheld(result)).toEqual([expect.stringContaining('no dependence of its own on "Person"')]);
        });
    });

    describe('a redefining end narrows what the redefined end reaches (section 9.6)', () => {
        const source = `
            package p
            category Agent
            kind Person specializes Agent
            kind Organization specializes Agent
            relator Contract {
                @mediation [1..*] -- [1] (holder) Agent
            }
            subkind EmploymentContract specializes Contract {
                @mediation [1..*] -- [1] (redefines Contract.holder) Person
            }
            collective Team {
                @membership (teams) [*] <>-- [*] (members) Agent
            }
            subkind Family specializes Team {
                @membership [*] <>-- [*] (redefines Team.members) Person
            }
            phase SmallTeam specializes Team {
                @membership [*] <>-- [*] (redefines Team.members) Person
            }
            phase BigTeam specializes Team
        `;
        const notes = (result: Awaited<ReturnType<typeof exportModel>>) => result.diagnostics
            .filter(entry => entry.code === 'gufo-no-counterpart').map(entry => entry.message);

        test('when every link it ever holds is held while the owner is one', async () => {
            const result = await exportModel(source);
            expect(result.diagnostics.filter(entry => entry.severity === 'error')).toEqual([]);
            const turtle = flat(result.turtle);
            expect(turtle).toContain('p:EmploymentContract a owl:Class, gufo:SubKind ; rdfs:label "EmploymentContract" ;'
                + ' rdfs:isDefinedBy <https://example.org/test> ; rdfs:subClassOf p:Contract,'
                + ' [ a owl:Restriction ; owl:onProperty p:Contract.mediatesAgent ; owl:allValuesFrom p:Person ],');
            expect(turtle).toContain('[ a owl:Restriction ; owl:onProperty p:Team.hasCollectionMemberAgent ; owl:allValuesFrom p:Person ]');
            expect(notes(result)).toContain('OWL preserves the subproperty part of redefines and that Family reaches only'
                + ' Person through the general end, but not that the general end holds no other links.');
        });

        test('and not under a phase, whose earlier spells may have held others', async () => {
            const result = await exportModel(source);
            const smallTeam = flat(result.turtle).split('\n\n').find(chunk => chunk.startsWith('p:SmallTeam '));
            expect(smallTeam).toBeDefined();
            expect(smallTeam).not.toContain('owl:allValuesFrom');
            expect(notes(result).filter(message => message.includes('SmallTeam may have held other links'))).toHaveLength(1);
        });

        test('through the source end as well', async () => {
            const result = await exportModel(`
                package p
                kind Person
                subkind Child specializes Person
                collective Team {
                    @membership (teams) [*] <>-- [*] Person
                }
                subkind Family specializes Team {
                    @membership (redefines Person.teams) [*] <>-- [*] Child
                }
            `);
            expect(result.diagnostics.filter(entry => entry.severity === 'error')).toEqual([]);
            expect(flat(result.turtle)).toContain('[ a owl:Restriction ;'
                + ' owl:onProperty [ owl:inverseOf p:Team.hasCollectionMemberPerson ] ; owl:allValuesFrom p:Family ]');
        });

        test('saying nothing new when the type is not narrowed', async () => {
            const result = await exportModel(`
                package p
                kind Person
                collective Team {
                    [*] -- [*] (members) Person
                }
                subkind Family specializes Team {
                    [*] -- [*] (redefines Team.members) Person
                }
            `);
            expect(result.turtle).not.toContain('owl:allValuesFrom');
            expect(notes(result)).toEqual(
                ['OWL preserves the subproperty part of redefines, but not the replacement of the general end.']);
        });
    });

    test('writes a bounded range as two restrictions, one constraint each', async () => {
        // The OWL 2 RDF mapping has no restriction node with both a min and a
        // max; OWLAPI reads the second as an annotation and drops the bound.
        const result = await exportModel(`
            package p
            kind Car {
                code: const string [1..2]
                @componenthood [1] <>-- [2..4] (const) Wheel
            }
            kind Wheel
        `);
        expect(result.diagnostics.filter(entry => entry.severity === 'error')).toEqual([]);
        expect(flat(result.turtle)).toContain(
            '[ a owl:Restriction ; owl:onProperty p:Car.code ; owl:minCardinality "1"^^xsd:nonNegativeInteger ]');
        expect(flat(result.turtle)).toContain(
            '[ a owl:Restriction ; owl:onProperty p:Car.code ; owl:maxCardinality "2"^^xsd:nonNegativeInteger ]');
        expect(flat(result.turtle)).toContain('[ a owl:Restriction ; owl:onProperty p:Car.hasComponentWheel ; '
            + 'owl:onClass p:Wheel ; owl:minQualifiedCardinality "2"^^xsd:nonNegativeInteger ]');
        expect(flat(result.turtle)).toContain('[ a owl:Restriction ; owl:onProperty p:Car.hasComponentWheel ; '
            + 'owl:onClass p:Wheel ; owl:maxQualifiedCardinality "4"^^xsd:nonNegativeInteger ]');
        expect(result.turtle).not.toMatch(/Cardinality[^\]]*Cardinality/);
    });

    test('carries documentation without assuming English', async () => {
        const result = await exportModel(`
            package p
            /// A person.
            /// @label Pessoa
            /// @label:pt-br Pessoa
            kind Person
        `);
        expect(result.turtle).toContain('rdfs:comment "A person."');
        expect(result.turtle).toContain('rdfs:label "Pessoa", "Pessoa"@pt-br');
        expect(result.turtle).not.toContain('"Person"@en');
    });

    test('accepts the complete BCP 47 syntax, including private-use tags', async () => {
        const accepted = await exportModel(`
            package p
            /// @label:x-private A private label
            kind Person
        `);
        expect(accepted.diagnostics.filter(entry => entry.severity === 'error')).toEqual([]);
        expect(accepted.turtle).toContain('"A private label"@x-private');

        const rejected = await exportModel(`
            package p
            /// @label:not_a_tag Invalid
            kind Person
        `);
        expect(rejected.turtle).toBe('');
        expect(rejected.diagnostics.map(entry => entry.code)).toContain('gufo-invalid-language-tag');
    });

    test('an ontology is its namespace without the closing "#", however many packages it has', async () => {
        const one = await exportModel('package p\nkind A', 'https://example.org/base');
        expect(one.turtle).toContain('<https://example.org/base#>');
        expect(one.turtle).toContain('<https://example.org/base> a owl:Ontology');
        const several = await exportModel('package p\nkind A\npackage q\nkind B', 'https://example.org/base');
        expect(several.files).toHaveLength(1);
        expect(several.files[0]!.content).toContain('<https://example.org/base> a owl:Ontology');
        expect(several.files[0]!.content).not.toContain('base/p');
    });

    test('stops atomically on model and export errors', async () => {
        const broken = await exportModel('package p\nkind A\nkind B specializes A');
        expect(broken.turtle).toBe('');
        expect(broken.diagnostics[0]?.code).toBe('gufo-model-has-errors');

        const badIri = await gufoOf('package p\nkind A', { namespaceIri: 'urn:not-http#' });
        expect(badIri.turtle).toBe('');
        expect(badIri.diagnostics.map(entry => entry.code)).toEqual(['gufo-invalid-namespace-iri']);

        const unsafeIri = await gufoOf('package p\nkind A', { namespaceIri: 'https://example.org/not valid#' });
        expect(unsafeIri.turtle).toBe('');
        expect(unsafeIri.diagnostics.map(entry => entry.code)).toEqual(['gufo-invalid-namespace-iri']);
    });

    test('reports a literal-source relation without minting a phantom property', async () => {
        const result = await exportModel(`
            package p
            datatype Code
            kind Item
            relation Code [0..*] -- [0..*] Item
        `);
        expect(result.diagnostics.filter(entry => entry.severity === 'error')).toEqual([]);
        expect(result.diagnostics.map(entry => entry.code)).toContain('gufo-no-counterpart');
        expect(result.turtle).not.toContain('Code.hasItem');
    });
});
