import "./terminals";
import "./natures";
import "./common";
import "./attributes";
import "./classifiers";

/**
 * A structured or primitive data type: `datatype Address { street: string }`.
 * Built-in primitives (`string`, `number`, `boolean`, `date`, `time`,
 * `datetime`) are themselves ordinary `Datatype` declarations, loaded from an
 * implicit `tonto.builtinDatatypes` document -- see workspace/builtin-datatypes.ts.
 */
interface Datatype extends Classifier {
    specializes: @DatatypeSpecializationTarget[]
}

Datatype returns Datatype:
    'datatype' name=Name
    ElementOntologicalNature?
    ('specializes' specializes+=[DatatypeSpecializationTarget:QualifiedName]
        (',' specializes+=[DatatypeSpecializationTarget:QualifiedName])*
    )?
    ('{'
        (legacyText+=LegacyTextBlock | attributes+=Attribute)*
    '}')?
;

/**
 * An enumeration: `enum Color { red, green, blue }`.
 *
 * Legacy tonto modeled this as `Enum infers DataType`, i.e. the very same
 * generated AST type as a plain `Datatype`, distinguished only by a runtime
 * `isEnum` boolean and an `elements` field that is simply absent/empty for
 * plain datatypes. Giving `Enumeration` its own interface means `$type`
 * alone discriminates the two -- no boolean flag to check, and a plain
 * `Datatype` can no longer accidentally carry `literals`.
 */
interface Enumeration extends Classifier {
    specializes: @DatatypeSpecializationTarget[]
    literals: EnumLiteral[]
}

Enumeration returns Enumeration:
    'enum' name=Name
    ('specializes' specializes+=[DatatypeSpecializationTarget:QualifiedName]
        (',' specializes+=[DatatypeSpecializationTarget:QualifiedName])*
    )?
    ('{'
        // The literals form one comma-separated run, so unlike a class body
        // they cannot be interleaved; the blocks stay ahead of the run.
        (legacyText+=LegacyTextBlock)*
        (literals+=EnumLiteral (',' literals+=EnumLiteral)*)?
    '}')?
;

interface EnumLiteral {
    name: string
}

EnumLiteral returns EnumLiteral:
    name=Name
;

/**
 * What a `datatype`/`enum` declaration may specialize: another datatype
 * family member, or a `class`-stereotype `ClassDeclaration` restricted to
 * `abstract-individuals` (enforced by validation, not the grammar).
 */
type DatatypeSpecializationTarget = ClassDeclaration | Datatype | Enumeration;

/** What an `Attribute` may be typed with. */
type AttributeType = Datatype | Enumeration;
