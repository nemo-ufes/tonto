import { describe, expect, test } from 'vitest';
import { RELATION_NATURE_TABLE } from '../src/validation/relation-nature-table.js';
import { NATURE_ATOMS } from '../src/validation/natures.js';
import { TRANSCRIBED } from './relation-ends.fixture.js';
import { EmptyFileSystem } from 'langium';
import { parseHelper } from 'langium/test';
import { isClassDeclaration } from '../src/generated/ast.js';
import type { ClassDeclaration, Model, Package, Relation } from '../src/generated/ast.js';
import { createTontoServices } from '../src/tonto-module.js';

const services = createTontoServices(EmptyFileSystem).Tonto;
const parseDocument = parseHelper<Model>(services);

// See validation.test.ts: one shared workspace, so each snippet needs its own
// package name for the duplicate-package-across-files check not to fire.
let packageCounter = 0;
function parse(source: string, options?: Parameters<typeof parseDocument>[1]): ReturnType<typeof parseDocument> {
    return parseDocument(source.replace(/\bpackage p\b/g, `package p${++packageCounter}`), options);
}

function classOf(pkg: Package, name: string): ClassDeclaration {
    const found = pkg.declarations.find(d => d.name === name);
    if (!found || !isClassDeclaration(found)) {
        throw new Error(`no class ${name}`);
    }
    return found;
}

function onlyRelation(classDeclaration: ClassDeclaration): Relation {
    expect(classDeclaration.relations).toHaveLength(1);
    return classDeclaration.relations[0];
}

/**
 * These assert on the resolved cross-reference (`.ref`), not merely on the
 * absence of diagnostics -- an unresolved reference and a reference that was
 * never checked look identical from a diagnostics-only assertion.
 */
