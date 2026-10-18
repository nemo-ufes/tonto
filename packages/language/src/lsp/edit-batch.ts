import type { CodeAction, TextEdit } from 'vscode-languageserver';

/**
 * Choosing which of several repairs may be applied in one pass.
 *
 * Shared by the two things that apply repairs without anyone reading them:
 * `TontoSession.fixText`/`fixFiles`, which is what `tonto check --fix` runs,
 * and the `source.fixAll` action, which is the same thing inside an editor.
 * Both have to answer the same two questions -- is this repair safe to apply
 * unread, and does it collide with one already taken -- and answering them
 * twice is how the two would come to disagree.
 */

/**
 * Whether a repair may be applied without anyone reading the diagnostic.
 *
 * Set by the code action provider, which is what knows: a repair forced by
 * its rule is safe, one that picks between readings of a model is not. An
 * action without the mark is treated as unsafe, so a repair added and not
 * classified is left rather than applied.
 */
export function isBatchSafe(action: CodeAction): boolean {
    return (action.data as { batchSafe?: boolean } | undefined)?.batchSafe === true;
}

/**
 * Whether a repair may be applied this round, claiming the lines it touches.
 *
 * Two repairs to one line are two repairs to one construct often enough that
 * applying both blindly produced text that did not parse: `(const)` and
 * `addOnly` inserted at the same brace, `specializes X` written twice at one
 * point, a decorator landing on the wrong side of a multiplicity another
 * repair was inserting. One per line per round, and the caller takes the next
 * one on the round after -- nothing is lost but a pass.
 */
export function claimLines(taken: Map<string, Set<number>>, changes: Array<[string, TextEdit[]]>): boolean {
    const wanted = changes.map(([uri, edits]) => [uri, edits.flatMap(edit => {
        const lines = [];
        for (let line = edit.range.start.line; line <= edit.range.end.line; line++) {
            lines.push(line);
        }
        return lines;
    })] as const);
    // Checked in full before anything is claimed: a repair that writes into
    // two files goes in whole or not at all.
    if (wanted.some(([uri, lines]) => lines.some(line => taken.get(uri)?.has(line)))) {
        return false;
    }
    for (const [uri, lines] of wanted) {
        const claimed = taken.get(uri) ?? new Set<number>();
        lines.forEach(line => claimed.add(line));
        taken.set(uri, claimed);
    }
    return true;
}
