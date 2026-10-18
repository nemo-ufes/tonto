/**
 * Builds the "tonto from Scratch" handout: the one-hour demonstration, with
 * the model it builds one step at a time.
 *
 * Nothing the editor says is written here. Each step's model is put through
 * the validator, and its diagnostics and repairs -- and the Turtle the finished
 * model exports to -- are the tools' own output, captured as the page is built.
 * So a rule that changes its wording or its repairs changes here by being
 * rebuilt. The prose that is not derived -- what each step does and what it is
 * about -- is in `steps.mjs`, beside the models.
 *
 *   node tools/handout-page/build.mjs [out.html]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalog } from '../../out/cli/patterns.js';
import { escape, highlight } from '../highlight.mjs';
import { MISTAKES, STEPS } from './steps.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TONTO = join(here, '../../bin/tonto.js');

// The models are checked as files of their own, in a directory of their own,
// so nothing else in the repository becomes part of the model they belong to.
const work = mkdtempSync(join(tmpdir(), 'tonto-handout-'));

function tonto(args) {
    try {
        return execFileSync('node', [TONTO, ...args], { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
        return error.stdout; // exits 1 when an error is reported
    }
}

/** Writes a model to the work directory under `name`, and returns the name. */
function file(name, model) {
    writeFileSync(join(work, name), `${model}\n`);
    return name;
}

const check = name => JSON.parse(tonto(['check', '--isolated', '--json', name])).diagnostics;
const read = name => readFileSync(join(work, name), 'utf8').replace(/\n+$/, '');

/** Lines of `next` that are not in `prev`, by longest common subsequence. */
function addedLines(prev, next) {
    const a = prev ? prev.split('\n') : [];
    const b = next.split('\n');
    const L = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
        }
    }
    const added = new Set();
    let i = 0, j = 0;
    while (j < b.length) {
        if (i < a.length && a[i] === b[j]) { i++; j++; }
        else if (i < a.length && L[i + 1][j] >= L[i][j + 1]) i++;
        else { if (b[j].trim()) added.add(j + 1); j++; }
    }
    return added;
}

const SEVERITY = { error: 'Error', warning: 'Warning', information: 'Information', hint: 'Hint' };

/** The model with line numbers, new lines marked, and each diagnostic's range underlined. */
function code(source, { added = new Set(), diagnostics = [] } = {}) {
    const lines = source.split('\n').map((text, index) => {
        const n = index + 1;
        // Where one range holds another, the inner one is the more specific
        // claim; the outer is still listed beside the code.
        const onLine = diagnostics.filter(d => d.line === n && d.endLine === n);
        const marks = onLine
            .filter(d => !onLine.some(o => o !== d && o.column >= d.column && o.endColumn <= d.endColumn
                && (o.column > d.column || o.endColumn < d.endColumn)))
            .sort((x, y) => x.column - y.column);
        let html = '';
        let at = 0;
        for (const d of marks) {
            const start = Math.max(d.column - 1, at);
            if (start >= d.endColumn - 1) continue;
            html += highlight(text.slice(at, start));
            html += `<span class="sq sq-${d.severity}" title="${escape(d.code)}">${highlight(text.slice(start, d.endColumn - 1))}</span>`;
            at = d.endColumn - 1;
        }
        html += highlight(text.slice(at));
        const cls = added.has(n) ? 'ln add' : 'ln';
        return `<span class="${cls}"><span class="no" aria-hidden="true">${n}</span><span class="tx">${html || ' '}</span></span>`;
    });
    return `<div class="codebox"><button class="copy" type="button" data-src="${escape(source)}">Copy</button>`
        + `<pre class="src"><code>${lines.join('')}</code></pre></div>`;
}

function diagnosticsList(diagnostics, { showBatch = false } = {}) {
    if (diagnostics.length === 0) {
        return '<p class="silent">Nothing to report: no error, no warning, not even a hint.</p>';
    }
    return `<ul class="diags">${diagnostics.map(d => `<li class="diag s-${d.severity}">
  <div class="diag-head"><span class="chip chip-${d.severity}">${SEVERITY[d.severity]}</span><code class="rid">${escape(d.code)}</code><span class="where">line ${d.line}</span></div>
  <p class="msg">${escape(d.message)}</p>
  ${d.fixes.length ? `<p class="fixes-lbl">Quick fixes offered</p><ul class="fixes">${d.fixes.map(f => `<li>${escape(f.title)}${showBatch && f.batchSafe ? ' <span class="auto">written by --fix</span>' : ''}</li>`).join('')}</ul>` : ''}
</li>`).join('')}</ul>`;
}

