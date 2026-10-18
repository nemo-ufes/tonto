import type { AstNode, CstNode, Reference } from 'langium';
import { AstUtils, EmptyFileSystem, GrammarUtils, URI, isReference } from 'langium';
import { createTontoServices } from '../tonto-module.js';
import {
    isAttribute, isClassifier, isEnumLiteral, isGeneralizationSet, isRelation, isRelationEndMetaAttributes
} from '../generated/ast.js';
import { getRelationSource } from '../utils/relations.js';

/**
 * The modeling patterns, as models that run.
 *
 * A rule says what you may not write. A pattern says what to write instead --
 * and the two are the same catalog seen from opposite sides, so this file is
 * shaped like `rules.ts`: every entry is a model, `catalog()` validates all
 * of them, and a test fails if any stops being clean. A pattern that no longer
 * validates is a pattern that is no longer being recommended, which is exactly
 * the thing that goes stale silently in a document.
 *
 * Each is the smallest model that shows the pattern and nothing else. Together
 * they are also the strongest test the checks have: thirty-five models drawn
 * from the literature, every one of which the implementation must accept in
 * silence -- no error, no warning, not even a hint. A check that fires on a
 * textbook pattern is wrong about the pattern or wrong about itself.
 *
 * Sources are named per entry: Guizzardi's UFO, the multi-level theory of
 * Carvalho and Almeida, and gUFO, whose vocabulary several of
 * these are written to line up with.
 */
export interface PatternCase {
    /** Stable identifier, used by `tonto patterns <name>`. */
    name: string;
    group: string;
    title: string;
    /** What the pattern is for, in one line. */
    intent: string;
    /** What is easy to get wrong about it. */
    note: string;
    /** Where it comes from. */
    source: string;
    model: string;
}

export interface Pattern extends PatternCase {
    example: string;
    /** Anything the validator said about the model; expected to be empty. */
    diagnostics: string[];
}

/** Every pattern is written against these, so no entry declares its own. */
const PREAMBLE = 'datatype string\ndatatype date\ndatatype number';

