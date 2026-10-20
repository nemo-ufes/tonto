import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { collectFiles, workspaceRootOf, TontoSession } from '../api.js';
import { writeBeside } from '../exports.js';
import type { GufoDiagnostic, GufoResult } from '../gufo.js';
import { article } from '../validation/wording.js';
import { fetchSummary, parseLocations } from '../publication/workspace.js';
import packageJson from '../../package.json' with { type: 'json' };

const SEVERITY = ['error', 'warning', 'information', 'hint'] as const;
let VERSION = packageJson.version;
// The marker sits beside a linked checkout's own files. Bundled as CommonJS
// into the extension, this module has no URL of its own -- import.meta is
// empty -- and resolving against it would fail the extension's activation.
if (import.meta.url) {
    try {
        const developmentVersion = readFileSync(new URL('../../.tonto-dev-version', import.meta.url), 'utf8').trim();
        if (developmentVersion) VERSION = developmentVersion;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
}

export interface CheckOptions {
    locations?: Record<string, string>;
    publication?: boolean;
    json: boolean;
    fix: boolean;
    /** Load this directory as the model instead of deriving it from the paths. */
    workspace?: string;
    /** Load only the files named, whatever else the model contains. */
    isolated?: boolean;
    /** When set, only these diagnostic codes are repaired. */
    only?: ReadonlySet<string>;
    antiPatterns: boolean;
}

/**
 * Validation without an editor.
 *
 * Everything the language server knows is otherwise reachable only over LSP,
 * which is fine for a person and useless for anything else -- a script, a CI
 * job, an agent writing a model and wanting to know whether it holds. This is
 * the same services, the same checks and the same repairs, over files.
 */

/** Everything on stdin, for `-` where a path would go. */
async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
}

export async function check(paths: string[], options: CheckOptions): Promise<number> {
    if (paths.includes('-')) {
        return checkStdin(options);
    }
    // No path means this directory, and it has to mean that to everything
    // below: naming the files but leaving the workspace empty loaded nothing,
    // and the report then said `0 error` about files it had never read.
    const targets = paths.length > 0 ? paths : ['.'];
    const files = collectFiles(targets);
    if (files.length === 0) {
        process.stderr.write('no .tonto files found\n');
        return 1;
    }
    // The model a file belongs to, not the file alone: half the checks read
    // what points at a class, and the relation carrying that is usually in
    // another file. `--isolated` asks for the file and nothing else.
    const session = new TontoSession({
        // `--isolated` means the files named and nothing else, which is no
        // workspace at all: loading the directory each file sits in was
        // loading its neighbors, so an isolated check of one file still
        // reported what the file beside it declares.
        // `--workspace=<dir>` is that directory, taken at its word. Passing it
        // through `workspaceRootOf` walked *up* out of it whenever the parent
        // happened to hold `.tonto` files of its own, which is not what
        // naming a directory means.
        workspace: options.isolated ? undefined
            : options.workspace ? [resolve(options.workspace)]
                : [...new Set(targets.map(target => workspaceRootOf(target)))],
        antiPatterns: options.antiPatterns, locations: options.locations, publication: options.publication
    });
    const repaired = options.fix ? await session.fixFiles(files, options.only) : [];
    const reported = await session.validateFiles(files);

    const root = process.cwd();
    const near = (path: string): string => {
        const shorter = relative(root, path);
        return /^https?:/.test(path) || shorter.startsWith('..') ? path : shorter;
    };
    const counts = Object.fromEntries(SEVERITY
        .map(name => [name, reported.filter(entry => entry.severity === name).length]));
    if (options.json) {
        process.stdout.write(JSON.stringify({
            diagnostics: reported.map(entry => ({ ...entry, file: near(entry.file) })),
            repaired,
            summary: { files: files.length, ...counts }
        }, undefined, 2) + '\n');
    } else {
        for (const entry of reported) {
            const fixes = entry.fixes.length > 0 ? `  [${entry.fixes.map(fix => fix.title).join(' | ')}]` : '';
            process.stdout.write(`${near(entry.file)}:${entry.line}:${entry.column}  `
                + `${entry.severity.padEnd(11)} ${entry.code.padEnd(34)} ${entry.message}${fixes}\n`);
        }
        const summary = SEVERITY.map(name => `${counts[name]} ${name}`).join(', ');
        process.stdout.write(`\n${files.length} file${files.length === 1 ? '' : 's'}: ${summary}`
            + (options.fix ? `, ${repaired.length} repaired` : '') + '\n');
    }
    return counts.error > 0 ? 1 : 0;
}

