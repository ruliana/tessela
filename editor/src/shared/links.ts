// Concept references in text: the same rules as the Rust tools (spec §4).

export interface ConceptAt {
  kind: "tag" | "link";
  /** The concept ID, e.g. `project/tessela`. */
  id: string;
  /** The range of the tag or link in the line, for highlighting. */
  from: number;
  to: number;
}

function hasScheme(dest: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(dest);
}

export function normalizeConcept(name: string): string {
  return name.trim().replace(/^#/, "").toLowerCase().split(/\s+/).filter(Boolean).join("-");
}

/** Resolves a link target to a concept ID, or null for URLs and non-Markdown files. */
export function linkTargetId(dest: string, pageDir: string): string | null {
  const clean = dest.split(/[#?]/)[0] ?? "";
  if (clean === "" || hasScheme(clean)) return null;
  const stem = clean.replace(/\.md$/i, "");
  if (stem === clean) return null;
  const parts: string[] = stem.startsWith("/") ? [] : pageDir.split("/").filter(Boolean);
  for (const part of stem.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.length === 0 ? null : normalizeConcept(parts.join("/"));
}

const TAG = /(^|[^\p{L}\p{N}_&/#)])#([\p{L}\p{N}_/-]+)/gu;
const LINK = /\[[^\]]*\]\(([^)\s]*)\)/g;

/** Every tag and concept link in a line, in order. Links to URLs and files are left out. */
export function refsInLine(line: string, pageDir: string): ConceptAt[] {
  const found: ConceptAt[] = [];
  for (const m of line.matchAll(LINK)) {
    const from = m.index ?? 0;
    const id = linkTargetId(m[1] ?? "", pageDir);
    if (id) found.push({ kind: "link", id, from, to: from + m[0].length });
  }
  for (const m of line.matchAll(TAG)) {
    const from = (m.index ?? 0) + (m[1]?.length ?? 0);
    const body = (m[2] ?? "").replace(/[-/]+$/, "");
    const to = from + 1 + body.length;
    const insideLink = found.some((f) => f.kind === "link" && from >= f.from && from < f.to);
    if (!insideLink && /\p{L}/u.test(body)) {
      found.push({ kind: "tag", id: normalizeConcept(body), from, to });
    }
  }
  return found.sort((a, b) => a.from - b.from);
}

/** The tag or concept link that covers `column` in `line`, if any. */
export function conceptAt(line: string, column: number, pageDir: string): ConceptAt | null {
  return refsInLine(line, pageDir).find((r) => column >= r.from && column <= r.to) ?? null;
}
