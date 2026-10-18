import { beforeEach, describe, expect, test } from 'vitest';
import { EmptyFileSystem } from 'langium';
import { validationHelper } from 'langium/test';
import { DiagnosticSeverity } from 'vscode-languageserver';
import { createTontoServices } from '../src/tonto-module.js';
import type { Model } from '../src/generated/ast.js';
import { inOntologyInPlace } from './in-ontology.js';

const services = createTontoServices(EmptyFileSystem).Tonto;
const validateSource = validationHelper<Model>(services);
const validateDocument = (source: string): ReturnType<typeof validateSource> => validateSource(inOntologyInPlace(source));
beforeEach(async () => {
    await services.shared.workspace.DocumentBuilder.update([], services.shared.workspace.LangiumDocuments.all.map(doc => doc.uri).toArray());
});

/**
 * Every test shares one workspace, and declaring the same package name in two
 * documents is now (correctly) an error -- so each snippet gets its own
 * package name. Write `package p` in the fixture and it is rewritten to a
 * unique name here.
 */
let packageCounter = 0;
function validate(source: string): ReturnType<typeof validateDocument> {
    return validateDocument(source.replace(/\bpackage p\b/g, `package p${++packageCounter}`));
}

function messages(diagnostics: { message: string }[]): string {
    return diagnostics.map(d => d.message).join('\n');
}

