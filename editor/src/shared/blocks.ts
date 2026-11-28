// The edits that act on blocks: indent, outdent, move and select (spec §3). What a block is, where it
// starts and ends and what holds what is not decided here: it is read from the page model
// (`shared/pageModel.ts`), the one reading of the page that Escape, Tab, Alt+Up/Down, folds and zoom all
// ask, so they cannot disagree about, say, whether a paragraph after a blank line is still part of a
// list item. An edit answers a `BlockEdit` (`shared/blockEdit.ts`): the `ChangeSet` over the page's text,
// and where text moved to. A position is an offset into the page, in and out, so they can be tested
// without a window and the editor needs no line numbers of its own.
//
// In the model a paragraph owns the list that starts on the line right beneath it, and a list item owns
// the items, fences, quotes and callouts nested under it, so moving a block moves what it owns. A heading
// owns its section: Alt+Up/Down moves the heading with everything under it, and Escape first takes the
// heading line, then the section. A list is not a node; where a list was, a run of item siblings is.

import { ChangeSet, type Text } from "@codemirror/state";

import { type BlockEdit, swapRanges } from "./blockEdit";
import type { PageModel, PageNode } from "./pageModel";
import { parsePage } from "./pageText";

/** A selection of the page, as offsets. */
export interface Sel {
  anchor: number;
  head: number;
}

const ITEM = /^( *)([-*+]|\d{1,9}[.)])( +|$)/;

function width(line: string): number {
  return (/^ */.exec(line)?.[0] ?? "").length;
}

function blank(line: string | undefined): boolean {
  return line === undefined || line.trim() === "";
}

/** The text of a line (0-based) of the page the model was made from. */
function lineText(model: PageModel, line: number): string {
  return model.doc.line(line + 1).text;
}

/** The last line of the front matter of a model, or -1 when the page has none. */
export function frontmatterEndOf(model: PageModel): number {
  const first = model.root.children[0];
  return first?.kind === "frontmatter" ? first.endLine - 1 : -1;
}

// ---- nodes as lines ------------------------------------------------------------------------
// The model counts lines from 1; the edits here count from 0, like the arrays they work on.

const startOf = (n: PageNode): number => n.startLine - 1;
/** The last line of a node with everything it owns: for a heading, its whole section. */
const endOf = (n: PageNode): number => n.endLine - 1;
/** The last line of the node itself: for a heading, the heading. */
const ownEnd = (n: PageNode): number => (n.kind === "section" ? startOf(n) : endOf(n));

/** What block selection and moving act on: everything but the page and its front matter. */
function movable(n: PageNode | null | undefined): n is PageNode {
  return !!n && n.kind !== "page" && n.kind !== "frontmatter";
}

/** The innermost block that holds `line`, the front matter included. A line that nothing holds, a blank line between blocks or under a heading, has none. */
export function blockAt(model: PageModel, line: number): PageNode | null {
  const n = model.nodeAtLine(line + 1);
  if (n.kind === "page") return null;
  if (n.kind === "section" && startOf(n) !== line) return null;
  return n;
}

/** What block selection and moving act on at `line`: the innermost item or top-level block. */
export function selectableAt(model: PageModel, line: number): PageNode | null {
  const b = blockAt(model, line);
  return movable(b) ? b : null;
}

function siblingsOf(n: PageNode): readonly PageNode[] {
  return n.parent ? n.parent.children : [n];
}

/** The block before or after `n` under the same parent, whatever it is, or null at the end. */
function sibling(n: PageNode, dir: "up" | "down"): PageNode | null {
  const s = siblingsOf(n);
  const p = s[s.indexOf(n) + (dir === "down" ? 1 : -1)];
  return movable(p) ? p : null;
}

/** The block that `n` can swap places with: an item with an item of its list, anything else with anything but an item. */
function previous(n: PageNode): PageNode | null {
  const p = sibling(n, "up");
  return p && (p.kind === "item") === (n.kind === "item") ? p : null;
}

function next(n: PageNode): PageNode | null {
  const p = sibling(n, "down");
  return p && (p.kind === "item") === (n.kind === "item") ? p : null;
}