/** Inline prose: backticks become code, double asterisks bold. */
const md = text => escape(text).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');

let previous;
const steps = STEPS.map((step, index) => {
    const name = file(`step${index + 1}.tonto`, step.model);
    const source = read(name);
    const diagnostics = check(name);
    const added = addedLines(previous, source);
    previous = source;
    return `<article class="step" id="step-${index + 1}">
  <header class="step-head"><span class="step-no">Step ${index + 1}</span><h3>${escape(step.title)}</h3></header>
  <div class="step-grid">
    <div class="pane">${code(source, { added, diagnostics })}</div>
    <div class="pane notes">
      <p class="lbl">What we do</p>
      <ul class="doing">${step.doing.map(line => `<li>${md(line)}</li>`).join('')}</ul>
      <p class="lbl">What the editor says</p>
      ${diagnosticsList(diagnostics)}
      <p class="lbl">The idea</p>
      <p class="idea">${md(step.idea)}</p>
    </div>
  </div>
</article>`;
}).join('\n');
const finished = `step${STEPS.length}.tonto`;

// The mistakes, and what `tonto check --fix` makes of them.
const mistakes = read(file('mistakes.tonto', MISTAKES));
const mistakeDiags = check('mistakes.tonto');
file('mistakes-fixed.tonto', MISTAKES);
const fixSummary = tonto(['check', '--isolated', '--fix', 'mistakes-fixed.tonto']).trim().split('\n').pop();
const fixed = read('mistakes-fixed.tonto');
const fixedDiags = check('mistakes-fixed.tonto');
const changed = addedLines(mistakes, fixed);

// The finished model as gUFO: the role and its relator, the derived relation,
// and the historical role defined by what it is derived from.
const namespace = '--namespace-iri=https://example.org/university#';
const turtle = tonto(['gufo', '--isolated', finished, namespace]);
const block = subject => turtle.split('\n\n').find(chunk => chunk.startsWith(subject));
const excerpt = ['university:Student a', 'university:studiesAt a', 'university:Graduate a']
    .map(block).filter(Boolean).join('\n\n');
const exportNotes = JSON.parse(tonto(['gufo', '--isolated', '--json', finished, namespace])).diagnostics ?? [];

function turtleHtml(text) {
    return text.split('\n').map(line => escape(line)
        .replace(/(&quot;[^&]*&quot;(\^\^[\w:]+)?)/g, '<span class="t-str">$1</span>')
        .replace(/\b(owl|rdfs|gufo|xsd):(\w+)/g, '<span class="t-voc">$1:$2</span>')
        .replace(/\buniversity:(\w+)/g, '<span class="t-own">university:$1</span>')
        .replace(/^(\S+) a /, '$1 <span class="t-kw">a</span> ')
    ).join('\n');
}

// The pattern catalog, by group, from the catalog the editor inserts from.
const patterns = await catalog();
const groups = [...new Set(patterns.map(pattern => pattern.group))].map(group => {
    const names = patterns.filter(pattern => pattern.group === group).map(pattern => pattern.name);
    return `<li><b>${escape(group)}<span>${names.length}</span></b><p>${names.map(escape).join(', ')}</p></li>`;
}).join('');

const page = readFileSync(join(here, 'template.html'), 'utf8')
    .replace('{{PATTERN_GROUPS}}', groups)
    .replaceAll('{{PATTERN_COUNT}}', String(patterns.length))
    .replace('{{STEPS}}', steps)
    .replace('{{MISTAKES}}', code(mistakes, { diagnostics: mistakeDiags }))
    .replace('{{MISTAKE_DIAGS}}', diagnosticsList(mistakeDiags, { showBatch: true }))
    .replace('{{MISTAKE_COUNT}}', String(mistakeDiags.length))
    .replace('{{FIX_SUMMARY}}', escape(fixSummary))
    .replace('{{FIXED}}', code(fixed, { added: changed, diagnostics: fixedDiags }))
    .replaceAll('{{FINAL_STEP}}', String(STEPS.length))
    .replace('{{FINAL}}', code(read(finished)))
    .replace('{{TURTLE}}', `<div class="codebox"><pre class="src ttl"><code>${turtleHtml(excerpt)}</code></pre></div>`)
    .replace('{{EXPORT_NOTES}}', exportNotes.map(d => `<li><span class="chip chip-information">Information</span> ${escape(d.message)}</li>`).join(''));

rmSync(work, { recursive: true, force: true });
const out = process.argv[2] ?? join(here, 'handout.html');
writeFileSync(out, page);
process.stdout.write(`${STEPS.length} steps, ${mistakeDiags.length} mistakes -> ${fixSummary}; ${page.length} bytes -> ${out}\n`);
