import { dirname, join, posix, relative, sep } from 'node:path';
import { AstUtils, GrammarUtils, URI } from 'langium';
import type { LangiumDocument } from 'langium';
import type { FileOperationHandler, LangiumSharedServices } from 'langium/lsp';
import type { FileOperationOptions, RenameFilesParams, TextEdit, WorkspaceEdit } from 'vscode-languageserver';
import { isBundleEntry, isImport, isModel } from '../generated/ast.js';
import { publicationWorkspace, relativeBundleLocation } from '../publication/workspace.js';

/**
 * Keeps relative locations pointing at the same files when files move.
 *
 * Bundle entries and ontology imports name files by where they are, so a
 * file renamed or moved in the editor would leave `core from <core.tonto>`
 * naming nothing. Before the move happens the editor asks for the edits that
 * go with it, and every location in an authored document that would change
 * meaning is rewritten: those naming a file that moves, and those written in a
 * file that moves. Absolute and remote locations name no file of this
 * workspace, and a cached dependency is never edited.
 */
export class TontoFileOperationHandler implements FileOperationHandler {
    readonly fileOperationOptions: FileOperationOptions = {
        willRename: {
            filters: [
                { scheme: 'file', pattern: { glob: '**/*.tonto', matches: 'file' } },
                { scheme: 'file', pattern: { glob: '**', matches: 'folder' } }
            ]
        }
    };

    constructor(private readonly services: LangiumSharedServices) {}

    willRenameFiles(params: RenameFilesParams): WorkspaceEdit | null {
        const moves = params.files.map(file => ({ from: URI.parse(file.oldUri).fsPath, to: URI.parse(file.newUri).fsPath }));
        const moved = (path: string): string => {
            for (const { from, to } of moves) {
                if (path === from) return to;
                if (path.startsWith(from + sep)) return to + path.slice(from.length);
            }
            return path;
        };
        const workspace = publicationWorkspace(this.services);
        const changes: Record<string, TextEdit[]> = {};
        for (const document of this.services.workspace.LangiumDocuments.all) {
            if (document.uri.scheme !== 'file' || workspace.isReadOnly(document)) continue;
            const edits = locationEdits(document, moved);
            if (edits.length) changes[document.uri.toString()] = edits;
        }
        return Object.keys(changes).length ? { changes } : null;
    }
}

function locationEdits(document: LangiumDocument, moved: (path: string) => string): TextEdit[] {
    const model = document.parseResult.value;
    if (!isModel(model)) return [];
    const from = document.uri.fsPath;
    const edits: TextEdit[] = [];
    for (const node of AstUtils.streamAllContents(model)) {
        if (!(isBundleEntry(node) || isImport(node)) || !node.location || !relativeBundleLocation(node.location)) continue;
        // Joined, not resolved: resolving a path with no drive adds the current one on Windows.
        const target = join(dirname(from), ...node.location.slice(1, -1).split('/'));
        if (moved(from) === from && moved(target) === target) continue;
        const location = `<${relative(dirname(moved(from)), moved(target)).split(sep).join(posix.sep)}>`;
        const cst = GrammarUtils.findNodeForProperty(node.$cstNode, 'location');
        if (cst && location !== node.location) edits.push({ range: cst.range, newText: location });
    }
    return edits;
}
