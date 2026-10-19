import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import { TontoSession } from 'tonto-language';
import { guide } from 'tonto-language/guide';
import { catalog } from 'tonto-language/rules';
import { catalog as patternCatalog } from 'tonto-language/patterns';
import { tablesJson } from 'tonto-language/tables';
import { TOOLS, ToolError, fenced, runTool } from 'tonto-language/tools';
import type { ToolHost, ToolInputSchema } from 'tonto-language/tools';

/**
 * The checks, over the protocol an agent already speaks.
 *
 * Everything here is the language server's own work: the same validation, the
 * same repairs, the same tables. What it adds is that a caller with a model in
 * hand and no file for it -- which is what something drafting one has -- can
 * ask about it. One session is kept for the life of the connection, so the
 * built-in datatypes and any workspace are parsed once rather than per call.
 */

/** A workspace directory, when the caller has one, so `import` resolves. */
const workspaceArgument = process.argv.slice(2).find(argument => !argument.startsWith('-'))
    ?? process.env.CLAUDE_PROJECT_DIR;
const workspace = workspaceArgument ? resolve(workspaceArgument) : undefined;
// File arguments are relative to the server process, including when Claude
// supplies its project root in the environment rather than on the command line.
if (workspace) process.chdir(workspace);
/**
 * `--anti-patterns`, as the command line spells it.
 *
 * Off by default, for the reason it is off there: they are advisory, and on a
 * large model they fire often enough to bury what is not. But a reviewer that
 * cannot turn them on is a reviewer that cannot see `RelOver`, `RepRel`,
 * `DepPhase`, `MixIden` or `HetColl` at all -- which is most of what the
 * `review` prompt is for, and none of it was reachable over this protocol.
 */
const antiPatterns = process.argv.slice(2).includes('--anti-patterns');
const session = new TontoSession({ workspace, antiPatterns });

/**
 * The tools, as tonto-language/tools defines them for every host: the same
 * names, parameters, descriptions and answers the VS Code tools have. What
 * is this host's own is below: a call names files relative to the workspace,
 * a call about no file is refused, and writes stay in the workspace.
 */
const host: ToolHost = {
    antiPatterns,
    files(paths) {
        if (!paths || paths.length === 0) throw new ToolError('Give either source or paths.');
        const root = realpathSync(workspace ?? process.cwd());
        return paths.map(path => {
            if (isAbsolute(path)) throw new ToolError('Path must be relative to the workspace.');
            const resolved = resolve(root, path);
            if (!inside(root, resolved)) throw new ToolError(`Path "${path}" must stay inside the workspace.`);
            let canonical: string;
            try {
                canonical = realpathSync(resolved);
            } catch {
                throw new ToolError(`Path "${path}" does not exist in the workspace.`);
            }
            if (!inside(root, canonical)) throw new ToolError(`Path "${path}" must stay inside the workspace.`);
            return canonical;
        });
    },
    session: () => session,
    sessionWith: options => new TontoSession({ workspace, antiPatterns, ...options }),
    workspaceRoot() {
        if (!workspace) throw new ToolError('This needs the server started with a workspace directory.');
        return workspace;
    },
    display: file => relative(workspace ?? process.cwd(), file) || file
};

/** Paths stay inside the workspace after resolving both `..` and symlinks. */
function inside(root: string, candidate: string): boolean {
    const path = relative(root, candidate);
    return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

const server = new McpServer({ name: 'tonto', version: '0.1.0' });

for (const tool of TOOLS) {
    server.registerTool(tool.name, {
        title: tool.title,
        description: tool.description(host),
        inputSchema: zodShape(tool.input)
    }, async input => {
        const result = await runTool(tool.name, input as Record<string, unknown>, host);
        return {
            ...(result.isError ? { isError: true } : {}),
            content: [{ type: 'text' as const, text: result.text }],
            ...(result.data ? { structuredContent: result.data } : {})
        };
    });
}

/** The shared JSON Schema of a tool's parameters, as the zod shape the SDK takes. */
function zodShape(schema: ToolInputSchema): Record<string, z.ZodTypeAny> {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [name, parameter] of Object.entries(schema.properties)) {
        let type: z.ZodTypeAny;
        switch (parameter.type) {
            case 'string': type = z.string(); break;
            case 'boolean': type = z.boolean(); break;
            case 'integer': type = z.number().int().min(parameter.minimum); break;
            case 'array': type = z.array(z.string()); break;
            case 'object': type = z.record(z.string(), z.string()); break;
        }
        type = type.describe(parameter.description);
        shape[name] = schema.required?.includes(name) ? type : type.optional();
    }
    return shape;
}

