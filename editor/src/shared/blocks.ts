// The block structure of a page as the editor sees it, and the edits that act on blocks:
// indent, outdent, move and select (spec §3). Everything here works on an array of
// lines, so it can be tested without an editor.
//
// A block is a paragraph, a heading, a code block, a quote, a table, a list or a list item.
// A paragraph owns the list that starts on the line right beneath it, and a list item
// owns the items nested under it, so moving a block moves what it owns.
//
// Where a block begins and ends is decided in one place, `parseBlocks`, which reads the page
// with the same CommonMark parser that the editor renders it with. Escape, Tab, Alt+Up/Down
// and the block that focus mode and the live preview keep lit all ask it, so they cannot
// disagree about, say, whether a paragraph after a blank line is still part of a list item.

import { GFM, parser } from "@lezer/markdown";

export interface Block {
  kind:
    | "frontmatter"
    | "heading"
    | "fence"
    | "code"
    | "para"
    | "list"
    | "item"
    | "quote"
    | "table"
    | "rule"
    | "html"
    | "other";
  /** First and last line, both included. Trailing blank lines are not part of a block. */
  start: number;
  end: number;
  /** Width of the leading whitespace of the first line. */
  indent: number;
  /** For an item: where its text starts, so the indent of a child that nests under it. */
  offset: number;
  children: Block[];
  parent: Block | null;
}

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
const THEMATIC = /^ {0,3}([-*_])( *\1){2,} *$/;
const HEADING = /^ {0,3}#{1,6}( |$)/;

function width(line: string): number {
  return (/^ */.exec(line)?.[0] ?? "").length;
}

function blank(line: string | undefined): boolean {
  return line === undefined || line.trim() === "";
}

function itemMatch(line: string): RegExpExecArray | null {
  return THEMATIC.test(line) ? null : ITEM.exec(line);
}

/** The last line of the front matter, or -1 when the page has none. */
export function frontmatterEnd(lines: string[]): number {
  if (lines[0]?.trimEnd() !== "---") return -1;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i]!.trimEnd();
    if (t === "---" || t === "...") return i;
  }
  return -1;
}

function newBlock(kind: Block["kind"], start: number, end: number, line: string): Block {
  return { kind, start, end, indent: width(line), offset: 0, children: [], parent: null };
}

const markdown = parser.configure(GFM);
type SyntaxNode = ReturnType<typeof markdown.parse>["topNode"];

/** The width of the text of an item: where a line must start to belong to it. */
function textOffset(line: string): number {
  const m = ITEM.exec(line);
  if (!m) return 0;
  const w = m[1]!.length;
  // A marker with nothing after it, or with five spaces or more, has its text one space in.
  return m[3]!.length === 0 || m[3]!.length > 4 ? w + m[2]!.length + 1 : m[0].length;
}

const LEAF: Record<string, Block["kind"]> = {
  FencedCode: "fence",
  CodeBlock: "code",
  Blockquote: "quote",
  Table: "table",
  HorizontalRule: "rule",
  HTMLBlock: "html",
  CommentBlock: "html",
  ProcessingInstructionBlock: "html",
  LinkReference: "other",
};

/**
 * The top-level blocks of a page, in order, with their items nested inside. The reading is
 * CommonMark's (with tables): what belongs to an item, where a lazy line goes, what a fence
 * swallows. On top of it, a paragraph owns the list that starts on the line right beneath it.
 */
