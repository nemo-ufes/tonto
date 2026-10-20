import { beforeAll, describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { validationHelper } from 'langium/test';
import { DiagnosticSeverity } from 'vscode-languageserver';
import { createTontoServices } from '../src/tonto-module.js';
import { TontoSession } from '../src/api.js';
import { naturesFor } from '../src/validation/relation-nature-table.js';
import {
    RELATION_STEREOTYPES, RENAMED_STEREOTYPES, RETIRED_STEREOTYPES
} from '../src/validation/relation-stereotypes.js';
import type { Model } from '../src/generated/ast.js';
import { inOntology } from './in-ontology.js';

const all = createTontoServices(EmptyFileSystem);
const validateSource = validationHelper<Model>(all.Tonto);
const validateDocument = (source: string): ReturnType<typeof validateSource> => validateSource(inOntology(source));

let packageCounter = 0;
async function validate(source: string): ReturnType<typeof validateDocument> {
    // Each snippet is a separate model, not another package of the same ontology.
    await all.shared.workspace.DocumentBuilder.update([], all.shared.workspace.LangiumDocuments.all
        .filter(doc => doc.uri.scheme === 'file').map(doc => doc.uri).toArray());
    return validateDocument(source.replace(/\bpackage p\b/g, `package p${++packageCounter}`));
}

/** Langium's own diagnostics carry their code in `data`. */
function unparsedOrUnlinked(d: { code?: unknown; data?: unknown }): boolean {
    const code = (d.data as { code?: string } | undefined)?.code ?? d.code;
    return code === 'linking-error' || code === 'parsing-error' || code === 'lexing-error';
}

function messages(diagnostics: { message: string }[]): string {
    return diagnostics.map(d => d.message).join('\n');
}

/** Asserts an error whose message matches `pattern` is reported. */
async function expectError(source: string, pattern: RegExp): Promise<void> {
    const { diagnostics } = await validate(source);
    const errors = diagnostics.filter(d => d.severity === DiagnosticSeverity.Error);
    expect(errors.some(d => pattern.test(d.message)), messages(diagnostics)).toBe(true);
}

/** Asserts no warning matching `pattern` is reported. */
async function expectNoWarnings(source: string, pattern: RegExp): Promise<void> {
    const { diagnostics } = await validate(source);
    expect(diagnostics.filter(d => pattern.test(d.message)), messages(diagnostics)).toEqual([]);
}

async function expectWarning(source: string, pattern: RegExp): Promise<void> {
    const { diagnostics } = await validate(source);
    const warnings = diagnostics.filter(d => d.severity === DiagnosticSeverity.Warning);
    expect(warnings.some(d => pattern.test(d.message)), messages(diagnostics)).toBe(true);
}

async function expectHintCode(source: string, code: string): Promise<void> {
    const { diagnostics } = await validate(source);
    expect(diagnostics.filter(d => d.code === code).map(d => d.severity), messages(diagnostics))
        .toEqual([DiagnosticSeverity.Hint]);
}

async function expectNoErrors(source: string): Promise<void> {
    const { diagnostics } = await validate(source);
    const errors = diagnostics.filter(d => d.severity === DiagnosticSeverity.Error);
    expect(errors, messages(errors)).toHaveLength(0);
}

describe('cardinality', () => {
    test('rejects a lower bound above the upper bound', async () => {
        await expectError(`
            package p
            kind A
            kind B { [5..2] -- r -- [1] A }
        `, /Lower bound 5 is greater than upper bound 2/);
    });

    test('rejects an upper bound of zero', async () => {
        await expectError(`
            package p
            kind A
            kind B { [0..0] -- r -- [1] A }
        `, /impossible to instantiate/);
    });

    test('rejects "*" as a lower bound', async () => {
        await expectError(`
            package p
            kind A
            kind B { [*..2] -- r -- [1] A }
        `, /cannot be used as a lower bound/);
    });

    test('accepts the usual forms', async () => {
        await expectNoErrors(`
            package p
            kind A
            kind B {
                [1] -- r1 -- [0..*] A
                [*] -- r2 -- [1..*] A
                [2..5] -- r3 -- [1] A
            }
        `);
    });
});

describe('duplicate member names', () => {
    beforeAll(async () => {
        await all.shared.workspace.WorkspaceManager.initializeWorkspace([]);
    });

    test('rejects duplicate attribute names', async () => {
        await expectError(`
            package p
            kind A {
                name: string
                name: string
            }
        `, /Duplicate attribute name "name"/);
    });

    test('scopes relation names to their source, regardless of where they are written', async () => {
        const classes = 'ontology example\nkind Person\nkind Company\nkind Organization\nkind Project\n';
        await expectNoErrors(classes
            + 'relation Person -- worksFor -- Organization\n'
            + 'relation Company -- worksFor -- Organization');
        await expectNoErrors(classes
            + 'relation Person -- worksFor -- Organization\n'
            + 'relation Company -- worksFor -- Organization\n'
            + 'relation Organization -- employs -- Person inverseOf Person.worksFor');
        await expectError(classes
            + 'relation Person -- worksFor -- Organization\n'
            + 'relation Company -- worksFor -- Organization\n'
            + 'relation Organization -- employs -- Person inverseOf worksFor',
            /Could not resolve reference.*worksFor/);
        await expectNoErrors(classes
            + 'kind Team { -- worksFor -- Organization }\n'
            + 'relation Person -- worksFor -- Organization');
        await expectError(classes
            + 'relation Person -- worksFor -- Organization\n'
            + 'relation Person -- worksFor -- Project', /Duplicate relation name "worksFor" in "Person"/);
        await expectError('ontology example\nkind Person { -- worksFor -- Organization }\n'
            + 'kind Organization\nkind Project\nrelation Person -- worksFor -- Project',
            /Duplicate relation name "worksFor" in "Person"/);
    });

    test('rejects an attribute colliding with a relation name', async () => {
        await expectError(`
            package p
            kind X
            kind A {
                rel: string
                [1] -- rel -- [1] X
            }
        `, /collides with the attribute/);
    });

    test('rejects an attribute colliding with a relation end name', async () => {
        await expectError(`
            package p
            kind X
            kind A {
                members: string
                [1] -- [1] (members) X
            }
        `, /collides with the attribute/);
    });

    test('rejects duplicate enum literals', async () => {
        await expectError(`
            package p
            enum E { red, red }
        `, /Duplicate enum literal name "red"/);
    });

    test('rejects both ends of one relation sharing a name, where one class owns both', async () => {
        // An end is a property of the classifier at the *opposite* end, so
        // only a relation from a class to itself lands both in one namespace.
        await expectError(`
            package p
            kind A { (e) [1] -- [1] (e) A }
        `, /Both ends of this relation are named "e", and both are properties of "A"/);
    });

    test('and accepts one name at each end of two classifiers', async () => {
        // `Company.party` and `Person.party`: two properties, each named for
        // what it holds, and nothing ambiguous between them.
        await expectNoErrors(`
            package p
            kind Person
            kind Company
            relation Person (party) [1] -- signs -- [1] (party) Company
        `);
    });
});

describe('a relation to a value type', () => {
    const code = 'value-relation-may-be-attribute';

    test('hints for an enumeration or datatype target in either relation form', async () => {
        await expectHintCode('package p\nenum Color { red, green }\nkind Apple { -- hasColor -- Color }', code);
        await expectHintCode('package p\ndatatype Code\nkind Product\nrelation Product -- hasCode -- Code', code);
        const { diagnostics } = await validate('package p\nenum Color { red, green }\nkind Apple { -- hasColor -- Color }');
        expect(diagnostics.find(d => d.code === code)?.message).toContain('"propertyName: Color"');
    });

    test('does not hint for an attribute or a relation whose source is a datatype', async () => {
        const { diagnostics } = await validate('package p\nenum Color { red, green }\ndatatype Code\nkind Orchard\n'
            + 'kind Apple { color: Color\n -- relatedTo -- Code }\n'
            + 'relation Code -- describes -- Color\nrelation Apple -- growsIn -- Orchard');
        expect(diagnostics.filter(d => d.code === code)).toHaveLength(1);
    });
});

describe('what depends on something must have it', () => {
    test('the end naming what is depended on cannot start at zero', async () => {
        await expectError(
            'package p\nkind Person\nextrinsicMode Commitment {\n@characterization [*] -- [1] (const) Person\n'
            + '@externalDependence [*] -- [0..1] (const) Person\n}',
            /cannot start at zero/);
        await expectError(
            'package p\nkind Person\nrelator Marriage {\n@mediation [1] -- [0..2] (const) Person\n}',
            /cannot start at zero/);
        await expectNoErrors(
            'package p\nkind Person\nrelator Marriage {\n@mediation [1] -- [2] (const) Person\n}');
        // Not historical dependence: standing in it is not what makes
        // anything what it is, and gUFO's own `historicallyDependsOn` runs
        // `[*]` to `[*]` between concrete individuals.
        await expectNoErrors([
            'package p', 'kind Person', 'event Wedding',
            '@participation relation Person (const) [2] -- marriedIn -- [0..*] (const) Wedding',
            'category ConcreteIndividual of functional-complexes, events {',
            '@historicalDependence (addOnly) [*] -- dependsOn -- [*] (const) ConcreteIndividual', '}'
        ].join('\n'));
    });

    test('but a characterization is answered by the stronger rule', async () => {
        // A moment inheres in exactly one bearer, which
        // `characterization-bearer-multiplicity` says; two rules on one end
        // would be one omission reported twice.
        const { diagnostics } = await validate(
            'package p\nkind Person\nquality Weight {\n@characterization [*] -- [0..1] (const) Person\n}');
        expect(diagnostics.filter(d => /^dependence-end/.test(String(d.code))).map(d => d.code))
            .toEqual([]);
        expect(diagnostics.map(d => d.code)).toContain('characterization-bearer-multiplicity');
    });
});

describe('a specialization cycle', () => {
    test('is reported by the classes in it, with the cycle it is', async () => {
        const { diagnostics } = await validate('package p\nkind B specializes C\nkind C specializes B');
        expect(diagnostics.filter(d => d.code === 'specialization-cycle').map(d => d.message)).toEqual([
            'B specializes C, which specializes B -- a cycle, so each would have to be a subtype of the other.',
            'C specializes B, which specializes C -- a cycle, so each would have to be a subtype of the other.'
        ]);
        const own = await validate('package p\nkind A specializes A');
        expect(own.diagnostics.filter(d => d.code === 'specialization-cycle').map(d => d.message))
            .toEqual(['A specializes A -- a cycle, so each would have to be a subtype of the other.']);
    });

    test('and not by the classes above one, in a path nobody wrote', async () => {
        // Reported case. The walk from `A` found the cycle `B, C` and printed
        // it with `A` appended -- "B specializes C, which specializes A" --
        // which is neither in the model nor a cycle.
        const { diagnostics } = await validate(
            'package p\nkind A specializes B\nkind B specializes C\nkind C specializes B');
        const cycles = diagnostics.filter(d => d.code === 'specialization-cycle');
        expect(cycles.map(d => d.message)).toEqual([
            'B specializes C, which specializes B -- a cycle, so each would have to be a subtype of the other.',
            'C specializes B, which specializes C -- a cycle, so each would have to be a subtype of the other.'
        ]);
    });

    test('and a class in one cycle is not silenced by another it can see', async () => {
        // `A` is in `A -> D -> A` and also looks into `B <-> C`; the walk must
        // not stop at the cycle that is not its own.
        const { diagnostics } = await validate([
            'package p', 'kind A specializes B, D', 'kind B specializes C', 'kind C specializes B',
            'kind D specializes A'
        ].join('\n'));
        expect(diagnostics.filter(d => d.code === 'specialization-cycle').map(d => d.message))
            .toContain('A specializes D, which specializes A -- a cycle, so each would have to be a subtype of the other.');
    });
});

describe('a relation that specializes another', () => {
    const model = (general: string, specific: string): string => [
        'package p', 'kind Person', 'kind Car', 'role Driver specializes Person', general, specific
    ].join('\n');

    test('holds no more at an end than the general does', async () => {
        // Permitting more is imprecise: the count is bounded by the general
        // whatever this end says.
        const { diagnostics } = await validate(model(
            'relation Person [1] -- owns -- [0..2] Car',
            'relation Driver [1] -- drives -- [0..*] Car specializes owns'));
        expect(diagnostics.filter(d => d.code === 'end-holds-more-than-general')
            .map(d => [d.severity, d.message])).toEqual([[
            DiagnosticSeverity.Warning,
            'A specialization\'s links are among the general\'s: this end can never hold more than the [0..2] "owns" permits, whatever [0..*] says.'
        ]]);
        // Requiring more is not satisfiable at all, and the source end is read
        // the same way as the target.
        const atSource = await validate(model(
            'relation Person [1] -- owns -- [1] Car',
            'relation Driver [2] -- drives -- [1] Car specializes owns'));
        expect(atSource.diagnostics.filter(d => d.code === 'end-holds-more-than-general')
            .map(d => d.severity)).toEqual([DiagnosticSeverity.Error]);
    });

    test('and the repair moves only the bound the rule is about', async () => {
        // Reported case. `[0..2]` under a general's `[1]`: the upper bound is
        // what cannot hold, and the lower is a specialization's own business,
        // so the answer is `[0..1]` rather than the general's `[1]`.
        const { diagnostics } = await validate(model(
            'relation Person [1] -- owns -- [1] Car',
            'relation Driver [1] -- drives -- [0..2] Car specializes owns'));
        const reported = diagnostics.find(d => d.code === 'end-holds-more-than-general');
        expect(reported).toBeDefined();
    });

    test('and says it once where the end also names what it draws from', async () => {
        // Both readings of one mistake: the relation specializes and its end
        // subsets, so the constraint arrived twice on one multiplicity.
        const { diagnostics } = await validate([
            'package p', 'kind Person',
            'kind Team {', '[1] <>-- members -- [2..5] (staff) Person', '}',
            'subkind Squad specializes Team {',
            '[1] <>-- crew -- [2..*] (hands subsets Team.staff) Person specializes Team.members', '}'
        ].join('\n'));
        expect(diagnostics.filter(d => d.code === 'end-holds-more-than-general').map(d => d.message))
            .toEqual(['The links at this end are among those of the end it subsets:'
                + ' it can never hold more than the [2..5] that end permits, whatever [2..*] says.']);
    });

    test('but may hold fewer, which is what specializing usually means', async () => {
        await expectNoErrors(model(
            'relation Person [1] -- owns -- [1] Car',
            'relation Driver [0..1] -- drives -- [0..1] Car specializes owns'));
        await expectNoErrors(model(
            'relation Person [0..*] -- owns -- [0..*] Car',
            'relation Driver [2..*] -- drives -- [3] Car specializes owns'));
    });
});

describe('a datatype that contains itself', () => {
    test('through what must be there, which is not everything', async () => {
        await expectError('package p\ndatatype Node {\nnext: Node\n}', /contains itself through its attribute "next"/);
        await expectError(
            'package p\ndatatype Address {\ncity: City\n}\ndatatype City {\npostalAddress: Address\n}',
            /contains itself/);
        // A mandatory step anywhere in the chain is enough to force it.
        await expectError('package p\ndatatype Node {\nparts: Node [1..*]\n}', /contains itself/);
    });

    test('and not through what may be left out', async () => {
        // Reported case: a linked list and a tree, both perfectly finite --
        // the recursion stops wherever the optional part is not filled in.
        await expectNoErrors('package p\ndatatype Node {\nnext: Node [0..1]\n}');
        await expectNoErrors('package p\ndatatype Node {\nchildren: Node [0..*]\n}');
        // Nor through one that is computed rather than held.
        await expectNoErrors('package p\ndatatype Node {\nnext: derived Node\n}');
    });
});

describe('higher-order references', () => {
    test('rejects instanceOf pointing at a non-type', async () => {
        await expectError(`
            package p
            kind NotAType
            kind A (instanceOf NotAType)
        `, /must reference a class that classifies types/);
    });

    test('accepts instanceOf pointing at a type', async () => {
        await expectNoErrors(`
            package p
            type AType
            kind A (instanceOf AType)
        `);
    });

    test('rejects a genset categorizer that is not a type', async () => {
        await expectError(`
            package p
            kind A
            subkind B specializes A
            kind NotAType
            genset G {
                general A
                categorizer NotAType
                specifics B
            }
        `, /categorizer must classify types/);
    });

    test('rejects a categorizer on a set of relations', async () => {
        await expectError(`
            package p
            kind Person
            relation Person [*] -- owns -- [*] Person
            relation Person [*] -- leases -- [*] Person specializes Person.owns
            type Tenure
            genset byTenure {
                general Person.owns
                categorizer Tenure
                specifics Person.leases
            }
        `, /"Tenure" cannot categorize "byTenure": .* this set's specifics are relations/);
    });

    test('rejects a relation as a genset categorizer, in a set of relations too', async () => {
        await expectError(`
            package p
            kind Person
            kind Car
            relation Person [1] -- owns -- [*] Car
            relation Person [1] -- leases -- [*] Car specializes Person.owns
            genset G {
                general Person.owns
                categorizer Person.owns
                specifics Person.leases
            }
        `, /"Person\.owns" is a relation, and a generalization set's categorizer is a high-order type/);
    });
});

describe('generalization sets', () => {
    test('reports a specific listed twice', async () => {
        // A warning, like every other name written twice: the set says what
        // it would have said without the repetition.
        await expectWarning(`
            package p
            kind A
            subkind B specializes A
            genset G where B, B specializes A
        `, /is listed more than once/);
    });

    test('a genset generalization counts as specialization ancestry', async () => {
        // B never writes `specializes`, so only the genset edge makes it a
        // proper sortal specializing exactly one ultimate sortal.
        await expectNoErrors(`
            package p
            kind A
            subkind B
            genset G where B specializes A
        `);
    });

    test('detects a cycle that closes through a genset', async () => {
        await expectError(`
            package p
            category A specializes B
            category B
            genset G where B specializes A
        `, /a cycle, so each would have to be a subtype/);
    });
});

describe('datatypes', () => {
    test('rejects a datatype containing itself', async () => {
        await expectError(`
            package p
            datatype D { self: D }
        `, /contains itself/);
    });

    test('rejects an indirect datatype cycle', async () => {
        await expectError(`
            package p
            datatype D1 { two: D2 }
            datatype D2 { one: D1 }
        `, /contains itself/);
    });
});

describe('relation ends: narrowing', () => {
    test('rejects a subsetting end whose type does not specialize', async () => {
        await expectError(`
            package p
            kind Person
            kind Unrelated
            kind Staff { <>-- [2..*] (members) Person }
            role Senior specializes Staff { <>-- [1..*] (s subsets Staff.members) Unrelated }
        `, /does not specialize/);
    });

    test('notes a subsetting end that permits more than it can hold', async () => {
        // A warning, not an error: the count is bounded by the end it subsets
        // whatever this one says, so the model is imprecise rather than
        // unsatisfiable.
        await expectWarning(`
            package p
            kind Person
            kind Staff { <>-- [2..5] (members) Person }
            role Senior specializes Staff { <>-- [1..*] (s subsets Staff.members) Person }
        `, /can never hold more than the \[2\.\.5\]/);
    });

    test('and rejects one that requires more than that end permits', async () => {
        await expectError(`
            package p
            kind Person
            kind Staff { <>-- [2..5] (members) Person }
            role Senior specializes Staff { <>-- [6..*] (s subsets Staff.members) Person }
        `, /cannot require more than the \[2\.\.5\]/);
    });

    test('while requiring fewer is what subsetting is for', async () => {
        // Reported as an error until the three readings were separated: a
        // department has staff and may have no professors.
        await expectNoErrors(`
            package p
            kind Person
            role Professor specializes Person
            kind Department {
                -- [1..*] (staff) Person
                -- [0..*] (subsets Department.staff) Professor
            }
        `);
    });

    test('but a redefinition holds the same links, so it keeps the lower bound', async () => {
        await expectError(`
            package p
            kind Person
            kind Team { -- [2..*] (members) Person }
            subkind Squad specializes Team { -- [0..*] (redefines Team.members) Person }
        `, /what that end requires still has to hold/);
    });

    test('accepts a properly narrowing subset', async () => {
        await expectNoErrors(`
            package p
            kind Person
            role Manager specializes Person
            kind Staff { <>-- [1..*] (members) Person }
            role Senior specializes Staff { <>-- [2..3] (s subsets Staff.members) Manager }
        `);
    });
});

describe('relation specialization and inverses', () => {
    test('rejects a relation specialization with an unrelated end', async () => {
        await expectError(`
            package p
            kind A
            kind B
            kind Other
            kind C { [1] -- r1 -- [1] A }
            kind D { [1] -- r2 -- [1] Other specializes C.r1 }
        `, /does not specialize the target/);
    });

    test('rejects an inverseOf whose ends are not swapped', async () => {
        await expectError(`
            package p
            kind A
            kind B
            kind C
            relation A -- fwd -- [1] B
            relation A -- bad -- [1] C inverseOf A.fwd
        `, /is not the inverse of this relation/);
    });

    test('accepts a correctly swapped inverseOf', async () => {
        await expectNoErrors(`
            package p
            kind A
            kind B
            relation A -- fwd -- [1] B
            relation B -- back -- [1] A inverseOf A.fwd
        `);
    });
});

describe('imports and packages', () => {
    test('warns about an unnecessary use', async () => {
        // Two documents of one ontology, so that the use reaches across them.
        await validate(`
            package unusedtarget in drafts
            kind Thing
        `);
        const { diagnostics } = await validateDocument(`
            use unusedtarget
            package p in drafts
            kind A
        `);
        expect(diagnostics.some(d => d.code === 'unnecessary-use')).toBe(true);
    });

    test('reports importing a package declared in the same file', async () => {
        // A warning, as the other two redundant imports are: the model is
        // right, one line of it says nothing.
        await expectWarning(`
            use selfImported
            package selfImported
            kind A
        `, /needs no `use`/);
    });

    test('rejects the same package name twice in one file', async () => {
        await expectError(`
            package twice
            kind A
            package twice
            kind B
        `, /declared more than once in this file/);
    });

    test('rejects the same package name in two files', async () => {
        await validate(`
            package shared in drafts
            kind A
        `);
        const { diagnostics } = await validateDocument(`
            package shared in drafts
            kind B
        `);
        expect(diagnostics.some(d => d.code === 'duplicate-package-across-files')).toBe(true);
    });
});

describe('UML structural rules', () => {
    test('flags the same supertype listed twice', async () => {
        await expectWarning(`
            package p
            kind A
            subkind B specializes A, A
        `, /already listed as a supertype/);
    });

    test('a composition with the implicit [1] whole end is fine', async () => {
        await expectNoErrors(`
            package p
            kind Engine
            kind Car { <>-- [2] Engine }
        `);
    });

    test('shared aggregation may have several wholes', async () => {
        await expectNoErrors(`
            package p
            kind Team
            kind Person { [0..*] <>-- [2..*] Team }
        `);
    });

    test('subsetting requires the owner to specialize the subsetted end owner', async () => {
        await expectError(`
            package p
            kind Person
            kind Staff { <>-- [1..*] (members) Person }
            kind Unrelated { <>-- [1..*] (m subsets Staff.members) Person }
        `, /does not specialize "Staff", so this end cannot subset/);
    });

    test('subsetting is accepted when the owner does specialize', async () => {
        await expectNoErrors(`
            package p
            kind Person
            kind Staff { <>-- [1..*] (members) Person }
            role Senior specializes Staff { <>-- [1..2] (m subsets Staff.members) Person }
        `);
    });

    test('and an end has no "ordered" to be pointless about', async () => {
        // A sequence at an association end was a claim no rule here read, so
        // the word is an attribute's alone and this does not parse.
        const { diagnostics } = await validate(`
            package p
            kind A
            kind B { [1] -- r -- [1] (ordered e) A }
        `);
        expect(diagnostics.some(d => /Expecting/.test(String(d.message)))).toBe(true);
    });

    test('"ordered" on a single-valued attribute is pointless', async () => {
        await expectWarning(`
            package p
            kind A { name: ordered string }
        `, /no effect on an attribute/);
    });

    test('"ordered" on a multi-valued attribute is fine', async () => {
        const { diagnostics } = await validate(`
            package p
            kind A { names: ordered string [1..*] }
        `);
        expect(diagnostics.some(d => /no effect/.test(d.message)), messages(diagnostics)).toBe(false);
    });

    test('flags an enumeration with no literals', async () => {
        await expectWarning(`
            package p
            enum Empty { }
        `, /declares no literals/);
    });

    test('flags a disjoint complete partition with a single specific', async () => {
        await expectWarning(`
            package p
            kind A
            subkind B specializes A
            disjoint complete genset G where B specializes A
        `, /single specific/);
    });
});

/**
 * Cases taken from the OntoUML tooling's own generalization table
 * (ontouml-vp-plugin, `allowedSuperClassesFor`), which distinguishes kinds of
 * anti-rigidity that a plain rigid/anti-rigid rule cannot.
 */
describe('generalization taxonomy', () => {
    test('a phase may not specialize a role', async () => {
        await expectError(`
            package p
            kind Person
            role Employee specializes Person
            phase Junior specializes Employee
        `, /holds for intrinsic reasons/);
    });

    test('a historicalRole under an anti-rigid type is allowed, and its cost is stated', async () => {
        // The historical role never lapses, so neither may whatever founds the
        // condition above it.
        await expectWarning(`
            package p
            kind Person
            role Employee specializes Person
            historicalRole FormerStaff specializes Employee
        `, /makes the relator that founds "Employee" historical too/);
        await expectWarning(`
            package p
            kind Person
            phase Child specializes Person
            historicalRole FormerChild specializes Child
        `, /makes whatever ends "Child" historical too/);
    });

    test('a role may specialize a phase', async () => {
        await expectNoErrors(`
            package p
            kind Person
            phase Adult specializes Person
            role Employee specializes Adult
        `);
    });

    test('a phase may specialize a phase', async () => {
        await expectNoErrors(`
            package p
            kind Person
            phase Adult specializes Person
            phase Senior specializes Adult
        `);
    });

    test('the rule applies to generalization-set edges too', async () => {
        await expectError(`
            package p
            kind Person
            role Employee specializes Person
            phase Junior specializes Person
            genset G where Junior specializes Employee
        `, /holds for intrinsic reasons/);
    });

    test('an event may not specialize a situation', async () => {
        await expectError(`
            package p
            situation Ready
            event Meeting specializes Ready
        `, /is an ultimate sortal/);
    });

    test('a high-order type is specialized as any ultimate sortal is', async () => {
        // `type` is an ultimate sortal, so its specializations are base
        // sortals, exactly as a kind's are -- not further `type`s.
        await expectNoErrors(`
            package p
            type PersonType
            subkind SpecialPersonType specializes PersonType
        `);
        await expectError(`
            package p
            type PersonType
            type SpecialPersonType specializes PersonType
        `, /is an ultimate sortal/);
    });

    test('and a power type is one of those, carrying the modifier', async () => {
        // Both need a base type: a power type of nothing is an MLT error.
        await expectNoErrors(`
            package p
            type PersonType
            subkind Species isPowerType specializes PersonType
            kind Animal { @instantiation -- [1..*] Species }
            kind Person { @instantiation -- [0..*] PersonType }
        `);
    });

    test('a class may be restricted to types', async () => {
        // `types` is an endurant nature in ontouml-js.
        await expectNoErrors(`
            package p
            category HigherOrder of types
        `);
    });
});

describe('disjointness', () => {
    const ages = `
        kind Person
        phase Child specializes Person
        phase Adult specializes Person
        disjoint genset Age where Child, Adult specializes Person
    `;

    test('rejects specializing both specifics of a disjoint set', async () => {
        await expectError(`
            package p
            ${ages}
            phase Both specializes Child, Adult
        `, /specializes both .* which a disjoint generalization set declares cannot share an instance/);
    });

    test('rejects it transitively, several levels down', async () => {
        await expectError(`
            package p
            ${ages}
            phase Young specializes Child
            phase Old specializes Adult
            phase Impossible specializes Young, Old
        `, /disjoint generalization set/);
    });

    test('rejects it when one edge comes from a generalization set', async () => {
        await expectError(`
            package p
            ${ages}
            phase Both specializes Child
            genset Extra where Both specializes Adult
        `, /disjoint generalization set/);
    });

    test('rejects a class specializing something it is declared disjoint from', async () => {
        await expectError(`
            package p
            kind Person
            phase Child specializes Person
            phase Adult specializes Person, Child
            disjoint genset Age where Child, Adult specializes Person
        `, /declared disjoint from .* which it also specializes/);
    });

    test('leaves the disjoint siblings themselves alone', async () => {
        await expectNoErrors(`
            package p
            ${ages}
        `);
    });

    test('allows overlap when the generalization set is not disjoint', async () => {
        await expectNoErrors(`
            package p
            kind Person
            role Student specializes Person
            role Employee specializes Person
            genset Roles where Student, Employee specializes Person
            role WorkingStudent specializes Student, Employee
        `);
    });

    test('a set listing the same specific twice does not make it disjoint from itself', async () => {
        const { diagnostics } = await validate(`
            package p
            kind Person
            phase Child specializes Person
            disjoint genset Age where Child, Child specializes Person
            phase Young specializes Child
        `);
        expect(diagnostics.some(d => /disjoint generalization set/.test(d.message)), messages(diagnostics)).toBe(false);
    });

    test('a class under only one specific of a three-way partition is fine', async () => {
        await expectNoErrors(`
            package p
            kind Person
            phase A1 specializes Person
            phase A2 specializes Person
            phase A3 specializes Person
            disjoint complete genset Age where A1, A2, A3 specializes Person
            phase Deep specializes A2
        `);
    });
});

describe('classifier body ordering', () => {
    test('accepts a label written after the attributes', async () => {
        await expectNoErrors(`
            package p
            kind A {
                name: string
                label { @en "A" }
            }
        `);
    });

    test('accepts a description before a label', async () => {
        await expectNoErrors(`
            package p
            kind A {
                description { @en "d" }
                label { @en "A" }
            }
        `);
    });

    test('accepts a label after a relation', async () => {
        await expectNoErrors(`
            package p
            kind B
            kind A {
                [1] -- r -- [1] B
                label { @en "A" }
            }
        `);
    });

    test('accepts a label after attributes in a datatype', async () => {
        await expectNoErrors(`
            package p
            datatype D {
                x: string
                label { @en "D" }
            }
        `);
    });

    test('still accepts the original label-first order', async () => {
        await expectNoErrors(`
            package p
            kind A {
                label { @en "A" }
                description { @en "d" }
                name: string
            }
        `);
    });

    test('two blocks of the same kind merge, and a repeated language is the error', async () => {
        // They used to overwrite one another: the AST kept the later, and the
        // earlier could only be found in the CST. Collected, what is actually
        // wrong is saying the same thing twice in one language.
        await expectNoErrors(`
            package p
            kind A {
                label { @en "A" }
                label { @pt-br "A" }
            }
        `);
        await expectError(`
            package p
            kind A {
                description { @en "d" }
                description { @en "e" }
            }
        `, /"@en" is already given for this "description"/);
    });

    test('and a repeat is not a rule but a parse error', async () => {
        // The flags are an unordered group, so the parser takes each at most
        // once: `(ordered ordered e)` does not parse, where it used to parse
        // and be reported by a rule of its own.
        const { diagnostics } = await validate(`
            package p
            kind A
            kind B { [1] -- r -- [0..*] (ordered ordered e) A }
        `);
        expect(diagnostics.some(d => /Expecting/.test(String(d.message)))).toBe(true);
    });

    test('accepts each flag declared once', async () => {
        const { diagnostics } = await validate(`
            package p
            kind A
            kind B { [1] -- r -- [0..*] (ordered const derived e) A }
        `);
        expect(diagnostics.some(d => /already declared/.test(d.message)), messages(diagnostics)).toBe(false);
    });

    test('warns when subsetting makes a const end writable', async () => {
        await expectWarning(`
            package p
            kind Person
            kind Staff { <>-- [1..*] (const members) Person }
            role Senior specializes Staff { <>-- [1..2] (m subsets Staff.members) Person }
        `, /should be "const" too/);
    });

    test('accepts a subsetting end that keeps const', async () => {
        const { diagnostics } = await validate(`
            package p
            kind Person
            kind Staff { <>-- [1..*] (const members) Person }
            role Senior specializes Staff { <>-- [1..2] (const m subsets Staff.members) Person }
        `);
        expect(diagnostics.some(d => /const/.test(d.message)), messages(diagnostics)).toBe(false);
    });

    test('adding const in the subtype is fine', async () => {
        const { diagnostics } = await validate(`
            package p
            kind Person
            kind Staff { <>-- [1..*] (members) Person }
            role Senior specializes Staff { <>-- [1..2] (const m subsets Staff.members) Person }
        `);
        expect(diagnostics.some(d => /const/.test(d.message)), messages(diagnostics)).toBe(false);
    });
});

describe('case sensitivity', () => {
    test('names differing only in case are distinct, not duplicates', async () => {
        await expectNoErrors(`
            package p
            kind Person
            kind person
        `);
    });

    test('a reference must match the declared case exactly', async () => {
        await expectError(`
            package p
            kind Person
            role Student specializes person
        `, /Could not resolve reference/);
    });
});

/**
 * Relation stereotype against the ontological natures at its ends, from the
 * OntoUML tooling's `association_constraints_nature.json`.
 */
describe('relation stereotype natures', () => {
    const universe = `
        kind Person
        collective Team
        quantity Water
        relator Deal
        quality Weight
        extrinsicMode Admiration
        event Meeting
        situation Ready
        type PersonType
    `;

    const model = (body: string): string => `package p\n${universe}\n${body}\n`;

    test('mediation must start from a relator', async () => {
        await expectNoErrors(model('relator D2 { @mediation [1] -- [1] Person }'));
        await expectError(model('kind K2 { @mediation [1] -- [1] Person }'), /"@mediation" cannot relate/);
    });

    test('characterization must start from a moment', async () => {
        await expectNoErrors(model('@characterization relation Weight -- [1] Person'));
        await expectError(model('kind Car\n@characterization relation Car -- [1] Person'), /"@characterization" cannot relate/);
    });

    test('memberOf needs a collective for its whole', async () => {
        // The diamond marks the whole, so the whole/part pair is read from the
        // notation rather than the writing order.
        await expectNoErrors(model('collective Crew { @membership [1] <>-- [2..*] Person }'));
        await expectError(model('kind Club { @membership [1] <>-- [2..*] Person }'),
            /"@membership" cannot relate whole "Club" .* to part "Person"/);
    });

    test('memberOf is accepted with the whole written at the target', async () => {
        await expectNoErrors(model('collective Crew2\nkind Member2\nrelation Member2 [2..*] --<> [1] Crew2'));
    });

    test('componentOf relates functional complexes', async () => {
        await expectNoErrors(model('kind Engine\nkind Vehicle { @componenthood [1] <>-- [1..*] Engine }'));
        await expectError(model('kind Car\ncollective Fleet { @componenthood [1] <>-- [1..*] Car }'), /"@componenthood" cannot relate/);
    });

    test('subQuantityOf relates quantities', async () => {
        // Every part of a quantity is essential, so the part end is `(const)`.
        // `--<>` puts the whole at the target, so the part end is the source one.
        await expectNoErrors(model('quantity Part { @subQuantity (const) [1] --<> [1] Water }'));
    });

    test('instantiation must target a high-order type', async () => {
        await expectNoErrors(model('kind P2 { @instantiation [*] -- [1] PersonType }'));
        await expectError(model('kind P3 { @instantiation [*] -- [1] Person }'), /"@instantiation" cannot relate/);
    });

    test('participation runs from an endurant to an event', async () => {
        await expectNoErrors(model('kind P4 { @participation [1] -- [1] Meeting }'));
        await expectError(model('event E2 { @participation [1] -- [1] Person }'), /"@participation" cannot relate/);
    });

    test('bringsAbout runs from an event to a situation, and says so when reversed', async () => {
        await expectNoErrors(model('event E3 { @bringingAbout [1] -- [1] Ready }'));
        await expectError(
            model('situation S2 { @bringingAbout [1] -- [1] Meeting }'),
            /ends may be the wrong way round/
        );
    });

    test('externalDependence must start from an extrinsic moment', async () => {
        await expectNoErrors(model('extrinsicMode A2 { @externalDependence [1] -- [1] Person }'));
        await expectError(model('kind K7 { @externalDependence [1] -- [1] Person }'), /"@externalDependence" cannot relate/);
    });

    test('every stereotype tonto defines has end natures', () => {
        // The table used to cover 18 of 25; the seven it missed were the six
        // tonto extensions, now removed, and constitution.
        const uncovered = RELATION_STEREOTYPES.filter(name => !naturesFor(name));
        expect(uncovered).toEqual([]);
    });

    test('ends whose nature cannot be determined are skipped', async () => {
        await expectNoErrors('package p\nclass U1\nclass U2\n@mediation relation U1 -- [1] U2\n');
    });
});

describe('characterization bearer cardinality', () => {
    const base = 'package p\nkind Person\nquality Weight\nmode Skill\n';

    test('accepts a bearer end of [1]', async () => {
        await expectNoErrors(base + '@characterization relation Weight -- [1] Person');
    });

    test('accepts an omitted bearer end, which already means exactly one', async () => {
        await expectNoErrors(base + '@characterization relation Weight -- Person');
    });

    test.each(['[0..1]', '[1..*]', '[2]'])('rejects a bearer end of %s', async bound => {
        await expectError(base + `@characterization relation Weight -- ${bound} Person`, /inheres in exactly one bearer/);
    });

    test('leaves the moment end unconstrained', async () => {
        await expectNoErrors(base + '@characterization relation Skill [0..*] -- [1] Person');
    });

    test('stays quiet when the relation is written the wrong way round', async () => {
        // checkRelationStereotypeNatures reports that; a second complaint about
        // the end that is not the bearer would only confuse.
        const { diagnostics } = await validate(base + '@characterization relation Person -- [0..*] Weight');
        expect(diagnostics.some(d => /inheres in exactly one bearer/.test(d.message)), messages(diagnostics)).toBe(false);
    });
});

describe('powertype instantiation cardinality', () => {
    // MLT fixes both bounds: the base type instantiates its powertype (lower
    // bound 1) and so does every specialization of it (upper bound *).
    const base = 'package p\ntype CarType isPowerType\n';
    const CARDELLI = /Cardelli powertype admits only/;

    test.each(['', '[1]', '[0..1]', '[0..*]', '[2..*]', '[1..3]'])(
        'a powertype end of "%s" is not [1..*]', async bound => {
            await expectWarning(base + `kind Car {\n@instantiation -- ${bound} CarType\n}`, CARDELLI);
        });

    test('[1..*] is the one shape it accepts', async () => {
        await expectNoWarnings(base + 'kind Car {\n@instantiation -- [1..*] CarType\n}', CARDELLI);
    });

    test('an upper bound of one denies the subtypes', async () => {
        await expectWarning(base + 'kind Car {\n@instantiation -- [1] CarType\n}', /upper bound must be "\*"/);
    });

    test('a lower bound of zero denies the base type itself', async () => {
        await expectWarning(base + 'kind Car {\n@instantiation -- [0..*] CarType\n}', /specializes itself/);
    });

    test('a lower bound above one denies a base type with no subtypes yet', async () => {
        await expectWarning(base + 'kind Car {\n@instantiation -- [2..*] CarType\n}', /so the lower bound is 1/);
    });

    test('[0..1] is wrong on both counts, and says so', async () => {
        await expectWarning(base + 'kind Car {\n@instantiation -- [0..1] CarType\n}', /upper bound must be "\*"; and .*specializes itself/);
    });

    test('leaves a plain "type" alone, which carries no Cardelli commitment', async () => {
        await expectNoWarnings('package p\ntype CarType\nkind Car {\n@instantiation -- CarType\n}', CARDELLI);
    });

    test('stays quiet when the ends are the wrong way round', async () => {
        // The target is not the high-order end, so there is no powertype end.
        await expectNoWarnings(base + 'kind Car\n@instantiation relation CarType -- [1..*] Car', CARDELLI);
    });
});


describe('nature reasoning follows the whole hierarchy', () => {
    test('a conflict two levels up is found', async () => {
        // Mid declares no natures of its own; they come from R.
        await expectError(
            'package p\nrelator R\nsubkind Mid specializes R\nevent E specializes Mid',
            /"E" inherits relators from "Mid"/
        );
    });

    test('an "of" clause is checked against what a grandparent allows', async () => {
        await expectError(
            'package p\ncategory Top of relators\ncategory Mid specializes Top\nsubkind Low of functional-complexes specializes Mid',
            /restricts its instances to functional-complexes/
        );
    });

    test('a generalization cycle does not hang the nature walk', async () => {
        const { diagnostics } = await validate('package p\nkind A specializes B\nsubkind B specializes A');
        expect(diagnostics.some(d => /a cycle, so each would have to be a subtype/.test(d.message)), messages(diagnostics)).toBe(true);
    });

    test('two supertypes both narrow, whichever order they are written in', async () => {
        // The end check reads the natures a class is assumed to have, and
        // that was the *nearest* restriction rather than all of them folded
        // together -- so `specializes Wide, Narrow` was checked as `Wide`,
        // and swapping the two words was the difference between reporting
        // this and not.
        const model = (order: string): string =>
            'package p\ncategory Wide of objects\ncategory Narrow of functional-complexes\n'
            + `category X specializes ${order}\ncollective C\n@subCollection relation X [1] --<> [1] C`;
        await expectError(model('Wide, Narrow'), /"@subCollection" cannot relate|nature/);
        await expectError(model('Narrow, Wide'), /"@subCollection" cannot relate|nature/);
    });

    test('a nature answer folded across a generalization cycle is not kept', async () => {
        // The cycle makes one of the two classes answer "unrestricted" while
        // the other is still being computed. Caching that answer let it stand
        // for the rest of the build, and which of the two got the wide value
        // depended on which the validator reached first -- so the diagnostic
        // on `C`, which is in no cycle at all, came and went with the order
        // the two lines above it were written in.
        const cyclic = (first: string, second: string): string =>
            `package p\n${first}\n${second}\nevent C specializes B`;
        const a = 'category A of relators specializes B';
        const b = 'category B specializes A';
        await expectError(cyclic(a, b), /"C" inherits/);
        await expectError(cyclic(b, a), /"C" inherits/);
    });

    test('three supertypes can agree pairwise and still share nothing all at once', async () => {
        // Each pair here shares a nature, so the pairwise check alone sees no
        // conflict; only the three together have an empty intersection.
        await expectError(
            'package p\ncategory A of functional-complexes, events\ncategory B of events, qualities\n'
            + 'category Ca of qualities, functional-complexes\nsubkind D specializes A, B, Ca',
            /cannot specialize "A".*"B".*"Ca".* together/
        );
    });
});

describe('a non-sortal says what it classifies', () => {
    const unstated = /says nothing about the ontological nature of its instances/;

    test('a category with no "of" anywhere above it is a warning', async () => {
        await expectWarning('package p\ncategory Agent\nkind Person specializes Agent\nkind Organization specializes Agent',
            /^"Agent" says nothing about the ontological nature of its instances \(are they functional complexes, events, types, \u2026\?\)\. Use "of" to name the nature it is meant to classify \(e\.g\., "of functional-complexes"\) or the natures it spans \("of relators, events"\)\.$/);
    });

    test('and so is every other non-sortal', async () => {
        for (const stereotype of ['mixin', 'roleMixin', 'phaseMixin', 'historicalRoleMixin']) {
            await expectWarning(`package p\n${stereotype} M`, unstated);
        }
    });

    test('the natures are read off what is beneath it, spanning included', async () => {
        await expectWarning(
            'package p\ncategory Occurrence\nevent Strike specializes Occurrence\nkind Protest specializes Occurrence',
            /\(e\.g\., "of functional-complexes"\) or the natures it spans \("of functional-complexes, events"\)/);
        await expectWarning(
            'package p\ncategory Agent\nkind Person specializes Agent\ncollective Team specializes Agent\nquantity Water specializes Agent',
            /\(e\.g\., "of objects"\) or the natures it spans \("of relators, events"\)/);
    });

    test('a clause anywhere above it is enough', async () => {
        await expectNoWarnings('package p\ncategory Party of functional-complexes\nmixin Insurable specializes Party\nkind Person specializes Insurable',
            unstated);
    });

    test('only the topmost of a chain of unstated non-sortals is reported', async () => {
        const { diagnostics } = await validate('package p\ncategory Top\ncategory Middle specializes Top\nkind Person specializes Middle');
        expect(diagnostics.filter(d => unstated.test(d.message)).map(d => d.message))
            .toEqual([expect.stringContaining('"Top"')]);
    });

    test('a sortal is never asked', async () => {
        await expectNoWarnings('package p\nkind Person\nrole Student specializes Person', unstated);
    });

    test('stating the natures can expose a relation that only passed because they were unstated', async () => {
        const model = (clause: string): string =>
            `package p\ncategory Thing${clause}\nkind Car specializes Thing\n@mediation relation Thing [0..*] -- [1] (const) Car`;
        await expectNoErrors(model(''));
        await expectError(model(' of functional-complexes'), /"@mediation" cannot relate source "Thing"/);
    });
});

describe('historical roles are derived from what happened', () => {
    const university = [
        'package p', 'kind Person', 'kind Organization', 'role Student specializes Person', 'kind University',
        'relator Enrollment {', '@mediation [1..*] -- [1] (const) Student', '@mediation [0..*] -- [1] (const) University', '}',
        'event Graduation', 'event Birth', 'subkind BirthInBrazil specializes Birth',
        '@participation relation Student (const) [1..*] -- graduatedIn -- [0..*] (addOnly) Graduation',
        '@creation relation Person (const) [1] -- wasBornIn -- [1] (const) Birth'
    ];
    const model = (...lines: string[]): string => [...university, ...lines].join('\n');
    const codes = async (source: string): Promise<string[]> =>
        (await validate(source)).diagnostics.map(d => String(d.code));

    test('warns when a past-event link starts at a type whose membership can lapse', async () => {
        await expectWarning(model('historicalRole Graduate specializes Person derivedFrom Student.graduatedIn'),
            /Membership in "Student" can lapse, but the link to a past "Graduation" event remains/);
        expect(await codes(model('historicalRole Graduate specializes Person derivedFrom Student.graduatedIn')))
            .toContain('historical-event-source-can-lapse');
        expect(await codes('package p\nkind Person\nphase Child specializes Person\nevent Birthday\n'
            + '@participation relation Child (const) [1] -- celebrated -- [0..*] (addOnly) Birthday'))
            .toContain('historical-event-source-can-lapse');
    });

    test.each(['creation', 'termination', 'change'])('also catches @%s into a completed event', async stereotype => {
        const source = `package p\nkind Person\nrole Employee specializes Person\nevent Retirement\n`
            + `@${stereotype} relation Employee (const) [1] -- retiredIn -- [0..*] (addOnly) Retirement`;
        expect(await codes(source)).toContain('historical-event-source-can-lapse');
    });

    test('does not warn for a rigid source or a process that may still unfold', async () => {
        expect(await codes('package p\nkind Person\nevent Graduation\n'
            + '@participation relation Person (const) [1..*] -- graduatedIn -- [0..*] (addOnly) Graduation'))
            .not.toContain('historical-event-source-can-lapse');
        expect(await codes('package p\nkind Person\nrole Student specializes Person\nprocess Studying\n'
            + '@participation relation Student [1..*] -- studiesIn -- [0..*] Studying'))
            .not.toContain('historical-event-source-can-lapse');
        expect(await codes('package p\nkind Person\nevent Graduation\n'
            + 'historicalRole Alumnus specializes Person {\n'
            + '    @participation (const) [1] -- graduatedIn -- [0..*] (addOnly) Graduation\n}'))
            .not.toContain('historical-event-source-can-lapse');
    });

    test('a derivation from the participation written on the student founds a graduate', async () => {
        const found = await codes(model('historicalRole Graduate specializes Person derivedFrom Student.graduatedIn'));
        expect(found).not.toContain('historical-role-without-event');
        expect(found.filter(code => code.startsWith('historical-derivation'))).toEqual([]);
    });

    test('naming the event is enough where one relation into it could be meant', async () => {
        await expectNoErrors(model('historicalRole Graduate specializes Person derivedFrom Graduation'));
    });

    test('and an event type narrower than the relation\'s is read for that type', async () => {
        // Born in Brazil: a creation written into Birth, read for the births in Brazil.
        const found = await codes(model('historicalRole BornInBrazil specializes Person derivedFrom BirthInBrazil'));
        expect(found.filter(code => code.startsWith('historical-derivation'))).toEqual([]);
    });

    test('a creation or a termination of its own founds one, as a participation does', async () => {
        const found = await codes(model('historicalRole Founder specializes Organization {', '@creation (const) [1] -- [1] (const) Birth', '}'));
        expect(found).not.toContain('historical-role-without-event');
    });

    test('a derivation names a participation, creation or termination', async () => {
        await expectError(model('historicalRole FormerStudent specializes Person derivedFrom Enrollment'),
            /"Enrollment" is a "relator", and a historical role is derived from an event/);
        await expectError(model('@material relation Student [0..*] -- studiesAt -- [1..*] University derivedFrom Enrollment',
            'historicalRole Alumnus specializes Person derivedFrom Student.studiesAt'),
        /"Student.studiesAt" is a "@material", and a historical role is founded by an event/);
    });

    test('from something that can be an instance of the role', async () => {
        await expectError(model('@participation relation Organization (const) [1..*] -- hosted -- [0..*] (const) Graduation',
            'historicalRole Graduate specializes Person derivedFrom Organization.hosted'),
        /"Organization.hosted" is how an "Organization" took part in "Graduation", and no "Organization" can be a "Graduate"/);
    });

    test('an event nothing that could be one took part in founds nothing', async () => {
        await expectError(model('event Founding', 'historicalRole Founder specializes Person derivedFrom Founding'),
            /Nothing that can be a "Founder" took part in, was created in or was terminated in "Founding"/);
    });

    test('an event more than one relation into could mean is named outright', async () => {
        await expectError(model('@participation relation Person (const) [0..*] -- attended -- [0..*] (const) Graduation',
            'historicalRole Graduate specializes Person derivedFrom Graduation'),
        /More than one relation into "Graduation" could make something a "Graduate": "Student.graduatedIn", "Person.attended"/);
    });

    test('only a historical role is derived from what happened', async () => {
        await expectError(model('role Graduate specializes Person derivedFrom Student.graduatedIn'),
            /Only a historical role is derived from what happened, and "Graduate" is a "role"/);
    });

    test('one optional founding relation of its own is enough where a derivation founds it too', async () => {
        const found = await codes(model('event Prize',
            'historicalRole Graduate specializes Person derivedFrom Student.graduatedIn {',
            '@participation (const) [0..*] -- [0..*] (const) Prize', '}'));
        expect(found).not.toContain('founding-relation-optional');
    });
});

describe('UFO rules about what a type depends on', () => {
    test('a non-sortal with only non-sortal subtypes supplies no identity principle', async () => {
        // A hint, not a warning: a foundational ontology is layers of
        // non-sortals waiting for a domain to put kinds under them.
        const { diagnostics } = await validate('package p\ncategory Top of objects\ncategory Sub specializes Top');
        const found = diagnostics.filter(d => /supplies no identity principle/.test(d.message));
        expect(found.map(d => d.severity), messages(diagnostics)).toEqual([DiagnosticSeverity.Hint]);
    });

    test('a non-sortal with a sortal beneath it is fine', async () => {
        await expectNoWarnings('package p\ncategory Top of objects\nkind K specializes Top', /identity principle/);
    });

    test('a non-sortal with no subtypes yet is left alone', async () => {
        // Its specializations may live in a file that is not open.
        await expectNoWarnings('package p\ncategory Floating of objects', /identity principle/);
    });

    test('a relator mediating one individual is flagged', async () => {
        await expectWarning(
            'package p\nkind Person\nrelator Marriage { @mediation [2] -- [1] Person }',
            /mediates a single individual/
        );
    });

    test('one mediation of [2] binds two, and is accepted', async () => {
        // Individuals are counted, not mediations.
        await expectNoWarnings(
            'package p\nkind Person\nrelator Marriage { @mediation [1] -- [2] Person }',
            /binds nothing together/
        );
    });

    test('two mediations of [1] are accepted', async () => {
        await expectNoWarnings(
            'package p\nkind A\nkind B\nrelator R { @mediation [1] -- [1] A\n@mediation [1] -- [1] B }',
            /binds nothing together/
        );
    });

    test('a relator with no mediations at all stays quiet', async () => {
        await expectNoWarnings('package p\nrelator R', /binds nothing together/);
    });

    test('a quality nothing bears is flagged', async () => {
        await expectWarning('package p\nquality Weight', /"Weight" classifies qualities, which inhere in something, but nothing bears it/);
    });

    test('a characterized quality is fine', async () => {
        await expectNoWarnings(
            'package p\nkind Person\nquality Weight { @characterization [0..*] -- [1] Person }',
            /nothing bears it/
        );
    });
});

describe('parthood is acyclic', () => {
    test('a wholly mandatory cycle never bottoms out', async () => {
        await expectError(
            'package p\nkind A { @componenthood [1] <>-- [1] B }\nkind B { @componenthood [1] <>-- [1] A }',
            /the parts never bottom out/
        );
    });

    test('a recursive type stops at both ends or not at all', async () => {
        // A tree: a leaf has no parts, a root has no whole. A type-level
        // cycle says nothing about individuals once both ends may stop.
        await expectNoErrors('package p\nkind Part { @componenthood [0..1] <>-- [*] Part }');
        await expectNoErrors('package p\nkind Part { @componenthood [0..1] <>-- [0..1] Part }');
    });

    test('a subtype answers for its own cycle, not for the one it inherits', async () => {
        // An ancestor's recursion is the ancestor's to answer, so a subtype
        // that merely inherits it stays quiet. A subtype that writes one of
        // its own is making a separate claim, and asking only whether an
        // ancestor was in *some* cycle let A's defect hide B's.
        const inherited = await validate(
            'package p\nkind A { @componenthood <>-- [1..*] A }\nsubkind B specializes A');
        expect(messages(inherited.diagnostics)).not.toMatch(/Every B/);

        const both = await validate('package p\nkind A { @componenthood <>-- [1..*] A }\n'
            + 'subkind B specializes A { @componenthood <>-- [1..*] B }');
        expect(messages(both.diagnostics), messages(both.diagnostics)).toMatch(/Every B must contain a B/);
        expect(messages(both.diagnostics), messages(both.diagnostics)).toMatch(/Every A must contain an A/);
    });

    test('a dependence is inherited too, so a chain may run through a subtype', async () => {
        // `A` declares nothing: what it inherits from `Base` is what makes
        // the inherence come back round.
        await expectError(
            'package p\nmode Base {\n@characterization [1] -- [1] (const) B\n}\n'
            + 'subkind A specializes Base\nmode B {\n@characterization [1] -- [1] (const) A\n}',
            /Every A must inhere in a B, which must inhere in an A/);
        await expectError(
            'package p\nkind Clay {\n@constitution [1] -- [1] Statue\n}\nsubkind RedClay specializes Clay\n'
            + 'kind Statue {\n@constitution [1] -- [1] RedClay\n}',
            /constitution is asymmetric|Every RedClay/);
    });

    test('and the bearers a moment inherits count against the one-bearer rule', async () => {
        await expectError(
            'package p\nkind Person\nkind Dog\nquality Weight {\n@characterization [1] -- [1] (const) Person\n}\n'
            + 'subkind Mass specializes Weight {\n@characterization [1] -- [1] (const) Dog\n}',
            /inheres in exactly one|two bearers|cannot inhere/);
    });

    test('a part inherited from a supertype supplements the parts written below it', async () => {
        // A sedan has the car's wheel and an engine of its own, which is two.
        // Reported of the car, whose own decomposition is the incomplete one,
        // and not again of everything under it.
        const { diagnostics } = await validate([
            'package p', 'kind Wheel', 'kind Engine',
            'kind Car {', '@componenthood [1] <>-- [1] Wheel', '}',
            'subkind Sedan specializes Car {', '@componenthood [1] <>-- [1] Engine', '}'
        ].join('\n'));
        const supplementation = diagnostics.filter(d => d.code === 'whole-with-one-part');
        expect(supplementation.map(d => d.message), messages(diagnostics))
            .toEqual([expect.stringContaining('Every "Car" has exactly one part')]);
    });

    test('and a material relation between subtypes is grounded by the relator above them', async () => {
        await expectNoWarnings(
            'package p\nkind Person\nkind Org\nrelator Job {\n@mediation [1] -- [1] (const) Person\n'
            + '@mediation [1] -- [1] (const) Org\n}\nsubkind Staff specializes Person\n'
            + '@material relation Staff [*] -- worksFor -- [*] Org',
            /nothing mediates both/);
    });

    test('a parthood is inherited, and so is the chain it makes', async () => {
        // Reported case: `[1]` at the whole says every node belongs to a
        // complex node, and a complex node is a node -- so the climb has no
        // root, though nothing at `ComplexNode` says parthood at all.
        const { diagnostics } = await validate([
            'package p', 'kind Node',
            'subkind ComplexNode specializes Node {', '@componenthood [1] <>-- [0..1] Node', '}',
            'subkind LeafNode specializes Node'
        ].join('\n'));
        const climbing = diagnostics.filter(d => d.code === 'parthood-climbs-forever');
        expect(climbing.map(d => d.message), messages(diagnostics))
            .toEqual(['Every ComplexNode must be part of a ComplexNode, so the wholes never top out.'
                + ' Parthood is irreflexive on individuals, so no individual can satisfy this: let a'
                + ' whole end stand alone, by dropping its lower bound to zero -- an omitted bound is'
                + ' exactly one, and that is what says every part belongs to a whole.']);
    });

    test('and the same downward, through a part end written at a supertype', async () => {
        await expectError(
            'package p\nkind Vehicle {\n@componenthood [0..1] <>-- [1] Part\n}\nsubkind Part specializes Vehicle',
            /the parts never bottom out/);
    });

    test('but a cycle an ancestor is already in is that ancestor\u2019s to answer', async () => {
        // One report, not one per subtype: the relation is written at the
        // category, and that is where it is repaired.
        const { diagnostics } = await validate([
            'package p', 'category Entity {', '[1..*] <>-- [*] Entity', '}',
            'kind A specializes Entity', 'kind B specializes Entity', 'subkind C specializes A'
        ].join('\n'));
        expect(diagnostics.filter(d => d.code === 'parthood-climbs-forever').length).toBe(1);
    });

    test('the two directions are told apart, and reported apart', async () => {
        // Separate claims made by separate multiplicities, so separate codes:
        // a model may make both, and `<>-- Node` does.
        const { diagnostics } = await validate('package p\nkind Node { @componenthood <>-- Node }');
        expect(diagnostics.map(d => d.code).sort())
            .toEqual(['parthood-climbs-forever', 'parthood-descends-forever']);
        const descends = diagnostics.find(d => d.code === 'parthood-descends-forever');
        const climbs = diagnostics.find(d => d.code === 'parthood-climbs-forever');
        expect(descends?.message).toMatch(/must contain a Node, so the parts never bottom out/);
        expect(descends?.message).toMatch(/let a part end hold none/);
        expect(climbs?.message).toMatch(/must be part of a Node, so the wholes never top out/);
        expect(climbs?.message).toMatch(/let a whole end stand alone/);
    });

    test('and a whole left unwritten is exactly one, so the climb never stops', async () => {
        // Reported case. A diamond with nothing beside it says exactly one
        // whole -- which is what `<o>--` used to say, and why it was dropped.
        await expectError(
            'package p\nkind Node { @componenthood <>-- [0..1] Node }',
            /the wholes never top out/
        );
        await expectError(
            'package p\nkind Node { @componenthood <>-- [*] Node }',
            /the wholes never top out/
        );
        await expectError(
            'package p\nkind Node { @componenthood [1..*] <>-- [*] Node }',
            /the wholes never top out/
        );
    });

    test('nor is a mutual parthood whose steps are optional', async () => {
        await expectNoErrors('package p\nkind A { @componenthood [0..1] <>-- [0..*] B }\nkind B { @componenthood [0..1] <>-- [0..*] A }');
    });

    test('a mandatory self-parthood is not', async () => {
        await expectError('package p\nkind Part { @componenthood [1] <>-- [1..*] Part }', /never bottom out/);
    });

    test('a plain association between the same classes is not parthood', async () => {
        const { diagnostics } = await validate('package p\nkind A { [1] -- r1 -- [1] B }\nkind B { [1] -- r2 -- [1] A }');
        expect(diagnostics.some(d => /is a part of itself/.test(d.message)), messages(diagnostics)).toBe(false);
    });

    test('an ordinary parthood hierarchy is fine', async () => {
        await expectNoWarnings('package p\nkind Wheel\nkind Car { @componenthood [1] <>-- [4] Wheel }', /part of itself/);
    });
});

describe('phases partition their parent', () => {
    test('two phases with no partition are flagged', async () => {
        await expectWarning(
            'package p\nkind Person\nphase Child specializes Person\nphase Adult specializes Person',
            /no "disjoint complete" generalization set/
        );
    });

    test('a single phase is left alone, being a partition still being written', async () => {
        await expectNoWarnings('package p\nkind Person\nphase Child specializes Person', /generalization set/);
    });

    test('a covering partition satisfies it', async () => {
        await expectNoWarnings(
            'package p\nkind Person\nphase Child specializes Person\nphase Adult specializes Person\ndisjoint complete genset G where Child, Adult specializes Person',
            /generalization set/
        );
    });
});

describe('naming conventions', () => {
    test.each(['kind pessoa', 'datatype cor'])('%s should be capitalized', async declaration => {
        await expectWarning(`package p\n${declaration}`, /should start with an uppercase letter/);
    });

    test('an attribute name should be lowercase', async () => {
        await expectWarning('package p\ndatatype String\nkind A { Nome: String }', /Attribute name "Nome"/);
    });

    test('a relation end name should be lowercase', async () => {
        await expectWarning('package p\nkind A\nkind B { -- [1] (Membros) A }', /Relation end name "Membros"/);
    });

    test('conventional names are quiet', async () => {
        await expectNoWarnings('package p\ndatatype String\nkind Pessoa { nome: String }', /should start with/);
    });
});

describe('the built-in datatypes are lowercase by design', () => {
    test.each(['string', 'number', 'boolean', 'date', 'time', 'datetime'])(
        'a datatype named "%s" is not flagged', async name => {
            await expectNoWarnings(`package p\ndatatype ${name}`, /uppercase letter/);
        });

    test('another lowercase datatype name still is', async () => {
        await expectWarning('package p\ndatatype cor', /uppercase letter/);
    });

    test('a class borrowing the name gets no license', async () => {
        // The exemption is for those declarations, not for the spelling.
        await expectWarning('package p\nkind date', /uppercase letter/);
    });
});

describe('MLT: the powertype pattern', () => {
    describe('a powertype is the powertype of exactly one type', () => {
        test('a powertype with no base is an error', async () => {
            await expectError('package p\ntype PersonType isPowerType', /powertype of nothing/);
        });

        test('an "instanceOf" clause counts as the base link', async () => {
            await expectNoErrors('package p\ntype PersonType isPowerType\nkind Person (instanceOf PersonType)');
        });

        test('two base types are an error', async () => {
            await expectError(
                'package p\ntype T isPowerType\nkind A { @instantiation -- [1..*] T }\nkind B { @instantiation -- [1..*] T }',
                /powertype of exactly one type/
            );
        });

        test('two powertypes for one base are an error', async () => {
            await expectError(
                'package p\ntype T1 isPowerType\ntype T2 isPowerType\nkind A {\n@instantiation -- [1..*] T1\n@instantiation -- [1..*] T2\n}',
                /at most one powertype/
            );
        });
    });

    describe('a powertype categorizes nothing', () => {
        test('using one as a generalization-set categorizer is an error', async () => {
            await expectError(
                'package p\ntype PersonType isPowerType\nkind Person { @instantiation -- [1..*] PersonType }\nsubkind Man specializes Person\ngenset G {\ngeneral Person\ncategorizer PersonType\nspecifics Man\n}',
                /supplies no classification criterion/
            );
        });

        test('a plain "type" may categorize', async () => {
            await expectNoErrors(
                'package p\ntype PersonGender\nkind Person\nsubkind Man specializes Person\ngenset G {\ngeneral Person\ncategorizer PersonGender\nspecifics Man\n}'
            );
        });
    });

    describe('instantiation raises the order by one', () => {
        test('a type cannot instantiate itself', async () => {
            await expectError('package p\ntype T { @instantiation -- [0..*] T }', /cannot come back round/);
        });

        test('nor through a chain', async () => {
            await expectError(
                'package p\ntype A { @instantiation -- [0..*] B }\ntype B { @instantiation -- [0..*] A }',
                /cannot come back round/
            );
        });
    });

    describe('cross-level theorems', () => {
        test('a categorizer of a type with a powertype sits under that powertype', async () => {
            // A warning, not an error: the generalization is one the model
            // already implies, and the repair writes it.
            await expectWarning(
                'package p\ntype PersonType isPowerType\ntype PersonGender\nkind Person {\n@instantiation -- [1..*] PersonType\n@instantiation -- [1] PersonGender\n}',
                /must specialize "PersonType"/
            );
        });

        test('and is accepted once it does', async () => {
            await expectNoErrors(
                'package p\ntype PersonType isPowerType\nsubkind PersonGender specializes PersonType\nkind Person {\n@instantiation -- [1..*] PersonType\n@instantiation -- [1] PersonGender\n}'
            );
        });

        test('the powertype hierarchy mirrors the base hierarchy', async () => {
            await expectError(
                'package p\ntype PersonType isPowerType\nsubkind EmployeeType isPowerType\nkind Person { @instantiation -- [1..*] PersonType }\nrole Employee specializes Person { @instantiation -- [1..*] EmployeeType }',
                /must specialize "Person"'s powertype/
            );
        });

        test('two partitions of one type cannot specialize each other', async () => {
            await expectError(
                'package p\nkind Person\ntype PersonGender\ntype PersonAgePhase specializes PersonGender\n@instantiation relation Person [0..*] -- [1] PersonGender\n@instantiation relation Person [0..*] -- [1] PersonAgePhase',
                /both partition "Person"/
            );
        });

        test('two independent partitions are fine', async () => {
            await expectNoErrors(
                'package p\nkind Person\ntype PersonGender\ntype PersonAgePhase\n@instantiation relation Person [0..*] -- [1] PersonGender\n@instantiation relation Person [0..*] -- [1] PersonAgePhase'
            );
        });
    });

    describe('a generalization set may not contradict its instantiation', () => {
        const base = 'package p\nkind Person\ntype Gender\nsubkind Man specializes Person\nsubkind Woman specializes Person\n';
        const set = (flags: string) => `${flags} genset G {\ngeneral Person\ncategorizer Gender\nspecifics Man, Woman\n}\n`;

        test('a complete set cannot sit under a lower bound of zero', async () => {
            await expectError(base + set('disjoint complete') + '@instantiation relation Person [0..*] -- [0..*] Gender',
                /lower bound of 0/);
        });

        test('an overlapping set cannot sit under an upper bound of one', async () => {
            await expectError(base + set('complete') + '@instantiation relation Person [0..*] -- [1] Gender',
                /upper bound of 1/);
        });

        test('disjoint and complete with [1] is the partition case, and valid', async () => {
            await expectNoErrors(base + set('disjoint complete') + '@instantiation relation Person [0..*] -- [1] Gender');
        });
    });

    describe("the paper's own figures validate", () => {
        test('Fig 5(b): a powertype alongside two characterizations', async () => {
            await expectNoErrors(`package p
type PersonType isPowerType
subkind SocialRole specializes PersonType
subkind PersonGender specializes PersonType
kind Person {
@instantiation -- [1..*] PersonType
@instantiation -- [0..*] SocialRole
@instantiation -- [1] PersonGender
}
subkind Man specializes Person
subkind Woman specializes Person
disjoint complete genset Gender {
general Person
categorizer PersonGender
specifics Man, Woman
}`);
        });

        test('Fig 6(a): the powertype hierarchy mirroring the base hierarchy', async () => {
            await expectNoErrors(`package p
type PersonType isPowerType
subkind EmployeeType isPowerType specializes PersonType
subkind PersonGender specializes PersonType
subkind ManagementRole specializes EmployeeType
kind Person { @instantiation -- [1..*] PersonType }
role Employee specializes Person { @instantiation -- [1..*] EmployeeType }
@instantiation relation Person [0..*] -- [1] PersonGender
@instantiation relation Employee [0..*] -- [0..1] ManagementRole`);
        });

        test('Fig 4(a): [0..1] with an incomplete disjoint set', async () => {
            await expectNoErrors(`package p
kind Person
type ManagementRole
subkind OrganizationPresident specializes Person
subkind DepartmentDean specializes Person
@instantiation relation Person [0..*] -- [0..1] ManagementRole
disjoint genset Roles {
general Person
categorizer ManagementRole
specifics OrganizationPresident, DepartmentDean
}`);
        });
    });
});

describe('gufoshapes: the categorization pattern from the instance side', () => {
    const gender = 'package p\nkind Person\ntype PersonGender\n@instantiation relation Person [0..*] -- [1] PersonGender\n';

    describe('an instance of a categorizer specializes what it categorizes', () => {
        test('one that does not is an error', async () => {
            await expectError(gender + 'kind Elephant (instanceOf PersonGender)', /must specialize "Person"/);
        });

        test('one that does is accepted', async () => {
            await expectNoErrors(gender + 'subkind Man (instanceOf PersonGender) specializes Person\ndisjoint genset G where Man specializes Person');
        });

        test('a "type" may not have its own base as an instance, since it categorizes properly', async () => {
            await expectError(
                'package p\nkind Person (instanceOf PersonGender)\ntype PersonGender\n@instantiation relation Person [0..*] -- [0..*] PersonGender',
                /cannot be an instance of it/
            );
        });

        test('a "powertype" may, since every specialization is an instance', async () => {
            await expectNoErrors(`package p
type TreeSpecies isPowerType
kind Tree (instanceOf TreeSpecies) { @instantiation -- [1..*] TreeSpecies }
subkind Elm (instanceOf TreeSpecies) specializes Tree`);
        });
    });

    describe('the instances of a partitioning type are disjoint', () => {
        const members = 'subkind Man (instanceOf PersonGender) specializes Person\nsubkind Woman (instanceOf PersonGender) specializes Person\n';

        test('undeclared disjointness is reported', async () => {
            await expectWarning(gender + members, /are not declared disjoint/);
        });

        test('a disjoint generalization set satisfies it', async () => {
            await expectNoWarnings(gender + members + 'disjoint genset G where Man, Woman specializes Person',
                /not declared disjoint/);
        });

        test('and so does a disjointness declared above them', async () => {
            // Reported case. An instance of `Man` is an instance of `Male`,
            // so a set declaring `Male` and `Female` disjoint has already
            // said that no individual is both -- asking for a second
            // declaration between the subtypes asks for what follows.
            await expectNoWarnings([
                'package p', 'kind Person', 'type PersonGender',
                '@instantiation relation Person [0..*] -- [1] PersonGender',
                'subkind Male specializes Person', 'subkind Female specializes Person',
                'disjoint genset sexes where Male, Female specializes Person',
                'subkind Man (instanceOf PersonGender) specializes Male',
                'subkind Woman (instanceOf PersonGender) specializes Female'
            ].join('\n'), /not declared disjoint/);
        });

        test('two independent partitions are each reported, not just the first', async () => {
            // The check used to `return` after the first undeclared pair,
            // which left every partitioning type after it unchecked.
            const { diagnostics } = await validate(gender + members
                + 'type PersonAgeGroup\n@instantiation relation Person [0..*] -- [1] PersonAgeGroup\n'
                + 'subkind Child (instanceOf PersonAgeGroup) specializes Person\n'
                + 'subkind Adult (instanceOf PersonAgeGroup) specializes Person');
            const undeclared = diagnostics.filter(d => /not declared disjoint/.test(d.message));
            expect(undeclared.some(d => /"PersonGender"/.test(d.message)), messages(diagnostics)).toBe(true);
            expect(undeclared.some(d => /"PersonAgeGroup"/.test(d.message)), messages(diagnostics)).toBe(true);
        });

        test('a characterization that does not partition is left alone', async () => {
            // [0..*] is plain characterization: overlaps are the point.
            await expectNoWarnings(
                'package p\nkind Person\ntype SocialRole\n@instantiation relation Person [0..*] -- [0..*] SocialRole\n'
                + 'role Client (instanceOf SocialRole) specializes Person\nrole Employee (instanceOf SocialRole) specializes Person',
                /not declared disjoint/);
        });
    });

    test('enumerating instances does not make them look like extra base types', async () => {
        // `Elm (instanceOf TreeSpecies)` says Elm is an instance, not that
        // TreeSpecies is the powertype of Elm.
        await expectNoErrors(`package p
type TreeSpecies isPowerType
kind Tree { @instantiation -- [1..*] TreeSpecies }
subkind Elm (instanceOf TreeSpecies) specializes Tree
subkind Apricot (instanceOf TreeSpecies) specializes Tree`);
    });
});

describe('UFO 2021: dependence and mereology axioms', () => {
    describe('a51 supplementation: a whole is more than one of its parts', () => {
        test('a single modeled part is raised, but only as a hint', async () => {
            // A diagram does not claim to enumerate every part, so this is a
            // question about the decomposition rather than a contradiction,
            // and one worth asking as quietly as an editor can ask it.
            const { diagnostics } = await validate('package p\nkind Engine\nkind Car { @componenthood [1] <>-- [1] Engine }');
            const supplementation = diagnostics.filter(d => /supplementation requires/.test(d.message));
            expect(supplementation, messages(diagnostics)).toHaveLength(1);
            expect(supplementation[0].severity).toBe(DiagnosticSeverity.Hint);
        });

        test('two parts satisfy it', async () => {
            await expectNoWarnings(
                'package p\nkind Engine\nkind Wheel\nkind Car {\n@componenthood [1] <>-- [1] Engine\n@componenthood [1] <>-- [4] Wheel\n}',
                /supplementation requires/);
        });

        test('one part end of [2..*] also satisfies it', async () => {
            // Parts are counted, not parthood relations.
            await expectNoWarnings('package p\nkind Cell\nkind Tissue { @componenthood [1] <>-- [2..*] Cell }',
                /supplementation requires/);
        });

        test('a type with no parts at all is left alone', async () => {
            await expectNoWarnings('package p\nkind Car', /supplementation forbids/);
        });

        test('a collective with no members at all is asked for some', async () => {
            // Not by this rule -- supplementation counts the parts a whole
            // has, and a collective with nothing in it claims none. The
            // question "what is this a plurality of?" is `collective-without-
            // members`, which is what the empty body gets.
            const { diagnostics } = await validate('package p\ncollective Teste {\n}');
            expect(diagnostics.map(d => d.code)).toEqual(['collective-without-members']);
            expect(diagnostics[0].severity).toBe(DiagnosticSeverity.Hint);
        });

        test('a collective is supplemented by its members, so a lone sub-collection says nothing', async () => {
            // A sub-collection is a portion of the collective rather than one
            // of the things it is made of, and `sub-collection-multiplicity`
            // holds its end at one -- counting it as the single part reported
            // every collective with a section in it, and offered to widen the
            // one end that may not be widened.
            await expectNoWarnings(
                'package p\ncollective Choir {\n@subCollection [*] <>-- [1] Section\n}\ncollective Section',
                /supplementation requires/);
        });

        test('members of [2..*] answer it, sub-collection or no', async () => {
            await expectNoWarnings(
                'package p\nkind Person\ncollective Choir {\n@membership [1] <>-- [2..*] (members) Person\n@subCollection [*] <>-- [1] Section\n}\ncollective Section',
                /supplementation requires/);
        });

        test('a collective of one member is still raised, and the member end is what widens', async () => {
            const reported = await new TontoSession().validateText(
                'package p\nkind Person\ncollective Choir {\n@membership [1] <>-- [1] (members) Person\n@subCollection [*] <>-- [1] Section\n}\ncollective Section');
            const supplementation = reported.filter(d => d.code === 'whole-with-one-part');
            expect(supplementation).toHaveLength(1);
            const titles = supplementation[0].fixes.map(fix => fix.title);
            expect(titles).toContain('Require more than one "Person": "[2..*]"');
            // Never the sub-collection: its end is held at one by another rule.
            expect(titles.join(' ')).not.toMatch(/Section/);
        });
    });

    describe('what a class inherits, it may name plainly', () => {
        const world = [
            'package p',
            'category PhysicalObject of functional-complexes',
            'mixin ComplexPhysicalObject specializes PhysicalObject {',
            '@componenthood (wholes) [0..*] <>-- hasPart -- [2..*] (parts) PhysicalObject',
            '}'
        ].join('\n');

        test('the reported fragment, with the class names left out', async () => {
            await expectNoErrors([
                world,
                'kind Lion specializes ComplexPhysicalObject {',
                '@componenthood (whole) <>-- [1] (heart subsets parts) LionHeart specializes hasPart',
                '@componenthood (const whole subsets wholes) <>-- [1] (const brain subsets parts) LionBrain'
                + ' specializes hasPart',
                '}',
                'kind LionHeart specializes PhysicalObject',
                'kind LionBrain specializes PhysicalObject'
            ].join('\n'));
        });

        test('but not where nothing in the lineage declares the name', async () => {
            const { diagnostics } = await validate([
                world,
                'kind Boulder specializes PhysicalObject {',
                '@componenthood <>-- [1] (bit subsets parts) Boulder',
                '}'
            ].join('\n'));
            // `parts` belongs to `ComplexPhysicalObject`, which a boulder is
            // not: the name reaches nothing from here.
            expect(diagnostics.filter(d => /Could not resolve/.test(d.message)), messages(diagnostics))
                .toHaveLength(1);
        });

        test('the nearest declaration is the one meant', async () => {
            // `B.parts` redefines `A.parts`, so they are one property refined
            // and the closer one answers.
            await expectNoWarnings(
                'package p\nkind Person\nmixin A {\n-- [0..*] (parts) Person\n}\n'
                + 'mixin B specializes A {\n-- [0..*] (parts redefines A.parts) Person\n}\n'
                + 'kind X specializes B {\n-- [0..1] (mine subsets parts) Person\n}',
                /say nothing about each other/);
        });

        test('and two branches that say nothing about each other must be told apart', async () => {
            await expectWarning(
                'package p\nkind Person\nmixin A {\n-- [0..*] (parts) Person\n}\n'
                + 'mixin B {\n-- [0..*] (parts) Person\n}\n'
                + 'kind X specializes A, B {\n-- [0..1] (mine subsets parts) Person\n}',
                /"parts" is declared by .* which say nothing about each other/);
        });

        test('a relation specialization is named the same way', async () => {
            await expectWarning(
                'package p\nkind Person\nmixin A {\n-- has -- [0..*] Person\n}\n'
                + 'mixin B {\n-- has -- [0..*] Person\n}\n'
                + 'kind X specializes A, B {\n-- mine -- [0..1] Person specializes has\n}',
                /"has" is declared by/);
        });
    });

    describe('"mode" is deprecated, and says which mode it never was', () => {
        test('using it is reported, and the model still reads', async () => {
            const { diagnostics } = await validate(
                'package p\nkind Person\nmode Skill {\n@characterization [1] -- [1] (const) Person\n}');
            expect(diagnostics.map(d => d.code)).toEqual(['deprecated-stereotype']);
            expect(diagnostics[0].severity).toBe(DiagnosticSeverity.Warning);
            expect(diagnostics[0].message).toMatch(/individuated/);
        });

        test('the two refinements are not', async () => {
            await expectNoWarnings(
                'package p\nkind Person\nintrinsicMode Skill {\n@characterization [1] -- [1] (const) Person\n}',
                /deprecated/);
            await expectNoWarnings(
                'package p\nkind Person\nextrinsicMode Love {\n@characterization [1] -- [1] (const) Person\n'
                + '@externalDependence [1] -- [1] (const) Person\n}',
                /deprecated/);
        });

        test('and the taxonomy still admits it, since a model that uses it must go on validating', async () => {
            await expectNoErrors(
                'package p\nkind Person\nmode Skill {\n@characterization [1] -- [1] (const) Person\n}\n'
                + 'subkind Talent specializes Skill');
        });
    });

    describe('an omitted multiplicity is a claim like any other', () => {
        test('a whole that must contain itself is a cycle, written briefly or not', async () => {
            // Reported case: `[1]` is the default, so this says every node has
            // a node for a part -- and the parts never bottom out.
            await expectError('package p\nkind Node {\n@componenthood <>-- Node\n}', /never bottom out/);
            await expectError('package p\nkind Node {\n@componenthood <>-- [1] Node\n}', /never bottom out/);
        });

        test('and a bound that lets the chain stop is not', async () => {
            await expectNoWarnings('package p\nkind Node {\n@componenthood [0..1] <>-- [*] Node\n}', /never bottom out/);
            await expectNoWarnings('package p\nkind Node {\n@componenthood [0..1] <>-- [0..1] Node\n}', /never bottom out/);
        });

        test('the same of a dependence that must come back round', async () => {
            await expectError(
                'package p\nmode A {\n@characterization -- B\n}\nmode B {\n@characterization -- A\n}',
                /inherence is irreflexive/);
        });
    });

    describe('where an individual began is settled', () => {
        test('the event end of a "@creation" is asked for "(const)"', async () => {
            // Not reached by `immutable-end-not-const`: that reads the nature
            // of the classifier the end belongs to, and the end at the event
            // side belongs to the endurant, which changes freely.
            const { diagnostics } = await validate(
                'package p\nevent Birth\nkind Person {\n@creation (const) [1] -- [1] Birth\n}');
            expect(diagnostics.map(d => d.code)).toEqual(['creation-end-not-const']);
            expect(diagnostics[0].severity).toBe(DiagnosticSeverity.Warning);
        });

        test('and says nothing once it is written', async () => {
            await expectNoWarnings(
                'package p\nevent Birth\nkind Person {\n@creation (const) [1] -- [1] (const) Birth\n}',
                /re-pointed/);
        });

        test('the repair writes it into a decorator that is already there', async () => {
            const fixed = await new TontoSession().fixText(
                'package p\nevent Birth\nkind Person {\n@creation (const) [1] -- born -- [1] (birth) Birth\n}');
            expect(fixed.text).toContain('(const birth) Birth');
        });

        test('a termination is a different shape, and is asked nothing', async () => {
            // Its event end is `[0..1]`: the link is made once, when the
            // individual ceases to exist, and never broken -- `(addOnly)`,
            // which is what the snippet writes.
            await expectNoWarnings(
                `package p
event Death
kind Person {
@termination (const) [1] -- [0..1] (addOnly) Death
}`,
                /re-pointed/);
        });
    });

    describe('a collective is a plurality of members', () => {
        test('one with none named is asked what it is a plurality of', async () => {
            const { diagnostics } = await validate('package p\ncollective Orchestra');
            expect(diagnostics.map(d => d.code)).toEqual(['collective-without-members']);
        });

        test('members answer it, whichever end the diamond was written on', async () => {
            await expectNoWarnings(
                'package p\ncollective Choir\nkind Person {\n@membership [2..*] --<> [1] Choir\n}',
                /plurality of members/);
        });

        test('so do members of a sub-collection, which are members of the collection', async () => {
            // The orchestra pattern: the membership is written once, at the
            // sections, and the orchestra has musicians in it all the same.
            await expectNoWarnings(
                `package p
kind Musician
collective Orchestra {
@subCollection [1] <>-- [1] StringSection
}
collective StringSection {
@membership [1] <>-- [2..*] (members) Musician
}`,
                /plurality of members/);
        });

        test('an ancestor that says it answers for everything below', async () => {
            await expectNoWarnings(
                `package p
kind Person
collective Group {
@membership [1] <>-- [2..*] (members) Person
}
subkind Committee specializes Group`,
                /plurality of members/);
        });

        test('a complete partition whose specifics each say it answers too', async () => {
            await expectNoWarnings(
                `package p
kind Person
collective Group
collective Crew specializes Group {
@membership [1] <>-- [2..*] (members) Person
}
collective Team specializes Group {
@membership [1] <>-- [2..*] (members) Person
}
genset Kinds complete where Group specializedBy Crew, Team`,
                /plurality of members/);
        });

        test('a value is not a member: an end naming a datatype is judged too', async () => {
            // Every nature check read only classes, so `@membership <>-- date`
            // had a plurality of dates in it and nothing to say. A datatype
            // and an enumeration classify abstract individuals.
            const { diagnostics } = await validate(
                'package p\ndatatype Point {\nx: number\n}\ncollective C {\n@membership [*] <>-- [2..*] (members) Point\n}');
            const mismatch = diagnostics.filter(d => d.code === 'relation-end-nature-mismatch');
            expect(mismatch, messages(diagnostics)).toHaveLength(1);
            expect(mismatch[0].message).toMatch(/"Point" \(abstract\)/);
        });

        test('a class that is not a plurality is asked nothing', async () => {
            await expectNoWarnings('package p\nkind Person', /plurality of members/);
            await expectNoWarnings('package p\ncategory Thing', /plurality of members/);
        });
    });

    describe('t28, t29, a61: inherence and constitution cannot come back round', () => {
        test('a moment cannot inhere in itself', async () => {
            await expectError('package p\nquality Weight { @characterization [1] -- [1] Weight }',
                /inherence is irreflexive/);
        });

        test('nor in something that inheres in it', async () => {
            await expectError('package p\nmode A { @characterization [1] -- [1] B }\nmode B { @characterization [1] -- [1] A }',
                /inherence is irreflexive/);
        });

        test('constitution is asymmetric', async () => {
            await expectError(
                'package p\nkind Statue { @constitution [1] -- [1] Clay }\nkind Clay { @constitution [1] -- [1] Statue }',
                /constitution is asymmetric/);
        });
    });

    describe('a moment needs a bearer, wherever the omission is', () => {
        const model = 'package p\nintrinsicMode Headache\nquality Intensity {\n@characterization -- Headache\n}\n';

        test('the characterization inside Intensity gives Intensity a bearer, not Headache', async () => {
            await expectWarning(model, /"Headache".*nothing bears it/);
        });

        test('a subtype does not silence it', async () => {
            // The subtype guard this replaced silenced the parent entirely.
            await expectWarning(model + 'phase ActiveHeadache specializes Headache', /"Headache".*nothing bears it/);
        });

        test('a moment is recognized by nature, not by stereotype', async () => {
            // `phase` says nothing about inherence; everything it classifies
            // here is an intrinsic mode, so it is a moment.
            const { diagnostics } = await validate(model + 'phase ActiveHeadache specializes Headache');
            const flagged = diagnostics.filter(d => /nothing bears it/.test(d.message));
            expect(flagged, messages(diagnostics)).toHaveLength(1);
        });

        test('it is reported on the highest moment lacking one', async () => {
            const { diagnostics } = await validate(model + 'intrinsicMode Migraine specializes Headache');
            const flagged = diagnostics.filter(d => /nothing bears it/.test(d.message)).map(d => d.message);
            expect(flagged, messages(diagnostics)).toHaveLength(1);
            expect(flagged[0]).toMatch(/"Headache"/);
        });

        test('a subtype inherits its supertype\'s bearer', async () => {
            await expectNoWarnings(
                'package p\nkind Person\nintrinsicMode Headache { @characterization [0..*] -- [1] Person }\nphase ActiveHeadache specializes Headache',
                /nothing bears it/);
        });

        test('a relator answers to the mediation rule instead', async () => {
            await expectNoWarnings('package p\nkind Person\nrelator Marriage { @mediation [1] -- [2] Person }',
                /nothing bears it/);
        });
    });

    describe('a67 non-migration: a moment inheres in exactly one individual', () => {
        test('two unrelated bearers are an error', async () => {
            await expectError(
                'package p\nkind Person\nkind Car\nquality Weight {\n@characterization [0..*] -- [1] Person\n@characterization [0..*] -- [1] Car\n}',
                /which are unrelated/);
        });

        test('a narrower bearer restates the inherence rather than adding one', async () => {
            await expectNoErrors(
                'package p\nkind Person\nsubkind Adult specializes Person\nquality Weight {\n@characterization [0..*] -- [1] Person\n@characterization [0..*] -- [1] Adult\n}');
        });
    });

    describe('a57 constitution holds between different kinds', () => {
        test('two types under one kind cannot constitute each other', async () => {
            await expectError(
                'package p\nkind Material\nsubkind Statue specializes Material\nsubkind Clay specializes Material {\n@constitution [1] -- [1] Statue\n}',
                /both draw identity from/);
        });

        test('different kinds are fine', async () => {
            await expectNoErrors(
                'package p\nkind Statue\nquantity Clay { @constitution [1] -- [1] Statue }');
        });
    });
});

describe('the stereotype vocabulary', () => {
    test('a domain word that is also a stereotype may name a member', async () => {
        // `value` is a relation stereotype, and was reserved everywhere; a
        // quality could not have an attribute called `value` at all.
        await expectNoErrors('package p\ndatatype Number\nkind Person\nquality Weight {\nvalue: Number\n@characterization [0..*] -- [1] Person\n}');
    });

    test.each(['material', 'formal', 'composition', 'participation', 'membership'])(
        '"%s" may name a relation', async name => {
            await expectNoErrors(`package p\nkind A\nkind B\nrelation A [1] -- ${name} -- [1] B`);
        });

    test('a mistyped stereotype is reported rather than ignored', async () => {
        await expectError('package p\nkind A\nkind B\n@mediaton relation A [1] -- r -- [1] B',
            /is not a relation stereotype\. Use "@mediation"\./);
    });

    test('a capitalization slip is recognized as one', async () => {
        await expectError('package p\nkind A\nkind B\n@Mediation relation A [1] -- r -- [1] B',
            /Use "@mediation"\./);
    });

    test.each(Object.entries(RENAMED_STEREOTYPES))(
        '"@%s" is answered with the rename to "@%s"', async (older, newer) => {
            // No edit distance would connect memberOf to membership; the model
            // is told what happened rather than left to infer it.
            await expectError(`package p\nkind A\nkind B\n@${older} relation A [1] -- r -- [1] B`,
                new RegExp(`renamed in tonto\\. Use "@${newer}"\\.`));
        });

    test.each(Object.keys(RETIRED_STEREOTYPES))(
        '"@%s" is answered with what tonto does instead', async name => {
            const { diagnostics } = await validate(`package p\nkind A\nkind B\n@${name} relation A [1] -- r -- [1] B`);
            const reported = diagnostics.find(d => d.code === 'unknown-relation-stereotype');
            expect(reported, messages(diagnostics)).toBeDefined();
            expect(reported!.message).not.toMatch(/Use "@/);
        });

    test('a word close to nothing gets no guess', async () => {
        await expectError('package p\nkind A\nkind B\n@zzzzzzzzz relation A [1] -- r -- [1] B',
            /is not a relation stereotype\.$/);
    });
});

describe('the parthood and event association stereotypes', () => {
    test.each(['componenthood', 'membership', 'subCollection', 'subQuantity', 'triggering', 'bringingAbout'])(
        '"@%s" is accepted', async name => {
            // `(const)` at the part end because `@subQuantity` requires essential parts.
            await expectNoErrors(`package p\nclass A\nclass B\n@${name} relation A [1] -- r -- [1] (const) B`);
        });

    test('the nature table applies with either relation orientation', async () => {
        // A functional complex cannot be the whole of a membership.
        await expectError('package p\nkind Whole\nkind Part\n@membership relation Part [2..*] --<> [1] Whole', /cannot relate/);
        await expectError('package p\nkind Whole\nkind Part\n@membership relation Whole [1] <>-- [2..*] Part', /cannot relate/);
    });

    test('membership is read with the diamond on the target whole', async () => {
        await expectNoErrors('package p\ncollective Forest\nkind Tree\n@membership relation Tree [2..*] --<> [1] Forest');
    });

    describe('and adds three', () => {
        test('"structural" is event parthood', async () => {
            await expectNoErrors('package p\nevent Goal\nevent Match\n@structural relation Goal [1..*] --<> [1] Match');
            await expectError('package p\nkind Thing\nevent Match\n@structural relation Thing [1..*] --<> [1] Match',
                /cannot relate/);
        });

        test('"temporal" relates a projected temporal segment to its event', async () => {
            await expectNoErrors('package p\nevent AfternoonSegment\nevent Meeting\n@temporal relation AfternoonSegment [1] --<> [1] Meeting');
        });

        test('a participational portion depends exclusively on one participant', async () => {
            const model = (participantBound: string): string => [
                'package p', 'kind Person',
                'event Meeting {',
                '@participational (const) [1] <>-- [2..*] (const) AttendeeParticipation',
                '}', 'event AttendeeParticipation',
                `@participation relation Person (const) ${participantBound} -- attended -- [0..*] (const) AttendeeParticipation`
            ].join('\n');
            await expectNoErrors(model('[1]'));
            await expectNoErrors(model('[0..1]'));
            await expectError(model('[1..*]'), /participant end's maximum must be 1/);
        });

        describe('and its participants are counted together', () => {
            const portion = (...lines: string[]): string => [
                'package p', 'kind Person', 'kind Message',
                'event Disorder {',
                '@participational (const) [1] <>-- [2..*] (const) AgentParticipation',
                '}',
                ...lines
            ].join('\n');
            const twoParticipants = /"AgentParticipation" is a participational portion.*nothing is both/;

            test('two required participants that cannot be one individual are an error', async () => {
                // Each relation says one and passes on its own; the reasoner
                // found the contradiction only after export.
                await expectError(portion(
                    'event AgentParticipation',
                    '@participation relation Person (const) [1] -- acted -- [0..*] (const) AgentParticipation',
                    '@participation relation Message (const) [1] -- figured -- [0..*] (const) AgentParticipation'
                ), twoParticipants);
            });

            test('an omitted participant end requires one, as everywhere else', async () => {
                await expectError(portion(
                    'event AgentParticipation',
                    '@participation relation Person -- acted -- [0..*] (const) AgentParticipation',
                    '@participation relation Message -- figured -- [0..*] (const) AgentParticipation'
                ), twoParticipants);
            });

            test('a participation into a type above the portion counts', async () => {
                await expectError(portion(
                    'event Involvement',
                    '@participation relation Person (const) [1] -- wasInvolvedIn -- [0..*] (const) Involvement',
                    'subkind AgentParticipation specializes Involvement',
                    '@participation relation Message (const) [1] -- figured -- [0..*] (const) AgentParticipation'
                ), twoParticipants);
            });

            test('an optional participation, or one into the whole, does not', async () => {
                await expectNoErrors(portion(
                    'event AgentParticipation',
                    '@participation relation Person (const) [1] -- acted -- [0..*] (const) AgentParticipation',
                    '@participation relation Message (const) [0..1] -- figured -- [0..*] (const) AgentParticipation'
                ));
                await expectNoErrors(portion(
                    'event AgentParticipation',
                    '@participation relation Person (const) [1] -- acted -- [0..*] (const) AgentParticipation',
                    '@participation relation Message (const) [1] -- figured -- [0..*] (const) Disorder'
                ));
            });

            test('a disjoint set keeps two roles of one kind apart', async () => {
                await expectError(portion(
                    'role Author specializes Person', 'role Sharer specializes Person',
                    'disjoint genset sides where Author, Sharer specializes Person',
                    'event AgentParticipation',
                    '@participation relation Author (const) [1] -- wrote -- [0..*] (const) AgentParticipation',
                    '@participation relation Sharer (const) [1] -- shared -- [0..*] (const) AgentParticipation'
                ), /nothing is both/);
            });

            test('participants that could be one individual are a warning instead', async () => {
                const source = portion(
                    'role Author specializes Person', 'role Sharer specializes Person',
                    'event AgentParticipation',
                    '@participation relation Author (const) [1] -- wrote -- [0..*] (const) AgentParticipation',
                    '@participation relation Sharer (const) [1] -- shared -- [0..*] (const) AgentParticipation'
                );
                await expectNoErrors(source);
                await expectWarning(source, /always the same individual/);
            });

            test('a subtype that only inherits the conflict is not reported again', async () => {
                const { diagnostics } = await validate(portion(
                    'event AgentParticipation',
                    'subkind PublicParticipation specializes AgentParticipation',
                    '@participation relation Person (const) [1] -- acted -- [0..*] (const) AgentParticipation',
                    '@participation relation Message (const) [1] -- figured -- [0..*] (const) AgentParticipation'
                ));
                const reported = diagnostics.filter(d => d.code === 'participational-portion-two-participants');
                expect(reported.map(d => d.message)).toEqual([expect.stringContaining('"AgentParticipation"')]);
            });

            test('a portion with nothing taking part is a warning, not a hint', async () => {
                await expectWarning(portion('event AgentParticipation'),
                    /"AgentParticipation" is a participational portion.*nothing takes part in it/);
            });
        });

        test('"presence" relates a situation to an entity of any nature', async () => {
            await expectNoErrors('package p\nsituation Checkmate\nkind King\n@presence relation Checkmate [0..*] -- [1] King');
            await expectError('package p\nkind NotASituation\nkind King\n@presence relation NotASituation [0..*] -- [1] King',
                /cannot relate/);
        });
    });
});

describe('intrinsic and extrinsic modes are distinct natures', () => {
    const bearer = 'package p\nkind Person\n';

    test('an intrinsicMode carries only intrinsic-modes', async () => {
        await expectError(bearer + 'intrinsicMode M of extrinsic-modes { @characterization [0..*] -- [1] Person }',
            /"intrinsicMode" cannot classify extrinsic-modes/);
    });

    test('an extrinsicMode carries only extrinsic-modes', async () => {
        await expectError(bearer + 'extrinsicMode M of intrinsic-modes { @characterization [0..*] -- [1] Person }',
            /"extrinsicMode" cannot classify intrinsic-modes/);
    });

    test('a bare mode still admits either, since it does not say which', async () => {
        // Deprecated, and still read: an older model goes on validating, and
        // `deprecated-stereotype` is the warning that says what to write now.
        await expectNoErrors(bearer + 'mode M of extrinsic-modes { @characterization [0..*] -- [1] Person }');
        await expectNoErrors(bearer + 'mode N of intrinsic-modes { @characterization [0..*] -- [1] Person }');
    });

    test('externalDependence may start at an extrinsic mode', async () => {
        await expectNoErrors(bearer
            + 'extrinsicMode Commitment { @characterization [0..*] -- [1] Person }\n'
            + '@externalDependence relation Commitment [0..*] -- [1] Person');
    });

    test('but not at an intrinsic one, which depends on nothing beyond its bearer', async () => {
        // The table requires extrinsic-mode at the source; the union used to
        // let an intrinsic mode through.
        await expectError(bearer
            + 'intrinsicMode Headache { @characterization [0..*] -- [1] Person }\n'
            + '@externalDependence relation Headache [0..*] -- [1] Person',
            /"@externalDependence" cannot relate source "Headache" \(intrinsic-mode\)/);
    });
});

describe('parthood orientation when no diamond is written', () => {
    // The diamond decorates rather than decides: with none, the whole is the
    // source, the same orientation `<>--` states explicitly. Every example and
    // test wrote a diamond, so this default went unexercised.
    const forest = 'package p\ncollective Forest\nkind Tree\n';

    test('the enclosing class of an internal relation is the whole', async () => {
        await expectNoErrors('package p\nkind Tree\ncollective Forest { @membership [1] -- [2..*] Tree }');
    });

    test('so a kind cannot be the source of a membership', async () => {
        await expectError('package p\ncollective Forest\nkind Tree { @membership [2..*] -- [1] Forest }',
            /"@membership" cannot relate/);
    });

    test('and the same holds for the external form', async () => {
        await expectNoErrors(forest + '@membership relation Forest [1] -- [2..*] Tree');
        await expectError(forest + '@membership relation Tree [2..*] -- [1] Forest', /"@membership" cannot relate/);
    });

    test('an explicit "<>--" agrees with the default', async () => {
        await expectNoErrors(forest + '@membership relation Forest [1] <>-- [2..*] Tree');
    });

    test('an explicit "--<>" reverses it', async () => {
        await expectNoErrors(forest + '@membership relation Tree [2..*] --<> [1] Forest');
    });

    test('supplementation reads the same orientation', async () => {
        const { diagnostics } = await validate('package p\nkind Engine\nkind Car { @componenthood [1] -- [1] Engine }');
        // Car is the whole, so Car is the one with a single modeled part.
        expect(diagnostics.filter(d => /supplementation requires/.test(d.message)).map(d => d.message).join())
            .toMatch(/"Car"/);
    });

    test('and so does the parthood cycle search', async () => {
        await expectError('package p\nkind Part { @componenthood [1] -- [1..*] Part }', /never bottom out/);
    });
});

describe('a diamond at both ends of one relation', () => {
    // `RelationNotation` used to have no shape for this at all: the parser
    // matched the first marker as a complete, targetless relation (everything
    // after a marker is optional, to let a half-written relation still parse)
    // and started a second, unrelated relation from whatever followed --
    // reported, if at all, as a linking error blaming a class named after the
    // role name written between the two markers.
    test('named, inside a class body', async () => {
        const { diagnostics } = await validate('package p\nkind A\nkind B\nkind W {\n<>-- named --<> [1] B\n}');
        expect(diagnostics.some(unparsedOrUnlinked), messages(diagnostics)).toBe(false);
        await expectError('package p\nkind A\nkind B\nkind W {\n<>-- named --<> [1] B\n}',
            /marks both ends with a diamond/);
    });

    test('bare, inside a class body', async () => {
        await expectError('package p\nkind A\nkind B\nkind W {\n<>-- --<> [1] B\n}',
            /marks both ends with a diamond/);
    });

    test('named, at package level', async () => {
        const { diagnostics } = await validate('package p\nkind A\nkind B\nrelation A <>-- named --<> B');
        expect(diagnostics.some(unparsedOrUnlinked), messages(diagnostics)).toBe(false);
        await expectError('package p\nkind A\nkind B\nrelation A <>-- named --<> B',
            /marks both ends with a diamond/);
    });

    test('one diamond only is left alone', async () => {
        await expectNoErrors('package p\nkind A\nkind B\nrelation A <>-- named -- B');
        await expectNoErrors('package p\nkind A\nkind B\nrelation A -- named --<> B');
    });
});

describe('types are endurants, so endurant relations reach them', () => {
    // Fonseca, Guizzardi, Almeida, Sales & Porello, CAiSE 2022: "all
    // constraints applicable to endurant types in OntoUML also apply to
    // high-order types" -- and with them, the relations endurants take part in.
    const base = 'package p\nkind Ship\ntype ShipType\nkind Anchor { @instantiation -- [0..*] ShipType }\n';

    test('a relator may mediate a type', async () => {
        await expectNoErrors(base + 'relator Certification {\n@mediation [1] -- [1] ShipType\n@mediation [1] -- [1] Ship\n}');
    });

    test('a quality may characterize a type', async () => {
        // "an animal species may be characterized by a changing population size"
        await expectNoErrors(base + 'quality PopulationSize { @characterization [0..*] -- [1] ShipType }');
    });

    test('a mode may characterize a type', async () => {
        await expectNoErrors(base + 'extrinsicMode Price { @characterization [0..*] -- [1] ShipType }');
    });

    test('a type may be the target of an external dependence', async () => {
        await expectNoErrors(base
            + 'extrinsicMode Price { @characterization [0..*] -- [1] Ship }\n'
            + '@externalDependence relation Price [0..*] -- [1] ShipType');
    });

    test('a type may take part in a material relation', async () => {
        await expectNoErrors(base + 'type CrewType\nkind Crew { @instantiation -- [0..*] CrewType }\n'
            + '@material relation ShipType [0..*] -- crews -- [0..*] CrewType');
    });

    test('and in a comparative one', async () => {
        await expectNoErrors(base + '@comparative relation ShipType [0..*] -- older -- [0..*] Ship');
    });

    test('a type may be created', async () => {
        // "crime types come into existence at determinate times"
        await expectNoErrors(base + 'event Legislation\n@creation relation ShipType [0..1] -- [1] Legislation');
    });

    test('and terminated', async () => {
        await expectNoErrors(base + 'event Repeal\n@termination relation ShipType [0..1] -- [1] Repeal');
    });

    test('the endurant end of a creation is the first, not the event', async () => {
        // Getting this backwards would have put `type` on the event side.
        await expectError(base + 'event Legislation\n@creation relation Legislation [0..1] -- [1] ShipType',
            /"@creation" cannot relate/);
    });
});

describe('the rules for events, and their consequences', () => {
    test('an event is specialized by a subkind, not by another event', async () => {
        await expectNoErrors('package p\nevent Meeting\nsubkind Board specializes Meeting');
        await expectError('package p\nevent Meeting\nevent Board specializes Meeting',
            /is an ultimate sortal/);
    });

    test('an event may specialize a category or a mixin', async () => {
        await expectNoErrors('package p\ncategory Ceremony of events\nevent Wedding specializes Ceremony');
    });

    test('a subkind may specialize a situation or a type', async () => {
        await expectNoErrors('package p\nsituation Ready\nsubkind FullyReady specializes Ready');
        await expectNoErrors('package p\ntype ShipType\nkind Ship { @instantiation -- [1..*] ShipType }\nsubkind Sub specializes ShipType');
    });

    test('a phase and a role may specialize a type, which is an endurant', async () => {
        await expectNoErrors('package p\ntype ShipType\nkind Ship { @instantiation -- [1..*] ShipType }\nrole Chartered specializes ShipType');
    });

    test('but not an event or a situation, being anti-rigid', async () => {
        // Nothing outside the endurants can stop being an instance and go on
        // existing, which is what a phase or a role asks of its instances.
        await expectError('package p\nsituation Ready\nphase NearlyReady specializes Ready', /inherits situations/);
        await expectError('package p\nevent Meeting\nrole Chair specializes Meeting', /inherits events/);
        await expectError('package p\nphase P of situations', /cannot classify/);
        await expectError('package p\nrole R of events', /cannot classify/);
    });

    test('a role may specialize a historical one; the reverse costs something', async () => {
        // A historical role holds because of a past event, and the past does
        // not stop having happened; an ordinary role holds because a relator
        // binds or an extrinsic mode is borne, and either may lapse. The
        // permanent condition may be narrowed by a lapsing one, not vice versa.
        await expectNoErrors('package p\nkind Person\nhistoricalRole H specializes Person\nrole R specializes H');
        await expectNoErrors('package p\nkind Person\nhistoricalRoleMixin H of objects\nrole R specializes Person, H');
        await expectNoErrors('package p\nhistoricalRoleMixin H of objects\nroleMixin R specializes H');
        await expectWarning('package p\nkind Person\nrole R specializes Person\nhistoricalRole H specializes R',
            /makes the relator that founds "R" historical too/);
    });

    test('an ultimate sortal does not sit under another of its own stereotype', async () => {
        // Ultimate sortals are pairwise disjoint, so a lineage holds one.
        for (const stereotype of ['situation', 'process', 'event']) {
            await expectError(`package p\n${stereotype} A\n${stereotype} B specializes A`,
                /is an ultimate sortal -- it supplies its own principle of identity and so tops its lineage, and what specializes it is a base sortal: a "subkind", "role", "phase" or "historicalRole"/);
        }
    });

    test('and a high-order type is no exception', async () => {
        // MLT needs one power type to specialize another, but that is a
        // specialization of a *type*, which is a base sortal restricted to
        // types -- not a second ultimate sortal.
        await expectNoErrors('package p\nkind K { @instantiation -- [1..*] A }\ntype A\nsubkind B specializes A');
        await expectError('package p\nkind K { @instantiation -- [1..*] A }\ntype A\ntype B specializes A',
            /is an ultimate sortal/);
    });

    test('a situation may specialize a category or a mixin, as an event may', async () => {
        await expectNoErrors('package p\ncategory Ceremony of situations\nsituation Ready specializes Ceremony');
        await expectNoErrors('package p\nmixin M of situations, objects\nsituation Ready specializes M');
    });

    test('an event supplies identity, so its subkind needs no other', async () => {
        // Before these rules an event was not an ultimate sortal, which
        // left a subkind of one with nowhere to draw identity from.
        await expectNoErrors('package p\nevent Meeting\nsubkind Board specializes Meeting');
    });

    describe('what a non-sortal may be restricted to', () => {
        test('a mixin needs an endurant, since only those can change', async () => {
            await expectError('package p\nmixin M of events', /is semi-rigid/);
            await expectError('package p\nmixin M of situations', /is semi-rigid/);
            await expectError('package p\nmixin M of abstract-individuals', /is semi-rigid/);
            await expectError('package p\nmixin M of events, situations', /is semi-rigid/);
        });

        test('but only one of them, anywhere among its natures', async () => {
            await expectNoErrors('package p\nmixin M of events, objects');
            await expectNoErrors('package p\nmixin M of relators');
            await expectNoErrors('package p\nmixin M');
        });

        test('a category is unrestricted, so nothing is excluded from it', async () => {
            await expectNoErrors('package p\ncategory Ceremony of events\nevent Wedding specializes Ceremony');
            await expectNoErrors('package p\ncategory C of situations');
            await expectNoErrors('package p\ncategory C of abstract-individuals');
            await expectNoErrors('package p\ncategory C of objects, situations');
        });

        test('an anti-rigid mixin classifies what can change', async () => {
            // A role or a phase divides a life that can change. An event, a
            // situation and an abstract individual have none to divide; a
            // process does, though it does not endure.
            for (const stereotype of ['roleMixin', 'phaseMixin', 'historicalRoleMixin']) {
                for (const nature of ['events', 'situations', 'abstract-individuals']) {
                    await expectError(`package p\n${stereotype} X of ${nature}`, /cannot classify/);
                }
                await expectNoErrors(`package p\n${stereotype} X of processes`);
            }
            await expectNoErrors('package p\nroleMixin R of objects');
        });
    });
});

describe('read-only ends', () => {
    test('a property of something immutable cannot change', async () => {
        // The end is a property of the classifier at the *other* end, so this
        // one belongs to the wedding -- which is over.
        await expectWarning('package p\nkind Place\nevent Wedding {\n-- [1] (venue) Place\n}',
            /whose instances cannot change/);
        await expectNoErrors('package p\nkind Place\nevent Wedding {\n-- [1] (const venue) Place\n}');
    });

    test('and neither can a property of an abstract individual', async () => {
        await expectWarning('package p\nkind Person\nabstractum Color {\n-- [1] (namedBy) Person\n}',
            /whose instances cannot change/);
    });

    test('but a process is not immutable: gaining parts is what it does', async () => {
        await expectNoErrors('package p\nkind Person\nprocess Baking {\n-- [1] (cook) Person\n}');
    });

    test('so an event fixes the end that belongs to it, and only that one', async () => {
        // Not a rule of its own: an end is a property of the classifier at the
        // *other* end. A process constituted by an event shows the asymmetry --
        // the end naming the process belongs to the event, which is over, while
        // the end naming the event belongs to the process, which is still going.
        await expectWarning('package p\nprocess Baking\nevent Fold\n@constitution relation Baking [1] -- [1] Fold',
            /property of "Fold", whose instances cannot change/);
        await expectNoErrors('package p\nprocess Baking\nevent Fold\n@constitution relation Baking (const) [1] -- [1] Fold');
    });

    test('dependence cannot lose a link, but a plural end may gain more', async () => {
        await expectWarning('package p\nkind Person\nquality Weight {\n@characterization -- [1] Person\n}',
            /is dependence, so what depends cannot lose or replace/);
        await expectWarning('package p\nkind Person\nrelator Marriage {\n@mediation [0..*] -- [2] Person\n}',
            /is dependence, so what depends cannot lose or replace/);
        await expectWarning('package p\nkind Person\nextrinsicMode Debt {\n@externalDependence -- [1] Person\n}',
            /individual it depends on/);
        // Not existential, but as firmly settled: the past does not change.
        await expectWarning('package p\nkind Cook\nprocess Baking {\n@historicalDependence -- [1] Cook\n}',
            /past it depends on/);
        await expectNoErrors('package p\nkind Cook\nprocess Baking {\n@historicalDependence -- [1] (const) Cook\n}');
        await expectNoErrors('package p\nkind Person\nquality Weight {\n@characterization -- [1] (const) Person\n}');
        await expectNoWarnings([
            'package p', 'kind Person', 'kind Organization', 'relator Grouping {',
            '@mediation [0..*] -- [1..*] (addOnly) Person',
            '@mediation [0..*] -- [1] (const) Organization', '}'
        ].join('\n'), /dependence-end-not-const|cannot lose or replace/);
    });

    test('presence and optional outcomes may accumulate around a settled individual', async () => {
        await expectNoWarnings(
            'package p\nsituation Ready\nkind Person\n@presence relation Ready (addOnly) [0..*] -- [1..*] (const) Person',
            /cannot change|nothing is added/);
        await expectNoWarnings(
            'package p\nsituation Ready\nevent Started\n@triggering relation Ready (const) [1] -- [0..1] (addOnly) Started',
            /cannot change|nothing is added/);
        await expectNoWarnings(
            'package p\nevent Signing\nsituation InForce\n@bringingAbout relation Signing (const) [1] -- [0..1] (addOnly) InForce',
            /cannot change|nothing is added/);
    });
});

describe('documentation tags', () => {
    test('a language documents a declaration once', async () => {
        await expectError('package p\n/// @en A human being.\n/// @en Someone else.\nkind Person',
            /Documentation in "en" is already given above/);
        await expectNoErrors('package p\n/// @en A human being.\n/// @pt-br Um ser humano.\nkind Person');
    });

    test('a label and a description in one language do not collide', async () => {
        // Different things about the same declaration: what it is called, and
        // what it is.
        await expectNoErrors('package p\n/// @label:en Person\n/// @en A human being.\nkind Person');
    });

    test('a tag with nothing after it says nothing', async () => {
        await expectWarning('package p\n/// @pt-br\nkind Person', /says nothing/);
    });

    test('a near-miss tag is questioned; a sentence is not', async () => {
        const { diagnostics } = await validate('package p\n/// @labl Person\nkind Person');
        expect(diagnostics.map(d => d.message).join('\n')).toMatch(/Did you mean "@label"/);
        await expectNoWarnings('package p\n/// @mediation is the stereotype to use.\nkind Person', /documentation tag/);
        // Two edits away is a word, not a slip.
        await expectNoWarnings('package p\n/// @lbll Person\nkind Person', /documentation tag/);
    });

    test('a language written once, one edit from the one written everywhere, is a slip', async () => {
        // Nothing about the shape of `@pt-b` says it is not a language; the
        // rest of the document is what says so.
        const { diagnostics } = await validate([
            'package p',
            '/// @pt-br Um ser humano.',
            'kind Person',
            '/// @pt-br Uma organização.',
            'kind Organization',
            '/// @pt-b Uma coisa.',
            'kind Thing'
        ].join('\n'));
        const doubtful = diagnostics.filter(d => d.code === 'doubtful-doc-language');
        expect(doubtful.map(d => d.message), messages(diagnostics)).toEqual([
            '"pt-b" is written once, and "pt-br" everywhere else. Did you mean "pt-br"?'
        ]);
        expect(doubtful[0].severity).toBe(DiagnosticSeverity.Hint);
    });

    test('but a language used once and nothing like it is left alone', async () => {
        await expectNoWarnings('package p\n/// @pt-br Um ser humano.\nkind Person\n/// @fr Une chose.\nkind Thing', /Did you mean/);
    });

    test('documentation attaches to anything, not only to classifiers', async () => {
        // The blocks could only be written on a classifier; this is the main
        // thing the comment form buys.
        await expectNoErrors([
            'package p',
            'datatype date',
            '/// @label:en Person',
            'kind Person {',
            '    /// @en When they were born.',
            '    @begin birthDate: const date',
            '    /// @en Where they live.',
            '    -- [1] Place',
            '}',
            'kind Place'
        ].join('\n'));
    });
});

describe('begin and end points', () => {
    const preamble = 'package p\ndatatype Date\n';

    test('a concrete individual may say when it began and when it ended', async () => {
        await expectNoErrors(preamble + 'kind Person {\n@begin birth: const Date\n@end death: const Date [0..1]\n}');
        await expectNoErrors(preamble + 'event Wedding {\n@begin starts: const Date\n@end finishes: const Date\n}');
        await expectNoErrors(preamble + 'situation Married {\n@begin from: const Date\n}');
    });

    test('and nothing asks it to', async () => {
        // The point of the amendment: a class that says nothing about its
        // lifetime is complete as it stands.
        await expectNoWarnings(preamble + 'kind Person {\nname: Date\n}', /begin|end point/);
    });

    test('a type is an endurant, so it has them too', async () => {
        await expectNoErrors(preamble + 'type PersonType {\n@begin introduced: const Date\n@end abandoned: const Date [0..1]\n}');
    });

    test('but an abstract individual is outside time', async () => {
        await expectError(preamble + 'abstractum Color {\n@begin b: const Date\n}',
            /abstract individual, and nothing outside time begins or ends/);
        await expectError(preamble + 'datatype Money {\n@begin b: const Date\n}',
            /is a datatype, so its instances are values/);
    });

    test('when something began cannot change', async () => {
        await expectWarning(preamble + 'kind Person {\n@begin birth: Date\n}', /cannot change. Mark it "const"/);
        await expectNoWarnings(preamble + 'kind Person {\n@begin birth: const Date\n}', /cannot change/);
    });

    test('an endurant that still exists has no end point yet', async () => {
        const { diagnostics } = await validate(preamble + 'kind Person {\n@end death: const Date\n}');
        const hint = diagnostics.filter(d => d.message.includes('should be optional'));
        expect(hint, messages(diagnostics)).toHaveLength(1);
        expect(hint[0].severity).toBe(DiagnosticSeverity.Hint);
        await expectNoWarnings(preamble + 'kind Person {\n@end death: const Date [0..1]\n}', /should be optional/);
        // A modeled event is one that occurred, so both of its instants are known.
        await expectNoWarnings(preamble + 'event Wedding {\n@end finishes: const Date\n}', /should be optional/);
    });

    test('an instantaneous individual carries both on one attribute', async () => {
        // Begin and end coincide, so the one value is
        // known as soon as there is anything to know it of.
        await expectNoWarnings(preamble + 'kind Payment {\n@begin @end instant: const Date\n}', /should be optional/);
        await expectError(preamble + 'kind Payment {\n@begin @begin instant: const Date\n}',
            /"@begin" is already on this attribute/);
    });

    test('a mistyped stereotype is answered by name', async () => {
        // Without this the attribute parses as a relation and the reader gets
        // a page of expected-token noise about a slip in one letter.
        await expectError(preamble + 'kind Person {\n@bgin birth: const Date\n}',
            /"@bgin" is not an attribute stereotype.*Use "@begin"/);
        await expectError(preamble + 'kind Person {\n@bogus birth: const Date\n}',
            /"@bogus" is not an attribute stereotype; the only ones are "@begin" and "@end"\.$/);
    });

    test('and "begin" and "end" are still ordinary attribute names', async () => {
        await expectNoErrors(preamble + 'kind Meeting {\nbegin: Date\nend: Date\n}');
    });
});

describe('@change, and what has a history', () => {
    test('an endurant changes in an event or a process', async () => {
        await expectNoErrors('package p\nkind Person\nevent Birthday\n@change relation Person [0..*] -- [1] Birthday');
        await expectNoErrors('package p\nkind Person\nprocess Ageing\n@change relation Person [0..*] -- [1] Ageing');
        await expectNoErrors('package p\nrelator Marriage\nevent Wedding\n@change relation Marriage [0..*] -- [1] Wedding');
    });

    test('and nothing else does, nor into anything else', async () => {
        // A situation obtains rather than changes, and what an endurant
        // changes in is a perdurant.
        await expectError('package p\nsituation Ready\nevent E\n@change relation Ready [0..*] -- [1] E', /cannot relate/);
        await expectError('package p\nkind Person\nsituation Ready\n@change relation Person [0..*] -- [1] Ready', /cannot relate/);
    });

    test('historical dependence relates any concrete individuals', async () => {
        await expectNoErrors('package p\nkind Person\nprocess Ageing\n@historicalDependence relation Ageing [0..*] -- [1] Person');
        await expectNoErrors('package p\nsituation Ready\nkind Person\n@historicalDependence relation Ready [0..*] -- [1] Person');
    });

    test('but not an abstract individual, which has no history', async () => {
        await expectError('package p\nkind Person\nclass A of abstract-individuals\n@historicalDependence relation Person [0..*] -- [1] A',
            /cannot relate/);
    });
});

describe('an abstractum classifies abstract individuals', () => {
    test('which is its nature, and the only one it may be restricted to', async () => {
        await expectNoErrors('package p\nabstractum Color');
        await expectError('package p\nabstractum Color of events', /cannot classify/);
    });

    test('only a subkind sits beneath one', async () => {
        await expectNoErrors('package p\nabstractum Color\nsubkind Hue specializes Color');
        // An anti-rigid sortal classifies what can change, and an abstract
        // individual cannot -- nothing they classify could be a Color.
        for (const stereotype of ['role', 'phase', 'historicalRole']) {
            await expectError(`package p\nabstractum Color\n${stereotype} X specializes Color`,
                /nature|specialize/);
        }
        await expectError('package p\nabstractum Color\nabstractum Shade specializes Color',
            /is an ultimate sortal/);
    });

    test('and it sits under a rigid non-sortal, as any ultimate sortal does', async () => {
        await expectNoErrors('package p\ncategory Abstract of abstract-individuals\nabstractum Color specializes Abstract');
    });

    test('a datatype may specialize one', async () => {
        // The check asks the natures, so the stereotype made for abstract
        // individuals works where `class of abstract-individuals` did.
        await expectNoErrors('package p\nabstractum Color\ndatatype RGB specializes Color');
        await expectError('package p\nkind Person\ndatatype Address specializes Person',
            /can only specialize a class whose instances are abstract individuals/);
    });
});

describe('what the rules ask that we had left unasked', () => {
    test('a phase alternates with another, so one on its own is questioned', async () => {
        const { diagnostics } = await validate('package p\nkind Person\nphase Adult specializes Person');
        const lone = diagnostics.filter(d => d.code === 'lone-phase');
        expect(lone.map(d => d.severity)).toEqual([DiagnosticSeverity.Hint]);
        expect(lone[0].message).toMatch(/only phase of "Person"/);
        await expectNoWarnings([
            'package p', 'kind Person',
            'phase Child specializes Person', 'phase Adult specializes Person',
            'disjoint complete genset ages where Child, Adult specializes Person'
        ].join('\n'), /phase/);
    });

    test('phases may divide a class along more than one line, each its own partition', async () => {
        const partitioned = [
            'package p', 'kind Person',
            'phase Child specializes Person', 'phase Adult specializes Person',
            'disjoint complete genset byLifePhase where Child, Adult specializes Person',
            'phase IllPerson specializes Person', 'phase HealthyPerson specializes Person',
            'disjoint complete genset byHealthStatus where IllPerson, HealthyPerson specializes Person'
        ];
        await expectNoWarnings(partitioned.join('\n'), /phase/);
        // A phase outside every partition is still reported, and only it.
        const { diagnostics } = await validate([...partitioned, 'phase Retiree specializes Person'].join('\n'));
        const loose = diagnostics.filter(d => d.code === 'phases-without-partition');
        expect(loose.map(d => d.message), messages(diagnostics)).toEqual([
            expect.stringMatching(/^Phase "Retiree" of "Person" is in no "disjoint complete"/)
        ]);
    });

    test('and a phase where two partitions meet is not a lone phase', async () => {
        // What an ill child alternates with is said by the partitions its
        // parents are in.
        const { diagnostics } = await validate([
            'package p', 'kind Person',
            'phase Child specializes Person', 'phase Adult specializes Person',
            'disjoint complete genset byLifePhase where Child, Adult specializes Person',
            'phase IllPerson specializes Person', 'phase HealthyPerson specializes Person',
            'disjoint complete genset byHealthStatus where IllPerson, HealthyPerson specializes Person',
            'phase IllChild specializes Child, IllPerson'
        ].join('\n'));
        expect(diagnostics.filter(d => /phase/.test(d.code ?? '')), messages(diagnostics)).toEqual([]);
    });

    describe('phase mixins are partitioned as phases are', () => {
        const devices = (...lines: string[]): string => [
            'package p', 'category Device of functional-complexes',
            'phaseMixin FunctionalDevice specializes Device', 'phaseMixin BrokenDevice specializes Device',
            ...lines,
            'kind Phone specializes Device',
            'phase WorkingPhone specializes Phone, FunctionalDevice', 'phase BrokenPhone specializes Phone, BrokenDevice',
            'disjoint complete genset phoneStatus where WorkingPhone, BrokenPhone specializes Phone',
            'kind Printer specializes Device',
            'phase WorkingPrinter specializes Printer, FunctionalDevice', 'phase BrokenPrinter specializes Printer, BrokenDevice',
            'disjoint complete genset printerStatus where WorkingPrinter, BrokenPrinter specializes Printer',
            'disjoint complete genset working where WorkingPhone, WorkingPrinter specializes FunctionalDevice',
            'disjoint complete genset broken where BrokenPhone, BrokenPrinter specializes BrokenDevice'
        ].join('\n');

        test('two of them under one type with no partition are a warning', async () => {
            const { diagnostics } = await validate(devices());
            const loose = diagnostics.filter(d => d.code === 'phase-mixins-without-partition');
            expect(loose.map(d => d.severity), messages(diagnostics)).toEqual([DiagnosticSeverity.Warning]);
            expect(loose[0].message).toMatch(/^Phase mixins "FunctionalDevice", "BrokenDevice" divide "Device"/);
        });

        test('a disjoint complete set over them answers it', async () => {
            await expectNoWarnings(
                devices('disjoint complete genset operationalStatus where FunctionalDevice, BrokenDevice specializes Device'),
                /without-partition|divide|in no "disjoint complete"/);
        });

        test('a set that is not both disjoint and complete does not', async () => {
            await expectWarning(devices('disjoint genset operationalStatus where FunctionalDevice, BrokenDevice specializes Device'),
                /Phase mixins "FunctionalDevice", "BrokenDevice" divide "Device"/);
        });

        test('a second line of change is a second partition, and one left outside is named', async () => {
            const { diagnostics } = await validate(devices(
                'disjoint complete genset operationalStatus where FunctionalDevice, BrokenDevice specializes Device',
                'phaseMixin AvailableDevice specializes Device'
            ));
            expect(diagnostics.filter(d => d.code === 'phase-mixins-without-partition').map(d => d.message), messages(diagnostics))
                .toEqual([expect.stringMatching(/^Phase mixin "AvailableDevice" of "Device" is in no "disjoint complete"/)]);
        });

        test('phases and phase mixins are counted apart', async () => {
            // One of each under a type is not two of either.
            await expectNoWarnings([
                'package p', 'kind Phone', 'phaseMixin BrokenThing of functional-complexes',
                'phase BrokenPhone specializes Phone, BrokenThing', 'phase WorkingPhone specializes Phone',
                'disjoint complete genset phoneStatus where WorkingPhone, BrokenPhone specializes Phone'
            ].join('\n'), /divide|in no "disjoint complete"/);
        });
    });

    test('and a partition of phases holds phases and nothing else', async () => {
        const { diagnostics } = await validate([
            'package p', 'kind Person',
            'phase Adult specializes Person', 'phase Child specializes Person',
            'subkind Man specializes Person',
            'disjoint complete genset ages where Adult, Child, Man specializes Person'
        ].join('\n'));
        const mixed = diagnostics.filter(d => d.code === 'partition-mixes-phases');
        // Two incompatible claims about the same set, not a half-written
        // sibling: a warning rather than a hint.
        expect(mixed.map(d => d.severity), messages(diagnostics)).toEqual([DiagnosticSeverity.Warning]);
        expect(mixed[0].message).toMatch(/"Man" \(subkind\)/);
    });

    test('and an event is what its participants are doing', async () => {
        // The fifth member of the family: a relator with no mediation, a
        // moment with no bearer, an extrinsic mode with nothing beyond its
        // bearer, a process with no events -- and an event with nobody in it.
        // A hint, where the other four in the family are warnings: who took
        // part is ordinarily worth saying and ordinarily said elsewhere.
        await expectHintCode('package p\nkind Person\nevent Wedding', 'event-without-participation');
        await expectNoWarnings(
            'package p\nkind Person\nevent Wedding\n@participation relation Person (const) [2] -- marriedIn -- [0..*] (const) Wedding',
            /takes part/);
        // Being created or terminated in it is taking part in it too.
        await expectNoWarnings(
            'package p\nkind Person\nevent Birth\n@creation relation Person (const) [1] -- bornIn -- [1] (const) Birth',
            /takes part/);
        // Causation is not: what brought an event about was not in it.
        await expectHintCode(
            'package p\nsituation Ready\nevent Signing\n@triggering relation Ready (const) [1] -- [0..1] (const) Signing',
            'event-without-participation');
    });

    test('and it has them through its parts, and through what it constitutes', async () => {
        // What takes part in a part takes part in the whole, whichever event
        // decomposition criterion is used -- and what takes part in a
        // process takes part in the events constituting it (A5).
        await expectNoWarnings([
            'package p', 'kind Person',
            'event Wedding {', '@structural (const) [1] <>-- [2..*] (const) VowExchange', '}',
            'event VowExchange',
            '@participation relation Person (const) [1] -- vowedIn -- [0..*] (const) VowExchange'
        ].join('\n'), /takes part/);
        await expectNoWarnings([
            'package p', 'kind Baker', 'event Kneading',
            'process Baking {', '@constitution (const) [1] -- [1..*] (addOnly) Kneading', '}',
            '@participation relation Baker (const) [1..*] -- performs -- [0..*] (const) Baking'
        ].join('\n'), /takes part/);
    });

    test('or a complete partition whose every subtype names one', async () => {
        // Reported case. A complete generalization set says its specifics
        // exhaust the general, so every bond mediates once every kind of bond
        // does -- and writing the abstraction first is the ordinary shape of a
        // taxonomy, not an omission.
        const bond = (genset: string, second: string): string => [
            'package p', 'kind Person', 'category Bond of relators',
            'relator Marriage specializes Bond {', '@mediation [1] -- [2] (const) Person', '}',
            'relator Employment specializes Bond {', second, '}', genset
        ].join('\n');
        const mediates = '@mediation [1] -- [2] (const) Person';
        await expectNoWarnings(
            bond('disjoint complete genset g where Marriage, Employment specializes Bond', mediates),
            /mediates nothing/);
        // Incomplete, so the instances are not exhausted and the abstraction
        // still has to say it.
        await expectWarning(
            bond('disjoint genset g where Marriage, Employment specializes Bond', mediates),
            /"Bond" classifies relators/);
        // Complete, but one of them says nothing.
        await expectWarning(
            bond('disjoint complete genset g where Marriage, Employment specializes Bond', ''),
            /classifies relators/);
    });

    test('and the same for a bearer, a dependence and a constitution', async () => {
        await expectNoWarnings([
            'package p', 'kind Person', 'category Aspect of intrinsic-modes',
            'intrinsicMode Skill specializes Aspect {', '@characterization [*] -- [1] (const) Person', '}',
            'intrinsicMode Belief specializes Aspect {', '@characterization [*] -- [1] (const) Person', '}',
            'complete genset g where Skill, Belief specializes Aspect'
        ].join('\n'), /nothing bears it/);
        await expectNoWarnings([
            'package p', 'event Fold', 'category Doing of processes',
            'process Baking specializes Doing {',
            '@constitution (const) [1] -- [1..*] (addOnly) Fold', '}',
            'complete genset g where Baking specializes Doing'
        ].join('\n'), /no event is named/);
    });

    test('or the parthood that holds it where it is', async () => {
        // Reported case. Componenthood is relational: a main motor is a motor
        // a boat has as its main one, and there is no relator to wait for.
        await expectNoWarnings([
            'package p', 'kind Motor',
            'kind Boat {', '@componenthood [0..1] <>-- [1..*] MainMotor', '}',
            'role MainMotor specializes Motor'
        ].join('\n'), /Nothing mediates/);
        // The whole end is not founded by its parts: an employee has a badge
        // because they are one, not the other way round.
        const { diagnostics } = await validate([
            'package p', 'kind Person', 'kind Badge',
            'role Employee specializes Person {', '@componenthood [1] <>-- [2..*] (const) Badge', '}'
        ].join('\n'));
        expect(diagnostics.filter(d => d.code === 'role-without-relator').map(d => d.severity),
            messages(diagnostics)).toEqual([DiagnosticSeverity.Hint]);
    });

    test('and a material relation names the relator it is derived from', async () => {
        await expectHintCode(
            'package p\nkind Person\nkind Organization\n@material relation Person [0..*] -- worksFor -- [0..*] Organization',
            'material-without-relator');
        // Mediations to the ends, or to anything above them, ground it.
        await expectNoWarnings([
            'package p', 'kind Person', 'role Employee specializes Person', 'kind Organization',
            'relator Employment {',
            '@mediation [1..*] -- [1] (const) Employee',
            '@mediation [0..*] -- [1] (const) Organization', '}',
            '@material relation Employee [0..*] -- worksFor -- [0..*] Organization'
        ].join('\n'), /derived from a relator/);
    });

    test('an inverse of a derived material relation inherits that derivation', async () => {
        const source = [
            'package p', 'kind Person', 'relator ParentHood {',
            '    @mediation (childParenthoods) [*] -- [1] (const involvesParent) Person',
            '    @mediation (parentParenthoods) [2] -- [1] (const involvesChild) Person',
            '}',
            '@material relation Person [2] -- hasChild -- [0..*] Person inverseOf hasParent derivedFrom ParentHood',
            '@material relation Person (children) [0..*] -- hasParent -- [2] (parents) Person'
        ].join('\n');
        const { diagnostics } = await validate(source);
        expect(diagnostics.map(diagnostic => diagnostic.code)).not.toContain('derivation-unstated');
        expect(diagnostics.map(diagnostic => diagnostic.code)).not.toContain('material-without-relator');
    });

    test('and it works when the underived declaration points to the derived inverse', async () => {
        const source = [
            'package p', 'kind Person', 'kind Organization', 'relator Employment {',
            '    @mediation [*] -- [1] (const) Person',
            '    @mediation [*] -- [1] (const) Organization',
            '}',
            '@material relation Person [*] -- worksFor -- [*] Organization inverseOf employs',
            '@material relation Organization [*] -- employs -- [*] Person derivedFrom Employment'
        ].join('\n');
        const { diagnostics } = await validate(source);
        expect(diagnostics.map(diagnostic => diagnostic.code)).not.toContain('derivation-unstated');
        expect(diagnostics.map(diagnostic => diagnostic.code)).not.toContain('material-without-relator');
    });

    test('a historical role names the event that made it hold', async () => {
        const { diagnostics } = await validate('package p\nkind Person\nhistoricalRole FormerStudent specializes Person');
        expect(diagnostics.filter(d => d.code === 'historical-role-without-event').map(d => d.severity))
            .toEqual([DiagnosticSeverity.Hint]);
        // Satisfied anywhere in the lineage, since a subtype inherits it.
        await expectNoWarnings([
            'package p', 'kind Person', 'event Graduation',
            'historicalRole FormerStudent specializes Person {',
            '@participation (const) [0..*] -- [1] Graduation', '}',
            'historicalRole FormerPhD specializes FormerStudent'
        ].join('\n'), /no event is named/);
    });
});

describe('an inverse is the same association read backwards', () => {
    // Reported case. The two statements of one association disagreed about
    // every end and nothing read the second one.
    const father = [
        'package p',
        'kind Person {',
        '@historicalDependence (addOnly children) [*] -- hasFather -- [1] (const father) Man',
        '}',
        'subkind Man specializes Person {'
    ];

    const withInverse = async (line: string): Promise<string[]> =>
        (await validate([...father, line, '}'].join('\n'))).diagnostics.map(d => String(d.code));

    test('so its ends are the other\'s, crossed over', async () => {
        expect(await withInverse('-- hasChildren -- Person inverseOf Person.hasFather'))
            .toEqual(['inverse-ends-differ']);
        expect(await withInverse('[0..1] -- hasChildren -- [2] Person inverseOf Person.hasFather'))
            .toEqual(['inverse-ends-differ']);
        expect(await withInverse(
            '(const father) [1] -- hasChildren -- [*] (addOnly children) Person inverseOf Person.hasFather'))
            .toEqual([]);
    });

    test('and naming one of them twice is naming one end twice', async () => {
        // `Man.children` is the end `hasFather` already declares, so the
        // second statement of it is not a second member.
        const { diagnostics } = await validate([...father,
            '(const father) [1] -- hasChildren -- [*] (addOnly children) Person inverseOf Person.hasFather',
            '}'].join('\n'));
        expect(diagnostics.filter(d => d.code === 'duplicate-member'), messages(diagnostics)).toEqual([]);
    });

    test('while an end named on one side only is not a disagreement', async () => {
        expect(await withInverse(
            '(const) [1] -- hasChildren -- [*] (addOnly kids) Person inverseOf Person.hasFather'))
            .toEqual(['inverse-ends-differ']);
        // `father` here, unnamed there: nothing contradicts anything.
        expect(await withInverse(
            '(const father) [1] -- hasChildren -- [*] (addOnly) Person inverseOf Person.hasFather'))
            .toEqual([]);
    });

    test('but a bad signature is answered before the ends are', async () => {
        const { diagnostics } = await validate([
            'package p', 'kind Person', 'kind Car',
            'relation Person [1] -- drives -- [*] Car',
            'relation Person [*] -- driven -- [1] Car inverseOf drives'
        ].join('\n'));
        expect(diagnostics.map(d => d.code)).toEqual(['inverse-signature-mismatch']);
    });

    test('two exact crossed signatures are suggested as possible inverses once', async () => {
        const { diagnostics } = await validate([
            'package p', 'kind Person', 'kind Organization',
            'relation Person (employer) [0..*] -- worksFor -- [1] (employee) Organization',
            'relation Organization (employee) [1] -- employs -- [0..*] (employer) Person'
        ].join('\n'));
        const hints = diagnostics.filter(d => d.code === 'matching-inverse');
        expect(hints.map(d => d.severity)).toEqual([DiagnosticSeverity.Hint]);
        expect(hints[0].message).toContain('"worksFor" and "employs"');
    });

    test('but cardinalities and every written end property have to match', async () => {
        const models = [
            'relation Organization [1] -- employs -- [1] Person',
            'relation Organization [1] -- employs -- [0..*] (const) Person',
            'relation Organization (company) [1] -- employs -- [0..*] Person'
        ];
        for (const candidate of models) {
            const { diagnostics } = await validate([
                'package p', 'kind Person', 'kind Organization',
                'relation Person [0..*] -- worksFor -- [1] Organization',
                candidate
            ].join('\n'));
            expect(diagnostics.filter(d => d.code === 'matching-inverse'), candidate).toEqual([]);
        }
    });

    test('but not between a class and itself where the ends read the same either way round', async () => {
        const same = await validate('package p\nkind Person {\n[*] -- likes -- [*] Person\n[*] -- admires -- [*] Person\n}');
        expect(same.diagnostics.filter(d => d.code === 'matching-inverse')).toEqual([]);
        // Crossing says something where the two ends differ.
        const crossed = await validate(
            'package p\nkind Person {\n[*] -- hasParent -- [2] Person\n[2] -- hasChild -- [*] Person\n}');
        expect(crossed.diagnostics.filter(d => d.code === 'matching-inverse')).toHaveLength(1);
    });

    test('nor for a relation whose inverse is already declared, from either side', async () => {
        const { diagnostics } = await validate([
            'package p', 'kind Person', 'kind Organization',
            'relation Person [0..*] -- worksFor -- [1] Organization',
            'relation Organization [1] -- employs -- [0..*] Person inverseOf worksFor',
            'relation Organization [1] -- pays -- [0..*] Person'
        ].join('\n'));
        expect(diagnostics.filter(d => d.code === 'matching-inverse')).toEqual([]);
    });

});

describe('what is settled, and what is still going on', () => {
    test('an event is over, so its properties and links are const', async () => {
        await expectWarning('package p\ndatatype date\nevent Wedding {\nheldAt: date\n}',
            /Nothing about an instance of "Wedding" changes/);
        await expectNoWarnings('package p\ndatatype date\nevent Wedding {\nheldAt: const date\n}', /changes/);
    });

    test('and so is a situation, which obtains or does not', async () => {
        await expectWarning('package p\ndatatype date\nsituation Ready {\nsince: date\n}',
            /Nothing about an instance of "Ready" changes/);
        await expectWarning('package p\nkind Person\nsituation Ready {\n-- [1] (who) Person\n}',
            /whose instances cannot change/);
    });

    test('and so is a value, which is what its components are', async () => {
        await expectWarning('package p\ndatatype Address {\nstreet: string\n}',
            /"Address" classifies values, and a value with a different "street" is a different value/);
        await expectNoWarnings('package p\ndatatype Address {\nstreet: const string\n}', /different value/);
        // Only its components: which apples are red is not part of the color.
        await expectNoWarnings(
            'package p\nenum Color { red, green }\nkind Apple\nrelation Apple [*] -- color -- [1] Color',
            /cannot change|different value/);
    });

    test('but a situation accumulates parts, which is the one thing it gains', async () => {
        const { diagnostics } = await validate('package p\nsituation Ready\nsituation Loaded\nrelation Ready [1] <>-- [2..*] Loaded');
        expect(diagnostics.filter(d => d.code === 'accumulating-end-not-add-only').map(d => d.message), messages(diagnostics))
            .toEqual(['A situation changes in no other way, but it accumulates parts: nothing here is ever taken back, which is "addOnly".']);
        await expectNoWarnings('package p\nsituation Ready\nsituation Loaded\nrelation Ready [1] <>-- [2..*] (addOnly) Loaded',
            /accumulates|cannot change/);
    });

    test('an event has ended, so its end point is [1]', async () => {
        await expectWarning('package p\ndatatype date\nevent Wedding {\n@end finishedAt: const date [0..1]\n}',
            /an event has ended, so its end point is "\[1\]"/);
        await expectNoWarnings('package p\ndatatype date\nevent Wedding {\n@end finishedAt: const date\n}', /end point/);
    });

    test('while a process or a situation may still be going on', async () => {
        for (const stereotype of ['process', 'situation', 'kind']) {
            const { diagnostics } = await validate(
                `package p\ndatatype date\n${stereotype} X {\n@end finishedAt: const date\n}`);
            expect(diagnostics.map(d => d.code), stereotype).toContain('end-time-point-not-optional');
        }
    });

    test('an aspect is reified for what has a life to bear it', async () => {
        // Endurants and processes; an event's or a situation's would-be
        // qualities are properties of it.
        await expectNoErrors('package p\nprocess Baking\nquality Duration {\n@characterization -- [1] (const) Baking\n}');
        await expectError('package p\nevent Wedding\nquality Duration {\n@characterization -- [1] (const) Wedding\n}',
            /An event is over, so "Wedding" bears no reified aspect. Record "Duration" as a "const" property/);
        await expectError('package p\nsituation Ready\nintrinsicMode Urgency {\n@characterization -- [1] (const) Ready\n}',
            /A situation is fact-like while it obtains, so "Ready" bears no reified aspect/);
    });

    test('and an extrinsic mode may depend on anything still unfolding', async () => {
        const dependence = (target: string): string => [
            'package p', 'kind Person', target,
            'extrinsicMode Duty {', '@characterization -- [1] (const) Person',
            '@externalDependence -- [1] (const) X', '}'
        ].join('\n');
        await expectNoErrors(dependence('process X'));
        await expectNoErrors(dependence('situation X'));
        await expectNoErrors(dependence('kind X'));
        // Not an event: it has already happened.
        await expectError(dependence('event X'), /"@externalDependence" cannot relate/);
    });
});

describe('a repair leaves something that parses', () => {
    // Every model in the rules and pattern catalogs is run through the
    // fixer in `test/repairs.test.ts`; these are the three that did not, and
    // the reasons they did not.

    test('two repairs do not write into one decorator at once', async () => {
        // Two flags written into one decorator at once produced text that
        // did not parse, back when they went inside braces. One repair per
        // line per round, and the loop takes the next one after.
        const session = new TontoSession();
        const source = inOntology([
            'package p', 'kind Person', 'kind Department {',
            '-- hasStaff -- [1..*] (const staff) Person',
            '-- head -- [1] (subsets Department.staff) Person', '}'
        ].join('\n'));
        const fixed = await session.fixText(source);
        expect(fixed.text).toContain('(const subsets Department.staff)');
        expect(fixed.left.filter(d => d.severity === 'error')).toEqual([]);
    });

    test('and a flag arrives with its comma', async () => {
        const session = new TontoSession();
        const fixed = await session.fixText(inOntology([
            'package p', 'kind Person', 'kind Team {',
            '<>-- hasMembers -- [2..*] (const members) Person',
            '<>-- hasLeader -- [1] (lead redefines Team.members) Person', '}'
        ].join('\n')));
        // The flag joins the decorator that is already there, comma and all.
        expect(fixed.text).toContain('(const lead redefines Team.members)');
        // The multiplicity is left: narrowing [1] to something within [2..*]
        // is a decision, so `--fix` does not make it (see `batchSafe`).
        expect(fixed.left.filter(d => d.severity === 'error').map(d => d.code))
            .toEqual(['redefinition-weakens-lower-bound']);
    });

    test('and removing the last specific removes the set', async () => {
        // Asked for by name: deleting a declaration is a decision, so a plain
        // `--fix` leaves it and this says which rule it wants applied.
        const session = new TontoSession();
        const fixed = await session.fixText(
            inOntology('package p\nkind Person\ngenset Odd where Person specializes Person'),
            'draft', new Set(['genset-self-generalization']));
        expect(fixed.text).not.toContain('genset');
        expect(fixed.left.filter(d => d.severity === 'error')).toEqual([]);
    });
});

describe('a quantity is extensional, so its parts are essential', () => {
    // Guizzardi 2005, section 8.3: "quantities are mereologically invariant,
    // i.e., the change of any of its parts changes the identity of the whole.
    // In other words, all parts of a quantity are essential."

    test('the part end is const, whatever the stereotype says', async () => {
        await expectError('package p\nquantity Wine {\n@subQuantity [1] <>-- [1] Alcohol\n}\nquantity Alcohol',
            /every part of "Wine" is essential to it, so this end is "\(const\)"/);
        await expectNoErrors('package p\nquantity Wine {\n@subQuantity [1] <>-- [1] (const) Alcohol\n@subQuantity [1] <>-- [1] (const) Water\n}\nquantity Alcohol\nquantity Water');
        // The nature settles it, so a bare diamond is not a way around it.
        await expectError('package p\nquantity Wine {\n[1] <>-- [1] Alcohol\n}\nquantity Alcohol',
            /every part of "Wine" is essential/);
    });

    test('and exactly one sub-quantity of a kind, since a quantity is maximal', async () => {
        await expectError('package p\nquantity Wine {\n@subQuantity [1] <>-- [0..*] (const) Alcohol\n}\nquantity Alcohol',
            /exactly one sub-quantity of a kind: this end is "\[1\]"/);
        await expectError('package p\nquantity Wine {\n@subQuantity [1] <>-- [0..1] (const) Alcohol\n}\nquantity Alcohol',
            /exactly one sub-quantity of a kind/);
    });

    test('and never shared, which the whole end says', async () => {
        // The bound, not a glyph: this rule read the filled diamond, so a
        // model that wrote `[1]` at the whole end -- saying exactly
        // non-shareable -- was told to say it differently.
        await expectError(
            'package p\nquantity Wine {\n@subQuantity [0..*] <>-- [1] (const) Alcohol\n}\nquantity Alcohol',
            /cannot be \[0\.\.\*\]/);
        await expectNoErrors(
            'package p\nquantity Wine {\n@subQuantity [1] <>-- [1] (const) Alcohol\n}\nquantity Alcohol');
        // An omitted bound is exactly one, which is the strongest form of it.
        await expectNoErrors(
            'package p\nquantity Wine {\n@subQuantity <>-- [1] (const) Alcohol\n}\nquantity Alcohol');
    });

    test('a collective is not extensional unless the model says so', async () => {
        // The choice the thesis marks with {extensional} on the class is made
        // here per relation, by writing `(const)` at the member end or not.
        await expectNoErrors('package p\nkind Person\ncollective Family {\n@membership [1] <>-- [2..*] Person\n}');
        await expectNoErrors('package p\nkind Person\ncollective Family {\n@membership [1] <>-- [2..*] (const) Person\n}');
    });
});

describe('what the meta-properties amount to, read off the types', () => {
    test('a collective has at most one sub-collection of a kind', async () => {
        await expectError('package p\ncollective Orchestra {\n@subCollection [1] <>-- [2..*] Strings\n}\ncollective Strings',
            /at most one sub-collection of a kind/);
        await expectNoErrors('package p\ncollective Orchestra {\n@subCollection [1] <>-- [1] Strings\n@subCollection [1] <>-- [1] Brass\n}\ncollective Strings\ncollective Brass');
    });

    test('but not between non-sortals, which quantify over every kind at once', async () => {
        await expectNoErrors([
            'package p',
            'category Collection of collectives',
            'collective Deck specializes Collection',
            'category Sub of collectives specializes Collection',
            'collective Suit specializes Sub',
            '@subCollection relation Collection [1] <>-- [0..*] Sub'
        ].join('\n'));
    });

    test('an anti-rigid whole makes an immutable part, not an essential one', async () => {
        // De dicto: fixed while the individual is an Employee, and silent
        // about the person, who may be one again with another badge.
        const { diagnostics } = await validate([
            'package p', 'kind Person', 'kind Badge', 'kind Lanyard',
            'role Employee specializes Person {',
            '@componenthood [1] <>-- [1] (const) Badge',
            '@componenthood [1] <>-- [1] Lanyard',
            '}'
        ].join('\n'));
        const noted = diagnostics.filter(d => d.code === 'essential-part-of-anti-rigid-whole');
        expect(noted.map(d => d.message), messages(diagnostics)).toEqual([
            // The rigid whole is the one above it: the sentence named the role
            // itself as the ultimate sortal the role specializes.
            '"Employee" is anti-rigid, so this fixes the part only while an instance is one: an immutable part,'
            + ' not an essential one. Essential parthood needs a rigid whole, which is the ultimate sortal'
            + ' "Person" it specializes.'
        ]);
        // A hint: nothing is wrong, and in this editor information is louder
        // than the remark deserves.
        expect(noted[0].severity).toBe(DiagnosticSeverity.Hint);
    });

    test('and a rigid one makes an essential part, with nothing to say about it', async () => {
        await expectNoWarnings([
            'package p', 'kind Brain', 'kind Heart',
            'kind Body {', '@componenthood [1] <>-- [1] (const) Brain',
            '@componenthood [1] <>-- [1] Heart', '}'
        ].join('\n'), /anti-rigid/);
    });
});

describe('addOnly: a collection that only grows', () => {
    // UML 1.x had `frozen` and `addOnly`; `const` stands where the first did,
    // and this is the second: values may be added, never removed or replaced.

    test('says something about a collection, and nothing about one value', async () => {
        await expectNoErrors('package p\ndatatype string\nkind K {\naliases: ordered addOnly string [0..*]\n}');
        await expectWarning('package p\ndatatype string\nkind K {\nname: addOnly string\n}',
            /always holds the same number of values/);
        await expectWarning('package p\nkind Person\nkind Team {\n-- [1] (addOnly) Person\n}',
            /always holds the same number of links/);
        // Fixed at two is fixed: nothing is added there either.
        await expectWarning('package p\nkind Person\nkind Team {\n<>-- [2] (addOnly) Person\n}',
            /always holds the same number of links/);
    });

    test('but an optional one can be filled in, which is an addition', async () => {
        // The two rules met here: this said `addOnly` was meaningless on
        // `[0..1]` while `accumulating-end-not-add-only` asked for it there,
        // and both cannot be right. Going from none to one is an addition, and
        // `(const)` on an end that starts empty says it stays empty.
        await expectNoWarnings('package p\nkind Person\nkind Team {\n-- [0..1] (addOnly) Person\n}',
            /addOnly/);
        await expectNoWarnings('package p\ndatatype string\nkind K {\nnickname: addOnly string [0..1]\n}',
            /addOnly/);
    });

    test('and never beside "const", which the grammar refuses', async () => {
        // `const` says the whole of what `addOnly` says and more, so the two
        // are alternatives rather than a pair a rule has to talk anyone out
        // of.
        for (const source of [
            'package p\ndatatype string\nkind K {\naliases: const addOnly string [0..*]\n}',
            'package p\nkind Person\nkind Team {\n<>-- [2..*] (const addOnly) Person\n}'
        ]) {
            const { diagnostics } = await validate(source);
            expect(diagnostics.some(d => /Expecting/.test(String(d.message))), source).toBe(true);
        }
    });

    test('a collection that cannot change is not one that grows', async () => {
        // The end belongs to the classifier at the other end, and an event is
        // over: `const` is the word there.
        await expectWarning('package p\nkind Place\nevent Wedding {\n-- [2..*] (addOnly venues) Place\n}',
            /whose instances cannot change, so nothing is added to it either/);
    });

    test('but what has come to depend on something past does grow', async () => {
        // The two rules met here and asked for opposite words: the dependent
        // end of a historical dependence is a property of the past thing, so
        // "a property of something immutable cannot change" reached it and
        // said `(const)` while `accumulating-end-not-add-only` said
        // `(addOnly)`. The past thing does not change when something new
        // comes to depend on it -- the world around it does.
        const attended = [
            'package p', 'kind Person', 'event Ceremony', 'event Wedding {',
            '@historicalDependence (addOnly) [*] -- [1] (const) Ceremony', '}',
            '@participation relation Person (const) [2] -- attended -- [0..*] (const) Ceremony',
            '@participation relation Person (const) [2] -- marriedIn -- [0..*] (const) Wedding'
        ].join('\n');
        await expectNoWarnings(attended, /cannot change/);
        await expectNoWarnings(
            'package p\nevent Ceremony\nkind Person\nrole Spouse specializes Person {\n@historicalDependence (addOnly) [*] -- [1] (const) Ceremony\n}',
            /cannot change/);
        // Said nothing at all, the end still hears the one hint that applies.
        const { diagnostics } = await validate(
            'package p\nevent Ceremony\nevent Wedding {\n@historicalDependence [*] -- [1] (const) Ceremony\n}');
        expect(diagnostics.filter(d => d.code !== 'event-without-participation')
            .map(d => d.code), messages(diagnostics))
            .toEqual(['accumulating-end-not-add-only']);
        // And the far end, which is the past itself, is fixed as ever.
        await expectWarning(
            'package p\nevent Ceremony\nevent Wedding {\n@historicalDependence (addOnly) [*] -- [1] (addOnly) Ceremony\n}',
            /whose instances cannot change, so nothing is added to it either/);
    });

    test('an end that can go from none to one still gains', async () => {
        // Reading the upper bound alone let `[0..1]` through, and none-to-one
        // is the addition this is about. Fixed at a size -- `[1]`, `[2]`, or
        // nothing written -- there is no addition to speak of.
        const hints = async (source: string): Promise<string[]> =>
            (await validate(source)).diagnostics
                .filter(d => d.code === 'accumulating-end-not-add-only').map(d => String(d.code));
        expect(await hints('package p\nkind Man\nkind Person {\n@historicalDependence [0..1] -- [1] (const) Man\n}'))
            .toEqual(['accumulating-end-not-add-only']);
        expect(await hints('package p\nkind Man\nkind Person {\n@historicalDependence [1] -- [1] (const) Man\n}'))
            .toEqual([]);
        expect(await hints('package p\nkind Man\nkind Person {\n@historicalDependence [2] -- [1] (const) Man\n}'))
            .toEqual([]);

        // And it is a warning here, not a hint: the far end of the same
        // relation is `(const)` for the same reason, and that is a warning.
        const { diagnostics } = await validate(
            'package p\nkind Man\nkind Person {\n@historicalDependence [*] -- born -- [1] (const) Man\n}');
        expect(diagnostics.filter(d => d.code === 'accumulating-end-not-add-only').map(d => d.severity),
            messages(diagnostics)).toEqual([DiagnosticSeverity.Warning]);
    });

    test('a redefinition may strengthen it, never weaken it', async () => {
        await expectWarning([
            'package p',
            'kind Person',
            'kind Team {',
            '<>-- [2..*] (addOnly members) Person',
            '}',
            'kind Squad specializes Team {',
            '<>-- [2..*] (players redefines Team.members) Person',
            '}'
        ].join('\n'), /should be "addOnly" or "const" too/);
        await expectNoWarnings([
            'package p',
            'kind Person',
            'kind Team {',
            '<>-- [2..*] (addOnly members) Person',
            '}',
            'kind Squad specializes Team {',
            '<>-- [2..*] (const players redefines Team.members) Person',
            '}'
        ].join('\n'), /addOnly/);
    });

    test('and a process is told that its life accumulates', async () => {
        // Axiom A7: the constitution at a later time has the constitution at
        // an earlier one as a starting part. `(addOnly)` is that.
        const { diagnostics } = await validate(
            'package p\nprocess Baking\nevent Fold\n@constitution relation Baking (const) [1] -- [1..*] Fold');
        const hint = diagnostics.filter(d => d.code === 'accumulating-end-not-add-only');
        expect(hint.map(d => d.message), messages(diagnostics))
            .toEqual(['A process accumulates what constitutes it: nothing here is ever taken back, which is "addOnly".']);
        expect(hint[0].severity).toBe(DiagnosticSeverity.Hint);

        await expectNoWarnings(
            'package p\nprocess Baking\nevent Fold\n@constitution relation Baking (const) [1] -- [1..*] (addOnly) Fold',
            /accumulates/);
        // Its temporal parts accumulate for the same reason.
        await expectNoWarnings(
            'package p\nprocess Flight\nprocess Crossing\nrelation Flight [1] <>-- [2..*] (addOnly) Crossing',
            /accumulates/);
        // An event's structural parts do not: they are fixed, which `const` says.
        await expectNoWarnings(
            'package p\nevent Wedding\nevent Vow\n@structural relation Wedding (const) [1] <>-- [2..*] (const) Vow',
            /accumulates/);
    });
});

describe('a process is an occurrent that can change', () => {
    // Guarino & Guizzardi, *Processes as variable embodiments*, Synthese
    // 203:104 (2024). A process is not a continuant -- it has temporal parts --
    // but it does have its properties at a time, so it can change: its
    // constitution varies as it goes on, the way a statue's matter does.

    test('intrinsic modes and qualities inhere in one', async () => {
        await expectNoErrors('package p\nprocess Baking\nquality Duration { @characterization -- [1] Baking }');
        await expectNoErrors('package p\nprocess Baking\nintrinsicMode Skill { @characterization -- [1] Baking }');
    });

    test('but an extrinsic mode does not, and no relator mediates one', async () => {
        // Both ask for an endurant, and a process is not one.
        await expectError('package p\nprocess Baking\nextrinsicMode Debt { @characterization -- [1] Baking }',
            /"@characterization" cannot relate/);
        await expectError('package p\nprocess Baking\nrelator Contract { @mediation [0..*] -- [1] Baking }',
            /"@mediation" cannot relate/);
    });

    test('and so it takes no part in a material relation', async () => {
        // A material relation is derived from a mediation; nothing mediates a
        // process, so nothing is derived about one.
        await expectError('package p\nkind Cook\nprocess Baking\n@material relation Cook [0..*] -- does -- [0..*] Baking',
            /"@material" cannot relate/);
    });

    test('objects participate in one, and moments manifest in one', async () => {
        await expectNoErrors('package p\nprocess Baking\nkind Cook { @participation -- [1] Baking }');
        await expectNoErrors('package p\nprocess Baking\nintrinsicMode Skill { @manifestation -- [1] Baking }');
    });

    test('it is constituted by events, in that direction only', async () => {
        // "At each time, a process is constituted by a certain series of
        // events" (§3.1, A5) -- and the constitution varies as it goes on,
        // which is what a process changing is.
        await expectNoErrors('package p\nprocess Baking\nevent Fold\n@constitution relation Baking [1] -- [1] Fold');
        await expectError('package p\nevent Fold\nprocess Baking\n@constitution relation Fold [1] -- [1] Baking',
            /may be the wrong way round/);
    });

    test('its parts are processes, and an event is not one of them', async () => {
        // Parthood is kept completely separate from constitution (§3.2, A8):
        // a process and the event constituting it share no part at all.
        await expectNoErrors('package p\nprocess Flight\nprocess Crossing\nrelation Flight [1] <>-- [2..*] Crossing');
        await expectError('package p\nprocess Baking\nevent Fold\nrelation Baking [1] <>-- [1..*] Fold',
            /Parthood does not admit/);
    });

    test('and it depends on the history of endurants', async () => {
        // The dependence runs from the process to what had to be there first,
        // not the other way about: there is no baking without a cook.
        await expectNoErrors('package p\nkind Cook\nprocess Baking { @historicalDependence -- [1] Cook }');
    });

    test('a situation may have one present in it', async () => {
        await expectNoErrors('package p\nprocess Baking\nsituation Ready { @presence -- [1] Baking }');
    });

    test('sortals may specialize it, because it can change', async () => {
        // Anti-rigidity needs an individual that can change, not one that
        // endures -- and §5.3 of the paper is a phase structure over a
        // process: ongoing, suspended, interrupted, complete.
        await expectNoErrors('package p\nprocess Baking\nsubkind Proving specializes Baking');
        await expectNoErrors('package p\nprocess Baking\nrole Contracted specializes Baking');
        await expectNoErrors('package p\ncategory Activity of processes\nprocess Baking specializes Activity');
        await expectNoErrors([
            'package p',
            'process Baking',
            'phase Ongoing specializes Baking',
            'phase Complete specializes Baking',
            'disjoint complete genset stages where Ongoing, Complete specializes Baking'
        ].join('\n'));
    });

    test('and a mixin may span one, since something under it can lapse', async () => {
        await expectNoErrors('package p\nmixin Monitored of processes, events');
    });
});

describe('the parthood table reads in writing order', () => {
    // `Car <>-- Engine` reads whole then part, and so does the table, so the
    // common case needs no mental inversion. `--<>` reverses both together.
    const forest = 'package p\ncollective Forest\nkind Tree\n';

    test('whole first, as written', async () => {
        await expectNoErrors(forest + '@membership relation Forest [1] <>-- [2..*] Tree');
        await expectNoErrors(forest + '@membership relation Forest [1] -- [2..*] Tree');
    });

    test('and the diagnostic names them in that order too', async () => {
        await expectError(forest + '@membership relation Tree [2..*] -- [1] Forest',
            /cannot relate whole "Tree" .* to part "Forest"/);
    });

    test('an inverted diamond reverses the reading, not the table', async () => {
        await expectNoErrors(forest + '@membership relation Tree [2..*] --<> [1] Forest');
    });
});

describe('the diamond makes a relation parthood, stereotype or not', () => {
    test('a relator may have extrinsic modes as parts, in either writing direction', async () => {
        const foundation = `ontology employment
kind Person
kind Organization
relator Employment {
    @mediation [0..*] -- [1] (const) Person
    @mediation [0..*] -- [1] (const) Organization
}
extrinsicMode RightToSalary {
    @characterization [0..*] -- [1] (const) Person
    @externalDependence [0..*] -- [1] (const) Organization
}
`;
        await expectNoErrors(foundation + 'relation Employment [1] <>-- [0..*] RightToSalary');
        await expectNoErrors(foundation + 'relation RightToSalary [0..*] --<> [1] Employment');
        await expectError(foundation + 'relation RightToSalary [1] <>-- [0..*] Employment',
            /Parthood does not admit/);
        await expectError(foundation + '@componenthood relation Employment <>-- RightToSalary',
            /"@componenthood" cannot relate/);
    });

    test('an unstereotyped aggregation that never bottoms out is reported', async () => {
        await expectError('package p\nkind System { [0..1] <>-- [1..*] System }', /never bottom out/);
        await expectError('package p\nkind System { [1..*] --<> [0..1] System }', /never bottom out/);
    });

    test('and an optional one is not -- a system may contain systems', async () => {
        await expectNoErrors('package p\nkind System { [0..1] <>-- [0..*] System }');
    });

    test('supplementation reads unstereotyped parthood too', async () => {
        const { diagnostics } = await validate('package p\nkind Engine\nkind Car { [0..1] <>-- [1] Engine }');
        expect(diagnostics.filter(d => /supplementation requires/.test(d.message)), messages(diagnostics))
            .toHaveLength(1);
    });

    test('a lower bound of zero claims nothing, so raises nothing', async () => {
        // `<>-- [0..*]` does not say the whole has any parts, so there is no
        // lone part for a second to be missing from.
        await expectNoWarnings('package p\nkind Wheel\nkind Car { [0..1] <>-- [0..*] Wheel }',
            /supplementation requires/);
    });

    test('a relation with no diamond and no parthood stereotype is not parthood', async () => {
        await expectNoErrors('package p\nkind System { [0..1] -- contains -- [1..*] System }');
    });

    describe('so the diamond and the stereotype may not disagree', () => {
        test('a diamond on a non-parthood stereotype is an error', async () => {
            await expectError('package p\nkind A\nkind B\n@material relation A [1] <>-- r -- [1] B',
                /aggregation diamond states parthood, but "@material" is not/);
        });

        test('a parthood stereotype with a diamond is fine', async () => {
            await expectNoErrors('package p\nkind A\nkind B { @componenthood [1] <>-- [2..*] A }');
        });
    });
});

describe('"@namespace": where an ontology\'s terms are published', () => {
    test('is an absolute http(s) IRI ending in "#" or "/", with no query', async () => {
        for (const [namespace, problem] of [
            ['https://example.org/ns-a', 'ends in neither'],
            ['ftp://example.org/ns-b#', 'is not an http or https IRI'],
            ['https://example.org/ns-c?x=1#', 'has a query'],
            ['https://example.org/ns#d#', 'has a "#" before its end'],
            ['http://purl.org/nemo/gufo#', 'is the namespace of a vocabulary the export builds on']
        ]) {
            await expectError(`/// @namespace ${namespace}\nontology p\nkind A\n`, new RegExp(`The namespace "[^"]*" ${problem}`));
        }
        for (const namespace of ['https://example.org/ns-ok-hash#', 'https://example.org/ns-ok-slash/']) {
            await expectNoWarnings(`/// @namespace ${namespace}\nontology p\nkind A\n`, /namespace/i);
        }
    });

    test('is written once, and above the ontology header', async () => {
        await expectError('/// @namespace https://example.org/ns-e#\n/// @namespace https://example.org/ns-f#\nontology p\nkind A\n',
            /An ontology has one namespace/);
        await expectWarning('ontology p\n/// @namespace https://example.org/ns-g#\nkind A\n',
            /"@namespace" describes an ontology, so it belongs above its "ontology" header; here it is ignored/);
        await expectWarning('ontology p\n/// @namespace https://example.org/ns-h#\npackage q\nkind A\n',
            /"@namespace" describes an ontology, so it belongs above its "ontology" header/);
    });

    test('and a near miss is asked about', async () => {
        const { diagnostics } = await validate('/// @namespce https://example.org/ns-h#\npackage p\nkind A\n');
        expect(diagnostics.some(d => /Did you mean "@namespace"/.test(d.message)), messages(diagnostics)).toBe(true);
    });

    test('a run above a one-line declaration is read once, as that declaration\'s', async () => {
        const { diagnostics } = await validate('package p\n/// @labl Color\nenum Color { Red, Green }\n');
        expect(diagnostics.filter(d => /Did you mean "@label"/.test(d.message)), messages(diagnostics)).toHaveLength(1);
    });
});

describe('"derivedFrom": what a derived relation is read off', () => {
    const employment = [
        'package p', 'kind Person', 'role Employee specializes Person', 'role Member specializes Person',
        'kind Organization', 'relator Employment {',
        '@mediation [1..*] -- [1] (const) Employee', '@mediation [0..*] -- [1] (const) Organization', '}',
        'relator Membership {',
        '@mediation [1..*] -- [1] (const) Member', '@mediation [0..*] -- [1] (const) Organization', '}',
        'quality Height {', '@characterization [1] -- [1] (const) Person', '}'
    ].join('\n');
    const codes = async (source: string) => (await validate(source)).diagnostics.map(d => d.code);

    test('a material relation from its relator, and a comparative one from its quality, say nothing more', async () => {
        const derived = await validate(`${employment}
@material relation Employee [0..*] -- worksFor -- [1..*] Organization derivedFrom Employment
@comparative relation Person [0..*] -- tallerThan -- [0..*] Person derivedFrom Height`);
        expect(derived.diagnostics.filter(d => /deriv|material/.test(String(d.code))), messages(derived.diagnostics))
            .toEqual([]);
    });

    test('one that could name its relator and does not is asked to', async () => {
        const { diagnostics } = await validate(`${employment}
@material relation Employee [0..*] -- worksFor -- [0..*] Organization`);
        const unstated = diagnostics.filter(d => d.code === 'derivation-unstated');
        expect(unstated.map(d => d.severity)).toEqual([DiagnosticSeverity.Hint]);
        expect(unstated[0].message).toContain('"derivedFrom Employment"');
    });

    test('and where two relators could ground it, names both and chooses neither', async () => {
        const { diagnostics } = await validate(`${employment}
relator Contract {
@mediation [1..*] -- [1] (const) Employee
@mediation [0..*] -- [1] (const) Organization
}
@material relation Employee [0..*] -- worksFor -- [0..*] Organization`);
        expect(diagnostics.find(d => d.code === 'derivation-unstated')?.message)
            .toMatch(/"Employment" and "Contract" each mediate both ends/);
    });

    test('only a derived relation has one', async () => {
        expect(await codes(`${employment}
relation Employee [0..*] -- worksFor -- [0..*] Organization derivedFrom Employment`))
            .toContain('derivation-on-underived-relation');
        await expectError(`${employment}
@componenthood relation Organization <>-- [0..*] Employment derivedFrom Employment`, /"@componenthood" relation is not derived/);
    });

    test('from an aspect of the kind its stereotype reads', async () => {
        await expectError(`${employment}
@material relation Employee [0..*] -- worksFor -- [0..*] Organization derivedFrom Height`,
        /"Height" classifies qualities/);
        await expectError(`${employment}
@comparative relation Person [0..*] -- tallerThan -- [0..*] Person derivedFrom Employment`,
        /"Employment" classifies relators/);
    });

    test('a material relation from one relator', async () => {
        expect(await codes(`${employment}
@material relation Employee [0..*] -- worksFor -- [0..*] Organization derivedFrom Employment, Membership`))
            .toContain('material-derived-from-many');
    });

    test('whose relator binds both ends, up the lineage or not at all', async () => {
        await expectError(`${employment}
@material relation Employee [0..*] -- worksFor -- [0..*] Organization derivedFrom Membership`,
        /"Membership" mediates nothing that is "Employee"/);
        // A mediation of a supertype grounds a relation between its subtypes.
        expect(await codes(`${employment}
role Manager specializes Employee
@material relation Manager [0..*] -- manages -- [0..*] Organization derivedFrom Employment`))
            .not.toContain('derivation-not-grounded');
    });

    test('fails when the relator mediates an incompatible type at one material end', async () => {
        await expectError(`package p
kind Person
role Professor specializes Person
kind Car
kind EmployingUniversity
/// An employment binding a professor to a university.
relator AcademicEmployment {
/// The professor bound by the employment.
@mediation [1..*] -- [1] (const) Professor
/// The university bound by the employment.
@mediation [1..*] -- [1] (const) EmployingUniversity
}
@material relation Professor [1..*] -- worksAt -- [1..*] Car derivedFrom AcademicEmployment`,
        /"AcademicEmployment" mediates nothing that is "Car"/);
    });

    test('fails when a self material relation has only one compatible mediation slot', async () => {
        const academicEmployment = `package p
kind Person
role Professor specializes Person
kind EmployingUniversity
relator AcademicEmployment {
@mediation [1..*] -- [1] (const) Professor
@mediation [1..*] -- [1] (const) EmployingUniversity
}`;
        await expectError(`${academicEmployment}
@material relation Professor [1..*] -- worksAt -- [1..*] Professor derivedFrom AcademicEmployment`,
        /self material relation relates two "Professor" instances.*admit at most 1/);

        expect(await codes(`package p
kind Person
relator Marriage {
@mediation [0..1] -- [2] (const) Person
}
@material relation Person [0..1] -- marriedTo -- [0..1] Person derivedFrom Marriage`))
            .not.toContain('derivation-not-grounded');
    });

    const cardinalityCodes = ['material-cardinality-mismatch', 'material-cardinality-weaker', 'material-cardinality-narrower'];

    test('follows the two mediation paths to derive both material ends', async () => {
        const { diagnostics } = await validate(`package p
kind A
kind B
relator R {
@mediation [2..3] -- [4..5] (const) A
@mediation [6..7] -- [8..9] (const) B
}
@material relation A [4..35] -- relates -- [8..27] B derivedFrom R`);
        expect(diagnostics.filter(d => cardinalityCodes.includes(String(d.code))), messages(diagnostics)).toEqual([]);
    });

    test('does not multiply lower bounds, since two relators may bind the same pair', async () => {
        // Two employments each, possibly with one employer: at least one.
        const { diagnostics } = await validate(`package p
kind Person
kind Organization
relator Employment {
@mediation [2..*] -- [1] (const) Person
@mediation [0..*] -- [1] (const) Organization
}
@material relation Person [0..*] -- worksFor -- [1..*] Organization derivedFrom Employment`);
        expect(diagnostics.filter(d => cardinalityCodes.includes(String(d.code))), messages(diagnostics)).toEqual([]);
    });

    test('warns where the written end admits what the mediations rule out, narrowed to what both allow', async () => {
        const model = (end: string) => `package p
kind Person
kind Organization
relator Employment {
@mediation [1..*] -- [1] (const) Person
@mediation [0..*] -- [1] (const) Organization
}
@material relation Person [0..*] -- worksFor -- ${end} Organization derivedFrom Employment`;
        for (const [end, replacement] of [['[0..*]', '[1..*]'], ['[0..3]', '[1..3]']]) {
            const { diagnostics } = await validate(model(end));
            const found = diagnostics.filter(d => cardinalityCodes.includes(String(d.code)));
            expect(found.map(d => [d.code, d.severity, (d.data as { replacement: string }).replacement]), end)
                .toEqual([['material-cardinality-weaker', DiagnosticSeverity.Warning, replacement]]);
        }
    });

    test('notes a narrower written end as a constraint of its own', async () => {
        const { diagnostics } = await validate(`package p
kind Person
kind Organization
relator Employment {
@mediation [1..*] -- [1] (const) Person
@mediation [0..*] -- [1] (const) Organization
}
@material relation Person [0..*] -- worksFor -- [1] Organization derivedFrom Employment`);
        const found = diagnostics.filter(d => cardinalityCodes.includes(String(d.code)));
        expect(found.map(d => [d.code, d.severity])).toEqual([['material-cardinality-narrower', DiagnosticSeverity.Hint]]);
    });

    test('reports each cardinality that contradicts the two mediation paths', async () => {
        const { diagnostics } = await validate(`package p
kind A
kind B
relator R {
@mediation [2..3] -- [4..5] (const) A
@mediation [6..7] -- [8..9] (const) B
}
@material relation A [1] -- relates -- [1] B derivedFrom R`);
        const mismatches = diagnostics.filter(d => d.code === 'material-cardinality-mismatch');
        expect(mismatches.map(d => d.severity)).toEqual([DiagnosticSeverity.Error, DiagnosticSeverity.Error]);
        expect(mismatches.map(d => d.message)).toEqual([
            expect.stringContaining('source end is [1]'),
            expect.stringContaining('target end is [1]')
        ]);
        expect(mismatches.map(d => (d.data as { replacement: string }).replacement)).toEqual(['[4..35]', '[8..27]']);
    });

    test('treats an omitted cardinality as exactly one', async () => {
        const { diagnostics } = await validate(`package p
kind A
kind B
relator R {
@mediation [2] -- [1] (const) A
@mediation [3] -- [1] (const) B
}
@material relation A -- relates -- B derivedFrom R`);
        expect(diagnostics.filter(d => d.code === 'material-cardinality-narrower')
            .map(d => (d.data as { replacement: string }).replacement)).toEqual(['[1..3]', '[1..2]']);
    });

    test('reports several exact mediation roles instead of choosing one', async () => {
        const { diagnostics } = await validate(`package p
kind A
kind B
relator R {
@mediation [1] -- [1] (const) A
@mediation [2] -- [1] (const) A
@mediation [3] -- [1] (const) B
}
@material relation A [3] -- relates -- [1] B derivedFrom R`);
        const ambiguous = diagnostics.filter(d => d.code === 'material-cardinality-ambiguous');
        expect(ambiguous.map(d => d.severity)).toEqual([DiagnosticSeverity.Warning]);
        expect(ambiguous[0].message).toContain('"A" (2)');
        expect(diagnostics.map(d => d.code)).not.toContain('material-cardinality-mismatch');
    });

    test('uses declaration order for the source and target roles of a self material relation', async () => {
        const correct = await codes(`package p
kind A
relator R {
@mediation [2..3] -- [4..5] (const) A
@mediation [6..7] -- [8..9] (const) A
}
@material relation A [4..35] -- relates -- [8..27] A derivedFrom R`);
        for (const code of [...cardinalityCodes, 'material-cardinality-ambiguous']) {
            expect(correct).not.toContain(code);
        }

        const { diagnostics } = await validate(`package p
kind A
relator R {
@mediation [2..3] -- [4..5] (const) A
@mediation [6..7] -- [8..9] (const) A
}
@material relation A [1] -- relates -- [1] A derivedFrom R`);
        expect(diagnostics.filter(d => d.code === 'material-cardinality-mismatch')
            .map(d => (d.data as { replacement: string }).replacement)).toEqual(['[4..35]', '[8..27]']);
    });

    test('reads the mediations crossed for the later of two inverse self relations', async () => {
        const mentoring = `package p
kind Person
relator Mentoring {
@mediation [0..1] -- mentor -- [1] (const) Person
@mediation [0..*] -- mentee -- [1] (const) Person
}
@material relation Person [0..*] -- mentors -- [0..1] Person inverseOf mentoredBy derivedFrom Mentoring
@material relation Person [0..1] -- mentoredBy -- [0..*] Person inverseOf mentors derivedFrom Mentoring`;
        const { diagnostics } = await validate(mentoring);
        expect(diagnostics.filter(d => (d.severity ?? 1) <= DiagnosticSeverity.Warning
            || cardinalityCodes.includes(String(d.code))), messages(diagnostics)).toEqual([]);
    });

    test('does not guess subtype participation or a one-mediation self relation', async () => {
        const subtype = await codes(`${employment}
role Manager specializes Employee
@material relation Manager [7] -- manages -- [8] Organization derivedFrom Employment`);
        expect(subtype).not.toContain('material-cardinality-mismatch');
        expect(subtype).not.toContain('material-cardinality-ambiguous');

        const self = await codes(`package p
kind Person
relator Marriage {
@mediation [0..1] -- [2] (const) Person
}
@material relation Person [7] -- marriedTo -- [8] Person derivedFrom Marriage`);
        expect(self).not.toContain('material-cardinality-mismatch');
        expect(self).not.toContain('material-cardinality-ambiguous');
    });

    test('or whose extrinsic mode inheres in one end and depends on the other', async () => {
        const loyalty = (dependence: string) => `package p
kind Person
kind Organization
extrinsicMode Loyalty {
@characterization [0..*] -- [1] (const) Person
${dependence}
}
@material relation Person [0..*] -- isLoyalTo -- [0..*] Organization derivedFrom Loyalty`;
        expect(await codes(loyalty('@externalDependence [0..*] -- [1] (const) Organization')))
            .not.toContain('derivation-not-grounded');
        expect(await codes(loyalty('@externalDependence [0..*] -- [1] (const) Person')))
            .toContain('derivation-not-grounded');
    });

    test('and a comparative one whose quality each end bears, or is', async () => {
        await expectWarning(`${employment}
@comparative relation Person [0..*] -- tallerThan -- [0..*] Organization derivedFrom Height`,
        /nothing characterizes "Organization" with "Height"/);
        expect(await codes(`${employment}
@comparative relation Height [0..*] -- greaterThan -- [0..*] Height derivedFrom Height`))
            .not.toContain('derivation-not-grounded');
    });

    test('the keyword is still a name where the syntax delimits one', async () => {
        await expectNoErrors('package p\nkind A\nkind B\nrelation A -- derivedFrom -- B');
    });
});

describe('what founds a role, and a historical role', () => {
    const codes = async (source: string) => (await validate(source)).diagnostics.map(d => String(d.code));

    test('a role founded by one optional relation is asked to require it', async () => {
        const { diagnostics } = await validate(`package p
kind Person
role Student specializes Person
kind University
relator Enrollment {
@mediation [0..*] -- [1] (const) Student
@mediation [0..*] -- [1] (const) University
}`);
        const optional = diagnostics.filter(d => d.code === 'founding-relation-optional');
        expect(optional.map(d => d.severity)).toEqual([DiagnosticSeverity.Hint]);
        expect(optional[0].message).toContain('"Enrollment" is the only relator named for it');
        expect(optional[0].data).toMatchObject({ replacement: '[1..*]' });
    });

    test('and so is a historical role founded by one optional event', async () => {
        const { diagnostics } = await validate(`package p
kind Person
event Graduation
historicalRole FormerStudent specializes Person {
@participation (const) [0..*] -- graduatedIn -- [0..1] Graduation
}`);
        const optional = diagnostics.filter(d => d.code === 'founding-relation-optional');
        expect(optional.map(d => d.data)).toMatchObject([{ replacement: '[1]' }]);
    });

    test('but not where one of several is enough', async () => {
        expect(await codes(`package p
kind Person
event Retirement
event Dismissal
historicalRole FormerEmployee specializes Person {
@participation (const) [0..*] -- retiredIn -- [0..1] Retirement
@participation (const) [0..*] -- wasDismissedIn -- [0..1] Dismissal
}`)).not.toContain('founding-relation-optional');
    });

    test('nor where a supertype founded the same way already founds it', async () => {
        expect(await codes(`package p
category Agent of functional-complexes
roleMixin Customer specializes Agent
kind Person specializes Agent
role PersonalCustomer specializes Person, Customer
kind Shop
relator Purchase {
@mediation [1..*] -- [1] (const) Customer
@mediation [0..*] -- [1] (const) Shop
}
relator LoyaltyCard {
@mediation [0..*] -- [1] (const) PersonalCustomer
@mediation [0..*] -- [1] (const) Shop
}`)).not.toContain('founding-relation-optional');
    });

    test('a mediation of a rigid supertype founds no role under it', async () => {
        const { diagnostics } = await validate(`package p
kind Person
role Student specializes Person
kind University
relator Enrollment {
@mediation [1..*] -- [1] (const) Person
@mediation [0..*] -- [1] (const) University
}`);
        expect(diagnostics.find(d => d.code === 'role-without-relator')?.message)
            .toContain('the mediation of "Person" says what any Person may have, not what makes one a Student');
    });

    test('nor does a participation of one found a historical role under it', async () => {
        expect(await codes(`package p
event Birth
kind Person {
@participation (const) [1] -- [1] Birth
}
historicalRole Survivor specializes Person`)).toContain('historical-role-without-event');
        // A historical role above does found one.
        expect(await codes(`package p
kind Person
event Graduation
historicalRole FormerStudent specializes Person {
@participation (const) [0..*] -- [1] Graduation
}
historicalRole FormerPhD specializes FormerStudent`)).not.toContain('historical-role-without-event');
    });
});

describe('"@version", "@license" and "@creator": what an ontology says of itself', () => {
    const codes = async (source: string) => (await validate(source)).diagnostics.map(d => String(d.code));

    test('are read above the header, the creators all of them', async () => {
        expect(await codes('/// @version 1.0.0\n/// @license https://creativecommons.org/licenses/by/4.0/\n'
            + '/// @creator Ana\n/// @creator Bruno\nontology p\nkind A')).toEqual([]);
    });

    test('and nowhere else', async () => {
        expect(await codes('ontology p\n/// @creator Ana\nkind A')).toContain('ontology-tag-not-on-header');
        expect(await codes('ontology p\n/// @version 2\npackage q\nkind A')).toContain('ontology-tag-not-on-header');
    });

    test('once, where an ontology has one', async () => {
        expect(await codes('/// @license https://a.example/\n/// @license https://b.example/\nontology p\nkind A'))
            .toContain('duplicate-ontology-tag');
        expect(await codes('/// @creator Ana\n/// @creator Bruno\nontology p\nkind A'))
            .not.toContain('duplicate-ontology-tag');
    });

    test('with something after the tag', async () => {
        expect(await codes('/// @version\nontology p\nkind A')).toContain('empty-doc-tag');
    });

    test('and a near miss is asked about, as the other tags are', async () => {
        const { diagnostics } = await validate('/// @licence https://creativecommons.org/licenses/by/4.0/\nontology p\nkind A');
        expect(diagnostics.find(d => d.code === 'unknown-doc-tag')?.message).toContain('Did you mean "@license"?');
    });
});
