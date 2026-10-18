import type { AstNodeDescription, LangiumCoreServices, ReferenceInfo, Scope } from 'langium';
import { AstUtils, DefaultScopeProvider, MapScope, WorkspaceCache } from 'langium';
import { isClassDeclaration, isExternalRelation, isPackage } from '../generated/ast.js';
import type { Import, Model, Package, Relation } from '../generated/ast.js';
import { getNamedEnds, getRelationSourceName } from '../utils/relations.js';
import { membersInScopeOf } from '../utils/inherited-members.js';
import { applicableImports, ownerOf, publicationWorkspace } from '../publication/workspace.js';
import { BUILTIN_DATATYPES_URI } from '../workspace/builtin-datatypes.js';

/**
 * Resolves qualified-name cross-references against tonto's package/import
 * model.
 *
 * A reference site sees, in this order:
 *  1. Every unambiguous declaration of its own package (by simple name, and by
 *     `PackageName.declName` for self-qualified references such as the
 *     `core.animals.Animal` seen inside `package core.animals` itself).
 *  2. Every declaration of each imported package (by `PackageName.declName`,
 *     and additionally by `alias.declName` when the import used `as alias`).
 *  3. Ontology imports under their aliases, with flat public names.
 *  4. The virtual builtin datatype prelude.
 *
 * Name matching is case-sensitive. Legacy tonto matches case-insensitively,
 * but that conflicts with case-sensitive duplicate-name detection: `Person`
 * and `person` would resolve to one another while never being reported as a
 * clash. Case sensitivity is the rule here, so both agree.
 */
export class TontoScopeProvider extends DefaultScopeProvider {

    /**
     * Assembled scopes, and the raw description lists they are built from.
     *
     * `getScope` runs once per cross-reference, and building a package's
     * descriptions walks all of its declarations, relations and ends -- so
     * without this, resolving a document's references costs O(references x
     * declarations). That made linking, not validation, the dominant cost on
     * larger models (~28s for 800 classes, ~120ms with the cache).
     *
     * These are `WorkspaceCache`s rather than `WeakMap`s keyed on AST nodes.
     * A scope built for one document embeds descriptions of *other*
     * documents' nodes (via imports), and when a dependency changes Langium
     * re-links the dependent document without re-parsing it -- so its AST
     * nodes are reused and a node-keyed cache would hand back descriptions
     * pointing into the old, discarded AST. `WorkspaceCache` evicts whenever
     * any document changes, which is the conservative and correct choice
     * here.
     */
    private readonly scopeCache: WorkspaceCache<string, Scope>;
    private readonly descriptionCache: WorkspaceCache<string, AstNodeDescription[]>;
    private readonly relationsCache: WorkspaceCache<string, Relation[]>;
    private readonly publication;

    constructor(services: LangiumCoreServices) {
        super(services);
        this.scopeCache = new WorkspaceCache(services.shared);
        this.descriptionCache = new WorkspaceCache(services.shared);
        this.relationsCache = new WorkspaceCache(services.shared);
        this.publication = publicationWorkspace(services.shared);
    }

    /** Stable identity for a package across a single build. */
    private packageKey(pkg: Package): string {
        return `${AstUtils.getDocument(pkg).uri.toString()}#${pkg.$containerIndex ?? 0}`;
    }

    override getScope(context: ReferenceInfo): Scope {
        return this.scopeForType(this.reflection.getReferenceType(context), context);
    }

    /**
     * The scope for an explicitly given reference type.
     *
     * Completion sometimes knows the target type from the grammar while the
     * runtime container it can offer does not declare the property, so
     * reflection cannot derive it -- see `TontoCompletionProvider`.
     */
    scopeForType(referenceType: string, context: ReferenceInfo): Scope {

        // Package lookup is ontology-local, unlike the workspace index that
        // also holds unrelated ontologies with their own same-named packages.
        if (referenceType === 'Package') {
            const model = AstUtils.getDocument(context.container).parseResult.value as Model;
            const pkg = AstUtils.getContainerOfType(context.container, isPackage);
            const units = new Set((pkg ? [pkg] : model.packages).map(ownerOf));
            return this.createScope([...new Set([...units].flatMap(unit => unit?.packages ?? []))]
                .filter(pkg => !!pkg.name).map(pkg => this.descriptions.createDescription(pkg, pkg.name!)));
        }

        const pkg = AstUtils.getContainerOfType(context.container, isPackage);
        if (!pkg) {
            return this.getGlobalScope(referenceType, context);
        }

        const outer = this.scopeCache.get(
            `${this.packageKey(pkg)}#${referenceType}`,
            () => this.buildScope(pkg, referenceType, context)
        );
        // Inside a class, what it inherits is named without saying where from.
        // Not cached with the rest: this part depends on the class the
        // reference is written in, not on the package.
        const inherited = this.inheritedMembers(referenceType, context);
        return inherited.length > 0 ? this.createScope(inherited, outer) : outer;
    }