const CASES: ReadonlyArray<readonly [string, string, string, string, string, string, string]> = [
['kind-and-subkind', 'Identity and taxonomy', 'A kind and the rigid subdivisions of it',
 'What every instance is, and rigid specializations whose instances never leave them.',
 'Treat `MountainBike` and `RoadBike` as design kinds: each bicycle is one for its whole existence. If a bicycle may move in or out of a classification through modification or use, that classification is a phase or a role, not a subkind. The two subkinds are not marked complete; other kinds of bicycle may exist.',
 'Guizzardi 2005, ch. 4 (sortals and rigidity); OntoUML "Subkind"',
 `kind Bicycle
subkind MountainBike specializes Bicycle
subkind RoadBike specializes Bicycle`],

['phase-partition', 'Identity and taxonomy', 'Phases, and the partition they make',
 'The stages of something’s life, each holding while an intrinsic condition does.',
 'The condition is intrinsic -- age, temperature, marital status held as a property of the thing itself. Phases come in sets: something in one stage is in exactly one, so the set is disjoint and complete.',
 'Guizzardi 2005, §4.3 (anti-rigid sortals); gUFO "Phase"',
 `kind Person
phase Child specializes Person
phase Adult specializes Person
disjoint complete genset lifeStages where Child, Adult specializes Person`],

['role-and-relator', 'Relators and roles', 'A role, and the relator that founds it',
 'A type something is only while it stands in a relationship.',
 'This is the pattern that explains roles: a role is anti-rigid because the relator that founds it can cease to exist. Every role should have a relator behind it -- if you cannot name one, what you have is a phase or a subkind. Read the two ends in opposite directions: the mediated end is `[1]` and `(const)`, since one employment binds one employee and cannot be moved to another; the relator end is `[1..*]`, since being founded means at least one, and nothing stops a person holding two jobs. A `[1]` there would say they cannot.',
 'Guizzardi 2005, §4.4; Guizzardi et al. 2018 (UFO relators); OntoUML "Relator" pattern',
 `kind Person
kind Organization
role Employee specializes Person
role Employer specializes Organization
relator Employment {
    @mediation [1..*] -- [1] (const) Employee
    @mediation [1..*] -- [1] (const) Employer
}`],

['role-mixin', 'Relators and roles', 'A role over more than one kind',
 'One role played by things of different kinds, which supply different identity principles.',
 'A `role` specializes exactly one ultimate sortal, so a role that people *and* organizations play cannot be one. The `roleMixin` carries the relational condition; a role under each kind carries the identity.',
 'Guizzardi 2005, §4.5 (non-sortals); OntoUML "RoleMixin" pattern',
 `kind Person
kind Organization
roleMixin Customer of functional-complexes
role PersonalCustomer specializes Person, Customer
role CorporateCustomer specializes Organization, Customer
disjoint complete genset customerKinds where PersonalCustomer, CorporateCustomer specializes Customer
kind Product
relator Purchase {
    @mediation [1..*] -- [1] (const) Customer
    @mediation [0..*] -- [1] (const) Product
}`],

['category', 'Identity and taxonomy', 'A category over several kinds',
 'Properties shared by things that do not share a principle of identity.',
 'Rigid and non-sortal: everything it classifies is one for as long as it exists, but it supplies no identity of its own. Attributes common to several kinds belong here.',
 'Guizzardi 2005, §4.5; gUFO "Category"',
 `category Party of functional-complexes {
    name: string
}
kind Person specializes Party
kind Organization specializes Party`],

['mixin', 'Identity and taxonomy', 'A mixin, essential to some and accidental to others',
 'A property that is part of what some things are, and a passing condition for others.',
 'Semi-rigid: the one non-sortal that is neither rigid nor anti-rigid. Reach for it only when both readings are genuinely present -- otherwise a category or a roleMixin says more.',
 'Guizzardi 2005, §4.5 (semi-rigidity)',
 `mixin Insurable of functional-complexes
kind Boat specializes Insurable
kind Vehicle
phase InsuredVehicle specializes Vehicle, Insurable
phase UninsuredVehicle specializes Vehicle
disjoint complete genset insuranceStatus where InsuredVehicle, UninsuredVehicle specializes Vehicle`],

['quality', 'Aspects', 'A quality and its bearer',
 'Something measurable that exists only because its bearer does.',
 'The characterization is existential dependence, so the bearer end is `[1]` and `(const)`: a weight cannot change whose weight it is.',
 'Guizzardi 2005, ch. 8 (qualities and quality structures); gUFO "Quality"',
 `kind Person
quality Weight {
    @characterization [1] -- [1] (const) Person
    value: number
}`],

['intrinsic-mode', 'Aspects', 'An intrinsic mode',
 'An aspect that is not measurable on a scale: a skill, a belief, a symptom.',
 'A mode is an aspect with no quality structure behind it. If what you are modeling has a value space, it is a quality.',
 'Guizzardi 2005, ch. 8; gUFO "IntrinsicMode"',
 `kind Person
intrinsicMode Skill {
    @characterization [0..*] -- [1] (const) Person
}`],

['extrinsic-mode', 'Aspects', 'An extrinsic mode',
 'An aspect of one thing that depends on another: a love, a debt, an intention.',
 'Two dependences, and they are different: `@characterization` names whose it is, `@externalDependence` names what else it needs. Both ends are `(const)`.',
 'Guizzardi et al. 2018 (externally dependent modes); gUFO "ExtrinsicMode"',
 `kind Person
extrinsicMode Love {
    @characterization [0..*] -- [1] (const) Person
    @externalDependence [0..*] -- [1] (const) Person
}`],

['constitution', 'Matter and parts', 'Constitution',
 'What something is made of, which is not the same thing as what it is.',
 'The statue and the clay have different identity principles and different persistence conditions: reshape the clay and the statue is gone while the clay remains. Constitution, not parthood, and not specialization -- and `@constitution` says so, which an unstereotyped association between the two would not. It runs from what is constituted to what constitutes it, as a process runs to the events constituting it. The statue end is `[0..1]`: a portion of clay constitutes at most one statue, and most of it constitutes none.',
 'Guizzardi 2005, §5.4 (constitution); Wiggins 1980',
 `kind Statue
quantity PortionOfClay
@constitution relation Statue [0..1] -- isConstitutedOf -- [1] PortionOfClay`],

['component-parthood', 'Matter and parts', 'Components of a functional complex',
 'Parts that play a distinct role in the whole.',
 'Weak supplementation: a whole has at least two parts, or the part is the whole under another name. A car with only an engine modeled is a car that is an engine.',
 'Guizzardi 2005, ch. 5 (mereology); Simons 1987 (weak supplementation)',
 `kind Car {
    @componenthood [1] <>-- [1] Engine
    @componenthood [1] <>-- [4] Wheel
}
kind Engine
kind Wheel`],

['member-parthood', 'Matter and parts', 'Members of a collective',
 'A collective and the individuals that make it up.',
 'The members are uniform in their contribution -- unlike components, no member plays a distinct role. A collective is not a set: it endures while its members change.',
 'Guizzardi 2005, §5.3 (collectives); gUFO "Collection"',
 `collective Orchestra {
    @membership [1] <>-- [2..*] (members) Musician
}
kind Musician`],

['subcollection', 'Matter and parts', 'A sub-collection of a collective',
 'A part of a collective that is itself a collective.',
 'The string section is part of the orchestra and is itself a collective; a musician is a member. The two are different relations, which is why tonto names them separately. The membership is written once, at the sections: a member of a sub-collection is a member of the collection it is part of, so the orchestra has musicians in it without saying so again.',
 'Guizzardi 2005, §5.3',
 `kind Musician
collective Orchestra {
    @subCollection [1] <>-- [1] StringSection
    @subCollection [1] <>-- [1] BrassSection
}
collective StringSection {
    @membership [1] <>-- [2..*] (members) Musician
}
collective BrassSection {
    @membership [1] <>-- [2..*] (members) Musician
}`],

['subquantity', 'Matter and parts', 'A sub-quantity of a quantity',
 'A portion of matter that is part of a larger portion.',
 'Quantities are maximally self-connected portions: the alcohol in the wine is a sub-quantity, and removing it leaves a different portion of wine.',
 'Guizzardi 2005, §5.2 (quantities)',
 `quantity Wine {
    @subQuantity [1] <>-- [1] (const) Alcohol
    @subQuantity [1] <>-- [1] (const) Water
}
quantity Alcohol
quantity Water`],

['event-participation', 'Events and situations', 'Participation in an event',
 'The objects that take part in something that happened.',
 'An event is over, so its participants are fixed: the participant end is `(const)`, and the relation name reads in the past (`marriedIn`, not `marriesIn`). The person’s history may still gain later events, so the event end is `(addOnly)`. The instants are `const` for the same reason as the participants — an attribute wears the word without parentheses.',
 'Guizzardi et al. 2013 (UFO-B); gUFO `participatedIn`',
 `kind Person
event Wedding {
    @begin startedAt: const date
    @end finishedAt: const date
}
@participation relation Person (const) [2] -- marriedIn -- [0..*] (addOnly) Wedding`],

['event-properties', 'Events and situations', 'What an event has to say about itself',
 'The qualities of something that has happened, recorded rather than reified.',
 'An aspect is reified for what has a life to bear it: the endurants, and processes, which are fast now and slow later. An event is over, and a situation, insofar as it obtains, is fact-like \u2014 what varies about a situation is whether it obtains, not what it is \u2014 so a "@characterization" pointed at either is refused and what it wanted is written as properties instead -- "const", because nothing about an event changes, and "@end" at "[1]", because an event has ended.',
 'Guizzardi et al. 2013 (UFO-B); Guarino & Guizzardi 2024 on what bears an aspect',
 `kind Person
event Wedding {
    @begin startedAt: const date
    @end finishedAt: const date [1]
    guestCount: const number
    cost: const number
}
@participation relation Person (const) [2..*] -- participatedIn -- [0..*] (addOnly) Wedding`],

['event-parthood', 'Events and situations', 'The parts of an event',
 'An event decomposed into the events that make it up.',
 'Use `@structural` when the part belongs to the definition of the whole. Do not use `@temporal` merely because a part occupies some of the whole’s duration: that stereotype is reserved for a maximal segment projected by an external temporal scheme. An event cannot change the whole it is part of.',
 'Guizzardi et al. 2013 (UFO-B)',
 `kind Person
event Wedding {
    @structural (const) [1] <>-- [2..*] (const) VowExchange
}
event VowExchange
@participation relation Person (const) [1] -- vowedIn -- [0..*] (addOnly) VowExchange`],

['temporal-event-segmentation', 'Events and situations', 'Temporal segments projected from an event',
 'An event divided by an external temporal frame of reference.',
 'Use `@temporal` only for maximal segments projected by a clock interval, duration, or temporal relation to another event. Here the two segment instances are the portions of a day-long meeting before and after noon. They are disjoint and maximal under that scheme; an ordinary constituent event belongs under `@structural` instead.',
 'Guizzardi et al. 2013 (UFO-B)',
 `kind Person
event Meeting {
    @temporal (const) [1] <>-- [2] (const) NoonDelimitedSegment
}
event NoonDelimitedSegment
@participation relation Person (const) [1..*] -- attended -- [0..*] (addOnly) NoonDelimitedSegment`],

['participational-event-decomposition', 'Events and situations', 'An event portion determined by one participant',
 'An event divided into maximal portions that depend exclusively on individual participants.',
 'Use `@participational` for a maximal portion projected by dependence on one endurant. The participant end of the portion’s `@participation` is exactly `[1]`: the whole meeting may have many participants, but each attendee participation depends exclusively on one of them. Portions determined by different participants are disjoint under this criterion.',
 'Guizzardi et al. 2013 (UFO-B)',
 `kind Person
event Meeting {
    @participational (const) [1] <>-- [2..*] (const) AttendeeParticipation
}
event AttendeeParticipation
@participation relation Person (const) [1] -- attended -- [0..*] (addOnly) AttendeeParticipation`],

['creation-termination', 'Events and situations', 'What created something, and what ended it',
 'The events at the two edges of an endurant’s life.',
 'The direction matches gUFO’s `wasCreatedIn` and `wasTerminatedIn`: from the endurant to the event. One `Death` terminates one `Person`, so the person end is `[1]`. The termination event end is `[0..1]` -- someone still living has not been terminated.',
 'gUFO `wasCreatedIn` / `wasTerminatedIn`; Guizzardi et al. 2013',
 `kind Person
event Birth
event Death
@creation relation Person (const) [1] -- wasCreatedIn -- [1] (const) Birth
@termination relation Person (const) [1] -- wasTerminatedIn -- [0..1] (addOnly) Death`],

['situation-causation', 'Events and situations', 'A situation triggers an event, which brings one about',
 'Causation, written as the chain UFO-B actually posits.',
 'Events do not cause events directly: a situation obtains, it triggers an event, the event brings about a new situation, and that one triggers the next. Modeling event-to-event causation skips the state of the world that made it happen. Both the triggered and the brought-about ends are `[0..1]`: a situation may obtain and nothing follow -- terms settle and the deal collapses -- and an event may fail, so a signing that happened need not have brought the contract into force. What is `[1]` is the other side of each: an event is triggered by the situation that obtained, and a contract in force came into force through one signing.',
 'Guizzardi et al. 2013 (UFO-B, causation); gUFO `triggers` / `broughtAbout`',
 `kind Party
situation TermsSettled
situation ContractInForce
event Signing {
    @bringingAbout (const) [1] -- [0..1] (addOnly) ContractInForce
}
@participation relation Party (const) [2..*] -- signed -- [0..*] (addOnly) Signing
@triggering relation TermsSettled (const) [1] -- triggers -- [0..1] (addOnly) Signing`],

['historical-role', 'Relators and roles', 'A historical role',
 'A type something belongs to forever, because of something that happened.',
 'Anti-rigid but not reversible: nothing stops being a former student. That is what separates it from a role, and why a phase cannot sit above one. What makes it hold is something that happened, so the event is named -- tonto asks for the participation outright.',
 'Guizzardi et al. 2018 (historical roles); gUFO "HistoricalRole"',
 `kind Person
role Student specializes Person
historicalRole FormerStudent specializes Person {
    @participation (const) [0..*] -- [1] Graduation
}
event Graduation
kind Course
relator Enrollment {
    @mediation [1..*] -- [1] (const) Student
    @mediation [0..*] -- [1] (const) Course
}`],

['historical-role-derived', 'Relators and roles', 'A historical role derived from what happened',
 'A type something belongs to forever because of how it took part in an event, written where it took part.',
 'The participation in a graduation remains true after the person ceases to be a student, so its source is the rigid `Person`. The historical role is derived from that participation: a graduate is a person who graduated. It never lapses -- the graduation does not stop having happened -- which is why the gUFO export writes it as a definition, `Graduate \u2261 Person \u2293 \u2203graduatedIn.Graduation`, where a role founded by a relator gets only a necessary condition. Student status at the time of the event is a separate temporal claim.',
 'Guizzardi et al. 2018 (historical roles)',
 `kind Person
role Student specializes Person
kind University
relator Enrollment {
    @mediation [1..*] -- [1] (const) Student
    @mediation [0..*] -- [1] (const) University
}
event Graduation
@participation relation Person (const) [1..*] -- graduatedIn -- [0..*] (addOnly) Graduation
historicalRole Graduate specializes Person derivedFrom Person.graduatedIn`],

['historical-role-from-creation', 'Relators and roles', 'A historical role founded by how something came to be',
 'A type something belongs to because of the event it was created in.',
 'Being born in Brazil is a historical role founded by a birth that took place in Brazil. The creation is written once, into `Birth`; naming the narrower event type derives the role from the births that are births in Brazil. `@termination` founds a historical role the same way.',
 'Guizzardi et al. 2018 (historical roles); gUFO `wasCreatedIn`',
 `kind Person
event Birth
subkind BirthInBrazil specializes Birth
@creation relation Person (const) [1] -- wasBornIn -- [1] (const) Birth
historicalRole BornInBrazil specializes Person derivedFrom BirthInBrazil`],

['material-derivation', 'Relators and roles', 'A material relation and the relator it derives from',
 'The relationship people actually name, and what makes it hold.',
 '`worksFor` is true of an employee and an organization *because* an employment mediates them. The material relation is derived, and `derivedFrom Employment` says from what -- which the model has to say, since a contract could bind the same two. The relator is what carries the properties -- the salary, the start date, the terms.',
 'Guizzardi 2005, §4.4 (derivation); OntoUML "Derivation" pattern; gUFO, `isDerivedFrom`',
 `kind Person
role Employee specializes Person
kind Organization
relator Employment {
    @mediation [1] -- [1] (const) Employee
    @mediation [0..*] -- [1] (const) Organization
}
@material relation Employee [0..*] -- worksFor -- [1] Organization derivedFrom Employment`],

['comparative', 'Aspects', 'A comparative relation',
 'A relation that holds purely in virtue of the qualities of what it relates.',
 'Nothing is reified: one person is taller than another because of their heights, and `derivedFrom Height` names the quality that decides it. This is the honest form of what people often draw as an unstereotyped association.',
 'Guizzardi 2005, ch. 8; gUFO, `isDerivedFrom`',
 `kind Person
quality Height {
    @characterization [1] -- [1] (const) Person
    value: number
}
@comparative relation Person [0..*] -- tallerThan -- [0..*] Person derivedFrom Height`],

['powertype-cardelli', 'Multi-level', 'A power type in Cardelli’s sense',
 'A high-order type whose instances are *every* specialization of a base type.',
 '`isPowerType` says the type holds every specialization of its base, the base included -- which is why the instantiation end is `[1..*]`. Each specialization states its classification explicitly with `instanceOf`. `isPowerType` is a modifier, not a stereotype: what the class is stays open.',
 'Cardelli 1988; Carvalho & Almeida 2016 (MLT), §4',
 `kind Person
type PersonType isPowerType
@instantiation relation Person [1..*] -- [1..*] PersonType
subkind Man (instanceOf PersonType) specializes Person`],

['categorization-odell', 'Multi-level', 'Categorization in Odell’s sense',
 'A high-order type whose instances are the specializations one criterion picks out.',
 'The criterion is what makes it Odell’s rather than Cardelli’s: `PersonBySex` holds `Man` and `Woman` and nothing else. The generalization set names it as its categorizer, and being disjoint and complete makes it a partition.',
 'Odell 1994; Carvalho & Almeida 2016 (MLT), §5 (categorization)',
 `kind Person
type PersonBySex
subkind Man (instanceOf PersonBySex) specializes Person
subkind Woman (instanceOf PersonBySex) specializes Person
disjoint complete genset bySex {
    general Person
    categorizer PersonBySex
    specifics Man, Woman
}`],

['phase-mixin', 'Identity and taxonomy', 'A phase over more than one kind',
 'One condition holding of things with different identity principles.',
 'The phaseMixin plays for phases the part the roleMixin plays for roles: the condition is shared, the identity is not, so a phase under each kind carries the identity and each set of phases still partitions its own kind.',
 'Guizzardi 2005, §4.5; OntoUML "PhaseMixin"',
 `kind Person
kind Organization
phaseMixin Active of functional-complexes
phase ActivePerson specializes Person, Active
phase RetiredPerson specializes Person
phase ActiveOrganization specializes Organization, Active
phase ClosedOrganization specializes Organization
disjoint complete genset personStatus where ActivePerson, RetiredPerson specializes Person
disjoint complete genset organizationStatus where ActiveOrganization, ClosedOrganization specializes Organization
disjoint complete genset activeThings where ActivePerson, ActiveOrganization specializes Active`],

['process-and-its-events', 'Events and situations', 'A process, and the events that constitute it',
 'Something that is going on: it has properties now, and they change as it goes.',
 'A process is not a kind of event. It is constituted by events -- "at each time, a process is constituted by a certain series of events" -- and that constitution varies as it goes on, which is what its changing consists in, the way a statue is constituted by different matter at different times. So it takes phases, and bears qualities; but it is not an endurant, so no relator mediates it and no material relation reaches it. Its parts are other processes, never the events constituting it: parthood and constitution are kept apart. What constitutes it accumulates -- `(addOnly)` is axiom A7, the earlier constitution a prefix of the later. Participation says who performs it; do not restate that as historical dependence.',
 'Guarino & Guizzardi, "Processes as variable embodiments", Synthese 203:104 (2024), \u00a73 and \u00a75.3',
 `kind Person
process Baking {
    @begin startedAt: const date
    @end finishedAt: const date [0..1]
    @constitution (const) [1] -- [1..*] (addOnly) Kneading
}
event Kneading
phase Ongoing specializes Baking
phase Complete specializes Baking
disjoint complete genset stages where Ongoing, Complete specializes Baking
@participation relation Person (addOnly) [1..*] -- performs -- [0..*] (addOnly) Baking`],

['historical-dependence', 'Events and situations', 'Historical dependence',
 'Something that could not exist unless something else had.',
 'Not existential dependence: the oven need not still exist for the baking to have depended on it. Both ends follow from the same thing, that what is named is in the past. The depended-on end is `(const)`: the baking cannot come to have taken place in a different oven. And the dependent end is `(addOnly)`: the oven gains bakings and never loses one, since a baking that took place in it does not stop having taken place in it.',
 'gUFO `historicallyDependsOn`; Guizzardi et al. 2013',
 `kind Baker
kind Oven
event Kneading
process Baking {
    @constitution (const) [1] -- [1..*] (addOnly) Kneading
}
@participation relation Baker (addOnly) [1..*] -- performs -- [0..*] (addOnly) Baking
@historicalDependence relation Baking (addOnly) [0..*] -- tookPlaceIn -- [1] (const) Oven`],

['quality-value-space', 'Aspects', 'A quality and the space its values come from',
 'The values a quality takes, as a datatype or an enumeration.',
 'The quality is the individual aspect; its value is an abstract individual in a quality structure. Reifying the quality is what lets it be talked about -- compared, dated, sourced -- rather than just recorded.',
 'Guizzardi 2005, §8.2 (quality structures and quale); gUFO `QualityValue`',
 `enum ColorName {
    red, green, blue
}
kind Apple
quality Color {
    @characterization [1] -- [1] (const) Apple
    name: ColorName
}`],

['structured-datatype', 'Values', 'A structured datatype',
 'A value with parts, which is not an individual in the domain.',
 'An address is not a thing with a life: two addresses with the same fields are the same address. That is the test -- if it has no identity beyond its values, it is a datatype. It is also why every field is `const`: an address with another street is another address, not the same one changed. What changes is which address a person has, which is why `address` on `Person` is not.',
 'Guizzardi 2005, §8.3',
 `datatype Address {
    street: const string
    city: const string
}
kind Person {
    address: Address [0..1]
}`],

['nature-restricted-class', 'Values', 'Saying what a class classifies',
 'Non-sortals over what happens, which no stereotype can say on its own.',
 'A `category` may classify anything, so it says nothing on its own about what it classifies: the `of` clause does. '
 + 'A disruption is either something that happens or a state that obtains, and both are here beneath it -- a fire and '
 + 'an outage are not the same sort of individual at all. An incident is narrower, always an event, and the second '
 + '`of` says exactly that. None of it can be spelled another way: `event` and `situation` are ultimate sortals, so '
 + 'neither non-sortal can be one, and `role` and `phase` are out because an event does not stop being that event.',
 'Guizzardi et al. 2018 (ontological natures)',
 `kind Vehicle
category Disruption of events, situations
category Incident of events specializes Disruption
event Collision specializes Incident
event Fire specializes Incident
situation Outage specializes Disruption
@participation relation Vehicle (const) [1..*] -- involvedIn -- [0..*] (addOnly) Incident`],

['high-order-ladder', 'Multi-level', 'Orders, one instantiating the next',
 'The ladder biology climbs: an animal, the species it belongs to, and the rank that species is.',
 'MLT is stratified: an instance of an order-n type is an order-(n-1) type, and the biological taxonomy is where the '
 + 'three rungs are hardest to argue with. Cecil is a lion; `Lion` is a species; `Species` is a taxonomic rank, '
 + 'alongside `Genus` and the rest. Cecil is not in the model and cannot be -- tonto declares types, and an individual '
 + 'lion is what `Lion` classifies. Each `instanceOf` states one rung, and the checks keep the ladder straight: an '
 + 'order cannot instantiate itself, and what classifies types must be one.',
 'Carvalho & Almeida 2016 (MLT), §3 (basic types and orders); the biological taxonomy is MLT’s running example',
 `type TaxonomicRank
type Species (instanceOf TaxonomicRank)
type Genus (instanceOf TaxonomicRank)
kind Lion (instanceOf Species)`],
];

