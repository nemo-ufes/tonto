import { LangiumParserErrorMessageProvider } from 'langium';
import type { IToken, TokenType } from 'chevrotain';

/**
 * What the parser says when no alternative fits.
 *
 * Chevrotain's own message lists every token sequence any alternative could
 * begin with, and tonto lets nearly every keyword stand as a name, so one
 * slip -- a single dash for `--`, a relation stereotype on an attribute --
 * was answered with 189 sequences and five kilobytes. What helps is the
 * first token of each, once: `Expecting '--', '<>--' or '--<>' but found
 * `finishedAt``. A keyword that could equally be a name is counted as one.
 */
export class TontoParserErrorMessageProvider extends LangiumParserErrorMessageProvider {

    override buildNoViableAltMessage(options: { expectedPathsPerAlt: TokenType[][][]; actual: IToken[] }): string {
        return expecting(options.expectedPathsPerAlt.flat(), options.actual[0]);
    }

    override buildEarlyExitMessage(options: { expectedIterationPaths: TokenType[][]; actual: IToken[] }): string {
        return expecting(options.expectedIterationPaths, options.actual[0]);
    }

    /** One token expected: said in the same words, `token of type '}'` being Chevrotain's. */
    override buildMismatchTokenMessage(options: { expected: TokenType; actual: IToken }): string {
        return expecting([[options.expected]], options.actual);
    }
}

/** How a terminal is named to someone writing a model rather than a parser. */
const TERMINALS: Record<string, string> = {
    ID: 'a name', INT: 'a number', STRING: 'a quoted string', LOCATION: 'a location in angle brackets', EOF: 'the end of the file'
};

/** At most this many alternatives are named; beyond it the message says how many more. */
const NAMED = 8;

function expecting(paths: TokenType[][], actual: IToken | undefined): string {
    const firsts = new Map<string, string>();
    let name = false;
    for (const path of paths) {
        const token = path[0];
        if (!token) continue;
        if (token.name === 'ID' || (!TERMINALS[token.name] && /^[A-Za-z][\w-]*$/.test(token.name))) {
            // A word: the identifier itself, or a keyword that a name may be
            // spelled with. Either way what fits here is a name.
            name = true;
            continue;
        }
        firsts.set(token.name, TERMINALS[token.name] ?? `'${token.LABEL ?? token.name}'`);
    }
    const options = [...firsts.values()];
    if (name) options.unshift('a name');
    const found = actual && actual.image && actual.tokenType?.name !== 'EOF' ? `\`${actual.image}\`` : 'the end of the file';
    if (options.length === 0) {
        return `Unexpected ${found}.`;
    }
    const shown = options.slice(0, NAMED);
    const rest = options.length - shown.length;
    const list = shown.length === 1 ? shown[0]
        : `${shown.slice(0, -1).join(', ')}${rest > 0 ? ', ' : ' or '}${shown.at(-1)}${rest > 0 ? ` or ${rest} more` : ''}`;
    return `Expecting ${list} but found ${found}.`;
}
