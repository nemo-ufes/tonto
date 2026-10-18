/**
 * The English a message has to get right.
 *
 * Two things kept going wrong. Articles: `a "kind"` but `an "event"`, and
 * four of the twenty-three stereotypes begin with a vowel -- which the
 * published specialization table shows in five hundred cells at once. And
 * chains: joining a cycle with one phrase produced "Every Department must
 * contain a Team must contain a Department", three clauses run together with
 * nothing between them.
 */

/** `a` or `an`, by how the word is spelled. */
export function article(word: string): string {
    return 'aeiou'.includes(word[0]?.toLowerCase() ?? '') ? 'an' : 'a';
}

/** A stereotype named in prose: `a "kind"`, `an "event"`. */
export function a(stereotype: string): string {
    return `${article(stereotype)} "${stereotype}"`;
}

/** The same, starting a sentence. */
export function capitalize(text: string): string {
    return `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`;
}

/**
 * A cycle, as a sentence: `A must contain a B, which must contain an A`.
 *
 * The first step reads straight on from the subject; every step after it is a
 * clause of its own, which is what keeps a cycle of three readable. `counts`
 * says whether the names are count nouns in this phrase: a whole contains *a*
 * part, but a type is an instance of another type, not of *a* another type.
 */
export function chain(names: readonly string[], phrase: string, counts = true): string {
    return names.slice(1).reduce(
        (text, name, index) =>
            `${text}${index === 0 ? '' : ', which'} ${phrase} ${counts ? `${article(name)} ` : ''}${name}`,
        names[0] ?? ''
    );
}
