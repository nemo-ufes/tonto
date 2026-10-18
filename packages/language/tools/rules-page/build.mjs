/**
 * Builds the published rules reference from the catalog that runs.
 *
 * The page is the `tonto rules` output with a layout: every example here was
 * put through the language server, and the messages, severities and quick-fix
 * titles are its own. Nothing is transcribed, so a rule that changes name or
 * message changes here by being rebuilt.
 *
 * The prose that is *not* derived -- the group descriptions below, and the
 * tables and architecture sections in `template.html` -- is the only part
 * written by hand. It lives here rather than in the published page, so the
 * page can be rebuilt from this repository alone; the first version of it
 * could not, and nineteen renamed codes went stale in public.
 *
 *   node tools/rules-page/build.mjs [out.html]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalog } from '../../out/cli/rules.js';
import { STEREOTYPES } from '../../out/validation/stereotype-model.js';

const here = dirname(fileURLToPath(import.meta.url));

/** The order the page reads in, which is not the order the catalog is in. */
const GROUPS = [
    ['Nature', 'nature',
        'What an instance can be, and whether anything can be it at all.'],
    ['Identity', 'identity',
        'Where a type draws its principle of identity from.'],
    ['Taxonomy', 'taxonomy',
        'Which stereotype may specialize which, and when a hierarchy contradicts itself.'],
    ['Generalization sets', 'generalization-sets',
        'A set declares generalizations, so it answers to the same rules as a clause.'],
    ['Multi-level', 'multi-level',
        'The powertype pattern, from the axiomatized multi-level theory of Carvalho, Almeida and Guizzardi '
        + '(CAiSE 2016). Cardelli’s powertype holds every specialization of its base type; Odell’s holds only '
        + 'those a criterion picks out. tonto spells them apart with the <code>isPowerType</code> modifier: a '
        + 'high-order type carrying it is Cardelli’s, one without it Odell’s. Three rules come from '
        + 'nemo-ufes/gufoshapes, the SHACL constraints for gUFO.'],
    ['Relations', 'relations',
        'What each relation stereotype may connect, what UML requires of an end, and the UFO axioms governing '
        + 'inherence, constitution and parthood between individuals.'],
    ['Time points', 'time-points',
        'The two attribute stereotypes, <code>@begin</code> '
        + 'and <code>@end</code>: the instants a concrete individual begins and ceases to exist. Every rule here is '
        + 'conditional on the attribute being written; nothing asks a class to declare one.'],
    ['Documentation', 'documentation',
        'What a declaration says about itself, and in which languages. A run of <code>///</code> lines above a '
        + 'declaration is its documentation; a tag inside the run gives another language or a display name. The rules '
        + 'here are about the run, never about whether one was written.'],
    ['Multiplicities', 'multiplicities',
        'Bounds that cannot be satisfied.'],
    ['Ontologies and packages', 'ontologies',
        'An ontology is what is published and imported; a package is a named part of one. An <code>ontology</code> '
        + 'header, in its ontology file, declares an ontology: followed by declarations it is a one-file ontology, '
        + 'followed by packages or a <code>bundles</code> list it owns those packages, and each package file says so '
        + 'with <code>package core in shop</code>. A package with no ontology is an error, and one that says it is in an '
        + 'ontology no ontology file declares is unbundled. Packages are <i>used</i>: <code>use core</code> lets a '
        + 'package refer to another of its own ontology. Ontologies are <i>imported</i>, by the location of their '
        + 'ontology file.'],
    ['Publication', 'publication',
        'Where an ontology is published and how its dependencies are found: its namespace, the locations it imports, '
        + 'the workspace&rsquo;s <code>tonto.json</code> mappings and <code>.tonto</code> cache. Checking never touches '
        + 'the network, and <code>--publication</code> verifies the closure with every mapping switched off.'],
    ['Hygiene', 'hygiene',
        'Names, duplicates and conventions.'],
    ['Anti-patterns', 'anti-patterns',
        'Structures that parse and validate but are empirically error-prone (Sales &amp; Guizzardi 2015). Reported as '
        + 'information, and <b>off by default</b> &mdash; they fire often enough on a real model to bury the '
        + 'diagnostics that are not advisory. Set <code>tonto.antiPatterns</code> to turn them on when auditing. '
        + 'Each is scanned over one document, so a model split across files reports fewer of them, never more.']
];

const SEVERITIES = ['error', 'warning', 'information', 'hint'];

