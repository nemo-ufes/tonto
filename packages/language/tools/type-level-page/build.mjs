/**
 * Builds the published type-level reference by asking the implementation.
 *
 * Everything computed -- what each stereotype fixes, the nature tiers, the
 * principle tallies and the 23x23 table -- comes from `stereotype-model.ts`
 * and `natures.ts` at build time, pair by pair, including the sentence the
 * language would say about each refusal. The prose that is not computed is in
 * `template.html`: the two tables keyed by diagnostic code, which say where
 * the type level reaches the rest of the language.
 *
 *   node tools/type-level-page/build.mjs [out.html]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STEREOTYPES, whyNotSpecialize } from '../../out/validation/stereotype-model.js';
import {
    ATOMIC_NATURES, CHANGEABLE_INSTANCE_NATURES, ENDURANT_NATURES, EVERY_NATURE, NATURE_UNIONS, atomsOf
} from '../../out/validation/natures.js';
import { escape } from '../highlight.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The refusals, in the order `whyNotSpecialize` tests them, each recognized by
 * what it says. A principle that stopped being said would fail the tally
 * below rather than quietly reporting zero.
 */
const PRINCIPLES = [
    ['A non-sortal takes no identity from a sortal', 'is a non-sortal, and carries no identity principle',
        'It generalizes sortals rather than specializing them: a category collects kinds, it does not sit under one.'],
    ['A rigid or semi-rigid type does not sit under an anti-rigid one', 'is anti-rigid, so its instances may stop being one',
        'An instance of the subtype would have to stop being an instance of the supertype while remaining an instance '
        + 'of the subtype, which the subtype’s own rigidity forbids.'],
    ['An ultimate sortal tops its lineage', 'is an ultimate sortal',
        'It supplies the principle of identity; nothing above it can supply another. What specializes it is a base sortal.'],
    ['The two must share an ontological nature', 'share no ontological nature',
        'Nothing could instantiate both, so the generalization has an empty extension. This is also where principle 6 '
        + 'does its work.'],
    ['An intrinsic condition cannot narrow a differently founded one', 'holds for intrinsic reasons',
        'A phase holds because of how the individual is; a role because of a relationship it stands in. The relational '
        + 'may narrow the intrinsic, never the reverse.']
];

const SIXTH = ['Anti-rigidity needs an instance that can change',
    'It refuses no pair of stereotypes directly. It narrows the natures the anti-rigid stereotypes may take, and the '
    + 'refusals surface as principle 4.'];

const SORTALITY = {
    'ultimate-sortal': 'ultimate sortal', 'base-sortal': 'base sortal', 'non-sortal': 'non-sortal', none: '—'
};

const stereotypes = Object.keys(STEREOTYPES);

/** Which principle refuses this pair, or 0 where none does. */
function refusal(subject, candidate) {
    const why = whyNotSpecialize(subject, candidate);
    if (why === undefined) {
        return { principle: 0, why: `${subject} may specialize ${candidate}` };
    }
    const found = PRINCIPLES.findIndex(([, mark]) => why.includes(mark));
    if (found < 0) {
        throw new Error(`no principle owns this refusal: ${why}`);
    }
    return { principle: found + 1, why };
}

const table = stereotypes.map(subject => stereotypes.map(candidate => refusal(subject, candidate)));
const tally = principle => table.flat().filter(cell => cell.principle === principle).length;

const props = stereotypes.map(name => {
    const facts = STEREOTYPES[name];
    const natures = facts.natures;
    const listed = natures === null ? '<span class="any">anything</span>'
        : natures.length > 3 ? `<span class="any">anything (${natures.length})</span>`
            : escape(natures.join(', '));
    const atoms = new Set((natures ?? []).flatMap(atomsOf));
    const order = natures === null ? 'first-order'
        : natures.length === 1 && natures[0] === 'types' ? 'high-order'
            : atoms.has('types') ? 'high-order possible' : 'first-order';
    return `<tr><th>${escape(name)}</th><td>${SORTALITY[facts.sortality] ?? facts.sortality}</td>`
        + `<td>${facts.rigidity === 'none' ? '—' : facts.rigidity}</td>`
        + `<td class="nat">${listed}</td><td>${order}</td></tr>`;
}).join('');

const dotted = names => [...new Set(names)].map(escape).join(' &middot; ');
const tiers = [
    ['atoms', dotted(ATOMIC_NATURES)],
    ['stands for several', Object.entries(NATURE_UNIONS)
        .map(([name, members]) => `${escape(name)} = ${dotted(members)}`).join('; ')],
    ['endurants &mdash; continuants, no temporal parts', dotted(ENDURANT_NATURES.flatMap(atomsOf))],
    ['instances can change &mdash; what anti-rigidity needs', dotted(CHANGEABLE_INSTANCE_NATURES.flatMap(atomsOf))],
    ['any rigid type may span', dotted(EVERY_NATURE.flatMap(atomsOf))]
].map(([label, body]) => `<li><b>${label}</b><code>${body}</code></li>`).join('');

const principles = [
    ...PRINCIPLES.map(([title, , why], index) => [index + 1, title, why, String(tally(index + 1))]),
    [6, SIXTH[0], SIXTH[1], '&mdash;']
].map(([number, title, why, count]) => `<article class="principle">
  <header><span class="chip p${number}">${number}</span><h3>${title}</h3>
  <span class="tally">${count}</span></header>
  <p>${why}</p>
</article>`).join('');

const matrixHead = stereotypes
    .map(name => `<th class="col"><span>${escape(name)}</span></th>`).join('');
const matrix = stereotypes.map((subject, row) => `<tr><th class="row">${escape(subject)}</th>`
    + stereotypes.map((candidate, column) => {
        const { principle, why } = table[row][column];
        return principle === 0
            ? `<td class="ok" title="${escape(why)}">&#10003;</td>`
            : `<td class="no p${principle}" title="${escape(why)}">${principle}</td>`;
    }).join('') + '</tr>').join('');

const admissible = table.flat().filter(cell => cell.principle === 0).length;
const legend = [
    '<li><span class="chip" style="background:var(--accent)">&#10003;</span>admissible '
    + `<b>${admissible}</b></li>`,
    ...PRINCIPLES.map(([title], index) =>
        `<li><span class="chip p${index + 1}">${index + 1}</span>${title} <b>${tally(index + 1)}</b></li>`),
    `<li><span class="chip p6">6</span>${SIXTH[0]} <i>no pair</i></li>`
].join('');

const counts = [
    [stereotypes.length, 'class stereotypes'],
    [stereotypes.length ** 2, 'ordered pairs'],
    [admissible, 'admissible'],
    [stereotypes.length ** 2 - admissible, 'refused'],
    [6, 'principles']
].map(([n, label]) => `<div><b>${n}</b><span>${label}</span></div>`).join('');

const page = readFileSync(join(here, 'template.html'), 'utf8')
    .replaceAll('{{SIZE}}', String(stereotypes.length))
    .replace('{{PAIRS}}', String(stereotypes.length ** 2))
    .replace('{{COUNTS}}', counts)
    .replace('{{PROPS}}', props)
    .replace('{{TIERS}}', tiers)
    .replace('{{PRINCIPLES}}', principles)
    .replace('{{MATRIX_HEAD}}', matrixHead)
    .replace('{{MATRIX}}', matrix)
    .replace('{{LEGEND}}', legend);

const out = process.argv[2] ?? join(here, 'type-level.html');
writeFileSync(out, page);
process.stdout.write(`${stereotypes.length} stereotypes, ${admissible} admissible of ${stereotypes.length ** 2}, `
    + `${page.length} bytes -> ${out}\n`);