describe('subsetting and redefinition target association ends', () => {
    test('subsets resolves to the named end of the subset relation', async () => {
        const document = await parse(`
            package p
            kind Person
            kind Staff {
                @membership [1..*] <>-- [2..*] (members) Person
            }
            role SeniorStaff specializes Staff {
                @membership [1..*] <>-- [2..*] (seniorMembers subsets Staff.members) Person
            }
        `, { validation: true });

        const pkg = document.parseResult.value.packages[0];
        const staffEnd = onlyRelation(classOf(pkg, 'Staff')).targetMeta;
        const seniorEnd = onlyRelation(classOf(pkg, 'SeniorStaff')).targetMeta;

        expect(staffEnd?.name).toBe('members');
        const subsets = seniorEnd?.subsets;
        expect(subsets?.error, subsets?.error?.message).toBeUndefined();
        // The reference resolves to the *end* node, not to the relation.
        expect(subsets?.ref).toBe(staffEnd);
    });

    test('redefines resolves the same way', async () => {
        const document = await parse(`
            package p
            kind Person
            role Executive specializes Person
            kind Organization {
                @membership [1..*] <>-- [2..*] (members) Person
            }
            subkind PremiumOrganization specializes Organization {
                @membership [1..*] <>-- [2..*] (members redefines Organization.members) Executive
            }
        `, { validation: true });

        const pkg = document.parseResult.value.packages[0];
        const orgEnd = onlyRelation(classOf(pkg, 'Organization')).targetMeta;
        const premiumEnd = onlyRelation(classOf(pkg, 'PremiumOrganization')).targetMeta;

        const redefines = premiumEnd?.redefines;
        expect(redefines?.error, redefines?.error?.message).toBeUndefined();
        expect(redefines?.ref).toBe(orgEnd);
    });

    test('a source-side end name is a property of the target classifier', async () => {
        // The end adjacent to `Staff` is a property of `Employee`, so it is
        // referenced as `Employee.employer`, not `Staff.employer`.
        const document = await parse(`
            package p
            kind Person
            kind Staff {
                (employer) [1] -- [2..*] Person
            }
            kind Contractor {
                [1] -- [2..*] (sub subsets Person.employer) Person
            }
        `, { validation: true });

        const pkg = document.parseResult.value.packages[0];
        const sourceEnd = onlyRelation(classOf(pkg, 'Staff')).sourceMeta;
        expect(sourceEnd?.name).toBe('employer');

        const subsets = onlyRelation(classOf(pkg, 'Contractor')).targetMeta?.subsets;
        expect(subsets?.error, subsets?.error?.message).toBeUndefined();
        expect(subsets?.ref).toBe(sourceEnd);
    });

    test('a source-side end name resolves plainly from a subclass of its owner', async () => {
        // `employer`'s true owner is `Person`, the *target* of `Staff`'s
        // relation, not `Staff` whose body holds it -- so a class that
        // specializes `Person` has to reach `employer` by its bare name too,
        // even though the relation naming it is declared somewhere else
        // entirely (`Staff`, not `Person` or anything under it).
        const document = await parse(`
            package p
            kind Person
            kind Staff {
                (employer) [1] -- [2..*] Person
            }
            subkind Employer specializes Person {
                [1] -- [2..*] (sub subsets employer) Staff
            }
        `, { validation: true });

        const pkg = document.parseResult.value.packages[0];
        const sourceEnd = onlyRelation(classOf(pkg, 'Staff')).sourceMeta;
        expect(sourceEnd?.name).toBe('employer');

        const subsets = onlyRelation(classOf(pkg, 'Employer')).targetMeta?.subsets;
        expect(subsets?.error, subsets?.error?.message).toBeUndefined();
        expect(subsets?.ref).toBe(sourceEnd);
    });

    test('a target-side end named on an external relation resolves plainly from a subclass', async () => {
        // `members` is declared via a package-level `relation`, never inside
        // any class body -- so a subclass of `Staff` reaching it by bare name
        // has nothing in its own ancestry's `relations` field to find at all.
        const document = await parse(`
            package p
            kind Employee
            kind Staff
            relation Staff <>-- [2..*] (members) Employee
            subkind SpecialStaff specializes Staff {
                @componenthood [0..*] <>-- [2..*] (execs subsets members) Employee
            }
        `, { validation: true });

        const pkg = document.parseResult.value.packages[0];
        const external = pkg.declarations.find(d => d.$type === 'ExternalRelation') as Relation | undefined;
        expect(external?.targetMeta?.name).toBe('members');

        const subsets = onlyRelation(classOf(pkg, 'SpecialStaff')).targetMeta?.subsets;
        expect(subsets?.error, subsets?.error?.message).toBeUndefined();
        expect(subsets?.ref).toBe(external?.targetMeta);
    });

    test('a relation cannot be used where an end is expected', async () => {
        // `Staff.membership` names the *relation*, not an end, so it must not
        // resolve for `subsets` -- this is the UML rule the grammar enforces
        // structurally via the cross-reference type.
        const document = await parse(`
            package p
            kind Person
            kind Staff {
                @membership [1..*] <>-- membership -- [2..*] Person
            }
            role SeniorStaff specializes Staff {
                @membership [1..*] <>-- [2..*] (x subsets Staff.membership) Person
            }
        `, { validation: true });

        const pkg = document.parseResult.value.packages[0];
        const subsets = onlyRelation(classOf(pkg, 'SeniorStaff')).targetMeta?.subsets;
        expect(subsets?.ref).toBeUndefined();
        expect(subsets?.error).toBeDefined();
    });

    test('an end can subset an end of a relation in an imported package', async () => {
        const services = createTontoServices(EmptyFileSystem);
        const parseLocal = parseHelper<Model>(services.Tonto);
        await parseLocal(`
            package base in relationends
            kind Person
            kind Staff {
                @membership [1..*] <>-- [2..*] (members) Person
            }
        `);
        const document = await parseLocal(`
            use base
            package seniority in relationends
            role SeniorStaff specializes base.Staff {
                @membership [1..*] <>-- [2..*] (seniors subsets base.Staff.members) base.Employee
            }
        `, { validation: true });

        const pkg = document.parseResult.value.packages[0];
        const subsets = onlyRelation(classOf(pkg, 'SeniorStaff')).targetMeta?.subsets;
        expect(subsets?.error, subsets?.error?.message).toBeUndefined();
        expect(subsets?.ref).toBeDefined();
    });

    test('and names it plainly, when the relation is written beside the ancestor', async () => {
        // `employer`'s owner is `Person`, but the relation naming it sits in
        // `Staff` -- beside `Person` in its own package, and nowhere near the
        // package doing the subsetting. An inherited end is named plainly
        // across files as within one, so the ancestor's *package* has to be
        // searched, not only the ancestor's own body and the referring one.
        const services = createTontoServices(EmptyFileSystem);
        const parseLocal = parseHelper<Model>(services.Tonto);
        await parseLocal(`
            package base in relationends
            kind Person
            kind Staff {
                (employer) [1] -- [2..*] Person
            }
        `);
        const document = await parseLocal(`
            use base
            package seniority in relationends
            subkind Employer specializes base.Person {
                [1] -- [1] (sub subsets employer) base.Staff
            }
        `, { validation: true });

        const pkg = document.parseResult.value.packages[0];
        const subsets = onlyRelation(classOf(pkg, 'Employer')).targetMeta?.subsets;
        expect(subsets?.error, subsets?.error?.message).toBeUndefined();
        expect(subsets?.ref).toBeDefined();
    });
});

