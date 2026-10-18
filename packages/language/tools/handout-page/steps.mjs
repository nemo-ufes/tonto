/**
 * The model the handout builds, one step at a time, and the file of mistakes
 * it repairs. Each step is the whole file at that point; what the editor
 * says about it is not written here but asked of the validator when the page
 * is built.
 *
 * Strings rather than `.tonto` files: every step declares `ontology
 * university`, and one of them is wrong on purpose, so as files in the
 * repository they would load into any workspace opened on it and report each
 * other as duplicates.
 */

export const STEPS = [
    {
        title: 'A kind',
        doing: [
            'Run **tonto: New Ontology...**, name it `university`, and declare `kind Person` under its header.',
            'Hover `Person`: the card shows its stereotype, the natures of its instances and the ultimate sortal it draws identity from, which here is itself.'
        ],
        idea: 'A `kind` supplies the identity of its instances: what makes this person the same person from one year to the next. Everything else we say about people hangs off it.',
        model: `ontology university

kind Person`
    },
    {
        title: 'The stages of a life',
        doing: [
            'Add two phases, `Child` and `Adult`.',
            'A warning appears. Apply its quick fix: it writes the generalization set you see in step 3.'
        ],
        idea: 'A `phase` holds while a condition of the individual itself holds, such as age. Phases come in sets, and everyone is in exactly one of them, so the set is `disjoint complete`.',
        model: `ontology university

kind Person
phase Child specializes Person
phase Adult specializes Person`
    },
    {
        title: 'A deliberate mistake',
        doing: [
            'Type `kind Student specializes Person`. After `specializes`, completion offers only supertypes that would be valid.',
            'The error explains why a kind cannot go there, and offers five repairs. Choose **Change "Student" to role**.'
        ],
        idea: 'Being a student is not what someone is, but something they are for a while. The message names the principle that refuses the model, and the repair is a choice between readings, so the command line leaves it to you.',
        model: `ontology university

kind Person
disjoint complete genset PersonPhase where Child, Adult specializes Person
phase Child specializes Person
phase Adult specializes Person

kind Student specializes Person`
    },
    {
        title: 'What makes someone a student',
        doing: [
            'With `Student` now a role, a hint appears: a faint underline, kept out of the Problems panel.'
        ],
        idea: 'A role holds only while a relationship does. If nothing can be named that makes someone a student, the type is probably a phase instead. Hints mark where the model could say more.',
        model: `ontology university

kind Person
disjoint complete genset PersonPhase where Child, Adult specializes Person
phase Child specializes Person
phase Adult specializes Person

role Student specializes Person`
    },
    {
        title: 'The relationship itself',
        doing: [
            'Add `University`, the relator `Enrollment` that mediates a student and a university, and the relation people actually say: `studiesAt`.',
            'The hint offers to write what the relation is derived from. Apply it.'
        ],
        idea: 'The enrollment is where the properties live: a start date, a program, a status. `studiesAt` is true because an enrollment exists. Each end of a mediation reads in its own direction: an enrollment binds exactly one student and cannot be moved to another (`[1] (const)`), and a student has at least one enrollment (`[1..*]`). That is why `studiesAt` reaches at least one university: whoever is a student is enrolled somewhere.',
        model: `ontology university

kind Person
disjoint complete genset PersonPhase where Child, Adult specializes Person
phase Child specializes Person
phase Adult specializes Person

role Student specializes Person
kind University

relator Enrollment {
    @mediation [1..*] -- [1] (const) Student
    @mediation [0..*] -- [1] (const) University
}

@material relation Student [0..*] -- studiesAt -- [1..*] University`
    },
    {
        title: 'Something that happened',
        doing: [
            'Add the event `Graduation`, the student\'s participation in it, and the historical role `Graduate`, derived from that participation.'
        ],
        idea: 'At the graduation the person was a student; being a graduate is what it made them. So the participation is the student\'s, and `Graduate` is derived from it: whoever, as a student, graduated. A historical role holds forever once it holds -- the graduation does not stop having happened -- which is why it specializes `Person` and not the `Student` role, which lapses. `(const)` because who took part in an event is settled; `(addOnly)` because a student can gain graduations and never loses one.',
        model: `ontology university

kind Person
disjoint complete genset PersonPhase where Child, Adult specializes Person
phase Child specializes Person
phase Adult specializes Person

role Student specializes Person
kind University

relator Enrollment {
    @mediation [1..*] -- [1] (const) Student
    @mediation [0..*] -- [1] (const) University
}

@material relation Student [0..*] -- studiesAt -- [1..*] University derivedFrom Enrollment

event Graduation
@participation relation Student (const) [1..*] -- graduatedIn -- [0..*] (addOnly) Graduation
historicalRole Graduate specializes Person derivedFrom Student.graduatedIn`
    }
];

/** Seven problems at once, for what `tonto check --fix` makes of them. */
export const MISTAKES = `ontology university

kind Person
kind University
role Student specializes Person, Person

relator Enrollment {
    @mediaton [1..*] -- [1] (const) Student
    @mediation [5..2] -- [1] (const) University
}

quality Weight {
    @characterization [0..*] -- [0..*] Person
}`;
