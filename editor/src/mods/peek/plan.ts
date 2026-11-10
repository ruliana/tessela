// The pure parts of the peek mod: what is under the cursor, and how a list of mentions reads.

import { dayAt } from "../../shared/dates";
import { conceptAt } from "../../shared/links";
import { conceptPath } from "../../shared/pages";

/** What a peek is about: a page or concept (`path` is where its page is, or would be), or a day of the journal. */
export type PeekTarget = { kind: "concept"; id: string; path: string } | { kind: "day"; day: string; id: string; path: string };

const JOURNAL = /^journals\/(\d{4}-\d{2}-\d{2})$/;

/**
 * The tag, link or date the cursor is in, at `column` of `line` in a page of the folder `pageDir`.
 * A link to a journal page is a day, like a date written out. Links to the web and to files are not peeked at.
 */
export function peekAt(line: string, column: number, pageDir: string): PeekTarget | null {
  const ref = conceptAt(line, column, pageDir);
  if (ref) {
    const day = JOURNAL.exec(ref.id)?.[1];
    return day ? { kind: "day", day, id: ref.id, path: conceptPath(ref.id) } : { kind: "concept", id: ref.id, path: conceptPath(ref.id) };
  }
  const at = dayAt(line, column);
  return at ? { kind: "day", day: at.day, id: `journals/${at.day}`, path: `journals/${at.day}.md` } : null;
}

/** Hits once each (by handle), without those on the peeked page itself. */
export function mentionsOf<T extends { handle: string; path: string }>(hits: T[], path: string): T[] {
  const seen = new Set<string>();
  return hits.filter((h) => h.path !== path && !seen.has(h.handle) && seen.add(h.handle));
}

/** "No mentions", "1 mention" or "4 mentions". */
export function countMentions(n: number): string {
  return n === 0 ? "No mentions" : n === 1 ? "1 mention" : `${n} mentions`;
}
