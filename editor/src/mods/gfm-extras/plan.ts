// The gfm-extras mod's logic on plain text, so it is tested without an editor: which forms of
// GitHub-flavored Markdown a line holds (a callout marker, a footnote, math), and what the two
// "copy" commands put on the clipboard. Each form is drawn only where GitHub draws it too, so the
// page reads the same everywhere.

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

/** The kind a `> [!NOTE]` line starts, or null when the line is anything else. */
export function calloutKind(line: string): CalloutKind | null {
  const kind = /^\s{0,3}>\s?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec(line)?.[1]?.toLowerCase();
  return kind ? (kind as CalloutKind) : null;
}

// ---- footnotes ---------------------------------------------------------------

export interface FootnoteRef {
  id: string;
  /** Columns in the line: `[^id]` is [from, to). */
  from: number;
  to: number;
}

const REF = /\[\^([^\]\s]+)\]/g;

/** The label a line defines (`[^id]: text`), with the column its text starts at; null when it defines none. */
export function footnoteDefinition(line: string): { id: string; from: number; to: number; text: string } | null {
  const m = /^(\[\^([^\]\s]+)\]:)[ \t]*(.*)$/.exec(line);
  return m ? { id: m[2]!, from: 0, to: m[1]!.length, text: m[3]! } : null;
}

/** The references in a line: every `[^id]` except the label that starts a definition. */
export function footnoteRefs(line: string): FootnoteRef[] {
  const skip = footnoteDefinition(line)?.to ?? 0;
  return [...line.matchAll(REF)].filter((m) => m.index >= skip).map((m) => ({ id: m[1]!, from: m.index, to: m.index + m[0].length }));
}

export interface Footnotes {
  /** The number each label is shown as: by the order of its first reference, as GitHub does. */
  numbers: Map<string, number>;
  /** The line (0 is the first) that defines each label, and the text it gives (its indented lines too). */
  defs: Map<string, { line: number; text: string }>;
  /** The line of each label's first reference. */
  first: Map<string, number>;
}

/** Reads the footnotes of a page. `skip(line)` says a line is code, where nothing counts. */
export function footnotesOf(lines: string[], skip: (line: number) => boolean = () => false): Footnotes {
  const numbers = new Map<string, number>();
  const defs = new Map<string, { line: number; text: string }>();
  const first = new Map<string, number>();
  for (const [i, text] of lines.entries()) {
    if (skip(i)) continue;
    const def = footnoteDefinition(text);
    if (def && !defs.has(def.id)) {
      const parts = [def.text];
      for (let j = i + 1; j < lines.length && /^( {4}|\t)\S/.test(lines[j]!); j++) parts.push(lines[j]!.trim());
      defs.set(def.id, { line: i, text: parts.join(" ").trim() });
    }
    for (const r of footnoteRefs(text)) {
      if (!numbers.has(r.id)) {
        numbers.set(r.id, numbers.size + 1);
        first.set(r.id, i);
      }
    }
  }
  return { numbers, defs, first };
}

/** The label for the next footnote: the smallest number nothing uses yet. */
export function nextLabel(lines: string[]): string {
  const used = new Set(lines.flatMap((l) => [...l.matchAll(REF)].map((m) => m[1]!)));
  let n = 1;
  while (used.has(String(n))) n++;
  return String(n);
}

// ---- math --------------------------------------------------------------------

export interface MathSpan {
  tex: string;
  from: number;
  to: number;
}

/**
 * The inline math in a line: `$x$` (no space just inside the dollars, and not a price like
 * `$5 and $6`) or GitHub's `` $`x`$ ``. Text inside `code` is not math.
 */
export function inlineMath(line: string): MathSpan[] {
  const out: MathSpan[] = [];
  const code = [...line.matchAll(/`[^`]*`/g)];
  const inCode = (at: number) => code.some((m) => at > m.index && at < m.index + m[0].length);
  for (const m of line.matchAll(/(?<![\\$\w])\$`([^`\n]+)`\$|(?<![\\$\w])\$(?![\s$])((?:\\.|[^$\\\n])+?)(?<![\s\\])\$(?![\d$\w])/g)) {
    const tex = m[1] ?? m[2];
    if (tex !== undefined && !inCode(m.index)) out.push({ tex, from: m.index, to: m.index + m[0].length });
  }
  return out;
}

/** Where a `$$` block is: the lines from its opening `$$` to its closing one, and the TeX between. */
export function displayMath(lines: string[], skip: (line: number) => boolean = () => false): { from: number; to: number; tex: string }[] {
  const out: { from: number; to: number; tex: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (skip(i)) continue;
    const one = /^\s*\$\$(.+)\$\$\s*$/.exec(lines[i]!);
    if (one) {
      out.push({ from: i, to: i, tex: one[1]!.trim() });
      continue;
    }
    if (!/^\s*\$\$\s*$/.test(lines[i]!)) continue;
    const end = lines.findIndex((l, j) => j > i && /^\s*\$\$\s*$/.test(l));
    if (end < 0) break;
    out.push({ from: i, to: end, tex: lines.slice(i + 1, end).join("\n").trim() });
    i = end;
  }
  return out;
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
