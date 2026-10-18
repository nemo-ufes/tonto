import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TontoSession } from '../out/api.js';
import { catalog } from '../out/cli/patterns.js';

const robotJar = process.env.ROBOT_JAR;
if (!robotJar) {
    throw new Error('Set ROBOT_JAR to the ROBOT executable jar (tested with ROBOT 1.9.10).');
}

// Optional: the pySHACL command, to load each shapes graph (section 18).
const pyshacl = process.env.PYSHACL;

const here = fileURLToPath(new URL('.', import.meta.url));
const fixture = join(here, 'fixtures', 'gufo-1.0.0.ttl');
const catalogFile = join(here, 'fixtures', 'catalog-v001.xml');
const work = mkdtempSync(join(tmpdir(), 'tonto-gufo-conformance-'));
copyFileSync(fixture, join(work, basename(fixture)));
copyFileSync(catalogFile, join(work, basename(catalogFile)));
writeFileSync(join(work, 'empty.ttl'), '');

function robot(...args) {
    const run = spawnSync('java', ['-jar', robotJar, ...args], {
        encoding: 'utf8', maxBuffer: 16 * 1024 * 1024
    });
    if (run.status !== 0) {
        throw new Error(`ROBOT ${args[0]} failed.\n${run.stdout}${run.stderr}`);
    }
}

// Constructs no published pattern reaches, each of which once broke the
// OWL 2 DL profile.
const regressions = [
    {
        name: 'bounded-range',
        model: 'kind Car {\n    code: const string [1..2]\n    @componenthood [1] <>-- [2..4] (const) Wheel\n}\nkind Wheel\n'
    },
    {
        // A relational condition written as a union (section 10.1).
        name: 'founded-by-either',
        model: 'kind Person\nevent Retirement\nevent Dismissal\nhistoricalRole FormerEmployee specializes Person {\n'
            + '    @participation (const) [0..*] -- retiredIn -- [0..1] Retirement\n'
            + '    @participation (const) [0..*] -- wasDismissedIn -- [0..1] Dismissal\n}\n'
    },
    {
        // Participation carried up event parthood, on gufo:participatedIn itself (section 10.2).
        name: 'participation-upward',
        model: 'kind Person\nevent Conference {\n    @structural (const) [1] <>-- [2..*] (const) Meeting\n}\n'
            + 'event Meeting {\n    @participational (const) [1] <>-- [2..*] (const) AttendeeParticipation\n}\n'
            + 'event AttendeeParticipation\n'
            + '@participation relation Person (const) [1] -- attended -- [0..*] (const) AttendeeParticipation\n'
            + 'historicalRole Attendee specializes Person {\n'
            + '    @participation (const) [1] -- attendedAs -- [1..*] (const) AttendeeParticipation\n}\n'
    }
];

// A documented, licensed package, so that the header ROBOT's report reads is
// the one a documented model exports.
const header = name => `/// The "${name}" pattern, as the conformance suite exports it.\n`
    + `/// @label ${name}\n/// @license https://creativecommons.org/licenses/by/4.0/\n`;