/** Whether `n` sits in a quote, a callout or a footnote: its lines start with something other than the item's own indent. */
function inContainer(n: PageNode): boolean {
  for (const a of n.ancestors()) if (a.kind === "quote" || a.kind === "callout" || a.kind === "footnote") return true;
  return false;
}

/** Whether the line is a heading's own line. */
function isHeadingLine(model: PageModel, line: number): boolean {
  const n = model.nodeAtLine(line + 1);
  return n.kind === "section" && startOf(n) === line;
}

/** The lines of a selection (0-based, both included); one that ends at column 0 of a later line does not touch that line. */
function selectedLines(model: PageModel, sel: Sel): [number, number] {
  const a = model.doc.lineAt(Math.min(sel.anchor, sel.head));
  const b = model.doc.lineAt(Math.max(sel.anchor, sel.head));
  const last = b.from === Math.max(sel.anchor, sel.head) && b.number > a.number ? b.number - 2 : b.number - 1;
  return [a.number - 1, last];
}

/**
 * The top-most blocks that cover the lines, so a block and its children are not edited twice. With
 * `sections`, a heading counts as the section it owns; without, as its own line, and what is under it
 * is looked at on its own.
 */
function topmost(model: PageModel, from: number, to: number, sections: boolean): PageNode[] {
  const found: PageNode[] = [];
  let line = from;
  while (line <= to) {
    const b = selectableAt(model, line);
    if (!b) {
      line++;
      continue;
    }
    // Climb to the highest block that starts inside the selection.
    let top = b;
    while (top.parent && movable(top.parent) && (sections || top.parent.kind !== "section") && startOf(top.parent) >= from) top = top.parent;
    if (!found.includes(top)) found.push(top);
    line = (top.kind === "section" && !sections ? startOf(top) : endOf(top)) + 1;
  }
  return found;
}

function inEditableText(model: PageModel, from: number, to: number): boolean {
  for (let line = from; line <= to; line++) {
    const b = blockAt(model, line);
    if (b && (b.kind === "frontmatter" || b.kind === "code" || b.kind === "math")) return false;
  }
  return true;
}

function hasTab(model: PageModel, from: number, to: number): boolean {
  for (let i = from; i <= to; i++) if (/^ *\t/.test(lineText(model, i))) return true;
  return false;
}

/** Where the text of an item starts: the indent of a child that nests under it. */
function textOffset(line: string): number {
  const m = ITEM.exec(line);
  if (!m) return 0;
  const w = m[1]!.length;
  // A marker with nothing after it, or with five spaces or more, has its text one space in.
  return m[3]!.length === 0 || m[3]!.length > 4 ? w + m[2]!.length + 1 : m[0].length;
}

function marker(model: PageModel, n: PageNode): string {
  return ITEM.exec(lineText(model, startOf(n)))?.[0] ?? "";
}

/**
 * The changes of an edit that rewrites the start of lines (indent, a list marker) and adds blank lines,
 * worked out on the page as it was. Each line is rewritten at most once, so every change is in the
 * coordinates of the page the edit started from. `lines` is the page as the edit has it so far, for
 * reading it again between steps.
 */
class LineEdits {
  readonly lines: string[];
  private readonly specs: { from: number; to: number; insert: string }[] = [];

  constructor(private readonly doc: Text) {
    this.lines = [...doc.iterLines()];
  }

  /** Replaces the first `take` characters of a line with `put`. */
  head(line: number, take: number, put: string): void {
    const from = this.doc.line(line + 1).from;
    this.specs.push({ from, to: from + take, insert: put });
    this.lines[line] = put + this.lines[line]!.slice(take);
  }

  /** Adds (or, when negative, removes) leading spaces on every non-blank line in the range. */
  shift(start: number, end: number, by: number): void {
    for (let i = start; i <= end; i++) {
      if (blank(this.lines[i])) continue;
      if (by >= 0) this.head(i, 0, " ".repeat(by));
      else this.head(i, Math.min(-by, width(this.lines[i]!)), "");
    }
  }

