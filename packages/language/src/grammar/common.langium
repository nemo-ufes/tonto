import "./terminals";

/**
 * A multiplicity constraint such as `[0..*]`, `[1]`, or `[2..5]`.
 * `upperBound` is absent for a single exact bound (e.g. `[1]` means lower =
 * upper = 1), matching legacy tonto's cardinality syntax exactly.
 */
interface Cardinality {
    lowerBound: number | string
    upperBound?: number | string
}

Cardinality returns Cardinality:
    '[' lowerBound=(INT | '*')
    ('..' upperBound=(INT | '*'))? ']'
;

/**
 * One `@language "text"` entry inside a legacy `label { }` or
 * `description { }` block.
 */
interface LanguageText {
    language: string
    text: string
}

LanguageText returns LanguageText:
    '@' language=ID text=STRING
;

/**
 * The older spelling of a label or a description: `description { @en "..." }`.
 *
 * Superseded by `///` documentation, which says the same things about any
 * declaration rather than only about a classifier, holds text no string
 * literal can (`"` has no escape) and is edited a line at a time. This rule
 * remains so that every model that parsed before still parses; a check
 * answers it with the conversion, and nothing downstream reads these blocks
 * except the documentation service, which folds them in beside the comments.
 *
 * One list rather than a `label=` and a `description=` field: two blocks of
 * the same kind used to overwrite one another silently -- the AST kept the
 * later, and finding the discarded one meant walking the CST -- and every
 * build warned about the data loss. Collected, they merge like the comment
 * runs they are becoming, and a language written twice is what is actually
 * wrong, which the documentation checks report by language.
 */
interface LegacyTextBlock {
    kind: string
    items: LanguageText[]
}

LegacyTextBlock returns LegacyTextBlock:
    kind=('label' | 'description') '{'
        (items+=LanguageText)*
    '}'
;
