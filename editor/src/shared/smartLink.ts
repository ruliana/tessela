// Ctrl+L: turn the selection into a Markdown link and leave the cursor on the
// missing half (spec §11).

export interface LinkEdit {
  /** What replaces the selection. */
  text: string;
  /** Where the cursor goes, as an offset into `text`. */
  cursor: number;
  /** Whether the cursor lands inside the `(...)` target, where concepts can be suggested. */
  inTarget: boolean;
}

const URL_LIKE = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/|mailto:)\S+$/;
const PATH_LIKE = /^(?:\/|\.{1,2}\/|~\/|[a-zA-Z]:[\\/])\S*$/;

export function isTarget(selected: string): boolean {
  const s = selected.trim();
  return URL_LIKE.test(s) || PATH_LIKE.test(s);
}

export function smartLink(selected: string): LinkEdit {
  if (selected === "") return { text: "[]()", cursor: 1, inTarget: false };
  if (isTarget(selected)) {
    return { text: `[](${selected})`, cursor: 1, inTarget: false };
  }
  return { text: `[${selected}]()`, cursor: selected.length + 3, inTarget: true };
}
