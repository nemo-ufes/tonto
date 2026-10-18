/**
 * Which ontological natures each association stereotype admits at each end.
 *
 * Written as twenty-three category signatures -- `@mediation` runs from a
 * relator to an endurant, `@membership` from a collective to a substantial --
 * and expanded into the five hundred-odd pairs a lookup wants. The categories
 * are UFO's own, so each signature is a claim someone can disagree with, which
 * a list of pairs is not.
 *
 * `test/relation-ends.fixture.ts` holds the transcribed pairs and the test
 * beside it asserts the signatures reproduce every one, so provenance stays
 * where provenance belongs and a category widened without meaning to widen the
 * table fails there rather than quietly admitting something new.
 *
 * Entries read `first:second`. For parthood that is *(whole, part)*, the order
 * the concrete syntax writes when the diamond sits at the source -- `Car <>--
 * Engine` -- or when there is none, which means the same. A `--<>` reverses
 * the reading, so a lookup still orients itself first; see `wholeEndOf`. For
 * every other stereotype the pair is *(source, target)*.
 *
 * Parthood is irreflexive and asymmetric *between individuals* -- no system is
 * part of itself -- while an entry of `functional-complex:functional-complex`
 * says only that a system may have systems among its parts, which is ordinary.
 * No table over natures can express the individual-level constraint, and none
 * here tries; `checkParthoodIsAcyclic` reports only the shape no finite
 * individual could satisfy.
 *//**
 * The ontological categories the signatures below are written in.
 *
 * These are UFO's own, not groupings invented for a lookup: substantials and
 * aspects partition the endurants, perdurants are what unfolds, concrete
 * individuals are everything in time. Writing the table in them is what makes
 * it checkable -- `test/relation-ends.test.ts` holds the transcribed pairs and
 * asserts these reproduce them.
 */
import { TABLE_NATURE_NAMES, tableNamesOfSort } from './natures.js';
import { RELATION_STEREOTYPES } from './relation-stereotypes.js';

// Read off the nature table rather than restated: the names, and which sort
// each nature belongs to, are facts about the language, and this file is
// about what the associations do with them.
const SUBSTANTIAL = tableNamesOfSort('substantial');
const ASPECT = tableNamesOfSort('aspect');
const PERDURANT = tableNamesOfSort('perdurant');
/**
 * A process is not among them. It is an occurrent -- it has temporal parts --
 * however much it otherwise behaves like a continuant (Guarino & Guizzardi,
 * *Processes as variable embodiments*, Synthese 203:104, 2024, §2). What a
 * relation stereotype asks of an endurant it asks for endurant reasons: a
 * relator mediates endurants and a material relation is derived from a
 * mediation, so neither reaches a process.
 *
 * External dependence is not one of those, and this comment said it was. What
 * an extrinsic mode *inheres in* is an endurant; what it *depends on* is
 * anything still unfolding, a process included -- see `DEPENDABLE`.
 */
const ENDURANT = [...SUBSTANTIAL, ...ASPECT, ...tableNamesOfSort('type')];
/** Everything in time: the endurants, what happens, and what obtains. */
const CONCRETE = [...ENDURANT, ...PERDURANT, ...tableNamesOfSort('situation')];
/**
 * What an aspect may inhere in: something with a life to bear it. A process
 * has one -- it is fast now and slow later -- while an event is over and a
 * situation, insofar as it obtains, is fact-like: nothing about it varies
 * while it stays that situation.
 */
const BEARER = [...ENDURANT, 'process'];
/**
 * What an extrinsic mode may depend on: everything in time that is not over.
 *
 * Written as the subtraction it is, rather than as endurants with two natures
 * added -- which is how it grew, one commit at a time, and how `process` came
 * to be here for a reason later retracted (that a process is an endurant).
 * A concrete sort added to the language belongs here on the same terms.
 *
 * The three exclusions are each a different reason. An **event** is out
 * because dependence on something that has already happened is historical,
 * which is what `@historicalDependence` states and what does not require the
 * past thing to still be there. An **abstract individual** is out because it
 * exists atemporally: depending on what cannot fail to be there trivializes
 * the dependence. A **high-order type** is in, and is the one member that
 * arrived with the category rather than by a decision about dependence -- the
 * object of a commitment may be the type itself, an intention directed at a
 * kind rather than at any instance of it.
 */
const DEPENDABLE = CONCRETE.filter(nature => nature !== 'event');
const EVERYTHING = [...CONCRETE, ...tableNamesOfSort('abstract')];

