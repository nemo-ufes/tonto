import type {
    AstNode, AstNodeLocator, IndexManager, LangiumDocument, LangiumDocuments, MaybePromise
} from 'langium';
import { AstUtils, CstUtils } from 'langium';
import type { DocumentationProvider } from 'langium';
import { AstNodeHoverProvider } from 'langium/lsp';
import type { LangiumServices } from 'langium/lsp';
import type { Hover, HoverParams } from 'vscode-languageserver';
import type {
    Attribute, ClassDeclaration, Datatype, Enumeration,
    GeneralizationSet, Ontology, Package, Relation, RelationEndMetaAttributes
} from '../generated/ast.js';
import {
    isAttribute, isClassDeclaration, isDatatype, isEnumeration, isGeneralizationSet,
    isPackage, isRelation, isRelationEndMetaAttributes, isOntology, isOntologyBody, isBundleEntry
} from '../generated/ast.js';
import { collectAncestors } from '../utils/generalizations.js';
import { describeNatures, getEffectiveNatures } from '../utils/natures.js';
import {
    getEndCardinality, getEndSide, getEndType, getNamedEnds, getRelationNotation, getRelationSource
} from '../utils/relations.js';
import type { ReverseLookup } from '../validation/incoming-relations.js';
import { createReverseLookup } from '../validation/incoming-relations.js';
import { isUltimateSortal } from '../validation/stereotype-model.js';
import { ontologiesNamed, ownerAt } from './ontology-actions.js';
import { ownerOf } from '../publication/workspace.js';

/**
 * tonto leaves an omitted multiplicity meaning exactly one, matching UML and
 * the OntoUML export (which calls `setOneToOne()` for a missing cardinality).
 * Hover spells this out rather than staying silent, since an unwritten bound
 * is the easiest thing in a model to misread as "unconstrained".
 */
const DEFAULT_CARDINALITY = '[1]';

/**
 * Renders a compact markdown card for the element under the cursor.
 *
 * Langium's default provider shows only a preceding `/** ... *\/` comment, so
 * an undocumented element hovers to nothing. Here the doc comment is kept as
 * the trailing prose, but the useful structural facts -- stereotype, natures,
 * the ultimate sortal a class ultimately specializes, supertypes, ends,
 * multiplicities -- are computed from the AST and shown first.
 */
export class TontoHoverProvider extends AstNodeHoverProvider {

    private readonly documentation: DocumentationProvider;
    private readonly reverse: ReverseLookup;
    private readonly documents: LangiumDocuments;

    constructor(services: LangiumServices) {
        super(services);
        this.documentation = services.documentation.DocumentationProvider;
        const documents: LangiumDocuments = services.shared.workspace.LangiumDocuments;
        this.documents = documents;
        const indexManager: IndexManager = services.shared.workspace.IndexManager;
        const locator: AstNodeLocator = services.workspace.AstNodeLocator;
        this.reverse = createReverseLookup(indexManager, documents, locator);
        services.shared.workspace.DocumentBuilder.onUpdate(() => this.reverse.reset());
    }

    /**
     * Falls back to the relation under the cursor when nothing else answers.
     *
     * Langium hovers a node only where the cursor sits on a name token or a
     * cross-reference, so an anonymous relation -- `@mediation [1] -- [2]
     * Person`, which has no name anywhere -- hovered to nothing at all, and a
     * named one only responded on its name. The `--`, the stereotype and the
     * multiplicities are the rest of the declaration, and hovering them now
     * describes the relation they belong to.
     *
     * Only as a fallback: the target reference still hovers the class it
     * names, which is what is wanted there.
     */
    override async getHoverContent(document: LangiumDocument, params: HoverParams): Promise<Hover | undefined> {
        const standard = await super.getHoverContent(document, params);
        if (standard) {
            return standard;
        }
        const root = document.parseResult.value.$cstNode;
        if (!root) {
            return undefined;
        }
        const offset = document.textDocument.offsetAt(params.position);
        const member = ownerAt(document, offset);
        if (member) {
            const ontology = ontologiesNamed(member.owner!, this.documents.all)[0];
            const value = ontology ? await this.getAstNodeHoverContent(ontology)
                : `**ontology** \`${member.owner}\`\n\nNo document of this workspace declares it.`;
            return value ? { contents: { kind: 'markdown', value } } : undefined;
        }
        const leaf = CstUtils.findLeafNodeAtOffset(root, offset);
        const relation = leaf && AstUtils.getContainerOfType(leaf.astNode, isRelation);
        const content = relation && await this.getAstNodeHoverContent(relation);
        return content ? { contents: { kind: 'markdown', value: content } } : undefined;
    }

