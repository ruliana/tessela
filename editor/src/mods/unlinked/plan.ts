// The pure parts of the unlinked mod: which page asks, how a mention reads in its block, and
// how a mention becomes a link in the text of its page.

import { isJournalPath, pageId } from "../../shared/pages";

/** One place where a page is named in plain words, as `tessela query --unlinked` reports it. */
export interface Mention {
  text: string;
  line: number;
  /** Bytes into the file's line; absent when the line could not be placed. */
  column?: number | null;
  /** What replaces the words: `[ML](/machine-learning.md)`. */
  link: string;
}

export interface UnlinkedHit {
  handle: string;
  path: string;
  line: number;
  text: string;
  mentions?: Mention[];
}

/** The concept to look for on the page at `path`, or null when the page has no plain-words mentions (a journal day, a non-page). */
export function conceptFor(path: string | null): string | null {
  if (!path || !path.endsWith(".md") || isJournalPath(path)) return null;
  return pageId(path);
}

/** One mention with the block it is in, which is what the list shows. */
export interface Entry {
  path: string;
  hit: UnlinkedHit;
  mention: Mention;
  /** The block's text split around the mention's words, or null when they are not in it. */
  parts: [string, string, string] | null;
}

/** Every mention of the hits as an entry, the pages in the order given, the mentions in the order written. */
export function entriesOf(hits: UnlinkedHit[]): Entry[] {
  const entries: Entry[] = [];
  for (const hit of hits) {
    let from = 0;
    for (const mention of hit.mentions ?? []) {
      const at = hit.text.indexOf(mention.text, from);
      if (at >= 0) from = at + mention.text.length;
      const parts: Entry["parts"] = at >= 0 ? [hit.text.slice(0, at), mention.text, hit.text.slice(at + mention.text.length)] : null;
      entries.push({ path: hit.path, hit, mention, parts });
    }
  }
  return entries;
}

/** "No unlinked mentions", "1 unlinked mention" or "4 unlinked mentions". */
export function countUnlinked(n: number): string {
  return `${n === 0 ? "No" : n} unlinked ${n === 1 ? "mention" : "mentions"}`;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The page's text with the mention written as its link, or null when the words are no longer where
 * the tool saw them (the page changed since). Only those words change: every other byte stays.
 */
export function linked(text: string, mention: Mention): string | null {
  const lines = text.split("\n");
  const row = lines[mention.line - 1];
  if (row === undefined) return null;
  let from: number;
  let to: number;
  if (mention.column === null || mention.column === undefined) {
    // The tool could not place it in the line; it counts only when the words are there once.
    from = row.indexOf(mention.text);
    if (from < 0 || row.indexOf(mention.text, from + 1) >= 0) return null;
    to = from + mention.text.length;
  } else {
    // The column is in bytes of the UTF-8 file, and the text here is UTF-16.
    const bytes = encoder.encode(row);
    const end = mention.column + encoder.encode(mention.text).length;
    if (decoder.decode(bytes.slice(mention.column, end)) !== mention.text) return null;
    from = decoder.decode(bytes.slice(0, mention.column)).length;
    to = from + mention.text.length;
  }
  lines[mention.line - 1] = row.slice(0, from) + mention.link + row.slice(to);
  return lines.join("\n");
}