    /**
     * The relations and named ends a class inherits, under their simple names.
     *
     * `subsets ComplexPhysicalObject.parts` inside a `kind Lion specializes
     * ComplexPhysicalObject` says where to look for something the
     * specialization has already said: the end is reachable, and the class
     * that owns it is not in question. So a bare `subsets parts` resolves,
     * and so does `specializes hasPart` -- nearest ancestor first, which is
     * what a redefinition expects.
     *
     * Only inside the class: the simple name is *not* added to the package
     * scope, since an end called `parts` means nothing where nothing in the
     * lineage declares one. External relations already carry a simple name of
     * their own, being package declarations, and need nothing here.
     *
     * Searches an ancestor's own body, the package that ancestor is declared
     * in, and the package the *reference* is written in. A *source*-side name
     * (`(wholes)` in `kind Part { (wholes) [0..*] <>-- [1..*] Whole }`) is a
     * property of the relation's *target* (see `getNamedEnds`), so the
     * relation naming an ancestor as owner is as often written beside that
     * ancestor as inside it -- and an `ExternalRelation` is never inside any
     * class at all. Both packages have to be searched, because either may
     * hold it: an inherited end is named plainly "across files as within
     * one", and an ancestor imported from elsewhere brings the relations
     * written beside it along with it.
     *
     * This has to be a plain AST walk rather than the workspace reference
     * index the checks use for the same question (`ReverseLookup`): that
     * index is populated *from* linking, so a scope request answered from it
     * while linking this very document would be reading an index this
     * document has not written its own part of yet.
     */
    private inheritedMembers(referenceType: string, context: ReferenceInfo): AstNodeDescription[] {
        // A historical role's `derivedFrom` names relations too, and one it
        // inherits is named plainly, as a `specializes` does.
        if (referenceType !== 'RelationEndMetaAttributes' && referenceType !== 'Relation'
            && referenceType !== 'HistoricalFounding') {
            return [];
        }
        const owner = AstUtils.getContainerOfType(context.container, isClassDeclaration);
        const pkg = owner && AstUtils.getContainerOfType(owner, isPackage);
        if (!owner || !pkg) {
            return [];
        }
        const here = this.packageRelations(pkg);
        const members = membersInScopeOf(owner, member => {
            const theirs = AstUtils.getContainerOfType(member, isPackage);
            return new Set([
                ...member.relations,
                ...(theirs && theirs !== pkg ? this.packageRelations(theirs) : []),
                ...here
            ]);
        });
        const found = referenceType === 'RelationEndMetaAttributes' ? members.ends : members.relations;
        // The nearest declaration of each name, which is the one a reader
        // means; `short-reference-ambiguous` says so where two branches of the
        // lineage disagree about what the name reaches.
        return [...found].map(([name, [nearest]]) =>
            this.descriptions.createDescription(nearest.node, name));
    }

    /** Every relation declared anywhere in a package, internal and external. */
    private packageRelations(pkg: Package): Relation[] {
        return this.relationsCache.get(`${this.packageKey(pkg)}#relations`, () => {
            const result: Relation[] = [];
            for (const declaration of pkg.declarations) {
                if (isClassDeclaration(declaration)) {
                    result.push(...declaration.relations);
                } else if (isExternalRelation(declaration)) {
                    result.push(declaration);
                }
            }
            return result;
        });
    }

    private buildScope(pkg: Package, referenceType: string, context: ReferenceInfo): Scope {
        const globalScope = this.getGlobalScope(referenceType, context);
        const importScope = this.createScope(
            this.importedDescriptions(pkg).filter(d => this.reflection.isSubtype(d.type, referenceType)),
            globalScope
        );
        return this.createScope(
            this.packageDescriptions(pkg, pkg.name).filter(d => this.reflection.isSubtype(d.type, referenceType)),
            importScope
        );
    }

