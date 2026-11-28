// HTML from the clipboard to the Markdown Tessela keeps. Pure text in, text out, so it is tested
// without a window (test/props.paste.test.ts). It is not a page parser: it reads a fragment that
// a browser or an office program put on the clipboard, and writes Markdown the page model then
// reads like anything typed.
//
// What it keeps: headings, paragraphs, bold, italic, strikethrough, code, code blocks, links,
// images, quotes, rules, nested lists with task boxes, and tables. Everything else (styles,
// classes, scripts, wrappers) is dropped and its text kept.

import { decodeEntities } from "./htmlText";
import { numericColumns } from "./numeric";

export interface Converted {
  markdown: string;
  /** Something more than plain paragraphs came out. When false the clipboard's plain text says the same. */
  rich: boolean;
}

interface Element {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
}
type Node = string | Element;

// ---------------------------------------------------------------- parsing

const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "col", "wbr", "area", "base", "source"]);
const SKIPPED = new Set(["script", "style", "head", "title", "template", "noscript", "svg", "iframe"]);
/** Opening one of these closes an open `p`. */
const CLOSES_P = new Set(["p", "div", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote", "table", "hr", "tr", "section", "article"]);

const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/y;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function attributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of source.matchAll(ATTR)) attrs[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  return attrs;
}

/** A forgiving reader: what a browser puts on the clipboard is well formed, what an office program puts there often is not. */
export function parseHtml(html: string): Element {
  const root: Element = { tag: "#root", attrs: {}, children: [] };
  const open: Element[] = [root];
  const top = () => open[open.length - 1]!;
  const closeTo = (tags: string[], stopAt: string[]): void => {
    for (let i = open.length - 1; i > 0; i--) {
      const t = open[i]!.tag;
      if (tags.includes(t)) return void open.splice(i);
      if (stopAt.includes(t)) return;
    }
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    const end = lt === -1 ? html.length : lt;
    if (end > i) top().children.push(decodeEntities(html.slice(i, end)));
    if (lt === -1) break;
    i = lt;
    if (html.startsWith("<!--", i)) {
      const close = html.indexOf("-->", i + 4);
      i = close === -1 ? html.length : close + 3;
      continue;
    }
    TAG.lastIndex = i;
    const m = TAG.exec(html);
    if (m === null) {
      // `<!DOCTYPE`, `<?xml` or a stray `<`.
      if (/^<[!?]/.test(html.slice(i, i + 2))) {
        const close = html.indexOf(">", i);
        i = close === -1 ? html.length : close + 1;
      } else {
        top().children.push("<");
        i += 1;
      }
      continue;
    }
    i = TAG.lastIndex;
    const tag = m[2]!.toLowerCase();
    if (m[1] === "/") {
      closeTo([tag], []);
      continue;
    }
    if (SKIPPED.has(tag)) {
      const close = html.toLowerCase().indexOf(`</${tag}`, i);
      const after = close === -1 ? -1 : html.indexOf(">", close);
      i = after === -1 ? html.length : after + 1;
      continue;
    }
    // Implied ends: a new `li` ends the open one, a block ends an open paragraph, and so on.
    if (tag === "li") closeTo(["li"], ["ul", "ol"]);
    else if (tag === "td" || tag === "th") closeTo(["td", "th"], ["tr", "table"]);
    else if (tag === "tr") closeTo(["tr"], ["table"]);
    if (CLOSES_P.has(tag) && top().tag === "p") open.pop();
    const element: Element = { tag, attrs: attributes(m[3] ?? ""), children: [] };
    top().children.push(element);
    if (!VOID.has(tag) && !m[3]?.trimEnd().endsWith("/")) open.push(element);
  }
  return root;
}

// ---------------------------------------------------------------- inline

const BLOCKS = new Set([
  "p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "figure", "figcaption", "details", "summary", "form", "fieldset",
  "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "dl", "dt", "dd", "pre", "blockquote", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "hr", "address", "center",
]);

/** The mark a tag stands for. */
function markOf(el: Element): "b" | "i" | "s" | "code" | null {
  switch (el.tag) {
    case "b": case "strong": return el.attrs.style !== undefined && /font-weight:\s*(normal|[1-5]00)\b/i.test(el.attrs.style) ? null : "b";
    case "i": case "em": case "cite": case "dfn": return "i";
    case "s": case "del": case "strike": return "s";
    case "code": case "tt": case "kbd": case "samp": return "code";
    default: return null;
  }
}

/** Marks that styles give (Google Docs, Word and browsers write bold as a `span` with a style). */
function styleMarks(el: Element): ("b" | "i" | "s")[] {
  const style = el.attrs.style;
  if (style === undefined || /^h[1-6]$|^th$/.test(el.tag)) return [];
  const marks: ("b" | "i" | "s")[] = [];
  if (/font-weight:\s*(bold|bolder|[6-9]00)\b/i.test(style) && markOf(el) !== "b") marks.push("b");
  if (/font-style:\s*italic/i.test(style) && markOf(el) !== "i") marks.push("i");
  if (/text-decoration[^;]*line-through/i.test(style) && markOf(el) !== "s") marks.push("s");
  return marks;
}

const DELIMITER = { b: "**", i: "*", s: "~~" } as const;

/** Text that Markdown would read as something else gets a backslash. */
export function escapeText(text: string): string {
  let out = "";
  const dollars = (text.match(/\$/g) ?? []).length >= 2;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const prev = text[i - 1] ?? "";
    const next = text[i + 1] ?? "";
    if (c === "\\" || c === "*" || c === "`" || c === "[" || c === "]") out += `\\${c}`;
    else if (c === "_") out += /[\p{L}\p{N}]/u.test(prev) && /[\p{L}\p{N}]/u.test(next) ? c : "\\_";
    else if (c === "~") out += prev === "~" || next === "~" ? "\\~" : c;
    else if (c === "<") out += /[A-Za-z/!?]/.test(next) ? "\\<" : c;
    else if (c === "&") out += /^#?\w+;/.test(text.slice(i + 1)) ? "\\&" : c;
    else if (c === "$") out += dollars ? "\\$" : c;
    else out += c;
  }
  return out;
}

