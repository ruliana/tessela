// Block selection as a value: which blocks are selected, and the moves that change it. It is what
// select mode holds (see `renderer/selectMode.ts`), kept free of the editor so that the rules can be
// tested on a page model alone (`editor/ARCHITECTURE.md`, principle 2).
//
// A selection is an anchor and a head, both nodes of the page model and siblings of each other, and the
// run of siblings between them, the ends included. A selected block includes the blocks it owns: an item
// brings the items nested in it, a heading (when it is not selected as its own line) its section.
// Whatever two nodes are given, `makeSelection` makes them into the smallest run that holds both, so a
// selection is never a half block, and never spans two parents.
//
// Where the selection can go is limited to what is shown: every move takes a `Visible` that says whether a
// block is on view. A block inside a fold, or outside a zoom, is neither stepped to nor widened to.

import type { Text } from "@codemirror/state";

import type { PageModel, PageNode } from "./pageModel";

export interface BlockSelection {
  readonly anchor: PageNode;
  readonly head: PageNode;
  /** A heading selected as its own line, without the section under it. Only for a single section. */
  readonly heading: boolean;
  /**
   * How deep Up and Down go: the nesting of the block that select mode began on (or deeper, when the
   * selection has been made deeper since). A block nested deeper than this is not a stop, and a parent
   * leads into its children only as far as this. Escape up to the parents leaves it as it was.
   */
  readonly depth: number;
}

/** Whether a block is shown: its first line is not inside a fold or outside a zoom. */
export type Visible = (node: PageNode) => boolean;

export const everything: Visible = () => true;

/** What can be selected: everything but the page and its front matter, which is drawn as a title. */
export function selectable(n: PageNode | null | undefined): n is PageNode {
  return !!n && n.kind !== "page" && n.kind !== "frontmatter";
}

/** How many blocks hold this one: its items' parents, quotes and the paragraph that owns a list, but not the page or the sections (a heading is not a level). */
export function nesting(n: PageNode): number {
  let depth = 0;
  for (const a of n.ancestors()) if (a.kind !== "page" && a.kind !== "section" && a.kind !== "frontmatter") depth++;
  return depth;
}

/** Whether items under `parent` are a list of their own: at the top of a page or a section. */
function listsIn(parent: PageNode | null): boolean {
  return parent === null || parent.kind === "page" || parent.kind === "section";
}

/** The node and the nodes around it, out to the page. */
function chain(n: PageNode): PageNode[] {
  const out = [n];
  for (const a of n.ancestors()) out.push(a);
  return out;
}

/**
 * The selection from `anchor` to `head`: the smallest run of siblings that holds them both. A node
 * that holds the other is the run by itself. Null when either is not something that can be selected.
 */
export function makeSelection(anchor: PageNode, head: PageNode = anchor, heading = false, depth = 0): BlockSelection | null {
  if (!selectable(anchor) || !selectable(head) || anchor.model !== head.model) return null;
  const up = chain(anchor);
  const hs = chain(head);
  const common = up.find((n) => hs.includes(n));
  if (!common) return null;
  // A heading is its own line only when it is all that was asked for.
  const own = heading && anchor === head && anchor.kind === "section";
  if (common === anchor || common === head) {
    return selectable(common) ? { anchor: common, head: common, heading: own && common === anchor, depth: Math.max(depth, nesting(common)) } : null;
  }
  const a = up[up.indexOf(common) - 1]!;
  const h = hs[hs.indexOf(common) - 1]!;
  if (!selectable(a) || !selectable(h)) return null;
  return { anchor: a, head: h, heading: false, depth: Math.max(depth, nesting(a)) };
}

/** The blocks of the run, in page order. */
export function membersOf(sel: BlockSelection): PageNode[] {
  const siblings = sel.anchor.parent!.children;
  const a = siblings.indexOf(sel.anchor);
  const h = siblings.indexOf(sel.head);
  return siblings.slice(Math.min(a, h), Math.max(a, h) + 1);
}

/** Whether the head is above the anchor: the selection was taken in upwards. */
export function reversed(sel: BlockSelection): boolean {
  const siblings = sel.anchor.parent!.children;
  return siblings.indexOf(sel.head) < siblings.indexOf(sel.anchor);
}

