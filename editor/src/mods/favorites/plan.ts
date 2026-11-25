// What the favorites mod decides, without the window: the list of favorite pages for one notes
// folder, and what happens to it when a page is marked, moved or deleted.

/** What was saved under a folder's name, as a clean list of paths: anything else is dropped. */
export function readList(saved: unknown): string[] {
  if (!Array.isArray(saved)) return [];
  const paths = saved.filter((p): p is string => typeof p === "string" && p !== "");
  return paths.filter((p, i) => paths.indexOf(p) === i);
}

/** `path` marked as a favorite (last in the list) or, when it already was one, unmarked. */
export function toggled(list: string[], path: string): string[] {
  return list.includes(path) ? list.filter((p) => p !== path) : [...list, path];
}

/** The list after a page changed place (`to`) or was deleted (`to` null): the favorite follows it or goes. */
export function followed(list: string[], from: string, to: string | null): string[] {
  const moved = list.flatMap((p) => (p !== from ? [p] : to === null ? [] : [to]));
  return moved.filter((p, i) => moved.indexOf(p) === i);
}

/** The favorites whose page is on disk, in order: one gone by an outside hand is hidden, not forgotten. */
export function present(list: string[], pages: Iterable<string>): string[] {
  const here = new Set(pages);
  return list.filter((p) => here.has(p));
}
