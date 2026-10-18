import { randomUUID } from 'node:crypto';
import {
    constants, copyFileSync, linkSync, lstatSync, mkdirSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * One file an export writes for one ontology, whatever the format: the gUFO
 * export's Turtle today, and the formats after it. Every export follows one
 * rule (docs/ontology-publication.md, section 11): an ontology's files are
 * written beside its ontology file and named after the ontology, with the
 * format's extension -- `shop.ttl` next to `shop.tonto` -- unless the caller
 * names a directory instead.
 */
export interface ExportedFile {
    /** Which ontology the file is of: its IRI, for an RDF format. */
    ontology: string;
    /** Its file name, `<ontology name>.<extension>`, unique within the export. */
    file: string;
    content: string;
    /** The ontology file on disk it was exported from, beside which it belongs; absent for unsaved text. */
    source?: string;
}

export interface WrittenFile {
    ontology: string;
    path: string;
}

/**
 * Writes each file beside the ontology file it came from. With a workspace,
 * an ontology file outside it is refused, as `writeInto` refuses a directory
 * outside it. All or nothing: every file is staged before any is renamed into
 * place, so a failure part-way leaves the previous export as it was.
 */
export function writeBeside(files: readonly ExportedFile[], workspaceRoot?: string): WrittenFile[] {
    const root = workspaceRoot === undefined ? undefined : realpathSync(resolve(workspaceRoot));
    const targets = files.map(file => {
        if (!file.source) throw new Error(`"${file.file}" has no ontology file on disk to be written beside.`);
        checkName(file);
        const directory = realpathSync(dirname(file.source));
        const fromRoot = root === undefined ? '' : relative(root, directory);
        if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
            throw new Error(`The ontology file "${file.source}" is outside the workspace.`);
        }
        return { file, directory };
    });
    return writeStaged(targets);
}

/**
 * Writes an export into one directory beneath a workspace, all of it or none.
 *
 * Agent tools take a relative directory rather than an arbitrary output path:
 * exporting a model is authority to refresh generated files in its project,
 * not to write elsewhere on the machine. Existing symbolic-link components
 * are refused so a path that looks local cannot redirect the write outside.
 */
export function writeInto(workspaceRoot: string, outputDirectory: string, files: readonly ExportedFile[]): WrittenFile[] {
    if (!outputDirectory.trim()) throw new Error('The output directory cannot be empty.');
    if (isAbsolute(outputDirectory)) throw new Error('The output directory must be workspace-relative.');
    const root = realpathSync(resolve(workspaceRoot));
    const directory = resolve(root, outputDirectory);
    const fromRoot = relative(root, directory);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
        throw new Error('The output directory must stay inside the workspace.');
    }
    ensurePlainDirectory(root, fromRoot);
    files.forEach(checkName);
    return writeStaged(files.map(file => ({ file, directory })));
}

/** A plain file name with an extension, which an export may not use to overwrite a model. */
function checkName(file: ExportedFile): void {
    if (basename(file.file) !== file.file || file.file.startsWith('.') || !/\.[a-z0-9]+$/i.test(file.file)
        || file.file.toLowerCase().endsWith('.tonto')) {
        throw new Error(`The exported file name "${file.file}" is not a safe file name.`);
    }
}

/**
 * Writes every file or none. Each new file is written beside its target
 * first; an existing target is kept as a backup -- a hard link, or a copy
 * where the file system has none -- while it stays where it is; and then each
 * new file is renamed over its target. A rename replaces a file in one step,
 * so a reader watching the target sees the old file or the new one and never
 * none, which is what renaming the old file away first would show. If any
 * step fails, the files already replaced are put back from their backups and
 * the error is the one that failed, not one from putting things back.
 */
function writeStaged(targets: ReadonlyArray<{ file: ExportedFile; directory: string }>): WrittenFile[] {
    const staged = targets.map(({ file, directory }) => ({
        file,
        target: join(directory, file.file),
        temporary: join(directory, `.${file.file}.${randomUUID()}.tmp`),
        backup: join(directory, `.${file.file}.${randomUUID()}.bak`)
    }));
    if (new Set(staged.map(item => item.target)).size !== staged.length) {
        throw new Error('An export names the same output file more than once.');
    }
    for (const { target } of staged) {
        const existing = existingTarget(target);
        if (existing && !existing.isFile() && !existing.isSymbolicLink()) {
            throw new Error(`The export target "${target}" is not a file.`);
        }
    }
    const backedUp = new Set<(typeof staged)[number]>();
    const installed: typeof staged = [];
    try {
        for (const { file, temporary } of staged) writeFileSync(temporary, file.content, { encoding: 'utf8', flag: 'wx' });
        for (const item of staged) {
            if (backUp(item.target, item.backup)) backedUp.add(item);
        }
        for (const item of staged) {
            renameSync(item.temporary, item.target);
            installed.push(item);
        }
    } catch (error) {
        const left: string[] = [];
        const attempt = (step: () => void, path: string): void => {
            try { step(); } catch { left.push(path); }
        };
        for (const item of [...installed].reverse()) {
            attempt(() => backedUp.has(item) ? renameSync(item.backup, item.target) : unlinkSync(item.target),
                backedUp.has(item) ? `${item.target} (the previous file is ${item.backup})` : item.target);
        }
        for (const item of backedUp) {
            if (!installed.includes(item)) attempt(() => unlinkSync(item.backup), item.backup);
        }
        for (const { temporary } of staged) {
            if (existingTarget(temporary)) attempt(() => unlinkSync(temporary), temporary);
        }
        if (left.length > 0 && error instanceof Error) {
            error.message = `${error.message.replace(/\.?$/, '.')} Putting the previous files back also failed; check ${left.join(', ')}.`;
        }
        throw error;
    }
    // Written: a backup that will not go is left behind, not reported as a failed export.
    for (const { backup } of backedUp) {
        try { unlinkSync(backup); } catch { /* Harmless; the export is in place. */ }
    }
    return staged.map(({ file, target }) => ({ ontology: file.ontology, path: target }));
}

/** Keeps an existing target at `backup`, leaving it in place; false when there is none. */
function backUp(target: string, backup: string): boolean {
    const existing = existingTarget(target);
    if (!existing) return false;
    if (existing.isSymbolicLink()) {
        // The link itself, not what it points at: a hard link to a symlink
        // follows it on some systems.
        symlinkSync(readlinkSync(target), backup);
        return true;
    }
    try {
        linkSync(target, backup);
    } catch {
        copyFileSync(target, backup, constants.COPYFILE_EXCL);
    }
    return true;
}

function existingTarget(path: string): ReturnType<typeof lstatSync> | undefined {
    try { return lstatSync(path); } catch (error) {
        if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
}

/** Creates only ordinary directories; an existing symlink may not steer an export. */
function ensurePlainDirectory(root: string, relativeDirectory: string): void {
    let current = root;
    for (const segment of relativeDirectory.split(sep).filter(Boolean)) {
        current = join(current, segment);
        try {
            const stats = lstatSync(current);
            if (stats.isSymbolicLink()) {
                throw new Error(`The output directory crosses symbolic link "${current}".`);
            }
            if (!stats.isDirectory()) throw new Error(`The output path "${current}" is not a directory.`);
        } catch (error) {
            const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
            if (code !== 'ENOENT') throw error;
            mkdirSync(current);
        }
    }
}
