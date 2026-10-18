/**
 * Builds the publication guide: how a tonto ontology goes from a source
 * folder to the web, and how another model comes to depend on it.
 *
 * Nothing the tools say is written here. The files in `scenario.mjs` are laid
 * out in a scratch directory and the CLI is run over them -- check, fetch,
 * verification and export -- with the network answered by a stub that serves
 * the one dependency, so the commands and their output on the page are the
 * tools' own. The diagnostics table is the rule catalog's, and the editor
 * commands are the extension's manifest. The prose around them is in
 * `template.html`.
 *
 *   node tools/publication-page/build.mjs [out.html]
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../../out/cli/index.js';
import { catalog } from '../../out/cli/rules.js';
import { escape, highlight } from '../highlight.mjs';
import { LOOSE, MAPPING, MEMBERS, PEOPLE, SHOP } from './scenario.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'tonto-publication-'));

function put(folder, files) {
    for (const [name, source] of Object.entries(files)) {
        const path = join(work, folder, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${source}\n`);
    }
}

// The dependency's host. Only `tonto fetch` asks it anything; a check that
// reached the network would find nothing here and fail the build.
let served = PEOPLE.source;
const requests = [];
globalThis.fetch = async url => {
    requests.push(String(url));
    const found = String(url) === PEOPLE.url;
    const response = new Response(found ? served : 'Not found', { status: found ? 200 : 404 });
    Object.defineProperty(response, 'url', { value: String(url) });
    return response;
};

/** Runs the CLI in a folder of the scratch directory, and returns the transcript. */
async function tonto(folder, ...argv) {
    const written = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = chunk => (written.push(String(chunk)), true);
    process.stderr.write = chunk => (written.push(String(chunk)), true);
    const was = process.cwd();
    process.chdir(join(work, folder));
    let code;
    try {
        code = await run(argv);
    } finally {
        process.chdir(was);
        process.stdout.write = out;
        process.stderr.write = err;
    }
    return { command: `tonto ${argv.join(' ')}`, output: written.join('').trim(), code };
}

/** A terminal transcript: the command, what it printed, and whether it passed. */
function terminal(...runs) {
    const body = runs.map(({ command, output, code }) => {
        const lines = output.split('\n').map(line => {
            const text = escape(line);
            if (/^\S+:\d+:\d+\s+error\b/.test(line)) return `<span class="o-error">${text}</span>`;
            if (/^\S+:\d+:\d+\s+warning\b/.test(line)) return `<span class="o-warning">${text}</span>`;
            return text;
        }).join('\n');
        const status = code === 0 ? '<span class="exit ok">exit 0</span>' : `<span class="exit bad">exit ${code}</span>`;
        return `<span class="prompt">$</span> <span class="cmd">${escape(command)}</span>${status}\n${lines}`;
    }).join('\n\n');
    return `<div class="term"><pre><code>${body}</code></pre></div>`;
}

/** tonto source, colored, with locations marked as the addresses they are. */
function source(name, text) {
    const html = highlight(text).replace(/&lt;([^<&]*?)&gt;/g, '<span class="c-loc">&lt;$1&gt;</span>');
    return `<figure class="file"><figcaption>${escape(name)}</figcaption><pre><code>${html}</code></pre></figure>`;
}

function plain(name, text, kind = 'json') {
    return `<figure class="file ${kind}"><figcaption>${escape(name)}</figcaption><pre><code>${escape(text)}</code></pre></figure>`;
}

// 1. What one ontology is, without any configuration.
put('loose', LOOSE);
const loose = await tonto('loose', 'check', '.');
put('members', MEMBERS);
const members = await tonto('members', 'check', '.');

// 2-4. The shop: its ontology file, a dependency by location, and a local copy of it.
put('shop', SHOP);
put('people', { 'people.tonto': PEOPLE.source });
const unmapped = await tonto('shop', 'check', '.');
put('shop', { 'tonto.json': JSON.stringify(MAPPING, undefined, 2) });
const mapped = await tonto('shop', 'check', '.');
if (requests.length > 0) throw new Error(`checking reached the network: ${requests.join(', ')}`);

// 5. Verification: the mapping is ignored, so the published dependency is fetched.
const unverified = await tonto('shop', 'check', '.', '--publication');
const fetched = await tonto('shop', 'fetch', '--publication');
const verified = await tonto('shop', 'check', '.', '--publication');
const exported = await tonto('shop', 'gufo', 'shop.tonto', '--publication', '--write');
const turtle = readFileSync(join(work, 'shop/shop.ttl'), 'utf8');
const header = turtle.split('\n\n').slice(0, 3).join('\n\n');
const cached = readdirSync(join(work, 'shop/.tonto'));