export function parseBlocks(lines: string[]): Block[] {
  const clean = lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const fm = frontmatterEnd(clean);
  // The front matter is not Markdown: its lines are blanked, so that line numbers stay put.
  const text = clean.map((l, i) => (i <= fm ? "" : l));
  const starts: number[] = [];
  let at = 0;
  for (const l of text) {
    starts.push(at);
    at += l.length + 1;
  }
  const lineOf = (pos: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  /** The first and last line of a node, without the blank lines that trail it. */
  const span = (node: SyntaxNode): [number, number] => {
    const start = lineOf(node.from);
    let end = lineOf(Math.max(node.from, node.to - 1));
    while (end > start && blank(text[end])) end--;
    return [start, end];
  };
  const make = (kind: Block["kind"], node: SyntaxNode, parent: Block | null): Block => {
    const [start, end] = span(node);
    const b = newBlock(kind, start, end, text[start]!);
    b.parent = parent;
    return b;
  };
  const item = (node: SyntaxNode, parent: Block): Block => {
    const b = make("item", node, parent);
    b.offset = textOffset(text[b.start]!);
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.name === "BulletList" || c.name === "OrderedList") {
        for (let i = c.firstChild; i; i = i.nextSibling) if (i.name === "ListItem") b.children.push(item(i, b));
      }
    }
    return b;
  };
  const list = (node: SyntaxNode): Block => {
    const b = make("list", node, null);
    for (let i = node.firstChild; i; i = i.nextSibling) if (i.name === "ListItem") b.children.push(item(i, b));
    return b;
  };

  const root: Block[] = [];
  if (fm >= 0) root.push(newBlock("frontmatter", 0, fm, clean[0]!));
  for (let node = markdown.parse(text.join("\n")).topNode.firstChild; node; node = node.nextSibling) {
    const name = node.name;
    if (name === "BulletList" || name === "OrderedList") {
      const l = list(node);
      const owner = root[root.length - 1];
      // The list right beneath a paragraph, with no blank line between, belongs to it.
      if (owner && owner.kind === "para" && owner.children.length === 0 && l.start === owner.end + 1) {
        owner.end = l.end;
        owner.children = l.children;
        for (const c of l.children) c.parent = owner;
      } else {
        root.push(l);
      }
    } else if (name === "Paragraph") {
      root.push(make("para", node, null));
    } else if (name.startsWith("ATXHeading") || name.startsWith("SetextHeading")) {
      root.push(make("heading", node, null));
    } else {
      root.push(make(LEAF[name] ?? "other", node, null));
    }
  }
  return root;
}

/**
 * The lines (0-based) of the block being edited at `line`: its own text, without the items
 * nested in it and without blank lines. A code block is not one text, so there it is the
 * line alone. Nothing for a blank line, or where no block is.
 */
export function editedBlockLines(lines: string[], line: number, blocks: Block[] = parseBlocks(lines)): number[] {
  if (blank(lines[line])) return [];
  const b = blockAt(blocks, line);
  if (!b || b.kind === "list") return [];
  if (b.kind === "frontmatter" || b.kind === "fence" || b.kind === "code" || b.kind === "html") return [line];
  const own: number[] = [];
  for (let n = b.start; n <= b.end; n++) {
    if (blank(lines[n]) || b.children.some((c) => n >= c.start && n <= c.end)) continue;
    own.push(n);
  }
  return own;
}

/** The innermost block that contains `line`. */
export function blockAt(blocks: Block[], line: number): Block | null {
  for (const b of blocks) {
    if (line < b.start || line > b.end) continue;
    return blockAt(b.children, line) ?? b;
  }
  return null;
}

function siblings(blocks: Block[], b: Block): Block[] {
  return b.parent ? b.parent.children : blocks;
}

/** The blocks that can be selected or moved as a unit: items, paragraphs and so on. */
function movable(b: Block | null): b is Block {
  return b !== null && b.kind !== "list" && b.kind !== "frontmatter";
}

/** What block selection and moving act on at `line`: the innermost item or top-level block. */
export function selectableAt(blocks: Block[], line: number): Block | null {
  const b = blockAt(blocks, line);
  if (b && b.kind === "list") return null;
  return movable(b) ? b : null;
}

function previous(blocks: Block[], b: Block): Block | null {
  const list = siblings(blocks, b);
  const i = list.indexOf(b);
  const p = list[i - 1] ?? null;
  return movable(p) ? p : null;
}