export const PATTERNS: PatternCase[] = CASES.map(([name, group, title, intent, note, source, model]) =>
    ({ name, group, title, intent, note, source, model }));

export const PATTERN_GROUPS: string[] = [...new Set(PATTERNS.map(pattern => pattern.group))];

/**
 * What to say when no pattern has the name asked for.
 *
 * An agent asks by the name it knows -- `componentOf`, OntoUML's, for what
 * is `component-parthood` here -- and was told to call again without a name,
 * which is the whole catalog: some seven thousand tokens to find one name.
 * In a live evaluation it did not, and went on without the pattern. So the
 * answer names the closest patterns, by the words of their names and the
 * relation stereotypes their models use, and then every name, on one line.
 */
export function missingPattern(name: string, patterns: readonly PatternCase[] = PATTERNS): string {
    const words = (text: string): string[] => text
        .replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
        .split(/[^a-z0-9]+/).filter(word => word.length >= 3 && !['and', 'the', 'its'].includes(word));
    const asked = words(name);
    const meets = (word: string, token: string): boolean => word.length >= 4 && token.length >= 4
        && (token.includes(word) || word.includes(token));
    // Ties go in catalog order, which runs from the common to the rare.
    const scored = patterns.map((pattern, index) => {
        const own = words(pattern.name);
        const stereotypes = [...pattern.model.matchAll(/@([A-Za-z]+)/g)].map(match => match[1].toLowerCase());
        const score = asked.reduce((sum, word) => sum
            + (own.some(token => meets(word, token)) ? 2 : 0)
            + (stereotypes.some(token => meets(word, token)) ? 1 : 0), 0);
        return { name: pattern.name, score, index };
    }).filter(one => one.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, 3);
    return `No pattern "${name}".`
        + (scored.length > 0 ? ` Closest: ${scored.map(one => one.name).join(', ')}.` : '')
        + ` All ${patterns.length}: ${patterns.map(pattern => pattern.name).join(', ')}.`;
}

