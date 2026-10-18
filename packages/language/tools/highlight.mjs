/**
 * Coloring for the models on the published pages.
 *
 * Both pages print tonto, and both printed it the same way; this is that,
 * once. Deliberately not a parser -- the models are a few lines each, and a
 * lexer's worth of machinery here would be a second grammar to keep in step
 * with the first.
 */
import { STEREOTYPES } from '../out/validation/stereotype-model.js';

export function escape(text) {
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

export function highlight(source) {
    return source.split('\n').map(line => {
        if (line.trimStart().startsWith('//')) {
            return `<span class="c-note">${escape(line)}</span>`;
        }
        let out = '';
        let at = 0;
        for (const match of line.matchAll(/@[A-Za-z]\w*|\[[^\]]*\]|[A-Za-z_]\w*/g)) {
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