function next(blocks: Block[], b: Block): Block | null {
  const list = siblings(blocks, b);
  const n = list[list.indexOf(b) + 1] ?? null;
  return movable(n) ? n : null;
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
export function selectedLines(sel: Sel): [number, number] {
  const [a, b] = ordered(sel);
  const last = b.col === 0 && b.line > a.line ? b.line - 1 : b.line;
  return [a.line, last];
}

function ordered(sel: Sel): [Pos, Pos] {
  const { anchor: a, head: h } = sel;
  return a.line < h.line || (a.line === h.line && a.col <= h.col) ? [a, h] : [h, a];
}

/** The top-most blocks that cover the lines, so a block and its children are not edited twice. */
function topmost(blocks: Block[], from: number, to: number): Block[] {
  const found: Block[] = [];
  let line = from;
  while (line <= to) {
    const b = selectableAt(blocks, line);
    if (!b) {
      line++;
      continue;
    }
    // Climb to the highest block that starts inside the selection.
    let top = b;
    while (top.parent && movable(top.parent) && top.parent.start >= from) top = top.parent;
    if (!found.includes(top)) found.push(top);
    line = top.end + 1;
  }
  return found;
}

function inEditableText(blocks: Block[], from: number, to: number): boolean {
  for (let line = from; line <= to; line++) {
    const b = blockAt(blocks, line);
    if (b && (b.kind === "frontmatter" || b.kind === "fence" || b.kind === "code")) return false;
  }
  return true;
}

function hasTab(lines: string[], from: number, to: number): boolean {
  for (let i = from; i <= to; i++) if (/^ *\t/.test(lines[i]!)) return true;
  return false;
}

function marker(lines: string[], b: Block): string {
  return itemMatch(lines[b.start]!)?.[0] ?? "";
}

/**
 * Tab. On a paragraph it starts a list, on a list item it nests the item (and what is
 * under it) beneath the item before it, and on an empty line it starts a list item.
 * Returns null when the selection is not ordinary text, so Tab can act as usual there.
 */
export function indent(lines: string[], sel: Sel): Result | null {
  const [from, to] = selectedLines(sel);
  const blocks = parseBlocks(lines);
  if (!inEditableText(blocks, from, to) || hasTab(lines, from, to)) return null;
  const out = rows(lines);

  if (from === to && blank(lines[from])) {
    const above = from > 0 && !blank(lines[from - 1]) ? selectableAt(blocks, from - 1) : null;
    const pad = above && above.kind === "item" ? above.offset : 0;
    out[from]!.text = `${" ".repeat(pad)}- `;
    out[from]!.dcol = out[from]!.text.length;
    return { rows: out };
  }

  // Forward, because an item that has just been nested is a child of the one before.
  let current = lines;
  for (const target of topmost(blocks, from, to)) {
    const fresh = current === lines ? blocks : parseBlocks(current);
    const b = blockAt(fresh, target.start);
    const at = b && b.start === target.start ? b : null;
    if (!at) continue;
    if (at.kind === "item") {
      const before = previous(fresh, at);
      if (!before || before.kind !== "item") continue;
      shiftLines(out, at.start, at.end, before.offset - at.indent);
    } else if (at.kind === "para") {
      // The paragraph becomes an item, and its lines and the list it owns nest under the marker.
      out[at.start]!.text = `- ${out[at.start]!.text.trimStart()}`;
      out[at.start]!.dcol += 2 - width(lines[at.start]!);
      for (let i = at.start + 1; i <= at.end; i++) {
        if (blank(out[i]!.text)) continue;
        out[i]!.text = `  ${out[i]!.text}`;
        out[i]!.dcol += 2;
      }
    }
    current = out.map((r) => r.text);
  }
  return { rows: out };
}

/**
 * Shift+Tab. A nested item moves out one level. An item at the top level stops being a
 * list item and becomes a plain paragraph again; what was nested under it moves out with it.
 */
export function outdent(lines: string[], sel: Sel): Result | null {
  const [from, to] = selectedLines(sel);
  const blocks = parseBlocks(lines);
  if (!inEditableText(blocks, from, to) || hasTab(lines, from, to)) return null;
  const targets = topmost(blocks, from, to).filter((b) => b.kind === "item");

  // Bottom to top, so the lines that are added do not move the ones still to do.
  const out = rows(lines);
  const order = [...targets].reverse();
  const inserted: { at: number; before: boolean }[] = [];
  for (const b of order) {
    const parent = b.parent;
    if (parent && parent.kind === "item") {
      shiftLines(out, b.start, b.end, parent.indent - b.indent);
    } else if (b.indent > 0) {
      shiftLines(out, b.start, b.end, -b.indent);
    } else {
      const m = marker(lines, b);
      const first = out[b.start]!;
      first.text = first.text.slice(m.length);
      first.dcol -= m.length;
      shiftLines(out, b.start + 1, b.end, -m.length);
      if (b.start > 0 && !blank(lines[b.start - 1]) && !HEADING.test(lines[b.start - 1]!)) {
        inserted.push({ at: b.start, before: true });
      }
      if (b.end + 1 < lines.length && !blank(lines[b.end + 1]) && !HEADING.test(lines[b.end + 1]!)) {
        inserted.push({ at: b.end + 1, before: true });
      }
    }
  }
  // Add the blank lines, last position first.
  const unique = [...new Set(inserted.map((i) => i.at))].sort((a, b) => b - a);
  for (const at of unique) out.splice(at, 0, { text: "", from: -1, dcol: 0 });
  return { rows: out };
}

/** The lines of a block, as a range with the blank lines between two neighbours. */
function swap(lines: string[], first: Block, second: Block): Result {
  const out = rows(lines);
  const a = out.slice(first.start, first.end + 1);
  const gap = out.slice(first.end + 1, second.start);
  const b = out.slice(second.start, second.end + 1);
  out.splice(first.start, second.end - first.start + 1, ...b, ...gap, ...a);
  return { rows: out };
}

/** Alt+Up / Alt+Down: moves the block, and what it owns, past its neighbour. */
export function move(lines: string[], sel: Sel, dir: "up" | "down"): Result | null {
  const [from, to] = selectedLines(sel);
  const blocks = parseBlocks(lines);
  if (!inEditableText(blocks, from, to)) return null;
  const group = selectedGroup(blocks, from, to);
  if (!group) return { rows: rows(lines) };
  const first = group[0]!;
  const last = group[group.length - 1]!;
  if (dir === "up") {
    const before = previous(blocks, first);
    if (!before) return { rows: rows(lines) };
    return swap(lines, before, mergeGroup(first, last));
  }
  const after = next(blocks, last);
  if (!after) return { rows: rows(lines) };
  return swap(lines, mergeGroup(first, last), after);
}

function mergeGroup(first: Block, last: Block): Block {
  return { ...first, end: last.end };
}

/** The selected blocks when they are neighbours; otherwise the block at the first line. */
function selectedGroup(blocks: Block[], from: number, to: number): Block[] | null {
  const found = topmost(blocks, from, to);
  if (found.length === 0) return null;
  const first = found[0]!;
  const level = siblings(blocks, first);
  const consecutive = found.every((b, i) => siblings(blocks, b) === level && (i === 0 || level.indexOf(b) === level.indexOf(found[i - 1]!) + 1));
  return consecutive ? found : [first];
}

function lineEnd(lines: string[], line: number): Pos {
  return { line, col: lines[line]!.length };
}

/** Whether the selection covers whole blocks that are neighbours, and nothing else. */
function aligned(lines: string[], blocks: Block[], sel: Sel): Block[] | null {
  const [a, b] = ordered(sel);
  if (a.col !== 0 || b.col !== lines[b.line]!.length || (a.line === b.line && a.col === b.col)) return null;
  const first = selectableAt(blocks, a.line);
  if (!first || first.start !== a.line) return null;
  const group = [first];
  let current = first;
  while (current.end < b.line) {
    const n = next(blocks, current);
    if (!n) return null;
    group.push(n);
    current = n;
  }
  return current.end === b.line ? group : null;
}

function cover(lines: string[], from: Block, to: Block): Sel {
  return { anchor: { line: from.start, col: 0 }, head: lineEnd(lines, to.end) };
}

/** Escape: selects the block at the cursor; again, the block that holds it. */
export function selectBlock(lines: string[], sel: Sel): Sel | null {
  const blocks = parseBlocks(lines);
  const group = aligned(lines, blocks, sel);
  if (group) {
    const parent = group[0]!.parent;
    return parent && parent.kind === "item" ? cover(lines, parent, parent) : null;
  }
  const b = selectableAt(blocks, sel.head.line);
  return b ? cover(lines, b, b) : null;
}

/** Shift+Up / Shift+Down on a block selection: takes in the next block in that direction. */
export function extendBlocks(lines: string[], sel: Sel, dir: "up" | "down"): Sel | null {
  const blocks = parseBlocks(lines);
  const group = aligned(lines, blocks, sel);
  if (!group) return null;
  const first = group[0]!;
  const last = group[group.length - 1]!;
  if (dir === "down") {
    const n = next(blocks, last);
    return n ? cover(lines, first, n) : null;
  }
  const p = previous(blocks, first);
  return p ? cover(lines, p, last) : null;
}