    protected override getGlobalScope(referenceType: string, _context: ReferenceInfo): Scope {
        return this.globalScopeCache.get(referenceType, () =>
            new MapScope(this.indexManager.allElements(referenceType).filter(description => description.documentUri.toString() === BUILTIN_DATATYPES_URI)));
    }

    /**
     * Descriptions for a package's own declarations, exposed under
     * `prefix.declName` as well as their simple name. Memoized per
     * package-and-prefix: the same package is described once for its own
     * members and again under each alias that imports it.
     */
    packageDescriptions(pkg: Package, prefix: string | undefined): AstNodeDescription[] {
        return this.descriptionCache.get(
            `${this.packageKey(pkg)}#${prefix}`,
            () => this.computePackageDescriptions(pkg, prefix)
        );
    }

    private computePackageDescriptions(pkg: Package, prefix: string | undefined): AstNodeDescription[] {
        const result: AstNodeDescription[] = [];
        const relationNameCounts = new Map<string, number>();
        for (const declaration of pkg.declarations) {
            if (isExternalRelation(declaration) && declaration.name) {
                relationNameCounts.set(declaration.name, (relationNameCounts.get(declaration.name) ?? 0) + 1);
            }
        }
        for (const declaration of pkg.declarations) {
            if (!declaration.name) {
                continue;
            }
            // A bare relation name can be used only while it identifies one
            // relation in this package. Its source-qualified name is always
            // available, as it is for a relation written inside the class.
            if (!isExternalRelation(declaration) || relationNameCounts.get(declaration.name) === 1) {
                result.push(this.descriptions.createDescription(declaration, declaration.name));
                if (prefix) {
                    result.push(this.descriptions.createDescription(declaration, `${prefix}.${declaration.name}`));
                }
            }
            if (isClassDeclaration(declaration)) {
                for (const relation of declaration.relations) {
                    result.push(...this.relationAndEndDescriptions(relation, prefix));
                }
            }
            if (isExternalRelation(declaration)) {
                result.push(...this.relationAndEndDescriptions(declaration, prefix));
            }
        }
        return result;
    }

    /**
     * Descriptions for a relation's own qualified name (`Source.relName`) and
     * for each of its named ends (`Owner.endName`). Both are also exposed
     * package-qualified (`prefix.Source.relName`, `prefix.Owner.endName`), so
     * a reference from another package can spell them out in full the same
     * way it can for a class. A package still being written has no name to
     * qualify with, so those descriptions are simply the simple ones.
     */
    private relationAndEndDescriptions(relation: Relation, prefix: string | undefined): AstNodeDescription[] {
        const result: AstNodeDescription[] = [];
        const source = getRelationSourceName(relation)?.split('.').pop();
        if (source && relation.name) {
            result.push(this.descriptions.createDescription(relation, `${source}.${relation.name}`));
            if (prefix) {
                result.push(this.descriptions.createDescription(relation, `${prefix}.${source}.${relation.name}`));
            }
        }
        for (const end of getNamedEnds(relation)) {
            if (end.ownerName) {
                const owner = end.ownerName.split('.').pop();
                result.push(this.descriptions.createDescription(end.node, `${owner}.${end.name}`));
                if (prefix) {
                    result.push(this.descriptions.createDescription(end.node, `${prefix}.${owner}.${end.name}`));
                }
            }
        }
        return result;
    }

    private importedDescriptions(pkg: Package): AstNodeDescription[] {
        const result: AstNodeDescription[] = [];
        for (const imp of applicableImports(pkg)) {
            if (imp.location && imp.alias) {
                const target = this.publication.imported.get(imp);
                for (const member of target?.packages ?? []) {
                    result.push(...this.packageDescriptions(member, imp.alias).filter(description => description.name.startsWith(`${imp.alias}.`)));
                }
                continue;
            }
            result.push(...this.resolveImport(imp, pkg));
        }
        return result;
    }

    private resolveImport(imp: Import, pkg: Package): AstNodeDescription[] {
        const target = imp.package?.ref;
        if (!target || ownerOf(target) !== ownerOf(pkg)) {
            return [];
        }
        const result = [...this.packageDescriptions(target, target.name)];
        if (imp.alias) {
            result.push(...this.packageDescriptions(target, imp.alias));
        }
        return result;
    }
}
