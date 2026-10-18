/**
 * The implicit standard library every tonto document can use without a `use`
 * or an `import`: `string`, `number`, `boolean`, `date`, `time`, `datetime`.
 *
 * These are ordinary `datatype` declarations in a compiler-defined prelude,
 * loaded as a virtual, unsaved document (see `TontoWorkspaceManager`) so
 * attribute types like `name: string` resolve through the same scoping
 * machinery as everything else -- no special-casing of "primitive type"
 * names anywhere else in the language.
 */
export const BUILTIN_DATATYPES_URI = 'tonto:/builtin/datatypes.tonto';

export const builtinDatatypes = `
package tonto.builtindatatypes

datatype string
datatype number
datatype boolean
datatype date
datatype time
datatype datetime
`;

/**
 * The names above, for the places that must recognize them -- the naming
 * convention, notably, since these are deliberately lowercase where every
 * other type is capitalized.
 *
 * Read out of the source rather than repeated, so the two cannot drift.
 */
export const BUILTIN_DATATYPE_NAMES: ReadonlySet<string> = new Set(
    [...builtinDatatypes.matchAll(/^datatype (\w+)$/gm)].map(match => match[1]));
