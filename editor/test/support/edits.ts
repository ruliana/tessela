// Block edits on a page given as lines, with line and column positions: what they do to the text, and
// where a position goes. The edits themselves work on offsets (`shared/blocks.ts`).

import { Text } from "@codemirror/state";

import type { BlockEdit } from "../../src/shared/blockEdit";
import { follow } from "../../src/shared/blockEdit";
import type { Sel } from "../../src/shared/blocks";
import { offsetOf } from "./selecting";

export interface Pos {
  line: number;
  col: number;
}

export interface LineSel {
  anchor: Pos;
  head: Pos;
}

/** A line and column of `doc` as an offset. */
export const at = (doc: string[], pos: Pos): number => offsetOf(doc.join("\n"), pos.line, pos.col);

/** A selection by lines and columns, as the offsets the edits take. */
export const toSel = (doc: string[], sel: LineSel): Sel => ({ anchor: at(doc, sel.anchor), head: at(doc, sel.head) });

/** The page after the edit, as lines. */
export const textOf = (doc: string[], edit: BlockEdit): string[] => edit.changes.apply(Text.of(doc)).toString().split("\n");

/** Where the text at `pos` is after the edit, as a line and column of the new page. */
export function whereIs(doc: string[], edit: BlockEdit, pos: number): Pos {
  const next = Text.of(textOf(doc, edit));
  const at = next.lineAt(follow(edit, pos));
  return { line: at.number - 1, col: follow(edit, pos) - at.from };
}
