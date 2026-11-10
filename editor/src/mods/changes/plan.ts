// The pure parts of the changes mod: how a change is put back (the text a page has after one
// block is undone), how a deleted page is written again, and which changes were kept.
// `tessela changes` says what differs; this turns one difference into the page text before it.

/** What the mod uses of a change in the answer of `tessela changes`. */
export interface Change {
  kind: "added" | "removed" | "changed";
  unit: "block" | "heading" | "properties";
  handle?: string | null;
  heading_path: string[];
  /** Added and changed: the first line in the text now. Removed: in the old text. */
  line: number;
  text: string;
  /** The unit's source lines in the text now (the old text when removed). */
  raw: string;
  old_text?: string;
  old_line?: number;
  old_raw?: string;
}

export interface PageChange {
  path: string;
  status: "added" | "modified" | "deleted";
  hash: string | null;
  changes: Change[];
}

export interface ChangesAnswer {
  since: string;
  commit: string | null;
  pages: PageChange[];
}

/** A page's text as lines, and whether it ended with a newline (which `split` shows as a last empty line). */
function linesOf(text: string): { lines: string[]; eol: boolean } {
  const eol = text.endsWith("\n");
  return { lines: (eol ? text.slice(0, -1) : text).split("\n"), eol };
}

const textOf = (lines: string[], eol: boolean) => lines.join("\n") + (eol ? "\n" : "");

/** Whether `raw` is what `lines` holds from the 1-based `line`. */
function sitsAt(lines: string[], line: number, raw: string): boolean {
  const want = raw.split("\n");
  return line >= 1 && want.every((l, i) => lines[line - 1 + i] === l);
}

/**
 * The text of the page with `change` undone, or null when the page no longer reads as it did when the
 * change was listed (it was edited since: draw the list again). An added unit is taken out (with the
 * blank line after it), a changed one gets its old lines back, and a removed one is written again where
 * it was, at the first boundary between blocks at or after its old line.
 */
export function putBack(text: string, change: Change): string | null {
  const { lines, eol } = linesOf(text);
  const raw = change.raw.split("\n");
  if (change.kind === "added") {
    if (!sitsAt(lines, change.line, change.raw)) return null;
    const from = change.line - 1;
    const after = lines[from + raw.length];
    // The blank line that separated it from the next block goes too; the last block takes the one before.
    if (after !== undefined && after.trim() === "") lines.splice(from, raw.length + 1);
    else if (from > 0 && lines[from - 1]?.trim() === "") lines.splice(from - 1, raw.length + 1);
    else lines.splice(from, raw.length);
    return textOf(lines, eol);
  }
  if (change.kind === "changed") {
    if (change.old_raw === undefined || !sitsAt(lines, change.line, change.raw)) return null;
    lines.splice(change.line - 1, raw.length, ...change.old_raw.split("\n"));
    return textOf(lines, eol);
  }
  // Removed: where the old line is now, moved forward to the start of a block.
  let at = Math.min(Math.max(change.line - 1, 0), lines.length);
  while (at > 0 && at < lines.length && lines[at - 1]?.trim() !== "") at++;
  if (at >= lines.length) {
    if (lines.length === 0 || lines.every((l) => l.trim() === "")) return textOf(raw, true);
    lines.push("", ...raw);
  } else {
    lines.splice(at, 0, ...raw, "");
  }
  return textOf(lines, true);
}

/**
 * A deleted page written again from what `changes` says was removed: its properties, then every
 * heading and block in order, a blank line between. Null when nothing is known of the page.
 */
export function restoredPage(page: PageChange): string | null {
  const units = page.changes.filter((c) => c.kind === "removed");
  if (units.length === 0) return null;
  const ordered = [...units].sort((a, b) => a.line - b.line || (a.unit === "block" ? 1 : 0) - (b.unit === "block" ? 1 : 0));
  return ordered.map((c) => c.raw).join("\n\n") + "\n";
}

/** The mark of a change that was kept, the same whichever revision the notes are compared with. */
export function keptKey(path: string, change: Change): string {
  return [path, change.kind, change.raw, change.old_raw ?? ""].join("\u0000");
}

/** The most kept changes remembered; the oldest are forgotten first. */
export const KEPT_LIMIT = 500;

/** `kept` with `key` added (last), the oldest dropped when there are too many. */
export function remember(kept: string[], ...keys: string[]): string[] {
  return [...kept.filter((k) => !keys.includes(k)), ...keys].slice(-KEPT_LIMIT);
}

/** The plain count line over the list. */
export function summary(pages: number, changes: number, kept: number): string {
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  if (changes === 0 && kept === 0) return "Nothing differs.";
  const head = changes === 0 ? "Nothing left to look at" : `${n(changes, "change")} in ${n(pages, "page")}`;
  return kept > 0 ? `${head} · ${kept} kept` : head;
}
