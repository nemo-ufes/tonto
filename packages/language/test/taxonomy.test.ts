import { describe, expect, test } from 'vitest';
import {
    allowedSupertypeStereotypes, canSpecializeByStereotype, STEREOTYPES, whyNotSpecialize
} from '../src/validation/stereotype-model.js';

/**
 * The transcribed generalization table, kept as a fixture.
 *
 * These are the edges the OntoUML Visual Paradigm plugin's
 * `generalization_constraints.json` states, amended
 * where this project decided differently -- `process` treated as an endurant,
 * `historicalRole` allowed under any anti-rigid type and under `type`, and the
 * ultimate sortals closed against each other, `type` included.
 *
 * The implementation no longer holds them. `canSpecializeByStereotype`
 * computes each answer from six principles, and this asserts that the six
 * reproduce all 112 edges exactly. Provenance stays where provenance belongs;
 * an edit to a principle that would silently rewrite the taxonomy fails here
 * instead.
 */
const TRANSCRIBED: Record<string, readonly string[]> = {
    kind: ['category', 'mixin'],
    subkind: ['abstractum', 'category', 'collective', 'event', 'kind', 'mixin', 'mode', 'intrinsicMode', 'extrinsicMode', 'process', 'quality', 'quantity', 'relator', 'situation', 'subkind', 'type'],
    role: ['category', 'collective', 'historicalRole', 'historicalRoleMixin', 'kind', 'mixin', 'mode', 'intrinsicMode', 'extrinsicMode', 'phase', 'phaseMixin', 'process', 'quality', 'quantity', 'relator', 'role', 'roleMixin', 'subkind', 'type'],
    phase: ['category', 'collective', 'kind', 'mixin', 'mode', 'intrinsicMode', 'extrinsicMode', 'phase', 'phaseMixin', 'process', 'quality', 'quantity', 'relator', 'subkind', 'type'],
    category: ['category', 'mixin'],
    mixin: ['category', 'mixin'],
    collective: ['category', 'mixin'],
    quantity: ['category', 'mixin'],
    relator: ['category', 'mixin'],
    quality: ['category', 'mixin'],
    mode: ['category', 'mixin'],
    intrinsicMode: ['category', 'mixin'],
    extrinsicMode: ['category', 'mixin'],
    roleMixin: ['category', 'historicalRoleMixin', 'mixin', 'phaseMixin', 'roleMixin'],
    phaseMixin: ['category', 'mixin', 'phaseMixin'],
    historicalRole: ['category', 'collective', 'historicalRole', 'historicalRoleMixin', 'kind', 'mixin', 'mode', 'intrinsicMode', 'extrinsicMode', 'phase', 'phaseMixin', 'process', 'quality', 'quantity', 'relator', 'role', 'roleMixin', 'subkind', 'type'],
    historicalRoleMixin: ['category', 'historicalRoleMixin', 'mixin', 'phaseMixin', 'roleMixin'],
    event: ['category', 'mixin'],
    situation: ['category', 'mixin'],
    process: ['category', 'mixin'],
    type: ['category', 'mixin'],
    abstractum: ['category', 'mixin'],
};

describe('the taxonomy follows from the principles', () => {
    const stereotypes = Object.keys(STEREOTYPES).filter(name => name !== 'class');

    test.each(Object.keys(TRANSCRIBED))('%s specializes exactly what the table says', stereotype => {
        expect([...(allowedSupertypeStereotypes(stereotype) ?? [])].sort())
            .toEqual([...TRANSCRIBED[stereotype]].sort());
    });

    test('and every pair agrees, in both directions', () => {
        const disagreements = stereotypes.flatMap(sub => stereotypes
            .filter(sup => canSpecializeByStereotype(sub, sup) !== TRANSCRIBED[sub].includes(sup))
            .map(sup => `${sub} -> ${sup}`));
        expect(disagreements).toEqual([]);
    });

    test('a refusal names the principle that refuses it', () => {
        const unexplained = stereotypes.flatMap(sub => stereotypes
            .filter(sup => !canSpecializeByStereotype(sub, sup) && !whyNotSpecialize(sub, sup))
            .map(sup => `${sub} -> ${sup}`));
        expect(unexplained).toEqual([]);
    });

    test('and a bare class is constrained in neither direction', () => {
        expect(allowedSupertypeStereotypes('class')).toBeUndefined();
        expect(stereotypes.every(other => canSpecializeByStereotype('class', other)
            && canSpecializeByStereotype(other, 'class'))).toBe(true);
    });
});