    protected override getAstNodeHoverContent(node: AstNode): MaybePromise<string | undefined> {
        const sections = this.describe(node);
        const comment = this.documentation.getDocumentation(node);
        if (comment) {
            sections.push('', comment);
        }
        return sections.length > 0 ? sections.join('\n') : undefined;
    }

    private describe(node: AstNode): string[] {
        if (isOntology(node)) return [`**ontology** \`${node.name}\``, '', ontologyForm(node)];
        if (isBundleEntry(node)) return [`**bundle** \`${node.name}\` from \`${node.location}\``];
        if (isClassDeclaration(node)) {
            return this.describeClass(node);
        }
        if (isDatatype(node) || isEnumeration(node)) {
            return this.describeDatatype(node);
        }
        if (isRelation(node)) {
            return this.describeRelation(node);
        }
        if (isAttribute(node)) {
            return this.describeAttribute(node);
        }
        if (isRelationEndMetaAttributes(node)) {
            return this.describeEnd(node);
        }
        if (isGeneralizationSet(node)) {
            return this.describeGenset(node);
        }
        if (isPackage(node)) {
            return this.describePackage(node);
        }
        return [];
    }

    private describeClass(node: ClassDeclaration): string[] {
        const out = [`**${node.stereotype}** \`${node.name}\``];
        const natures = getEffectiveNatures(node);
        if (natures) {
            out.push('', `*of* ${describeNatures(natures)}`);
        }

        const ancestors = [...collectAncestors(node)];
        const supertypes = node.specializes.map(ref => ref.ref?.name).filter(Boolean);
        if (supertypes.length > 0) {
            out.push('', `*specializes* ${supertypes.map(n => `\`${n}\``).join(', ')}`);
        }
        if (node.derivedFrom.length > 0) {
            out.push('', `*derived from* ${node.derivedFrom.map(reference => `\`${reference.$refText}\``).join(', ')}`);
        }

        // The identity provider is the single most useful derived fact about a
        // sortal, and is often several hops away in the hierarchy.
        const ultimateSortals = ancestors.filter(a => isUltimateSortal(a.stereotype));
        if (!isUltimateSortal(node.stereotype) && ultimateSortals.length > 0) {
            out.push('', `*identity from* ${ultimateSortals.map(a => `\`${a.name}\``).join(', ')}`);
        }
        if (node.instanceOf?.ref) {
            out.push('', `*instance of* \`${node.instanceOf.ref.name}\``);
        }

        // A relation belongs on both ends' cards, regardless of whether its
        // declaration is package-level or nested in either class. The reverse
        // lookup reads the workspace index, so this also includes relations
        // written in another document or package. A self-relation can name the
        // same class twice (and an internal one is also found through its
        // container), hence the identity-based de-duplication.
        const touchingRelations = [...new Set(this.reverse.touching(node))];
        const members = [
            ...node.attributes.map(attributeSignature),
            ...touchingRelations.map(relationSignature)
        ];
        if (members.length > 0) {
            out.push('', '```tonto', ...members, '```');
        }
        return out;
    }

    private describeDatatype(node: Datatype | Enumeration): string[] {
        const kind = isEnumeration(node) ? 'enum' : 'datatype';
        const out = [`**${kind}** \`${node.name}\``];
        if (isEnumeration(node) && node.literals.length > 0) {
            out.push('', `*literals*: ${node.literals.map(l => `\`${l.name}\``).join(', ')}`);
        }
        if (!isEnumeration(node) && node.attributes.length > 0) {
            out.push('', '```tonto', ...node.attributes.map(attributeSignature), '```');
        }
        return out;
    }

    private describeRelation(node: Relation): string[] {
        const out = [`**relation** ${node.name ? `\`${node.name}\`` : '*(unnamed)*'}`];
        if (node.stereotype) {
            out.push('', `*stereotype* \`@${node.stereotype}\``);
        }
        out.push('', '```tonto', relationSignature(node), '```');
        const note = defaultCardinalityNote(node);
        if (note) {
            out.push('', `*${note}*`);
        }
        const ends = getNamedEnds(node);
        if (ends.length > 0) {
            out.push('', `*ends*: ${ends.map(e => `\`${e.ownerName}.${e.name}\``).join(', ')}`);
        }
        if (node.specializes?.ref) {
            out.push('', `*specializes* \`${node.specializes.$refText}\``);
        }
        if (node.inverseOf?.ref) {
            out.push('', `*inverse of* \`${node.inverseOf.$refText}\``);
        }
        if (node.derivedFrom.length > 0) {
            out.push('', `*derived from* ${node.derivedFrom.map(reference => `\`${reference.$refText}\``).join(', ')}`);
        }
        return out;
    }

    private describeAttribute(node: Attribute): string[] {
        const flags = attributeFlags(node);
        const stereotypes = node.stereotypes.map(s => `\`@${s}\` `).join('');
        const out = [`**attribute** ${stereotypes}\`${node.name}\`: \`${node.type?.$refText ?? '?'}\`${cardinalityText(node)}`];
        if (flags.length > 0) {
            out.push('', `*${flags.join(', ')}*`);
        }
        return out;
    }

    private describeEnd(node: RelationEndMetaAttributes): string[] {
        const owner = getNamedEnds(node.$container).find(e => e.node === node);
        const type = getEndType(node);
        const cardinality = getEndCardinality(node);
        const out = [`**relation end** \`${owner ? `${owner.ownerName}.${owner.name}` : node.name ?? '?'}\``];
        if (type && 'name' in type && type.name) {
            const bounds = cardinality
                ? `\`${cardinalityLiteral(cardinality)}\``
                : `\`${DEFAULT_CARDINALITY}\` *(default)*`;
            out.push('', `*typed by* \`${type.name}\` ${bounds}`);
            if (isClassDeclaration(type)) {
                const natures = getEffectiveNatures(type);
                if (natures) {
                    out.push('', `*of* ${describeNatures(natures)}`);
                }
            }
        }
        out.push('', `*side*: ${getEndSide(node) ?? 'unknown'}`);
        const overrides = [
            node.subsets && `subsets \`${node.subsets.$refText}\``,
            node.redefines && `redefines \`${node.redefines.$refText}\``
        ].filter(Boolean);
        if (overrides.length > 0) {
            out.push('', `*${overrides.join(', ')}*`);
        }
        return out;
    }

    private describeGenset(node: GeneralizationSet): string[] {
        const modifiers = [node.disjoint && 'disjoint', node.complete && 'complete'].filter(Boolean);
        const out = [`**genset** \`${node.name}\``];
        if (modifiers.length > 0) {
            out.push('', `*${modifiers.join(' ')}*`);
        }
        out.push('', `*general*: \`${node.general?.$refText ?? '?'}\``);
        out.push('', `*specifics*: ${node.specifics.map(s => `\`${s.$refText}\``).join(', ')}`);
        return out;
    }

    private describePackage(node: Package): string[] {
        const out = [`**package** \`${node.name}\`${node.owner ? ` in \`${node.owner}\`` : ''}`];
        const imports = node.imports.filter(imp => imp.location).length;
        out.push('', `${node.declarations.length} declaration(s), ${node.imports.length - imports} use(s), ${imports} ontology import(s)`);
        // What the package is published as is its ontology's to say, on the header.
        const ontology = ownerOf(node)?.declaration;
        const published = ontology && this.documentation.getDocumentation(ontology);
        if (ontology && published) out.push('', `Published in ontology \`${ontology.name}\`:`, '', published);
        return out;
    }
}

