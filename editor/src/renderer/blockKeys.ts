// The keys that act on blocks, as one table. Each key says what it does while editing and what it does in
// select mode (renderer/selectMode.ts: blocks selected as blocks), and `respond(state, key)` is the whole
// state machine: a function of the state and the key that answers a transaction, or says the key is not
// taken. The wiring below is only a keymap that asks it. A key that is not in the table, in either mode,
// leaves select mode if it moves the selection or changes the text (that is the rule in selectMode.ts), so
// every way out is listed here: Enter, Space, Left, Right, a character, Backspace's and Delete's last block,
// Escape with nothing left to widen. The logic of the edits is in shared/blocks.ts (Tab, Shift+Tab,
// Alt+Up/Down) and of the selection in shared/blockSelection.ts; both read the page model.
//
// Escape is resolved here, in this order: a menu or popup that is open takes it first (they bind it above
// this keymap), then the block selection widens (the block, its parent, the section, the page), and only
// when there is nothing left to widen is focus mode left, through `leaveFocus`.

import { ChangeSet, type EditorState, type Extension, Facet, Prec, type TransactionSpec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

import {
  type BlockSelection,
  extendBlock,
  makeSelection,
  membersOf,
  selectedLines,
  selectedSpan,
  stepBlock,
  removalRange,
  widenBlock,
} from "../shared/blockSelection";
import {
  type Pos,
  type Result,
  type Sel,
  blockBelow,
  indent,
  linesOf,
  mapPos,
  move,
  outdent,
} from "../shared/blocks";
import { toggleTask } from "../shared/format";
import type { PageModel, PageNode } from "../shared/pageModel";
import { parsePage } from "../shared/pageText";
import { pageModel } from "./pageModelField";
import { blockSelection, isSelecting, selectLinesSpec, selectModeState, selectionSpec, visibleIn } from "./selectMode";

/** Asked when Escape has nothing left to widen: leaves focus mode and says it did. */
export const leaveFocus = Facet.define<() => boolean>();

/** The key is taken, and nothing happens: it must not move the cursor either. */
export const STAY: unique symbol = Symbol("stay");
/** Escape found nothing to widen: the next stop is focus mode. */
export const LEAVE: unique symbol = Symbol("leave");

/** What a key does: a transaction, nothing (STAY), or the key is not taken (null). */
export type Reply = TransactionSpec | typeof STAY | typeof LEAVE | null;
export type Action = (state: EditorState) => Reply;

// ---- the page as the edits read it -----------------------------------------------------------

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

/** The change that turns `lines` into the lines of `result`, replacing only the lines that differ, so the undo history and the cursor stay sensible. */
function rowsChange(lines: string[], docLength: number, result: Result): { from: number; to: number; insert: string } | null {
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
  if (head + tail >= lines.length && head + tail >= next.length) return null;
  const oldEnd = lines.length - tail;
  const newEnd = next.length - tail;
  const lineStart = (line: number) => offsetOf(lines, { line, col: 0 });
  const added = next.slice(head, newEnd).join("\n");
  if (oldEnd > head) {
    // Some lines are replaced, or removed when nothing takes their place.
    const from = lineStart(head);
    const to = lineStart(oldEnd - 1) + lines[oldEnd - 1]!.length;
    if (newEnd > head) return { from, to, insert: added };
    if (oldEnd < lines.length) return { from, to: to + 1, insert: "" };
    return { from: Math.max(0, from - 1), to, insert: "" };
  }
  if (head < lines.length) return { from: lineStart(head), to: lineStart(head), insert: `${added}\n` };
  return { from: docLength, to: docLength, insert: `\n${added}` };
}

/**
 * Selects, after a change, the blocks that start on the lines `targets` says in the text the change makes.
 * The page is read again for that, with the reader the editor's model is made by. When no block is there
 * the selection is just where `fallback` puts the cursor, and the mode ends.
 */
function afterChange(
  state: EditorState,
  changes: ChangeSet,
  targets: { anchor: number; head: number; heading?: boolean } | null,
  fallback: number,
): TransactionSpec {
  const doc = changes.apply(state.doc);
  const spec = targets ? selectLinesSpec(doc, parsePage(doc.toString()), targets) : null;
  return { changes, userEvent: "input", ...(spec ?? { selection: { anchor: Math.min(fallback, doc.length) }, scrollIntoView: true }) };
}

// ---- the table's actions -----------------------------------------------------------------------

/** Tab, Shift+Tab, Alt+Up/Down: an edit of the blocks at the cursor, or of the selected ones (which stay selected). */
function blockEdit(op: (model: PageModel, sel: Sel) => Result | null): Action {
  return (state) => {
    const { model, lines, sel } = toSel(state);
    const result = op(model, sel);
    if (!result) return null;
    const change = rowsChange(lines, state.doc.length, result);
    const changes = ChangeSet.of(change ? [change] : [], state.doc.length);
    const blocks = state.field(blockSelection, false);
    // Nothing changed (the first block cannot move up, or the two blocks that swapped read the same): the selection stays as it is.
    if (blocks && !change) return STAY;
    if (blocks) {
      // The same blocks, wherever their lines went.
      const at = (n: { startLine: number }) => mapPos(result, { line: n.startLine - 1, col: 0 }).line + 1;
      return afterChange(state, changes, { anchor: at(blocks.anchor), head: at(blocks.head), heading: blocks.heading }, state.selection.main.head);
    }
    const next = result.rows.map((r) => r.text);
    const selection = {
      anchor: offsetOf(next, mapPos(result, sel.anchor)),
      head: offsetOf(next, mapPos(result, sel.head)),
    };
    return change ? { changes: change, selection, userEvent: "input" } : { selection };
  };
}

/** Escape: select the block at the cursor, and each time the one around it; at the end, on to focus mode. */
const escape: Action = (state) => {
  const model = state.field(pageModel);
  const blocks = state.field(blockSelection, false);
  const { from, to } = state.selection.main;
  const next = widenBlock(model, blocks ? selectedSpan(model, blocks) : { from, to }, visibleIn(state));
  return next ? selectionSpec(state, next) : LEAVE;
};

/** Up and Down in select mode: the block before or after, in reading order, as far as it is shown. */
const step =
  (dir: "up" | "down"): Action =>
  (state) => {
    const blocks = state.field(blockSelection, false);
    if (!blocks) return null;
    const next = stepBlock(state.field(pageModel), blocks, dir, visibleIn(state));
    return next ? selectionSpec(state, next) : STAY;
  };

/** Shift+Up and Shift+Down in select mode: take in the next block, or the parent, or give one back. */
const extend =
  (dir: "up" | "down"): Action =>
  (state) => {
    const blocks = state.field(blockSelection, false);
    if (!blocks) return null;
    const next = extendBlock(blocks, dir, visibleIn(state));
    return next ? selectionSpec(state, next) : STAY;
  };

/** The first and the last character of the selected blocks: where Space, Left and Right put the cursor. */
function edge(end: boolean): Action {
  return (state) => {
    const blocks = state.field(blockSelection, false);
    if (!blocks) return null;
    const span = selectedSpan(state.field(pageModel), blocks);
    return { selection: { anchor: end ? span.to : span.from }, scrollIntoView: true };
  };
}

/** Enter in select mode: a new block below the selected ones, and the cursor in it. */
const addBlockBelow: Action = (state) => {
  if (!isSelecting(state)) return null;
  const { model, lines, sel } = toSel(state);
  const { at, insert, caret } = blockBelow(model, sel);
  const pos = offsetOf(lines, at);
  return { changes: { from: pos, insert }, selection: { anchor: pos + caret }, scrollIntoView: true, userEvent: "input" };
};

/** What removing the selected blocks does: the change, and the blocks to select in the page that is left (the next one, or the one before at the end). */
function removing(state: EditorState, blocks: BlockSelection): TransactionSpec {
  const model = state.field(pageModel);
  const visible = visibleIn(state);
  const [first, last] = selectedLines(blocks);
  const range = removalRange(state.doc, first, last);
  const changes = ChangeSet.of([{ from: range.from, to: range.to }], state.doc.length);
  const doc = changes.apply(state.doc);
  const next = stepBlock(model, blocks, "down", visible);
  const before = next ? null : stepBlock(model, blocks, "up", visible);
  // Lines before the cut stay where they were, and the ones after move up by what was cut.
  const line = next ? doc.lineAt(changes.mapPos(state.doc.line(next.anchor.startLine).from, 1)).number : (before?.anchor.startLine ?? 0);
  const target = next ?? before;
  const spec = target
    ? afterChange(state, changes, { anchor: line, head: line, heading: target.heading }, range.from)
    : { changes, selection: { anchor: Math.min(range.from, doc.length) }, userEvent: "delete" };
  return { ...spec, userEvent: "delete" };
}

/** Backspace and Delete in select mode: the blocks go, and select mode stays. */
const remove: Action = (state) => {
  const blocks = state.field(blockSelection, false);
  return blocks ? removing(state, blocks) : null;
};

/** What Ctrl+X takes: the text of the blocks as Markdown, and the transaction that removes them. */
export function cutBlocks(state: EditorState): { text: string; spec: TransactionSpec } | null {
  const blocks = state.field(blockSelection, false);
  if (!blocks) return null;
  const { from, to } = selectedSpan(state.field(pageModel), blocks);
  return { text: state.sliceDoc(from, to), spec: removing(state, blocks) };
}

/** Ctrl+D in select mode: a copy under the selected blocks, and the copy is what is selected. */
const duplicate: Action = (state) => {
  const blocks = state.field(blockSelection, false);
  if (!blocks) return null;
  const [first, last] = selectedLines(blocks);
  const text = state.sliceDoc(state.doc.line(first + 1).from, state.doc.line(last + 1).to);
  // Items go on the next line, as one more item; anything else is set apart by a blank line.
  const sep = membersOf(blocks).every((n) => n.kind === "item") ? "\n" : "\n\n";
  const changes = ChangeSet.of([{ from: state.doc.line(last + 1).to, insert: sep + text }], state.doc.length);
  const start = last + 1 + sep.length;
  const at = (n: { startLine: number }) => start + n.startLine - 1 - first;
  return afterChange(state, changes, { anchor: at(blocks.anchor), head: at(blocks.head), heading: blocks.heading }, state.selection.main.head);
};

/** Ctrl+Enter in select mode: ticks or unticks the selected items (a plain item becomes a task). */
const tick: Action = (state) => {
  const blocks = state.field(blockSelection, false);
  if (!blocks) return null;
  const edits = membersOf(blocks).flatMap((n) => {
    if (n.kind !== "item") return [];
    const line = state.doc.line(n.startLine);
    const edit = toggleTask(line.text);
    return edit ? [{ from: line.from, to: line.to, insert: edit.text }] : [];
  });
  if (edits.length === 0) return STAY;
  const changes = ChangeSet.of(edits, state.doc.length);
  return afterChange(state, changes, { anchor: blocks.anchor.startLine, head: blocks.head.startLine, heading: blocks.heading }, state.selection.main.head);
};

/** A character typed in select mode goes to the start of the blocks, and never replaces them. */
export function typed(state: EditorState, text: string): TransactionSpec | null {
  const blocks = state.field(blockSelection, false);
  if (!blocks) return null;
  const { from } = selectedSpan(state.field(pageModel), blocks);
  return { changes: { from, insert: text }, selection: { anchor: from + text.length }, scrollIntoView: true, userEvent: "input.type" };
}

/** Shift+click on a block in select mode: the selection is taken from its anchor to that block. */
export function extendTo(state: EditorState, pos: number): TransactionSpec | null {
  const blocks = state.field(blockSelection, false);
  if (!blocks) return null;
  const model = state.field(pageModel);
  // The block at the click: what holds the position, out to the first that can be selected.
  let node: PageNode | null = model.nodeAt(pos);
  while (node && (node.kind === "page" || node.kind === "frontmatter")) node = node.parent;
  if (!node || !visibleIn(state)(node)) return null;
  const next = makeSelection(blocks.anchor, node);
  return next ? selectionSpec(state, next) : null;
}

// ---- the table ------------------------------------------------------------------------------

export const KEYS = [
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "Shift-ArrowUp",
  "Shift-ArrowDown",
  "Enter",
  " ",
  "ArrowLeft",
  "ArrowRight",
  "Backspace",
  "Delete",
  "Tab",
  "Shift-Tab",
  "Alt-ArrowUp",
  "Alt-ArrowDown",
  "Mod-d",
  "Mod-Enter",
] as const;
export type Key = (typeof KEYS)[number];

/** What each key does while editing (the text, or the block at the cursor) and in select mode. A key with no action in a mode is CodeMirror's. */
const TABLE: Record<Key, { editing?: Action; selecting?: Action }> = {
  Escape: { editing: escape, selecting: escape },
  ArrowUp: { selecting: step("up") },
  ArrowDown: { selecting: step("down") },
  "Shift-ArrowUp": { selecting: extend("up") },
  "Shift-ArrowDown": { selecting: extend("down") },
  Enter: { selecting: addBlockBelow },
  " ": { selecting: edge(false) },
  ArrowLeft: { selecting: edge(false) },
  ArrowRight: { selecting: edge(true) },
  Backspace: { selecting: remove },
  Delete: { selecting: remove },
  Tab: { editing: blockEdit(indent), selecting: blockEdit(indent) },
  "Shift-Tab": { editing: blockEdit(outdent), selecting: blockEdit(outdent) },
  "Alt-ArrowUp": { editing: blockEdit((m, s) => move(m, s, "up")), selecting: blockEdit((m, s) => move(m, s, "up")) },
  "Alt-ArrowDown": { editing: blockEdit((m, s) => move(m, s, "down")), selecting: blockEdit((m, s) => move(m, s, "down")) },
  "Mod-d": { selecting: duplicate },
  "Mod-Enter": { selecting: tick },
};

/** What `key` does in `state`: the whole machine, with no window. The mode is whether blocks are selected. */
export function respond(state: EditorState, key: Key): Reply {
  const row = TABLE[key];
  const action = isSelecting(state) ? row.selecting : row.editing;
  return action ? action(state) : null;
}

// ---- the keymap ------------------------------------------------------------------------------

/** Escape had nothing to widen: focus mode, if it is on; else select mode ends, with the cursor at the start of the blocks. */
function leave(view: EditorView): boolean {
  if (view.state.facet(leaveFocus).some((f) => f())) return true;
  const blocks = view.state.field(blockSelection, false);
  if (!blocks) return false;
  const { from } = selectedSpan(view.state.field(pageModel), blocks);
  view.dispatch({ selection: { anchor: from }, scrollIntoView: true });
  return true;
}

function binding(key: Key) {
  return {
    key,
    run(view: EditorView): boolean {
      const reply = respond(view.state, key);
      if (reply === null) return false;
      if (reply === LEAVE) return leave(view);
      if (reply !== STAY) view.dispatch(reply);
      return true;
    },
  };
}

/** The keys of select mode that CodeMirror's own bindings (find, ticking a task) would otherwise take. */
const BEFORE_OTHERS: Key[] = ["Mod-d", "Mod-Enter"];

export const blockKeymap: Extension = [
  selectModeState,
  // What is typed in select mode goes to the start of the blocks, and never replaces them.
  EditorView.inputHandler.of((view, _from, _to, text) => {
    const spec = typed(view.state, text);
    if (!spec) return false;
    view.dispatch(spec);
    return true;
  }),
  EditorView.domEventHandlers({
    // Cut takes the whole blocks, as Markdown, and they go: the selected text is not what is selected.
    cut(event, view) {
      const cut = cutBlocks(view.state);
      if (!cut || !event.clipboardData) return false;
      event.clipboardData.setData("text/plain", cut.text);
      event.preventDefault();
      view.dispatch(cut.spec);
      return true;
    },
    // Shift+click on another block takes in everything between. (A drag stays a text selection.)
    mousedown(event, view) {
      if (!event.shiftKey || !isSelecting(view.state)) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      const spec = pos === null ? null : extendTo(view.state, pos);
      if (!spec) return false;
      event.preventDefault();
      view.dispatch(spec);
      return true;
    },
  }),
  Prec.highest(keymap.of(BEFORE_OTHERS.map(binding))),
  Prec.high(keymap.of(KEYS.filter((k) => !BEFORE_OTHERS.includes(k)).map(binding))),
];
