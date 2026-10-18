// The vocabulary of OntoUML/UFO stereotypes a `ClassDeclaration` can carry.
//
// This is a `fragment`, not a standalone rule: its single assignment
// (`stereotype=...`) is merged directly into whichever rule calls it, so
// `ClassDeclaration.stereotype` is a plain string field instead of a nested
// `{ ontologicalCategory: string }` wrapper object. Legacy tonto's
// `OntologicalCategory` rule was *not* a fragment, which produced exactly
// that extra indirection in the generated AST.
fragment Stereotype:
    stereotype=(UnspecifiedStereotype | NonEndurantStereotype | EndurantStereotype)
;

/**
 * The stereotype vocabulary as declared types, so the generated AST carries a
 * union of the literals rather than a bare `string`.
 *
 * Every table and every check in `validation/` switches on these words; typed
 * as `string` a misspelling compiles and silently matches nothing, and adding
 * a stereotype to the grammar leaves every table quietly incomplete.
 */
type ClassStereotype =
    'class' | 'event' | 'situation' | 'process' |
    'category' | 'mixin' | 'phaseMixin' | 'roleMixin' | 'historicalRoleMixin' |
    'kind' | 'collective' | 'quantity' | 'quality' | 'mode' | 'intrinsicMode' |
    'extrinsicMode' | 'relator' | 'type' | 'abstractum' |
    'subkind' | 'phase' | 'role' | 'historicalRole';

UnspecifiedStereotype returns ClassStereotype:
    'class'
;

NonEndurantStereotype returns ClassStereotype:
    'event' | 'situation' | 'process'
;

EndurantStereotype returns ClassStereotype:
    NonSortalStereotype | UltimateSortalStereotype | SortalStereotype
;

/** Rigid or anti-rigid classifiers that do not carry identity on their own. */
NonSortalStereotype returns ClassStereotype:
    'category' | 'mixin' | 'phaseMixin' | 'roleMixin' | 'historicalRoleMixin'
;

/** Sortals that supply an identity principle to their instances. */
UltimateSortalStereotype returns ClassStereotype:
    'kind' | 'collective' | 'quantity' | 'quality' | 'mode' | 'intrinsicMode' |
    'extrinsicMode' | 'relator' | 'type' | 'abstractum'
;

/** Sortals that specialize (directly or transitively) an ultimate sortal. */
SortalStereotype returns ClassStereotype:
    'subkind' | 'phase' | 'role' | 'historicalRole'
;
