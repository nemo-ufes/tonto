import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { canonicalPath, canonicalRealPath, underRoot } from '../utils/paths.js';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { AstUtils, URI } from 'langium';
import type { AstNode, LangiumDocument, LangiumSharedCoreServices } from 'langium';
import { isModel, isOntologyBody, isPackage } from '../generated/ast.js';
import type { BundleEntry, Import, Model, Ontology, Package } from '../generated/ast.js';
import { declaredNamespace } from '../utils/namespaces.js';
import { BUILTIN_DATATYPES_URI } from '../workspace/builtin-datatypes.js';

export interface PublicationOptions {
    locations?: Record<string, string>;
    publication?: boolean;
}

/** Bundles name source files of their own entry, not an independently located dependency. */
export function relativeBundleLocation(location: string): boolean {
    const raw = location.slice(1, -1);
    return !!raw && !/^[a-z][a-z\d+.-]*:/i.test(raw) && !raw.startsWith('/')
        && !raw.includes('\\') && !raw.includes('?') && !raw.includes('#');
}

export interface OntologyUnit {
    id: string;
    name: string;
    root?: LangiumDocument<Model>;
    declaration?: Ontology;
    packages: Package[];
    dependencies: Set<OntologyUnit>;
    namespace?: string;
    namespaceSupplied?: boolean;
    /** Packages no ontology file bundles: checked together, never published. */
    unbundled: boolean;
    /** A bundled package or an imported ontology is unavailable. */
    incomplete?: boolean;
}

export interface PublicationProblem {
    node: AstNode;
    code: string;
    message: string;
    warning?: boolean;
    property?: string;
}

