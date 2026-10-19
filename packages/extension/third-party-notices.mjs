// The bundles in out/ carry other packages' code, but --no-dependencies keeps
// those packages' LICENSE files out of the VSIX, and esbuild preserves only the
// few notices written as @license comments. MIT, ISC, BSD and Apache-2.0 all
// ask that the notice travel with the code, so it is collected here from what
// esbuild actually bundled -- not from package-lock.json, which also lists
// build tools that never ship.
import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

// Licenses that ask for nothing beyond keeping the notice. Anything else in a
// bundle stops the build: a copyleft or proprietary package is a decision to
// make on purpose, not one to find out about from a published VSIX.
const permissive = new Set([
    '0BSD', 'Apache-2.0', 'BlueOak-1.0.0', 'BSD-2-Clause', 'BSD-3-Clause',
    'CC0-1.0', 'ISC', 'MIT', 'Unlicense', 'Zlib'
]);

const noticeFile = /^(licen[cs]e|copying|notice)([.-]|$)/i;

/**
 * Writes the notices of every npm package bundled into the given builds.
 * @param {import('esbuild').Metafile[]} metafiles
 * @param {string} outfile
 */
export function writeThirdPartyNotices(metafiles, outfile) {
    const roots = new Set();
    for (const metafile of metafiles) {
        for (const input of Object.keys(metafile.inputs)) {
            const root = packageRoot(input);
            if (root) roots.add(root);
        }
    }

    const packages = new Map();
    for (const root of roots) {
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
        packages.set(`${pkg.name}@${pkg.version}`, { root, pkg, license: licenseOf(pkg) });
    }
    const sorted = [...packages.entries()].sort(([a], [b]) => a.localeCompare(b));

    const problems = [];
    for (const [id, { root, license }] of sorted) {
        const files = readdirSync(root).filter(name => noticeFile.test(name));
        if (!license) problems.push(`${id} declares no license`);
        else if (!satisfies(license)) problems.push(`${id} is licensed ${license}, which is not on the permissive list`);
        if (!license && files.length === 0) problems.push(`${id} has no license file either`);
    }
    if (problems.length > 0) {
        throw new Error(`Third-party licenses need a decision:\n  ${problems.join('\n  ')}`);
    }

    const sections = sorted.map(([id, { root, pkg, license }]) => {
        const files = readdirSync(root).filter(name => noticeFile.test(name)).sort();
        const texts = files.map(name => readFileSync(join(root, name), 'utf8').trim());
        const source = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
        const header = [`${id}`, `License: ${license}`, ...(source ? [`Source: ${source}`] : [])];
        const body = texts.length > 0
            ? texts.join('\n\n')
            : `No license file is distributed with this package; its package.json declares ${license}.`;
        return `${header.join('\n')}\n\n${body}`;
    });

    const rule = '-'.repeat(78);
    writeFileSync(outfile, [
        'Third-party notices',
        '',
        'The tonto extension bundles the following packages into out/. Each is',
        'listed with the license it is distributed under and the notice it carries.',
        '',
        ...sections.flatMap(section => [rule, '', section, ''])
    ].join('\n'));
    return sorted.length;
}

// The directory of the npm package an esbuild input belongs to, or nothing for
// this repository's own sources. Inputs are relative to the working directory
// and already resolved through symlinks, so workspace packages never appear
// under node_modules.
function packageRoot(input) {
    const path = resolve(input.replace(/^[a-z-]+:/i, ''));
    const marker = `${sep}node_modules${sep}`;
    const at = path.lastIndexOf(marker);
    if (at < 0) return undefined;
    const rest = path.slice(at + marker.length).split(sep);
    const depth = rest[0].startsWith('@') ? 2 : 1;
    return realpathSync(path.slice(0, at + marker.length) + rest.slice(0, depth).join(sep));
}

function licenseOf(pkg) {
    if (typeof pkg.license === 'string') return pkg.license;
    if (pkg.license?.type) return pkg.license.type;
    // The array form predates SPDX expressions; each entry is an alternative.
    if (Array.isArray(pkg.licenses) && pkg.licenses.length > 0) {
        return pkg.licenses.map(entry => entry.type ?? entry).join(' OR ');
    }
    return undefined;
}

// An SPDX expression is satisfied when some choice among its ORs leaves only
// permissive licenses. AND binds tighter than OR, and a WITH exception, which
// can grant or take away, is left for a person to read.
function satisfies(expression) {
    const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
    let next = 0;
    const or = () => {
        let value = and();
        while (tokens[next] === 'OR') { next++; value = and() || value; }
        return value;
    };
    const and = () => {
        let value = term();
        while (tokens[next] === 'AND') { next++; value = term() && value; }
        return value;
    };
    const term = () => {
        const token = tokens[next++];
        if (token === '(') { const value = or(); next++; return value; }
        if (tokens[next] === 'WITH') { next += 2; return false; }
        return permissive.has(token);
    };
    const value = or();
    return value && next === tokens.length;
}