// 6. The dependency moves on; a refresh says what changed.
served = PEOPLE.next;
const refreshed = await tonto('shop', 'fetch', '--publication', '--refresh');

for (const [name, result, expected] of [['loose', loose, 0], ['members', members, 1], ['unmapped', unmapped, 1],
    ['mapped', mapped, 0], ['unverified', unverified, 1], ['fetched', fetched, 0], ['verified', verified, 0],
    ['exported', exported, 0], ['refreshed', refreshed, 0]]) {
    if (result.code !== expected) throw new Error(`${name}: exit ${result.code}, expected ${expected}\n${result.output}`);
}

function turtleHtml(text) {
    return text.split('\n').map(line => {
        if (line.startsWith('#')) return `<span class="t-note">${escape(line)}</span>`;
        return escape(line)
            .replace(/(&quot;[^&]*&quot;)/g, '<span class="t-str">$1</span>')
            .replace(/&lt;(https?:[^&]*)&gt;/g, '<span class="t-iri">&lt;$1&gt;</span>')
            .replace(/\b(owl|rdfs|gufo|xsd|dcterms|vann):(\w+)/g, '<span class="t-voc">$1:$2</span>');
    }).join('\n');
}

// The diagnostics an author meets on the way, as the catalog reports them.
const CODES = ['namespace-name-clash', 'missing-package-use', 'cross-ontology-package-use', 'ontology-header',
    'ontology-loose-declarations', 'package-file-without-in', 'package-not-bundled', 'package-file-import',
    'import-for-use', 'package-without-ontology', 'ontology-file-required', 'ontology-bundle', 'package-bundled-twice', 'ontology-namespace-conflict', 'ontology-tag-not-on-header',
    'publication-location', 'publication-configuration', 'publication-namespace', 'ontology-file-missing',
    'ontology-name-case'];
const rules = await catalog();
const diagnostics = CODES.map(code => {
    const rule = rules.find(candidate => candidate.code === code);
    if (!rule || rule.reported !== code) throw new Error(`the catalog does not report ${code}`);
    return `<li class="rule s-${rule.severity}">
  <div class="rule-head"><code class="rid">${escape(code)}</code><span class="chip chip-${rule.severity}">${escape(rule.severity)}</span></div>
  <p class="msg">${escape(rule.message)}</p>
</li>`;
}).join('');

// The editor's commands for this, from the extension's own manifest.
const manifest = JSON.parse(readFileSync(join(here, '../../../extension/package.json'), 'utf8'));
const commands = manifest.contributes.commands
    .filter(command => /Ontolog|Publication|gUFO/.test(command.title))
    .map(command => `<li><b>tonto: ${escape(command.title)}</b></li>`).join('');

const files = Object.entries(SHOP).map(([name, text]) => source(name, text)).join('');
const page = readFileSync(join(here, 'template.html'), 'utf8')
    .replace('{{LOOSE_FILES}}', Object.entries(LOOSE).map(([name, text]) => source(name, text)).join(''))
    .replace('{{LOOSE}}', terminal(loose))
    .replace('{{MEMBERS_FILES}}', Object.entries(MEMBERS).map(([name, text]) => source(name, text)).join(''))
    .replace('{{MEMBERS}}', terminal(members))
    .replace('{{SHOP_FILES}}', files)
    .replace('{{UNMAPPED}}', terminal(unmapped))
    .replace('{{PEOPLE}}', source(PEOPLE.url, PEOPLE.source))
    .replace('{{MAPPING}}', plain('tonto.json', JSON.stringify(MAPPING, undefined, 2)))
    .replace('{{MAPPED}}', terminal(mapped))
    .replace('{{VERIFY}}', terminal(unverified, fetched, verified))
    .replace('{{EXPORT}}', terminal(exported))
    .replace('{{TURTLE}}', `<figure class="file ttl"><figcaption>dist/shop.ttl (beginning)</figcaption><pre><code>${turtleHtml(header)}</code></pre></figure>`)
    .replace('{{CACHE}}', cached.map(name => `<code>.tonto/${escape(name)}</code>`).join(' and '))
    .replace('{{REFRESH}}', terminal(refreshed))
    .replace('{{DIAGNOSTICS}}', diagnostics)
    .replace('{{COMMANDS}}', commands);
const left = page.match(/\{\{[A-Z_]+\}\}/);
if (left) throw new Error(`template placeholder left unfilled: ${left[0]}`);

rmSync(work, { recursive: true, force: true });
const out = process.argv[2] ?? join(here, 'publication.html');
writeFileSync(out, page);
process.stdout.write(`${CODES.length} diagnostics, ${requests.length} network request(s), all in fetch; ${page.length} bytes -> ${out}\n`);
