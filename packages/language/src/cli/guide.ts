import { PARTHOOD_NATURE_PAIRS, signatureOf, TABLE_NATURE_NAMES } from '../validation/relation-nature-table.js';
import { RELATION_STEREOTYPES } from '../validation/relation-stereotypes.js';
import { STEREOTYPES, SUGGESTED_CLASS_STEREOTYPES } from '../validation/stereotype-model.js';

/**
 * The language in one page, generated from the same tables the checks read.
 *
 * Written for something that has to hold the whole language in its context
 * before writing any of it -- a person new to tonto, or a model doing the
 * same job. That was not possible while the taxonomy was a hundred listed
 * edges and the end-nature table five hundred pairs; it is now six principles
 * and twenty-three category signatures, which fits.
 *
 * Everything here is read off the tables, so it cannot drift from what the
 * validator enforces.
 */

type Stereotype = keyof typeof STEREOTYPES;

const byKind = (kind: string): Stereotype[] => SUGGESTED_CLASS_STEREOTYPES
    .filter(stereotype => STEREOTYPES[stereotype].sortality === kind);

/**
 * The worked example, exported so a test can validate it: documentation that
 * does not parse is worse than none, and this is the first tonto anyone reads.
 */
export const SAMPLE = `/// Who buys what.
ontology sales

/// Someone who buys, or could.
kind Person
kind Product
role Customer specializes Person

relator Purchase {
    @mediation [1..*] -- [1] (const) Customer
    @mediation [0..*] -- [1] (const) Product
}

kind Order {
    @begin placedAt: const date
    @end closedAt: const date [0..1]
}

@material relation Customer [0..*] -- buys -- [1..*] Product derivedFrom Purchase
`;

