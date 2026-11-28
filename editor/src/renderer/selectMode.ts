// Select mode: blocks are selected as blocks. What is selected is a value in the state, a
// `BlockSelection` (shared/blockSelection.ts): the anchor and head nodes of the page model and the run of
// siblings between them. Select mode means this field is set, and Editing that it is not.
//
// The CodeMirror selection is a projection of it: every transaction that sets the field sets the text
// selection to the lines of the blocks, in the same transaction (`selectionSpec`), so that copy, the
// accessibility tree and everything that reads the selection see the blocks. Anything else that moves the
// selection or changes the text, without selecting blocks again, ends the mode: a click, a key that is
// not in the table (blockKeys.ts), an undo. These are the only ways in and out.
//
// What is selected is drawn on one path, from the field: a line decoration on every line of the blocks,
// and `coversRange` for the widgets that stand in for a block (a table), which draw the same class.

import { foldedRanges } from "@codemirror/language";
import { EditorSelection, type EditorState, Facet, StateEffect, StateField, type Text, type TransactionSpec } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";

import {
  type BlockSelection,
  type Visible,
  makeSelection,
  membersOf,
  nodeStartingAt,
  reversed,
  selectedLines,
} from "../shared/blockSelection";
import type { PageModel, PageNode } from "../shared/pageModel";
import { foldsFollowMoves } from "./blockMoves";
import { pageModel } from "./pageModelField";

/**
 * Selects blocks: the effect that goes with the text selection in the transaction that does it (use
 * `selectionSpec`). A node is one of the page model of the state the transaction starts from, a number
 * is an offset into the document the transaction makes: the block that starts on its line is meant.
 */
export const setBlockSelection = StateEffect.define<{ anchor: PageNode | number; head: PageNode | number; heading?: boolean; depth?: number }>();

/** A node of the model of the new document: the same node, or the one at the same place when the text came out the same. */
function resolve(model: PageModel, target: PageNode | number): PageNode | null {
  if (typeof target === "number") return nodeStartingAt(model, model.doc.lineAt(target).number);
  if (target.model === model) return target;
  return model.nodes.find((n) => n.from === target.from && n.kind === target.kind) ?? null;
}

function select(model: PageModel, value: { anchor: PageNode | number; head: PageNode | number; heading?: boolean; depth?: number }): BlockSelection | null {
  const anchor = resolve(model, value.anchor);
  const head = resolve(model, value.head);
  return anchor && head ? makeSelection(anchor, head, value.heading === true, value.depth) : null;
}

/** The blocks that are selected, or null while the person is editing. */
export const blockSelection = StateField.define<BlockSelection | null>({
  create: () => null,
  update(value, tr) {
    const model = tr.state.field(pageModel);
    let next: BlockSelection | null | undefined;
    for (const e of tr.effects) if (e.is(setBlockSelection)) next = select(model, e.value);
    if (next !== undefined) return next;
    if (value === null) return null;
    // A selection or an edit that select mode did not make is the way back to editing.
    if (tr.docChanged || tr.selection !== undefined) return null;
    // The parser reached further into an unchanged page: the same blocks, in the new model.
    return value.anchor.model === model ? value : select(model, value);
  },
  provide: (f) => EditorView.editorAttributes.from(f, (sel) => ({ class: sel ? "cm-select-mode" : "" })),
});

/** Whether blocks are selected, as against editing. */
export function isSelecting(state: EditorState): boolean {
  return state.field(blockSelection, false) != null;
}

/** The selected blocks, in page order, or none while editing. A selected block includes those it owns. */
export function selectedBlocks(state: EditorState): PageNode[] {
  const sel = state.field(blockSelection, false);
  return sel ? membersOf(sel) : [];
}

// ---- what is shown --------------------------------------------------------------

/** The lines (1-based, both included) of a page that are not shown. */
export interface HiddenLines {
  from: number;
  to: number;
}

/**
 * Lines that something hides, besides the folds CodeMirror knows: a zoom hides all but one block. Block
 * selection does not step to, widen to or take in a block that starts on a hidden line.
 */
export const hiddenLines = Facet.define<(state: EditorState) => readonly HiddenLines[]>();

/** Which blocks are shown in `state`: the ones whose first line is not in a fold or hidden by a mod. */
export function visibleIn(state: EditorState): Visible {
  const hidden: HiddenLines[] = [];
  foldedRanges(state).between(0, state.doc.length, (from, to) => {
    const a = state.doc.lineAt(from);
    const b = state.doc.lineAt(to);
    hidden.push({ from: a.number + 1, to: to === b.to ? b.number : b.number - 1 });
  });
  for (const provide of state.facet(hiddenLines)) hidden.push(...provide(state));
  return (node) => !hidden.some((h) => h.from <= node.startLine && node.startLine <= h.to);
}

// ---- selecting ------------------------------------------------------------------------

/** The text selection that goes with `sel` in `doc`: the lines of the blocks, the head at the start of them when the selection was taken in upwards. */
function projection(doc: Text, sel: BlockSelection): EditorSelection {
  const [first, last] = selectedLines(sel);
  const from = doc.line(first + 1).from;
  const to = doc.line(last + 1).to;
  return reversed(sel) ? EditorSelection.single(to, from) : EditorSelection.single(from, to);
}

/**
 * The transaction part that selects `sel`: the effect and the text selection that projects it, in the
 * same transaction. Anything that selects blocks does it through this or `selectLinesSpec`.
 */
export function selectionSpec(state: EditorState, sel: BlockSelection): TransactionSpec {
  return {
    selection: projection(state.doc, sel),
    effects: setBlockSelection.of({ anchor: sel.anchor, head: sel.head, heading: sel.heading, depth: sel.depth }),
    scrollIntoView: true,
  };
}

/**
 * The same for blocks of a document that a change makes (`doc`, whose page model is `model`): the blocks
 * that start on the lines of the targets, offsets into `doc`, or null when there are none there.
 */
export function selectAtSpec(
  doc: Text,
  model: PageModel,
  targets: { anchor: number; head: number; heading?: boolean; depth?: number },
): TransactionSpec | null {
  const sel = select(model, targets);
  return sel ? { selection: projection(doc, sel), effects: setBlockSelection.of(targets), scrollIntoView: true } : null;
}

/** Whether the text from `from` to `to` lies in the selected blocks: what a widget that stands in for a block draws as selected. */
export function coversRange(state: EditorState, from: number, to: number): boolean {
  const sel = state.field(blockSelection, false);
  if (!sel) return false;
  const [first, last] = selectedLines(sel);
  return from >= state.doc.line(first + 1).from && to <= state.doc.line(last + 1).to;
}

/** A line of a selected block: it is drawn selected (see style.css), above whatever background the block has. */
export const selectedLine = Decoration.line({ class: "cm-block-selected" });

export const blockSelectionDrawing = EditorView.decorations.compute([blockSelection, "doc"], (state) => {
  const sel = state.field(blockSelection);
  if (!sel) return Decoration.none;
  const [first, last] = selectedLines(sel);
  const marks = [];
  for (let line = first + 1; line <= last + 1; line++) marks.push(selectedLine.range(state.doc.line(line).from));
  return Decoration.set(marks);
});

/** The state of select mode and how it is drawn, and the folds that go with the blocks that an edit moves: part of every editor (its keys are in blockKeys.ts). */
export const selectModeState = [pageModel, blockSelection, blockSelectionDrawing, foldsFollowMoves];
