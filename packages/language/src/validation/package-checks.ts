import type { ValidationAcceptor } from 'langium';
import { AstUtils } from 'langium';
import type { ClassDeclaration, Model, Package } from '../generated/ast.js';
import { isClassDeclaration, isExternalRelation, isModel, isOntologyBody } from '../generated/ast.js';
import { getDirectGeneralizations } from '../utils/generalizations.js';
import { chain } from './wording.js';

/**
 * A package is a namespace, and a namespace needs a name.
 *
 * The grammar takes one without, so that a document being typed still parses
 * and every other rule still has something to say about it -- with the name
 * mandatory, `package` alone discarded the file and answered with a list of
 * twenty-six tokens it might have been.
 */
export function checkPackageHasName(pkg: Package, accept: ValidationAcceptor): void {
    // A one-file ontology's declarations are the one package that has none.
    if (pkg.name || isOntologyBody(pkg)) {
        return;
    }
    accept('error', 'This package has no name: write one after "package".', {
        node: pkg,
        code: 'package-without-name'
    });
}

/**
 * Package names are written in lower case, a segment at a time:
 * `university.people`, `core.datatypes`. That is legacy tonto's convention
 * -- its documentation and every project `tonto init` writes -- and it keeps a
 * package apart from the types it holds at a glance: in `sales.Customer` the
 * namespace and the class read differently, as they do in Java or Python.
 *
 * Each segment is asked, not only the last, since `Core.people` has a
 * capitalized namespace as much as `core.People` does.
 */
export function checkPackageNameIsLowerCase(pkg: Package, accept: ValidationAcceptor): void {
    // Nothing to say about a name nobody has written; `checkPackageHasName`
    // reports it.
    if (!pkg.name) {
        return;
    }
    const expected = lowerCasePackageName(pkg.name);
    if (expected !== pkg.name) {
        accept('warning', `Package names are entirely lowercase: write "${expected}" instead of "${pkg.name}".`, {
            node: pkg,
            property: 'name',
            code: 'package-name-case'
        });
    }
}

/**
 * How a message names a package: by its name, or -- for a one-file
 * ontology's declarations, which are a package without one -- by the
 * ontology's.
 */
export function packageLabel(pkg: Package): string {
    if (isOntologyBody(pkg)) {
        const model = AstUtils.getContainerOfType(pkg, isModel) as Model | undefined;
        return `ontology "${model?.ontologies[0]?.name ?? ''}"`;
    }
    return `package "${pkg.name ?? ''}"`;
}

/** Lowercase every segment, without normalizing the Unicode spelling. */
export function lowerCasePackageName(name: string): string {
    return name.toLowerCase();
}

export function checkNoDuplicateDeclarationNames(pkg: Package, accept: ValidationAcceptor): void {
    const seen = new Map<string, boolean>();
    for (const declaration of pkg.declarations) {
        // A relation belongs to its source class's member namespace whether
        // written here or inside that class. checkDuplicateMemberNames checks
        // both forms together, including relations from other packages.
        if (isExternalRelation(declaration) || !declaration.name) {
            continue;
        }
        if (seen.has(declaration.name)) {
            accept('error', `Duplicate declaration name "${declaration.name}" in ${packageLabel(pkg)}.`, {
                node: declaration,
                property: 'name',
                code: 'duplicate-declaration'
            });
        } else {
            seen.set(declaration.name, true);
        }
    }
}

/**
 * Detects specialization cycles reachable from this package's classes.
 *
 * Generalizations declared by a generalization set count as edges (see
 * `getDirectGeneralizations`), and because `specializes` references resolve
 * to nodes in any document, a cycle that runs through another package is
 * found too -- it is simply reported from whichever package's class the walk
 * started at.
 */
export function checkNoCircularSpecialization(pkg: Package, accept: ValidationAcceptor): void {
    const classDeclarations = pkg.declarations.filter(isClassDeclaration);
    for (const classDeclaration of classDeclarations) {
        const cycle = cycleThrough(classDeclaration);
        if (cycle) {
            accept('error', `${chain([...cycle.map(member => member.name), classDeclaration.name], 'specializes', false)} -- a cycle, so each would have to be a subtype of the other.`, {
                node: classDeclaration,
                property: 'specializes',
                code: 'specialization-cycle'
            });
        }
    }
}

/**
 * The cycle this class is *in*, starting at it, or nothing.
 *
 * Any cycle reachable from it was reported as its own before, and the message
 * then named a path nobody had written: with `A specializes B`, `B specializes
 * C` and `C specializes B`, the walk from `A` found the cycle `B, C` and
 * printed it with `A` appended -- "B specializes C, which specializes A" --
 * which is not in the model and not a cycle. `A` is above a cycle, which is
 * `B` and `C`'s problem to report; the paths that lead into one are as many as
 * the model has classes.
 */
function cycleThrough(start: ClassDeclaration): ClassDeclaration[] | undefined {
    const walk = (current: ClassDeclaration, path: ClassDeclaration[]): ClassDeclaration[] | undefined => {
        for (const parent of getDirectGeneralizations(current)) {
            if (parent === start) {
                return [...path, current];
            }
            // Somebody else's cycle: stepping into it again would not
            // terminate, and it is not the one being asked about.
            if (parent === current || path.includes(parent)) {
                continue;
            }
            const found = walk(parent, [...path, current]);
            if (found) {
                return found;
            }
        }
        return undefined;
    };
    return walk(start, []);
}