type Category = readonly string[];

/**
 * What each association stereotype relates, as one category to another.
 *
 * This is the whole table. The 500-odd admissible pairs it stands for are the
 * products below, written out only because a lookup wants pairs -- and each
 * signature is a claim someone can disagree with, which a list of pairs is
 * not. `@constitution` is the one entry with a different shape: it closes over
 * the categories rather than crossing two, since what constitutes something
 * belongs to its own.
 *
 * Source: the OntoUML tooling's `association_constraints_nature.json`,
 * amended where this project decided differently -- processes as occurrents that can change,
 * `@comparative` opened to everything, `@historicalDependence` to every
 * concrete individual, and `@change` added.
 */
/**
 * A stereotype relates one category to another -- except where a category
 * boundary does not line up, and then it takes more than one signature and the
 * table is their union. Two do: `@characterization`, because what may bear an
 * extrinsic mode is narrower than what may bear a quality, and `@constitution`,
 * which closes over categories instead of crossing two.
 */
type Signature = readonly [Category, Category];

const SIGNATURES: Readonly<Record<string, Signature | readonly Signature[]>> = {
    // Endurants
    material: [ENDURANT, ENDURANT],
    // Aspects are reified for what has a life to bear them: the endurants, and
    // processes, which are fast now and slow later. An event's or a
    // situation's qualities are recorded as `(const)` properties of it
    // instead -- see `checkCharacterizationIsReified`, which says so where
    // someone reaches for a characterization.
    //
    // An extrinsic mode is narrower still: what it inheres in is an endurant.
    characterization: [
        [['intrinsic-mode', 'quality'], BEARER],
        [['extrinsic-mode'], ENDURANT]
    ],
    mediation: [['relator'], ENDURANT],
    // Wider than what an extrinsic mode may *inhere* in: a commitment whose
    // object is an ongoing negotiation, or a situation that obtains, depends
    // on something that is not an endurant. Not an event, which is over --
    // that dependence is `@historicalDependence`, below.
    externalDependence: [['extrinsic-mode'], DEPENDABLE],
    // Founded on the qualities of what it relates, not on what sort of thing
    // they are, so there is nothing for the natures to exclude.
    comparative: [EVERYTHING, EVERYTHING],
    componenthood: [['functional-complex'], ['functional-complex']],
    membership: [['collective'], SUBSTANTIAL],
    subCollection: [['collective'], ['collective']],
    subQuantity: [['quantity'], ['quantity']],
    // Events
    // The other half of external dependence: what has already happened is
    // depended on historically, which asks nothing of it in the present --
    // so this reaches the events `DEPENDABLE` leaves out, and reaches them
    // from anything concrete rather than from an extrinsic mode alone.
    historicalDependence: [CONCRETE, CONCRETE],
    participation: [SUBSTANTIAL, PERDURANT],
    creation: [ENDURANT, PERDURANT],
    // Between the two ends of an endurant's life, which `creation` and
    // `termination` state.
    change: [ENDURANT, PERDURANT],
    termination: [ENDURANT, PERDURANT],
    manifestation: [ASPECT, PERDURANT],
    structural: [['event'], ['event']],
    temporal: [['event'], ['event']],
    participational: [['event'], ['event']],
    // Situations
    triggering: [['situation'], PERDURANT],
    // A process brings a situation about only once terminated: one still
    // gaining parts is not a completed perdurant for a situation to result
    // from. Left to the modeler, as above.
    bringingAbout: [PERDURANT, ['situation']],
    presence: [['situation'], EVERYTHING],
    // Multi-level
    instantiation: [EVERYTHING, ['type']]
};

/**
 * `@constitution` keeps to one category: a statue is constituted of matter, a
 * commitment of other moments, an event of events. Nothing is constituted of
 * something from another category, which is a closure rather than a product.
 *
 * It runs from what is constituted to what constitutes it --
 * `Statue @constitution -- isConstitutedOf -- PortionOfClay` -- the direction
 * the crossing below fixes, taken for every constitution so that a model's
 * reading never depends on which side of a closure its ends fall. Within one
 * category no nature can tell the two ends apart, so there it is a convention
 * the checks read (`constitution-cycle`, `event-without-participation`) and
 * the exporter relies on (docs/gufo-mapping.md), not one they can enforce.
 */
const CONSTITUTION_BLOCKS: readonly Category[] = [SUBSTANTIAL, ASPECT, ['event'], ['process']];

