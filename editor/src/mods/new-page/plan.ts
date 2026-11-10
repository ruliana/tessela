// The pure parts of the new-page mod: the types a new page can have, made from what
// `tessela index --dir templates` lists, and the choice among them.

/** What `tessela index --dir templates` lists for a template (the rest of its answer is not used). */
export interface TemplateEntry {
  path: string;
  type?: string | null;
  description?: string | null;
}

/** A type for a new page: `type` is what `add --type` is given, `label` what the picker shows. */
export interface PageKind {
  type: string;
  label: string;
  description?: string;
}

/** The plain page: the type a page has when none is chosen (`concept`). */
export const PLAIN = "concept";

/**
 * The types to choose from: "Page" first (the plain type, started from `templates/concept.md` when
 * the bundle has one), then each other template by name. Files that are not marked `type: template`
 * are not templates (the CLI does not use them either).
 */
export function kindsFrom(entries: TemplateEntry[]): PageKind[] {
  const templates = entries
    .filter((e) => e.type === "template" && /^templates\/[^/]+\.md$/.test(e.path))
    .map((e) => ({ type: e.path.slice("templates/".length, -".md".length), description: e.description?.trim() }))
    .sort((a, b) => a.type.localeCompare(b.type));
  const kind = (type: string, label: string, description?: string): PageKind => ({ type, label, ...(description ? { description } : {}) });
  const plain = templates.find((t) => t.type === PLAIN);
  return [kind(PLAIN, "Page", plain?.description), ...templates.filter((t) => t.type !== PLAIN).map((t) => kind(t.type, t.type, t.description))];
}

/** The type that comes `step` places after `current` in `kinds`, stopping at both ends. */
export function moveChoice(kinds: PageKind[], current: string, step: 1 | -1): string {
  const at = kinds.findIndex((k) => k.type === current);
  const next = Math.min(kinds.length - 1, Math.max(0, (at < 0 ? 0 : at) + step));
  return kinds[next]?.type ?? current;
}
