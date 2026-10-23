import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * The words docs/ontology-publication.md section 2 retired, kept out of every
 * text a person or an agent reads about the model. The account of the model is
 * written in several places -- the guide, the specification, the README, the
 * agent instructions, the walkthrough and the pages -- and they drifted once;
 * this is what keeps them on one vocabulary. A paragraph that names the old
 * words in order to retire them is the one place they may appear.
 */
const RETIRED: Array<[RegExp, string, string?]> = [
    [/\bmanifests?\b/i, 'say "ontology file"'],
    [/\bentry documents?\b/i, 'say "ontology file"'],
    [/\bmonolithic\b/i, 'say "one-file ontology"'],
    [/\bdevelopment mappings?\b/i, 'say "location mapping"'],
    [/\bmember files?\b/i, 'say "package file"'],
    [/older spelling of `use/i, '"import" of a package is an error now'],
    [/--base-iri|\bbaseIri\b/, 'the namespace is written above the ontology header'],
    // gUFO Turtle is the first export of several, so an export is named by its format.
    // The mapping is about nothing else, so it may say "the export".
    [/(?<!gUFO )\bthe exports?\b(?! of\b)/i, 'say "the gUFO export", or "every export" for what all formats do', 'docs/gufo-mapping.md']
];

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const files = [
    'README.md', 'AGENTS.md', 'packages/language/src/cli/guide.ts',
    ...readdirSync(join(repository, 'docs')).filter(name => name.endsWith('.md') && name !== 'ontology-publication-stages.md').map(name => `docs/${name}`),
    'packages/extension/templates/agent-instructions.md', 'packages/language/templates/agent-instructions.md',
    ...readdirSync(join(repository, 'packages/extension/media/walkthrough')).map(name => `packages/extension/media/walkthrough/${name}`),
    ...['handout-page', 'publication-page', 'rules-page'].flatMap(page => readdirSync(join(repository, 'packages/language/tools', page))
        .filter(name => /\.(mjs|md)$/.test(name) || name === 'template.html').map(name => `packages/language/tools/${page}/${name}`))
];

describe('the vocabulary of ontologies, packages and files', () => {
    test.each(files)('%s uses none of the retired words', file => {
        const text = readFileSync(join(repository, file), 'utf8');
        const found = text.split(/\n\s*\n/)
            .filter(paragraph => !/\bretired\b|earlier names for/i.test(paragraph))
            // VS Code calls an extension's package.json its manifest.
            .map(paragraph => paragraph.replace(/extension['’]s (own )?manifest|manifest\.contributes|const manifest/g, ''))
            .flatMap(paragraph => RETIRED.filter(([word, , except]) => except !== file && word.test(paragraph))
                .map(([word, instead]) => `${word.source}: ${instead} -- ${paragraph.slice(0, 120).replace(/\s+/g, ' ')}`));
        expect(found).toEqual([]);
    });
});

/**
 * One spelling, US English, in everything this repository writes: code,
 * comments, messages, tests and documents. The words are the British spellings
 * it once used. Quotations and titles keep their own spelling, and the near
 * miss `@licence` is a test's input, so a word right after `@` is not checked.
 */
const BRITISH = /(?<![@\w])(model(l(ing|ed|er|ers))|catalogu(e|es|ed)|colour|behaviour|neighbour|favour|enrolment|labelled|cancelled|licence|judgement|organis(e|ed|es|ing|ation|ations)|recognis(e|ed|es|ing)|normalis(e|ed|es|ing|ation)|capitalis(e|ed|es|ing|ation))(?!\w)/i;

const SPELLED = ['README.md', 'AGENTS.md', 'docs', 'evals', 'packages/language/src', 'packages/language/test',
    'packages/language/tools', 'packages/language/templates', 'packages/mcp/src', 'packages/extension/src',
    'packages/extension/templates', 'packages/extension/media', 'packages/extension/package.json'];

function textFiles(path: string): string[] {
    const absolute = join(repository, path);
    if (!existsSync(absolute)) return [];
    if (!statSync(absolute).isDirectory()) return [path];
    return readdirSync(absolute)
        .filter(name => !['node_modules', 'out', 'generated', 'fixtures'].includes(name))
        .flatMap(name => textFiles(join(path, name)))
        // A page is built from its template, and the built one is not kept.
        .filter(file => /\.(ts|mts|mjs|js|json|md|langium)$/.test(file) || file.endsWith('template.html'));
}

describe('US spelling', () => {
    // This file names the British spellings in order to keep them out.
    test.each(SPELLED.flatMap(textFiles).filter(file => !file.endsWith('vocabulary.test.ts')))('%s', file => {
        const found = readFileSync(join(repository, file), 'utf8').split('\n')
            .map((line, index) => ({ line, index }))
            .filter(({ line }) => BRITISH.test(line))
            .map(({ line, index }) => `${index + 1}: ${BRITISH.exec(line)![0]}`);
        expect(found).toEqual([]);
    });
});
