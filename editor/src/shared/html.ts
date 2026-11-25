// The only HTML the editor draws. Everything else in a page is text, shown exactly as typed
// (a `<script>` in a table cell is the characters `<script>`, never an element).
//
// To allow more, add one entry to ALLOWED_HTML and a line to the table in docs/conventions.md.
// An entry is a fixed spelling: nothing the writer types between `<` and `>` is ever copied into
// the page, so an entry cannot carry attributes unless its pattern spells them out.

export type HtmlPiece = string | { element: "br" };

interface AllowedHtml {
  /** What is matched, in the Markdown text. */
  pattern: RegExp;
  /** Drawn in its place: text, or an element with no attributes. */
  draw: string | { element: "br" };
}

export const ALLOWED_HTML: readonly AllowedHtml[] = [
  { pattern: /&nbsp;/, draw: " " },
  { pattern: /<br ?\/?>/, draw: { element: "br" } },
];

const ANY = new RegExp(ALLOWED_HTML.map(({ pattern }) => `(${pattern.source})`).join("|"), "g");

/** Splits text into the plain text around the allowed HTML and what that HTML is drawn as. */
export function allowedHtml(text: string): HtmlPiece[] {
  const pieces: HtmlPiece[] = [];
  let last = 0;
  const push = (piece: HtmlPiece) => {
    const before = pieces[pieces.length - 1];
    if (typeof piece === "string" && typeof before === "string") pieces[pieces.length - 1] = before + piece;
    else if (piece !== "") pieces.push(piece);
  };
  for (const m of text.matchAll(ANY)) {
    const at = m.index ?? 0;
    push(text.slice(last, at));
    last = at + m[0].length;
    // The group that matched says which entry it is.
    push(ALLOWED_HTML[m.findIndex((g, i) => i > 0 && g !== undefined) - 1]!.draw);
  }
  push(text.slice(last));
  return pieces;
}
