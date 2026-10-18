import type { Reported, TontoSession } from './api.js';
import { explainText } from './cli/index.js';
import { guide } from './cli/guide.js';
import { catalog as patternCatalog, missingPattern } from './cli/patterns.js';
import { catalog as ruleCatalog } from './cli/rules.js';
import { tablesJson } from './cli/tables.js';
import { writeBeside, writeInto } from './exports.js';
import type { WrittenFile } from './exports.js';

/**
 * The tools agents call, defined once.
 *
 * Two hosts serve them: the MCP server, which Codex and Claude Code use, and
 * VS Code's language-model tools, which agents inside the editor use. Each
 * tool is written here once -- its name, what it is for, its parameters, what
 * it does and how its answer reads -- so the two offer the same tools with
 * the same parameters and the same words, and cannot drift apart. A host
 * supplies only what it alone knows: which files a call means, which
 * session answers it, where a write may go.
 *
 * Answers are compact text, written for a model to read: a diagnostic is a
 * line and its message, with its repairs by title. The full structure, repair
 * edits included, goes in `data`, for a host that passes structured content
 * on; a repair is taken with `tonto_apply`, by its title.
 */

/** The parameters a tool takes, as the JSON Schema both hosts read. */
export interface ToolInputSchema {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required?: string[];
}

export type ToolParameter =
    | { type: 'string' | 'boolean'; description: string }
    | { type: 'integer'; description: string; minimum: number }
    | { type: 'array'; items: { type: 'string' }; description: string }
    | { type: 'object'; additionalProperties: { type: 'string' }; description: string };

export interface ToolResult {
    text: string;
    /** The answer as data, for hosts that pass structured content on. */
    data?: Record<string, unknown>;
    isError?: boolean;
}

/** What a host's descriptions say about it: what differs between hosts, and an agent should know. */
export interface ToolCapabilities {
    /** Whether the advisory anti-patterns are checked, or whether a setting decides. */
    readonly antiPatterns: boolean | 'setting';
    /** What a call with neither source nor paths is about, when the host has a default. */
    readonly filesByDefault?: string;
}

/** VS Code's tools: a setting decides the anti-patterns, and a call about nothing is about the active model. */
export const VSCODE_CAPABILITIES: ToolCapabilities = {
    antiPatterns: 'setting',
    filesByDefault: 'it is about the active tonto file, or else the open workspace'
};

/** What a call needs from the host it runs in. */
export interface ToolHost extends ToolCapabilities {
    /**
     * The files a call is about. Given paths, the host resolves them; given
     * none, it supplies its default -- the editor's active model -- or
     * refuses with a `ToolError` saying what to give.
     */
    files(paths: string[] | undefined): string[];
    /** The session that answers about these files, or about text when there are none. */
    session(files?: string[]): TontoSession;
    /** A session checking the unmapped publication model, or with these mappings. */
    sessionWith(options: { publication?: boolean; locations?: Record<string, string> }, files?: string[]): TontoSession;
    /** The one workspace root a write or a listing may use, or a `ToolError` saying why there is none. */
    workspaceRoot(files?: string[]): string;
    /** How a file is named in an answer: relative to the workspace, as a person would say it. */
    display(file: string): string;
}

/** A problem with a call, said to the caller rather than thrown at it. */
export class ToolError extends Error {}

export interface ToolDefinition {
    name: string;
    /** A title for people: menus, tool pickers, logs. */
    title: string;
    /** What the tool is for, for the model choosing one: when first, then what comes back. */
    description(host: ToolCapabilities): string;
    input: ToolInputSchema;
    /** What a host shows while the tool runs. */
    progress: string;
    run(input: Record<string, unknown>, host: ToolHost): Promise<ToolResult>;
}

