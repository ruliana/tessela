// A line of Markdown cut into the pieces that are drawn differently: text, tags, links,
// code and emphasis. Used where a block is shown outside the editor (the backlinks).

export type Part =
  | { kind: "text"; text: string }
  | { kind: "tag"; text: string }
  | { kind: "link"; text: string; dest: string }
  | { kind: "code" | "bold" | "italic" | "strike"; text: string };

const INLINE =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(~~[^~]+~~)|(\*[^*]+\*)|(!?)\[([^\]]*)\]\(([^)\s]*)\)|(?<![\p{L}\p{N}_&/#])#([\p{L}\p{N}_/-]+)/gu;

export function inlineParts(text: string): Part[] {
  const parts: Part[] = [];
  let last = 0;
  const push = (part: Part) => {
    if (part.text !== "") parts.push(part);
  };
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    push({ kind: "text", text: text.slice(last, at) });
    last = at + m[0].length;
    if (m[1]) push({ kind: "code", text: m[1].slice(1, -1) });
    else if (m[2]) push({ kind: "bold", text: m[2].slice(2, -2) });
    else if (m[3]) push({ kind: "strike", text: m[3].slice(2, -2) });
    else if (m[4]) push({ kind: "italic", text: m[4].slice(1, -1) });
    else if (m[8]) push({ kind: "tag", text: `#${m[8]}` });
    else if (m[5] === "!") push({ kind: "text", text: m[6] ?? "" });
    else push({ kind: "link", text: m[6] ?? "", dest: m[7] ?? "" });
  }
  push({ kind: "text", text: text.slice(last) });
  return parts;
}
