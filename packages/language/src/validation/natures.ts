import { AstUtils, GrammarAST } from 'langium';
import { TontoGrammar } from '../generated/grammar.js';
/**
 * The ontological natures, once.
 *
 * A nature is what an individual fundamentally is: a functional complex, a
 * quantity, a relator, an event, a process. Five places used to say what they
 * are and how they behave -- the grammar's keywords, the lists in
 * `stereotype-model.ts`, the singular categories the association signatures
 * are built from, the plural-to-singular map between the two spellings, and a
 * set of the natures whose instances cannot change -- and nothing held them to
 * each other.
 *
 * They drifted, in the way this kind of duplication always drifts: quietly and
 * in a comment. `processes` was added to the language and left out of the list
 * that called itself "every atomic nature", and the sentence explaining the
 * omission called a process "a way of being an endurant", which is the one
 * thing the rest of the project is careful to say it is not.
 *
 * So each fact is stated here once and everything else is derived. What a
 * nature is called in either spelling, which sort of individual it is, whether
 * it endures, and whether its instances can change: add a nature to this table
 * and the keywords, the unions, the signatures, the immutability set and the
 * guide all learn about it together.
 */

/** UFO's sorts, which the association signatures are grouped by. */
export type Sort = 'substantial' | 'aspect' | 'type' | 'perdurant' | 'situation' | 'abstract';

export interface NatureDescription {
    /** How the relation tables spell it: one individual of that nature. */
    table: string;
    sort: Sort;
    /**
     * A continuant: wholly present whenever it is present, with no temporal
     * parts. A process is not one, however much else it shares with them
     * (Guarino & Guizzardi, *Processes as variable embodiments*, Synthese
     * 203:104, 2024, §2).
     */
    endures: boolean;
    /**
     * Whether an individual of this nature can have a property now and lack it
     * later. This, not endurance, is what anti-rigidity needs: a `role` or a
     * `phase` holds of an instance for part of its life and not the rest.
     * Endurants qualify, and so do processes, whose constitution varies in
     * time exactly as a statue's matter does. An event does not stop being
     * that event, and an abstract individual has no life to divide.
     *
     * `situations` are false for now: whether a situation can change is
     * unsettled, and saying yes would be a claim this project has not made.
     */
    instancesCanChange: boolean;
}

/** Every nature that is one thing rather than a name for several. */
export const NATURE_ATOMS: Readonly<Record<string, NatureDescription>> = {
    'functional-complexes': { table: 'functional-complex', sort: 'substantial', endures: true, instancesCanChange: true },
    collectives: { table: 'collective', sort: 'substantial', endures: true, instancesCanChange: true },
    quantities: { table: 'quantity', sort: 'substantial', endures: true, instancesCanChange: true },
    relators: { table: 'relator', sort: 'aspect', endures: true, instancesCanChange: true },
    'intrinsic-modes': { table: 'intrinsic-mode', sort: 'aspect', endures: true, instancesCanChange: true },
    'extrinsic-modes': { table: 'extrinsic-mode', sort: 'aspect', endures: true, instancesCanChange: true },
    qualities: { table: 'quality', sort: 'aspect', endures: true, instancesCanChange: true },
    // A high-order type is itself an endurant (Fonseca, Guizzardi, Almeida,
    // Sales & Porello, CAiSE 2022), so `category C of types` is well formed.
    types: { table: 'type', sort: 'type', endures: true, instancesCanChange: true },
    processes: { table: 'process', sort: 'perdurant', endures: false, instancesCanChange: true },
    events: { table: 'event', sort: 'perdurant', endures: false, instancesCanChange: false },
    situations: { table: 'situation', sort: 'situation', endures: false, instancesCanChange: false },
    'abstract-individuals': { table: 'abstract', sort: 'abstract', endures: false, instancesCanChange: false }
};

