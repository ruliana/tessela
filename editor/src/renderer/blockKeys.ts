// Keys that act on blocks instead of characters: Tab and Shift+Tab nest and un-nest,
// Alt+Up/Down move a block with what it owns, Escape and Shift+Up/Down select blocks. In select
// mode (what Escape leaves) the arrows step from block to block and Enter, Space, Left, Right and
// any character go back to editing. The logic is in shared/blocks.ts, which reads the page model
// (`pageModel`, one for each version of the text); this connects it to the editor.

import { type EditorState, Prec, type Extension, type StateEffect } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

import {
  type Pos,
  type Result,
  type Sel,
  blockBelow,
  extendBlocks,
  frontmatterEndOf,
  indent,
  linesOf,
  mapPos,
  move,
  outdent,
  selectBlock,
  selectedSpan,
  stepBlock,
} from "../shared/blocks";
import type { PageModel } from "../shared/pageModel";
import { pageModel } from "./pageModelField";
import { enterSelectMode, selectMode } from "./selectMode";

function toSel(state: EditorState): { model: PageModel; lines: string[]; sel: Sel } {
  const { anchor, head } = state.selection.main;
  const pos = (offset: number): Pos => {
    const line = state.doc.lineAt(offset);
    return { line: line.number - 1, col: offset - line.from };
  };
  const model = state.field(pageModel);
  return { model, lines: linesOf(model), sel: { anchor: pos(anchor), head: pos(head) } };
}

function offsetOf(lines: string[], pos: Pos): number {
  let offset = 0;
  for (let i = 0; i < pos.line; i++) offset += lines[i]!.length + 1;
  return offset + pos.col;
}

/** Replaces only the lines that changed, so the undo history and the cursor stay sensible. */
function apply(view: EditorView, lines: string[], sel: Sel, result: Result, effects: StateEffect<unknown>[]): void {
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
    view.dispatch({ selection, effects });
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
  view.dispatch({ changes, selection, effects, userEvent: "input" });
}

function command(op: (model: PageModel, sel: Sel) => Result | null) {
  return (view: EditorView): boolean => {
    const { model, lines, sel } = toSel(view.state);
    const result = op(model, sel);
    if (!result) return false;
    // Blocks that are selected stay selected, and stay drawn as Markdown, after they move.
    apply(view, lines, sel, result, view.state.field(selectMode) ? [enterSelectMode.of(null)] : []);
    return true;
  };
}

/** `stay`: the key is taken even when there is nowhere to go, so that it does not move the cursor either. */
function selecting(op: (model: PageModel, sel: Sel) => Sel | null, stay = false) {
  return (view: EditorView): boolean => {
    if (stay && !view.state.field(selectMode)) return false;
    const { model, lines, sel } = toSel(view.state);
    const next = op(model, sel);
    if (!next) return stay;
    view.dispatch({
      selection: { anchor: offsetOf(lines, next.anchor), head: offsetOf(lines, next.head) },
      effects: enterSelectMode.of(null),
      scrollIntoView: true,
    });
    return true;
  };
}

/** Where the selected blocks start and end, as offsets. Not in the front matter, which is drawn as a title. */
function span(view: EditorView): { start: number; end: number } {
  const { model, lines, sel } = toSel(view.state);
  const { start, end } = selectedSpan(model, sel);
  const body = frontmatterEndOf(model) + 1;
  const first = Math.max(start.line, body);
  const to = Math.max(end.line, body);
  return { start: offsetOf(lines, { line: first, col: first === start.line ? start.col : 0 }), end: offsetOf(lines, to === end.line ? end : { line: to, col: lines[to]!.length }) };
}

/** Select mode only: ends it, with the cursor where `at` says and, for a character typed, the text added there. */
function editing(at: (view: EditorView) => number, text = "") {
  return (view: EditorView): boolean => {
    if (!view.state.field(selectMode)) return false;
    const pos = at(view);
    view.dispatch({
      changes: text ? { from: pos, insert: text } : undefined,
      selection: { anchor: pos + text.length },
      scrollIntoView: true,
      userEvent: text ? "input.type" : undefined,
    });
    return true;
  };
}

/** Enter in select mode: a new block under the selected ones, and the cursor in it. */
function addBlockBelow(view: EditorView): boolean {
  if (!view.state.field(selectMode)) return false;
  const { model, lines, sel } = toSel(view.state);
  const { at, insert, caret } = blockBelow(model, sel);
  const pos = offsetOf(lines, at);
  view.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + caret }, scrollIntoView: true, userEvent: "input" });
  return true;
}

export const blockKeymap: Extension = [
  selectMode,
  // What is typed in select mode goes to the start of the block, and never replaces the selection.
  EditorView.inputHandler.of((view, _from, _to, text) =>
    view.state.field(selectMode) ? editing((v) => span(v).start, text)(view) : false,
  ),
  Prec.high(
    keymap.of([
      { key: "Tab", run: command(indent) },
      { key: "Shift-Tab", run: command(outdent) },
      { key: "Alt-ArrowUp", run: command((m, s) => move(m, s, "up")) },
      { key: "Alt-ArrowDown", run: command((m, s) => move(m, s, "down")) },
      { key: "Escape", run: selecting(selectBlock) },
      { key: "ArrowUp", run: selecting((m, s) => stepBlock(m, s, "up"), true) },
      { key: "ArrowDown", run: selecting((m, s) => stepBlock(m, s, "down"), true) },
      { key: "Enter", run: addBlockBelow },
      { key: " ", run: editing((v) => span(v).start) },
      { key: "ArrowLeft", run: editing((v) => span(v).start) },
      { key: "ArrowRight", run: editing((v) => span(v).end) },
      { key: "Shift-ArrowUp", run: selecting((m, s) => extendBlocks(m, s, "up")) },
      { key: "Shift-ArrowDown", run: selecting((m, s) => extendBlocks(m, s, "down")) },
    ]),
  ),
];
