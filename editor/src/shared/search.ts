// Searching the text of the notes with `tessela query --text`.

import type { Hit } from "./api";

/** Fewer characters than this match too much to be useful. */
export const MIN_SEARCH_CHARS = 2;

export function searchable(input: string): string | null {
  const text = input.trim();
  return text.length >= MIN_SEARCH_CHARS ? text : null;
}

/** A hit's text cut around the first match, so a long paragraph shows where it matched. */
export function excerpt(text: string, query: string, width = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= width) return flat;
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, Math.min(at < 0 ? 0 : at - Math.floor(width / 3), flat.length - width));
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + width)}${start + width < flat.length ? "…" : ""}`;
}

/** Text hits are blocks and headings; a page hit has no text of its own to match. */
export function textHits(hits: Hit[]): Hit[] {
  return hits.filter((h) => h.kind !== "page");
}