/** Escape source that is literal in a VS Code/LSP snippet. */
function escapeSnippetText(text: string): string {
    return text.replace(/[\\$}]/g, character => `\\${character}`);
}

interface Occurrence {
    start: number;
    end: number;
}

interface PatternSymbol {
    occurrences: Occurrence[];
}

const PATTERN_SNIPPETS = new Map<string, Promise<string>>();

/**
 * The complete pattern as an editor snippet.
 *
 * Tab stops follow symbols, not spelling: changing the `Employee` declaration
 * also changes references to it, while two unrelated ends both called
 * `members` remain independently editable. The model is parsed and linked by
 * the language itself, so the CLI example, MCP result and editor insertion
 * cannot quietly acquire different ideas of what one name denotes.
 */
export function patternSnippet(pattern: PatternCase): Promise<string> {
    const key = `${pattern.name}\0${pattern.model}`;
    let snippet = PATTERN_SNIPPETS.get(key);
    if (!snippet) {
        snippet = buildPatternSnippet(pattern);
        PATTERN_SNIPPETS.set(key, snippet);
    }
    return snippet;
}

/**
 * Why a complete pattern cannot be inserted at this offset, or `undefined`
 * when it can. A pattern is a run of declarations, so it goes where
 * declarations go: after a `package` line, or after an `ontology` header with
 * no `bundles` list (a one-file ontology), and never inside a declaration's
 * braces. Read from the text rather than the parse, which a half-written
 * document may not have.
 */
