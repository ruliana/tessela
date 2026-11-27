// The gfm-extras mod's logic without an editor, so it is tested on its own: how footnotes are
// numbered, and what the two "copy" commands put on the clipboard. Which forms of GitHub-flavored
// Markdown a page holds (callouts, footnotes, math) is read from the editor's syntax tree, not here.
// Each form is drawn only where GitHub draws it too, so the page reads the same everywhere.

import { anchorOf, headingText } from "../../shared/links";
import { headingAt, headings } from "../outline/plan";

// ---- callouts ----------------------------------------------------------------

export const CALLOUTS = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
} as const;

export type CalloutKind = keyof typeof CALLOUTS;

// ---- footnotes ---------------------------------------------------------------

/** A reference `[^id]` in the text, from and to as positions in the page. */
export interface FootnoteRef {
  id: string;
  from: number;
  to: number;
}

/** A definition `[^id]: text`: where it starts, where its label is, and the text it gives (continuation lines included). */
export interface FootnoteDef {
  id: string;
  from: number;
  label: { from: number; to: number };
  text: string;
}

export interface Footnotes {
  /** The number each label is shown as: by the order of its first reference, as GitHub does. */
  numbers: Map<string, number>;
  /** The definition of each label; when a label is defined twice, the first one counts. */
  defs: Map<string, FootnoteDef>;
  /** The position of each label's first reference. */
  first: Map<string, number>;
}

/** Numbers the footnotes of a page from its references and definitions, both in the order of the page. */
export function numberFootnotes(refs: readonly FootnoteRef[], defs: readonly FootnoteDef[]): Footnotes {
  const numbers = new Map<string, number>();
  const first = new Map<string, number>();
  const byId = new Map<string, FootnoteDef>();
  for (const def of defs) if (!byId.has(def.id)) byId.set(def.id, def);
  for (const r of refs) {
    if (!numbers.has(r.id)) {
      numbers.set(r.id, numbers.size + 1);
      first.set(r.id, r.from);
    }
  }
  return { numbers, defs: byId, first };
}

/** The label for the next footnote: the smallest number that none of the `used` labels is. */
export function nextLabel(used: Iterable<string>): string {
  const taken = new Set(used);
  let n = 1;
  while (taken.has(String(n))) n++;
  return String(n);
}

// ---- the copy commands -------------------------------------------------------

/** The title of a page as the tools see it: front matter `title:`, else the first `#` heading, else the file name. */
export function pageTitle(lines: string[], path: string): string {
  const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  if (end > 0) {
    const title = lines.slice(1, end).map((l) => /^title:\s*(.+)$/.exec(l)?.[1]).find(Boolean);
    if (title) return title.replace(/^(["'])(.*)\1$/, "$2");
  }
  const heading = lines.find((l, i) => i > end && /^ {0,3}#\s/.test(l));
  if (heading) return headingText(heading);
  return (path.split("/").pop() ?? path).replace(/\.md$/, "").replace(/-/g, " ");
}

/** The link to the heading the line is in: `[Text](/page.md#anchor)`; null above the first heading. */
export function headingLink(lines: string[], line: number, path: string): string | null {
  const all = headings(lines);
  const here = headingAt(all, line);
  if (!here) return null;
  const base = anchorOf(here.text);
  // GitHub tells repeated headings apart with -1, -2, and the editor follows the same rule.
  const before = all.slice(0, all.indexOf(here)).filter((h) => anchorOf(h.text) === base).length;
  const anchor = before === 0 ? base : `${base}-${before}`;
  return `[${here.text}](/${path}#${anchor})`;
}

/** `text` as a quote with the page it came from linked under it. */
export function asQuote(text: string, title: string, path: string): string {
  const quoted = text
    .replace(/\s+$/, "")
    .split("\n")
    .map((l) => (l === "" ? ">" : `> ${l}`))
    .join("\n");
  return `${quoted}\n>\n> — [${title}](/${path})\n`;
}
