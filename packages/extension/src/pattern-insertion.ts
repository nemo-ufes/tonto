import {
    PATTERN_GROUPS, PATTERNS, patternInsertionProblem, patternSnippet
} from 'tonto-language/patterns';
import type { PatternCase } from 'tonto-language/patterns';
import type {
    ExtensionContext, QuickPickItem, TextDocumentChangeEvent, TextEditor, TextEditorSelectionChangeEvent
} from 'vscode';
import * as vscode from 'vscode';

const COMMAND = 'tonto.insertPattern';

interface PatternItem extends QuickPickItem {
    pattern?: PatternCase;
}

interface OffsetRange {
    start: number;
    end: number;
}

let patternSession: PatternSession | undefined;

/** Register the explicit, deliberately quieter alternative to 33 completion entries. */
export function registerPatternInsertion(context: ExtensionContext): void {
    context.subscriptions.push(vscode.commands.registerCommand(COMMAND, insertPattern));
    context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(event => selectionChanged(event)));
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => documentChanged(event)));
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
        if (patternSession && editor !== patternSession.editor) void stopPatternSession(false);
    }));
}

async function insertPattern(): Promise<void> {
    if (patternSession) await stopPatternSession();
    let editor = vscode.window.activeTextEditor;
    const initialProblem = insertionProblem(editor);
    if (initialProblem) {
        void vscode.window.showWarningMessage(initialProblem);
        return;
    }

    const picked = await vscode.window.showQuickPick(patternItems(), {
        title: 'Insert a tonto modeling pattern',
        placeHolder: 'Choose a validated shape; its domain names become linked placeholders',
        matchOnDescription: true,
        matchOnDetail: true
    });
    if (!picked?.pattern) return;

    // The picker does not hold the editor still. Re-read it so a switch to a
    // different tab never inserts the chosen model into an unintended file.
    editor = vscode.window.activeTextEditor;
    const problem = insertionProblem(editor);
    if (problem) {
        void vscode.window.showWarningMessage(problem);
        return;
    }

    const document = editor!.document;
    const selection = editor!.selection;
    const line = document.lineAt(selection.active.line);
    const source = document.getText();
    const start = document.offsetAt(line.range.start);
    const end = document.offsetAt(line.range.end);
    const before = source.slice(0, start);
    const after = source.slice(end);
    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const leading = before.length > 0 && !before.endsWith(`${eol}${eol}`) ? eol : '';
    const trailing = after.startsWith(`${eol}${eol}`) ? '' : eol;
    const body = (await patternSnippet(picked.pattern)).replace(/\n/g, eol);
    const inserted = await editor!.insertSnippet(
        new vscode.SnippetString(`${leading}${body}${trailing}`),
        line.range,
        { undoStopBefore: true, undoStopAfter: true, keepWhitespace: true }
    );
    if (!inserted) {
        void vscode.window.showErrorMessage(`tonto could not insert the "${picked.pattern.title}" pattern.`);
        return;
    }
    const patternLength = picked.pattern.model.replace(/\n/g, eol).length;
    patternSession = PatternSession.start(editor!, start + leading.length, patternLength);
}

/**
 * A snippet normally keeps mirrored tab stops live until Escape or `$0`.
 * Pattern names are less forgiving: once the modeler deliberately moves out
 * of the selected name, continuing to rewrite its references is surprising.
 * Keep ordinary Tab traversal, but make a manual escape from the active name
 * end this pattern's snippet session immediately.
 */
class PatternSession {
    private changedSinceSelection = false;

    private constructor(
        readonly editor: TextEditor,
        private pattern: OffsetRange,
        private active: OffsetRange[]
    ) {}

    static start(editor: TextEditor, patternStart: number, patternLength: number): PatternSession | undefined {
        if (editor.selections.length === 0) return undefined;
        const document = editor.document;
        return new PatternSession(
            editor,
            { start: patternStart, end: patternStart + patternLength },
            editor.selections.map(selection => ({
                start: document.offsetAt(selection.start),
                end: document.offsetAt(selection.end)
            }))
        );
    }

    applyChanges(event: TextDocumentChangeEvent): void {
        if (event.document !== this.editor.document) return;
        this.pattern = updatedRange(this.pattern, event.contentChanges);
        this.active = this.active.map(range => updatedRange(range, event.contentChanges));
        this.changedSinceSelection = event.contentChanges.length > 0;
    }