export function patternInsertionProblem(source: string, offset: number): string | undefined {
    const header = /^[ \t]*(?:(?:global[ \t]+)?package[ \t]+[A-Za-z_][\w.-]*(?:[ \t]+in[ \t]+[A-Za-z_]\w*)?|(ontology)[ \t]+[A-Za-z_]\w*(?:[ \t]+(bundles)\b.*)?)(?:[ \t]*\/\/.*)?[ \t]*\r?$/gm;
    const last = [...source.slice(0, offset).matchAll(header)].filter(match => isTopLevel(source, match.index)).at(-1);
    if (!last) {
        return 'Write the ontology or package declaration before inserting a modeling pattern.';
    }
    const bundled = last[2] !== undefined
        || (last[1] !== undefined && /^\s*bundles\b/.test(withoutComments(source.slice(last.index + last[0].length, offset))));
    if (bundled) {
        return 'This ontology file only lists its packages. Insert the pattern in one of them.';
    }
    if (!isTopLevel(source, offset)) {
        return 'A complete modeling pattern belongs between declarations, not inside a declaration body.';
    }
    return undefined;
}

function withoutComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, '');
}

/**
 * Braces are the language's declaration-level boundary. Ignore the braces that
 * documentation, ordinary comments and legacy strings may contain.
 */
