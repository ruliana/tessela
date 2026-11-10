// Page paths and IDs. The text of a new page is made by `tessela add`.

export function pageId(path: string): string {
  return path.replace(/\.md$/i, "");
}

export function isJournalPath(path: string): boolean {
  return /^journals\/\d{4}-\d{2}-\d{2}\.md$/.test(path);
}

/** The folder a page is in, without the trailing slash ("" for the root). */
export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** The concept to ask about for the page at `path`, or null for a journal day or something that is not a page. */
export function conceptFor(path: string | null): string | null {
  if (!path || !path.endsWith(".md") || isJournalPath(path)) return null;
  return pageId(path);
}

export function journalPath(day: string): string {
  return `journals/${day}.md`;
}

/** The link to a day's journal, the way a Markdown link writes it. */
export function journalDest(day: string): string {
  return `/${journalPath(day)}`;
}

/** `YYYY-MM-DD` in local time. */
export function localDay(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** A concept name as a file path: lowercase, words joined by `-`, `/` kept. */
export function conceptPath(name: string): string {
  const parts = name
    .trim()
    .toLowerCase()
    .replace(/^#/, "")
    .split("/")
    .map((p) => p.trim().replace(/\s+/g, "-"))
    .filter((p) => p.length > 0);
  return `${parts.join("/")}.md`;
}

/**
 * The path for a page typed by name in the "New page" box, or null when the name cannot be a
 * page: nothing typed, or a part that is `.`/`..` or hidden. A trailing `.md` is not doubled.
 */
export function newPagePath(input: string): string | null {
  const name = input.trim().replace(/\.md$/i, "");
  const path = conceptPath(name);
  if (path === ".md") return null;
  if (path.split("/").some((part) => part.startsWith("."))) return null;
  return path;
}

/** The title a new page starts with: what was typed, without a folder or `.md`, so it keeps its capitals and spaces. */
export function newPageTitle(input: string): string | undefined {
  return input.trim().replace(/\.md$/i, "").split("/").pop()?.trim();
}

/** Newest day first. Days are `YYYY-MM-DD`, so plain string order is date order. */
export function newestFirst(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

/**
 * The days the journals view stacks, most recent first. Today is always among them (it may have
 * no file yet), and so are any days after it, so the order is by date and not "today, then the rest".
 */
export function journalDays(paths: string[], today: string, count: number): string[] {
  const days = new Set(paths.filter(isJournalPath).map((p) => pageId(p).slice("journals/".length)));
  days.add(today);
  const sorted = [...days].sort(newestFirst);
  return sorted.slice(0, Math.max(count, sorted.indexOf(today) + 1));
}
