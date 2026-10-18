/**
 * Builds the published pattern catalog from the catalog that runs.
 *
 * Every model here is validated as it is printed, and the page says so; if one
 * stopped validating in silence the page would have to say that too, which is
 * what the `unclean` line is for. The prose that is not derived -- the lede
 * and the group descriptions -- is below, so the page can be rebuilt from this
 * repository rather than from the published copy of itself.
 *
 *   node tools/patterns-page/build.mjs [out.html]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalog } from '../../out/cli/patterns.js';
import { escape, highlight } from '../highlight.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** The order the page reads in, with what each group is for. */
const GROUPS = [
    ['Identity and taxonomy', 'identity-and-taxonomy',
        'What a thing is, what supplies that answer, and how a type may be divided without changing it.'],
    ['Relators and roles', 'relators-and-roles',
        'Everything that holds only while a relationship does — and the relationship itself, which is where the '
        + 'properties live.'],
    ['Aspects', 'aspects',
        'Qualities and modes: the things that exist because something else does, and cannot be moved to another bearer.'],
    ['Matter and parts', 'matter-and-parts',
        'Four parthood relations that are not interchangeable, and constitution, which is not parthood at all.'],
    ['Events and situations', 'events-and-situations',
        'What happened, what took part in it, what it changed, and the chain by which one thing leads to the next.'],
    ['Multi-level', 'multi-level',
        'Types whose instances are types. Cardelli’s reading and Odell’s are different patterns, and the difference '
        + 'is a criterion.'],
    ['Values', 'values',
        'What has no life of its own: structured values, and saying what a class classifies.']
];

const LEDE = (count) => `${count} shapes drawn from Guizzardi&rsquo;s UFO, the multi-level theory of Carvalho and `
    + 'Almeida, and gUFO. The validation rules say what not to write; these say what to write instead. '
    + 'Each is the smallest model that shows one pattern and nothing else &mdash; and every one is validated on the way '
    + 'out, in silence: no error, no warning, not even a hint. A rule that fires on a textbook pattern is wrong about '
    + 'the pattern or wrong about itself.';

/** The notes are written with backticks and asterisks; both mean something. */
function prose(text) {
    return escape(text)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function renderPattern(pattern, number) {
    // A pattern that no longer validates in silence is news, and the page says
    // so rather than printing it as though nothing had happened.
    const unclean = pattern.diagnostics.length === 0 ? ''
        : `<p class="unclean">No longer silent: ${pattern.diagnostics.map(escape).join('; ')}</p>`;
    return `<article class="plate" id="${escape(pattern.name)}">
  <header class="plate-head">
    <span class="plate-no">${String(number).padStart(2, '0')}</span>
    <div>
      <h3>${escape(pattern.title)}</h3>
      <p class="intent">${prose(pattern.intent)}</p>
    </div>
    <code class="handle">${escape(pattern.name)}</code>
  </header>
  <div class="scroll"><pre class="model">${highlight(pattern.model.trim())}</pre></div>
  <p class="note">${prose(pattern.note)}</p>
  ${unclean}
  <p class="source">${escape(pattern.source)}</p>
</article>`;
}

const patterns = await catalog();
const byGroup = GROUPS.map(group => [group, patterns.filter(pattern => pattern.group === group[0])]);
const missing = patterns.filter(pattern => !GROUPS.some(([name]) => name === pattern.group));
if (missing.length > 0) {
    throw new Error(`no place on the page for: ${[...new Set(missing.map(pattern => pattern.group))].join(', ')}`);
}

let number = 0;
const groups = byGroup.map(([[name, id, why], found]) => `<section class="group" id="${id}">
  <div class="group-head">
    <h2>${escape(name)}</h2>
    <p class="group-why">${why}</p>
  </div>
  ${found.map(pattern => renderPattern(pattern, ++number)).join('')}
</section>`).join('');

const silent = patterns.filter(pattern => pattern.diagnostics.length === 0).length;
const counts = [
    [patterns.length, 'patterns'],
    [GROUPS.length, 'groups'],
    [silent, 'validate silently']
].map(([n, label]) => `<div><b>${n}</b><span>${label}</span></div>`).join('');

const page = readFileSync(join(here, 'template.html'), 'utf8')
    .replace('{{LEDE}}', LEDE(patterns.length))
    .replace('{{COUNTS}}', counts)
    .replace('{{RAIL}}', byGroup
        .map(([[name, id], found]) => `<li><a href="#${id}"><span>${escape(name)}</span><span class="n">${found.length}</span></a></li>`)
        .join(''))
    .replace('{{GROUPS}}', groups);

const out = process.argv[2] ?? join(here, 'patterns.html');
writeFileSync(out, page);
process.stdout.write(`${patterns.length} patterns, ${silent} silent, ${page.length} bytes -> ${out}\n`);