/** Validates whatever is piped in, which is what a caller with no file has. */
async function checkStdin(options: CheckOptions): Promise<number> {
    const source = await readStdin();
    // The same workspace the path form reads, since a draft on stdin is the
    // case `--workspace` exists for: it has no file of its own, so nothing
    // else can say which model its uses and imports resolve against. Ignoring
    // the flag here answered a resolvable use with a linking error.
    const session = new TontoSession({
        workspace: options.isolated || !options.workspace ? undefined : [resolve(options.workspace)],
        antiPatterns: options.antiPatterns, locations: options.locations, publication: options.publication
    });
    // One pass, not two: the repaired text and what is left of the
    // diagnostics come out of the same run. What is left still decides the
    // exit status -- repairing a model does not make an error it could not
    // repair go away, and returning 0 regardless said it did.
    const fixed = options.fix ? await session.fixText(source, 'stdin', options.only) : undefined;
    const reported = fixed?.left ?? await session.validateText(source);
    if (options.json) {
        const counts = Object.fromEntries(SEVERITY
            .map(name => [name, reported.filter(entry => entry.severity === name).length]));
        process.stdout.write(JSON.stringify({ ...(fixed ? { text: fixed.text } : {}),
            diagnostics: reported, summary: { files: 1, ...counts } }, undefined, 2) + '\n');
    } else if (fixed) {
        process.stdout.write(fixed.text);
    } else {
        // Not beside the repaired model: that goes to stdout to be piped on,
        // and a diagnostic in the middle of it is not a model any more.
        for (const entry of reported) {
            process.stdout.write(`-:${entry.line}:${entry.column}  ${entry.severity.padEnd(11)} `
                + `${entry.code.padEnd(34)} ${entry.message}\n`);
        }
    }
    return reported.some(entry => entry.severity === 'error') ? 1 : 0;
}

export interface GufoCliOptions {
    locations?: Record<string, string>;
    publication?: boolean;
    json: boolean;
    namespaceIri?: string;
    /** Write each ontology's Turtle beside its ontology file. */
    write?: boolean;
    out?: string;
    workspace?: string;
    isolated?: boolean;
    directSpecializations?: boolean;
    snapshot?: boolean;
    outDir?: string;
}

/** Exports a checked model as the deterministic Turtle mapping in docs/gufo-mapping.md. */
export async function gufo(paths: string[], options: GufoCliOptions): Promise<number> {
    const stdin = paths.includes('-');
    const targets = paths.length > 0 ? paths : ['.'];
    const roots = options.isolated ? [] : options.workspace
        ? [resolve(options.workspace)]
        : stdin ? [] : [...new Set(targets.map(target => workspaceRootOf(target)))];
    const session = new TontoSession({ workspace: roots.length > 0 ? roots : undefined,
        locations: options.locations, publication: options.publication });
    let result: GufoResult;
    if (stdin) {
        result = await session.gufoText(await readStdin(), {
            namespaceIri: options.namespaceIri, directSpecializations: options.directSpecializations, snapshot: options.snapshot
        }, 'stdin');
    } else {
        const files = collectFiles(targets);
        if (files.length === 0) {
            process.stderr.write('no .tonto files found\n');
            return 1;
        }
        result = await session.gufoFiles(files, {
            namespaceIri: options.namespaceIri, directSpecializations: options.directSpecializations, snapshot: options.snapshot
        });
    }

    const root = process.cwd();
    const diagnostics = result.diagnostics.map(entry => ({
        ...entry,
        file: entry.file && !relative(root, entry.file).startsWith('..') ? relative(root, entry.file) : entry.file
    }));
    const failed = diagnostics.some(entry => entry.severity === 'error');
    // Several ontologies are several documents: one stream or one file cannot
    // hold them apart, so they need a directory (section 4).
    const several = !failed && result.files.length > 1 && !options.outDir && !options.write && (options.out !== undefined || !options.json);
    if (several) {
        process.stderr.write(`The export is ${result.files.length} documents (${result.files.map(file => file.file).join(', ')}); write each beside its ontology file with --write, or into a directory with --out-dir=<dir>.\n`);
        writeGufoDiagnostics(diagnostics);
        return 1;
    }
    let outputPath: string | undefined;
    const outputs: Array<{ ontology: string; path: string }> = [];
    if (!failed && options.write) {
        outputs.push(...writeBeside(result.files));
    } else if (!failed && options.outDir) {
        const directory = resolve(options.outDir);
        mkdirSync(directory, { recursive: true });
        for (const file of result.files) {
            const path = join(directory, file.file);
            writeAtomically(path, file.content);
            outputs.push({ ontology: file.ontology, path });
        }
    } else if (!failed && options.out) {
        outputPath = resolve(options.out);
        writeAtomically(outputPath, result.turtle);
    }
    if (options.json) {
        const written = options.outDir || options.write ? { outputs }
            : outputPath ? { output: outputPath }
                : !options.out ? { turtle: result.turtle, files: result.files } : {};
        process.stdout.write(JSON.stringify({ ...written, publicationVerified: result.publicationVerified ?? false, diagnostics }, undefined, 2) + '\n');
    } else {
        if (!options.out && !options.outDir && !options.write && !failed) process.stdout.write(result.turtle);
        for (const { path } of outputs) process.stderr.write(`wrote ${relative(root, path) || path}\n`);
        writeGufoDiagnostics(diagnostics);
    }
    return failed ? 1 : 0;
}

