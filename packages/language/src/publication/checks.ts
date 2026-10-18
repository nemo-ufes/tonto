import { AstUtils } from 'langium';
import type { AstNode, ValidationAcceptor } from 'langium';
import type { Model, Package } from '../generated/ast.js';
import { isClassDeclaration, isDatatype, isEnumeration, isExternalRelation, isOntologyBody, isPackage } from '../generated/ast.js';
import { getRelationSource } from '../utils/relations.js';
import { relationPlainName } from '../gufo.js';
import { ownerOf } from './workspace.js';
import type { OntologyUnit } from './workspace.js';

/** The public identifier space is independent of package visibility and RDF configuration. */
export function publicNames(pkg: Package): Array<{ node: AstNode; name: string }> {
    const names: Array<{ node: AstNode; name: string }> = [];
    for (const declaration of pkg.declarations) {
        if (isClassDeclaration(declaration) || isDatatype(declaration) || isEnumeration(declaration)) {
            if (declaration.name) names.push({ node: declaration, name: declaration.name });
            for (const attribute of declaration.attributes) names.push({ node: attribute, name: `${declaration.name}.${attribute.name}` });
            if (isEnumeration(declaration)) for (const literal of declaration.literals) names.push({ node: literal, name: `${declaration.name}.${literal.name}` });
        }
        const relations = isClassDeclaration(declaration) ? declaration.relations : isExternalRelation(declaration) ? [declaration] : [];
        for (const relation of relations) {
            const source = getRelationSource(relation);
            const target = relation.target?.ref;
            if (source && target && relation.stereotype !== 'instantiation') {
                names.push({ node: relation, name: `${source.name}.${relationPlainName(relation, source, target)}` });
            }
        }
    }
    return names;
}

/**
 * What every package of an ontology shares, worked out once per build rather
 * than once per package: each package read every other package's names, so
 * the check grew with the square of the model.
 */
interface OntologySummary {
    names: Map<string, Array<{ node: AstNode; name: string }>>;
    packages: Map<string, Package[]>;
}
const summaries = new WeakMap<OntologyUnit, OntologySummary>();

function summaryOf(unit: OntologyUnit): OntologySummary {
    let summary = summaries.get(unit);
    if (summary) return summary;
    const names = new Map<string, Array<{ node: AstNode; name: string }>>();
    for (const entry of unit.packages.flatMap(publicNames)) names.set(entry.name, [...names.get(entry.name) ?? [], entry]);
    const packages = new Map<string, Package[]>();
    for (const pkg of unit.packages) if (pkg.name) packages.set(pkg.name, [...packages.get(pkg.name) ?? [], pkg]);
    summary = { names, packages };
    summaries.set(unit, summary);
    return summary;
}

export function checkOntologyIdentifiers(pkg: Package, accept: ValidationAcceptor): void {
    const unit = ownerOf(pkg);
    if (!unit) return;
    const summary = summaryOf(unit);
    for (const entry of publicNames(pkg)) {
        const earlier = summary.names.get(entry.name)?.find(other => other.node !== entry.node);
        if (!earlier) continue;
        const otherPackage = AstUtils.getContainerOfType(earlier.node, isPackage)!;
        const where = unit.declaration ? `ontology "${unit.name}"` : 'the same model';
        const other = isOntologyBody(otherPackage) ? `ontology "${unit.name}"` : `package "${otherPackage.name}" of ${where}`;
        accept('error', `Public identifier "${entry.name}" is also declared in ${other}. Rename one; a "use" does not separate public identities.`, {
            node: entry.node, code: entry.name.includes('.') ? 'namespace-member-clash' : 'namespace-name-clash',
            relatedInformation: earlier.node.$cstNode ? [{
                location: { uri: AstUtils.getDocument(earlier.node).uri.toString(), range: earlier.node.$cstNode.range },
                message: `Other declaration of "${entry.name}".`
            }] : undefined
        });
    }
    const duplicate = pkg.name ? summary.packages.get(pkg.name)?.find(other => other !== pkg) : undefined;
    if (duplicate) accept('error', `Package "${pkg.name}" is also declared in ${AstUtils.getDocument(duplicate).uri.toString()} within this ontology.`, {
        node: pkg, property: 'name', code: 'duplicate-package-across-files'
    });
}

export function checkPublicationNames(model: Model, accept: ValidationAcceptor, publication: boolean): void {
    for (const node of [...model.ontologies, ...model.imports, ...model.packages.flatMap(pkg => pkg.imports)]) {
        const property = 'name' in node ? 'name' : 'alias';
        const name = 'name' in node ? node.name : node.alias;
        if (name && name !== name.toLowerCase()) accept(publication ? 'error' : 'warning', `Ontology names and aliases must be lowercase: write "${name.toLowerCase()}".`, {
            node, property, code: 'ontology-name-case', data: { expected: name.toLowerCase(), property }
        });
    }
}