/**
 * The reading, as resources rather than as tool calls.
 *
 * A tool is for asking a question about a model. The guide, the rule
 * reference and the pattern catalog are not questions -- they are what a
 * client should be able to attach and read, once, without spending a turn on
 * it. They are the same text the tools return, which is the point: one
 * source, two ways in.
 */
server.registerResource(
    'guide', 'tonto://guide',
    {
        title: 'The tonto language in one page',
        description: 'Every stereotype, nature, principle and association signature, from the tables '
            + 'the validator reads.',
        mimeType: 'text/markdown'
    },
    async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: guide() }] })
);

server.registerResource(
    'rules', 'tonto://rules',
    {
        title: 'The validation rules',
        description: 'Every rule: why it exists, the smallest model that trips it, the message it '
            + 'writes and the repairs it offers.',
        mimeType: 'application/json'
    },
    async uri => ({
        contents: [{
            uri: uri.href, mimeType: 'application/json',
            text: JSON.stringify({ rules: await catalog() }, undefined, 2)
        }]
    })
);

server.registerResource(
    'patterns', 'tonto://patterns',
    {
        title: 'The modeling patterns',
        description: 'What to write, where the rules say what not to: each a small model that '
            + 'validates in silence.',
        mimeType: 'application/json'
    },
    async uri => ({
        contents: [{
            uri: uri.href, mimeType: 'application/json',
            text: JSON.stringify({ patterns: await patternCatalog() }, undefined, 2)
        }]
    })
);

server.registerResource(
    'tables', 'tonto://tables',
    {
        title: 'The reference tables',
        description: 'What each stereotype admits at each end, what each classifies, and which may '
            + 'specialize which.',
        mimeType: 'application/json'
    },
    async uri => ({
        contents: [{
            uri: uri.href, mimeType: 'application/json',
            text: JSON.stringify(await tablesJson(), undefined, 2)
        }]
    })
);

/**
 * Two prompts, which are the two things anyone does with this.
 *
 * Written as workflow rather than as encouragement: what to read first, what
 * to run, and what to do with what comes back. The order is the one that
 * works -- the guide before the writing, the patterns for the shape,
 * validation before handing anything over, and a repair chosen rather than a
 * model rewritten.
 */
server.registerPrompt(
    'draft',
    {
        title: 'Draft a tonto model',
        description: 'Write a model of a domain, from the guide and the patterns, validated before it '
            + 'is handed back.',
        argsSchema: { domain: z.string().describe('What to model, e.g. "car rentals".') }
    },
    ({ domain }) => ({
        messages: [{
            role: 'user',
            content: {
                type: 'text',
                text: `Write a tonto model of ${domain}.\n\n`
                    + 'Read `tonto://guide` first: most mistakes are a stereotype whose natures do not '
                    + 'match what it is used for, and the guide states which combinations exist. Look '
                    + 'in `tonto://patterns` for the shapes you need -- a role and the relator that '
                    + 'founds it, parthood, constitution, an event and what takes part in it.\n\n'
                    + 'Then: call `tonto_validate` on what you write, and do not hand back a model you '
                    + 'have not validated. Read each diagnostic with `tonto_rules` before repairing it. '
                    + 'Take repairs with `tonto_apply`, naming the one you mean; where a rule offers '
                    + 'two, the choice is a modeling decision and it is yours to make and to say. '
                    + 'Hints are not failures: they are what the model has not said yet, and some of '
                    + 'them should stay unsaid. Finish with `tonto_format`.'
            }
        }]
    })
);

server.registerPrompt(
    'review',
    {
        title: 'Review a tonto model',
        description: 'Read a model as an ontologist would, and report what it says and what it leaves '
            + 'unsaid.',
        argsSchema: { source: z.string().describe('The model as text.') }
    },
    ({ source }) => ({
        messages: [{
            role: 'user',
            content: {
                type: 'text',
                text: 'Review this tonto model.\n\n'
                    + 'Start with `tonto_digest`, which gives the ultimate sortals and what hangs off '
                    + 'each, what every relator binds, and the hints -- the model\u2019s own list of what '
                    + 'it has not said. Then `tonto_validate` for the rest. For each finding, say what '
                    + 'the model claims, why the rule objects (`tonto_rules`), and which repair you '
                    + 'would take and why; where a rule offers a choice, say what the two readings '
                    + 'commit the model to. If you change anything, check yourself with `tonto_diff` '
                    + 'before saying you improved it.\n\n'
                    + fenced(source)
            }
        }]
    })
);

await server.connect(new StdioServerTransport());
