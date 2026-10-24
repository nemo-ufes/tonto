/**
 * The language without its command line: what a host that brings its own
 * file system needs to parse, link, validate, read and export a model.
 *
 * The package root also exports `TontoSession` and the export writers, which
 * read folders and write files through Node. A diagram drawn in another
 * process, or an editor running in a browser, wants the services and the AST
 * and none of that, so this entry leaves it out. `test/core-entry.test.ts`
 * keeps it that way: it fails when this entry starts to reach a Node module
 * it did not reach before.
 */

export * from './generated/ast.js';
export { TontoLanguageMetaData } from './generated/module.js';
export * from './tonto-module.js';
export * from './utils/relations.js';
export { getEffectiveNatures } from './utils/natures.js';
export type { EffectiveNatures, NatureOrigin } from './utils/natures.js';
export { isUltimateSortal } from './validation/stereotype-model.js';
export { generateGufo, validGufoNamespaceIri } from './gufo.js';
export type { GufoDiagnostic, GufoFile, GufoOptions, GufoResult, GufoSeverity } from './gufo.js';