function writeAtomically(path: string, contents: string): void {
    const temporary = resolve(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
    try {
        writeFileSync(temporary, contents, 'utf8');
        renameSync(temporary, path);
    } catch (error) {
        try { unlinkSync(temporary); } catch { /* Nothing was written, or rename already completed. */ }
        throw error;
    }
}

function writeGufoDiagnostics(diagnostics: readonly GufoDiagnostic[]): void {
    for (const entry of diagnostics) {
        const place = entry.file ? `${entry.file}:${entry.line}:${entry.column}  ` : '';
        process.stderr.write(`${place}${entry.severity.padEnd(11)} ${entry.code.padEnd(42)} ${entry.message}\n`);
    }
}

/** Lays a model out canonically. Reads a file or stdin, writes stdout. */
export async function format(paths: string[]): Promise<number> {
    const source = paths[0] === undefined || paths[0] === '-'
        ? await readStdin()
        : readFileSync(paths[0], 'utf8');
    process.stdout.write(await new TontoSession().formatText(source));
    return 0;
}

/** The parsed model as JSON, for a caller reading structure rather than text. */
export async function ast(paths: string[]): Promise<number> {
    const source = paths[0] === undefined || paths[0] === '-'
        ? await readStdin()
        : readFileSync(paths[0], 'utf8');
    process.stdout.write(JSON.stringify(await new TontoSession().astOf(source), undefined, 2) + '\n');
    return 0;
}

/**
 * Answers a question about the language directly, so a caller does not have to
 * write a model to find out. Two class stereotypes ask whether one may
 * specialize the other; a stereotype and two natures ask whether an
 * association may run between them.
 */
export interface Explanation {
    /** The answer, for whoever asked. */
    text: string;
    /** Set instead when the question itself was wrong. */
    problem?: string;
    /** 0 yes, 1 no, 2 the question could not be read. */
    code: number;
}

/**
 * The answer as text, written nowhere.
 *
 * The command prints it; the MCP server returns it. That server speaks its
 * protocol over stdout, so a tool that answered by writing there had to
 * borrow the stream back from the transport -- and anything the transport
 * wrote meanwhile went into the answer instead of to the client.
 */
export async function explainText(words: string[]): Promise<Explanation> {
    const { STEREOTYPES, canSpecializeByStereotype, whyNotSpecialize } =
        await import('../validation/stereotype-model.js');
    const { pairGroups, RELATION_NATURE_TABLE, TABLE_NATURE_NAMES } = await import('../validation/relation-nature-table.js');

    const [first, second, third] = words;
    if (first?.startsWith('@')) {
        const stereotype = first.slice(1);
        const pairs = RELATION_NATURE_TABLE[stereotype];
        if (!pairs) {
            return { text: '', problem: `no association stereotype "@${stereotype}"\n`, code: 2 };
        }
        const natures = (given: string | undefined): string | undefined =>
            given === undefined ? undefined : TABLE_NATURE_NAMES[given] ?? given;
        const from = natures(second);
        const to = natures(third);
        // A word that is not a nature is not an answer of "no". Asked whether
        // "@mediation" runs to a "kind" -- a stereotype, not a nature -- it
        // used to say no, which reads as a fact about mediation.
        const known = new Set([...Object.keys(TABLE_NATURE_NAMES), ...Object.values(TABLE_NATURE_NAMES)]);
        const strange = [from, to].filter((nature): nature is string =>
            nature !== undefined && !known.has(nature));
        if (strange.length > 0) {
            return {
                text: '',
                problem: `no ontological nature ${strange.map(nature => `"${nature}"`).join(', ')}`
                    + ` -- the natures are ${[...new Set(Object.values(TABLE_NATURE_NAMES))].join(', ')}\n`,
                code: 2
            };
        }
        // What each group of first natures reaches, not the two margins: the
        // union of firsts and the union of seconds says "@characterization"
        // runs from an extrinsic mode to a process, which its pairs deny.
        const groups = pairGroups(stereotype);
        const written = (group: { from: string[]; to: string[] }): string =>
            `  from ${[...group.from].sort().join(', ')}\n    to ${[...group.to].sort().join(', ')}\n`;
        if (from === undefined || to === undefined) {
            return { text: `@${stereotype} runs\n${groups.map(written).join('')}`, code: 0 };
        }
        const admitted = pairs.includes(`${from}:${to}`);
        const reaching = groups.find(group => group.from.includes(from));
        return {
            text: admitted
                ? `Yes. "@${stereotype}" may run from ${article(from)} ${from} to ${article(to)} ${to}.\n`
                : `No. "@${stereotype}" does not run from ${article(from)} ${from} to ${article(to)} ${to}.\n`
                    + (reaching
                        ? `  From ${article(from)} ${from} it runs to ${[...reaching.to].sort().join(', ')}.\n`
                        : `  It runs from ${groups.flatMap(group => group.from).sort().join(', ')}.\n`),
            code: admitted ? 0 : 1
        };
    }
    if (first === undefined || second === undefined || !(first in STEREOTYPES) || !(second in STEREOTYPES)) {
        return { text: '', problem: 'usage: tonto explain <stereotype> <stereotype>   -- may the first specialize the second?\n'
            + '       tonto explain @<stereotype> [<nature> <nature>]  -- what an association relates\n', code: 2 };
    }
    const allowed = canSpecializeByStereotype(first, second);
    return {
        text: allowed
            ? `Yes. A "${first}" may specialize a "${second}".\n`
            : `No. ${whyNotSpecialize(first, second)}.\n`,
        code: allowed ? 0 : 1
    };
}

/** The same answer, printed. */
export async function explain(words: string[]): Promise<number> {
    const { text, problem, code } = await explainText(words);
    if (problem !== undefined) {
        process.stderr.write(problem);
    }
    if (text.length > 0) {
        process.stdout.write(text);
    }
    return code;
}

/** The reference tables, as the checks hold them. */
export async function tables(): Promise<number> {
    const { tablesJson } = await import('./tables.js');
    process.stdout.write(JSON.stringify(await tablesJson(), undefined, 2) + '\n');
    return 0;
}

/** Every rule, with the example that trips it and the repairs it offers. */
export async function printRules(json: boolean, code?: string): Promise<number> {
    const { catalog } = await import('./rules.js');
    const all = await catalog();
    const rules = code === undefined ? all : all.filter(rule => rule.code === code);
    if (rules.length === 0) {
        process.stderr.write(`no rule "${code}" -- run without an argument for the list\n`);
        return 2;
    }
    if (json) {
        process.stdout.write(JSON.stringify({ rules }, undefined, 2) + '\n');
        return 0;
    }
    for (const rule of rules) {
        process.stdout.write(`${rule.code}  [${rule.group}, ${rule.severity ?? 'not reported'}]\n`
            + `  ${rule.rationale}\n`
            + rule.example.split('\n').map(line => `      ${line}`).join('\n') + '\n'
            + (rule.message ? `  -> ${rule.message}\n` : '')
            + (rule.fixes.length > 0
                ? `  fixes: ${rule.fixes.join(' | ')}${rule.batchSafe ? '' : '   (not applied by --fix: it decides something)'}\n`
                : '') + '\n');
    }
    if (code === undefined) {
        process.stdout.write(`${rules.length} rules\n`);
    }
    return 0;
}

/**
 * The modeling patterns: what to write, where the rules say what not to.
 *
 * Every entry is validated on the way out, so a pattern that stopped being
 * clean is reported here rather than recommended in silence.
 */
export async function printPatterns(json: boolean, name?: string): Promise<number> {
    const { catalog, missingPattern } = await import('./patterns.js');
    const all = await catalog();
    const patterns = name === undefined ? all : all.filter(pattern => pattern.name === name);
    if (patterns.length === 0) {
        process.stderr.write(`${missingPattern(name ?? '')}\n`);
        return 2;
    }
    if (json) {
        process.stdout.write(JSON.stringify({ patterns }, undefined, 2) + '\n');
        return 0;
    }
    for (const pattern of patterns) {
        process.stdout.write(`${pattern.name}  [${pattern.group}]\n`
            + `  ${pattern.title}\n`
            + `  ${pattern.intent}\n`
            + pattern.example.split('\n').map(line => `      ${line}`).join('\n') + '\n'
            + `  ! ${pattern.note}\n`
            + `  source: ${pattern.source}\n`
            + (pattern.diagnostics.length > 0 ? `  UNCLEAN: ${pattern.diagnostics.join(' | ')}\n` : '')
            + '\n');
    }
    if (name === undefined) {
        process.stdout.write(`${patterns.length} patterns\n`);
    }
    return 0;
}

/** The language in one page, for a reader that needs it before writing. */
/** The ontologies a workspace authors: what the editor's export lists. */
export async function ontologies(paths: string[], json: boolean): Promise<number> {
    const root = workspaceRootOf(paths[0] ?? '.');
    const listed = await new TontoSession({ workspace: [root] }).ontologies();
    if (json) {
        process.stdout.write(JSON.stringify(listed, undefined, 2) + '\n');
    } else if (!listed.length) {
        process.stderr.write(`No ontology header in ${relative(process.cwd(), root) || '.'}.\n`);
    } else {
        for (const ontology of listed) {
            const where = relative(process.cwd(), ontology.file) || ontology.file;
            const errors = ontology.errors ? `, ${ontology.errors} error${ontology.errors === 1 ? '' : 's'}` : '';
            process.stdout.write(`${ontology.name}  ${where}  ${ontology.namespace ?? '(no namespace)'}${errors}\n`);
        }
    }
    return listed.some(ontology => ontology.errors > 0) ? 1 : 0;
}

export async function printGuide(): Promise<number> {
    const { guide } = await import('./guide.js');
    process.stdout.write(guide());
    return 0;
}

const USAGE = `tonto -- static analysis for the tonto modeling language

  tonto --version             print the installed CLI version
  tonto --help                show this help

  tonto fetch [paths...]     explicitly retrieve missing remote dependencies
    --refresh                atomically refresh the full retrieval closure
    --publication            retrieve original URLs, ignoring all mappings
    --workspace=<dir>        workspace cache/configuration root
    --json                   report retrieved and reused locations

  check/gufo options:
    --publication            check/export the unmapped publication model
    --locations=<json>       URL-to-location mappings overriding tonto.json

  tonto check [paths...]     validate .tonto files (a directory is searched,
                             "-" reads the model from stdin)
    --json                   machine-readable diagnostics, with every repair
                             (stdin --fix returns repaired text in "text")
    --fix[=<code,...>]       apply the repairs a rule forces; those that decide
                             something are reported, not written, unless their
                             code is named here
    --anti-patterns          include the advisory anti-pattern rules
    --workspace=<dir>        load this directory as the workspace; by default
                             the workspace is the nearest directory above the
                             paths holding tonto.json, or else the highest one
                             that still holds .tonto files
    --isolated               load only the files named, so a check that reads
                             what points at a class sees nothing else
  tonto ontologies [path]    the ontologies the workspace authors: name,
                             ontology file, namespace and error count
    --json                   the same as JSON
  tonto format [path]        lay a model out canonically (stdin if no path)
  tonto ast [path]           the parsed model as JSON
  tonto gufo [paths...]      export the ontologies of these files as
                             gUFO-aligned Turtle, to stdout unless written
    --write                  write each ontology as <name>.ttl beside its
                             ontology file, as the editor's export does
    --namespace-iri=<iri>    exact namespace for the one ontology whose header
                             has none; as /// @namespace, ends in # or /
    --out=<file>             write one ontology's Turtle to this file
    --out-dir=<dir>          write each ontology as its own file in <dir>
    --json                   return Turtle/output paths and diagnostics as JSON
    --workspace=<dir>        load this directory as the workspace
    --isolated               load only the files named
    --direct-specializations also write the direct rdfs:subClassOf triples
                             gufoshapes reads without inference
    --snapshot               also write the snapshot layer: beside each
                             ontology, a module with the upper bounds and the
                             disjointness that hold at one instant, and SHACL
                             shapes that check a graph of current state
                             (needs --write, --out-dir or --json)
  tonto explain <a> <b>      may a stereotype specialize another? what does an
                             association relate? -- answered from the tables
  tonto patterns [name]      the modeling patterns, each a model that validates
    --json                   the catalog as JSON
  tonto tables               the reference tables the checks consult, as JSON
  tonto guide                the language in one page; catalogs from the tables
  tonto rules [code] [--json]  every rule, or one: why it exists, the smallest
                             model that trips it, its message and its repairs

Exits 1 when anything is reported as an error.
`;

/**
 * A path that is not there is the caller's slip, not a crash.
 *
 * Every command reads files, and an unhandled `ENOENT` reached the terminal as
 * a Node stack trace -- which is noise for a person and unparseable for an
 * agent expecting a diagnostic.
 */
function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === 'ENOENT' || code === 'EACCES' || code === 'EISDIR' || code === 'ENOTDIR';
}

