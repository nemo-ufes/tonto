import { TontoSession } from '../src/api.js';
import type { Applied, Difference, Digest, Reported } from '../src/api.js';

/**
 * Every package belongs to an ontology a document declares, so a snippet
 * written as bare packages -- `package p` and its declarations -- is given an
 * `ontology` header. Its packages become inline packages of that ontology:
 * what the packages of one document already were before every package needed
 * a declared ontology, and what the checks under test read the snippet as.
 *
 * The header goes last. Every package of a document with a header is its
 * inline package wherever the header stands, and written last it moves no
 * line: the positions a test asks about and the diagnostics it expects stay
 * where the snippet has them. `withoutOntology` takes it off text a tool
 * returns. Names are distinct, since the ontologies of one workspace need
 * distinct names. A snippet that declares an ontology, or with no package
 * lacking `in`, is left as it is.
 */
let counter = 0;

export function inOntology(source: string, name = `snippet${++counter}`): string {
    if (/^\s*ontology\s/m.test(source) || !/^[ \t]*package[ \t]+[\w.]+\b(?![ \t]+in\b)/m.test(source)) return source;
    return `${source}\nontology ${name}\n`;
}

/** Text a tool returned, without the header `inOntology` added. */
export function withoutOntology(text: string): string {
    return text.replace(/\nontology snippet\d+\n$/, '');
}

/**
 * The ontology a snippet of bare packages names, for checks that read the
 * ontology's name -- export names its file, prefix and provenance after it.
 * A lone undotted package that uses no other becomes a one-file ontology of
 * its name; otherwise the header `inOntology` writes is named after the first
 * package, as the snippet's ontology was before every package needed one.
 */
export function asOntology(source: string): string {
    if (/^\s*ontology\s/m.test(source)) return source;
    const names = [...source.matchAll(/^[ \t]*package[ \t]+([\w.]+)\b(?![ \t]+in\b)/gm)].map(match => match[1]);
    if (!names.length) return source;
    if (names.length === 1 && !names[0].includes('.') && !/^\s*(use|import)\s+[\w.]+(\s+as\s+\w+)?\s*$/m.test(source)) {
        return source.replace(/^([ \t]*)package([ \t]+)/m, '$1ontology$2');
    }
    return inOntology(source, names.map(name => name.replace(/\./g, '_')).sort()[0]);
}

/**
 * A snippet as `asOntology` makes it, its header given a namespace when it
 * declares none: only an ontology's header says where its terms are published.
 */
export function withNamespace(source: string, namespace: string): string {
    const text = asOntology(source);
    if (/^[ \t]*\/\/\/[ \t]*@namespace\b[^\n]*\n(?:[ \t]*\/\/\/[^\n]*\n)*[ \t]*ontology\s/m.test(text)) return text;
    return text.replace(/^([ \t]*)ontology\s/m, match => `/// @namespace ${namespace}\n${match}`);
}

/**
 * The ontology a snippet belongs to, written without moving a line: a lone
 * undotted package that uses no other becomes a one-file ontology in place
 * (`package p` is `ontology p`), and any other snippet gets `inOntology`'s
 * header after it. Positions keep their lines either way.
 */
export function inOntologyInPlace(source: string): string {
    if (/^\s*ontology\s/m.test(source)) return source;
    const names = [...source.matchAll(/^[ \t]*package[ \t]+([\w.]+)\b(?![ \t]+in\b)/gm)].map(match => match[1]);
    if (names.length === 1 && !names[0].includes('.') && !/^\s*(use|import)\s+[\w.]+(\s+as\s+\w+)?\s*$/m.test(source)) {
        return source.replace(/^([ \t]*)package([ \t]+)/m, '$1ontology$2');
    }
    return inOntology(source);
}

/**
 * Files written as bare packages, made one ontology the way a model of several
 * files is one: each package says `in <name>`, and an ontology file bundles
 * it from its file. Before every package needed a declared ontology, a
 * `tonto.json` made the files of a folder one model; this is what says so
 * now. Packages that already say `in`, and files with a header, are left
 * alone. The entry is added only when something is bundled.
 */
export function bundled(files: Array<[string, string]>, name = 'model'): Array<[string, string]> {
    const bundles: string[] = [];
    const members = files.map(([path, text]): [string, string] => [path, /^\s*ontology\s/m.test(text) ? text
        : text.replace(/^([ \t]*package[ \t]+([\w.]+))\b(?![ \t]+in\b)/gm, (_, head: string, pkg: string) => {
            bundles.push(`    ${pkg} from <${path}>`);
            return `${head} in ${name}`;
        })]);
    return bundles.length ? [...members, [`${name}-entry.tonto`, `ontology ${name} bundles\n${bundles.join('\n')}\n`]] : files;
}

/**
 * A session whose snippets are given their ontology on the way in, by
 * `inOntology`, and whose repaired text comes back as the snippet wrote it.
 * Files it reads are its own business: a test about files writes them whole.
 */
export class OntologySession extends TontoSession {
    override validateText(source: string, name?: string): Promise<Reported[]> {
        return super.validateText(inOntology(source), name);
    }

    override async fixText(source: string, name?: string, only?: ReadonlySet<string>): Promise<{ text: string; applied: string[]; left: Reported[] }> {
        const fixed = await super.fixText(inOntology(source), name, only);
        return { ...fixed, text: withoutOntology(fixed.text) };
    }

    override digestOf(source: string, name?: string): Promise<Digest> {
        return super.digestOf(inOntology(source), name);
    }

    override async applyFix(source: string, code: string, title?: string, line?: number, columnOrName?: number | string, name?: string): Promise<Applied> {
        const applied = await (super.applyFix as (...args: unknown[]) => Promise<Applied>)(inOntology(source), code, title, line, columnOrName, name);
        return { ...applied, text: withoutOntology(applied.text) };
    }

    override compareText(before: string, after: string, name?: string): Promise<Difference> {
        return super.compareText(inOntology(before), inOntology(after), name);
    }
}
