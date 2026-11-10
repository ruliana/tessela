// The outline mod's logic, on lines like shared/blocks.ts, so it is tested without an editor:
// which headings a page has, which lines a section covers, and what moving one past its neighbour
// makes of the page. Only `#` headings at the top level count, so a `#` line in a code block, a
// quote or a list is left alone (the page is read with the editor's own block parser).

import { parseBlocks } from "../../shared/blocks";
import { headingText } from "../../shared/links";

export interface Heading {
  /** The line it is on (0 is the first). */
  line: number;
  /** 1 for `#`, 2 for `##`, and so on. */
  level: number;
  text: string;
}

/** The headings of a page, in order. */
export function headings(lines: string[]): Heading[] {
  const out: Heading[] = [];
  for (const b of parseBlocks(lines)) {
    if (b.kind !== "heading") continue;
    const level = /^ {0,3}(#{1,6})/.exec(lines[b.start]!)?.[1]!.length;
    if (level) out.push({ line: b.start, level, text: headingText(lines[b.start]!) });
  }
  return out;
}

/** The heading the line is under (or on): the last one at or above it. */
export function headingAt(list: Heading[], line: number): Heading | null {
  let found: Heading | null = null;
  for (const h of list) {
    if (h.line > line) break;
    found = h;
  }
  return found;
}

/** Headings whose text contains every word typed, in any case; all of them when nothing is typed. */
export function matching(list: Heading[], typed: string): Heading[] {
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((h) => words.every((w) => h.text.toLowerCase().includes(w)));
}

/** A section: from its heading to the line before the next heading of its level or higher. */
interface Section {
  start: number;
  /** Where its text ends; the blank lines that follow it, up to `end`, are the gap before the next section. */
  last: number;
  end: number;
}

function sectionOf(lines: string[], list: Heading[], index: number): Section {
  const mine = list[index]!;
  let next = index + 1;
  while (next < list.length && list[next]!.level > mine.level) next++;
  const end = next < list.length ? list[next]!.line - 1 : lines.length - 1;
  let last = end;
  while (last > mine.line && lines[last]!.trim() === "") last--;
  return { start: mine.line, last, end };
}

export interface Moved {
  /** The page's lines after the move. */
  lines: string[];
  /** The first and last line (of the old page) that the move rewrote. */
  from: number;
  to: number;
  /** How many lines the moved heading went down (negative: up). */
  shift: number;
}

/**
 * Moves the section whose heading is on `line` past its neighbour of the same level, above it
 * (`up`) or below it (`down`). The blank lines between sections stay where they are, so the page
 * does not gain or lose any. Nothing moves (null) when the line is not a heading or the section has
 * no neighbour of its level inside the same parent.
 */
export function moveSection(lines: string[], line: number, dir: "up" | "down"): Moved | null {
  const list = headings(lines);
  const at = list.findIndex((h) => h.line === line);
  if (at < 0) return null;
  const level = list[at]!.level;
  let other = -1;
  if (dir === "up") {
    for (let i = at - 1; i >= 0 && other < 0; i--) if (list[i]!.level <= level) other = i;
  } else {
    for (let i = at + 1; i < list.length && other < 0; i++) if (list[i]!.level <= level) other = i;
  }
  if (other < 0 || list[other]!.level !== level) return null;

  const [firstAt, secondAt] = dir === "up" ? [other, at] : [at, other];
  const a = sectionOf(lines, list, firstAt);
  const b = sectionOf(lines, list, secondAt);
  const text = (s: Section) => lines.slice(s.start, s.last + 1);
  const gap = (s: Section) => lines.slice(s.last + 1, s.end + 1);
  const moved = [...text(b), ...gap(a), ...text(a), ...gap(b)];
  const next = [...lines.slice(0, a.start), ...moved, ...lines.slice(b.end + 1)];
  const shift = dir === "up" ? -(a.last - a.start + 1 + gap(a).length) : text(b).length + gap(a).length;
  return { lines: next, from: a.start, to: b.end, shift };
}
