// Fold and zoom: which blocks of a page can be folded (headings with their sections, list items, paragraphs
// with a list, code fences), which lines a zoom shows, and the trail that leads back out. What a block is and
// where it ends come from the page model (`shared/pageModel.ts`); lines are 0-based here, as in blocks.ts,
// so it is tested without an editor. Fold state is the window's, never the page's: a fold is remembered by the
// key of its node (the hash of its text, as in a block handle), and a block whose text has changed simply opens.

import { selectableAt } from "./blocks";
import type { PageModel, PageNode } from "./pageModel";

export interface Fold {
  /** The line that stays visible; the fold hides what follows it. */
  line: number;
  /** The last hidden line. */
  last: number;
  /** How deep the block sits in the outline: headings above it plus items around it. */
  depth: number;
  /** What a window remembers a folded block by: the key of its node (`9f2c41d0`, `9f2c41d0.2` for the second of equal text). */
  readonly key: string;
  /** Whether a page that is opened shows it folded until the window has been told otherwise: a code fence that something runs. */
  auto: boolean;
}

/** The info strings of the code fences whose output the editor draws under them: their source folds when a page opens. */
export const RUN_FENCES: readonly string[] = ["tessela", "mermaid"];

/** Whether a fence is closed and runs, so that what it draws is worth more than its source. */
function isRunFence(n: PageNode): boolean {
  const info = n.fence?.info.split(/\s/)[0] ?? "";
  return !!n.fence?.closed && n.endLine > n.startLine && RUN_FENCES.includes(info);
}

/**
 * Every block that can be folded, in page order; or, given `lines` (first and last, 0-based, both included),
 * only those whose first line is there, which is all that is drawn at a time and does not make the others.
 */
export function foldables(model: PageModel, lines?: { from: number; to: number }): Fold[] {
  const out: Fold[] = [];
  // The key is worked out when it is asked for: hashing the page is not needed to show a chevron.
  const fold = (n: PageNode, line: number, last: number, auto = false): void => {
    if (lines && (line < lines.from || line > lines.to)) return;
    out.push({ line, last, depth: depthOf(n), get key() { return n.key; }, auto });
  };
  for (const n of model.readingOrder()) {
    if (n.kind === "section") {
      if (n.endLine > n.startLine) fold(n, n.startLine - 1, n.endLine - 1);
    } else if (n.kind === "code") {
      // Only a fenced block: an indented one has no first line to stay.
      if (n.fence && n.endLine > n.startLine) fold(n, n.startLine - 1, n.endLine - 1, isRunFence(n));
    } else if (n.kind === "item") {
      if (n.endLine > n.startLine) fold(n, n.startLine - 1, n.endLine - 1);
    } else if (n.kind === "paragraph" && n.children.length > 0) {
      // A paragraph keeps its own text and folds the list it owns.
      fold(n, n.children[0]!.startLine - 2, n.endLine - 1);
    }
  }
  return out;
}

/** The sections and the blocks that hold this one: how far in the outline it sits. */
function depthOf(n: PageNode): number {
  let depth = 0;
  for (const a of n.ancestors()) if (a.kind !== "page") depth++;
  return depth;
}

/** The innermost foldable block around `line`, or the one above it when `skip` of them are to be passed. */
export function foldAround(folds: Fold[], line: number, skip = 0): Fold | null {
  const around = folds.filter((f) => f.line <= line && line <= f.last).sort((a, b) => b.line - a.line || a.last - b.last);
  return around[skip] ?? null;
}

/** What a window remembers of a page: the keys of its folded blocks, and for a fence that folds by itself the key of one that was opened (marked with a `-`). A page left as it opens remembers nothing. */
const OPENED = "-";

/** The folds a page that has just been loaded starts with, given what the window remembers of it. */
export function foldsOnLoad(folds: Fold[], remembered: string[]): Fold[] {
  const keys = new Set(remembered);
  return folds.filter((f) => (f.auto ? !keys.has(OPENED + f.key) : keys.has(f.key)));
}

/** What to remember of a page whose folded blocks are those for which `folded` is true. */
export function foldsToRemember(folds: Fold[], folded: (f: Fold) => boolean): string[] {
  return folds.flatMap((f) => (f.auto === folded(f) ? [] : [f.auto ? OPENED + f.key : f.key]));
}

export interface Crumb {
  /** A line of the block, to zoom to it again. */
  line: number;
  text: string;
}

export interface Zoom {
  /** First and last line shown, both included. */
  start: number;
  end: number;
  /** The headings and items around the block, outermost first. */
  trail: Crumb[];
}

/** What zooming in on the block at `line` shows: the block with what it owns, and the way out. */
export function zoomAt(model: PageModel, line: number): Zoom | null {
  const b = selectableAt(model, line);
  if (!b) return null;
  const trail: Crumb[] = [];
  // The sections that lead to the block, then the items and paragraphs around it, outermost first.
  for (const a of [...b.ancestors()].reverse()) {
    if (a.kind === "section" || a.kind === "item" || a.kind === "paragraph") trail.push({ line: a.startLine - 1, text: a.label });
  }
  return { start: b.startLine - 1, end: b.endLine - 1, trail };
}