export function guide(): string {
    const parthood = [...PARTHOOD_NATURE_PAIRS]
        .map(pair => pair.split(':'))
        .filter(([whole, part]) => whole !== part)
        .map(([whole, part]) => `${whole} → ${part}`);
    return `# tonto in one page

Generated from the tables the validator reads. Run \`tonto check <path>\` to
validate, \`--json\` for machine-readable diagnostics with their repairs.

## Shape of a file

${SAMPLE.trimEnd().split('\n').map(line => `    ${line}`).join('\n')}

This is a one-file ontology: its header, \`ontology sales\`, then its
declarations. One file, nothing else to set up. How an ontology grows into
packages and files, and how it imports others, is under *Ontologies, packages
and files*.

\`//\` is an ordinary comment. A run of \`///\` lines immediately above a
declaration is that declaration's documentation, which an editor shows on hover
and on the declaration's completion proposals. The run ends at the first line
that is not a \`///\` line, blank lines included.

A tag says the same thing in another language, or gives a display name:

    /// Someone who buys, or could.
    /// @label Customer
    /// @label:pt-br Cliente
    /// @pt-br Alguém que compra, ou poderia.
    role Customer specializes Person

Prose runs until the first tag; \`@<lang>\` stays open over the untagged lines
after it; \`@label\` is one line. \`label { }\` and \`description { }\` are the
older spelling of the same two things, and \`tonto check --fix=legacy-text-block\`
converts them.

## Ontologies, packages and files

Three words, each for one thing:

- An **ontology** is what is published and imported: one namespace, one
  version. It is declared by its header, \`ontology sales\`, in its
  **ontology file**. Every ontology has exactly one ontology file, and an
  import names it.
- A **package** is a named part of one ontology. It organizes the
  declarations and says which may refer to which. It is never published or
  imported on its own.
- A **file** only holds text. Nothing but an ontology header makes an
  ontology: not a folder, a file name, a shared namespace or a
  \`tonto.json\`. A package with no header above it and no \`in\` is an
  error, \`package-without-ontology\`.

Ontology and package names are lower case, a package's a segment at a time:
\`university.people\`.

### One file, or several

A small ontology is a **one-file ontology**: the header, then its
declarations, as above. It has no packages.

When it outgrows the file, the editor's *Split into an ontology file and
package* refactoring, on the header, moves the declarations into a
**package file** and leaves the header behind, now listing the ontology's
packages after \`bundles\`, each with the location of its package file:

    /// @namespace https://example.org/shop#
    ontology shop bundles
        core from <foundation/core.tonto>
        sales from <commerce/sales.tonto>

A package file says which ontology it is in, so it reads alone:

    package sales in shop
    use core
    role Customer specializes core.Person

Packages may also be written in the ontology file itself, after its header or
its \`bundles\` list; those need no \`in\`. An ontology file holds either
declarations or packages, never both. No folder layout is imposed, and no
public name changes when an ontology is split: importers name the ontology,
not its packages.

### Use a package, import an ontology

Packages are **used**; ontologies are **imported**.

Within one ontology, a package refers to another only through \`use\`, even in
one file. \`use core\` makes \`core.Person\` and \`Person\` available, and
\`use commerce.sales as sales\` adds a shorter qualifier. Identifiers are
unique across the whole ontology, used or not, because its packages share one
namespace.

Another ontology is imported by the location of its ontology file, under an
alias that qualifies its names:

    ontology clients
    import shop from <https://example.org/shop.tonto>
    subkind PreferredCustomer specializes shop.Customer

An importer sees the ontology's names, not its packages: \`shop.Customer\`,
however \`shop\` is divided. A \`use\` cannot reach a package of another
ontology, and a package file cannot be imported: import its ontology file.
\`import core\`, naming a package, is an error: write \`use core\`.

### Header, and the gUFO export

The \`///\` lines above the header describe the ontology. \`@namespace\` says
where its terms are published when it is exported to OWL -- an absolute IRI
ending in \`#\` or \`/\`. \`@version\`, \`@license\` and \`@creator\` (one line
each, the last repeatable) go into the exported header with its label and
prose:

    /// Who buys what.
    /// @label Sales
    /// @namespace https://w3id.org/shop/sales#
    /// @version 1.2.0
    /// @license https://creativecommons.org/licenses/by/4.0/
    /// @creator Ana Silva
    ontology sales

Every export of an ontology is written beside its ontology file and named
after the ontology, with its format's extension. The gUFO export is one
Turtle document per ontology, \`sales.ttl\`, with all its packages in its one
namespace; several ontologies are several documents, and nothing joins them. Publishing on the web needs a hash namespace (ending in
\`#\`); a slash namespace is accepted for a local RDF preview.

### The workspace and tonto.json

The **workspace** is the folder whose \`.tonto\` files are loaded and checked
together. It may hold several ontologies. \`tonto.json\` is its optional
settings file: its folder is a workspace root, in the editor as on the
command line, and its \`locations\` redirect import locations -- to a local
copy of a dependency, say. It never says which files make an ontology.

Builtin datatypes need no \`use\` or import. Checking never goes to the
network: run \`tonto fetch\` first. \`tonto fetch --publication\` and
\`tonto check --publication\` verify the original import locations with the
location mappings switched off.

## Class stereotypes

Ultimate sortal — supplies a principle of identity, tops its lineage, and no
two share an instance:
${byKind('ultimate-sortal').map(s => `  ${s} (${(STEREOTYPES[s].natures ?? []).filter(n => n !== 'objects').join(', ')})`).join('\n')}

Base sortal — specializes exactly one ultimate sortal:
${byKind('base-sortal').map(s => `  ${s} (${STEREOTYPES[s].rigidity})`).join('\n')}

Non-sortal — generalizes sortals, carries no identity of its own:
${byKind('non-sortal').map(s => `  ${s} (${STEREOTYPES[s].rigidity})`).join('\n')}

  class — states nothing; use \`of <natures>\` to say what it classifies

A class may be restricted with \`of\`: \`category Agent of functional-complexes\`.
\`isPowerType\` marks Cardelli's reading on a class restricted to types.

## Ontological natures

${Object.keys(TABLE_NATURE_NAMES).join(' · ')}

\`objects\` abbreviates functional-complexes, collectives and quantities.
A rigid type may classify anything; an anti-rigid one only endurants — nothing
outside them can stop being an instance and go on existing.

## What may specialize what

Six principles decide every case:

  1. A non-sortal takes no identity from a sortal.
  2. A rigid or semi-rigid type does not sit under an anti-rigid one.
  3. An ultimate sortal tops its lineage: it specializes no sortal.
  4. The two must share an ontological nature.
  5. Among anti-rigid types, only a relationally founded one (role, roleMixin)
     may narrow a differently founded one (phase, historicalRole).
  6. Anti-rigidity needs an individual that can change: an endurant, or a
     process, whose constitution varies in time.

A \`phase\` comes in a set: at least two, in a \`disjoint complete genset\`, and
that set holds phases and nothing else. A \`historicalRole\` holds because
something happened, so the event is named: its own \`@participation\`,
\`@creation\` or \`@termination\` in it, or a \`derivedFrom\` naming one written
where it happened (see Derived relations).

## Association stereotypes

Written \`@stereotype relation A [n] -- name -- [m] B\`, or inside a class body
with the source left out. Ends read source → target, except parthood, where
the diamond marks the whole.

Names are lower-camel-case verbal phrases read from source to target. A
modeled \`event\` has occurred, so name an \`@participation\` toward an event in
the past: \`Person -- delivered -- KeynoteSpeech\` or
\`Person -- participatedIn -- Conference\`. Do not write \`delivers\` or
\`participatesIn\`. A participation in a \`process\` may use the present when the
process may still be unfolding: \`Baker -- performs -- Baking\`.

${RELATION_STEREOTYPES.map(s => `  @${s.padEnd(20)} ${signatureOf(s)}`).join('\n')}

The three event-parthood stereotypes answer different decomposition criteria:

- \`@structural\` is for an event that belongs to the definition of the whole,
  such as a goal in a soccer match.
- \`@temporal\` is only for a maximal temporal segment projected from the whole
  by an external temporal scheme: a clock interval, a duration, or a temporal
  relation to another event. The portions of a day-long meeting before and
  after noon are temporal segments; an event part does not become
  \`@temporal\` merely because it occupies some of the whole's duration.
- \`@participational\` is for a maximal portion projected by exclusive
  dependence on one endurant, such as John's participation in a meeting. Its
  \`@participation\` relation has maximum \`1\` at the participant end; different
  participants determine disjoint portions under that criterion.

## Derived relations

A \`@material\` relation holds because an extrinsic aspect connects its ends:
usually a relator that binds both, or an extrinsic mode that inheres in one and
depends on the other. A \`@comparative\` relation holds because of the qualities
of what it relates. \`derivedFrom\` says which, after the target:

    @material relation Customer [0..*] -- buys -- [1..*] Product derivedFrom Purchase
    @comparative relation Person [0..*] -- tallerThan -- [0..*] Person derivedFrom Height

A material relation is derived from one relator that mediates both ends, or
from one extrinsic mode inhering in one and depending on the other; a
comparative one from qualities or intrinsic modes that characterize both. No
other relation is derived from anything. An inverse is the same association
read backwards, so when one material declaration names its ground, its inverse
need not repeat the \`derivedFrom\` clause.

With one exact mediation to each distinct end, the material multiplicities
are derived too. For \`R [rPerS] -- [sPerR] S\` and
\`R [rPerT] -- [tPerR] T\`, the \`S\`s per \`T\` are at most
\`rPerT * sPerR\`, and at least the lower bound of \`sPerR\` when a \`T\` must
have a relator (otherwise none): two relators may bind the same pair, so the
lower bounds do not multiply. The \`T\`s per \`S\` are derived the same way.
A written multiplicity no count could share with the derived one is an error;
one admitting counts the mediations rule out is a warning; a narrower one is a
constraint of the relation's own, and only noted.
When both material ends have the same type, two exact mediations distinguish
their roles: the mediation written first supplies the source, and the one
written later supplies the target -- crossed for the later of two inverse
declarations, which reads the same association backwards.

A historical role is derived the same way, from what happened. Name the
participation, creation or termination that makes one, written where it
happened, after what the role specializes:

    @participation relation Student (const) [1..*] -- graduatedIn -- [0..*] (addOnly) Graduation
    historicalRole Graduate specializes Person derivedFrom Student.graduatedIn

Naming the event, \`derivedFrom Graduation\`, is enough where only one such
relation reaches it, and a narrower event type is read for that type:
\`historicalRole BornInBrazil specializes Person derivedFrom BirthInBrazil\`
derives from a creation written into \`Birth\`. Only a historical role is
derived this way: what happened stays happened, so it never lapses.

## Parthood

The diamond states parthood and marks the whole: \`<>--\` puts it at the source,
\`--<>\` at the target. A parthood stereotype needs one. Whether a part may be
shared is the multiplicity at the whole end -- \`[1]\` or \`[0..1]\` says it may
not, and an omitted bound means \`[1]\`.
\`const\` at the part end says the whole cannot come to have a different part;
with a lower bound of one that is an *essential* part -- but only if the whole
is rigid. Under a \`role\` or a \`phase\` the same words say the part is fixed
while the individual plays it, which is an *immutable* part. \`const\` at the
whole end reads the other way round: inseparable, or immutable-whole.

A quantity is extensional -- change a part and it is a different portion -- so
every part of one is essential: the part end is \`const\`, there is exactly
one sub-quantity of a kind, and it is never shared. A collective has at most
one sub-collection of a kind; whether its *members* are essential is the
model's to say, by writing \`const\` at the member end or not.

Outside the substantials parthood does not cross natures; what does:

${parthood.map(pair => `  ${pair}`).join('\n')}

## Multiplicity and end decorators

\`[1]\` \`[0..1]\` \`[1..*]\` \`[*]\`; an omitted multiplicity means exactly one. Whether a part may be shared is the
multiplicity at the whole end. An end is written in parentheses: the flags first, then a name, then what it
draws from -- \`(const father)\`, \`(addOnly children)\`,
\`(staff subsets Team.members)\`. The flags are written in the order
\`const addOnly\`.

\`const\` says the link cannot change once set, and \`addOnly\` -- for an end
that holds more than one -- says the weaker thing: links may be added and never
removed, so the collection only grows -- which is what the events constituting
a process do. That the earlier is a *prefix* of the later is the stronger
claim the axiom makes, and one an end has no word for: \`ordered\` and
\`derived\` are attribute flags.

Two things require \`const\`. An end is a property of the classifier at the
*opposite* end, so an end belonging to an event or an abstract individual
cannot change, because they cannot. And
\`@characterization\`, \`@mediation\` and \`@externalDependence\` are existential
dependence: an aspect does not survive losing what it depends on, so it cannot
be re-pointed at something else. \`@historicalDependence\` is fixed for another
reason -- what it names has already happened.

## Attributes, and when an individual began

An attribute is \`name: modifiers Type [n]\`, the modifiers being \`ordered\`,
then \`const\` or \`addOnly\`, then \`derived\`, written in front of the type.
\`const\` and \`addOnly\` are alternatives: the first says nothing changes and
the second says nothing is taken away, so both is the second said twice. Two stereotypes may precede the name:

  @begin   the instant the individual began to exist
  @end     the instant it ceased to

They are for concrete individuals -- everything but the abstract ones, a
high-order \`type\` included, since a type is an endurant too. Both are
\`const\`: when something began does not change, and neither does when it
ended. \`@end\` is \`[0..1]\` on anything that may still be going on -- an
endurant that exists, a process unfolding, a situation obtaining -- and
\`[1]\` on an event, which has ended. Both stereotypes on one attribute says
the individual is instantaneous.

An event and a situation change in no other way either, so every intrinsic
property of one is \`const\`, and an aspect of one is not reified: what would
have been a \`quality\` or an \`intrinsicMode\` characterizing it is written as
those properties. A situation accumulates parts, which is \`addOnly\`. Outward
histories may accumulate too: what later stands in a situation, what it
triggers, or what an event brings about changes the world around the settled
individual, not that individual itself.

A value is the same: a datatype's attributes are its components, and an
address with another street is another address, so each is \`const\`.

Nothing requires them. A class that never says when its instances began is
well formed, and no check asks it to.
`;
}