export async function run(argv: string[]): Promise<number> {
    try {
        return await dispatch(argv);
    } catch (error) {
        if (error instanceof Error && error.message.startsWith('--locations')) {
            process.stderr.write(`tonto: ${error.message}\n`);
            return 2;
        }
        if (!isMissingFile(error)) {
            throw error;
        }
        process.stderr.write(`tonto: cannot read ${error.path ?? 'the path given'}\n`);
        return 2;
    }
}

/** The codes in `--fix=` that no rule answers to. */
async function unknownCodes(only: ReadonlySet<string>): Promise<string[]> {
    const { catalog } = await import('./rules.js');
    const known = new Set((await catalog()).map(rule => rule.code));
    return [...only].filter(code => !known.has(code));
}

async function dispatch(argv: string[]): Promise<number> {
    const [command, ...rest] = argv;
    if (command === '--version' || command === '-V') {
        process.stdout.write(`tonto ${VERSION}\n`);
        return 0;
    }
    // Help after a command is help, not a file: `tonto format --help` was
    // read as a model called "--help" and answered that it could not be read.
    if (rest.includes('--help') || rest.includes('-h')) {
        process.stdout.write(USAGE);
        return 0;
    }
    if (command === 'fetch') {
        const flags = rest.filter(argument => argument.startsWith('--'));
        const workspace = flags.find(flag => flag.startsWith('--workspace='))?.slice('--workspace='.length) ?? process.cwd();
        const unknown = flags.filter(flag => !['--refresh', '--publication', '--json'].includes(flag)
            && !flag.startsWith('--workspace=') && !flag.startsWith('--locations='));
        if (unknown.length) { process.stderr.write(`unknown option ${unknown.join(', ')}\n`); return 2; }
        try {
            const session = new TontoSession({ workspace, publication: flags.includes('--publication'), locations: locationFlags(flags) });
            const paths = rest.filter(argument => !argument.startsWith('--'));
            const result = await session.fetch(paths.length ? paths : [workspace], { refresh: flags.includes('--refresh') });
            process.stdout.write(flags.includes('--json') ? JSON.stringify(result, undefined, 2) + '\n'
                : `${fetchSummary(result)}\n`);
            return 0;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`tonto fetch: ${message}\n`);
            return message.startsWith('--locations') ? 2 : 1;
        }
    }
    if (command === 'tables') {
        return tables();
    }
    if (command === 'guide') {
        return printGuide();
    }
    if (command === 'format') {
        return format(rest);
    }
    if (command === 'ast') {
        return ast(rest);
    }
    if (command === 'gufo') {
        const flags = new Set(rest.filter(argument => argument.startsWith('--')));
        const namespaceFlag = [...flags].find(flag => flag.startsWith('--namespace-iri='));
        const outFlag = [...flags].find(flag => flag.startsWith('--out='));
        const outDirFlag = [...flags].find(flag => flag.startsWith('--out-dir='));
        const workspaceFlag = [...flags].find(flag => flag.startsWith('--workspace='));
        const unknown = [...flags].filter(flag => !['--json', '--isolated', '--direct-specializations', '--snapshot', '--publication', '--write'].includes(flag)
            && !flag.startsWith('--locations=')
            && flag !== namespaceFlag && flag !== outFlag
            && flag !== outDirFlag && flag !== workspaceFlag);
        if (unknown.length > 0) {
            process.stderr.write(`unknown option ${unknown.join(', ')}\n\n${USAGE}`);
            return 2;
        }
        if (namespaceFlag === '--namespace-iri=' || outFlag === '--out='
            || workspaceFlag === '--workspace=' || outDirFlag === '--out-dir=') {
            process.stderr.write('options --namespace-iri, --out, --out-dir and --workspace require a value\n');
            return 2;
        }
        if ([outFlag, outDirFlag, flags.has('--write') || undefined].filter(Boolean).length > 1) {
            process.stderr.write('give one of --write, --out and --out-dir\n');
            return 2;
        }
        if (flags.has('--write') && rest.includes('-')) {
            process.stderr.write('--write needs ontology files: text from stdin has none to be written beside\n');
            return 2;
        }
        return gufo(rest.filter(argument => !argument.startsWith('--')), {
            publication: flags.has('--publication'), locations: locationFlags([...flags]),
            json: flags.has('--json'), isolated: flags.has('--isolated'),
            directSpecializations: flags.has('--direct-specializations'),
            snapshot: flags.has('--snapshot'),
            namespaceIri: namespaceFlag?.slice('--namespace-iri='.length),
            write: flags.has('--write'),
            out: outFlag?.slice('--out='.length),
            outDir: outDirFlag?.slice('--out-dir='.length),
            workspace: workspaceFlag?.slice('--workspace='.length)
        });
    }
    if (command === 'ontologies') {
        return ontologies(rest.filter(argument => !argument.startsWith('--')), rest.includes('--json'));
    }
    if (command === 'explain') {
        return explain(rest);
    }
    if (command === 'rules') {
        return printRules(rest.includes('--json'), rest.find(argument => !argument.startsWith('--')));
    }
    if (command === 'patterns') {
        return printPatterns(rest.includes('--json'), rest.find(argument => !argument.startsWith('--')));
    }
    if (command === 'check') {
        const flags = new Set(rest.filter(argument => argument.startsWith('--')));
        const fixFlag = [...flags].find(flag => flag === '--fix' || flag.startsWith('--fix='));
        const workspaceFlag = [...flags].find(flag => flag.startsWith('--workspace='));
        const unknown = [...flags].filter(flag =>
            !['--json', '--anti-patterns', '--isolated', '--publication'].includes(flag)
            && !flag.startsWith('--locations=')
            && flag !== fixFlag && flag !== workspaceFlag);
        if (unknown.length > 0) {
            process.stderr.write(`unknown option ${unknown.join(', ')}\n\n${USAGE}`);
            return 2;
        }
        const only = fixFlag?.startsWith('--fix=')
            ? new Set(fixFlag.slice('--fix='.length).split(',').filter(code => code.length > 0))
            : undefined;
        const wrong = only && await unknownCodes(only);
        if (wrong && wrong.length > 0) {
            // A code with a typo in it matches no diagnostic, so the run
            // repairs nothing and says so in the same words as a model with
            // nothing to repair. Better to say which code no rule has.
            process.stderr.write(`no rule ${wrong.map(code => `"${code}"`).join(', ')}`
                + ' -- run `tonto rules` for the list\n');
            return 2;
        }
        if (only?.size === 0) {
            process.stderr.write('--fix= needs at least one rule code, or use --fix for all of them\n');
            return 2;
        }
        return check(rest.filter(argument => !argument.startsWith('--')), {
            publication: flags.has('--publication'), locations: locationFlags([...flags]),
            json: flags.has('--json'),
            fix: fixFlag !== undefined,
            only,
            antiPatterns: flags.has('--anti-patterns'),
            isolated: flags.has('--isolated'),
            workspace: workspaceFlag?.slice('--workspace='.length)
        });
    }
    process.stdout.write(USAGE);
    return command === undefined || command === '--help' || command === '-h' ? 0 : 2;
}

function locationFlags(flags: string[]): Record<string, string> | undefined {
    const value = flags.find(flag => flag.startsWith('--locations='));
    return value ? parseLocations(value.slice('--locations='.length)) : undefined;
}