describe('validation', () => {
    test('an ultimate sortal cannot specialize another ultimate sortal', async () => {
        const { diagnostics } = await validate(`
            package p
            kind A
            kind B specializes A
        `);
        expect(diagnostics.some(d => d.severity === DiagnosticSeverity.Error && /is an ultimate sortal/.test(d.message)), messages(diagnostics)).toBe(true);
    });

    test('a rigid class cannot specialize an anti-rigid class', async () => {
        const { diagnostics } = await validate(`
            package p
            kind Base
            role A specializes Base
            kind B specializes A
        `);
        expect(diagnostics.some(d => d.severity === DiagnosticSeverity.Error && /is anti-rigid/.test(d.message)), messages(diagnostics)).toBe(true);
    });

    test('a semi-rigid class (mixin) cannot specialize an anti-rigid class', async () => {
        const { diagnostics } = await validate(`
            package p
            roleMixin A
            mixin B specializes A
        `);
        expect(diagnostics.some(d => d.severity === DiagnosticSeverity.Error && /is anti-rigid/.test(d.message)), messages(diagnostics)).toBe(true);
    });

    test('a non-sortal cannot specialize a sortal', async () => {
        const { diagnostics } = await validate(`
            package p
            kind A
            category B specializes A
        `);
        expect(diagnostics.some(d => d.severity === DiagnosticSeverity.Error && /is a non-sortal/.test(d.message)), messages(diagnostics)).toBe(true);
    });

    test('a base sortal must specialize exactly one ultimate sortal', async () => {
        const { diagnostics } = await validate(`
            package p
            category A
            subkind B specializes A
        `);
        expect(diagnostics.some(d => d.severity === DiagnosticSeverity.Error && /draws identity from exactly one ultimate sortal/i.test(d.message)), messages(diagnostics)).toBe(true);
    });

    test('declaring the types nature does not exempt a base sortal from an identity supplier', async () => {
        const { diagnostics } = await validate(`
            package p
            category Meta of types
            subkind InheritedTypes specializes Meta
            subkind DeclaredTypes of types specializes Meta
        `);
        const missing = diagnostics.filter(d => d.code === 'sortal-without-ultimate-sortal');
        expect(missing, messages(diagnostics)).toHaveLength(2);
    });

    test('a high-order base sortal draws identity from an ultimate type', async () => {
        const { diagnostics } = await validate(`
            package p
            type TypeIdentity
            subkind MetaSubkind of types specializes TypeIdentity
        `);
        const errors = diagnostics.filter(d => d.severity === DiagnosticSeverity.Error);
        expect(errors, messages(errors)).toHaveLength(0);
    });

    test('a subclass may narrow a parent nature restriction (functional-complexes within objects)', async () => {
        const { diagnostics } = await validate(`
            package p
            category A of objects
            kind B of functional-complexes specializes A
        `);
        const errors = diagnostics.filter(d => d.severity === DiagnosticSeverity.Error);
        expect(errors, messages(errors)).toHaveLength(0);
    });

    test('a subclass may not widen a parent nature restriction', async () => {
        const { diagnostics } = await validate(`
            package p
            category A of functional-complexes
            category B of functional-complexes, collectives specializes A
        `);
        expect(diagnostics.some(d => d.severity === DiagnosticSeverity.Error && /not compatible with/i.test(d.message)), messages(diagnostics)).toBe(true);
    });

    describe('ontological nature consistency', () => {
        test('rejects supertypes whose natures have nothing in common', async () => {
            // The reported case: a Spouse would have to be both a functional
            // complex and a relator at once.
            const { diagnostics } = await validate(`
                package p
                kind Person
                category SocialRelator of relators
                role Spouse specializes Person, SocialRelator
            `);
            expect(diagnostics.some(d => d.severity === DiagnosticSeverity.Error && /nothing in common/i.test(d.message)), messages(diagnostics)).toBe(true);
        });

        test('catches it when the generalization comes from a generalization set', async () => {
            const { diagnostics } = await validate(`
                package p
                kind Person
                category SocialRelator of relators
                role Spouse specializes Person
                genset G where Spouse specializes SocialRelator
            `);
            expect(diagnostics.some(d => d.severity === DiagnosticSeverity.Error && /nothing in common/i.test(d.message)), messages(diagnostics)).toBe(true);
        });

        test('rejects a stereotype whose identity principle contradicts what it inherits', async () => {
            // A kind's instances are functional complexes; this one inherits relators.
            const { diagnostics } = await validate(`
                package p
                category R of relators
                kind K specializes R
            `);
            expect(diagnostics.some(d => d.severity === DiagnosticSeverity.Error && /inherits relators/i.test(d.message)), messages(diagnostics)).toBe(true);
        });

        test('rejects an event specializing an endurant type', async () => {
            const { diagnostics } = await validate(`
                package p
                category Endurants of functional-complexes
                subkind E specializes Endurants
            `);
            expect(diagnostics.some(d => d.severity === DiagnosticSeverity.Error), messages(diagnostics)).toBe(true);
        });

        test('rejects an "of" clause diverging from an inherited nature', async () => {
            // The parent declares nothing; its nature comes from being a kind.
            const { diagnostics } = await validate(`
                package p
                kind Person
                subkind S of collectives specializes Person
            `);
            expect(diagnostics.some(d => d.severity === DiagnosticSeverity.Error && /not compatible with/i.test(d.message)), messages(diagnostics)).toBe(true);
        });

        test('accepts compatible supertypes', async () => {
            const { diagnostics } = await validate(`
                package p
                kind Person
                category Agent of functional-complexes
                role Employee specializes Person, Agent
            `);
            const errors = diagnostics.filter(d => d.severity === DiagnosticSeverity.Error);
            expect(errors, messages(errors)).toHaveLength(0);
        });

        test('accepts a supertype that constrains nothing', async () => {
            const { diagnostics } = await validate(`
                package p
                kind Person
                category Consumer
                role Buyer specializes Person, Consumer
            `);
            const errors = diagnostics.filter(d => d.severity === DiagnosticSeverity.Error);
            expect(errors, messages(errors)).toHaveLength(0);
        });
    });

    test('a datatype nature can only be restricted to abstract-individuals', async () => {
        const { diagnostics } = await validate(`
            package p
            datatype D of events
        `);
        expect(diagnostics.some(d => d.severity === DiagnosticSeverity.Error && /classifies abstract individuals/i.test(d.message)), messages(diagnostics)).toBe(true);
    });

    test('flags duplicate declaration names within a package', async () => {
        const { diagnostics } = await validate(`
            package p
            kind A
            category A
        `);
        expect(diagnostics.some(d => d.severity === DiagnosticSeverity.Error && /Duplicate declaration name/i.test(d.message)), messages(diagnostics)).toBe(true);
    });

    test('flags circular specialization', async () => {
        const { diagnostics } = await validate(`
            package p
            category A specializes B
            category B specializes A
        `);
        expect(diagnostics.some(d => d.severity === DiagnosticSeverity.Error && /a cycle, so each would have to be a subtype/i.test(d.message)), messages(diagnostics)).toBe(true);
    });

    test('flags a relation end that subsets itself', async () => {
        const { diagnostics } = await validate(`
            package p
            kind A {
                [1] -- rel -- [1] (x subsets A.x) A
            }
        `);
        expect(diagnostics.some(d => d.severity === DiagnosticSeverity.Error && /cannot subset itself/i.test(d.message)), messages(diagnostics)).toBe(true);
    });

    test('resolves subsets against a named relation end, not the whole relation', async () => {
        const { diagnostics } = await validate(`
            package p
            kind A
            collective B {
                @membership [1..*] <>-- [2..*] (members) A
            }
            subkind C specializes B {
                @membership [1..*] <>-- [2..*] (members subsets B.members) A
            }
        `);
        const errors = diagnostics.filter(d => d.severity === DiagnosticSeverity.Error);
        expect(errors, messages(errors)).toHaveLength(0);
    });

    test('requires entirely lowercase package names, a segment at a time', async () => {
        for (const [name, expected] of [['Upper', 'upper'], ['core.People', 'core.people'], ['Core.people', 'core.people'], ['core.someThing', 'core.something']]) {
            // Under a header, so that the package stays a package.
            const { diagnostics } = await validate(`
                ontology names
                package ${name}
                kind A
            `);
            expect(diagnostics.some(d => d.severity === DiagnosticSeverity.Warning
                && d.code === 'package-name-case' && d.message.includes(`write "${expected}"`)), messages(diagnostics)).toBe(true);
        }
        const { diagnostics } = await validate('package core.people\nkind A\n');
        expect(diagnostics.filter(d => /package name/i.test(d.message)), messages(diagnostics)).toEqual([]);
    });

    test('a clean model produces no error diagnostics', async () => {
        const { diagnostics } = await validate(`
            package clean
            category Organization of functional-complexes
            kind Company specializes Organization
        `);
        const errors = diagnostics.filter(d => d.severity === DiagnosticSeverity.Error);
        expect(errors, messages(errors)).toHaveLength(0);
    });
});
