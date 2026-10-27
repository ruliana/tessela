// Where the user has been: the back/forward history and the "Recent" list.

/** A place the middle of the window can show. */
export type Place = { kind: "page"; path: string } | { kind: "journals" };

export interface History {
  places: Place[];
  /** Index of the place being shown; -1 before anything was shown. */
  at: number;
}

const HISTORY_LIMIT = 100;

export function emptyHistory(): History {
  return { places: [], at: -1 };
}

export function samePlace(a: Place | undefined, b: Place): boolean {
  if (!a || a.kind !== b.kind) return false;
  return a.kind === "journals" || (b.kind === "page" && a.path === b.path);
}

/** Showing `place` by the user's own doing: what lay ahead of the current place is dropped. */
export function visit(h: History, place: Place): History {
  if (samePlace(h.places[h.at], place)) return h;
  const places = [...h.places.slice(0, h.at + 1), place].slice(-HISTORY_LIMIT);
  return { places, at: places.length - 1 };
}

export const canGoBack = (h: History): boolean => h.at > 0;
export const canGoForward = (h: History): boolean => h.at >= 0 && h.at < h.places.length - 1;

/** The history moved one place back or forward (same history when there is nowhere to go). */
export function step(h: History, by: -1 | 1): History {
  const at = h.at + by;
  return at < 0 || at >= h.places.length ? h : { ...h, at };
}

export const RECENT_DEFAULT = 6;
export const RECENT_MAX = 30;
/** More are remembered than shown, so showing more later brings them back. */
const RECENT_KEPT = 50;

/** A number of recent pages to show: a whole number from 1 to the maximum. */
export function recentCount(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, RECENT_MAX) : RECENT_DEFAULT;
}

/** `path` becomes the most recently used page. */
export function touch(recent: string[], path: string): string[] {
  return [path, ...recent.filter((p) => p !== path)].slice(0, RECENT_KEPT);
}