function isTopLevel(source: string, offset: number): boolean {
    let depth = 0;
    let lineComment = false;
    let blockComment = false;
    let string = false;

    for (let i = 0; i < offset; i++) {
        const current = source[i];
        const next = source[i + 1];
        if (lineComment) {
            if (current === '\n') lineComment = false;
            continue;
        }
        if (blockComment) {
            if (current === '*' && next === '/') {
                blockComment = false;
                i++;
            }
            continue;
        }
        if (string) {
            if (current === '"' && source[i - 1] !== '\\') string = false;
            continue;
        }
        if (current === '/' && next === '/') {
            lineComment = true;
            i++;
        } else if (current === '/' && next === '*') {
            blockComment = true;
            i++;
        } else if (current === '"') {
            string = true;
        } else if (current === '{') {
            depth++;
        } else if (current === '}') {
            depth--;
        }
    }
    return depth === 0 && !blockComment && !string;
}

async function buildPatternSnippet(pattern: PatternCase): Promise<string> {
    const services = createTontoServices(EmptyFileSystem);
    const prefix = `ontology snippet\n${PREAMBLE}\n`;
    const source = `${prefix}${pattern.model}\n`;
    const document = services.shared.workspace.LangiumDocumentFactory.fromString(
        source, URI.parse(`file:///snippet-${pattern.name}.tonto`));
    services.shared.workspace.LangiumDocuments.addDocument(document);
    await services.shared.workspace.DocumentBuilder.build([document]);

    const modelStart = prefix.length;
    const modelEnd = modelStart + pattern.model.length;
    const symbols = new Map<AstNode, PatternSymbol>();
    const nodes = [document.parseResult.value, ...AstUtils.streamAllContents(document.parseResult.value)];

    for (const node of nodes) {
        if (!isEditablePatternSymbol(node)) continue;
        const name = GrammarUtils.findNodeForProperty(node.$cstNode, 'name');
        const occurrence = inPattern(name, modelStart, modelEnd);
        if (occurrence) symbols.set(node, { occurrences: [occurrence] });
    }
    for (const node of nodes) {
        for (const reference of referencesOf(node)) {
            const target = reference.ref;
            const occurrence = inPattern(reference.$refNode, modelStart, modelEnd);
            if (!target || !occurrence) continue;
            const text = pattern.model.slice(occurrence.start, occurrence.end);
            const dot = text.lastIndexOf('.');
            if (dot < 0) {
                symbols.get(target)?.occurrences.push(occurrence);
                continue;
            }
            // `Student.graduatedIn` names two symbols: the relation, by its
            // last segment, and the class it is read from, by the one before.
            // Replacing the whole of it with the relation's name lost the
            // class, and renaming the class left the reference behind.
            symbols.get(target)?.occurrences.push({ start: occurrence.start + dot + 1, end: occurrence.end });
            const source = isRelation(target) ? getRelationSource(target) : undefined;
            const before = text.lastIndexOf('.', dot - 1);
            const owner = source && symbols.get(source);
            if (owner && text.slice(before + 1, dot) === source.name) {
                owner.occurrences.push({ start: occurrence.start + before + 1, end: occurrence.start + dot });
            }
        }
    }

    const ordered = [...symbols.values()]
        .map(symbol => ({
            ...symbol,
            occurrences: [...new Map(symbol.occurrences.map(one => [`${one.start}:${one.end}`, one])).values()]
                .sort((a, b) => a.start - b.start)
        }))
        .sort((a, b) => a.occurrences[0].start - b.occurrences[0].start);
    const replacements = ordered.flatMap((symbol, symbolIndex) =>
        symbol.occurrences.map((occurrence, occurrenceIndex) => ({
            ...occurrence,
            replacement: occurrenceIndex === 0
                ? `\${${symbolIndex + 1}:${escapeSnippetText(pattern.model.slice(occurrence.start, occurrence.end))}}`
                : `\${${symbolIndex + 1}}`
        }))).sort((a, b) => a.start - b.start);

    let offset = 0;
    let result = '';
    for (const replacement of replacements) {
        result += escapeSnippetText(pattern.model.slice(offset, replacement.start));
        result += replacement.replacement;
        offset = replacement.end;
    }
    // An explicit final stop keeps traversal inside one pattern predictable
    // instead of leaving each editor to infer where snippet mode should end.
    return result + escapeSnippetText(pattern.model.slice(offset)) + '$0';
}

