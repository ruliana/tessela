// Formatting: Ctrl+B, Ctrl+I and friends mark text, typing a mark over a selection
// surrounds it, brackets close themselves, pasting a URL over a selection links it, and
// Ctrl+Enter ticks a task. The edits are in shared/format.ts.

import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { EditorSelection, EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

import { type TextEdit, pasteLink, surround, toggleMark, toggleTask } from "../shared/format";

function dispatchEdit(view: EditorView, e: TextEdit): void {
  view.dispatch({
    changes: { from: e.from, to: e.to, insert: e.insert },
    selection: EditorSelection.single(e.anchor, e.head),
    userEvent: "input",
  });
}

function mark(m: string) {
  return (view: EditorView): boolean => {
    const { from, to } = view.state.selection.main;
    dispatchEdit(view, toggleMark(view.state.doc.toString(), from, to, m));
    return true;
  };
}

function tick(view: EditorView): boolean {
  const { head } = view.state.selection.main;
  const line = view.state.doc.lineAt(head);
  const edit = toggleTask(line.text);
  if (!edit) return false;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: edit.text },
    selection: { anchor: head + edit.dcol },
    userEvent: "input",
  });
  return true;
}

/** Marks that surround a selection when typed over it. Brackets and quotes are closeBrackets'. */
const SURROUND = new Set(["*", "_", "~"]);

export const formatting: Extension = [
  closeBrackets(),
  // Pairs that close themselves; apostrophes are left out because they are text.
  EditorState.languageData.of(() => [{ closeBrackets: { brackets: ["(", "[", "{", '"', "`"] } }]),
  Prec.highest(
    keymap.of([
      { key: "Mod-b", run: mark("**") },
      { key: "Mod-i", run: mark("*") },
      { key: "Mod-e", run: mark("`") },
      { key: "Mod-Shift-x", run: mark("~~") },
      { key: "Mod-Enter", run: tick },
    ]),
  ),
  keymap.of(closeBracketsKeymap),
  EditorView.inputHandler.of((view, from, to, text) => {
    if (from === to || !SURROUND.has(text) || view.state.selection.ranges.length > 1) return false;
    dispatchEdit(view, surround(view.state.doc.toString(), from, to, text));
    return true;
  }),
  EditorView.domEventHandlers({
    paste(event, view) {
      const { from, to } = view.state.selection.main;
      const link = pasteLink(view.state.sliceDoc(from, to), event.clipboardData?.getData("text/plain") ?? "");
      if (!link) return false;
      event.preventDefault();
      view.dispatch({
        changes: { from, to, insert: link },
        selection: { anchor: from + link.length },
        userEvent: "input.paste",
      });
      return true;
    },
  }),
];
