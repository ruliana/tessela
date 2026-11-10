// The pure parts of the pages mod: what its dialogs say, and the names it suggests.

/** What `tessela rename` and `tessela move` answer; `updated` lists the pages whose text changes. */
export interface MoveAnswer {
  from: string;
  to: string;
  updated: { path: string; links: number; tags: number }[];
  warnings: string[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 references in 2 pages will change", counting the other pages only (the moved page's own links are its business). */
export function describeChange(answer: MoveAnswer): string {
  const others = answer.updated.filter((u) => u.path !== answer.from && u.path !== answer.to);
  const refs = others.reduce((n, u) => n + u.links + u.tags, 0);
  if (refs === 0) return "No other page refers to it, so no other page changes.";
  return `${plural(refs, "reference", "references")} in ${plural(others.length, "page", "pages")} will change.`;
}

/** The pages (not the moved one) that change, to list under the summary. */
export function changedPages(answer: MoveAnswer): string[] {
  return answer.updated.filter((u) => u.path !== answer.from && u.path !== answer.to).map((u) => u.path);
}

/** The file name a title asks for: lowercase, spaces as hyphens, or null when it cannot be a name (empty, a `/`). */
export function nameForTitle(title: string): string | null {
  const name = title.trim().split(/\s+/).join("-").toLowerCase();
  return name === "" || /[/\\]/.test(name) ? null : name;
}

/** `notes/idea.md` is `idea`. */
export function stemOf(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/, "");
}

/** `notes/idea.md` is `notes/`; a page at the root is the empty string. */
export function folderOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i + 1);
}

/** The pages that mention the page at `path`, once each, from the hits of a query on its id. */
export function mentioning(hits: { path: string }[], path: string): { pages: string[]; mentions: number } {
  const others = hits.filter((h) => h.path !== path);
  return { pages: [...new Set(others.map((h) => h.path))], mentions: others.length };
}
