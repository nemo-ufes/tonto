import type { AstNode } from 'langium';
import { docLinesAbove, parseDocLines } from '../documentation/doc-comment.js';

/**
 * Vocabularies a model's terms may not be minted in: the ones the export
 * builds on. A package published into one of them would redefine its terms.
 */
const RESERVED: readonly string[] = [
    'http://www.w3.org/2002/07/owl#',
    'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    'http://www.w3.org/2000/01/rdf-schema#',
    'http://www.w3.org/2001/XMLSchema#',
    'http://purl.org/nemo/gufo#'
];

/**
 * What is wrong with a namespace IRI written after `@namespace`, if anything.
 *
 * A namespace is an absolute `http` or `https` IRI that local names are
 * appended to, so it ends in `#` (a hash namespace, whose terms are all
 * described by one document) or in `/` (a slash namespace, where each term is
 * its own address). It has no query, a `#` only at its end, and none of the
 * characters an IRI cannot carry.
 */
export function namespaceProblem(value: string): string | undefined {
    if (value.length === 0) {
        return 'names no IRI';
    }
    if (/[\u0000- <>"{}|\\^`]/u.test(value) || /%(?![0-9A-Fa-f]{2})/u.test(value)) {
        return 'contains characters an IRI cannot carry';
    }
    for (const character of value) {
        const code = character.codePointAt(0)!;
        if (code === 0x200E || code === 0x200F || (code >= 0x202A && code <= 0x202E)
            || (code >= 0xFFF0 && code <= 0xFFFD)) {
            return 'contains characters an IRI cannot carry';
        }
    }
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return 'is not an absolute IRI';
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return 'is not an http or https IRI';
    }
    if (value.includes('?')) {
        return 'has a query';
    }
    const hash = value.indexOf('#');
    if (hash >= 0 && hash !== value.length - 1) {
        return 'has a "#" before its end';
    }
    if (!value.endsWith('#') && !value.endsWith('/')) {
        return 'ends in neither "#" nor "/", so a local name would run into it';
    }
    if (RESERVED.some(reserved => value === reserved)) {
        return 'is the namespace of a vocabulary the export builds on';
    }
    return undefined;
}

/** The `@namespace` written above a package, if one is. */
export function declaredNamespace(pkg: AstNode): string | undefined {
    return parseDocLines(docLinesAbove(pkg)).namespace;
}