const SOURCE: ToolParameter = { type: 'string', description: 'The model as text.' };
const PATHS: ToolParameter = { type: 'array', items: { type: 'string' }, description: 'Files or directories, relative to the workspace, instead of source.' };
const PUBLICATION: ToolParameter = { type: 'boolean', description: 'Check the unmapped publication closure, offline.' };
const LOCATIONS: ToolParameter = { type: 'object', additionalProperties: { type: 'string' }, description: 'Location mappings, over the workspace\'s tonto.json.' };

/** One diagnostic per line, with its message and its repairs by title. */
export function renderDiagnostics(diagnostics: readonly Reported[], host?: Pick<ToolHost, 'display'>): string {
    if (diagnostics.length === 0) return 'No diagnostics. The model is valid.';
    return diagnostics.map(diagnostic => {
        const where = diagnostic.file && diagnostic.file !== 'draft' && host ? `${host.display(diagnostic.file)}:` : '';
        const fixes = diagnostic.fixes.length > 0 ? `\n    repairs: ${diagnostic.fixes.map(fix => fix.title).join(' | ')}` : '';
        return `${where}${diagnostic.line}:${diagnostic.column}  ${diagnostic.severity}  ${diagnostic.code}\n    ${diagnostic.message}${fixes}`;
    }).join('\n');
}

/**
 * Model text inside a fence the text cannot close: one backtick longer than
 * any run in it. Three would end at the first triple backtick in a model,
 * and what followed would read as prose addressed to the reader.
 */
