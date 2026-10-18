import type { AstNode, ValidationAcceptor } from 'langium';
import { AstUtils } from 'langium';
import type { ClassDeclaration, Classifier, Datatype, Enumeration, Relation } from '../generated/ast.js';
import { isClassDeclaration, isEnumeration } from '../generated/ast.js';
import { areInverses, getEndOwner, getRelationSource } from '../utils/relations.js';
import type { ReverseLookup } from './incoming-relations.js';
import { classifiesTypes } from '../utils/nature-reasoning.js';

export interface Member {
    name: string;
    node: AstNode;
    property: string;
    /** What kind of member this is, for the diagnostic message. */
    kind: string;
    /** The relation it came from, where it came from one. */
    relation?: Relation;
}

/**
 * Everything that occupies a classifier's member namespace.
 *
 * Attributes, relations and named relation ends all become `Owner.x`
 * qualified names, so a collision between any two of them is a genuine
 * ambiguity, not just a style problem -- hence one combined check rather
 * than three independent ones.
 *
 * The namespace is the classifier's, not the file's. An end is a property of
 * the classifier at the *opposite* side, so a relation written anywhere in
 * the workspace can put a name into this classifier's namespace: the
 * target-side end of a relation whose source is this class, the source-side
 * end of one whose target is. Only the relations nested in the class were
 * read here once, so the same model written as `relation Person [1] -- [*]
 * (foo) Car` beside the class, rather than inside it, collided with
 * `Person.foo` in silence -- and the scope provider exported both names all
 * the same.
 */
export function collectMembers(classifier: Classifier, lookup?: ReverseLookup): Member[] {
    const members: Member[] = [];

    for (const attribute of classifier.attributes) {
        if (attribute.name) {
            members.push({ name: attribute.name, node: attribute, property: 'name', kind: 'attribute' });
        }
    }

    if (isEnumeration(classifier)) {
        for (const literal of classifier.literals) {
            if (literal.name) {
                members.push({ name: literal.name, node: literal, property: 'name', kind: 'enum literal' });
            }
        }
    }

    if (isClassDeclaration(classifier)) {
        // Every relation with this class at either end, wherever written,
        // and its own -- which `touching` already includes.
        const relations = lookup ? lookup.touching(classifier) : classifier.relations;
        for (const relation of new Set(relations)) {
            if (relation.name && getRelationSource(relation) === classifier) {
                members.push({ name: relation.name, node: relation, property: 'name', kind: 'relation', relation });
            }
            for (const end of [relation.sourceMeta, relation.targetMeta]) {
                if (end?.name && getEndOwner(end) === classifier) {
                    members.push({ name: end.name, node: end, property: 'name', kind: 'relation end', relation });
                }
            }
        }
    }

    return members;
}

export function checkDuplicateMemberNames(
    classifier: Classifier, accept: ValidationAcceptor, lookup?: ReverseLookup
): void {
    const document = AstUtils.getDocument(classifier);
    const here = (member: Member): boolean => AstUtils.getDocument(member.node) === document;
    const seen = new Map<string, Member>();
    for (const member of collectMembers(classifier, lookup)) {
        const previous = seen.get(member.name);
        if (!previous) {
            seen.set(member.name, member);
            continue;
        }
        // An inverse is the same association read the other way, so its ends
        // are the same ends: `Man.children` written on both is one property
        // named twice, and `checkInverseEndsAgree` is what holds the two
        // statements of it together.
        if (previous.relation && member.relation && areInverses(previous.relation, member.relation)) {
            continue;
        }
        // Both ends of one relation, which is a relation from a classifier to
        // itself: `duplicate-end-name` says that in the words of the relation,
        // and repeating it here as a namespace collision is one mistake
        // reported twice.
        if (previous.relation && previous.relation === member.relation
            && previous.kind === 'relation end' && member.kind === 'relation end') {
            continue;
        }
        // Reported where it can be pointed at: a collision with a relation
        // written in another file is still this classifier's collision, but
        // the diagnostic has to land on text in this document.
        const [named, other] = here(member) ? [member, previous] : [previous, member];
        const detail = named.kind === other.kind
            ? `Duplicate ${named.kind} name "${named.name}" in "${classifier.name}".`
            : `The ${named.kind} "${named.name}" collides with the ${other.kind} of the same name in "${classifier.name}".`;
        accept('error', detail, here(named)
            ? {
                node: named.node,
                property: named.property,
                code: 'duplicate-member',
                // The repair deletes what it is reported on. With both here,
                // the second one written is the redundant one; with one of
                // them in another file, which is redundant is not this
                // check's to say.
                data: { local: here(other) }
            }
            : { node: classifier, property: 'name', code: 'duplicate-member', data: { local: false } });
    }
}

export function checkClassDeclarationMembers(
    lookup: ReverseLookup, classDeclaration: ClassDeclaration, accept: ValidationAcceptor
): void {
    checkDuplicateMemberNames(classDeclaration, accept, lookup);
}

export function checkDatatypeMembers(datatype: Datatype, accept: ValidationAcceptor): void {
    checkDuplicateMemberNames(datatype, accept);
}

export function checkEnumerationMembers(enumeration: Enumeration, accept: ValidationAcceptor): void {
    checkDuplicateMemberNames(enumeration, accept);
}

/**
 * `(instanceOf X)` states that this class is an instance of the higher-order
 * type `X`, so everything `X` classifies must itself be a type.
 */
export function checkInstanceOfTargetIsHigherOrder(classDeclaration: ClassDeclaration, accept: ValidationAcceptor): void {
    const target = classDeclaration.instanceOf?.ref;
    if (!target) {
        return;
    }
    if (!classifiesTypes(target)) {
        accept('error', `"instanceOf" must reference a class that classifies types -- a "type", or any class restricted to "of types" -- but "${target.name}" does not.`, {
            node: classDeclaration,
            property: 'instanceOf',
            // `categorizer-not-higher-order` is the generalization set's categorizer.
            // Two rules under one code cannot be told apart by anything
            // reading the code: not by a suppression, not by `--fix=`.
            code: 'instance-of-not-higher-order'
        });
    }
}
