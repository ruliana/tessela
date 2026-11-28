// Block edits are CodeMirror transactions: what the editor keeps around the text (folds, the selection,
// the history) follows the blocks that an edit moves or shifts, and is not rebuilt from line numbers.

import { foldedRanges } from "@codemirror/language";
import { history, redo, undo } from "@codemirror/commands";
import type { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { press, pageState, offsetOf } from "./support/selecting";

/** The lines (0-based, `first` visible and `last` the last hidden one) of the folds a state has. */
function folded(state: EditorState): [number, number][] {
  const out: [number, number][] = [];
  foldedRanges(state).between(0, state.doc.length, (from, to) => {
    out.push([state.doc.lineAt(from).number - 1, state.doc.lineAt(to).number - 1]);
  });
  return out;
}

const PAGE = ["- a", "- b", "  - b1", "  - b2", "- c"].join("\n");

describe("folds follow the blocks that an edit moves", () => {
  it("keeps a fold on the item that Alt+Down moves, and on the one it passed", () => {
    // b folded (its children are lines 2-3), and c (a leaf) cannot fold; move a below b.
    const state = pageState(PAGE, { at: 0, folds: [{ first: 1, last: 3 }], extensions: [history()] });
    const after = press(state, "Alt-ArrowDown");
    expect(after.doc.toString()).toBe(["- b", "  - b1", "  - b2", "- a", "- c"].join("\n"));
    expect(folded(after)).toEqual([[0, 2]]);
  });

  it("keeps the fold of the block that is moved up", () => {
    const state = pageState(PAGE, { at: offsetOf(PAGE, 1), folds: [{ first: 1, last: 3 }], extensions: [history()] });
    const after = press(state, "Alt-ArrowUp");
    expect(after.doc.toString()).toBe(["- b", "  - b1", "  - b2", "- a", "- c"].join("\n"));
    expect(folded(after)).toEqual([[0, 2]]);
  });

  it("keeps the folds of selected blocks that Alt+Down moves", () => {
    const state = pageState(PAGE, { at: offsetOf(PAGE, 1), folds: [{ first: 1, last: 3 }], extensions: [history()] });
    const after = press(state, "Escape", "Alt-ArrowDown");
    expect(after.doc.toString()).toBe(["- a", "- c", "- b", "  - b1", "  - b2"].join("\n"));
    expect(folded(after)).toEqual([[2, 4]]);
  });

  it("keeps a fold when Tab nests the item that holds it", () => {
    const state = pageState(PAGE, { at: offsetOf(PAGE, 1), folds: [{ first: 1, last: 3 }], extensions: [history()] });
    const after = press(state, "Tab");
    expect(after.doc.toString()).toBe(["- a", "  - b", "    - b1", "    - b2", "- c"].join("\n"));
    expect(folded(after)).toEqual([[1, 3]]);
  });

  it("is undone in one step, with the text as it was", () => {
    let state = pageState(PAGE, { at: 0, extensions: [history()] });
    state = press(state, "Alt-ArrowDown");
    let undone = state;
    undo({ state, dispatch: (tr) => (undone = tr.state) });
    expect(undone.doc.toString()).toBe(PAGE);
  });
});

describe("the cursor and the history follow the edit", () => {
  it("keeps the cursor on the character it was on when its block moves", () => {
    const state = pageState(PAGE, { at: offsetOf(PAGE, 1, 3), extensions: [history()] });
    const after = press(state, "Alt-ArrowUp");
    expect(after.doc.toString()).toBe(["- b", "  - b1", "  - b2", "- a", "- c"].join("\n"));
    expect(after.selection.main.head).toBe(offsetOf(after.doc.toString(), 0, 3));
  });

  it("brings the fold back with the text when the move is undone, and again when it is redone", () => {
    let state = pageState(PAGE, { at: 0, folds: [{ first: 1, last: 3 }], extensions: [history()] });
    state = press(state, "Alt-ArrowDown");
    undo({ state, dispatch: (tr) => (state = tr.state) });
    expect(state.doc.toString()).toBe(PAGE);
    expect(folded(state)).toEqual([[1, 3]]);
    redo({ state, dispatch: (tr) => (state = tr.state) });
    expect(folded(state)).toEqual([[0, 2]]);
  });
});

describe("two blocks that swap, both folded", () => {
  it("carry both folds, whichever lands first on the page", () => {
    const page = ["# a", "", "> x", "", "# b", "", "y", "- z"].join("\n");
    const state = pageState(page, { at: 0, folds: [{ first: 0, last: 2 }, { first: 4, last: 7 }], extensions: [history()] });
    const after = press(state, "Alt-ArrowDown");
    expect(after.doc.toString()).toBe(["# b", "", "y", "- z", "", "# a", "", "> x"].join("\n"));
    expect(folded(after)).toEqual([[0, 3], [5, 7]]);
  });
});