let complete = false;
try {
    const session = new TontoSession();
    for (const pattern of [...await catalog(), ...regressions]) {
        const namespace = `https://example.org/tonto-patterns/${encodeURIComponent(pattern.name)}#`;
        const source = `${header(pattern.name)}/// @namespace ${namespace}\nontology pattern\n${pattern.model}`;
        const first = await session.gufoText(source, {}, pattern.name);
        const second = await session.gufoText(source, {}, `${pattern.name}-repeat`);
        const errors = first.diagnostics.filter(entry => entry.severity === 'error');
        if (errors.length > 0) {
            throw new Error(`${pattern.name} did not export:\n${JSON.stringify(errors, undefined, 2)}`);
        }
        if (first.turtle !== second.turtle) {
            throw new Error(`${pattern.name} did not export deterministically.`);
        }

        const stem = pattern.name.replace(/[^A-Za-z0-9_.-]/g, '_');
        const ontology = join(work, `${stem}.ttl`);
        const profile = join(work, `${stem}-profile.txt`);
        writeFileSync(ontology, first.turtle);
        robot('validate-profile', '--profile', 'DL', '--catalog', join(work, 'catalog-v001.xml'),
            '--input', ontology, '--output', profile);
        const report = readFileSync(profile, 'utf8');
        if (!report.includes('Ontology and imports closure in profile')) {
            throw new Error(`${pattern.name} is outside OWL 2 DL:\n${report}`);
        }
        robot('reason', '--reasoner', 'hermit', '--catalog', join(work, 'catalog-v001.xml'),
            '--input', ontology, '--output', join(work, `${stem}-reasoned.owl`));
        // ROBOT's quality report: labels, header metadata, and the rest of
        // its default profile. Its warnings are OBO conventions -- an
        // IAO definition on every term -- that a gUFO model does not follow.
        robot('report', '--catalog', join(work, 'catalog-v001.xml'), '--input', ontology,
            '--fail-on', 'ERROR', '--output', join(work, `${stem}-report.tsv`));

        // The snapshot layer (section 18): the core must come out byte for
        // byte the same, and the module, with the core it imports, must be
        // OWL 2 DL, consistent and coherent. A cardinality restriction on a
        // property a chain implies is the way it could fail. ROBOT's report is
        // not run on it: the module mentions terms whose labels are in the
        // core, and the report reads one ontology.
        const layered = await session.gufoText(source, { snapshot: true }, `${pattern.name}-snapshot`);
        const core = layered.files.find(file => !file.snapshot);
        const module = layered.files.find(file => file.snapshot && !file.shapes);
        const shapes = layered.files.find(file => file.shapes);
        if (!core || !module || core.content !== first.turtle) {
            throw new Error(`${pattern.name}: asking for the snapshot layer changed the core ontology.`);
        }
        const moduleFile = join(work, `${stem}.snapshot.ttl`);
        writeFileSync(moduleFile, module.content);
        const moduleCatalog = join(work, `${stem}-catalog.xml`);
        writeFileSync(moduleCatalog, readFileSync(join(work, 'catalog-v001.xml'), 'utf8').replace('</catalog>',
            `  <uri name="${core.ontology}" uri="${stem}.ttl"/>\n</catalog>`));
        const moduleProfile = join(work, `${stem}-snapshot-profile.txt`);
        robot('validate-profile', '--profile', 'DL', '--catalog', moduleCatalog,
            '--input', moduleFile, '--output', moduleProfile);
        if (!readFileSync(moduleProfile, 'utf8').includes('Ontology and imports closure in profile')) {
            throw new Error(`${pattern.name}'s snapshot layer is outside OWL 2 DL:\n${readFileSync(moduleProfile, 'utf8')}`);
        }
        robot('reason', '--reasoner', 'hermit', '--catalog', moduleCatalog,
            '--input', moduleFile, '--output', join(work, `${stem}-snapshot-reasoned.owl`));
        // The shapes are SHACL, not OWL: they are loaded by a SHACL processor
        // where one is given, which rejects a malformed shape even with no
        // data to validate.
        if (!shapes) {
            throw new Error(`${pattern.name}: the snapshot layer has no shapes graph.`);
        }
        const shapesFile = join(work, `${stem}.shapes.ttl`);
        writeFileSync(shapesFile, shapes.content);
        if (pyshacl) {
            const run = spawnSync(pyshacl, ['-s', shapesFile, '-e', ontology, '-i', 'rdfs', join(work, 'empty.ttl')],
                { encoding: 'utf8' });
            if (run.status !== 0) {
                throw new Error(`${pattern.name}'s shapes did not load:\n${run.stdout}${run.stderr}`);
            }
        }
    }
    complete = true;
    process.stdout.write('All tonto patterns are deterministic, OWL 2 DL, consistent, coherent with gUFO 1.0.0, and pass ROBOT\'s report; so are their snapshot layers, without it'
        + (pyshacl ? ', and their shapes load.\n' : '. Set PYSHACL to load their shapes as well.\n'));
} finally {
    if (complete) rmSync(work, { recursive: true });
    else process.stderr.write(`Conformance artifacts retained at ${work}\n`);
}
