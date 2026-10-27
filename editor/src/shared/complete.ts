// Suggestions for tags and link targets, built from `tessela vocab`, so people and
// agents pick a term that exists instead of inventing a new one.

import type { VocabEntry } from "./api";

export interface Suggestion {
  concept: string;
  detail: string;
}

function detail(e: VocabEntry): string {
  const mentions = e.mentions === 1 ? "1 mention" : `${e.mentions} mentions`;
  return e.has_page ? mentions : `${mentions}, no page yet`;
}

/** Concepts that start with, then contain, `query`; the most used first. */
export function suggest(vocab: VocabEntry[], query: string, limit = 50): Suggestion[] {
  const q = query.toLowerCase().replace(/^#/, "");
  const usable = vocab.filter((e) => !e.deprecated && e.use_instead === null);
  const starts = usable.filter((e) => e.concept.startsWith(q));
  const contains = usable.filter((e) => !e.concept.startsWith(q) && e.concept.includes(q));
  const byUse = (a: VocabEntry, b: VocabEntry) =>
    b.mentions - a.mentions || a.concept.localeCompare(b.concept);
  return [...starts.sort(byUse), ...contains.sort(byUse)]
    .slice(0, limit)
    .map((e) => ({ concept: e.concept, detail: detail(e) }));
}