/** The first and last line the selection covers, 0-based and both included. */
export function selectedLines(sel: BlockSelection): [number, number] {
  const members = membersOf(sel);
  const first = members[0]!.startLine - 1;
  return [first, sel.heading ? first : members[members.length - 1]!.endLine - 1];
}

/** The text the selection covers, as a range of the page: whole lines, from the first column to the end of the last. */
export function selectedSpan(model: PageModel, sel: BlockSelection): { from: number; to: number } {
  const [first, last] = selectedLines(sel);
  return { from: model.doc.line(first + 1).from, to: model.doc.line(last + 1).to };
}

/** The first block that starts on a line (1-based): the outermost, when an item and what is in it start together. */
export function nodeStartingAt(model: PageModel, line: number): PageNode | null {
  return model.nodes.find((n) => n.startLine === line && selectable(n)) ?? null;
}

// ---- moving ----------------------------------------------------------------------

/**
 * Up and Down in select mode: the block before or after the selected ones, in the order the page is read
 * and as it is shown. Code blocks, quotes and nested items are blocks like any other, and a heading is
 * its own line, so that the blocks under it are the next stops. A run of blocks is left by its end. A
 * block nested deeper than `sel.depth` is not a stop: it is left with the block that owns it, and the way
 * to it is `enterBlock`. Null at the ends of what is shown.
 */
export function stepBlock(model: PageModel, sel: BlockSelection, dir: "up" | "down", visible: Visible = everything): BlockSelection | null {
  const [first, last] = selectedLines(sel);
  const all = model.readingOrder().filter((n) => selectable(n) && visible(n) && nesting(n) <= sel.depth);
  const b = dir === "down" ? all.find((c) => c.startLine - 1 > last) : all.findLast((c) => c.startLine - 1 < first);
  return b ? makeSelection(b, b, b.kind === "section", sel.depth) : null;
}

/**
 * Down on a block that is selected with what it owns: its first child, as far as it is shown and not
 * deeper than `sel.depth`. This is the way back in after Up (or Escape) took the selection out to a parent.
 */
export function enterBlock(sel: BlockSelection, visible: Visible = everything): BlockSelection | null {
  if (sel.heading || sel.anchor !== sel.head) return null;
  const child = sel.head.children.find((c) => selectable(c) && visible(c) && nesting(c) <= sel.depth);
  return child ? makeSelection(child, child, child.kind === "section", sel.depth) : null;
}

/** The sibling of `node` in a direction when it can be taken in: it exists and is shown. */
function neighbourOf(node: PageNode, dir: "up" | "down", visible: Visible): PageNode | null {
  const siblings = node.parent ? node.parent.children : [];
  const n = siblings[siblings.indexOf(node) + (dir === "down" ? 1 : -1)];
  return selectable(n) && visible(n) ? n : null;
}

/**
 * Shift+Up and Shift+Down: the head moves to the next block in that direction and the selection is made
 * again from the anchor. From a heading that is its own line the first step takes in its section. Past the
 * last (or first) block of a parent the head climbs: the parent is selected. A run of items at the top of a
 * page or a section is a list, and is taken in whole, as a paragraph or a heading is, when the selection
 * comes to it from outside. With the head above the anchor, Shift+Down takes a block back out again.
 * Null when there is nowhere to go.
 */
export function extendBlock(sel: BlockSelection, dir: "up" | "down", visible: Visible = everything): BlockSelection | null {
  const { anchor, head } = sel;
  if (sel.heading && dir === "down" && head.endLine > head.startLine) return makeSelection(head, head, false, sel.depth);
  const siblings = head.parent!.children;
  const ai = siblings.indexOf(anchor);
  const hi = siblings.indexOf(head);
  const step = dir === "down" ? 1 : -1;
  const growing = dir === "down" ? hi >= ai : hi <= ai;
  if (growing) {
    let to = neighbourOf(head, dir, visible);
    if (to) {
      if (to.kind === "item" && head.kind !== "item" && listsIn(to.parent)) {
        // A list is one step: go to its last item (or its first, going up).
        for (let n: PageNode | null = to; n?.kind === "item"; n = neighbourOf(n, dir, visible)) to = n;
      }
      return makeSelection(anchor, to, false, sel.depth);
    }
    const parent = head.parent;
    return parent && selectable(parent) && visible(parent) ? makeSelection(parent, parent, false, sel.depth) : null;
  }
  let to = siblings[hi + step]!;
  if (head.kind === "item" && anchor.kind !== "item" && listsIn(head.parent)) {
    // Out of a list the same way it was entered: whole.
    let k = hi;
    while (siblings[k + step]?.kind === "item") k += step;
    to = siblings[k + step]!;
  }
  return makeSelection(anchor, to, false, sel.depth);
}