/** A line of text that would start a block gets a backslash before the mark that does it. */
function escapeLineStart(line: string): string {
  return line
    .replace(/^(\s*)(#{1,6}(?:\s|$))/, "$1\\$2")
    .replace(/^(\s*)(>)/, "$1\\$2")
    .replace(/^(\s*)([-+])(\s|$)/, "$1\\$2$3")
    .replace(/^(\s*)(\d{1,9})([.)])(\s|$)/, "$1$2\\$3$4")
    .replace(/^(\s*)([-_]{3,}\s*)$/, "$1\\$2");
}

function plainText(node: Node): string {
  if (typeof node === "string") return node;
  if (node.tag === "br") return "\n";
  return node.children.map(plainText).join("");
}

function safeDestination(href: string | undefined, image: boolean): string | null {
  const h = (href ?? "").trim();
  if (!(image ? /^https?:\/\//i : /^(?:https?:\/\/|mailto:)/i).test(h)) return null;
  return h.replace(/[\s()<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

interface Seen {
  rich: boolean;
}

/** Output with the one rule that spaces do not pile up: text never starts with a space after one. */
class Writer {
  value = "";
  constructor(private atSpace: boolean) {}
  get endsInSpace(): boolean {
    return this.value === "" ? this.atSpace : /[ \n]$/.test(this.value);
  }
  text(s: string): void {
    const collapsed = s.replace(/[\s ]+/g, " ");
    this.value += this.endsInSpace ? collapsed.replace(/^ /, "") : collapsed;
  }
  raw(s: string): void {
    this.value += s;
  }
}

interface Marks {
  b: boolean;
  i: boolean;
  s: boolean;
}

function inline(nodes: Node[], w: Writer, marks: Marks, seen: Seen, escape = true): void {
  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n]!;
    if (typeof node === "string") {
      w.text(escape ? escapeText(node) : node);
      continue;
    }
    if (node.tag === "br") {
      // A line break is a backslash at the end of the line; trailing ones are dropped by the caller.
      w.raw("\\\n");
      continue;
    }
    if (node.tag === "img") {
      const src = safeDestination(node.attrs.src, true);
      const alt = (node.attrs.alt ?? "").replace(/\s+/g, " ").trim();
      if (src === null) {
        if (alt !== "") w.text(escapeText(alt));
      } else {
        w.raw(`![${escapeText(alt)}](${src})`);
        seen.rich = true;
      }
      continue;
    }
    if (node.tag === "input") {
      if ((node.attrs.type ?? "").toLowerCase() === "checkbox") w.raw(node.attrs.checked !== undefined ? "[x] " : "[ ] ");
      continue;
    }
    if (BLOCKS.has(node.tag)) {
      // A block inside inline content (a `div` in a link, say): its text, set apart by a space.
      w.text(" ");
      inline(node.children, w, marks, seen, escape);
      w.text(" ");
      continue;
    }
    if (node.tag === "a") {
      const dest = safeDestination(node.attrs.href, false);
      if (dest === null) {
        inline(node.children, w, marks, seen, escape);
        continue;
      }
      const same = plainText(node).trim() === (node.attrs.href ?? "").trim();
      if (same) {
        w.raw(dest);
        continue;
      }
      const sub = new Writer(false);
      inline(node.children, sub, marks, seen, escape);
      const core = sub.value.replace(/(\\\n)+$/, "").trim();
      if (core === "") continue;
      if (!w.endsInSpace && /^\s/.test(sub.value)) w.raw(" ");
      w.raw(`[${core}](${dest})`);
      if (/\s$/.test(sub.value)) w.raw(" ");
      seen.rich = true;
      continue;
    }
    const code = markOf(node) === "code";
    const added = [...(code ? [] : ([markOf(node), ...styleMarks(node)].filter((m): m is "b" | "i" | "s" => m !== null && m !== "code")))];
    const fresh = added.filter((m) => !marks[m]);
    if (code) {
      const text = plainText(node).replace(/\s+/g, " ");
      if (text.trim() === "") {
        w.text(" ");
        continue;
      }
      const core = text.trim();
      const longest = Math.max(0, ...(core.match(/`+/g) ?? []).map((r) => r.length));
      const fence = "`".repeat(longest + 1);
      const pad = core.startsWith("`") || core.endsWith("`") ? " " : "";
      if (/^\s/.test(text) && !w.endsInSpace) w.raw(" ");
      w.raw(`${fence}${pad}${core}${pad}${fence}`);
      if (/\s$/.test(text)) w.raw(" ");
      seen.rich = true;
      continue;
    }
    if (fresh.length === 0) {
      inline(node.children, w, marks, seen, escape);
      continue;
    }
    const sub = new Writer(false);
    const inner = { ...marks };
    for (const m of fresh) inner[m] = true;
    inline(node.children, sub, inner, seen, escape);
    // Marks go around the words, not the spaces next to them.
    const body = sub.value.replace(/(\\\n)+$/, "");
    const core = body.trim();
    if (core === "") {
      if (body !== "") w.text(" ");
      continue;
    }
    if (/^\s/.test(body) && !w.endsInSpace) w.raw(" ");
    const open = fresh.map((m) => DELIMITER[m]).join("");
    const close = [...fresh].reverse().map((m) => DELIMITER[m]).join("");
    w.raw(`${open}${core}${close}`);
    if (/\s$/.test(body)) w.raw(" ");
    seen.rich = true;
  }
}

/** The inline content of nodes as one line of Markdown (line breaks stay as backslash line ends). */
function inlineText(nodes: Node[], seen: Seen, escape = true): string {
  const w = new Writer(true);
  inline(nodes, w, { b: false, i: false, s: false }, seen, escape);
  return w.value.replace(/(\\\n|\s)+$/, "").replace(/^\s+/, "");
}

// ---------------------------------------------------------------- blocks

function indentLines(text: string, first: string, rest: string): string {
  return text
    .split("\n")
    .map((line, i) => (i === 0 ? first + line : line === "" ? rest.trimEnd() : rest + line))
    .join("\n");
}

/** Marks the paragraph's lines so that none of them starts a block. */
function paragraph(nodes: Node[], seen: Seen): string | null {
  const text = inlineText(nodes, seen);
  return text === "" ? null : text.split("\n").map(escapeLineStart).join("\n");
}


function isBlock(node: Node): boolean {
  return typeof node !== "string" && (BLOCKS.has(node.tag) || node.tag === "body" || node.tag === "html");
}

function holdsBlock(node: Node): boolean {
  return typeof node !== "string" && (isBlock(node) || node.children.some(holdsBlock));
}

/** An inline wrapper around blocks (Google Docs wraps a whole copy in a `b`) is only a wrapper. */
function unwrap(nodes: Node[]): Node[] {
  return nodes.flatMap((n) => (typeof n === "string" || isBlock(n) || !holdsBlock(n) ? [n] : unwrap(n.children)));
}

/** The blocks of a run of nodes: inline content between blocks becomes paragraphs. */
function blocks(children: Node[], seen: Seen): string[] {
  const nodes = unwrap(children);
  const out: string[] = [];
  let run: Node[] = [];
  const flush = () => {
    const p = paragraph(run, seen);
    if (p !== null) out.push(p);
    run = [];
  };
  for (const node of nodes) {
    if (typeof node === "string" || !isBlock(node)) {
      run.push(node);
      continue;
    }
    flush();
    out.push(...block(node, seen));
  }
  flush();
  return out;
}

function language(el: Element): string {
  const classes = `${el.attrs.class ?? ""} ${el.children.map((c) => (typeof c === "string" ? "" : (c.attrs.class ?? ""))).join(" ")}`;
  return /(?:^|\s)(?:language|lang)-([\w+#-]+)/.exec(classes)?.[1] ?? "";
}

function listItems(list: Element, seen: Seen): string {
  const ordered = list.tag === "ol";
  const start = ordered ? Number.parseInt(list.attrs.start ?? "1", 10) || 1 : 0;
  const items: { blocks: string[] }[] = [];
  for (const child of list.children) {
    if (typeof child === "string") continue;
    if (child.tag === "ul" || child.tag === "ol") {
      // A list straight inside a list (Google Docs writes nesting so) belongs to the item before it.
      const at = items[items.length - 1] ?? items[items.push({ blocks: [] }) - 1]!;
      at.blocks.push(listItems(child, seen));
      continue;
    }
    if (child.tag === "li") items.push({ blocks: blocks(child.children, seen) });
    else items.push({ blocks: blocks([child], seen) });
  }
  seen.rich = true;
  return items
    .map((item, k) => {
      const marker = ordered ? `${start + k}. ` : "- ";
      const parts = item.blocks;
      let body = "";
      parts.forEach((part, p) => {
        const nested = /^\s*(?:[-+*]|\d+[.)])\s/.test(part) && p > 0 && !/^\\/.test(part);
        body += p === 0 ? part : nested && !parts[p - 1]!.includes("\n\n") ? `\n${part}` : `\n\n${part}`;
      });
      return indentLines(body, marker, " ".repeat(marker.length));
    })
    .join("\n");
}

function tableRows(table: Element): Element[] {
  const rows: Element[] = [];
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (typeof n === "string") continue;
      if (n.tag === "tr") rows.push(n);
      else if (n.tag !== "table") walk(n.children);
    }
  };
  walk(table.children);
  return rows;
}

function cells(row: Element): Element[] {
  return row.children.filter((c): c is Element => typeof c !== "string" && (c.tag === "td" || c.tag === "th"));
}

function tableMarkdown(table: Element, seen: Seen): string[] {
  const rows = tableRows(table).map(cells).filter((r) => r.length > 0);
  // A table that lays a page out (one cell) is not data: its content is the content.
  if (rows.length === 1 && rows[0]!.length === 1) return blocks(rows[0]![0]!.children, seen);
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map((r) => r.length));
  const text = rows.map((r) =>
    Array.from({ length: width }, (_, c) => {
      const cell = r[c];
      if (!cell) return "";
      const inner = blocks(cell.children, seen).join("\n\n");
      return inner.replace(/\\\n|\n+/g, "<br>").replace(/\|/g, "\\|");
    }),
  );
  const line = (cs: string[]) => `| ${cs.map((c) => (c === "" ? " " : c)).join(" | ")} |`;
  seen.rich = true;
  // A column of numbers is right-aligned (`---:`), as a spreadsheet draws it.
  const numeric = numericColumns(text.slice(1), width);
  return [[line(text[0]!), line(numeric.map((n) => (n ? "---:" : "---"))), ...text.slice(1).map(line)].join("\n")];
}

function block(el: Element, seen: Seen): string[] {
  const { tag } = el;
  if (/^h[1-6]$/.test(tag)) {
    const text = inlineText(el.children, seen).replace(/\\\n/g, " ");
    if (text === "") return [];
    seen.rich = true;
    return [`${"#".repeat(Number(tag[1]))} ${text}`];
  }
  if (tag === "p") {
    const marks = styleMarks(el);
    const p = marks.length > 0 ? paragraph([{ tag: "span", attrs: { style: el.attrs.style ?? "" }, children: el.children }], seen) : paragraph(el.children, seen);
    return p === null ? [] : [p];
  }
  if (tag === "ul" || tag === "ol") return [listItems(el, seen)];
  if (tag === "pre") {
    const code = plainText(el).replace(/\r/g, "").replace(/\n$/, "");
    const longest = Math.max(0, ...(code.match(/`{3,}/g) ?? []).map((r) => r.length));
    const fence = "`".repeat(Math.max(3, longest + 1));
    seen.rich = true;
    return [`${fence}${language(el)}\n${code}\n${fence}`];
  }
  if (tag === "blockquote") {
    const inner = blocks(el.children, seen).join("\n\n");
    if (inner === "") return [];
    seen.rich = true;
    return [inner.split("\n").map((l) => (l === "" ? ">" : `> ${l}`)).join("\n")];
  }
  if (tag === "hr") {
    seen.rich = true;
    return ["---"];
  }
  if (tag === "table") return tableMarkdown(el, seen);
  if (tag === "li") return blocks(el.children, seen);
  // td, th, tr, div, section and the rest hold blocks of their own.
  return blocks(el.children, seen);
}

/** The Markdown for an HTML fragment, and whether it says more than plain paragraphs. */
export function htmlToMarkdown(html: string): Converted {
  const seen: Seen = { rich: false };
  const root = parseHtml(html);
  const markdown = blocks(root.children, seen).join("\n\n").trim();
  return { markdown, rich: seen.rich && markdown !== "" };
}
