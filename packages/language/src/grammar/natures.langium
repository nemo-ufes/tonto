// The `of objects, events, ...` clause restricting which ontological natures
// a classifier's instances can have.
//
// Also a `fragment`: legacy tonto's `ElementOntologicalNature` rule was a
// plain (non-fragment) rule assigned via `ontologicalNatures=ElementOntologicalNature?`,
// which wrapped the `natures` array inside an extra object
// (`class.ontologicalNatures.natures`) instead of exposing it directly as
// `class.natures`. Making it a fragment removes that indirection.
fragment ElementOntologicalNature:
    'of' natures+=OntologicalNature (',' natures+=OntologicalNature)*
;

OntologicalNature returns string:
    'objects' | 'functional-complexes' | 'collectives' | 'quantities' |
    'relators' | 'intrinsic-modes' | 'extrinsic-modes' | 'qualities' |
    'events' | 'processes' | 'situations' | 'types' | 'abstract-individuals'
    // These are the words `natures.ts` describes, and the only home of the
    // vocabulary a grammar cannot derive -- `test/grammar.test.ts` holds the
    // two lists to each other.
    //
    // 'objects' is the union of 'functional-complexes', 'collectives' and 'quantities'.
    //
    // 'processes' is not a kind of event, and not an endurant either. A
    // process is an occurrent: it has temporal parts, which is what keeps it
    // among the perdurants however much else it shares with the continuants
    // (Guarino & Guizzardi, *Processes as variable embodiments*, Synthese
    // 203:104, 2024, §2). What it does share is that its instances change --
    // it is a variable embodiment, constituted by different events at
    // different times -- so the anti-rigid stereotypes are available over it
    // and the taxonomic rules that turn on change treat it as they treat an
    // endurant.
;
