import { beforeEach, describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { validationHelper } from 'langium/test';
import { createTontoServices } from '../src/tonto-module.js';
import type { Model } from '../src/generated/ast.js';
import { inOntologyInPlace } from './in-ontology.js';

const shared = createTontoServices(EmptyFileSystem).shared;
const services = shared.ServiceRegistry.all[0] as ReturnType<typeof createTontoServices>['tonto'];
const validateSource = validationHelper<Model>(services);
const validateDocument = (source: string): ReturnType<typeof validateSource> => validateSource(inOntologyInPlace(source));
beforeEach(async () => {
    await shared.workspace.DocumentBuilder.update([], shared.workspace.LangiumDocuments.all.map(doc => doc.uri).toArray());
});

// Anti-patterns are off unless `tonto.antiPatterns` is set, which is what an
// editor sends on startup and on every change to the setting.
shared.workspace.ConfigurationProvider.updateConfiguration({ settings: { tonto: { antiPatterns: true } } });

let packageCounter = 0;
function validate(source: string): ReturnType<typeof validateDocument> {
    return validateDocument(source.replace(/\bpackage p\b/g, `package p${++packageCounter}`));
}

async function codes(source: string): Promise<string[]> {
    const { diagnostics } = await validate(source);
    return diagnostics.map(d => d.code).filter((c): c is string => typeof c === 'string');
}

describe('anti-patterns are off unless asked for', () => {
    test('a fresh server reports none of them', async () => {
        // A separate server, so the setting above does not reach it.
        const quiet = createTontoServices(EmptyFileSystem).Tonto;
        const { diagnostics } = await validationHelper<Model>(quiet)(`
            package quiet
            kind Person
            role Employee specializes Person
            role Manager specializes Person
            relation Manager [1] -- manages -- [0..*] Employee
        `);
        expect(diagnostics.map(d => d.code)).not.toContain('BinOver');
    });

    test('and reports them once the setting arrives', async () => {
        const loud = createTontoServices(EmptyFileSystem);
        loud.shared.workspace.ConfigurationProvider.updateConfiguration({ settings: { tonto: { antiPatterns: true } } });
        const { diagnostics } = await validationHelper<Model>(loud.Tonto)(`
            package loud
            kind Person
            role Employee specializes Person
            role Manager specializes Person
            relation Manager [1] -- manages -- [0..*] Employee
        `);
        expect(diagnostics.map(d => d.code)).toContain('BinOver');
    });
});

describe('anti-patterns (Sales & Guizzardi 2015)', () => {
    test('BinOver: relation between a type and itself', async () => {
        expect(await codes(`
            package p
            kind Person { [0..*] -- knows -- [0..*] Person }
        `)).toContain('BinOver');
    });

    test('BinOver: relation between two roles of the same kind', async () => {
        expect(await codes(`
            package p
            kind Person
            role Buyer specializes Person
            role Seller specializes Person
            relation Buyer -- buysFrom -- [1] Seller
        `)).toContain('BinOver');
    });

    test('BinOver: not reported when a disjoint genset separates the roles', async () => {
        expect(await codes(`
            package p
            kind Person
            role Buyer specializes Person
            role Seller specializes Person
            disjoint genset Parties where Buyer, Seller specializes Person
            relation Buyer -- buysFrom -- [1] Seller
        `)).not.toContain('BinOver');
    });

    test('BinOver: not reported for unrelated kinds', async () => {
        expect(await codes(`
            package p
            kind Person
            kind Car
            relation Person -- owns -- [0..*] Car
        `)).not.toContain('BinOver');
    });

    test('ImpAbs: many-end on a class with two or more subtypes', async () => {
        expect(await codes(`
            package p
            kind Person
            kind Vehicle
            subkind Car specializes Vehicle
            subkind Truck specializes Vehicle
            relation Person -- owns -- [0..*] Vehicle
        `)).toContain('ImpAbs');
    });

    test('ImpAbs: not reported when the many-end class has no subtypes', async () => {
        expect(await codes(`
            package p
            kind Person
            kind Vehicle
            relation Person -- owns -- [0..*] Vehicle
        `)).not.toContain('ImpAbs');
    });

    test('RelSpec: a relation duplicating a more general one', async () => {
        expect(await codes(`
            package p
            kind Person
            kind Vehicle
            role Driver specializes Person
            relation Person -- uses -- [0..*] Vehicle
            relation Driver -- drives -- [0..*] Vehicle
        `)).toContain('RelSpec');
    });

    test('RelSpec: not reported when the relation already specializes', async () => {
        expect(await codes(`
            package p
            kind Person
            kind Vehicle
            role Driver specializes Person
            relation Person -- uses -- [0..*] Vehicle
            relation Driver -- drives -- [0..*] Vehicle specializes Person.uses
        `)).not.toContain('RelSpec');
    });

    test('RelSpec: nor when an end already subsets or redefines', async () => {
        // Overriding an end implies the specialization, so "consider whether
        // it should subset" was advice to do what the model already does.
        expect(await codes(`
            package p
            kind Person
            kind Team {
                -- [0..*] (staff) Person
            }
            subkind Club specializes Team {
                -- [0..*] (subsets Team.staff) Person
            }
        `)).not.toContain('RelSpec');
    });

    test('RelOver: relator mediating two overlapping roles', async () => {
        expect(await codes(`
            package p
            kind Person
            role Buyer specializes Person
            role Seller specializes Person
            relator Deal {
                @mediation [1..*] -- [1..*] Buyer
                @mediation [1..*] -- [1..*] Seller
            }
        `)).toContain('RelOver');
    });

    test('RelOver: not reported when the mediated types are disjoint', async () => {
        expect(await codes(`
            package p
            kind Person
            role Buyer specializes Person
            role Seller specializes Person
            disjoint genset Parties where Buyer, Seller specializes Person
            relator Deal {
                @mediation [1..*] -- [1..*] Buyer
                @mediation [1..*] -- [1..*] Seller
            }
        `)).not.toContain('RelOver');
    });

    test('RepRel: every mediation admits more than one relator', async () => {
        expect(await codes(`
            package p
            kind Person
            kind Company
            relator Employment {
                @mediation [0..*] -- [1] Person
                @mediation [0..*] -- [1] Company
            }
        `)).toContain('RepRel');
    });

    test('RepRel: not reported when a relator end is restricted to one', async () => {
        expect(await codes(`
            package p
            kind Person
            kind Company
            relator Employment {
                @mediation [1] -- [1] Person
                @mediation [1] -- [1] Company
            }
        `)).not.toContain('RepRel');
    });

    test('AssocCyc: three associations forming a cycle', async () => {
        expect(await codes(`
            package p
            kind A
            kind B
            kind C
            relation A -- ab -- [1] B
            relation B -- bc -- [1] C
            relation C -- ca -- [1] A
        `)).toContain('AssocCyc');
    });

    test('AssocCyc: not reported for only two associations', async () => {
        // A two-association cycle is RelSpec/RelOver territory, per the paper.
        expect(await codes(`
            package p
            kind A
            kind B
            relation A -- ab -- [1] B
            relation A -- ab2 -- [1] B
        `)).not.toContain('AssocCyc');
    });

    test('AssocCyc: not reported for a diamond of generalizations', async () => {
        // A -> B, A -> C, B -> D, C -> D is a genuine undirected cycle, but it
        // contains no associations at all, so it is a plain hierarchy.
        expect(await codes(`
            package p
            kind A
            subkind B specializes A
            subkind C specializes A
            subkind D specializes B, C
        `)).not.toContain('AssocCyc');
    });

    test('AssocCyc: a cycle padded with generalizations still needs 3 associations', async () => {
        // Two associations closed by a generalization edge: excluded.
        expect(await codes(`
            package p
            kind A
            subkind B specializes A
            kind C
            relation A -- ac -- [1] C
            relation C -- cb -- [1] B
        `)).not.toContain('AssocCyc');
    });

    test('AssocCyc: excludes the relator design pattern', async () => {
        // relator mediates Buyer and Seller, which a material relation joins:
        // a legitimate closed cycle, since the material relation is derived.
        expect(await codes(`
            package p
            kind Person
            role Buyer specializes Person
            role Seller specializes Person
            relator Deal {
                @mediation [1] -- [1] Buyer
                @mediation [1] -- [1] Seller
            }
            @material relation Buyer -- tradesWith -- [1] Seller
        `)).not.toContain('AssocCyc');
    });

    test('AssocCyc: ignores derived relations, which say what they are derived from', async () => {
        const model = (derivation: string) => `
            package p
            category Sized of functional-complexes
            kind A specializes Sized
            kind B
            kind C specializes Sized
            quality Size {
                @characterization [1] -- [1] (const) Sized
            }
            relation A -- ab -- [1] B
            relation B -- bc -- [1] C
            @comparative relation C -- ca -- [1] A${derivation}
        `;
        expect(await codes(model(' derivedFrom Size'))).toEqual([]);
        // Derived or not, the language cannot tell until the model says so.
        expect(await codes(model(''))).toContain('AssocCyc');
    });

    test('AssocCyc: ignores associations with a derived end', async () => {
        expect(await codes(`
            package p
            kind A
            kind B
            kind C
            relation A -- ab -- [1] B
            relation B -- bc -- [1] C
            relation C -- [1] (derived back) A
        `)).not.toContain('AssocCyc');
    });

    test('AssocCyc: reports a cycle only once', async () => {
        const found = (await codes(`
            package p
            kind A
            kind B
            kind C
            relation A -- ab -- [1] B
            relation B -- bc -- [1] C
            relation C -- ca -- [1] A
        `)).filter(c => c === 'AssocCyc');
        expect(found).toHaveLength(1);
    });

    test('DepPhase: a phase a relator mediates is a role', async () => {
        expect(await codes(`
            package p
            kind Person
            phase Employed specializes Person
            phase Unemployed specializes Person
            disjoint complete genset stages where Employed, Unemployed specializes Person
            kind Organization
            relator Employment {
                @mediation [1..*] -- [1] (const) Employed
                @mediation [0..*] -- [1] (const) Organization
            }
        `)).toContain('DepPhase');
    });

    test('DepPhase: and a phase that holds by a condition is left alone', async () => {
        expect(await codes(`
            package p
            kind Person
            phase Child specializes Person
            phase Adult specializes Person
            disjoint complete genset stages where Child, Adult specializes Person
        `)).not.toContain('DepPhase');
    });

    test('MixIden: a non-sortal over one identity says nothing a sortal cannot', async () => {
        expect(await codes(`
            package p
            kind Person
            category Human of functional-complexes
            subkind Man specializes Person, Human
            subkind Woman specializes Person, Human
        `)).toContain('MixIden');
    });

    test('MixIden: two kinds under it is what a non-sortal is for', async () => {
        expect(await codes(`
            package p
            kind Person
            kind Organization
            category Party of functional-complexes
            subkind Client specializes Person, Party
            subkind Firm specializes Organization, Party
        `)).not.toContain('MixIden');
    });

    test('HetColl: members typed by a non-sortal may be of different kinds', async () => {
        expect(await codes(`
            package p
            kind Person
            kind Organization
            category Party of functional-complexes
            subkind Client specializes Person, Party
            subkind Firm specializes Organization, Party
            collective Crowd {
                @membership [0..*] <>-- [2..*] (members) Party
            }
        `)).toContain('HetColl');
        expect(await codes(`
            package p
            kind Person
            collective Crowd {
                @membership [0..*] <>-- [2..*] (members) Person
            }
        `)).not.toContain('HetColl');
    });

    test('anti-patterns are advisory, never errors', async () => {
        const { diagnostics } = await validate(`
            package p
            kind Person { [0..*] -- knows -- [0..*] Person }
        `);
        const errors = diagnostics.filter(d => d.severity === 1);
        expect(errors.map(d => d.message)).toHaveLength(0);
        expect(diagnostics.some(d => d.code === 'BinOver' && d.severity === 3)).toBe(true);
    });
});
