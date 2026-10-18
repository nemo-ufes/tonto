/**
 * Registry for caches of *derived* information -- anything computed by
 * following resolved cross-references, such as a class's ancestors or a
 * document's subtype index.
 *
 * These cannot be keyed on AST nodes alone. When a document changes, Langium
 * re-links every document that depends on it *without re-parsing them*, so
 * their AST nodes are reused while the references those nodes carry now point
 * somewhere else. A `WeakMap` keyed on those nodes therefore keeps answering
 * with the pre-change targets: renaming a `kind` to a `category` in one file
 * left a `subkind` in another file still believing it specialized an ultimate
 * sortal, and the error went unreported until that file happened to be
 * re-parsed.
 *
 * Every such cache registers a reset here, and `createTontoServices` calls
 * `resetDerivedCaches` on each document update.
 */
const resetters: Array<() => void> = [];

export function registerDerivedCacheReset(reset: () => void): void {
    resetters.push(reset);
}

export function resetDerivedCaches(): void {
    for (const reset of resetters) {
        reset();
    }
}
