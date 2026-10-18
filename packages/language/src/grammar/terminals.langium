// Lexical layer: identical token set to legacy tonto so that every existing
// .tonto document keeps parsing exactly as before.

hidden terminal WS: /\s+/;
terminal INT returns number: /[0-9]+/;
terminal STRING: /"[^"]*"|'[^']*'/;
terminal LOCATION: /<[^\s<>]+>/;

/**
 * Identifiers. Permissive after the first character ('-', '~', '$', '#', '@',
 * '/'), to match every identifier legacy tonto accepts, and widened beyond
 * it to letters outside ASCII: `\w` left `kind Ação` as three tokens and a
 * lexer error in a language whose documentation had `@pt-br` from the start.
 *
 * The ranges are XML's `NameStartChar` and `NameChar` rather than `\p{L}` with
 * the `u` flag, and that is not a stylistic choice. Under `u` the lexer stops
 * resolving a keyword against a longer identifier, so `@subQuantityOf` lexed
 * as the keyword `subQuantity` followed by `Of` -- every name beginning with a
 * keyword would have broken the same way.
 */
terminal ID: /[_a-zA-Z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD][\w_\-~$#@/\d\u00B7\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u037D\u037F-\u1FFF\u200C-\u200D\u203F-\u2040\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD]*/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;

/**
 * One rule covers both comment forms, because `///` *is* a line comment: what
 * separates them is not lexical.
 *
 * `//` is an aside to whoever reads the source. A run of `///` lines
 * immediately above a declaration is that declaration's documentation, which
 * the language server returns on hover and in completion proposals -- see
 * `documentation/tonto-documentation-provider.ts`, which reads the run off the
 * lines. Keeping them one token is what lets the run be assembled by
 * adjacency; it also means an editor colors `///` as the comment it is.
 */
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;

/**
 * The relation-stereotype vocabulary, readmitted as ordinary names.
 *
 * These words are keywords only because a stereotype is written with them,
 * and a stereotype is always written after `@`. Nothing else in the language
 * begins with one, so allowing them where a name is expected costs no
 * ambiguity -- and several are exactly the words a domain wants. `value` is
 * the plain case: a quality's value could not be called `value`, while the
 * naming convention insisted member names be lowercase, so there was no legal
 * spelling of it at all.
 *
 * Class stereotypes are deliberately absent: those *do* begin a declaration,
 * so admitting them here would let an unfinished `specializes` swallow the
 * next one.
 */
SoftKeyword returns string:
    'begin' | 'end' | 'global' | 'from' | 'in' | 'use' |
    'material' | 'characterization' | 'mediation' | 'externalDependence' | 'comparative' |
    'componenthood' | 'membership' | 'subCollection' | 'subQuantity' | 'constitution' |
    'historicalDependence' | 'participation' | 'creation' | 'termination' | 'manifestation' |
    'structural' | 'temporal' | 'participational' |
    'triggering' | 'bringingAbout' | 'presence' | 'instantiation' | 'change'
;

/** An identifier, or one of the soft keywords above. */
Name returns string:
    ID | SoftKeyword
;

/**
 * A dotted path such as `core.animals.Vertebrate`, used both for declaring
 * package names and for writing cross-package references.
 */
QualifiedName returns string:
    Name ('.' Name)*
;

/**
 * Every remaining keyword, readmitted where the surrounding syntax already
 * says where the name ends.
 *
 * `SoftKeyword` above can be admitted anywhere a name is written, because a
 * stereotype only ever follows `@`. These cannot: `of`, `specializes` and
 * `where` each continue a declaration, so a class called `of` would leave
 * `kind of objects` genuinely ambiguous. Inside a pair of brackets there is no
 * such doubt -- `(of)` has a `)` after it and nothing else it could be -- and
 * a relation name sits between two `--`. So they are admitted there and
 * nowhere else. `of` is the word this is really for: an end named `(of)` is
 * the most natural label a characterization has, and it did not parse.
 *
 * `test/grammar.test.ts` asserts these two lists together account for every
 * word-shaped keyword in the grammar, so a keyword added anywhere shows up
 * here as a failing test rather than as a name nobody may use.
 */
HardKeyword returns string:
    'abstract-individuals' | 'abstractum' | 'addOnly' | 'as' | 'categorizer' | 'category' | 'class' | 'collective' |
    'collectives' | 'complete' | 'const' | 'datatype' | 'derived' | 'derivedFrom' | 'description' |
    'disjoint' | 'enum' | 'event' | 'events' | 'extrinsic-modes' | 'extrinsicMode' |
    'functional-complexes' | 'general' | 'genset' | 'ontology' | 'bundles' | 'historicalRole' |
    'historicalRoleMixin' | 'import' | 'instanceOf' | 'intrinsic-modes' | 'intrinsicMode' |
    'inverseOf' | 'kind' | 'label' | 'mixin' | 'mode' | 'objects' | 'of' | 'ordered' |
    'package' | 'phase' | 'phaseMixin' | 'isPowerType' | 'process' | 'processes' | 'qualities' | 'quality' |
    'quantities' | 'quantity' | 'redefines' | 'relation' | 'relator' | 'relators' | 'role' |
    'roleMixin' | 'situation' | 'situations' | 'specializes' | 'specifics' | 'subkind' |
    'subsets' | 'type' | 'types' | 'where'
;

/** A name in a position the surrounding syntax delimits, so any word will do. */
DelimitedName returns string:
    Name | HardKeyword
;

/**
 * The same, minus the four words a relation end decorator spends on something
 * else: `(const father)` is a flag and a name, so `const` cannot also *be* the
 * name. The braces used to keep the two apart and no longer exist -- see
 * `RelationEndMetaAttributes` -- and `test/grammar.test.ts` holds these four as
 * the one exception to "every keyword is nameable somewhere".
 */
EndName returns string:
    Name | EndSafeKeyword
;

EndSafeKeyword returns string:
    'abstract-individuals' | 'abstractum' | 'as' | 'categorizer' | 'category' | 'class' | 'collective' |
    'collectives' | 'complete' | 'datatype' | 'derived' | 'derivedFrom' | 'description' |
    'disjoint' | 'enum' | 'event' | 'events' | 'extrinsic-modes' | 'extrinsicMode' |
    'functional-complexes' | 'general' | 'genset' | 'ontology' | 'bundles' | 'historicalRole' |
    'historicalRoleMixin' | 'import' | 'instanceOf' | 'intrinsic-modes' | 'intrinsicMode' |
    'inverseOf' | 'kind' | 'label' | 'mixin' | 'mode' | 'objects' | 'of' | 'ordered' |
    'package' | 'phase' | 'phaseMixin' | 'isPowerType' | 'process' | 'processes' | 'qualities' | 'quality' |
    'quantities' | 'quantity' | 'relation' | 'relator' | 'relators' | 'role' |
    'roleMixin' | 'situation' | 'situations' | 'specializes' | 'specifics' | 'subkind' |
    'type' | 'types' | 'where'
;

/**
 * A dotted path in such a position -- the `subsets`/`redefines` target, which
 * sits inside `{...}`. An end may be called `of`, so `Staff.of` has to be
 * writable, or the name would be legal and unreferenceable.
 */
DelimitedQualifiedName returns string:
    DelimitedName ('.' DelimitedName)*
;
