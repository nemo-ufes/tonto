import type { ValidationAcceptor } from 'langium';
import type { Attribute, ClassDeclaration, Datatype, Enumeration, RelationEndMetaAttributes } from '../generated/ast.js';
import { isClassDeclaration } from '../generated/ast.js';
import { BUILTIN_DATATYPE_NAMES } from '../workspace/builtin-datatypes.js';

/**
 * Type names are capitalized and member names are not, matching UML and every
 * published OntoUML model. A convention rather than a rule, so both are
 * warnings -- but a consistent one, since `Person` and `person` are distinct
 * declarations here and a stray case makes references read as typos.
 */
export function checkTypeNameStartsWithCapital(
    declaration: ClassDeclaration | Datatype | Enumeration, accept: ValidationAcceptor
): void {
    const name = simpleName(declaration.name);
    // The built-in datatypes are lowercase by design -- `string`, `number` --
    // so a datatype of that name is following the convention, not breaking it.
    // A *class* called `date` gets no such license; the exemption is about
    // those declarations, not about the spelling.
    if (BUILTIN_DATATYPE_NAMES.has(name) && !isClassDeclaration(declaration)) {
        return;
    }
    // Caseless first characters -- digits, underscores, scripts without case --
    // carry no convention and are left alone.
    if (name.length > 0 && name[0] === name[0].toLowerCase() && name[0] !== name[0].toUpperCase()) {
        accept('warning', `Type name "${declaration.name}" should start with an uppercase letter.`, {
            node: declaration,
            property: 'name',
            code: 'type-name-case'
        });
    }
}

export function checkAttributeNameStartsLowercase(attribute: Attribute, accept: ValidationAcceptor): void {
    reportIfCapitalized(attribute.name, 'Attribute', attribute, accept);
}

export function checkRelationEndNameStartsLowercase(
    end: RelationEndMetaAttributes, accept: ValidationAcceptor
): void {
    if (end.name) {
        reportIfCapitalized(end.name, 'Relation end', end, accept);
    }
}

function reportIfCapitalized(
    name: string | undefined, what: string, node: Attribute | RelationEndMetaAttributes, accept: ValidationAcceptor
): void {
    const simple = simpleName(name);
    if (simple.length > 0 && simple[0] === simple[0].toUpperCase() && simple[0] !== simple[0].toLowerCase()) {
        accept('warning', `${what} name "${name}" should start with a lowercase letter.`, {
            node,
            property: 'name',
            code: 'member-name-case'
        });
    }
}

/**
 * Names may be qualified; only the last segment carries the convention.
 *
 * A name that has not been typed yet is the empty string here rather than a
 * crash: the parser recovers from `kind {` or a bare `@begin` by leaving the
 * field undefined, and a convention has nothing to say about a name nobody
 * has written.
 */
function simpleName(name: string | undefined): string {
    return name?.split('.').pop() ?? '';
}