function escape(text) {
    return String(text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

/** Words that begin a declaration, and the words that qualify one. */
const DECLARING = new Set([...Object.keys(STEREOTYPES), 'class', 'datatype', 'enum', 'genset', 'relation',
    'package', 'import', 'use', 'ontology']);
const QUALIFYING = new Set(['of', 'specializes', 'where', 'isPowerType', 'instanceOf', 'disjoint', 'complete',
    'general', 'categorizer', 'specifics', 'const', 'ordered', 'derived', 'addOnly', 'subsets', 'redefines',
    'inverseOf', 'derivedFrom', 'as', 'bundles', 'from', 'in']);

/**
 * Colors the model the way the language does: what declares, what qualifies,
 * a stereotype, a multiplicity, a comment. Deliberately not a parser -- the
 * examples are two or three lines each, and a lexer's worth of machinery here
 * would be a second grammar to keep in step with the first.
 */
function highlight(source) {
    return source.split('\n').map(line => {
        if (line.trimStart().startsWith('//')) {
            return `<span class="c-note">${escape(line)}</span>`;
        }
        let out = '';
        const pattern = /@[A-Za-z]\w*|\[[^\]]*\]|[A-Za-z_]\w*/g;
        let at = 0;
        for (const match of line.matchAll(pattern)) {
            out += escape(line.slice(at, match.index));
            const token = match[0];
            const kind = token.startsWith('@') ? 'c-ster'
                : token.startsWith('[') ? 'c-mult'
                    : DECLARING.has(token) ? 'c-decl'
                        : QUALIFYING.has(token) ? 'c-mod'
                            : undefined;
            out += kind ? `<span class="${kind}">${escape(token)}</span>` : escape(token);
            at = match.index + token.length;
        }
        return out + escape(line.slice(at));
    }).join('\n');
}

function renderFixes(rule) {
    if (rule.fixes.length === 0) {
        return '<div class="fixes"><p class="lbl">Quick fixes</p>'
            + '<p class="none">None — the repair is a modeling decision.</p></div>';
    }
    // Whether `--fix` writes it, which is a different question from whether a
    // repair exists: a lone phase has one repair and two readings.
    const note = rule.batchSafe
        ? '<p class="fix-note">Written by <code>--fix</code>.</p>'
        : '<p class="fix-note held">Offered, not written by <code>--fix</code>: applying it decides something.</p>';
    return '<div class="fixes"><p class="lbl">Quick fixes</p><ul>'
        + rule.fixes.map(fix => `<li>${escape(fix)}</li>`).join('')
        + `</ul>${note}</div>`;
}

function renderRule(rule) {
    const severity = rule.severity ?? 'error';
    return `<article class="rule s-${severity}">
<header class="rule-head">
  <code class="rid">${escape(rule.code)}</code>
  <span class="chip chip-${severity}">${severity[0].toUpperCase()}${severity.slice(1)}</span>
</header>
<p class="why">${escape(rule.rationale)}</p>
<div class="split">
  <div class="pane">
    <p class="lbl">Model</p>
    <pre class="src"><code>${highlight(rule.example.trim())}</code></pre>
  </div>
  <div class="pane">
    <p class="lbl">Reported</p>
    <p class="msg">${escape(rule.message ?? '')}</p>
    ${renderFixes(rule)}
  </div>
</div>
</article>`;
}

function renderGroup([name, id, why], rules) {
    const bar = SEVERITIES
        .map(severity => [severity, rules.filter(rule => rule.severity === severity).length])
        .filter(([, count]) => count > 0)
        .map(([severity, count]) => `<span class="tick t-${severity}" style="flex:${count}"></span>`)
        .join('');
    return `<section class="group" id="${id}">
<div class="group-head">
  <h2>${escape(name)}</h2>
  <div class="bar">${bar}</div>
  <p class="group-why">${why}</p>
</div>
${rules.map(renderRule).join('')}
</section>`;
}

const rules = await catalog();
const byGroup = GROUPS.map(group => [group, rules.filter(rule => rule.group === group[0])]);
const missing = rules.filter(rule => !GROUPS.some(([name]) => name === rule.group));
if (missing.length > 0) {
    throw new Error(`no place on the page for: ${[...new Set(missing.map(rule => rule.group))].join(', ')}`);
}

const counted = severity => rules.filter(rule => rule.severity === severity).length;
const withFixes = rules.filter(rule => rule.fixes.length > 0);
const counts = [
    ['', rules.length, 'Rules'],
    ['is-error', counted('error'), 'Errors'],
    ['is-warning', counted('warning'), 'Warnings'],
    ['is-information', counted('information'), 'Information'],
    ['is-hint', counted('hint'), 'Hint'],
    ['', withFixes.length, 'With quick fixes'],
    ['', withFixes.filter(rule => rule.batchSafe).length, 'Written by --fix']
].map(([kind, n, label]) => `<div class="count ${kind}"><b>${n}</b><span>${escape(label)}</span></div>`).join('');

const rail = byGroup
    .map(([[name, id], found]) => `<li><a href="#${id}"><span>${escape(name)}</span><span class="n">${found.length}</span></a></li>`)
    .join('')
    + '<li><a href="#tables"><span>The tables</span><span class="n">23</span></a></li>';

const page = readFileSync(join(here, 'template.html'), 'utf8')
    .replace('{{TITLE}}', `${rules.length} rules the language enforces`)
    .replace('{{STANDFIRST}}', 'Every diagnostic the tonto language server reports, grouped by what it is protecting. '
        + 'Each entry shows a model that triggers it, the message as the server actually emits it, and the repairs '
        + 'offered &mdash; and, of those, which ones <code>tonto check --fix</code> will write on its own. Nothing '
        + 'here is transcribed by hand: the examples were run through the validator and the output captured.')
    .replace('{{COUNTS}}', counts)
    .replace('{{RAIL}}', rail)
    .replace('{{GROUPS}}', byGroup.map(([group, found]) => renderGroup(group, found)).join(''));

const out = process.argv[2] ?? join(here, 'rules.html');
writeFileSync(out, page);
process.stdout.write(`${rules.length} rules, ${page.length} bytes -> ${out}\n`);
