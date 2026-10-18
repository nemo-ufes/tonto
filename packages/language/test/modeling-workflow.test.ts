import { describe, expect, test } from 'vitest';
import { TontoSession } from '../src/api.js';

// A person is a student while enrolled, and a graduate because graduation happened.
const campus = `ontology campus
kind Person
kind University
role Student specializes Person
relator Enrollment {
    @mediation [1..*] -- [1] (const) Student
    @mediation [0..*] -- [1] (const) University
}
event Graduation
@participation relation Student (const) [1..*] -- graduatedIn -- [0..*] (addOnly) Graduation
historicalRole Graduate specializes Person derivedFrom Student.graduatedIn
@material relation Student [0..*] -- attends -- [1..*] University derivedFrom Enrollment
`;

describe('a model across roles, relators, events and derived relations', () => {
    test('validates before and after canonical formatting', async () => {
        const session = new TontoSession();
        expect(await session.validateText(campus)).toEqual([]);
        const formatted = await session.formatText(campus);
        expect(await session.validateText(formatted)).toEqual([]);
        expect(await session.astOf(formatted)).toEqual(await session.astOf(campus));
    });

    test('a mediation of Person does not found the Student role', async () => {
        const session = new TontoSession();
        const changed = campus.replace('(const) Student\n', '(const) Person\n');
        const difference = await session.compareText(campus, changed);
        expect(difference.introduced.map(d => d.code)).toEqual(['role-without-relator']);
        expect(difference.introduced[0].message).toContain('the mediation of "Person"');
        expect(difference.resolved).toEqual([]);
    });

    test('a graduate needs the participation that made them one', async () => {
        const session = new TontoSession();
        const unfinished = campus.replace(' derivedFrom Student.graduatedIn', '');
        const reports = await session.validateText(unfinished);
        expect(reports.map(d => d.code)).toEqual(['historical-role-without-event']);
        expect(reports[0].fixes.map(fix => fix.title)).toContain('Derive from "Student.graduatedIn"');
        const applied = await session.applyFix(unfinished, 'historical-role-without-event', 'Derive from "Student.graduatedIn"');
        expect(applied.text).toContain('historicalRole Graduate specializes Person derivedFrom Student.graduatedIn');
        expect(await session.validateText(applied.text)).toEqual([]);
    });
});
