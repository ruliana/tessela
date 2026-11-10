// Building blocks for adding a link without typing the title and the path twice.
// Pure functions on text, so the options can be measured (test/linkFlows.test.ts)
// before any of them is wired into the editor.

import type { PageEntry, VocabEntry } from "./api";
import { candidates, score } from "./palette";
import { newPagePath, pageId } from "./pages";

/** A page the link picker can offer: where it lives and what it is called. */
export interface LinkPage {
  /** Relative to the notes folder, with `/` separators. */
  path: string;
  title: string;
}

/**
 * What a page calls itself: the `title:` of its front matter, else its first `#` heading, else its
 * file name. Tessela uses `#` headings only, so setext headings are not looked for.
 */
export function titleOf(text: string, path: string): string {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const body = fm ? text.slice(fm[0].length) : text;
  const quoted = fm ? /^title:\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(.+?))\s*$/m.exec(fm[1] ?? "") : null;
  const fromFrontMatter = quoted?.[1]?.replace(/\\(.)/g, "$1") ?? quoted?.[2] ?? quoted?.[3];
  if (fromFrontMatter?.trim()) return fromFrontMatter.trim();
  const heading = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(body);
  if (heading?.[1]) return heading[1].trim();
  return (pageId(path).split("/").pop() ?? path).replace(/-/g, " ");
}

/** The Markdown link the editor keeps in the file. */
export function markdownLink(text: string, dest: string): string {
  return `[${text}](${dest})`;
}

export interface LinkChoice {
  /** The link text to write. */
  text: string;
  /** The target to write, starting at the notes folder: `/some/page.md`. */
  dest: string;
  /** The page does not exist yet; choosing this creates a link to it. */
  fresh: boolean;
}

/** The best score of a page against what was typed, by its title or by its path. */
function pageScore(p: LinkPage, query: string): number | null {
  const a = score(p.title, query);
  const b = score(pageId(p.path), query);
  return a === null ? b : b === null ? a : Math.max(a, b);
}

/**
 * What to offer for `query`: the pages whose title or path match, best first, and a row that
 * links to a page of that name, which does not exist yet. That row goes first when no page
 * matches well (the start of a word or better) and last otherwise, so a half-typed
 * title still picks the page that exists, and a new title never picks one by accident.
 */
export function choicesFor(pages: LinkPage[], query: string, limit = 8): LinkChoice[] {
  const q = query.trim();
  const ranked = pages
    .map((p, order) => ({ p, order, s: pageScore(p, q) }))
    .filter((x): x is { p: LinkPage; order: number; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s || a.order - b.order);
  const found: LinkChoice[] = ranked
    .slice(0, limit)
    .map(({ p }) => ({ text: p.title, dest: `/${p.path}`, fresh: false }));
  const path = q === "" ? null : newPagePath(q);
  // A title that a page already has is that page, not a new one.
  if (path === null || pages.some((p) => p.path === path || p.title.toLowerCase() === q.toLowerCase())) return found;
  const create: LinkChoice = { text: q, dest: `/${path}`, fresh: true };
  return (ranked[0]?.s ?? 0) >= 60 ? [...found, create] : [create, ...found];
}

export interface BracketSearch {
  /** Where the `[` is in the text before the cursor. */
  start: number;
  /** What was typed after it, to look for a page by. */
  query: string;
  /** How many characters after the cursor go with the brackets: the rest of the text and the `]` closeBrackets added. */
  closing: number;
}

/**
 * A single `[` followed by letters is a search for a page: `[dai` offers "Daily TODO", and the
 * choice becomes `[Daily TODO](/daily-todo.md)`. It is not one for a task box (`[ ]`, `[x]`),
 * an image (`![`), text already followed by `(` (an existing link), or a tag.
 */
export function bracketSearch(before: string, after: string): BracketSearch | null {
  const m = /\[([^\][\n]*)$/.exec(before);
  if (!m) return null;
  const query = m[1] ?? "";
  const prev = before[m.index - 1] ?? "";
  if (prev === "[" || prev === "!") return null;
  if (query.trim() === "" || /^[xX]$/.test(query.trim()) || query.startsWith("#")) return null;
  const rest = /^[^\][\n]*\]/.exec(after);
  if (rest !== null && after[rest[0].length] === "(") return null;
  return { start: m.index, query, closing: rest?.[0].length ?? 0 };
}

const WEB_ADDRESS = /^(?:https?:\/\/|mailto:)\S+$/i;

/** Pasting an address over selected text makes the selection the link text. */
export function pasteLink(selected: string, clipboard: string): string | null {
  const dest = clipboard.trim();
  if (selected.trim() === "" || /[\n\r]/.test(selected) || !WEB_ADDRESS.test(dest)) return null;
  return markdownLink(selected, dest);
}

/** What the pickers search: every page by its title, and the concepts that are mentioned but have no page yet. */
export function linkPages(pages: PageEntry[], vocab: VocabEntry[]): LinkPage[] {
  const out: LinkPage[] = pages.map((p) => ({ path: p.path, title: p.title ?? titleOf("", p.path) }));
  for (const c of candidates(pages, vocab)) if (c.unwritten) out.push({ path: c.path, title: c.label });
  return out;
}
