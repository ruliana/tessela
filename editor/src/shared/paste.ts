// What a paste turns into. A pure plan from what is on the clipboard and what surrounds the cursor,
// so the rules are tested without a window (test/props.paste.test.ts, test/paste.test.ts).
// renderer/paste.ts applies the plan.
//
// In order: nothing special in code or for a file; an address over selected text links it; HTML that
// says more than plain text becomes Markdown; a bare address stays as it is and asks for its page
// title (it is upgraded to `[title](address)` when the title comes); a pasted list takes the
// indentation of the line it lands on.

import { isWebUrl, pasteLink } from "./format";
import { escapeText, htmlToMarkdown } from "./htmlToMarkdown";
import { isPublicWebUrl } from "./htmlText";

export interface PasteInput {
  plain: string;
  html: string;
  /** The clipboard's formats (`DataTransfer.types`). */
  types: readonly string[];
  /** The clipboard holds a file (a picture, say). The attach mod takes those. */
  hasFiles: boolean;
  /** The selected text; empty for a cursor. */
  selected: string;
  /** The line's text before the selection. */
  before: string;
  inCode: boolean;
  /** The cursor is in a link: in its text or its address. */
  inLink: boolean;
}

export interface PastePlan {
  /** How many characters before the selection the paste replaces too (an empty list marker). */
  back: number;
  insert: string;
  /** A web address inserted bare, whose page title to ask for. */
  title: string | null;
}

const MARKER = /^(?:[-+*]|\d{1,9}[.)])[ \t]+/;
const BARE_MARKER = /^(?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]*)?$/;
const QUOTE_AND_INDENT = /^(?:[ \t]*>)*[ \t]*/;

/** A pasted list that was indented with tabs is indented with the two spaces the editor uses. */
export function normalizeList(text: string): string {
  const lines = text.split("\n");
  const filled = lines.filter((l) => l.trim() !== "");
  if (filled.length === 0 || !filled.every((l) => /^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+/.test(l))) return text;
  return lines.map((l) => l.replace(/^[ \t]+/, (ws) => ws.replace(/\t/g, "  "))).join("\n");
}

/**
 * Where text lands at the end of `before` (the line up to the cursor): lines after the first are
 * indented to the line's own indentation and quote marks, so a list pasted at a nested item nests
 * there, and a list pasted over an empty item takes that item's place.
 */
export function place(before: string, text: string): { back: number; insert: string } {
  const lead = QUOTE_AND_INDENT.exec(before)![0];
  const rest = before.slice(lead.length);
  const listFirst = MARKER.test(text.split("\n", 1)[0]!.trimStart());
  let back = 0;
  let prefix = lead;
  if (rest !== "" && BARE_MARKER.test(rest)) {
    if (listFirst) back = rest.length;
    else prefix = lead + " ".repeat(MARKER.exec(rest)![0].length);
  } else if (rest !== "") {
    const marker = MARKER.exec(rest);
    prefix = lead + " ".repeat(marker?.[0].length ?? 0);
  }
  const insert = text
    .split("\n")
    .map((line, i) => (i === 0 ? line : line === "" ? prefix.trimEnd() : prefix + line))
    .join("\n");
  return { back, insert };
}

export function planPaste(input: PasteInput): PastePlan | null {
  const { selected, before } = input;
  const plain = input.plain.replace(/\r\n?/g, "\n");
  if (input.inCode) return null;
  if (input.hasFiles && plain.trim() === "") return null;

  if (selected !== "") {
    // An address over selected words makes them its link; over several lines it replaces them.
    const link = pasteLink(selected, plain);
    if (link !== null) return { back: 0, insert: link, title: null };
    if (selected.includes("\n") && isWebUrl(plain)) return { back: 0, insert: plain.trim(), title: null };
  }

  // Copying from a code editor brings HTML with a span for every colour; its plain text is right.
  if (input.html.trim() !== "" && !input.types.includes("vscode-editor-data")) {
    const { markdown, rich } = htmlToMarkdown(input.html);
    if (rich) return { ...place(before, normalizeList(markdown)), title: null };
  }

  const address = plain.trim();
  if (selected === "" && isWebUrl(address) && !address.includes("\n")) {
    return { back: 0, insert: address, title: !input.inLink && isPublicWebUrl(address) ? address : null };
  }

  const text = normalizeList(plain);
  const placed = place(before, text);
  return placed.back === 0 && placed.insert === plain ? null : { ...placed, title: null };
}

/** The Markdown link for a page title and its address. */
export function titleLink(title: string, url: string): string {
  const balanced = (url.match(/\(/g) ?? []).length === (url.match(/\)/g) ?? []).length;
  const dest = balanced ? url : url.replace(/[()]/g, (c) => (c === "(" ? "%28" : "%29"));
  return `[${escapeText(title)}](${dest})`;
}
