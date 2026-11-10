// The pure parts of the related mod: which page asks, and how the answer of `tessela related`
// reads as rows (what is mentioned together with the page) and a trail (the home pages that lead to it).

import { isJournalPath, pageId } from "../../shared/pages";

export interface PageRef {
  path: string;
  title: string;
}

/** One concept that is mentioned together with the page, as `tessela related` reports it. */
export interface Together {
  concept: string;
  /** The concept's page, when it has one. */
  page: PageRef | null;
  reason: string;
}

export interface Related {
  together: Together[];
  chain: PageRef[];
  /** `links` when the home pages are a path of links from the root's; `folders` when they are only those of the folders around the page. */
  chain_by: "links" | "folders";
}

/** The concept to ask about for the page at `path`, or null for a journal day or something that is not a page. */
export function conceptFor(path: string | null): string | null {
  if (!path || !path.endsWith(".md") || isJournalPath(path)) return null;
  return pageId(path);
}

/** What a home page is called in the trail: the folder it is the start of, `Home` for the root's. */
export function homeLabel(path: string): string {
  const folder = path.split("/").slice(0, -1).join("/");
  return folder === "" ? "Home" : folder;
}

/** At most `limit` of the concepts mentioned together, the page's own concept never among them. */
export function togetherRows(answer: Related, limit = 8): Together[] {
  return answer.together.slice(0, limit);
}

/**
 * The home pages to show as a trail. A path of links is always one; the home pages of the folders
 * around a page are one too, except the root's, which every page has and so says nothing.
 */
export function trailOf(answer: Related): PageRef[] {
  return answer.chain_by === "links" ? answer.chain : answer.chain.filter((h) => h.path.includes("/"));
}

/** Whether there is anything to show for a page. */
export const isEmpty = (answer: Related): boolean => answer.together.length === 0 && trailOf(answer).length === 0;
