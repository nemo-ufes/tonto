/**
 * The names a new ontology or package may be given, by every host that
 * creates one: the editor, the command line and the agent tools. Kept apart
 * from the rest of onboarding, which reads paths, because the language server
 * checks a package name too and must not gain a Node module for it.
 */

/**
 * One lower-case identifier, its words joined by `_` or `-`. The grammar's
 * identifiers admit far more; this is the house shape for a name that also
 * becomes a file name and a Turtle prefix. A hyphen stands only between two
 * words, since `--` is how a relation is written.
 */
const SEGMENT = '[a-z][a-z0-9_]*(?:-[a-z0-9_]+)*';

/** An ontology's name: one segment. */
const ONTOLOGY_NAME = new RegExp(`^${SEGMENT}$`);

/** A package's name: one segment, or several joined by `.`. */
const PACKAGE_NAME = new RegExp(`^${SEGMENT}(?:\\.${SEGMENT})*$`);

export function validOntologyName(value: string): boolean {
    return ONTOLOGY_NAME.test(value);
}

export function validPackageName(value: string): boolean {
    return PACKAGE_NAME.test(value);
}

export const ONTOLOGY_NAME_HINT = 'Use one lower-case name, for example "sales", "university" or "car-rental".';

export const PACKAGE_NAME_HINT = 'Use lower-case words, joined by "." if it has several parts, for example "sales", "car-rental" or "commerce.sales".';
