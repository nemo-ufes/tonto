import type { AstNode, ValidationAcceptor } from 'langium';
import { AstUtils, isReference } from 'langium';
import type { Import, Model, Package } from '../generated/ast.js';
import { isImport, isModel, isPackage } from '../generated/ast.js';
import { bundleTargets, entryImportsFor, ownerOf } from '../publication/workspace.js';

/**
 * Imports are checked per scope, which is what a scope is here.
 *
 * A package sees the file's own uses and its own: `model.imports` reach
 * every package in the file, while `pkg.imports` reach only that one. The
 * checks used to flatten the two into a list per document, which got both
 * questions wrong -- two packages in one file each using what each of
 * them refers to was reported as a duplicate, and a use needed by one of them
 * counted as used by the other, so the one that never touched it was never
 * reported.
 */
interface Scope {
    /** The imports written in this scope. */
    imports: Import[];
    /** The imports already covering it, which are the file's own. */
    outer: Import[];
    /** Where a reference has to be, for an import here to be used. */
    within: AstNode;
}

function scopesOf(model: Model): Scope[] {
    return [
        { imports: model.imports, outer: [], within: model },
        ...model.packages.map(pkg => ({ imports: pkg.imports, outer: [...entryImportsFor(pkg), ...model.imports], within: pkg }))
    ];
}

/** Every import written in a document, whether at top level or inside a package. */
function allImports(model: Model): Import[] {
    return [...model.imports, ...model.packages.flatMap(pkg => pkg.imports)];
}

export function checkImports(model: Model, accept: ValidationAcceptor): void {
    const localPackages = new Set<Package>();
    for (const imp of allImports(model)) {
        const target = imp.package?.ref;
        if (target && (imp.$container === target || (imp.$container === model && model.packages.every(pkg => pkg === target)))) {
            // A warning, as the other two redundant imports are: nothing is
            // wrong with the model, a line of it says nothing.
            accept('warning', `"${target.name}" is declared in this file and needs no \`use\`.`, {
                node: imp,
                property: 'package',
                code: 'self-use'
            });
        }
        // Packages are used and ontologies imported. `import core` is parsed,
        // so that the error can say which word was meant, and resolved, so
        // that one wrong keyword does not unresolve everything after it.
        if (!imp.use && !imp.location && imp.package) {
            accept('error', `Packages are used, not imported: write "use ${imp.package.$refText}". \`import\` brings in another ontology, by the location of its ontology file.`, {
                node: imp,
                keyword: 'import',
                code: 'import-for-use'
            });
        }
    }

    for (const scope of scopesOf(model)) {
        checkScope(scope, localPackages, accept);
    }
    // A source document can hold several packages with different owners. Check
    // its document-level aliases against each relevant entry without making
    // one owner's imports visible to another package.
    const checked = new Set<Import>();
    for (const pkg of model.packages) {
        const inherited = entryImportsFor(pkg);
        if (!inherited.length) continue;
        const names = new Set(inherited.map(imp => imp.alias).filter(Boolean));
        for (const imp of model.imports) {
            if (imp.alias && names.has(imp.alias) && !checked.has(imp)) {
                checked.add(imp);
                accept('error', `"${imp.alias}" is already an ontology import alias in the ontology file of "${ownerOf(pkg)?.name}".`,
                    { node: imp, property: 'alias', code: 'duplicate-alias' });
            }
        }
    }
}

/** A use as written: `use core`, or the older spelling `import core`. */
function written(imp: Import): string {
    return `${imp.use ? 'use' : 'import'} ${imp.package?.$refText ?? ''}`;
}

function checkScope(scope: Scope, localPackages: ReadonlySet<Package>, accept: ValidationAcceptor): void {
    const named = (imp: Import): string | undefined => imp.package?.ref?.name;
    const covered = new Map<string, Import>();
    for (const imp of scope.outer) {
        const name = named(imp);
        if (name !== undefined) {
            covered.set(name, imp);
        }
    }
    const used = packagesUsedWithin(scope.within);

    for (const imp of scope.imports) {
        const target = imp.package?.ref;
        if (!target?.name || localPackages.has(target)) {
            continue;
        }
        const previous = covered.get(target.name);
        if (previous) {
            accept('warning',
                `"${target.name}" is already used ${scope.outer.includes(previous) ? 'by this file' : 'here'}, so \`${written(imp)}\` says nothing.`,
                { node: imp, property: 'package', code: 'duplicate-use' });
            continue;
        }
        covered.set(target.name, imp);
        if (!used.has(target)) {
            accept('warning', `\`${written(imp)}\` is unnecessary: nothing here refers to "${target.name}".`,
                { node: imp, property: 'package', code: 'unnecessary-use' });
        }
    }

    checkAliases(scope, accept);
}

