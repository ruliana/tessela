// The order of the backlinks panel (spec §5). A link from a home page says "this page matters",
// so those mentions come first, the most specific folder's home first. After them, the most
// recently changed page comes first. Pages changed at the same time, or at an unknown time, keep their order.

import type { Hit } from "./api";

/** Whether `path` is a folder's `home.md`. */
export function isHomePath(path: string): boolean {
  return path === "home.md" || path.endsWith("/home.md");
}

/** Whether a hit sits on a home page. Older `tessela` builds do not say, so the path decides. */
export function isHomeHit(hit: Hit): boolean {
  return hit.home ?? isHomePath(hit.path);
}

/** Home hits first, deepest folder first; then newest file first; ties in their order. */
export function orderBacklinks(hits: Hit[]): Hit[] {
  const depth = (hit: Hit) => hit.path.split("/").length - 1;
  const rank = (hit: Hit) => (isHomeHit(hit) ? -(depth(hit) + 1) : 1);
  return hits
    .map((hit, i) => ({ hit, i }))
    .sort((a, b) => rank(a.hit) - rank(b.hit) || (b.hit.modified ?? -1) - (a.hit.modified ?? -1) || a.i - b.i)
    .map(({ hit }) => hit);
}