  /** A blank line before `line`. */
  blankBefore(line: number): void {
    const from = this.doc.line(line + 1).from;
    this.specs.push({ from, to: from, insert: "\n" });
  }

  done(): BlockEdit {
    // In page order, an insertion before a replacement that starts at the same place.
    const sorted = [...this.specs].sort((a, b) => a.from - b.from || a.to - b.to);
    return { changes: ChangeSet.of(sorted, this.doc.length), moves: [] };
  }
}

/**
 * Tab. On a paragraph it starts a list, on a list item it nests the item (and what is
 * under it) beneath the item before it, and on an empty line it starts a list item.
 * Returns null when the selection is not ordinary text, so Tab can act as usual there.
 */
export function indent(model: PageModel, sel: Sel): BlockEdit | null {
  const [from, to] = selectedLines(model, sel);
  if (!model.complete || !inEditableText(model, from, to) || hasTab(model, from, to)) return null;
  const edits = new LineEdits(model.doc);
  const lines = edits.lines.slice();

  if (from === to && blank(lines[from])) {
    const above = from > 0 && !blank(lines[from - 1]) ? selectableAt(model, from - 1) : null;
    const pad = above && above.kind === "item" && !inContainer(above) ? textOffset(lines[startOf(above)]!) : 0;
    edits.head(from, lines[from]!.length, `${" ".repeat(pad)}- `);
    return edits.done();
  }

  // Forward, because an item that has just been nested is a child of the one before.
  let current = model;
  for (const target of topmost(model, from, to, false)) {
    const b = selectableAt(current, startOf(target));
    const at = b && startOf(b) === startOf(target) ? b : null;
    if (!at || inContainer(at)) continue;
    if (at.kind === "item") {
      const before = previous(at);
      if (!before || before.kind !== "item") continue;
      edits.shift(startOf(at), endOf(at), textOffset(edits.lines[startOf(before)]!) - width(edits.lines[startOf(at)]!));
    } else if (at.kind === "paragraph") {
      // The paragraph becomes an item, and its lines and the list it owns nest under the marker.
      edits.head(startOf(at), width(lines[startOf(at)]!), "- ");
      for (let i = startOf(at) + 1; i <= endOf(at); i++) if (!blank(lines[i])) edits.head(i, 0, "  ");
    }
    current = parsePage(edits.lines.join("\n"));
  }
  return edits.done();
}

/**
 * Shift+Tab. A nested item moves out one level. An item at the top level stops being a
 * list item and becomes a plain paragraph again; what was nested under it moves out with it.
 */
export function outdent(model: PageModel, sel: Sel): BlockEdit | null {
  const [from, to] = selectedLines(model, sel);
  if (!model.complete || !inEditableText(model, from, to) || hasTab(model, from, to)) return null;
  const targets = topmost(model, from, to, false).filter((b) => b.kind === "item" && !inContainer(b));

  const edits = new LineEdits(model.doc);
  const lines = edits.lines.slice();
  const inserted = new Set<number>();
  for (const b of targets) {
    const parent = b.parent;
    const indentOf = width(lines[startOf(b)]!);
    if (parent && parent.kind === "item") {
      edits.shift(startOf(b), endOf(b), width(lines[startOf(parent)]!) - indentOf);
    } else if (indentOf > 0) {
      edits.shift(startOf(b), endOf(b), -indentOf);
    } else {
      const m = marker(model, b);
      edits.head(startOf(b), m.length, "");
      edits.shift(startOf(b) + 1, endOf(b), -m.length);
      const above = startOf(b) - 1;
      const below = endOf(b) + 1;
      if (above >= 0 && !blank(lines[above]) && !isHeadingLine(model, above)) inserted.add(startOf(b));
      if (below < lines.length && !blank(lines[below]) && !isHeadingLine(model, below)) inserted.add(below);
    }
  }
  for (const at of inserted) edits.blankBefore(at);
  return edits.done();
}

/** The range of the text that lines `first` to `last` (0-based) take, from the start of the first to the end of the last. */
function lineRange(doc: Text, first: number, last: number): { from: number; to: number } {
  return { from: doc.line(first + 1).from, to: doc.line(last + 1).to };
}