/**
 * An alias is a second name for a package, and it goes into the same scope as
 * the names already there. Two imports under one alias, or an alias spelled
 * like a package that is already reachable, make `alias.X` mean two things --
 * and the scope answers with whichever it happens to hold first, which is not
 * a decision anyone made.
 */
function checkAliases(scope: Scope, accept: ValidationAcceptor): void {
    const reachable = new Map<string, string>();
    const model = AstUtils.getContainerOfType(scope.within, isModel);
    const owned = isPackage(scope.within)
        ? ownerOf(scope.within)?.packages
        : model && [...model.packages,
            ...model.ontologies.flatMap(ontology => ontology.bundles.map(bundle => bundleTargets.get(bundle)).filter((pkg): pkg is Package => !!pkg))];
    for (const pkg of owned ?? model?.packages ?? []) {
        if (pkg.name) {
            reachable.set(pkg.name, model?.packages.includes(pkg)
                ? 'a package declared in this file' : 'a bundled package');
        }
    }
    for (const imp of [...scope.outer, ...scope.imports]) {
        const target = imp.package?.ref;
        if (target?.name) {
            reachable.set(target.name, `the package "${target.name}"`);
        }
    }
    const aliases = new Map<string, Import>();
    for (const imp of [...scope.outer, ...scope.imports]) {
        if (!imp.alias) {
            continue;
        }
        const clash = aliases.get(imp.alias);
        const shadowed = reachable.get(imp.alias);
        if (!scope.imports.includes(imp)) {
            aliases.set(imp.alias, imp);
            continue;
        }
        if (clash) {
            accept('error',
                `"${imp.alias}" is already the alias of "${clash.package?.ref?.name ?? '?'}" here, so it now names two packages.`,
                { node: imp, property: 'alias', code: 'duplicate-alias' });
        } else if (shadowed) {
            accept('error',
                `"${imp.alias}" is also ${shadowed}, so it names two things at once.`,
                { node: imp, property: 'alias', code: 'alias-shadows-package' });
        }
        aliases.set(imp.alias, imp);
    }
}

/**
 * The packages some reference inside this subtree resolves into.
 *
 * Unresolved references are ignored rather than treated as usage: while the
 * user is mid-edit a broken reference shouldn't silence the diagnostic, and
 * once it resolves the import is credited automatically.
 */
function packagesUsedWithin(root: AstNode): Set<Package> {
    const used = new Set<Package>();
    for (const node of AstUtils.streamAllContents(root)) {
        // An import's own reference names the package but doesn't *use* it;
        // counting it would make every import look used.
        if (isImport(node)) {
            continue;
        }
        for (const info of AstUtils.streamReferences(node)) {
            const targets = isReference(info.reference)
                ? [info.reference.ref]
                : info.reference.items.map(item => item.ref);
            for (const target of targets) {
                const owner = target && AstUtils.getContainerOfType(target, isPackage);
                if (owner) {
                    used.add(owner);
                }
            }
        }
    }
    return used;
}

/** Two packages with the same name in one document are always a mistake. */
export function checkNoDuplicatePackageNamesInDocument(model: Model, accept: ValidationAcceptor): void {
    const seen = new Set<string>();
    for (const pkg of model.packages) {
        // A package still being named is not a second anything.
        if (!pkg.name) {
            continue;
        }
        if (seen.has(pkg.name)) {
            accept('error', `Package "${pkg.name}" is declared more than once in this file.`, {
                node: pkg,
                property: 'name',
                code: 'duplicate-package-in-file'
            });
        } else {
            seen.add(pkg.name);
        }
    }
}
