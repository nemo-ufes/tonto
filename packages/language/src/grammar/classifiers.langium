import "./terminals";
import "./stereotypes";
import "./natures";
import "./common";
import "./attributes";
import "./relations";

/**
 * Common shape shared by every named classifier in a tonto model
 * (`ClassDeclaration`, `Datatype`, `Enumeration`). Declaring it as a real
 * interface -- instead of duplicating these fields per rule, or relying on
 * callers to structurally guess a shared shape -- lets tooling (validators,
 * generators, LLM-facing serializers) write one code path that works over
 * any classifier.
 */
interface Classifier {
    name: string
    natures: string[]
    /** `label { }` / `description { }` blocks, kept only to be converted. */
    legacyText: LegacyTextBlock[]
    attributes: Attribute[]
}

/**
 * An OntoUML/UFO endurant or non-endurant type: `kind Person { ... }`,
 * `role Student specializes Person`, `relator Marriage (instanceOf ...) { ... }`.
 */
interface ClassDeclaration extends Classifier {
    stereotype: ClassStereotype
    /**
     * Cardelli's reading of a high-order type: its instances are *every*
     * specialization of the base, the base included. A modifier rather than a
     * stereotype, because it is orthogonal to what the class is -- a `type`, a
     * `category of types` and a `class of types` may each be one, and each is
     * still whatever its stereotype says.
     */
    isPowerType: boolean
    instanceOf?: @ClassDeclaration
    specializes: @ClassDeclaration[]
    /**
     * What a historical role is derived from: a `@participation`,
     * `@creation` or `@termination` written elsewhere -- a graduate is
     * whoever, as a student, took part in a graduation -- or the event type,
     * where only one relation into it could be meant.
     */
    derivedFrom: @HistoricalFounding[]
    relations: InternalRelation[]
}

/**
 * What a class may be derived from: a relation, or the event type it reaches
 * when only one relation into that event could be meant.
 */
type HistoricalFounding = Relation | ClassDeclaration;

ClassDeclaration returns ClassDeclaration:
    Stereotype
    name=Name
    ElementOntologicalNature?
    (isPowerType?='isPowerType')?
    ('(' 'instanceOf' instanceOf=[ClassDeclaration:QualifiedName] ')')?
    ('specializes' specializes+=[ClassDeclaration:QualifiedName]
        (',' specializes+=[ClassDeclaration:QualifiedName])*
    )?
    // A clause, as on a relation: the derivation is a fact about this class.
    ('derivedFrom' derivedFrom+=[HistoricalFounding:QualifiedName]
        (',' derivedFrom+=[HistoricalFounding:QualifiedName])*
    )?
    // Body members may appear in any order. Legacy tonto fixed the order as
    // `label? description? members*`, so a `label` written after an attribute
    // -- or a `description` before a `label` -- failed with
    // `Expecting token of type '}' but found 'label'`, which says nothing
    // about the real problem. Every body the ordered version accepted still
    // parses.
    ('{'
        (legacyText+=LegacyTextBlock | attributes+=Attribute | relations+=InternalRelation)*
    '}')?
;
