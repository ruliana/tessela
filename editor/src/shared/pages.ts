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
