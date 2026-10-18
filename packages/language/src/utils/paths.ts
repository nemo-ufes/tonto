import { realpathSync } from 'node:fs';
import { isAbsolute, normalize, resolve } from 'node:path';
import { URI } from 'langium';

/**
 * A file path in the one form this package compares paths in: the form a
 * document's URI gives back. On Windows that has a lower-case drive letter --
 * `c:\Users\...` -- where Node's own paths keep `C:`, so a file collected from
 * disk and the same file loaded as a document were two paths, the document
 * was not found among those loaded, and loading it a second time failed:
 * "A document with the URI ... is already present." Elsewhere it is the path
 * resolved, unchanged.
 *
 * An absolute path is normalized, not resolved: on Windows, resolving one with
 * no drive -- `\project`, as a URI with no authority gives it -- adds the
 * current drive, and the path no longer matches the documents under it.
 */
export function canonicalPath(path: string): string {
    return URI.file(isAbsolute(path) ? normalize(path) : resolve(path)).fsPath;
}

/** A location under a root, joined rather than resolved for the same reason. */
export function underRoot(root: string, path: string): string {
    return isAbsolute(path) ? normalize(path) : canonicalPath(`${root}/${path}`);
}

/** The real path, in the same form; the path itself, canonical, when it cannot be resolved. */
export function canonicalRealPath(path: string): string {
    try { return canonicalPath(realpathSync.native(path)); } catch { return canonicalPath(path); }
}