export function fenced(source: string, language = 'tonto'): string {
    const longest = Math.max(0, ...[...source.matchAll(/`+/g)].map(run => run[0].length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return `${fence}${language}\n${source}\n${fence}`;
}

function string(input: Record<string, unknown>, key: string): string | undefined {
    const value = input[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new ToolError(`"${key}" must be a string.`);
    return value;
}

function required(input: Record<string, unknown>, key: string): string {
    const value = string(input, key);
    if (value === undefined) throw new ToolError(`"${key}" is required.`);
    return value;
}

function integer(input: Record<string, unknown>, key: string): number | undefined {
    const value = input[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value)) throw new ToolError(`"${key}" must be an integer.`);
    return value;
}

function flag(input: Record<string, unknown>, key: string): boolean | undefined {
    const value = input[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') throw new ToolError(`"${key}" must be true or false.`);
    return value;
}

function strings(input: Record<string, unknown>, key: string): string[] | undefined {
    const value = input[key];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some(one => typeof one !== 'string')) throw new ToolError(`"${key}" must be a list of strings.`);
    return value as string[];
}

function mappings(input: Record<string, unknown>, key: string): Record<string, string> | undefined {
    const value = input[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.values(value).some(one => typeof one !== 'string')) {
        throw new ToolError(`"${key}" must map locations to locations.`);
    }
    return value as Record<string, string>;
}

/** Text or files, never both: both is a caller who thinks the answer covers the files too. */
function sourceOrFiles(input: Record<string, unknown>, host: ToolHost): { source?: string; files?: string[] } {
    const source = string(input, 'source');
    const paths = strings(input, 'paths');
    if (source !== undefined && paths?.length) {
        throw new ToolError('Give either source or paths, not both: text and files are two questions, and only the text would be answered.');
    }
    return source !== undefined ? { source } : { files: host.files(paths?.length ? paths : undefined) };
}

/** The session a call with these options uses: the host's own, unless it asks for publication or mappings. */
function sessionFor(input: Record<string, unknown>, host: ToolHost, files?: string[]): TontoSession {
    const publication = flag(input, 'publication');
    const locations = mappings(input, 'locations');
    return publication || locations ? host.sessionWith({ publication, locations }, files) : host.session(files);
}

function some<T>(all: readonly T[], render: (one: T) => string, limit = 20): string[] {
    return [...all.slice(0, limit).map(render), ...(all.length > limit ? [`... and ${all.length - limit} more`] : [])];
}

export const TOOLS: readonly ToolDefinition[] = [
    {
        name: 'tonto_guide',
        title: 'The tonto language in one page',
        progress: 'Reading the tonto language guide…',
        description: () => 'Read before writing tonto, or when unsure which stereotype, nature or association fits. '
            + 'The language in one page, generated from the tables the validator reads: every stereotype and what it '
            + 'classifies, the principles that decide specialization, every association signature, and ontologies, '
            + 'packages and files.',
        input: { type: 'object', properties: {} },
        run: async () => ({ text: guide() })
    },
    {
        name: 'tonto_validate',
        title: 'Validate a tonto model',
        progress: 'Validating the tonto model…',
        description: host => 'Run after every edit, and before saying a model is valid. Checks a model given as text '
            + 'or as files and returns each diagnostic: position, stable code, message and repairs by title (take one '
            + 'with tonto_apply; tonto_rules says what a code means). '
            + (host.filesByDefault ? `With neither source nor paths, ${host.filesByDefault}. ` : '')
            + (host.antiPatterns === 'setting' ? 'Anti-patterns (RelOver, RepRel, DepPhase and the rest) are reported when the tonto.antiPatterns setting is on.'
                : `Anti-patterns (RelOver, RepRel, DepPhase and the rest) are ${host.antiPatterns ? '' : 'not '}reported here.`),
        input: { type: 'object', properties: { source: SOURCE, paths: PATHS, publication: PUBLICATION, locations: LOCATIONS } },
        run: async (input, host) => {
            const { source, files } = sourceOrFiles(input, host);
            const session = sessionFor(input, host, files);
            const diagnostics = source !== undefined ? await session.validateText(source) : await session.validateFiles(files!);
            return { text: renderDiagnostics(diagnostics, host), data: { diagnostics } };
        }
    },
    {
        name: 'tonto_repair',
        title: 'Apply the repairs the rules force',
        progress: 'Computing safe tonto repairs…',
        description: () => 'Use to clear the mechanical problems in one step. Returns the model with every repair applied '
            + 'that its rule offers alone, and the diagnostics left. Where a rule offers a choice nothing is written: '
            + 'choosing is modeling, done with tonto_apply. Never writes files.',
        input: { type: 'object', properties: { source: SOURCE }, required: ['source'] },
        run: async (input, host) => {
            const { text, applied, left } = await host.session().fixText(required(input, 'source'));
            const summary = applied.length > 0 ? `Applied: ${applied.join(' | ')}`
                : left.length === 0 ? 'Nothing needed repair.' : 'Nothing could be repaired without choosing.';
            return { text: `${summary}\n\n${fenced(text)}\n\n${renderDiagnostics(left)}`, data: { text, applied, remaining: left } };
        }
    },
    {
        name: 'tonto_apply',
        title: 'Apply one repair, by title',
        progress: 'Applying the chosen tonto repair…',
        description: () => 'Use to take one repair after tonto_validate, above all where a rule offers several: the choice '
            + 'is a modeling decision, so say which and why. Name the code, the repair title, and the line and column '
            + 'where the code is reported more than once, as tonto_validate gives them. Returns the revised model and '
            + 'what is left; refuses to guess. Never writes files.',
        input: {
            type: 'object',
            properties: {
                source: SOURCE,
                code: { type: 'string', description: 'The diagnostic code, e.g. add-only-with-nothing-to-add.' },
                title: { type: 'string', description: 'The repair title, where the rule offers more than one.' },
                line: { type: 'integer', minimum: 1, description: 'One-based line of the occurrence, where the code is reported more than once.' },
                column: { type: 'integer', minimum: 1, description: 'One-based column, where it is reported twice on one line.' }
            },
            required: ['source', 'code']
        },
        run: async (input, host) => {
            const { text, applied, left } = await host.session().applyFix(required(input, 'source'), required(input, 'code'),
                string(input, 'title'), integer(input, 'line'), integer(input, 'column'));
            return { text: `Applied: ${applied}\n\n${fenced(text)}\n\n${renderDiagnostics(left)}`, data: { text, applied, remaining: left } };
        }
    },
    {
        name: 'tonto_diff',
        title: 'What an edit did to a model',
        progress: 'Comparing the tonto edit…',
        description: () => 'Use after editing a model, to tell whether the edit was a step backwards. Validates the model '
            + 'before and after and says which diagnostics the edit introduced, resolved and left.',
        input: {
            type: 'object',
            properties: {
                before: { type: 'string', description: 'The model as it was.' },
                after: { type: 'string', description: 'The model as it is now.' }
            },
            required: ['before', 'after']
        },
        run: async (input, host) => {
            const difference = await host.session().compareText(required(input, 'before'), required(input, 'after'));
            const part = (title: string, reported: readonly Reported[]): string =>
                reported.length === 0 ? '' : `\n\n${title}:\n${renderDiagnostics(reported)}`;
            const verdict = difference.introduced.length > 0 ? 'This edit introduced something.'
                : difference.resolved.length > 0 ? 'This edit resolved something and introduced nothing.'
                    : 'This edit changed no diagnostic.';
            return {
                text: verdict + part('Introduced', difference.introduced) + part('Resolved', difference.resolved) + part('Left', difference.left),
                data: { ...difference }
            };
        }
    },
    {
        name: 'tonto_complete',
        title: 'What may be written here',
        progress: 'Computing tonto completions…',
        description: () => 'Use instead of guessing what belongs at a position: the classes a relation end admits given its '
            + 'stereotype and the other end, the ends a class may subset, the stereotypes it could take. Returns the '
            + 'proposals an editor would offer. Line and character count from 0.',
        input: {
            type: 'object',
            properties: {
                source: { type: 'string', description: 'The model as text, as far as it is written.' },
                line: { type: 'integer', minimum: 0, description: 'Zero-based line of the cursor.' },
                character: { type: 'integer', minimum: 0, description: 'Zero-based character of the cursor.' }
            },
            required: ['source', 'line', 'character']
        },
        run: async (input, host) => {
            const line = integer(input, 'line');
            const character = integer(input, 'character');
            if (line === undefined || character === undefined) throw new ToolError('"line" and "character" are required.');
            const proposals = await host.session().completionsAt(required(input, 'source'), line, character);
            const text = proposals.length === 0
                ? 'Nothing belongs here that the language can name: a name of your own, or nothing at all.'
                : proposals.map(one => `${one.label}${one.kind ? `  (${one.kind})` : ''}${one.detail ? `\n    ${one.detail}` : ''}`
                    + `${one.insertText ? `\n    writes: ${one.insertText}` : ''}`).join('\n');
            return { text, data: { proposals } };
        }
    },
    {
        name: 'tonto_digest',
        title: 'A model read for review',
        progress: 'Reading the tonto model…',
        description: () => 'Use to review a model, rather than reading its text: the ultimate sortals and what hangs off '
            + 'each, what every relator binds, the relations by stereotype, the generalization sets, and the hints -- '
            + 'what the model has not said yet. Use tonto_ast for the tree itself.',
        input: { type: 'object', properties: { source: SOURCE }, required: ['source'] },
        run: async (input, host) => {
            const digest = await host.session().digestOf(required(input, 'source'));
            const lines = [
                digest.errors > 0 ? `${digest.errors} error${digest.errors === 1 ? '' : 's'}: what follows is read from a model `
                    + 'that does not validate, and may be partial. Call tonto_validate.' : '',
                `packages: ${digest.packages.join(', ') || 'none'}`,
                `stereotypes: ${Object.entries(digest.stereotypes).map(([word, n]) => `${word} ${n}`).join(', ') || 'none'}`,
                `relations: ${Object.entries(digest.relations).map(([word, n]) => `${word} ${n}`).join(', ') || 'none'}`,
                ...some(digest.ultimateSortals, one => `${one.stereotype} ${one.name}`
                    + (one.under.length ? ` <- ${one.under.slice(0, 12).join(', ')}${one.under.length > 12 ? `, and ${one.under.length - 12} more` : ''}`
                        : ' (nothing under it)')),
                ...some(digest.relators, one => `relator ${one.name} binds ${one.mediates.join(', ') || 'nothing'}`),
                ...some(digest.gensets, one => `genset ${one.name}${one.disjoint ? ' disjoint' : ''}${one.complete ? ' complete' : ''}: `
                    + `${one.specifics.join(', ')} under ${one.general ?? '?'}`),
                digest.values.length ? `values: ${digest.values.join(', ')}` : '',
                digest.warnings > 0 ? `${digest.warnings} warning${digest.warnings === 1 ? '' : 's'}, from tonto_validate` : '',
                digest.unsaid.length ? `\nleft unsaid:\n${some(digest.unsaid, one => `  ${one.code}: ${one.message}`).join('\n')}` : ''
            ].filter(Boolean);
            return { text: lines.join('\n'), data: { ...digest } };
        }
    },
    {
        name: 'tonto_hold',
        title: 'Hold a file beside the draft',
        progress: 'Holding a tonto file…',
        description: () => 'Use while drafting a model of several files that are not on disk yet: a held file is one that '
            + 'later calls resolve against, named as a path without ".tonto" relative to the other held files (an ontology '
            + 'file held as "shop" that bundles "sales from <sales/orders.tonto>" finds a package file held as '
            + '"sales/orders"). Returns the held file\'s own diagnostics. Omit source to release a file; omit name to list '
            + 'what is held.',
        input: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'What to call the file. Omit to list what is held.' },
                source: { type: 'string', description: 'The file as text. Omit to release the named one.' }
            }
        },
        run: async (input, host) => {
            const session = host.session();
            const name = string(input, 'name');
            const source = string(input, 'source');
            if (name === undefined) {
                const held = session.holding();
                return { text: held.length === 0 ? 'Nothing held.' : held.map(one => `${one.name} (${one.lines} lines)`).join('\n'), data: { held } };
            }
            if (source === undefined) {
                const was = await session.release(name);
                return { text: was ? `Released "${name}".` : `Nothing was held under "${name}".`, data: { released: was, held: session.holding() } };
            }
            const reported = await session.hold(name, source);
            return { text: `Holding "${name}". Later calls resolve against it.\n\n${renderDiagnostics(reported)}`, data: { held: session.holding(), diagnostics: reported } };
        }
    },
    {
        name: 'tonto_format',
        title: 'Lay a model out canonically',
        progress: 'Formatting the tonto source…',
        description: () => 'Use before handing a model back, so its diffs stay small. Returns the model with indented bodies, '
            + 'normalized spacing and one declaration per line, keeping the author\'s blank lines. Never writes files.',
        input: { type: 'object', properties: { source: SOURCE }, required: ['source'] },
        run: async (input, host) => {
            const text = await host.session().formatText(required(input, 'source'));
            return { text: fenced(text), data: { text } };
        }
    },
    {
        name: 'tonto_ast',
        title: 'The parsed model as JSON',
        progress: 'Parsing the tonto source…',
        description: () => 'Use for exact questions about structure -- counting declarations, finding classes that lack '
            + 'something, checking a convention the validator does not encode. Returns the syntax tree as JSON, each '
            + 'declaration with its /// documentation as $documentation; refused for a model with errors.',
        input: { type: 'object', properties: { source: SOURCE }, required: ['source'] },
        run: async (input, host) => {
            const source = required(input, 'source');
            const session = host.session();
            const diagnostics = await session.validateText(source);
            const ast = await session.astOf(source);
            const errors = diagnostics.filter(diagnostic => diagnostic.severity === 'error');
            if (errors.length > 0) {
                return { isError: true, text: `The source has errors, so its partial tree is not returned as a model.\n\n${renderDiagnostics(errors)}`, data: { ast, diagnostics } };
            }
            return { text: JSON.stringify(ast), data: { ast, diagnostics } };
        }
    },
    {
        name: 'tonto_rules',
        title: 'What a diagnostic means',
        progress: 'Reading the tonto rules…',
        description: () => 'Use with a diagnostic code before repairing it. Returns the rule: why it exists, the smallest '
            + 'model that trips it, its message and its repairs. Without a code, every rule.',
        input: { type: 'object', properties: { code: { type: 'string', description: 'A diagnostic code, e.g. parthood-crosses-natures.' } } },
        run: async input => {
            const code = string(input, 'code');
            const all = await ruleCatalog();
            const rules = code === undefined ? all : all.filter(rule => rule.code === code);
            if (rules.length === 0) throw new ToolError(`No rule "${code}". Call without a code for the list.`);
            const text = rules.map(rule => `${rule.code}  [${rule.group}, ${rule.severity}]\n  ${rule.rationale}\n`
                + rule.example.split('\n').map(line => `      ${line}`).join('\n')
                + (rule.message ? `\n  -> ${rule.message}` : '')
                + (rule.fixes.length > 0 ? `\n  repairs: ${rule.fixes.join(' | ')}` : '')).join('\n\n');
            return { text, data: { rules } };
        }
    },
    {
        name: 'tonto_patterns',
        title: 'The modeling patterns',
        progress: 'Reading the tonto patterns…',
        description: () => 'Use before inventing the shape of a model: a role and the relator that founds it, parthood, '
            + 'events, multi-level types. Returns validated patterns from the UFO and multi-level literature and gUFO, each '
            + 'a small model with what it is for and what is easy to get wrong. Name one to get only that one.',
        input: { type: 'object', properties: { name: { type: 'string', description: 'A pattern name, e.g. "role-and-relator". Omit for all.' } } },
        run: async input => {
            const name = string(input, 'name');
            const all = await patternCatalog();
            const patterns = name === undefined ? all : all.filter(pattern => pattern.name === name);
            if (patterns.length === 0) throw new ToolError(missingPattern(name ?? ''));
            const text = patterns.map(pattern => `${pattern.name}  [${pattern.group}]  ${pattern.title}\n  ${pattern.intent}\n  ${pattern.note}\n`
                + pattern.model.split('\n').map(line => `      ${line}`).join('\n') + `\n  -- ${pattern.source}`).join('\n\n');
            return { text, data: { patterns } };
        }
    },
    {
        name: 'tonto_explain',
        title: 'Ask the language a question',
        progress: 'Consulting the tonto tables…',
        description: () => 'Use to settle a question without writing a model: may one class stereotype specialize another, '
            + 'and if not which principle refuses it; or, for an association stereotype written with its "@", what it '
            + 'relates and whether it may run between two natures.',
        input: {
            type: 'object',
            properties: {
                subject: { type: 'string', description: 'A class stereotype, or an association stereotype as "@membership".' },
                object: { type: 'string', description: 'The stereotype it would specialize, or the source nature.' },
                target: { type: 'string', description: 'For an association, the target nature.' }
            },
            required: ['subject']
        },
        run: async input => {
            const subject = required(input, 'subject');
            const object = string(input, 'object');
            const target = string(input, 'target');
            const association = subject.startsWith('@');
            if (association && (object === undefined) !== (target === undefined)) {
                throw new ToolError('Give both source and target natures for an association, or neither.');
            }
            if (!association && target !== undefined) {
                throw new ToolError('Target is part of an association question only; class specialization takes subject and object.');
            }
            const words = association && object !== undefined ? [subject, object, target!] : object !== undefined ? [subject, object] : [subject];
            const { text, problem } = await explainText(words);
            if (problem !== undefined) throw new ToolError(problem.trim());
            return { text: text.trim() };
        }
    },
    {
        name: 'tonto_tables',
        title: 'The reference tables',
        progress: 'Reading the tonto reference tables…',
        description: () => 'Use only for a question tonto_explain and tonto_guide do not answer. Returns, as JSON, the '
            + 'tables the checks read: what each class stereotype classifies, which may specialize which, what each '
            + 'association stereotype admits at each end, and the parthood pairs.',
        input: { type: 'object', properties: {} },
        run: async () => {
            const tables = await tablesJson();
            return { text: JSON.stringify(tables), data: tables as unknown as Record<string, unknown> };
        }
    },
    {
        name: 'tonto_ontologies',
        title: 'The ontologies of the workspace',
        progress: 'Listing the workspace\'s ontologies…',
        description: () => 'Use to find out what a workspace holds before exporting or adding to it. Returns each ontology '
            + 'it authors: name, ontology file, namespace if its header gives one, and how many errors it has. '
            + 'Dependencies and unbundled packages are not listed.',
        input: { type: 'object', properties: {} },
        run: async (_input, host) => {
            host.workspaceRoot();
            const ontologies = await host.session().ontologies();
            const text = ontologies.length === 0 ? 'No ontology header in the workspace.'
                : ontologies.map(ontology => `${ontology.name}  ${host.display(ontology.file)}  ${ontology.namespace ?? '(no namespace)'}`
                    + (ontology.errors ? `  ${ontology.errors} error${ontology.errors === 1 ? '' : 's'}` : '')).join('\n');
            return { text, data: { ontologies } };
        }
    },
    {
        name: 'tonto_gufo',
        title: 'Export to gUFO',
        progress: 'Mapping tonto to gUFO…',
        description: host => 'Use to preview or regenerate an ontology\'s gUFO-aligned OWL. Checks the model and returns its '
            + 'Turtle, one document per ontology, or nothing when anything has an error. With paths, write puts each '
            + '<name>.ttl beside its ontology file, as the editor\'s gUFO export does, and outDir puts them in one '
            + 'workspace directory instead. Edit the .tonto source, never the Turtle.'
            + (host.filesByDefault ? ` With neither source nor paths, ${host.filesByDefault}.` : ''),
        input: {
            type: 'object',
            properties: {
                source: SOURCE,
                paths: PATHS,
                write: { type: 'boolean', description: 'Write each ontology\'s Turtle beside its ontology file. Needs paths.' },
                outDir: { type: 'string', description: 'A workspace-relative directory to write into instead. Needs paths.' },
                namespaceIri: { type: 'string', description: 'The exact namespace, ending in # or /, for the one exported ontology whose header has none; as "/// @namespace".' },
                snapshot: { type: 'boolean', description: 'Also write the snapshot layer and its SHACL shapes, for a graph of current state.' },
                directSpecializations: { type: 'boolean', description: 'Also write the direct rdfs:subClassOf triples gufoshapes reads without inference.' },
                publication: PUBLICATION,
                locations: LOCATIONS
            }
        },
        run: async (input, host) => {
            const write = flag(input, 'write') === true;
            const outDir = string(input, 'outDir');
            if (write && outDir !== undefined) throw new ToolError('Give write or outDir, not both.');
            const { source, files } = sourceOrFiles(input, host);
            const writing = write || outDir !== undefined;
            if (writing && source !== undefined) throw new ToolError('Writing an export needs saved files as paths, not source text.');
            const root = writing ? host.workspaceRoot(files) : undefined;
            const options = {
                namespaceIri: string(input, 'namespaceIri'),
                snapshot: flag(input, 'snapshot'),
                directSpecializations: flag(input, 'directSpecializations')
            };
            const session = sessionFor(input, host, files);
            const result = source !== undefined ? await session.gufoText(source, options) : await session.gufoFiles(files!, options);
            const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === 'error');
            const notices = result.diagnostics.length === 0 ? 'No export diagnostics.'
                : result.diagnostics.map(diagnostic => `${diagnostic.file ? `${host.display(diagnostic.file)}:` : ''}${diagnostic.line}:${diagnostic.column}  `
                    + `${diagnostic.severity}  ${diagnostic.code}\n    ${diagnostic.message}`).join('\n');
            let written: WrittenFile[] = [];
            if (errors.length === 0 && writing) {
                try {
                    written = write ? writeBeside(result.files, root) : writeInto(root!, outDir!, result.files);
                } catch (error) {
                    throw new ToolError(`Could not write the gUFO export: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            const documents = written.length > 0
                ? `Wrote ${written.length} file${written.length === 1 ? '' : 's'}:\n${written.map(file => `- ${host.display(file.path)}`).join('\n')}`
                : result.files.map(file => `# ${file.file} -- <${file.ontology}>${file.shapes ? ' (SHACL shapes)' : file.snapshot ? ' (snapshot layer)' : ''}\n`
                    + fenced(file.content, 'turtle')).join('\n\n');
            return {
                ...(errors.length > 0 ? { isError: true } : {}),
                text: documents ? `${documents}\n\n${notices}` : notices,
                data: { files: result.files, written, publicationVerified: result.publicationVerified ?? false, diagnostics: result.diagnostics }
            };
        }
    },
    {
        name: 'tonto_fetch',
        title: 'Retrieve the imported ontologies',
        progress: 'Retrieving ontology dependencies…',
        description: () => 'Use when validation reports an import that is not cached: checking never goes to the network, '
            + 'and this is the one call that does. Retrieves the ontology files the model imports by location, and the '
            + 'package files they bundle, into the workspace\'s .tonto cache. refresh replaces them all.',
        input: {
            type: 'object',
            properties: {
                paths: { type: 'array', items: { type: 'string' }, description: 'Ontology files or directories whose dependencies to retrieve.' },
                refresh: { type: 'boolean', description: 'Retrieve everything again, replacing the cached copies.' },
                publication: { type: 'boolean', description: 'Retrieve the original locations, ignoring the mappings.' },
                locations: LOCATIONS
            },
            required: ['paths']
        },
        run: async (input, host) => {
            const files = host.files(strings(input, 'paths'));
            host.workspaceRoot(files);
            const session = host.sessionWith({ publication: flag(input, 'publication'), locations: mappings(input, 'locations') }, files);
            try {
                const result = await session.fetch(files, { refresh: flag(input, 'refresh') });
                const list = (title: string, items: readonly string[]): string => items.length ? `\n${title}: ${items.join(', ')}` : '';
                return {
                    text: `Retrieved ${result.retrieved.length}, reused ${result.cached.length} from the cache.`
                        + list('New', result.added) + list('Changed', result.changed) + list('Removed', result.removed),
                    data: { ...result }
                };
            } catch (error) {
                throw new ToolError(error instanceof Error ? error.message : String(error));
            }
        }
    }
];

/** Runs a tool, turning a problem with the call into an answer that says so. */
export async function runTool(name: string, input: Record<string, unknown>, host: ToolHost): Promise<ToolResult> {
    const tool = TOOLS.find(one => one.name === name);
    if (!tool) return { isError: true, text: `No tonto tool "${name}".` };
    try {
        return await tool.run(input ?? {}, host);
    } catch (error) {
        if (error instanceof ToolError) return { isError: true, text: error.message };
        throw error;
    }
}

/**
 * The tools as VS Code's `languageModelTools` contribution, which the
 * extension's package.json must declare statically. A test keeps the two the
 * same; `npm run tools:sync` in the extension writes it.
 */
export function vscodeToolContributions(capabilities: ToolCapabilities): Array<Record<string, unknown>> {
    return TOOLS.map(tool => ({
        name: tool.name,
        displayName: tool.title,
        toolReferenceName: tool.name.replace(/^tonto_/, 'tonto').replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
            .replace(/^tonto([a-z])/, (_, letter: string) => `tonto${letter.toUpperCase()}`),
        canBeReferencedInPrompt: true,
        userDescription: tool.title,
        modelDescription: tool.description(capabilities),
        inputSchema: tool.input
    }));
}
