import "./terminals";
import "./common";
import "./datatypes";

/** A property of a classifier: `name: const string [0..1]`. */
interface Attribute {
    /**
     * `@begin` and `@end`, the two attribute stereotypes; they decorate an
     * attribute, which is the word the rest of this language uses.
     * A list because one attribute may carry both, which is how an
     * instantaneous individual is written -- its begin and end points coincide.
     */
    stereotypes: string[]
    name: string
    type: @AttributeType
    cardinality?: Cardinality
    isOrdered: boolean
    isConst: boolean
    /**
     * `addOnly`: values may be added and never removed or replaced, so the
     * collection only ever grows. UML 1.x had exactly this, beside the
     * `frozen` that `const` stands for; UML 2 kept only the latter.
     */
    isAddOnly: boolean
    isDerived: boolean
}

/**
 * `birthDate: const date`, `nicknames: ordered string [*]`.
 *
 * The modifiers are words in front of the type, where a reader meets them
 * before the thing they qualify -- "a const date" -- rather than in a trailing
 * `{const}` block. Nothing delimits them because nothing has to: a type
 * reference is a `QualifiedName`, which admits no hard keyword, so a word in
 * that position is a modifier or it is the type, and never both.
 *
 * The braces they used to sit in also made `{}` legal, saying nothing, and
 * left the rule ambiguous enough that Chevrotain reported it on every parser
 * build -- an empty group between two braces is a prefix of itself.
 *
 * `const` and `addOnly` are alternatives, not a pair: `const` says nothing
 * changes and `addOnly` says nothing is taken away, so writing both says the
 * second twice. A rule used to point that out; the grammar refuses it, which
 * is the same answer given earlier. That is what fixes the order of the three
 * -- `ordered`, then `const` or `addOnly`, then `derived` -- since an
 * alternation inside an unordered group is more than Chevrotain can see
 * through.
 */
Attribute returns Attribute:
    ('@' stereotypes+=AttributeStereotype)*
    name=Name ':'
    (isOrdered?='ordered')? ((isConst?='const') | (isAddOnly?='addOnly'))? (isDerived?='derived')?
    type=[AttributeType:QualifiedName]
    cardinality=Cardinality?
;

/**
 * The instant a concrete individual begins or ceases to exist: for an endurant
 * when it comes into or goes out of existence, for an event when it starts or
 * finishes occurring, for a situation when it begins or ceases to obtain.
 */
AttributeStereotype returns string:
    'begin' | 'end' | ID
;