/** Why a location mapping cannot be used, or undefined when it can. */
export function mappingProblem(key: string, value: unknown): string | undefined {
    if (typeof value !== 'string' || !value) return `mapping "${key}" needs a location string as its value`;
    let url: URL;
    try { url = new URL(key); } catch { return `mapping key "${key}" is not an absolute HTTP(S) URL`; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return `mapping key "${key}" is not an absolute HTTP(S) URL`;
    if (url.hash || key.endsWith('#')) return `mapping key "${key}" must not have a fragment`;
    if (key.endsWith('/') && !value.endsWith('/')) return `mapping "${key}" maps a prefix, so its value must end in "/" too`;
    return undefined;
}

/** `--locations` and the API's `locations` option, checked as `tonto.json` entries are. */
export function parseLocations(text: string): Record<string, string> {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (error) {
        throw new Error(`--locations is not JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--locations must be a JSON object of URL-to-location mappings');
    for (const [key, value] of Object.entries(parsed)) {
        const problem = mappingProblem(key, value);
        if (problem) throw new Error(`--locations: ${problem}`);
    }
    return parsed as Record<string, string>;
}

interface CacheEntry {
    requested: string;
    mapped: string;
    effective: string;
    retrieved: string;
    sha256: string;
    source: string;
}

interface CacheSnapshot { entries: Record<string, CacheEntry> }

/** What an explicit retrieval did, by requested location (§7.2). */
export interface FetchResult {
    /** Retrieved over the network in this run. */
    retrieved: string[];
    /** Reused from the cache without a request. */
    cached: string[];
    /** Retrieved and not in the cache before. */
    added: string[];
    /** Retrieved with content that differs from the cached copy it replaces. */
    changed: string[];
    /** Cached before, reached by no import of the workspace now, and dropped. */
    removed: string[];
}

export function fetchSummary(result: FetchResult): string {
    const detail = [
        result.added.length ? `${result.added.length} new` : '',
        result.changed.length ? `${result.changed.length} changed` : ''
    ].filter(Boolean).join(', ');
    return `Retrieved ${result.retrieved.length} document(s)${detail ? ` (${detail})` : ''}; reused ${result.cached.length} cached document(s)`
        + (result.removed.length ? `; removed ${result.removed.length} no longer needed` : '') + '.'
        + [...result.added.map(url => `\n  new      ${url}`), ...result.changed.map(url => `\n  changed  ${url}`),
            ...result.removed.map(url => `\n  removed  ${url}`)].join('');
}

const owners = new WeakMap<Package, OntologyUnit>();
export const validationOntology = new AsyncLocalStorage<OntologyUnit | undefined>();
export const bundleTargets = new WeakMap<BundleEntry, Package>();
const workspaces = new WeakMap<LangiumSharedCoreServices, PublicationWorkspace>();

export function ownerOf(node: AstNode): OntologyUnit | undefined {
    const pkg = isPackage(node) ? node : AstUtils.getContainerOfType(node, isPackage);
    return pkg && owners.get(pkg);
}

/** Ontology aliases declared by the entry apply to every bundled member. */
export function entryImportsFor(pkg: Package): Import[] {
    const unit = ownerOf(pkg);
    if (!unit?.declaration || !unit.root || unit.root === AstUtils.getDocument(pkg)) return [];
    return unit.root.parseResult.value.imports.filter(imp => !!imp.location);
}

/** Imports in the source document remain local to that document. */
export function applicableImports(pkg: Package): Import[] {
    const model = AstUtils.getDocument(pkg).parseResult.value as Model;
    return [...entryImportsFor(pkg), ...model.imports, ...pkg.imports];
}

export function closureOf(unit: OntologyUnit): Set<OntologyUnit> {
    const result = new Set<OntologyUnit>();
    const visit = (current: OntologyUnit): void => {
        if (result.has(current)) return;
        result.add(current);
        current.dependencies.forEach(visit);
    };
    visit(unit);
    return result;
}

export function canSee(from: AstNode, target: AstNode): boolean {
    const source = validationOntology.getStore() ?? ownerOf(from);
    const destination = ownerOf(target);
    return !source || !destination || closureOf(source).has(destination);
}

export function publicationWorkspace(services: LangiumSharedCoreServices): PublicationWorkspace {
    let workspace = workspaces.get(services);
    if (!workspace) {
        workspace = new PublicationWorkspace(services);
        workspaces.set(services, workspace);
    }
    return workspace;
}

/** Ownership is established from parsed documents, before any reference binds. */
export class PublicationWorkspace {
    get isPublication(): boolean { return this.options.publication === true; }
    units: OntologyUnit[] = [];
    problems: PublicationProblem[] = [];
    imported = new WeakMap<Import, OntologyUnit>();
    /** The roots the caller configured: the editor's folders, or the CLI's workspace. */
    private given: string[] = [];
    /**
     * Those, and every folder beneath one that holds a `tonto.json`: each is a
     * workspace of its own, as the command line finds it from a file inside.
     */
    private roots: string[] = [];
    private options: PublicationOptions = {};
    /** Each root's location mappings: its own `tonto.json`, and what the caller supplied. */
    private mappings = new Map<string, Record<string, string>>();
    /** Each root's retrieval cache, `<root>/.tonto/`. */
    private snapshots = new Map<string, CacheSnapshot>();
    private cacheProblems = new Map<string, string>();
    /** The root on whose behalf a dependency was loaded, by its URI. */
    private origins = new Map<string, string>();
    /** What is wrong with a root's `tonto.json` or the supplied mappings; reported, never thrown. */
    private configurationProblems: Array<{ root: string; message: string }> = [];
    private loaded = new Map<string, LangiumDocument<Model>>();
    private dependencyRevision = 0;
    private effective = new Map<string, string>();
    private exportNamespace?: { value: string; documents: ReadonlySet<string> };

    constructor(private readonly services: LangiumSharedCoreServices) {}

    copyConfigurationTo(target: PublicationWorkspace): void {
        target.configure(this.given, this.options);
        target.snapshots = new Map(this.snapshots);
        target.origins = new Map(this.origins);
        target.loaded = new Map(this.loaded);
        target.effective = new Map(this.effective);
    }

    supplyNamespace(value: string | undefined, documents: LangiumDocument[] = []): void {
        this.exportNamespace = value === undefined ? undefined : { value, documents: new Set(documents.map(doc => doc.uri.toString())) };
    }

    configure(roots: string[], options: PublicationOptions = this.options): void {
        this.given = roots.map(root => canonicalPath(root));
        this.roots = [...this.given, ...this.nestedRoots()];
        this.options = options;
        this.mappings = new Map(this.roots.map(root => [root, {}]));
        this.configurationProblems = [];
        if (!options.publication) {
            for (const root of this.roots) {
                const config = join(root, 'tonto.json');
                if (!existsSync(config)) continue;
                let parsed: unknown;
                try {
                    parsed = JSON.parse(readFileSync(config, 'utf8'));
                } catch (error) {
                    this.configurationProblems.push({ root, message: `tonto.json cannot be read: ${error instanceof Error ? error.message : String(error)}. Its location mappings are ignored until it is fixed.` });
                    continue;
                }
                const locations = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { locations?: unknown }).locations : parsed;
                if (locations === undefined) continue;
                if (!locations || typeof locations !== 'object' || Array.isArray(locations)) {
                    this.configurationProblems.push({ root, message: 'tonto.json must be a JSON object whose "locations" is an object of URL-to-location mappings. Its mappings are ignored until it is fixed.' });
                    continue;
                }
                this.addMappings(this.mappings.get(root)!, locations as Record<string, unknown>, root, 'tonto.json');
            }
            // What the caller supplies applies to every root, over each one's own.
            const supplied = options.locations ?? {};
            // A host with no workspace root may have no `process` either: an
            // editor in a browser checks one document and supplies no locations.
            if (this.roots.length === 0) this.addMappings(this.mappingsOf(undefined), supplied, globalThis.process?.cwd() ?? '/', 'The supplied locations');
            for (const root of this.roots) this.addMappings(this.mappings.get(root)!, supplied, this.roots[0]!, 'The supplied locations');
        }
        this.snapshots = new Map();
        this.cacheProblems = new Map();
        for (const root of this.roots) {
            const cache = this.cachePath(root);
            try {
                const snapshot = existsSync(cache) ? JSON.parse(readFileSync(cache, 'utf8')) as CacheSnapshot : { entries: {} };
                if (!snapshot.entries || typeof snapshot.entries !== 'object') throw new Error('Missing cache entries.');
                this.snapshots.set(root, snapshot);
            } catch {
                this.snapshots.set(root, { entries: {} });
                this.cacheProblems.set(root, `The cache snapshot "${cache}" cannot be read. `);
            }
        }
    }

    /**
     * Folders beneath a configured root that hold a `tonto.json`, found by
     * walking up from the documents loaded there: the command line takes the
     * nearest such folder above a file as its workspace, and the editor does
     * the same, rather than letting the open folder hide it.
     */
    private nestedRoots(): string[] {
        const found = new Set<string>();
        const seen = new Set<string>();
        for (const document of this.services.workspace.LangiumDocuments.all) {
            if (document.uri.scheme !== 'file' || this.loaded.has(document.uri.toString())) continue;
            const path = document.uri.fsPath;
            const root = this.given.filter(given => path.startsWith(given + sep)).sort((a, b) => b.length - a.length)[0];
            if (!root) continue;
            for (let directory = dirname(path); directory !== root && directory.startsWith(root + sep); directory = dirname(directory)) {
                if (seen.has(directory)) break;
                seen.add(directory);
                if (existsSync(join(directory, 'tonto.json'))) found.add(directory);
            }
        }
        return [...found].sort();
    }

    /** The workspace root a document belongs to: the nearest one holding it, or the one that loaded it. */
    rootOf(document: LangiumDocument): string | undefined {
        const origin = this.origins.get(document.uri.toString());
        if (origin) return origin;
        if (document.uri.scheme !== 'file') return this.roots[0];
        const path = document.uri.fsPath;
        return this.roots.filter(root => path === root || path.startsWith(root + sep)).sort((a, b) => b.length - a.length)[0] ?? this.roots[0];
    }

    private mappingsOf(root: string | undefined): Record<string, string> {
        const key = root ?? '';
        let mappings = this.mappings.get(key);
        if (!mappings) {
            mappings = {};
            this.mappings.set(key, mappings);
        }
        return mappings;
    }

    private snapshotOf(root: string | undefined): CacheSnapshot {
        return (root && this.snapshots.get(root)) || { entries: {} };
    }

    private addMappings(target: Record<string, string>, mappings: Record<string, unknown>, root: string, source: string): void {
        for (const [key, value] of Object.entries(mappings)) {
            const problem = mappingProblem(key, value);
            if (problem || typeof value !== 'string') {
                this.configurationProblems.push({ root, message: `${source}: ${problem}; it is ignored.` });
                continue;
            }
            target[key] = /^[a-z][a-z\d+.-]*:/i.test(value)
                ? value : URI.file(underRoot(root, value)).toString() + (value.endsWith('/') ? '/' : '');
        }
    }

    private cachePath(root: string): string {
        return join(root, '.tonto', this.options.publication ? 'publication.json' : 'development.json');
    }

    private mapped(location: string, root: string | undefined): string {
        if (this.options.publication) return location;
        const mappings = this.mappingsOf(root);
        const key = Object.keys(mappings)
            .filter(key => key.endsWith('/') ? location.startsWith(key) : key === location)
            .sort((a, b) => b.length - a.length)[0];
        return key ? mappings[key] + (key.endsWith('/') ? location.slice(key.length) : '') : location;
    }

    private resolveLocation(location: string, from: LangiumDocument): { requested: string; mapped: string } {
        const raw = location.slice(1, -1);
        const base = this.effective.get(from.uri.toString()) ?? from.uri.toString();
        const requested = new URL(raw, base).href;
        const protocol = new URL(requested).protocol;
        if (protocol !== 'http:' && protocol !== 'https:' && !(protocol === 'file:' && from.uri.scheme === 'file')) {
            throw new Error(`Location <${raw}> uses a forbidden scheme.`);
        }
        if (requested.includes('#')) throw new Error(`Document location <${raw}> must not contain a fragment.`);
        let mapped = this.mapped(requested, this.rootOf(from));
        if (mapped.startsWith('file:')) {
            const path = URI.parse(mapped).fsPath;
            if (existsSync(path)) mapped = URI.file(realpathSync(path)).toString();
        }
        return { requested, mapped };
    }

    /** Original import locations that resolve through a substitute in these ontologies. */
    substitutedImports(units: Iterable<OntologyUnit>): string[] {
        const substituted = new Set<string>();
        const inspected = new Set<Import>();
        for (const unit of units) for (const member of closureOf(unit)) {
            const imports = [
                ...(member.root?.parseResult.value.imports ?? []),
                ...member.packages.flatMap(pkg => [
                    ...(AstUtils.getDocument(pkg).parseResult.value as Model).imports,
                    ...pkg.imports
                ])
            ];
            for (const imp of imports) {
                if (!imp.location || inspected.has(imp)) continue;
                inspected.add(imp);
                try {
                    const location = this.resolveLocation(imp.location, AstUtils.getDocument(imp));
                    if (location.requested !== location.mapped) substituted.add(location.requested);
                } catch { /* The regular export reports an invalid location. */ }
            }
        }
        return [...substituted].sort();
    }

    private load(location: string, from: LangiumDocument, node: AstNode): LangiumDocument<Model> | undefined {
        try {
            const { requested, mapped } = this.resolveLocation(location, from);
            const uri = URI.parse(mapped);
            const existing = this.services.workspace.LangiumDocuments.getDocument(uri)
                ?? (uri.scheme === 'file' ? this.services.workspace.LangiumDocuments.all.find(doc => {
                    if (doc.uri.scheme !== 'file') return false;
                    return canonicalRealPath(doc.uri.fsPath) === uri.fsPath;
                }) : undefined);
            if (existing && isModel(existing.parseResult.value)) return existing as LangiumDocument<Model>;
            let source: string;
            if (uri.scheme === 'file') {
                try {
                    source = this.services.workspace.FileSystemProvider.readFileSync(uri);
                } catch {
                    // Name the mapping: the import says one location and the
                    // file that is missing is somewhere else entirely.
                    throw new Error(mapped === requested || requested.startsWith('file:')
                        ? `Document <${requested}> cannot be read.`
                        : `Location <${requested}> is mapped to ${uri.fsPath}, which cannot be read. Check the mapping in tonto.json or --locations.`);
                }
            } else if (uri.scheme === 'http' || uri.scheme === 'https') {
                const root = this.rootOf(from);
                const entry = this.snapshotOf(root).entries[requested];
                if (!entry || entry.mapped !== mapped) {
                    throw new Error(`${(root && this.cacheProblems.get(root)) ?? ''}Document <${requested}> is not cached. Run tonto fetch${this.options.publication ? ' --publication' : ''}.`);
                }
                if (hash(entry.source) !== entry.sha256) throw new Error(`Cached document <${requested}> failed its SHA-256 check. Run tonto fetch --refresh.`);
                source = entry.source;
                this.effective.set(mapped, entry.effective);
            } else {
                throw new Error(`Unsupported mapped location <${mapped}>.`);
            }
            const document = this.services.workspace.LangiumDocumentFactory.fromString<Model>(source, uri);
            this.services.workspace.LangiumDocuments.addDocument(document);
            this.loaded.set(mapped, document);
            const root = this.rootOf(from);
            if (root) this.origins.set(mapped, root);
            return document;
        } catch (error) {
            const message = String(error instanceof Error ? error.message : error);
            this.problem(node, 'publication-location', `${message} Until it loads, the importing ontology is checked only for names and ownership.`);
            return undefined;
        }
    }

    /** No network access here: dependencies come only from disk or the explicit-fetch snapshot. */
    prepare(): LangiumDocument[] {
        this.configure(this.given);
        // A second check in a long-lived API/editor session must see an
        // explicitly refreshed cache or changed external local dependency.
        for (const [uri, remembered] of this.loaded) {
            const document = this.services.workspace.LangiumDocuments.getDocument(URI.parse(uri)) ?? remembered;
            let source: string | undefined;
            let redirectChanged = false;
            try {
                const cached = Object.values(this.snapshotOf(this.origins.get(uri)).entries).find(entry => entry.mapped === uri);
                // Identical text at a new redirect destination can resolve
                // every relative import and bundle to a different document.
                redirectChanged = document.uri.scheme !== 'file' && cached?.effective !== this.effective.get(uri);
                source = document.uri.scheme === 'file' ? this.services.workspace.TextDocuments?.get(uri)?.getText()
                    ?? this.services.workspace.FileSystemProvider.readFileSync(document.uri)
                    : cached && hash(cached.source) === cached.sha256 ? cached.source : undefined;
            } catch { /* Missing now: let the introducing location report it. */ }
            if (source === undefined || source !== document.textDocument.getText() || redirectChanged) {
                this.services.workspace.LangiumDocuments.deleteDocument(document.uri);
                this.services.workspace.IndexManager.removeContent(document.uri);
                this.services.workspace.IndexManager.removeReferences(document.uri);
                this.loaded.delete(uri);
                this.effective.delete(uri);
                // These changes were discovered after the builder chose its
                // affected documents. Even unchanged ownership now points to
                // new trees, so clients must drop their old resolved links.
                this.dependencyRevision++;
            }
        }
        this.problems = [];
        this.units = [];
        for (const { root, message } of this.configurationProblems) this.configurationProblem(root, message);
        this.imported = new WeakMap();
        const allDocuments = this.services.workspace.LangiumDocuments.all.toArray()
            .filter((doc): doc is LangiumDocument<Model> => isModel(doc.parseResult.value) && doc.uri.toString() !== BUILTIN_DATATYPES_URI);
        for (const doc of allDocuments) doc.parseResult.value.packages.forEach(pkg => owners.delete(pkg));
        const documents = allDocuments.filter(doc => !['http', 'https'].includes(doc.uri.scheme)
            && (!this.loaded.has(doc.uri.toString()) || this.roots.some(root => doc.uri.fsPath.startsWith(root + sep))));
        const entryRoots = new Map<LangiumDocument<Model>, OntologyUnit>();
        const claimed = new Set<Package>();
        const pendingImports: Array<{ imp: Import; document: LangiumDocument<Model>; unit?: OntologyUnit }> = [];
        const problem = (node: AstNode, code: string, message: string, property?: string, warning?: boolean): void =>
            this.problem(node, code, message, property, warning);
        const entry = (document: LangiumDocument<Model>): OntologyUnit => {
            const known = entryRoots.get(document);
            if (known) return known;
            const model = document.parseResult.value;
            const declaration = model.ontologies[0];
            const unit: OntologyUnit = {
                id: document.uri.toString(), name: declaration?.name ?? model.packages[0]?.name ?? 'ontology',
                root: document, declaration, packages: [], dependencies: new Set(), unbundled: false
            };
            entryRoots.set(document, unit);
            this.units.push(unit);
            for (const extra of model.ontologies.slice(1)) {
                problem(extra, 'ontology-header', 'A document declares at most one ontology; give this one a document of its own.', 'name');
            }
            if (declaration) {
                const body = model.packages.find(isOntologyBody);
                if (declaration.bundled && !declaration.bundles.length) problem(declaration, 'ontology-header', 'A "bundles" clause lists at least one package.', 'name');
                if (body?.declarations[0] && (declaration.bundled || model.packages.some(pkg => !isOntologyBody(pkg)))) {
                    problem(body.declarations[0], 'ontology-loose-declarations',
                        `Ontology "${declaration.name}" has packages, so its declarations belong in one: these, written straight after the header, would be a package without a name, which no other package can use.`,
                        body.declarations[0].name ? 'name' : undefined);
                }
                // The entry's own packages are members by being written here.
                for (const pkg of model.packages) {
                    assign(pkg, unit, pkg);
                    if (pkg.owner === undefined || isOntologyBody(pkg)) continue;
                    if (pkg.owner === declaration.name) {
                        problem(pkg, 'package-in-redundant', `Package "${pkg.name}" is written in the ontology file of "${declaration.name}", which makes it a member already; "in ${pkg.owner}" says it again.`, 'owner', true);
                    } else {
                        problem(pkg, 'package-in-mismatch', `Package "${pkg.name}" is written in the ontology file of "${declaration.name}", so it cannot be in "${pkg.owner}".`, 'owner');
                    }
                }
                for (const bundle of declaration.bundles) {
                    bundleTargets.delete(bundle);
                    if (!relativeBundleLocation(bundle.location)) {
                        unit.incomplete = true;
                        problem(bundle, 'ontology-bundle-location',
                            `Bundle "${bundle.name}" must use a relative source path in "from". Import another ontology by location instead.`, 'location');
                        continue;
                    }
                    const source = this.load(bundle.location, document, bundle);
                    if (!source) {
                        unit.incomplete = true;
                        continue;
                    }
                    if (source.parseResult.value.ontologies.length) {
                        unit.incomplete = true;
                        problem(bundle, 'ontology-bundle', 'A bundle location must select a package file, not another ontology file.');
                        continue;
                    }
                    const matches = source.parseResult.value.packages.filter(pkg => pkg.name === bundle.name);
                    if (matches.length !== 1) {
                        unit.incomplete = true;
                        problem(bundle, 'ontology-bundle', `Bundle "${bundle.name}" selects ${matches.length} packages; exactly one is required in <${bundle.location.slice(1, -1)}>.`);
                    } else {
                        const member = matches[0];
                        bundleTargets.set(bundle, member);
                        assign(member, unit, bundle);
                        if (member.owner === undefined) {
                            problem(member, 'package-file-without-in', `Package "${member.name}" is bundled by ontology "${declaration.name}"; say so with "package ${member.name} in ${declaration.name}".`, 'name', !this.options.publication);
                        } else if (member.owner !== declaration.name) {
                            problem(member, 'package-in-mismatch', `Package "${member.name}" is bundled by ontology "${declaration.name}", not "${member.owner}".`, 'owner');
                        }
                    }
                }
            } else {
                for (const pkg of model.packages) assign(pkg, unit, pkg);
            }
            inspect(document, unit);
            for (const pkg of unit.packages) inspect(AstUtils.getDocument(pkg) as LangiumDocument<Model>, unit, pkg);
            return unit;
        };
        const assign = (pkg: Package, unit: OntologyUnit, node: AstNode): void => {
            if (claimed.has(pkg)) {
                const previous = owners.get(pkg);
                problem(node, 'package-bundled-twice', previous === unit
                    ? `Package "${pkg.name}" is bundled more than once.`
                    : `Package "${pkg.name}" already belongs to ontology "${previous?.name}".`);
                return;
            }
            claimed.add(pkg);
            owners.set(pkg, unit);
            unit.packages.push(pkg);
        };
        const inspect = (document: LangiumDocument<Model>, unit?: OntologyUnit, selected?: Package): void => {
            // Package-level imports in unselected siblings do not expand a bundle.
            const model = document.parseResult.value;
            const imports = [...model.imports, ...(selected ? selected.imports : unit?.declaration ? [] : model.packages.flatMap(pkg => pkg.imports))];
            for (const imp of imports) {
                if (!imp.location) continue;
                if (!pendingImports.some(item => item.imp === imp && item.unit === unit)) pendingImports.push({ imp, document, unit });
            }
        };
        // Ontology files establish all ownership before internal imports are linked.
        for (const doc of documents) if (doc.parseResult.value.ontologies.length) entry(doc);
        for (const doc of documents) {
            // A bundled package's imports were inspected for its ontology.
            const packages = doc.parseResult.value.packages;
            if (!entryRoots.has(doc) && !(packages.length && packages.every(pkg => claimed.has(pkg)))) inspect(doc);
        }
        for (let i = 0; i < pendingImports.length; i++) {
            const pending = pendingImports[i];
            const target = this.load(pending.imp.location!, pending.document, pending.imp);
            if (!target) continue;
            // A member's document is part of an ontology, not one.
            const member = target.parseResult.value.ontologies.length ? undefined
                : target.parseResult.value.packages.find(pkg => pkg.owner !== undefined);
            if (member) {
                problem(pending.imp, 'package-file-import', `<${pending.imp.location!.slice(1, -1)}> holds package "${member.name}" of ontology "${member.owner}", not an ontology of its own. Import the ontology file of "${member.owner}" instead.`, 'location');
                continue;
            }
            // Only a header declares an ontology; a document without one has none to import.
            if (!target.parseResult.value.ontologies.length) {
                problem(pending.imp, 'ontology-file-required', `<${pending.imp.location!.slice(1, -1)}> declares no ontology. An import names an ontology file, which starts with an "ontology" header.`, 'location');
                continue;
            }
            const unit = entry(target);
            this.imported.set(pending.imp, unit);
        }
        // Documents loaded as dependencies are entry-bounded, never absorbed by the default.
        const authored = documents.filter(doc => !this.loaded.has(doc.uri.toString())
            || (doc.uri.scheme === 'file' && this.roots.some(root => doc.uri.fsPath.startsWith(root + sep))));
        const residual = authored.flatMap(doc => doc.parseResult.value.packages).filter(pkg => !claimed.has(pkg));
        // Authored entries are what `in` names, so their names must tell them apart.
        const entries = [...entryRoots.values()].filter(unit => unit.declaration && authored.includes(unit.root!));
        for (const unit of entries) {
            // Each root is a workspace of its own, and names need only differ within one.
            const twin = entries.find(other => other !== unit && other.declaration!.name === unit.declaration!.name
                && this.rootOf(other.root!) === this.rootOf(unit.root!));
            if (twin) problem(unit.declaration!, 'ontology-name-clash', `Ontology "${unit.name}" is also declared in ${basename(twin.root!.uri.path)}; the ontologies of one workspace need distinct names.`, 'name');
        }
        // A package that names its ontology is unbundled until that ontology's file bundles it.
        const declared = new Map<string, Package[]>();
        for (const pkg of residual) {
            if (pkg.owner === undefined) continue;
            const here = this.rootOf(AstUtils.getDocument(pkg));
            const named = entries.filter(unit => unit.declaration!.name === pkg.owner && this.rootOf(unit.root!) === here);
            if (named.length === 1) {
                const oneFile = named[0].packages.some(isOntologyBody);
                problem(pkg, 'package-not-bundled', oneFile
                    ? `Package "${pkg.name}" says it is in ontology "${pkg.owner}", a one-file ontology that bundles nothing. Split "${pkg.owner}" into an ontology file and a package to bundle more.`
                    : `Package "${pkg.name}" says it is in ontology "${pkg.owner}", but ${basename(named[0].root!.uri.path)} does not bundle it.`, 'owner');
            } else if (!named.length) {
                problem(pkg, 'ontology-file-missing', `No ontology file for "${pkg.owner}" is in this workspace. Package "${pkg.name}" is checked with the other packages in "${pkg.owner}", but cannot be published until an ontology file bundles it.`, 'owner', !this.options.publication);
            }
            const path = AstUtils.getDocument(pkg).uri.fsPath;
            const root = this.roots.filter(root => path.startsWith(root + sep)).sort((a, b) => b.length - a.length)[0] ?? '';
            const key = `${root ? URI.file(root).toString() : 'workspace:'}#in:${pkg.owner}`;
            declared.set(key, [...declared.get(key) ?? [], pkg]);
        }
        for (const [id, packages] of declared) {
            const unit: OntologyUnit = { id, name: packages[0].owner!, dependencies: new Set(), packages: [], unbundled: true };
            this.units.push(unit);
            for (const pkg of packages) assign(pkg, unit, pkg);
        }
        // A package of no ontology is checked with the others of its document, and nothing else.
        const unowned = new Map<LangiumDocument, Package[]>();
        for (const pkg of residual) {
            if (pkg.owner !== undefined) continue;
            // An unnamed package is reported as that; its ontology comes after its name.
            if (pkg.name) problem(pkg, 'package-without-ontology', `Package "${pkg.name}" belongs to no ontology. Write an "ontology" header above it, or say which ontology bundles it with "package ${pkg.name} in <ontology>".`, 'name');
            const document = AstUtils.getDocument(pkg);
            unowned.set(document, [...unowned.get(document) ?? [], pkg]);
        }
        for (const [document, packages] of unowned) {
            const unit: OntologyUnit = { id: `${document.uri}#unowned`, name: packages[0].name ?? 'model', dependencies: new Set(), packages: [], unbundled: true };
            this.units.push(unit);
            for (const pkg of packages) assign(pkg, unit, pkg);
        }
        for (const pending of pendingImports) {
            const target = this.imported.get(pending.imp);
            const scopes = pending.unit ? [pending.unit] : pending.document.parseResult.value.packages
                .filter(pkg => !isPackage(pending.imp.$container) || pending.imp.$container === pkg)
                .map(pkg => owners.get(pkg)).filter((unit): unit is OntologyUnit => !!unit);
            for (const source of scopes) {
                if (target) source.dependencies.add(target); else source.incomplete = true;
            }
        }
        // An ontology is checked against its whole closure or not at all (§7.2).
        for (const unit of this.units) {
            if ([...closureOf(unit)].some(member => member.incomplete)) unit.incomplete = true;
        }
        // Only the header gives an ontology its namespace; a package is published with it.
        for (const unit of this.units) unit.namespace = unit.declaration && declaredNamespace(unit.declaration);
        const lacking = this.units.filter(unit => !unit.namespace && this.exportNamespace
            && ((unit.root && this.exportNamespace.documents.has(unit.root.uri.toString()))
                || unit.packages.some(pkg => this.exportNamespace!.documents.has(AstUtils.getDocument(pkg).uri.toString()))));
        if (lacking.length === 1 && this.exportNamespace) {
            lacking[0].namespace = this.exportNamespace.value;
            lacking[0].namespaceSupplied = true;
        }
        for (const unit of this.units) {
            if ((this.options.publication || unit.root?.uri.scheme.startsWith('http')) && (!unit.namespace || !unit.namespace.endsWith('#')
                || (unit.declaration && !declaredNamespace(unit.declaration) && !unit.namespaceSupplied))) {
                problem(unit.declaration ?? unit.packages[0] ?? unit.root!.parseResult.value, 'publication-namespace', 'Publication and remote imports require an explicit HTTP(S) hash namespace.');
            }
            for (const other of this.units) {
                if (other !== unit && unit.namespace && unit.namespace === other.namespace) {
                    problem(unit.declaration ?? unit.packages[0], 'ontology-namespace-conflict', `Ontologies "${unit.name}" and "${other.name}" both claim <${unit.namespace}>. Give one another namespace, or, if they are one ontology, a location mapping that makes them one.`);
                    break;
                }
            }
        }
        return this.services.workspace.LangiumDocuments.all.toArray();
    }

    /**
     * Everything ownership decides, in terms that survive a reparse: which
     * packages each ontology owns, what it imports, whether its closure
     * loaded, and what was reported. Dependencies replaced during discovery
     * also invalidate clients: the builder's usual affected set was computed
     * before those changes were known.
     */
    signature(): string {
        const key = (pkg: Package): string => {
            const model = AstUtils.getContainerOfType(pkg, isModel)!;
            return `${AstUtils.getDocument(pkg).uri}#${pkg.name}#${model.packages.indexOf(pkg)}`;
        };
        const units = this.units.map(unit => [unit.id, unit.name, unit.namespace, unit.incomplete === true, unit.unbundled,
            unit.packages.map(key).sort().join(','), [...unit.dependencies].map(other => other.id).sort().join(',')].join('|')).sort();
        const problems = this.problems.map(problem => `${AstUtils.getDocument(problem.node).uri}|${problem.code}|${problem.message}`).sort();
        return JSON.stringify([units, problems, [...this.loaded.keys()].sort(), this.dependencyRevision]);
    }

    /** One report per node and message, however often discovery reaches it. */
    private problem(node: AstNode, code: string, message: string, property?: string, warning?: boolean): void {
        if (this.problems.some(known => known.node === node && known.message === message)) return;
        this.problems.push({ node, code, message, property, warning });
    }

    /** Whether a location import failed to load, so references through its alias cannot bind. */
    failed(imp: Import): boolean {
        return !!imp.location && !this.imported.has(imp);
    }

    /** `tonto.json` is not a tonto document, so its problems are reported at the root's first file. */
    private configurationProblem(root: string, message: string): void {
        const documents = this.services.workspace.LangiumDocuments.all.toArray()
            .filter((doc): doc is LangiumDocument<Model> => doc.uri.scheme === 'file' && isModel(doc.parseResult.value))
            .sort((a, b) => a.uri.toString().localeCompare(b.uri.toString()));
        const document = documents.find(doc => doc.uri.fsPath.startsWith(root + sep)) ?? documents[0];
        if (!document) return;
        const model = document.parseResult.value;
        const named = model.ontologies[0] ?? model.packages.find(pkg => pkg.name);
        this.problem(named ?? model, 'publication-configuration', message, named ? 'name' : undefined);
    }

    selected(primary: LangiumDocument[]): { documents: LangiumDocument[]; units: Set<OntologyUnit> } {
        const units = new Set<OntologyUnit>();
        for (const document of primary) {
            for (const unit of this.units) {
                if (unit.root === document || unit.packages.some(pkg => AstUtils.getDocument(pkg) === document)) units.add(unit);
            }
        }
        const closure = new Set([...units].flatMap(unit => [...closureOf(unit)]));
        const documents = new Set<LangiumDocument>(primary);
        for (const unit of closure) {
            if (unit.root) documents.add(unit.root);
            unit.packages.forEach(pkg => documents.add(AstUtils.getDocument(pkg)));
        }
        return { documents: [...documents], units };
    }

    /**
     * The only network-enabled operation. Each path is fetched into the cache
     * of the workspace root it belongs to, with that root's mappings, and each
     * root commits one complete snapshot.
     */
    async fetch(paths: string[], refresh = false): Promise<FetchResult> {
        // A session may outlive a mapping edit or another session's fetch.
        // Start from the current snapshots so a partial fetch preserves both.
        this.configure(this.given);
        const byRoot = new Map<string | undefined, string[]>();
        for (const path of paths) {
            const resolved = resolve(path);
            const root = this.roots.filter(root => resolved === root || resolved.startsWith(root + sep))
                .sort((a, b) => b.length - a.length)[0] ?? this.roots[0];
            byRoot.set(root, [...byRoot.get(root) ?? [], path]);
        }
        const result: FetchResult = { retrieved: [], cached: [], added: [], changed: [], removed: [] };
        for (const [root, group] of byRoot) {
            const part = await this.fetchInto(root, group, refresh);
            for (const key of Object.keys(result) as Array<keyof FetchResult>) result[key].push(...part[key]);
        }
        const stale = [...this.loaded.values()].filter(doc => doc.uri.scheme !== 'file').map(doc => doc.uri);
        stale.forEach(uri => this.loaded.delete(uri.toString()));
        if (stale.length) await this.services.workspace.DocumentBuilder.update([], stale);
        return result;
    }

    private async fetchInto(root: string | undefined, paths: string[], refresh: boolean): Promise<FetchResult> {
        if (!root) throw new Error('Explicit fetch requires a workspace directory for its cache.');
        const previous = this.snapshotOf(root).entries;
        const candidate: CacheSnapshot = { entries: { ...previous } };
        const retrieved: string[] = [];
        const cached: string[] = [];
        const reached = new Set<string>();
        const seen = new Set<string>();
        const sources = new Map<string, { source: string; effective: string; entry?: CacheEntry }>();
        const visit = async (requested: string, selector?: string): Promise<void> => {
            reached.add(requested);
            const mapped = this.mapped(requested, root);
            const loaded = sources.get(mapped);
            // Reuse this run's entry, not the first matching alias in the
            // previous snapshot, which may still contain the old revision.
            if (loaded?.entry) candidate.entries[requested] = { ...loaded.entry, requested };
            const key = `${mapped}\n${selector ?? '*'}`;
            if (seen.has(key)) return;
            seen.add(key);
            let source: string;
            let effective = mapped;
            if (loaded) ({ source, effective } = loaded);
            else if (mapped.startsWith('file:')) source = this.services.workspace.FileSystemProvider.readFileSync(URI.parse(mapped));
            else {
                const previous = candidate.entries[requested];
                if (!refresh && previous?.mapped === mapped && hash(previous.source) === previous.sha256) {
                    source = previous.source;
                    effective = previous.effective;
                    cached.push(requested);
                } else {
                    if (!/^https?:\/\//.test(mapped)) throw new Error(`Unsupported retrieval location <${mapped}>.`);
                    const response = await fetch(mapped, { signal: AbortSignal.timeout(30_000) });
                    if (!response.ok) throw new Error(`Retrieval of <${requested}> failed: HTTP ${response.status}.`);
                    effective = response.url;
                    if (!/^https?:\/\//.test(effective)) throw new Error('A remote redirect must remain HTTP(S).');
                    source = await response.text();
                    candidate.entries[requested] = { requested, mapped, effective, source, retrieved: new Date().toISOString(), sha256: hash(source) };
                    retrieved.push(requested);
                }
            }
            sources.set(mapped, { source, effective, entry: mapped.startsWith('file:') ? undefined : candidate.entries[requested] });
            const parser = this.services.ServiceRegistry.all[0].parser.LangiumParser;
            const parsed = parser.parse<Model>(source);
            if (parsed.lexerErrors.length || parsed.parserErrors.length) throw new Error(`Cannot retrieve closure: <${requested}> has syntax errors.`);
            const model = parsed.value;
            const packages = selector === undefined ? model.packages : model.packages.filter(pkg => pkg.name === selector);
            if (selector !== undefined && (packages.length !== 1 || model.ontologies.length)) {
                throw new Error(`Bundle "${selector}" must select exactly one package in <${requested}>.`);
            }
            const links = [...model.imports, ...packages.flatMap(pkg => pkg.imports), ...model.ontologies.flatMap(ontology => ontology.bundles)];
            for (const link of links) {
                if (!link.location) continue;
                if (link.$type === 'BundleEntry' && !relativeBundleLocation(link.location)) {
                    throw new Error(`Bundle "${(link as BundleEntry).name}" in <${requested}> must use a relative source path.`);
                }
                const raw = link.location.slice(1, -1);
                const next = new URL(raw, effective);
                if (!['http:', 'https:', ...(effective.startsWith('file:') ? ['file:'] : [])].includes(next.protocol) || next.href.includes('#')) {
                    throw new Error(`Invalid dependency location <${raw}> in <${requested}>.`);
                }
                await visit(next.href, link.$type === 'BundleEntry' ? (link as BundleEntry).name : undefined);
            }
        };
        for (const path of paths) await visit(URI.file(resolve(path)).toString());
        // Only a retrieval over the whole workspace knows what nothing needs:
        // fetching one ontology file must not drop another's dependencies.
        const whole = this.covered(root, paths);
        const removed = whole ? Object.keys(candidate.entries).filter(key => !reached.has(key)).sort() : [];
        for (const key of removed) delete candidate.entries[key];
        const added = retrieved.filter(key => !previous[key]);
        const changed = retrieved.filter(key => previous[key] && previous[key].sha256 !== candidate.entries[key].sha256);
        const destination = this.cachePath(root);
        if (existsSync(dirname(destination)) && lstatSync(dirname(destination)).isSymbolicLink()) {
            throw new Error('The workspace cache directory must not be a symbolic link.');
        }
        mkdirSync(dirname(destination), { recursive: true });
        const temporary = `${destination}.${randomUUID()}.tmp`;
        try {
            writeFileSync(temporary, JSON.stringify(candidate, undefined, 2), { encoding: 'utf8', flag: 'wx' });
            renameSync(temporary, destination);
        } catch (error) {
            try { unlinkSync(temporary); } catch { /* No staged file, or already committed. */ }
            throw error;
        }
        this.snapshots.set(root, candidate);
        return { retrieved, cached, added, changed, removed };
    }

    /** Whether the fetched paths include every authored document under this root. */
    private covered(root: string, paths: string[]): boolean {
        const real = canonicalRealPath;
        const targets = paths.map(real);
        const reaches = (file: string): boolean => targets.some(target => file === target || file.startsWith(target + sep));
        return this.services.workspace.LangiumDocuments.all.toArray()
            .filter(doc => doc.uri.scheme === 'file' && !this.loaded.has(doc.uri.toString()) && this.rootOf(doc) === root)
            .every(doc => reaches(real(doc.uri.fsPath)));
    }

    isReadOnly(document: LangiumDocument): boolean {
        if (document.uri.scheme !== 'file') return true;
        if (!this.loaded.has(document.uri.toString())) return false;
        return !this.roots.some(root => document.uri.fsPath === root || document.uri.fsPath.startsWith(root + sep));
    }
}

function hash(source: string): string { return createHash('sha256').update(source).digest('hex'); }
