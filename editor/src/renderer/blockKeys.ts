// Keys that act on blocks instead of characters: Tab and Shift+Tab nest and un-nest,
// Alt+Up/Down move a block with what it owns, Escape and Shift+Up/Down select blocks.
// The logic is in shared/blocks.ts; this connects it to the editor.

import { type EditorState, Prec, type Extension } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";

import { type Pos, type Result, type Sel, extendBlocks, indent, mapPos, move, outdent, selectBlock } from "../shared/blocks";

function toSel(state: EditorState): { lines: string[]; sel: Sel } {
  const { anchor, head } = state.selection.main;
  const pos = (offset: number): Pos => {
    const line = state.doc.lineAt(offset);
    return { line: line.number - 1, col: offset - line.from };
  };
  return { lines: state.doc.toString().split("\n"), sel: { anchor: pos(anchor), head: pos(head) } };
}

function offsetOf(lines: string[], pos: Pos): number {
  let offset = 0;
  for (let i = 0; i < pos.line; i++) offset += lines[i]!.length + 1;
  return offset + pos.col;
}

/** Replaces only the lines that changed, so the undo history and the cursor stay sensible. */
function apply(view: EditorView, lines: string[], sel: Sel, result: Result): void {
  const next = result.rows.map((r) => r.text);
  let head = 0;
  while (head < lines.length && head < next.length && lines[head] === next[head]) head++;
  let tail = 0;
  while (
    tail < lines.length - head &&
    tail < next.length - head &&
    lines[lines.length - 1 - tail] === next[next.length - 1 - tail]
  ) {
    tail++;
  }
  const selection = {
    anchor: offsetOf(next, mapPos(result, sel.anchor)),
    head: offsetOf(next, mapPos(result, sel.head)),
  };
  if (head + tail >= lines.length && head + tail >= next.length) {
    view.dispatch({ selection });
    return;
  }
  const oldEnd = lines.length - tail;
  const newEnd = next.length - tail;
  const docEnd = view.state.doc.length;
  const lineStart = (line: number) => offsetOf(lines, { line, col: 0 });
  const added = next.slice(head, newEnd).join("\n");
  let changes: { from: number; to: number; insert: string };
  if (oldEnd > head) {
    // Some lines are replaced, or removed when nothing takes their place.
    const from = lineStart(head);
    const to = lineStart(oldEnd - 1) + lines[oldEnd - 1]!.length;
    if (newEnd > head) changes = { from, to, insert: added };
    else if (oldEnd < lines.length) changes = { from, to: to + 1, insert: "" };
    else changes = { from: Math.max(0, from - 1), to, insert: "" };
  } else if (head < lines.length) {
    changes = { from: lineStart(head), to: lineStart(head), insert: `${added}\n` };
  } else {
    changes = { from: docEnd, to: docEnd, insert: `\n${added}` };
  }
  view.dispatch({ changes, selection, userEvent: "input" });
}

function command(op: (lines: string[], sel: Sel) => Result | null) {
  return (view: EditorView): boolean => {
    const { lines, sel } = toSel(view.state);
    const result = op(lines, sel);
    if (!result) return false;
    apply(view, lines, sel, result);
    return true;
  };
}

function selecting(op: (lines: string[], sel: Sel) => Sel | null) {
  return (view: EditorView): boolean => {
    const { lines, sel } = toSel(view.state);
    const next = op(lines, sel);
    if (!next) return false;
    view.dispatch({
      selection: { anchor: offsetOf(lines, next.anchor), head: offsetOf(lines, next.head) },
      scrollIntoView: true,
    });
    return true;
  };
}

export const blockKeymap: Extension = Prec.high(
  keymap.of([
    { key: "Tab", run: command(indent) },
    { key: "Shift-Tab", run: command(outdent) },
    { key: "Alt-ArrowUp", run: command((l, s) => move(l, s, "up")) },
    { key: "Alt-ArrowDown", run: command((l, s) => move(l, s, "down")) },
    { key: "Escape", run: selecting(selectBlock) },
    { key: "Shift-ArrowUp", run: selecting((l, s) => extendBlocks(l, s, "up")) },
    { key: "Shift-ArrowDown", run: selecting((l, s) => extendBlocks(l, s, "down")) },
  ]),
);