/** A selection the page can be widened to, with the lines it covers (0-based, both included). */
interface Unit {
  sel: BlockSelection;
  from: number;
  to: number;
}

/** Every selection Escape can widen to: each block, a heading as its line and then as its section, each list, the page. */
function unitsOf(model: PageModel, visible: Visible): Unit[] {
  const out: Unit[] = [];
  const add = (sel: BlockSelection | null): void => {
    if (!sel) return;
    const [from, to] = selectedLines(sel);
    out.push({ sel, from, to });
  };
  for (const n of model.nodes) {
    if (!selectable(n) || !visible(n)) continue;
    add(makeSelection(n));
    if (n.kind === "section") add(makeSelection(n, n, true));
  }
  for (const parent of [model.root, ...model.nodes]) {
    if (!listsIn(parent)) continue;
    let run: PageNode[] = [];
    const flush = (): void => {
      if (run.length > 1) add(makeSelection(run[0]!, run[run.length - 1]!));
      run = [];
    };
    for (const c of parent.children) {
      if (c.kind === "item" && visible(c)) run.push(c);
      else flush();
    }
    flush();
  }
  const body = model.root.children.filter((c) => selectable(c) && visible(c));
  if (body.length > 0) add(makeSelection(body[0]!, body[body.length - 1]!));
  return out;
}

/**
 * Escape: the selection one step wider than `cover`, a range of the page (the cursor or the text selected
 * while editing, or the blocks selected already): the block at the cursor, then the one around it each
 * time: the parent item, the list, the section under its heading, the section that holds that and in the
 * end the whole page. Only what is shown counts, so a zoom is a limit and not something Escape leaves.
 * `depth` is the one the selection to widen has (see `BlockSelection`). Null when there is nothing wider, or
 * when a cursor is in the gap between blocks.
 */
export function widenBlock(model: PageModel, cover: { from: number; to: number }, visible: Visible = everything, depth = 0): BlockSelection | null {
  if (cover.from === cover.to) {
    const line = model.doc.lineAt(cover.from).number;
    const n = model.nodeAtLine(line);
    // A cursor in a gap between blocks has nothing to take in.
    if (n.kind === "page" || (n.kind === "section" && n.startLine !== line)) return null;
  }
  let best: BlockSelection | null = null;
  let size = Infinity;
  for (const u of unitsOf(model, visible)) {
    const from = model.doc.line(u.from + 1).from;
    const to = model.doc.line(u.to + 1).to;
    // It must hold the cover and be wider than it.
    if (from > cover.from || to < cover.to || (from === cover.from && to === cover.to)) continue;
    if (u.to - u.from < size) {
      size = u.to - u.from;
      best = u.sel;
    }
  }
  return best && makeSelection(best.anchor, best.head, best.heading, depth);
}

// ---- removing ------------------------------------------------------------------------

/**
 * What to cut out of the page to remove the blocks on lines `first` to `last` (0-based): the lines and
 * the blank lines that went with them, so that what is left keeps the same space between its blocks.
 * Between two blocks one gap stays, the larger of the two; at an end of the page the gap goes. The
 * range always starts and ends at a line break or at an end of the page.
 */
export function removalRange(doc: Text, first: number, last: number): { from: number; to: number } {
  const blank = (i: number): boolean => doc.line(i + 1).text.trim() === "";
  let before = first - 1;
  while (before >= 0 && blank(before)) before--;
  let after = last + 1;
  while (after < doc.lines && blank(after)) after++;
  if (before >= 0 && after < doc.lines) {
    const upto = last + Math.min(first - 1 - before, after - last - 1);
    return { from: doc.line(first + 1).from, to: doc.line(upto + 2).from };
  }
  if (before >= 0) return { from: doc.line(before + 1).to, to: doc.line(last + 1).to };
  if (after < doc.lines) return { from: doc.line(first + 1).from, to: doc.line(after + 1).from };
  return { from: 0, to: doc.length };
}
