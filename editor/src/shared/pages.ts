// Page paths, IDs and the text of a page that does not exist yet.

export function pageId(path: string): string {
  return path.replace(/\.md$/i, "");
}

export function isJournalPath(path: string): boolean {
  return /^journals\/\d{4}-\d{2}-\d{2}\.md$/.test(path);
}

export function journalPath(day: string): string {
  return `journals/${day}.md`;
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

function yamlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The text a new page starts with: frontmatter that already passes `tessela lint`. */
export function newPageText(path: string, title?: string): string {
  if (isJournalPath(path)) {
    const day = pageId(path).slice("journals/".length);
    return `---\ntype: journal\ntitle: ${yamlString(day)}\ndate: ${yamlString(day)}\n---\n\n`;
  }
  const name = title ?? pageId(path).split("/").pop()?.replace(/-/g, " ") ?? "Untitled";
  return `---\ntype: concept\ntitle: ${yamlString(name)}\n---\n\n`;
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
