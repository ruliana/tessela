// What a block edit is: a CodeMirror `ChangeSet` over the text of the page the edit was worked out on,
// and, for an edit that moves text, the ranges that went somewhere else. An edit works out its changes
// from the page model and hands them over; everything the editor keeps about the text (the selection, the
// blocks that are selected, folds, the history) follows from the changes and the moves, never from line
// numbers that the edit counted for itself (`editor/ARCHITECTURE.md`, principle 3).
//
// A `ChangeSet` has no word for "this text went there": a swap of two blocks is two replacements, and a
// position inside either would land in the text that took its place. The moves say where text went, so that
// `follow` can take a cursor, a fold or a selected block along.

import { Annotation, ChangeSet, type Text } from "@codemirror/state";

/** A range of the old text that is now `by` characters further on (or back, when negative). Ends included. */
export interface Move {
  readonly from: number;
  readonly to: number;
  readonly by: number;
}

export interface BlockEdit {
  readonly changes: ChangeSet;
  readonly moves: readonly Move[];
}

/** On the transaction of an edit that moves text, so that what lives in the text outside the document (folds) goes along. */
export const blockMoves = Annotation.define<readonly Move[]>();

/** Where the text at `pos` of the old page is in the new one: with the block that moved, else mapped through the changes. */
export function follow(edit: BlockEdit, pos: number): number {
  for (const m of edit.moves) if (pos >= m.from && pos <= m.to) return pos + m.by;
  return edit.changes.mapPos(pos, 1);
}

/** The edit that swaps two ranges of `doc`, the first before the second, and leaves what is between them where it is. */
export function swapRanges(doc: Text, first: { from: number; to: number }, second: { from: number; to: number }): BlockEdit {
  const a = doc.sliceString(first.from, first.to);
  const b = doc.sliceString(second.from, second.to);
  const moves = [
    { from: first.from, to: first.to, by: second.to - first.to },
    { from: second.from, to: second.to, by: first.from - second.from },
  ];
  // Two blocks that read the same swap into the same text: nothing changes, but the cursor still goes to the other.
  if (a === b) return { changes: ChangeSet.empty(doc.length), moves };
  const changes = ChangeSet.of(
    [
      { from: first.from, to: first.to, insert: b },
      { from: second.from, to: second.to, insert: a },
    ],
    doc.length,
  );
  return { changes, moves };
}