/**
 * The one constitution that crosses categories, and the only pair in this file
 * whose direction the natures themselves fix.
 *
 * A process is constituted by events, and by nothing else: "at each time, a
 * process is constituted by a certain series of events" (Guarino & Guizzardi
 * 2024, §3.1, axiom A5). The constitution is temporary and it varies as the
 * process goes on, exactly as the matter constituting a statue does -- which
 * is what a process changing *is*. Written one way only, so that a relation
 * with the ends reversed is answered with the direction rather than with a
 * flat refusal.
 */
const CONSTITUTION_CROSSINGS: readonly string[] = ['process:event'];

function product(first: Category, second: Category): string[] {
    return first.flatMap(a => second.map(b => `${a}:${b}`));
}

function signaturesOf(stereotype: string): readonly Signature[] {
    const entry = SIGNATURES[stereotype];
    return Array.isArray(entry[0]) && Array.isArray((entry as readonly Signature[])[0][0])
        ? entry as readonly Signature[]
        : [entry as Signature];
}

/**
 * Built in the vocabulary's own order, which is the order everything else
 * reads them in: endurants then events then situations
 * then multi-level. Suggestion lists follow it.
 */
export const RELATION_NATURE_TABLE: Record<string, readonly string[]> = Object.fromEntries(
    RELATION_STEREOTYPES.map(stereotype => [
        stereotype,
        [...new Set(stereotype === 'constitution'
            ? [...CONSTITUTION_BLOCKS.flatMap(block => product(block, block)), ...CONSTITUTION_CROSSINGS]
            : signaturesOf(stereotype).flatMap(signature => product(...signature)))].sort()
    ]));

/**
 * The stereotypes that run from something that endures to something that
 * happens: taking part in it, being created or terminated by it, changing in
 * it, being manifested in it.
 *
 * Read off the signatures rather than listed, so a stereotype added with that
 * shape joins them. Causation is not among them -- a situation triggering an
 * event, or an event bringing one about, starts from something that is not an
 * endurant -- and neither is event parthood, which starts from an event.
 */
export const UNFOLDING_STEREOTYPES: ReadonlySet<string> = new Set(
    RELATION_STEREOTYPES.filter(stereotype => {
        const pairs = RELATION_NATURE_TABLE[stereotype] ?? [];
        return pairs.length > 0 && pairs.every(pair => {
            const [first, second] = pair.split(':');
            return ENDURANT.includes(first) && PERDURANT.includes(second);
        });
    }));

/**
 * Parthood stereotypes, whose entries read (whole, part) -- see the note at
 * the top of this file. Three of them, `participational`, `structural` and
 * `temporal`, admit an event as whole, and all three are `event:event`: a
 * part of an event is an event, whichever of the three states it.
 */
export const PART_WHOLE_STEREOTYPES = new Set([
    'componenthood',
    'membership',
    'subCollection',
    'subQuantity',
    'participational',
    'structural',
    'temporal'
]);

/**
 * The natures admissible at one side of a stereotyped relation, in the
 * table's own vocabulary. `side` is the position within the table entry, not
 * necessarily source/target -- see `relationNaturePair` in
 * `relation-nature-checks.ts`.
 */
/** The table entry for a stereotype, if it has one. */
export function naturesFor(stereotype: string): readonly string[] | undefined {
    return RELATION_NATURE_TABLE[stereotype];
}

export function naturesAllowedAt(stereotype: string, side: 'first' | 'second'): Set<string> {
    const entries = naturesFor(stereotype) ?? [];
    const index = side === 'first' ? 0 : 1;
    return new Set(entries.map(entry => entry.split(':')[index]));
}

/**
 * tonto's plural nature names to the singular ones this table uses.
 * `objects` is absent by design: it expands to its three members first.
 */
// The two spellings, from the nature table that owns both.
export { TABLE_NATURE_NAMES, TONTO_NATURE_NAMES } from './natures.js';

