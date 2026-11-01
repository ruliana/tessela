// What the command palette offers: pages and concepts that match what was typed, best first.

import type { PageEntry, VocabEntry } from "./api";
import { conceptPath, pageId } from "./pages";

/** How well `label` matches `query` (higher is better), or null when it does not match. */
export function score(label: string, query: string): number | null {
  const l = label.toLowerCase();
  const q = query.trim().toLowerCase();
  if (q === "") return 1;
  if (l === q) return 100;
  if (l.startsWith(q)) return 80;
  const at = l.indexOf(q);
  if (at >= 0) {
    const before = l[at - 1] ?? "";
    // At the start of a word (after a folder slash, a dash or a space) beats the middle of one.
    return /[\s/_-]/.test(before) ? 60 : 40 - Math.min(at, 20) / 2;
  }
  // The typed letters in order, like "tsl" for "tessela".
  let i = 0;
  for (const c of l) if (c === q[i] && ++i === q.length) return 10;
  return null;
}

/** The matching items, best first and then in the order given, at most `limit`. */
export function rank<T extends { label: string }>(items: T[], query: string, limit: number): T[] {
  return items
    .map((item, order) => ({ item, order, s: score(item.label, query) }))
    .filter((x): x is { item: T; order: number; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s || a.order - b.order)
    .slice(0, limit)
    .map((x) => x.item);
}

export interface Candidate {
  label: string;
  path: string;
  /** A concept that is mentioned but has no page yet. */
  unwritten: boolean;
}

/** Every page, and every concept that is mentioned without a page, once each. */
export function candidates(pages: PageEntry[], vocab: VocabEntry[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const p of pages) {
    const label = pageId(p.path);
    seen.add(label.toLowerCase());
    out.push({ label, path: p.path, unwritten: false });
  }
  for (const v of vocab) {
    if (v.deprecated || v.use_instead || v.has_page || v.concept.startsWith("journals/")) continue;
    if (seen.has(v.concept.toLowerCase())) continue;
    seen.add(v.concept.toLowerCase());
    out.push({ label: v.concept, path: conceptPath(v.concept), unwritten: true });
  }
  return out;
}
