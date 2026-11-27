// The edits that act on blocks: indent, outdent, move and select (spec §3). What a block is, where it
// starts and ends and what holds what is not decided here: it is read from the page model
// (`shared/pageModel.ts`), the one reading of the page that Escape, Tab, Alt+Up/Down, folds and zoom all
// ask, so they cannot disagree about, say, whether a paragraph after a blank line is still part of a
// list item. The edits themselves work on an array of lines and return the lines that result, so they can
// be tested without an editor.
//
// In the model a paragraph owns the list that starts on the line right beneath it, and a list item owns
// the items, fences, quotes and callouts nested under it, so moving a block moves what it owns. A heading
// owns its section: Alt+Up/Down moves the heading with everything under it, and Escape first takes the
// heading line, then the section. A list is not a node; where a list was, a run of item siblings is.

import type { Text } from "@codemirror/state";

import type { PageModel, PageNode } from "./pageModel";
import { parsePage } from "./pageText";

export interface Pos {
  line: number;
  col: number;
}

export interface Sel {
  anchor: Pos;
  head: Pos;
}

/** A line of the result and where it came from, so the selection can follow the text. */
export interface Row {
  text: string;
  /** Index of the line in the input, or -1 for a line that was added. */
  from: number;
  /** How far the columns of that line moved. */
  dcol: number;
}

const ITEM = /^( *)([-*+]|\d{1,9}[.)])( +|$)/;

function width(line: string): number {
  return (/^ */.exec(line)?.[0] ?? "").length;
}

function blank(line: string | undefined): boolean {
  return line === undefined || line.trim() === "";
}

const linesCache = new WeakMap<Text, string[]>();