/** `@begin birth: Date [0..1]`, as the member list writes it. */
function attributeSignature(node: Attribute): string {
    const stereotypes = node.stereotypes.map(s => `@${s} `).join('');
    return `${stereotypes}${node.name}: ${node.type?.$refText ?? '?'}${cardinalityText(node).replace(/`/g, '')}`;
}

function attributeFlags(node: Attribute): string[] {
    // An attribute keeps all four; an end has only `const` and `addOnly`.
    return [node.isOrdered && 'ordered', node.isConst && 'const', node.isAddOnly && 'addOnly',
        node.isDerived && 'derived'].filter(Boolean) as string[];
}

function cardinalityText(node: Attribute): string {
    return node.cardinality ? ` \`${cardinalityLiteral(node.cardinality)}\`` : '';
}

function cardinalityLiteral(cardinality: { lowerBound: number | string; upperBound?: number | string }): string {
    return cardinality.upperBound === undefined
        ? `[${cardinality.lowerBound}]`
        : `[${cardinality.lowerBound}..${cardinality.upperBound}]`;
}

/**
 * A one-line rendering of a relation, close to how it is written -- except
 * that omitted multiplicities are filled in with the implicit `[1]`, so both
 * ends always read explicitly.
 */
function relationSignature(relation: Relation): string {
    const source = getRelationSource(relation);
    const sourceName = source && 'name' in source ? source.name : '?';
    const stereotype = relation.stereotype ? `@${relation.stereotype} ` : '';
    const left = relation.sourceCardinality ? cardinalityLiteral(relation.sourceCardinality) : DEFAULT_CARDINALITY;
    const right = relation.targetCardinality ? cardinalityLiteral(relation.targetCardinality) : DEFAULT_CARDINALITY;
    return `${stereotype}${sourceName} ${left} ${notationLiteral(relation)} ${right} ${relation.target?.$refText ?? '?'}`;
}

