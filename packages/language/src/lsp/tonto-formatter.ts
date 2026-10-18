import type { AstNode, CstNode } from 'langium';
import { CstUtils, GrammarUtils } from 'langium';
import { AbstractFormatter, Formatting } from 'langium/lsp';
import type { NodeFormatter } from 'langium/lsp';
import type {
    ClassDeclaration, Datatype, Enumeration, GeneralizationSet, LegacyTextBlock, Model, Package
} from '../generated/ast.js';
import {
    isAttribute, isClassDeclaration, isDatatype, isEnumeration, isGeneralizationSet,
    isImport, isLanguageText, isLegacyTextBlock, isModel, isPackage, isRelation, isRelationEndMetaAttributes,
    isOntology, isBundleEntry
} from '../generated/ast.js';

/**
 * Formats tonto documents.
 *
 * Deliberately conservative: it normalizes indentation inside `{ }` bodies,
 * spacing around keywords, and the placement of declarations on their own
 * lines -- but leaves the internals of relation notation alone, where the
 * `--`/`<>--`/`(endName)` punctuation carries meaning and is easy to corrupt.
 * Blank lines the author wrote between declarations survive a format, so
 * grouping is preserved.
 */
export class TontoFormatter extends AbstractFormatter {

    protected format(node: AstNode): void {
        if (isModel(node)) {
            this.formatModel(node);
        } else if (isOntology(node)) {
            const formatter = this.getNodeFormatter(node);
            formatter.keyword('ontology').append(Formatting.oneSpace());
            formatter.keyword('bundles').prepend(Formatting.oneSpace());
            formatter.nodes(...node.bundles).prepend(Formatting.newLine()).prepend(Formatting.indent());
        } else if (isBundleEntry(node)) {
            this.getNodeFormatter(node).keyword('from').surround(Formatting.oneSpace());
        } else if (isPackage(node)) {
            this.formatPackage(node);
        } else if (isClassDeclaration(node)) {
            this.formatClassDeclaration(node);
        } else if (isDatatype(node)) {
            this.formatDatatype(node);
        } else if (isEnumeration(node)) {
            this.formatEnumeration(node);
        } else if (isGeneralizationSet(node)) {
            this.formatGeneralizationSet(node);
        } else if (isLegacyTextBlock(node)) {
            this.formatTextBlock(node);
        } else if (isLanguageText(node)) {
            this.getNodeFormatter(node).keyword('@').append(Formatting.noSpace());
        } else if (isAttribute(node)) {
            const formatter = this.getNodeFormatter(node);
            // `@begin birth: Date` -- the `@` binds to its stereotype, and the
            // name is what normalizes the gap after the last one.
            formatter.keyword('@').append(Formatting.noSpace());
            if (node.stereotypes.length > 0) {
                // Only with a stereotype in front: with none, the name is the
                // attribute's first token, and the line break before it is the
                // body's to decide.
                formatter.property('name').prepend(Formatting.oneSpace());
            }
            formatter.keyword(':').prepend(Formatting.noSpace()).append(Formatting.oneSpace());
            formatter.keyword('{').prepend(Formatting.oneSpace()).append(Formatting.oneSpace());
            formatter.keyword('}').prepend(Formatting.oneSpace());
        } else if (isRelation(node)) {
            const formatter = this.getNodeFormatter(node);
            formatter.keyword('relation').append(Formatting.oneSpace());
            formatter.keyword('@').append(Formatting.noSpace());
            formatter.keyword('specializes').surround(Formatting.oneSpace());
            formatter.keyword('inverseOf').surround(Formatting.oneSpace());
            formatter.keyword('derivedFrom').surround(Formatting.oneSpace());
            // The only commas a relation has are between what it is derived from.
            formatter.keywords(',').prepend(Formatting.noSpace()).append(Formatting.oneSpace());
        } else if (isRelationEndMetaAttributes(node)) {
            const formatter = this.getNodeFormatter(node);
            formatter.keyword('(').append(Formatting.noSpace());
            formatter.keyword(')').prepend(Formatting.noSpace());
            // Nothing about the words inside: they are separated by spaces
            // the author wrote, and the comma this used to normalize went
            // with the braces.
        } else if (isImport(node)) {
            this.getNodeFormatter(node).keyword('import').append(Formatting.oneSpace());
            this.getNodeFormatter(node).keyword('use').append(Formatting.oneSpace());
            this.getNodeFormatter(node).keyword('from').surround(Formatting.oneSpace());
            this.getNodeFormatter(node).keyword('as').surround(Formatting.oneSpace());
        }
    }

    private formatModel(node: Model): void {
        this.getNodeFormatter(node)
            .nodes(...node.imports, ...node.packages, ...node.ontologies)
            .prepend(Formatting.noIndent());
    }

    private formatPackage(node: Package): void {
        const formatter = this.getNodeFormatter(node);
        formatter.keyword('package').append(Formatting.oneSpace());
        formatter.keyword('in').surround(Formatting.oneSpace());
        const members = [...node.imports, ...node.declarations];
        if (members.length > 0) {
            // A blank line the author put between declarations is kept.
            formatter.nodes(...members).prepend(Formatting.fit(Formatting.newLine(), Formatting.newLines(2)));
        }
    }