/** The lines of the page the model was made from (the same array for the same version of the text). */
export function linesOf(model: PageModel): string[] {
  let lines = linesCache.get(model.doc);
  if (!lines) {
    lines = model.doc.toString().split("\n");
    linesCache.set(model.doc, lines);
  }
  return lines;
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

/** Whether items under `parent` are a list of their own: at the top of a page or a section. (An item that holds items has its children for them, a paragraph the list it owns.) */
function listsIn(parent: PageNode | null): boolean {
  return parent === null || parent.kind === "page" || parent.kind === "section";
}

/** The run of items that starts at `n` (going down) or ends at it (going up): what a list was. */
function itemRun(n: PageNode, dir: "up" | "down"): PageNode[] {
  const s = siblingsOf(n);
  const run: PageNode[] = [];
  for (let i = s.indexOf(n); s[i]?.kind === "item"; i += dir === "down" ? 1 : -1) run.push(s[i]!);
  return dir === "down" ? run : run.reverse();
}

/** Whether the items from `first` to `last` are a whole list: the run of items they are in begins at the one and ends at the other. */
function wholeList(first: PageNode, last: PageNode): boolean {
  return first.kind === "item" && last.kind === "item" && listsIn(first.parent) && sibling(first, "up")?.kind !== "item" && sibling(last, "down")?.kind !== "item";
}

/**
 * Shift+Up / Shift+Down take a whole list in one step, as a paragraph or a heading is taken, when the
 * selection comes to it from outside. (From an item, the next block is the next item; from a whole
 * list, whatever is beside it.) The answer is the blocks to take in, or null when there is nothing there.
 */
function neighbour(n: PageNode, dir: "up" | "down", list = false): PageNode[] | null {
  const m = sibling(n, dir);
  if (!m) return null;
  if (m.kind === "item") return n.kind === "item" || !listsIn(m.parent) ? [m] : itemRun(m, dir);
  return n.kind === "item" && !list ? null : [m];
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

function rows(lines: string[]): Row[] {
  return lines.map((text, from) => ({ text, from, dcol: 0 }));
}

/** Adds (or, when negative, removes) leading spaces on every non-blank line in the range. */
function shiftLines(out: Row[], start: number, end: number, by: number): void {
  for (let i = start; i <= end; i++) {
    const row = out[i]!;
    if (blank(row.text)) continue;
    if (by >= 0) {
      row.text = " ".repeat(by) + row.text;
      row.dcol += by;
    } else {
      const take = Math.min(-by, width(row.text));
      row.text = row.text.slice(take);
      row.dcol -= take;
    }
  }
}

export interface Result {
  rows: Row[];
}

/** Where a position ends up after an edit. */
export function mapPos(result: Result, pos: Pos): Pos {
  const index = result.rows.findIndex((r) => r.from === pos.line);
  if (index < 0) return { line: Math.min(pos.line, result.rows.length - 1), col: 0 };
  const row = result.rows[index]!;
  return { line: index, col: Math.max(0, Math.min(pos.col + row.dcol, row.text.length)) };
}

/** The lines a selection touches; a selection that ends at column 0 does not touch that line. */
function selectedLines(sel: Sel): [number, number] {
  const [a, b] = ordered(sel);
  const last = b.col === 0 && b.line > a.line ? b.line - 1 : b.line;
  return [a.line, last];
}

function ordered(sel: Sel): [Pos, Pos] {
  const { anchor: a, head: h } = sel;
  return a.line < h.line || (a.line === h.line && a.col <= h.col) ? [a, h] : [h, a];
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

function hasTab(lines: string[], from: number, to: number): boolean {
  for (let i = from; i <= to; i++) if (/^ *\t/.test(lines[i]!)) return true;
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

function marker(lines: string[], n: PageNode): string {
  return ITEM.exec(lines[startOf(n)]!)?.[0] ?? "";
}

/**
 * Tab. On a paragraph it starts a list, on a list item it nests the item (and what is
 * under it) beneath the item before it, and on an empty line it starts a list item.
 * Returns null when the selection is not ordinary text, so Tab can act as usual there.
 */
export function indent(model: PageModel, sel: Sel): Result | null {
  const lines = linesOf(model);
  const [from, to] = selectedLines(sel);
  if (!model.complete || !inEditableText(model, from, to) || hasTab(lines, from, to)) return null;
  const out = rows(lines);

  if (from === to && blank(lines[from])) {
    const above = from > 0 && !blank(lines[from - 1]) ? selectableAt(model, from - 1) : null;
    const pad = above && above.kind === "item" && !inContainer(above) ? textOffset(lines[startOf(above)]!) : 0;
    out[from]!.text = `${" ".repeat(pad)}- `;
    out[from]!.dcol = out[from]!.text.length;
    return { rows: out };
  }

  // Forward, because an item that has just been nested is a child of the one before.
  let current = model;
  let text = lines;
  for (const target of topmost(model, from, to, false)) {
    const b = selectableAt(current, startOf(target));
    const at = b && startOf(b) === startOf(target) ? b : null;
    if (!at || inContainer(at)) continue;
    if (at.kind === "item") {
      const before = previous(at);
      if (!before || before.kind !== "item") continue;
      shiftLines(out, startOf(at), endOf(at), textOffset(text[startOf(before)]!) - width(text[startOf(at)]!));
    } else if (at.kind === "paragraph") {
      // The paragraph becomes an item, and its lines and the list it owns nest under the marker.
      out[startOf(at)]!.text = `- ${out[startOf(at)]!.text.trimStart()}`;
      out[startOf(at)]!.dcol += 2 - width(lines[startOf(at)]!);
      for (let i = startOf(at) + 1; i <= endOf(at); i++) {
        if (blank(out[i]!.text)) continue;
        out[i]!.text = `  ${out[i]!.text}`;
        out[i]!.dcol += 2;
      }
    }
    text = out.map((r) => r.text);
    current = parsePage(text.join("\n"));
  }
  return { rows: out };
}

/**
 * Shift+Tab. A nested item moves out one level. An item at the top level stops being a
 * list item and becomes a plain paragraph again; what was nested under it moves out with it.
 */
export function outdent(model: PageModel, sel: Sel): Result | null {
  const lines = linesOf(model);
  const [from, to] = selectedLines(sel);
  if (!model.complete || !inEditableText(model, from, to) || hasTab(lines, from, to)) return null;
  const targets = topmost(model, from, to, false).filter((b) => b.kind === "item" && !inContainer(b));

  // Bottom to top, so the lines that are added do not move the ones still to do.
  const out = rows(lines);
  const inserted: number[] = [];
  for (const b of [...targets].reverse()) {
    const parent = b.parent;
    const indentOf = width(lines[startOf(b)]!);
    if (parent && parent.kind === "item") {
      shiftLines(out, startOf(b), endOf(b), width(lines[startOf(parent)]!) - indentOf);
    } else if (indentOf > 0) {
      shiftLines(out, startOf(b), endOf(b), -indentOf);
    } else {
      const m = marker(lines, b);
      const first = out[startOf(b)]!;
      first.text = first.text.slice(m.length);
      first.dcol -= m.length;
      shiftLines(out, startOf(b) + 1, endOf(b), -m.length);
      const above = startOf(b) - 1;
      const below = endOf(b) + 1;
      if (above >= 0 && !blank(lines[above]) && !isHeadingLine(model, above)) inserted.push(startOf(b));
      if (below < lines.length && !blank(lines[below]) && !isHeadingLine(model, below)) inserted.push(below);
    }
  }
  // Add the blank lines, last position first.
  for (const at of [...new Set(inserted)].sort((a, b) => b - a)) out.splice(at, 0, { text: "", from: -1, dcol: 0 });
  return { rows: out };
}

/** The lines of a block, as a range with the blank lines between two neighbours. */
function swap(lines: string[], first: [number, number], second: [number, number]): Result {
  const out = rows(lines);
  const a = out.slice(first[0], first[1] + 1);
  const gap = out.slice(first[1] + 1, second[0]);
  const b = out.slice(second[0], second[1] + 1);
  out.splice(first[0], second[1] - first[0] + 1, ...b, ...gap, ...a);
  return { rows: out };
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

/** Alt+Up / Alt+Down: moves the block, and what it owns, past its neighbour. A heading takes its section. */
export function move(model: PageModel, sel: Sel, dir: "up" | "down"): Result | null {
  const lines = linesOf(model);
  const [from, to] = selectedLines(sel);
  if (!model.complete || !inEditableText(model, from, to)) return null;
  const group = selectedGroup(model, from, to);
  if (!group) return { rows: rows(lines) };
  const first = group[0]!;
  const last = group[group.length - 1]!;
  const span: [number, number] = [startOf(first), endOf(last)];
  const target = swapTarget(dir === "up" ? first : last, dir);
  if (!target) return { rows: rows(lines) };
  const result = dir === "up" ? swap(lines, target, span) : swap(lines, span, target);
  // A rule that ends up on the first line, with another rule below it, would turn everything
  // between them into front matter. Moving does not do that: the block stays where it is.
  const moved = parsePage(result.rows.map((r) => r.text).join("\n"));
  return frontmatterEndOf(moved) === frontmatterEndOf(model) ? result : { rows: rows(lines) };
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

function lineEnd(lines: string[], line: number): Pos {
  return { line, col: lines[line]!.length };
}

function cover(lines: string[], from: number, to: number): Sel {
  return { anchor: { line: from, col: 0 }, head: lineEnd(lines, to) };
}

/**
 * The blocks a selection of whole lines holds, as units (a unit is one block, or the run of items that
 * a list was), or null when it covers anything else: part of a line, or blocks that are not neighbours.
 * A heading is held by its own line or by the whole of its section.
 */
function aligned(model: PageModel, sel: Sel): PageNode[][] | null {
  const lines = linesOf(model);
  const [a, b] = ordered(sel);
  if (a.col !== 0 || b.col !== lines[b.line]!.length || (a.line === b.line && a.col === b.col)) return null;
  const first = selectableAt(model, a.line);
  if (!first || startOf(first) !== a.line) return null;
  let unit = [first];
  // A selection that starts at a list and goes to its end or past it holds the list, not its items.
  if (first.kind === "item" && listsIn(first.parent) && previous(first) === null) {
    const run = itemRun(first, "down");
    if (endOf(run[run.length - 1]!) <= b.line) unit = run;
  }
  const group = [unit];
  for (;;) {
    const last = unit[unit.length - 1]!;
    if (b.line === endOf(last) || b.line === ownEnd(last)) return group;
    if (endOf(last) > b.line) return null;
    const n = neighbour(last, "down", wholeList(unit[0]!, last));
    if (!n) return null;
    group.push(n);
    unit = n;
  }
}

/**
 * Every range Escape can widen to, as whole lines: each block (the items inside a list too), a heading
 * line and then the section it owns, each run of items (what a list was), and the whole page.
 */
function ranges(model: PageModel, lines: string[]): [number, number][] {
  const found: [number, number][] = [[0, lines.length - 1]];
  for (const n of model.nodes) {
    found.push([startOf(n), ownEnd(n)]);
    if (n.kind === "section") found.push([startOf(n), endOf(n)]);
  }
  for (const parent of [model.root, ...model.nodes].filter(listsIn)) {
    let run: PageNode[] = [];
    const flush = (): void => {
      if (run.length > 1) found.push([startOf(run[0]!), endOf(run[run.length - 1]!)]);
      run = [];
    };
    for (const c of parent.children) {
      if (c.kind === "item") run.push(c);
      else flush();
    }
    flush();
  }
  return found;
}

function before(a: Pos, b: Pos): boolean {
  return a.line < b.line || (a.line === b.line && a.col < b.col);
}

/**
 * Escape: selects the block at the cursor, and each time again the next one out: the item or
 * paragraph, the item that holds it, the list, the section under its heading, the section that
 * holds that, and in the end the whole page. Null when the whole page is selected already.
 */
export function selectBlock(model: PageModel, sel: Sel): Sel | null {
  const lines = linesOf(model);
  const [from, to] = ordered(sel);
  // A cursor in a gap between blocks has nothing to take in.
  if (from.line === to.line && from.col === to.col && !blockAt(model, from.line)) return null;
  let best: Sel | null = null;
  let size = Infinity;
  for (const [start, end] of ranges(model, lines)) {
    const first: Pos = { line: start, col: 0 };
    const last = lineEnd(lines, end);
    // It must hold the selection and be wider than it.
    if (before(from, first) || before(last, to) || (!before(first, from) && !before(to, last))) continue;
    if (end - start < size) {
      size = end - start;
      best = { anchor: first, head: last };
    }
  }
  return best;
}

/** Shift+Up / Shift+Down on a block selection: takes in the next block in that direction. */
export function extendBlocks(model: PageModel, sel: Sel, dir: "up" | "down"): Sel | null {
  const lines = linesOf(model);
  const group = aligned(model, sel);
  if (!group) return null;
  const [a, b] = ordered(sel);
  const firstUnit = group[0]!;
  const lastUnit = group[group.length - 1]!;
  const first = firstUnit[0]!;
  const last = lastUnit.at(-1)!;
  if (dir === "down") {
    // Items that are all of a list are the list: the selection can go on to what is beside it.
    const list = wholeList(lastUnit[0]!, last);
    // A heading that is selected alone takes its section first.
    if (last.kind === "section" && b.line === startOf(last) && endOf(last) > startOf(last)) return cover(lines, a.line, endOf(last));
    const n = neighbour(last, "down", list);
    return n ? cover(lines, a.line, endOf(n.at(-1)!)) : null;
  }
  const n = neighbour(first, "up", wholeList(first, firstUnit.at(-1)!));
  return n ? cover(lines, startOf(n[0]!), b.line) : null;
}

// ---- select mode ---------------------------------------------------------------
// After Escape the selected blocks stay selected as blocks: the arrows go from block to block,
// Enter adds a block below, and anything else goes back to editing.

/**
 * Up / Down in select mode: selects the block that comes before or after the selected ones, as the
 * page is read. Code blocks, quotes and tables are blocks like any other. Null at the ends.
 */
export function stepBlock(model: PageModel, sel: Sel, dir: "up" | "down"): Sel | null {
  const lines = linesOf(model);
  const [first, last] = selectedLines(sel);
  const all = model.readingOrder().filter(movable);
  const b = dir === "down" ? all.find((c) => startOf(c) > last) : all.findLast((c) => startOf(c) < first);
  return b ? cover(lines, startOf(b), ownEnd(b)) : null;
}

/** The first and last character of the selected lines: where Space and the arrows put the cursor. */
export function selectedSpan(model: PageModel, sel: Sel): { start: Pos; end: Pos } {
  const [first, last] = selectedLines(sel);
  return { start: { line: first, col: 0 }, end: lineEnd(linesOf(model), last) };
}

/** A text to put in the page, where, and where the cursor goes inside it. */
export interface Insertion {
  at: Pos;
  insert: string;
  caret: number;
}

/**
 * Enter in select mode: a new block below the selected ones. Below an item it is another item
 * of the same list; below anything else it is a paragraph, with a blank line to set it apart.
 */
export function blockBelow(model: PageModel, sel: Sel): Insertion {
  const lines = linesOf(model);
  const [first, last] = selectedLines(sel);
  // The outermost block that ends where the selection does.
  const owner = model.readingOrder().find((b) => movable(b) && startOf(b) >= first && ownEnd(b) === last);
  const m = owner?.kind === "item" ? ITEM.exec(lines[startOf(owner)]!) : null;
  if (m) {
    const marker = /^\d/.test(m[2]!) ? `${parseInt(m[2]!, 10) + 1}${m[2]!.slice(-1)}` : m[2]!;
    const task = /^ *[-*+] +\[[ xX]\]/.test(lines[startOf(owner!)]!) ? "[ ] " : "";
    const insert = `\n${m[1]}${marker} ${task}`;
    return { at: lineEnd(lines, last), insert, caret: insert.length };
  }
  if (last + 1 >= lines.length) return { at: lineEnd(lines, last), insert: "\n\n", caret: 2 };
  if (blank(lines[last + 1])) {
    // The gap is already there: the paragraph goes after it, with the same gap below.
    return last + 2 >= lines.length
      ? { at: lineEnd(lines, last + 1), insert: "\n", caret: 1 }
      : { at: lineEnd(lines, last + 1), insert: "\n\n", caret: 1 };
  }
  return { at: lineEnd(lines, last), insert: "\n\n\n", caret: 2 };
}