    accepts(event: TextEditorSelectionChangeEvent): boolean {
        if (event.textEditor !== this.editor || event.selections.length === 0) return false;
        const document = this.editor.document;
        const selected = event.selections.map(selection => ({
            start: document.offsetAt(selection.start),
            end: document.offsetAt(selection.end)
        }));
        const selectedInOrder = [...selected].sort((a, b) => a.start - b.start);
        const activeInOrder = [...this.active].sort((a, b) => a.start - b.start);
        if (selectedInOrder.length === activeInOrder.length && selectedInOrder.every((selection, index) => {
            const active = activeInOrder[index];
            const contained = selection.start >= active.start && selection.end <= active.end;
            const manuallyCollapsedAtEdge = selection.start === selection.end
                && (selection.start === active.start || selection.end === active.end)
                && !this.changedSinceSelection;
            return contained && !manuallyCollapsedAtEdge;
        })) {
            this.changedSinceSelection = false;
            return true;
        }

        // A mouse selection is a deliberate departure, not snippet traversal.
        // Keyboard traversal selects every occurrence of the complete next
        // identifier; cursor motion outside an active identifier is empty.
        if (event.kind === vscode.TextEditorSelectionChangeKind.Mouse
            || event.selections.some(selection => selection.isEmpty)) return false;
        if (selected.some(selection => selection.start < this.pattern.start || selection.end > this.pattern.end)) {
            return false;
        }
        const names = event.selections.map(selection => document.getText(selection));
        if (names.some(name => !/^[A-Za-z_]\w*$/.test(name)) || new Set(names).size !== 1) return false;
        this.active = selected;
        this.changedSinceSelection = false;
        return true;
    }
}

function documentChanged(event: TextDocumentChangeEvent): void {
    patternSession?.applyChanges(event);
}

function selectionChanged(event: TextEditorSelectionChangeEvent): void {
    if (!patternSession || patternSession.accepts(event)) return;
    void stopPatternSession();
}

/**
 * Collapse the mirrored cursors ourselves before asking VS Code to leave its
 * snippet session. The command is context-key guarded and can be ignored when
 * the editor has already changed state; a single selection is unconditional
 * and itself makes the native snippet controller abandon linked placeholders.
 */
async function stopPatternSession(runCommand = true): Promise<void> {
    const session = patternSession;
    if (!session) return;
    patternSession = undefined;
    const primary = session.editor.selection;
    session.editor.selections = [primary];
    if (runCommand && vscode.window.activeTextEditor === session.editor) {
        await vscode.commands.executeCommand('leaveSnippet');
    }
}

/** Translate a tracked range through the simultaneous edits in one event. */
function updatedRange(range: OffsetRange, changes: readonly vscode.TextDocumentContentChangeEvent[]): OffsetRange {
    let before = 0;
    let inside = 0;
    for (const change of [...changes].sort((a, b) => a.rangeOffset - b.rangeOffset)) {
        const changeStart = change.rangeOffset;
        const changeEnd = changeStart + change.rangeLength;
        const delta = change.text.length - change.rangeLength;
        if (changeEnd < range.start || (changeEnd === range.start && change.rangeLength > 0)) {
            before += delta;
        } else if (changeStart <= range.end) {
            inside += delta;
        }
    }
    return { start: range.start + before, end: range.end + before + inside };
}

function patternItems(): PatternItem[] {
    return PATTERN_GROUPS.flatMap(group => [
        { label: group, kind: vscode.QuickPickItemKind.Separator },
        ...PATTERNS.filter(pattern => pattern.group === group).map(pattern => ({
            label: pattern.title,
            description: pattern.name,
            detail: `${pattern.intent} ${pattern.note} — ${pattern.source}`,
            pattern
        }))
    ]);
}

/** Why the active selection cannot safely receive a pattern. */
function insertionProblem(editor: TextEditor | undefined): string | undefined {
    if (!editor || editor.document.languageId !== 'tonto') {
        return 'Open a tonto model before inserting a modeling pattern.';
    }
    if (editor.selections.length !== 1 || !editor.selection.isEmpty) {
        return 'Place one cursor on a blank line between declarations before inserting a modeling pattern.';
    }
    const line = editor.document.lineAt(editor.selection.active.line);
    if (line.text.trim() !== '') {
        return 'Place the cursor on a blank line between declarations before inserting a modeling pattern.';
    }
    return patternInsertionProblem(editor.document.getText(), editor.document.offsetAt(editor.selection.active));
}