/**
 * The lines that a block swaps places with when it moves, or null when it stays. Beside a sibling it is
 * that sibling and what it owns, and a heading takes its section with it. A block that is the first or the
 * last under a heading moves out of that section, past the heading line of its own section or of the next
 * one, and a block that moves up to a section enters it: the same step, taken backwards.
 */
function swapTarget(n: PageNode, dir: "up" | "down"): [number, number] | null {
  const s = dir === "up" ? previous(n) : next(n);
  if (s) return n.kind !== "section" && s.kind === "section" ? [startOf(s), startOf(s)] : [startOf(s), endOf(s)];
  if (n.kind === "item" || n.kind === "section") return null;
  // Nothing beside it: the heading of its section, or the one that comes after the section.
  for (let x = n.parent; x?.kind === "section"; x = dir === "down" ? x.parent : null) {
    const h = dir === "up" ? x : sibling(x, "down");
    if (h?.kind === "section") return [startOf(h), startOf(h)];
  }
  return null;
}

/** Nothing changes, and nothing moves. */
function stays(model: PageModel): BlockEdit {
  return { changes: ChangeSet.empty(model.doc.length), moves: [] };
}

/** Alt+Up / Alt+Down: moves the block, and what it owns, past its neighbour. A heading takes its section. */
export function move(model: PageModel, sel: Sel, dir: "up" | "down"): BlockEdit | null {
  const [from, to] = selectedLines(model, sel);
  if (!model.complete || !inEditableText(model, from, to)) return null;
  const group = selectedGroup(model, from, to);
  if (!group) return stays(model);
  const first = group[0]!;
  const last = group[group.length - 1]!;
  const span: [number, number] = [startOf(first), endOf(last)];
  const target = swapTarget(dir === "up" ? first : last, dir);
  if (!target) return stays(model);
  const [a, b] = dir === "up" ? [target, span] : [span, target];
  const edit = swapRanges(model.doc, lineRange(model.doc, ...a), lineRange(model.doc, ...b));
  // A rule that ends up on the first line, with another rule below it, would turn everything
  // between them into front matter. Moving does not do that: the block stays where it is.
  const moved = parsePage(edit.changes.apply(model.doc).toString());
  return frontmatterEndOf(moved) === frontmatterEndOf(model) ? edit : stays(model);
}

/** The selected blocks when they are neighbours; otherwise the block at the first line. */
function selectedGroup(model: PageModel, from: number, to: number): PageNode[] | null {
  const found = topmost(model, from, to, true);
  if (found.length === 0) return null;
  const first = found[0]!;
  const level = siblingsOf(first);
  const consecutive = found.every((b, i) => siblingsOf(b) === level && (i === 0 || level.indexOf(b) === level.indexOf(found[i - 1]!) + 1));
  return consecutive ? found : [first];
}

/** A text to put in the page, where (an offset), and where the cursor goes inside it. */
export interface Insertion {
  at: number;
  insert: string;
  caret: number;
}

/**
 * Shift+Enter: a new line above the line at `pos`, with the cursor in it. Above an item it is another item
 * of the same list (a task unticked); above the first line of any other block a paragraph, set apart by a
 * blank line; above a line inside a block a plain line. Null in the front matter, where nothing opens above.
 */
export function lineAbove(model: PageModel, pos: number): Insertion | null {
  const doc = model.doc;
  const line = doc.lineAt(pos);
  const node = model.nodeAtLine(line.number);
  if (node.kind === "frontmatter") return null;
  const m = node.kind === "item" && node.startLine === line.number ? ITEM.exec(line.text) : null;
  if (m) {
    const task = /^ *[-*+] +\[[ xX]\]/.test(line.text) ? "[ ] " : "";
    const prefix = `${m[1]}${m[2]} ${task}`;
    return { at: line.from, insert: `${prefix}\n`, caret: prefix.length };
  }
  const startsBlock = line.number === 1 || blank(doc.line(line.number - 1).text);
  return { at: line.from, insert: startsBlock ? "\n\n" : "\n", caret: 0 };
}
