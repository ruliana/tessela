// Fold and zoom: which blocks of a page can be folded, which lines a zoom shows, and the
// trail that leads back out. Everything works on lines, like blocks.ts, so it is tested
// without an editor. Fold state is the window's, never the page's: a fold is remembered as a
// key made from the block's first line, and a block whose first line has changed simply opens.

import { type Block, parseBlocks, selectableAt } from "./blocks";
import { headingText } from "./links";

export interface Fold {
  /** The line that stays visible; the fold hides what follows it. */
  line: number;
  /** The last hidden line. */
  last: number;
  /** How deep the block sits in the outline: headings above it plus items around it. */
  depth: number;
  /** What a window remembers a folded block by: its kind, its first line and which one of its kind that is. */
  key: string;
}

const HEADING_LEVEL = /^ {0,3}(#{1,6})(?: |$)/;

function level(lines: string[], b: Block): number {
  return HEADING_LEVEL.exec(lines[b.start]!)?.[1]!.length ?? 0;
}

/** The last line of the section a heading opens: up to the next heading as high or higher. */
function sectionEnd(lines: string[], roots: Block[], at: number): number {
  const mine = level(lines, roots[at]!);
  let end = roots[at]!.end;
  for (let i = at + 1; i < roots.length; i++) {
    const b = roots[i]!;
    if (b.kind === "heading" && level(lines, b) <= mine) break;
    end = b.end;
  }
  return end;
}

/** The text of a block's first line without its list marker or `#`s. */
function label(lines: string[], b: Block): string {
  const line = lines[b.start]!;
  return (b.kind === "heading" ? headingText(line) : line.replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/, "")).trim();
}

/** Every block that can be folded, in page order. */
export function foldables(lines: string[], blocks: Block[] = parseBlocks(lines)): Fold[] {
  const out: Fold[] = [];
  const seen = new Map<string, number>();
  const keyOf = (b: Block): string => {
    const base = `${b.kind}:${lines[b.start]!.trim()}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}#${n}`;
  };
  const headings: number[] = [];
  const walk = (b: Block, depth: number, roots?: { list: Block[]; at: number }): void => {
    if (b.kind === "list") {
      for (const c of b.children) walk(c, depth);
      return;
    }
    if (b.kind === "heading" && roots) {
      while (headings.length > 0 && headings[headings.length - 1]! >= level(lines, b)) headings.pop();
      const key = keyOf(b);
      const last = sectionEnd(lines, roots.list, roots.at);
      if (last > b.start) out.push({ line: b.start, last, depth: headings.length, key });
      headings.push(level(lines, b));
      return;
    }
    if (b.kind !== "item" && b.kind !== "para") return;
    const key = keyOf(b);
    if (b.kind === "item" && b.end > b.start) out.push({ line: b.start, last: b.end, depth, key });
    // A paragraph keeps its own text and folds the list it owns.
    else if (b.kind === "para" && b.children.length > 0) {
      out.push({ line: b.children[0]!.start - 1, last: b.end, depth, key });
    }
    for (const c of b.children) walk(c, depth + 1);
  };
  blocks.forEach((b, at) => walk(b, headings.length, { list: blocks, at }));
  return out;
}

/** The innermost foldable block around `line`, or the one above it when `skip` of them are to be passed. */
export function foldAround(folds: Fold[], line: number, skip = 0): Fold | null {
  const around = folds.filter((f) => f.line <= line && line <= f.last).sort((a, b) => b.line - a.line || a.last - b.last);
  return around[skip] ?? null;
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
export function zoomAt(lines: string[], line: number, blocks: Block[] = parseBlocks(lines)): Zoom | null {
  const b = selectableAt(blocks, line);
  if (!b) return null;
  let top = b;
  while (top.parent) top = top.parent;
  const at = blocks.indexOf(top);
  const trail: Crumb[] = [];
  // The headings that lead to the block: each is the last one of its level, above the top block.
  const stack: Block[] = [];
  for (const r of blocks.slice(0, at + 1)) {
    if (r.kind !== "heading" || (r === top && b === top)) continue;
    while (stack.length > 0 && level(lines, stack[stack.length - 1]!) >= level(lines, r)) stack.pop();
    stack.push(r);
  }
  if (b.kind === "heading") {
    while (stack.length > 0 && level(lines, stack[stack.length - 1]!) >= level(lines, b)) stack.pop();
  }
  for (const h of stack) trail.push({ line: h.start, text: label(lines, h) });
  const parents: Block[] = [];
  for (let p = b.parent; p; p = p.parent) if (p.kind === "item" || p.kind === "para") parents.unshift(p);
  for (const p of parents) trail.push({ line: p.start, text: label(lines, p) });
  const end = b.kind === "heading" ? sectionEnd(lines, blocks, blocks.indexOf(b)) : b.end;
  return { start: b.start, end, trail };
}
