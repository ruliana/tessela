// What in a line of text can be found by the tools: tags, links to concepts, dates. The
// editor colours these so it is clear what is queryable (spec §4, §7).

import { datesInLine } from "./dates";
import { normalizeConcept, refsInLine } from "./links";

export type TokenKind = "tag" | "concept" | "file" | "date" | "datetime";

export interface Token {
  from: number;
  to: number;
  kind: TokenKind;
  /** The concept a tag or concept link names. */
  id?: string;
}

const LINK = /\[[^\]]*\]\(([^)\s]*)\)/g;

/** A link to a file that is not a page, such as `[paper](./paper.pdf)`. */
function fileLinks(line: string): Token[] {
  const found: Token[] = [];
  for (const m of line.matchAll(LINK)) {
    const dest = (m[1] ?? "").split(/[#?]/)[0] ?? "";
    if (dest === "" || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(dest) || /\.md$/i.test(dest)) continue;
    const from = m.index ?? 0;
    found.push({ from, to: from + m[0].length, kind: "file" });
  }
  return found;
}

/** Tokens of a line, in order, not overlapping other tokens of the same sort. */
export function inlineTokens(line: string, pageDir: string): Token[] {
  const tokens: Token[] = [
    ...refsInLine(line, pageDir).map((r): Token => ({
      from: r.from,
      to: r.to,
      kind: r.kind === "tag" ? "tag" : "concept",
      id: r.id,
    })),
    ...fileLinks(line),
    ...datesInLine(line).map((d): Token => ({ from: d.from, to: d.to, kind: d.kind })),
  ];
  return tokens.sort((a, b) => a.from - b.from || a.to - b.to);
}

/**
 * The `tags` of the front matter, which tag the page itself (spec §2): `tags: [a, b]`, or a
 * list of `- a` lines under `tags:`. Returns the tokens by line index.
 */
export function frontmatterTags(lines: string[], end: number): Map<number, Token[]> {
  const found = new Map<number, Token[]>();
  const add = (line: number, from: number, to: number, name: string) => {
    const id = normalizeConcept(name);
    if (id === "") return;
    found.set(line, [...(found.get(line) ?? []), { from, to, kind: "tag", id }]);
  };
  let inTags = false;
  for (let i = 1; i < end; i++) {
    const text = lines[i]!;
    const key = /^([\w-]+):(.*)$/.exec(text);
    if (key) {
      inTags = key[1] === "tags";
      if (!inTags) continue;
      const value = key[2]!;
      const open = value.indexOf("[");
      const base = key[1]!.length + 1;
      if (open >= 0) {
        for (const m of value.slice(open + 1).matchAll(/[^,\]]+/g)) {
          const raw = m[0];
          const lead = raw.length - raw.trimStart().length;
          const word = raw.trim().replace(/^["']|["']$/g, "");
          if (word === "") continue;
          const from = base + open + 1 + (m.index ?? 0) + lead;
          add(i, from, from + raw.trim().length, word);
        }
        inTags = false;
      } else if (value.trim() !== "") {
        const lead = value.length - value.trimStart().length;
        add(i, base + lead, base + lead + value.trim().length, value.trim().replace(/^["']|["']$/g, ""));
      }
      continue;
    }
    const item = inTags ? /^(\s*-\s+)(.+?)\s*$/.exec(text) : null;
    if (item) add(i, item[1]!.length, item[1]!.length + item[2]!.length, item[2]!.replace(/^["']|["']$/g, ""));
    else if (!/^\s*$/.test(text) && !/^\s/.test(text)) inTags = false;
  }
  return found;
}