/**
 * Names that stand for several natures at once.
 *
 * Comparing natures by string equality gets subsumption wrong in both
 * directions -- it rejects `kind B of functional-complexes specializes
 * category A of objects` (valid: functional-complexes are objects) and accepts
 * a child that widens its parent's restriction -- so every comparison expands
 * first.
 */
export const NATURE_UNIONS: Readonly<Record<string, readonly string[]>> = {
    objects: ['functional-complexes', 'collectives', 'quantities']
};

export const ATOMIC_NATURES: readonly string[] = Object.keys(NATURE_ATOMS);

/** Every word the grammar accepts in an `of` clause: the atoms and the unions. */
export const EVERY_NATURE: readonly string[] = [...ATOMIC_NATURES, ...Object.keys(NATURE_UNIONS)];

/** The atoms a name stands for: itself, unless it is a union. */
export function atomsOf(nature: string): readonly string[] {
    return NATURE_UNIONS[nature] ?? [nature];
}

/** Every name -- atom or union -- all of whose atoms answer yes. */
function every(predicate: (description: NatureDescription) => boolean): readonly string[] {
    return EVERY_NATURE.filter(nature => {
        const atoms = atomsOf(nature).map(atom => NATURE_ATOMS[atom]);
        return atoms.length > 0 && atoms.every(atom => atom !== undefined && predicate(atom));
    });
}

export const ENDURANT_NATURES: readonly string[] = every(nature => nature.endures);
export const CHANGEABLE_INSTANCE_NATURES: readonly string[] = every(nature => nature.instancesCanChange);
/** The complement: nothing about an instance of these changes. */
export const IMMUTABLE_NATURES: ReadonlySet<string> = new Set(
    ATOMIC_NATURES.filter(nature => !NATURE_ATOMS[nature].instancesCanChange));

/** The natures of one sort, spelled as the association signatures spell them. */
export function tableNamesOfSort(...sorts: Sort[]): readonly string[] {
    return ATOMIC_NATURES
        .filter(nature => sorts.includes(NATURE_ATOMS[nature].sort))
        .map(nature => NATURE_ATOMS[nature].table);
}

/** Plural as written in tonto, to the singular the tables use. */
export const TABLE_NATURE_NAMES: Record<string, string> = Object.fromEntries(
    ATOMIC_NATURES.map(nature => [nature, NATURE_ATOMS[nature].table]));

/** The same mapping read the other way, derived so the two cannot disagree. */
export const TONTO_NATURE_NAMES: Record<string, string> = Object.fromEntries(
    ATOMIC_NATURES.map(nature => [NATURE_ATOMS[nature].table, nature]));

let grammarOrder: readonly string[] | undefined;

/**
 * The natures in the order the grammar's `OntologicalNature` rule lists them,
 * which is the order a modeler reads them in -- events before processes --
 * and not this table's, which groups them by sort.
 */
function inGrammarOrder(): readonly string[] {
    if (!grammarOrder) {
        const rule = TontoGrammar().rules.find(candidate => candidate.name === 'OntologicalNature');
        const listed = rule
            ? AstUtils.streamAllContents(rule).filter(GrammarAST.isKeyword).map(keyword => keyword.value).toArray()
            : [];
        grammarOrder = listed.length > 0 ? listed : EVERY_NATURE;
    }
    return grammarOrder;
}

/**
 * Natures as an `of` clause spells them: in the order the grammar lists them,
 * with `objects` for the three it names.
 */
export function ofClauseNatures(natures: Iterable<string>): string[] {
    const found = new Set(natures);
    const atoms = inGrammarOrder().filter(nature => found.has(nature) && ATOMIC_NATURES.includes(nature));
    const objects = NATURE_UNIONS.objects;
    if (!objects.every(nature => found.has(nature))) {
        return atoms;
    }
    const at = atoms.indexOf(objects[0]);
    const rest = atoms.filter(nature => !objects.includes(nature));
    return [...rest.slice(0, at), 'objects', ...rest.slice(at)];
}