/**
 * The `--` / `<>--` / `--<>` notation as written, with the relation name
 * between the dashes when there is one.
 *
 * An unnamed relation gets a single marker rather than the `-- --` an empty
 * name used to leave behind, and the diamond is carried through: rendering a
 * `@componenthood` as a plain association would hide which end is the whole,
 * which is the one thing the notation exists to say.
 */
function notationLiteral(relation: Relation): string {
    const notation = getRelationNotation(relation);
    const marker = notation.kind === 'aggregation' ? '<>' : '';
    if (!relation.name) {
        return notation.wholeEnd === 'target' ? `--${marker}` : `${marker}--`;
    }
    return notation.wholeEnd === 'target'
        ? `-- ${relation.name} --${marker}`
        : `${marker}-- ${relation.name} --`;
}

/** Notes which ends fell back to the implicit multiplicity. */
function defaultCardinalityNote(relation: Relation): string | undefined {
    const implicit = [
        !relation.sourceCardinality && 'source',
        !relation.targetCardinality && 'target'
    ].filter(Boolean) as string[];
    if (implicit.length === 0) {
        return undefined;
    }
    const ends = implicit.length === 2 ? 'Both ends use' : `The ${implicit[0]} end uses`;
    return `${ends} the default multiplicity \`${DEFAULT_CARDINALITY}\` (exactly one), which is not written in the model.`;
}

/** What an ontology's entry says it consists of. */
function ontologyForm(ontology: Ontology): string {
    const packages = ontology.$container.packages;
    const body = packages.find(isOntologyBody);
    if (body && !ontology.bundled && packages.length === 1) {
        return `One-file ontology: ${body.declarations.length} declaration(s) in this file.`;
    }
    const inline = packages.filter(pkg => !isOntologyBody(pkg)).length;
    const parts = [inline ? `${inline} package(s) in this document` : '', ontology.bundles.length ? `${ontology.bundles.length} bundled package(s)` : ''];
    return parts.filter(Boolean).join(', ') || 'No declarations or packages yet.';
}
