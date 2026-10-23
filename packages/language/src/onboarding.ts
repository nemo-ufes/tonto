import { basename } from 'node:path';

/**
 * Starting a tonto workspace, in the words every host uses for it.
 *
 * The editor's New Ontology... and Set Up Codex and Claude, the command
 * line's `tonto new` and `tonto init`, and the `tonto_new` tool each start an
 * ontology or set up a folder for agents. What they write is decided here,
 * once: the name an ontology may have, the file it starts as, and how a
 * folder's agent instructions are added to or brought up to date without
 * touching anything else in the file. Nothing here reads or writes a file,
 * so the extension can bundle it.
 */

/** An ontology's name: one identifier, entirely lowercase. */
const ONTOLOGY_NAME = /^[a-z][a-z0-9_]*$/;

export function validOntologyName(value: string): boolean {
    return ONTOLOGY_NAME.test(value);
}

export const ONTOLOGY_NAME_HINT = 'Use one lower-case name, for example "sales" or "university".';

/** The name a folder suggests for its first ontology: `Car Rentals` gives `car_rentals`. */
export function defaultOntologyName(folder: string): string {
    const normalized = basename(folder)
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return /^[a-z]/.test(normalized) ? normalized : normalized ? `model_${normalized}` : 'model';
}

/**
 * A new one-file ontology. The first of a workspace starts with one
 * documented class, so that whoever opens it sees what a declaration and its
 * documentation look like; a later one starts with its header alone, since
 * its author has seen that already.
 */
export function starterOntology(name: string, sample: boolean): string {
    return sample
        ? `ontology ${name}\n\n/// A person, in the everyday sense.\nkind Person\n`
        : `ontology ${name}\n\n`;
}

/**
 * Where tonto's block of agent instructions begins and ends in a folder's
 * `AGENTS.md`. Two blocks are written: the editor's, for agents with the tonto
 * tools, and the command line's, for agents with the installed CLI alone. They
 * end alike and begin differently, so each setup can tell whose block is
 * there -- the editor's replaces the command line's, since it covers the
 * command line too, and the command line leaves the editor's alone.
 */
export const EDITOR_INSTRUCTIONS_START = '<!-- tonto-model-instructions -->';
export const CLI_INSTRUCTIONS_START = '<!-- tonto-model-instructions (cli) -->';
export const INSTRUCTIONS_END = '<!-- /tonto-model-instructions -->';
/** How every version of the editor's instructions ended, before they carried an end marker. */
const OLD_LAST_LINE = 'changing the source model.';

/** Whose tonto instructions a file holds, if any. */
export function instructionsIn(text: string): 'editor' | 'cli' | undefined {
    const editor = text.indexOf(EDITOR_INSTRUCTIONS_START);
    const cli = text.indexOf(CLI_INSTRUCTIONS_START);
    if (editor < 0 && cli < 0) return undefined;
    return cli < 0 || (editor >= 0 && editor < cli) ? 'editor' : 'cli';
}

/**
 * The file with tonto's block replaced by `template`, or `template` added at
 * the end when it has none, so that running a setup again brings the
 * instructions up to date. Only the block is touched: from its start marker
 * to its end marker, or, in an editor block written before there was one, to
 * the line every earlier version ended with. A block whose end cannot be
 * found is left as it is rather than guessed at.
 */
export function withTontoInstructions(current: string, template: string): string {
    const starts = [EDITOR_INSTRUCTIONS_START, CLI_INSTRUCTIONS_START]
        .map(marker => current.indexOf(marker)).filter(index => index >= 0);
    if (starts.length === 0) return appended(current, template);
    const start = Math.min(...starts);
    let end = current.indexOf(INSTRUCTIONS_END, start);
    if (end >= 0) {
        end += INSTRUCTIONS_END.length;
    } else {
        const last = current.indexOf(OLD_LAST_LINE, start);
        if (last < 0) return current;
        end = last + OLD_LAST_LINE.length;
    }
    return current.slice(0, start) + template.trim() + current.slice(end);
}

/** What Claude Code reads `AGENTS.md` by: `CLAUDE.md` importing it. */
export const AGENTS_IMPORT = '@AGENTS.md\n';

/** `CLAUDE.md` importing `AGENTS.md`, added at its end when it does not already. */
export function withAgentsImport(current: string): string {
    return /(?:^|\n)@AGENTS\.md(?:\s|$)/.test(current) ? current : appended(current, AGENTS_IMPORT);
}

function appended(current: string, addition: string): string {
    return current.trim().length === 0 ? addition.trimStart() : `${current.trimEnd()}\n\n${addition.trimStart()}`;
}