/**
 * The (whole, part) nature pairs any parthood may take, stereotyped or not.
 *
 * A diamond states parthood on its own, and tonto lets it stand without a
 * stereotype -- which it must, since there is no stereotype for the
 * parthood of a relator, a quality or a mode. Those relations still cannot say
 * anything they like: parthood never crosses ontological natures. A part of an
 * event is an event, a part of a situation a situation, a part of a quality a
 * quality, and likewise for relators and for modes of either sort.
 *
 * Only the substantials are richer, and only because a collective admits
 * members that are not collectives. That is why this is derived rather than
 * written out: every crossing pair a stereotype allows comes from the table
 * itself, and the same-nature pairs are added for the natures no parthood
 * stereotype covers. A row added to the table above therefore widens this
 * with it, and cannot fall out of step.
 *
 * A process's parts are processes, and nothing else. What it gains from events
 * is its constitution, not its parts: "we reject (V4*), following Baker in
 * keeping parthood completely separate from constitution", so that a process
 * and the event constituting it share no part at all (Guarino & Guizzardi
 * 2024, §3.2, axiom A8). The temporal parts a process does have -- the Alps
 * crossing within the flight -- are themselves processes, and `process:process`
 * is already here among the same-nature pairs.
 */
export const PARTHOOD_NATURE_PAIRS: ReadonlySet<string> = new Set([
    ...[...PART_WHOLE_STEREOTYPES].flatMap(stereotype => RELATION_NATURE_TABLE[stereotype] ?? []),
    ...Object.values(TABLE_NATURE_NAMES).map(nature => `${nature}:${nature}`)
]);

/** The UFO categories, most specific first so a set gets its tightest name. */
const CATEGORIES: ReadonlyArray<readonly [string, readonly string[]]> = (() => {
    const substantial = SUBSTANTIAL;
    const aspect = ASPECT;
    const endurant = ENDURANT;
    return [
        ...['functional-complex', 'collective', 'quantity', 'relator', 'extrinsic-mode',
            'event', 'process', 'situation', 'type'].map(one => [one, [one]] as const),
        ['aspect that inheres in one bearer', ['intrinsic-mode', 'extrinsic-mode', 'quality']],
        ['substantial', substantial],
        ['aspect', aspect],
        ['perdurant', PERDURANT],
        ['endurant', endurant],
        // The two the signatures reach for that UFO has no one word for: what
        // has a life for an aspect to inhere in, and what is still unfolding
        // enough to be depended on.
        ['endurant or process', BEARER],
        ['endurant, process or situation', DEPENDABLE],
        ['concrete individual', CONCRETE],
        ['anything', EVERYTHING]
    ];
})();

function categoryOf(natures: Set<string>): string {
    const found = CATEGORIES.find(([, members]) =>
        members.length === natures.size && members.every(member => natures.has(member)));
    return found ? found[0] : [...natures].join('/');
}

/**
 * What a relation stereotype relates, as one line: `relator -> endurant`.
 *
 * Written from the signatures rather than from the pairs they expand to, so a
 * stereotype that takes more than one of them says so instead of being
 * flattened. Two do. `@characterization` has two because what may bear an
 * extrinsic mode is narrower than what may bear a quality, and reading its
 * pairs alone -- they are not a product of the two ends -- answered "both ends
 * in the same broad category", which is what `@constitution` does and the
 * opposite of what inherence is. `@constitution` is the closure itself, and
 * gets the sentence that describes one.
 */
export function signatureOf(stereotype: string): string {
    if (stereotype === 'constitution') {
        return 'constituted → constituent, within one category, and a process from the events constituting it';
    }
    if (!SIGNATURES[stereotype]) {
        return '';
    }
    return signaturesOf(stereotype)
        .map(([first, second]) => `${categoryOf(new Set(first))} \u2192 ${categoryOf(new Set(second))}`)
        .join('; ');
}

/**
 * The pairs a stereotype admits, grouped by what each group of first natures
 * may reach.
 *
 * The margins are not the table: the union of what `@characterization` runs
 * *from* and the union of what it runs *to* says an extrinsic mode may inhere
 * in a process, which the pairs deny. Printing the groups says only what is
 * there, and collapses to a single line for the twenty-one stereotypes whose
 * pairs are one product.
 */
export function pairGroups(stereotype: string): Array<{ from: string[]; to: string[] }> {
    const reached = new Map<string, string[]>();
    for (const pair of RELATION_NATURE_TABLE[stereotype] ?? []) {
        const [first, second] = pair.split(':');
        reached.set(first, [...(reached.get(first) ?? []), second]);
    }
    const groups = new Map<string, { from: string[]; to: string[] }>();
    for (const [first, seconds] of reached) {
        const key = [...seconds].sort().join(',');
        const group = groups.get(key);
        if (group) {
            group.from.push(first);
        } else {
            groups.set(key, { from: [first], to: seconds });
        }
    }
    return [...groups.values()];
}
