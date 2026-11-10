// What a live list shows, worked out from what `tessela fence --json` answered. No DOM here.

/** Rows shown at most; the rest is counted. */
export const LIMIT = 200;

export interface RowView {
  text: string;
  /** The page the row came from, when it came from one: clicking the row opens it. */
  open?: { path: string; line?: number };
}

export type ListView =
  | { kind: "rows"; rows: RowView[]; more: number }
  | { kind: "empty" }
  | { kind: "error"; message: string };

type Row = { text?: unknown; source?: unknown };

function openOf(source: unknown): RowView["open"] {
  if (!source || typeof source !== "object") return undefined;
  const { path, line } = source as { path?: unknown; line?: unknown };
  // A folder row has a path too; only a page is opened.
  if (typeof path !== "string" || !path.endsWith(".md")) return undefined;
  return typeof line === "number" ? { path, line } : { path };
}

export function listOf(answer: unknown, limit = LIMIT): ListView {
  const a = (answer ?? {}) as { ok?: unknown; rows?: unknown; error?: { message?: unknown } };
  if (a.ok === false) return { kind: "error", message: typeof a.error?.message === "string" ? a.error.message : "the list could not be run" };
  if (!Array.isArray(a.rows)) return { kind: "error", message: "tessela fence did not answer with rows" };
  if (a.rows.length === 0) return { kind: "empty" };
  const rows = (a.rows as Row[]).slice(0, limit).map((r): RowView => {
    const open = openOf(r.source);
    return { text: String(r.text ?? ""), ...(open ? { open } : {}) };
  });
  return { kind: "rows", rows, more: Math.max(0, a.rows.length - rows.length) };
}
