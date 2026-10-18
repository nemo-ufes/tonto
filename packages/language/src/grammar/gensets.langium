import "./classifiers";
import "./relations";

/** What can participate in a generalization set: a class or a relation. */
type GeneralizableElement = ClassDeclaration | Relation;

/**
 * A generalization set, either in block form (`genset X { general ... specifics ... }`)
 * or short form (`genset X where A, B specializes C`).
 */
interface GeneralizationSet {
    disjoint: boolean
    complete: boolean
    name: string
    general: @GeneralizableElement
    categorizers: @GeneralizableElement[]
    specifics: @GeneralizableElement[]
}

GeneralizationSetImpl returns GeneralizationSet:
    (disjoint?='disjoint')? (complete?='complete')?
    'genset' name=Name '{'
        // TODO: change to an unordered group once Langium supports it for interfaces.
        (
            'general' general=[GeneralizableElement:QualifiedName]
            ('categorizer' categorizers+=[GeneralizableElement:QualifiedName])?
            'specifics' specifics+=[GeneralizableElement:QualifiedName]
            (',' specifics+=[GeneralizableElement:QualifiedName])*
        )
    '}'
;

GeneralizationSetShort returns GeneralizationSet:
    (disjoint?='disjoint')? (complete?='complete')?
    'genset' name=Name 'where'
    specifics+=[GeneralizableElement:QualifiedName] (',' specifics+=[GeneralizableElement:QualifiedName])*
    'specializes' general=[GeneralizableElement:QualifiedName]
;
