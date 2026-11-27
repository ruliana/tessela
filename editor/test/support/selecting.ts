// Select mode without a window: an editor state with the page model and the block selection, and
// keys pressed on it through the table in `renderer/blockKeys.ts` (`respond`), one state to the next.

import { codeFolding, foldEffect } from "@codemirror/language";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";

import { type Key, LEAVE, STAY, respond } from "../../src/renderer/blockKeys";
import { pageLanguage } from "../../src/renderer/pageModelField";
import { type HiddenLines, blockSelection, hiddenLines, selectModeState, selectedBlocks } from "../../src/renderer/selectMode";
import { selectedLines } from "../../src/shared/blockSelection";

export interface Setup {
  /** The cursor (or the start of a selection) as an offset into the text. */
  at?: number;
  to?: number;
  /** Lines (0-based, `first` stays visible, `last` is the last hidden one) that are folded. */
  folds?: { first: number; last: number }[];
  /** A zoom: only these lines (0-based, both included) are shown. */
  zoom?: { first: number; last: number };
  extensions?: Extension[];
}

/** The offset of the start of line `line` (0-based) of `text`, `col` characters in. */
export function offsetOf(text: string, line: number, col = 0): number {
  return text.split("\n").slice(0, line).reduce((n, l) => n + l.length + 1, 0) + col;
}

export function pageState(text: string, setup: Setup = {}): EditorState {
  const zoom = setup.zoom;
  const provide = zoom
    ? hiddenLines.of((state): readonly HiddenLines[] => [
        { from: 1, to: zoom.first },
        { from: zoom.last + 2, to: state.doc.lines },
      ])
    : [];
  let state = EditorState.create({
    doc: text,
    selection: EditorSelection.single(setup.at ?? 0, setup.to ?? setup.at ?? 0),
    extensions: [pageLanguage(), selectModeState, codeFolding(), provide, ...(setup.extensions ?? [])],
  });
  if (setup.folds) {
    for (const f of setup.folds) {
      state = state.update({ effects: foldEffect.of({ from: state.doc.line(f.first + 1).to, to: state.doc.line(f.last + 1).to }) }).state;
    }
  }
  return state;
}

/** The state after `key`: the same state when the key is not taken, or taken with nothing to do. */
export function press(state: EditorState, ...keys: Key[]): EditorState {
  let now = state;
  for (const key of keys) {
    const reply = respond(now, key);
    if (reply === null || reply === STAY || reply === LEAVE) continue;
    now = now.update(reply).state;
  }
  return now;
}

/** The lines the selected blocks cover (0-based, both included), or null while editing. */
export function picked(state: EditorState): [number, number] | null {
  const sel = state.field(blockSelection, false);
  return sel ? selectedLines(sel) : null;
}

/** The selected text, as the text selection that projects the blocks has it. */
export function selectedText(state: EditorState): string {
  const { from, to } = state.selection.main;
  return state.sliceDoc(from, to);
}

export const kinds = (state: EditorState): string[] => selectedBlocks(state).map((n) => n.kind);

/** A page with the cursor in line `line`, then Escape: the block of that line is selected. */
export function selecting(text: string, line: number, setup: Setup = {}): EditorState {
  return press(pageState(text, { ...setup, at: offsetOf(text, line) }), "Escape");
}