    private formatClassDeclaration(node: ClassDeclaration): void {
        const formatter = this.getNodeFormatter(node);
        // The stereotype is a fragment assignment rather than a fixed keyword,
        // so the gap before it is normalized via the name that follows.
        formatter.property('name').prepend(Formatting.oneSpace());
        formatter.keyword('of').surround(Formatting.oneSpace());
        formatter.keyword('specializes').surround(Formatting.oneSpace());
        formatter.keyword('derivedFrom').surround(Formatting.oneSpace());
        formatter.keyword('instanceOf').append(Formatting.oneSpace());
        this.eachKeyword(node, formatter, ',', region =>
            region.prepend(Formatting.noSpace()).append(Formatting.oneSpace()));
        this.formatBody(node, [...node.legacyText, ...node.attributes, ...node.relations]);
    }

    private formatDatatype(node: Datatype): void {
        const formatter = this.getNodeFormatter(node);
        formatter.keyword('datatype').append(Formatting.oneSpace());
        formatter.keyword('specializes').surround(Formatting.oneSpace());
        this.formatBody(node, [...node.legacyText, ...node.attributes]);
    }

    private formatEnumeration(node: Enumeration): void {
        const formatter = this.getNodeFormatter(node);
        formatter.keyword('enum').append(Formatting.oneSpace());
        formatter.keyword('specializes').surround(Formatting.oneSpace());
        // Each literal starts a line; the separating comma stays attached to
        // the literal before it, which falls out of indenting only the
        // literals themselves.
        this.formatBody(node, [...node.legacyText, ...node.literals]);
    }

    private formatGeneralizationSet(node: GeneralizationSet): void {
        const formatter = this.getNodeFormatter(node);
        for (const keyword of ['genset', 'disjoint', 'complete', 'where', 'specializes', 'general', 'categorizer', 'specifics']) {
            formatter.keyword(keyword).append(Formatting.oneSpace());
        }
        this.eachKeyword(node, formatter, ',', region =>
            region.prepend(Formatting.noSpace()).append(Formatting.oneSpace()));

        const open = formatter.keyword('{');
        if (open.nodes.length > 0) {
            open.prepend(Formatting.oneSpace());
            for (const keyword of ['general', 'categorizer', 'specifics']) {
                formatter.keyword(keyword).prepend(Formatting.indent());
            }
            formatter.keyword('}').prepend(Formatting.newLine());
        }
    }

    private formatTextBlock(node: LegacyTextBlock): void {
        this.formatBody(node, node.items);
    }

    /**
     * Indents a block's members one level and returns the closing brace to the
     * parent's indentation.
     *
     * Members are addressed as AST nodes rather than via `interior()`, which
     * works at CST granularity: on a relation such as `[1] -- name -- [1] X`
     * it attached the indent to the `--` token and split the line in two.
     */
    private formatBody(node: AstNode, members: AstNode[]): void {
        const formatter = this.getNodeFormatter(node);
        const open = formatter.keyword('{');
        const close = formatter.keyword('}');
        if (open.nodes.length === 0 || close.nodes.length === 0) {
            return;
        }
        open.prepend(Formatting.oneSpace());
        if (members.length > 0) {
            // The comment lines above a member are indented with it. They are
            // hidden tokens, so they are not among `members` and Langium
            // indents them only where the surrounding context is already
            // indented -- a `///` block would have stayed at column zero while
            // the declaration it documents moved in. Not `interior()`, which
            // reaches every token in the body, commas included, and would put
            // each on a line of its own.
            // `allowMore`, as at package level: a blank line the author put
            // between members is kept. Collapsing it is not only a layout
            // change -- a blank line is what ends a `///` run, so deleting
            // one silently turned a detached comment into the documentation
            // of whatever followed it, which is a different parsed model.
            const comments = members.flatMap(member => commentsAbove(member));
            formatter.nodes(...members).prepend(Formatting.indent({ allowMore: true }));
            if (comments.length > 0) {
                formatter.cst(comments).prepend(Formatting.indent({ allowMore: true }));
            }
        }
        close.prepend(Formatting.newLine());
    }

    /**
     * Applies a formatting to every occurrence of a keyword.
     *
     * `NodeFormatter.keyword` resolves one occurrence, so a rule written once
     * only reaches the first comma of a list. The count has to come from
     * `findNodesForKeyword` rather than probing increasing indices, because
     * `findNodeForKeyword` *clamps* an out-of-range index to the last node --
     * probing never terminates.
     */
    private eachKeyword<T extends AstNode>(
        node: T,
        formatter: NodeFormatter<T>,
        keyword: string,
        apply: (region: ReturnType<NodeFormatter<T>['keyword']>) => void
    ): void {
        const count = GrammarUtils.findNodesForKeyword(node.$cstNode, keyword).length;
        for (let index = 0; index < count; index++) {
            apply(formatter.keyword(keyword, index));
        }
    }
}

/**
 * The run of comment lines standing on their own directly above a node.
 *
 * Stops at anything else, and at a comment sharing a line with code -- a
 * trailing `// note` belongs to the line it is on, and moving it would move
 * it away from what it annotates.
 */
function commentsAbove(node: AstNode): CstNode[] {
    const found: CstNode[] = [];
    let current = node.$cstNode;
    while (current) {
        const previous = CstUtils.getPreviousNode(current, true);
        if (!previous?.hidden || previous.range.end.line >= current.range.start.line) {
            break;
        }
        found.push(previous);
        current = previous;
    }
    return found;
}