describe('a diamond at each end of one relation', () => {
    // Both markers on one relation used to have no shape in `RelationNotation`
    // at all, so the parser matched the first marker as a complete relation
    // with no target and started a second, unrelated one from whatever
    // followed -- see the grammar comment on `RelationNotation`. It parses as
    // one relation now, with both flags set, which `checkDiamondMarksOneEndOnly`
    // reports.
    test('parses as one relation with both whole-part flags set', async () => {
        const document = await parse(`
            package p
            kind A
            kind B
            kind W {
                <>-- named --<> [1] B
            }
        `);

        const pkg = document.parseResult.value.packages[0];
        const relations = classOf(pkg, 'W').relations;
        expect(relations).toHaveLength(1);
        const [relation] = relations;
        expect(relation.isAggregation).toBe(true);
        expect(relation.isAggregationInverted).toBe(true);
        expect(relation.name).toBe('named');
        expect(relation.target?.ref).toBe(classOf(pkg, 'B'));
    });

    test('the bare form parses the same way, with no name', async () => {
        const document = await parse(`
            package p
            kind A
            kind B
            kind W {
                <>-- --<> [1] B
            }
        `);

        const pkg = document.parseResult.value.packages[0];
        const [relation] = classOf(pkg, 'W').relations;
        expect(relation.isAggregation).toBe(true);
        expect(relation.isAggregationInverted).toBe(true);
        expect(relation.name).toBeUndefined();
    });
});

describe('the end-nature table follows from the category signatures', () => {
    test('every stereotype admits exactly the transcribed pairs', () => {
        const derived = Object.fromEntries(Object.entries(RELATION_NATURE_TABLE)
            .map(([name, pairs]) => [name, [...pairs].sort()]));
        const transcribed = Object.fromEntries(Object.entries(TRANSCRIBED)
            .map(([name, pairs]) => [name, [...pairs].sort()]));
        expect(derived).toEqual(transcribed);
    });

    test('and the stereotypes are exactly those with a signature', () => {
        expect(Object.keys(RELATION_NATURE_TABLE).sort()).toEqual(Object.keys(TRANSCRIBED).sort());
    });

    test('external dependence reaches everything in time that is not over', () => {
        // The rule, not the list: an extrinsic mode depends on what is still
        // there to be depended on. An event is excluded because dependence on
        // what has already happened is historical; an abstract individual
        // because it exists atemporally, which would trivialize the
        // dependence. A concrete sort added to the language belongs here on
        // the same terms, so this is written as the subtraction rather than
        // as the eight natures that pass it today.
        const reached = new Set((RELATION_NATURE_TABLE.externalDependence ?? [])
            .map(pair => pair.split(':')[1]));
        const inTime = Object.values(NATURE_ATOMS)
            .filter(nature => nature.sort !== 'abstract')
            .map(nature => nature.table);
        expect([...reached].sort()).toEqual(inTime.filter(nature => nature !== 'event').sort());
        // And it runs from an extrinsic mode alone.
        expect([...new Set((RELATION_NATURE_TABLE.externalDependence ?? [])
            .map(pair => pair.split(':')[0]))]).toEqual(['extrinsic-mode']);
        // What it leaves out, historical dependence takes: the past does not
        // have to still be there to have happened.
        expect(RELATION_NATURE_TABLE.historicalDependence).toContain('extrinsic-mode:event');
    });
});