function isEditablePatternSymbol(node: AstNode): boolean {
    return isClassifier(node) || isAttribute(node) || isEnumLiteral(node)
        || isGeneralizationSet(node) || isRelation(node) || isRelationEndMetaAttributes(node);
}

function inPattern(node: CstNode | undefined, start: number, end: number): Occurrence | undefined {
    if (!node || node.offset < start || node.end > end) return undefined;
    return { start: node.offset - start, end: node.end - start };
}

function referencesOf(node: AstNode): Reference[] {
    const references: Reference[] = [];
    for (const [property, value] of Object.entries(node)) {
        if (property.startsWith('$')) continue;
        if (isReference(value)) references.push(value);
        if (Array.isArray(value)) references.push(...value.filter(isReference));
    }
    return references;
}

/**
 * Validates every pattern and returns it with whatever was reported.
 *
 * Nothing should be: the test asserts the list is empty for all of them.
 */
export async function catalog(): Promise<Pattern[]> {
    const services = createTontoServices(EmptyFileSystem);
    const documents = services.shared.workspace.LangiumDocuments;
    const patterns: Pattern[] = [];
    let n = 0;

    for (const pattern of PATTERNS) {
        n++;
        const text = `ontology pattern${n}\n${PREAMBLE}\n${pattern.model}\n`;
        const document = services.shared.workspace.LangiumDocumentFactory
            .fromString(text, URI.parse(`file:///pattern${n}.tonto`));
        documents.addDocument(document);
        await services.shared.workspace.DocumentBuilder.build([document], { validation: true });
        patterns.push({
            ...pattern,
            example: pattern.model,
            diagnostics: (document.diagnostics ?? []).map(diagnostic =>
                `${diagnostic.code ?? 'no code'}: ${String(diagnostic.message).split('\n')[0]}`)
        });
        await services.shared.workspace.DocumentBuilder.update([], [document.uri]);
    }
    return patterns;
}
