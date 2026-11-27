// Tessela's own Markdown syntax, as @lezer/markdown extensions. The editor reads a page with one
// parser, the CodeMirror syntax tree, so everything that something draws, folds or selects has
// to be a node in it. CommonMark and GFM give the rest; this file adds what they do not:
//
//   FrontMatter      `---` ... `---` (or `...`) on the first lines of the page, as written by
//                    `tessela`. Children: FrontMatterMark, FrontMatterContent (the YAML), FrontMatterMark.
//   Callout          a quote whose first line is `> [!NOTE]` (also TIP, IMPORTANT, WARNING, CAUTION).
//                    Children: QuoteMark, CalloutMark (`[!NOTE]`), then the blocks inside it.
//   FootnoteDefinition
//                    `[^id]: text`, and every line that continues it: indented by four, or lazy.
//                    Children: FootnoteLabel (`[^id]:`), then the blocks inside it.
//   FootnoteReference
//                    `[^id]` in text.
//   MathBlock        `$$` on a line, the TeX (blank lines included), `$$` on a line; or `$$tex$$`
//                    alone on a line. Children: MathMark, MathText, MathMark. Like a code fence, a
//                    block that is never closed runs to the end of what holds it, and then has just
//                    the first MathMark: whatever draws it should draw only blocks that closed.
//   InlineMath       `$x$` (no space just inside the dollars, and not a price like `$5 and $6`)
//                    or GitHub's `` $`x`$ ``. Children: two MathMark.
//
// The extensions only add nodes. Nothing here reads a page on its own.

import { yamlLanguage } from "@codemirror/lang-yaml";
import { parseMixed } from "@lezer/common";
import { tags } from "@lezer/highlight";
import type { BlockContext, Element, Line, MarkdownConfig } from "@lezer/markdown";

/**
 * Tessela writes headings with `#`. A line of dashes or equals under a paragraph is a rule or
 * text, not an underline: otherwise `hello---` on the first line of a page, in front of the
 * front matter, turned the whole front matter into one big heading.
 */
export const noSetext: MarkdownConfig = { remove: ["SetextHeading"] };

/** The kinds of callout, as GitHub writes them. */
export const CALLOUT_KINDS = ["note", "tip", "important", "warning", "caution"] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

const GT = 62;
const OPEN_BRACKET = 91;
const DOLLAR = 36;

const isSpace = (code: number) => code === 32 || code === 9;

/** The text of the line from its first character that is not markup of a container around it. */
const rest = (line: Line) => line.text.slice(line.pos);

/** True when the line is indented enough, relative to its container, to be code instead. */
const indentedCode = (line: Line) => line.indent - line.baseIndent >= 4;

/** The blocks of the container that is being parsed: lezer keeps the stack private. */
interface Internals {
  input: { length: number; read(from: number, to: number): string };
  stack: { end: number }[];
}
const internals = (cx: BlockContext) => cx as unknown as Internals;
/** How many of the containers around the line it has been read through so far: lezer keeps that private too. */
const depthOf = (line: Line) => (line as unknown as { depth: number }).depth;

// ---- front matter ------------------------------------------------------------

/** Where the front matter that opens `text` ends: the offset after its closing line, or -1 when there is none. */
export function frontMatterLength(text: string): number {
  const lines = /^---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!lines) return -1;
  let at = lines[0].length;
  while (at < text.length) {
    const nl = text.indexOf("\n", at);
    const end = nl < 0 ? text.length : nl;
    if (/^(?:---|\.\.\.)[ \t\r]*$/.test(text.slice(at, end))) return end;
    if (nl < 0) break;
    at = nl + 1;
  }
  return -1;
}

const FrontMatter: MarkdownConfig = {
  defineNodes: [
    { name: "FrontMatter", block: true },
    { name: "FrontMatterMark", style: tags.meta },
    { name: "FrontMatterContent" },
  ],
  parseBlock: [
    {
      name: "FrontMatter",
      before: "IndentedCode",
      parse(cx, line) {
        if (cx.lineStart !== 0 || cx.depth !== 1 || line.text.trimEnd() !== "---") return false;
        if (!closesFrontMatter(cx)) return false;
        const marks: Element[] = [cx.elt("FrontMatterMark", 0, 3)];
        let content: [number, number] | null = null;
        let end = 3;
        while (cx.nextLine()) {
          const text = line.text.trimEnd();
          const start = cx.lineStart;
          if (text === "---" || text === "...") {
            if (content) marks.push(cx.elt("FrontMatterContent", content[0], content[1]));
            marks.push(cx.elt("FrontMatterMark", start, start + text.length));
            end = start + text.length;
            cx.nextLine();
            break;
          }
          content = [content?.[0] ?? start, start + line.text.length];
        }
        cx.addElement(cx.elt("FrontMatter", 0, end, marks));
        return true;
      },
    },
  ],
};

/**
 * Reads the YAML of the front matter with the YAML parser. It is apart from `tessela` because it
 * puts a `Stream` node in the place of `FrontMatterContent` for whoever walks the tree into the
 * YAML: the editor needs the colours, a reader of the page structure does not.
 */
export const frontMatterYaml: MarkdownConfig = {
  wrap: parseMixed((node) => (node.name === "FrontMatterContent" ? { parser: yamlLanguage.parser } : null)),
};

/** Looks ahead, in growing steps (nearly every page closes its front matter in the first few lines), for the closing line. */
function closesFrontMatter(cx: BlockContext): boolean {
  const { input } = internals(cx);
  for (let size = 2048; ; size *= 4) {
    const whole = size >= input.length;
    let text = input.read(0, Math.min(size, input.length));
    // The window may cut a line short, and a cut `----` looks like `---`.
    if (!whole) text = text.slice(0, text.lastIndexOf("\n") + 1);
    if (frontMatterLength(text) >= 0) return true;
    if (whole) return false;
  }
}

// ---- callouts ----------------------------------------------------------------

const CALLOUT = /^>[ \t]?(\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\])[ \t]*$/i;

/** The kind of a callout from the text of its `CalloutMark`, `[!NOTE]`. */
export function calloutKindOf(mark: string): CalloutKind | null {
  const kind = /^\[!(\w+)\]$/.exec(mark)?.[1]?.toLowerCase();
  return (CALLOUT_KINDS as readonly string[]).includes(kind ?? "") ? (kind as CalloutKind) : null;
}

const Callout: MarkdownConfig = {
  defineNodes: [
    {
      name: "Callout",
      // A callout is a quote, and looks like one until something draws it differently.
      composite(cx, line) {
        if (line.next !== GT) return false;
        const at = cx.lineStart + line.pos;
        line.markers.push(cx.elt("QuoteMark", at, at + 1));
        line.moveBase(line.pos + (isSpace(line.text.charCodeAt(line.pos + 1)) ? 2 : 1));
        // The container ends where its last marker is, so the markers of its later lines stay inside it.
        internals(cx).stack[depthOf(line)]!.end = cx.lineStart + line.text.length;
        return true;
      },
      style: { "Callout/...": tags.quote },
    },
    { name: "CalloutMark" },
  ],
  parseBlock: [
    {
      name: "Callout",
      before: "Blockquote",
      parse(cx, line) {
        if (line.next !== GT || indentedCode(line)) return false;
        const m = CALLOUT.exec(rest(line));
        if (!m) return false;
        const at = cx.lineStart + line.pos;
        const mark = at + m[0].indexOf("[");
        cx.startComposite("Callout", line.pos);
        cx.addElement(cx.elt("QuoteMark", at, at + 1));
        cx.addElement(cx.elt("CalloutMark", mark, mark + m[1]!.length));
        cx.nextLine();
        return true;
      },
    },
  ],
};

// ---- footnotes ---------------------------------------------------------------

const FOOTNOTE_DEF = /^\[\^([^\]\s]+)\]:/;

const Footnotes: MarkdownConfig = {
  defineNodes: [
    {
      name: "FootnoteDefinition",
      // What continues a footnote: lines indented by four, and the blank lines between them.
      composite(_cx, line) {
        if (line.next < 0) return true;
        if (line.indent < line.baseIndent + 4) return false;
        line.moveBaseColumn(line.baseIndent + 4);
        return true;
      },
    },
    { name: "FootnoteLabel" },
    { name: "FootnoteReference" },
  ],
  parseBlock: [
    {
      name: "FootnoteDefinition",
      before: "IndentedCode",
      parse(cx, line) {
        if (indentedCode(line)) return false;
        const m = FOOTNOTE_DEF.exec(rest(line));
        if (!m) return false;
        const at = cx.lineStart + line.pos;
        cx.startComposite("FootnoteDefinition", line.pos);
        cx.addElement(cx.elt("FootnoteLabel", at, at + m[0].length));
        line.moveBase(line.pos + m[0].length);
        return null;
      },
      // A definition ends the paragraph above it, as a heading would.
      endLeaf: (_cx, line) => !indentedCode(line) && FOOTNOTE_DEF.test(rest(line)),
    },
  ],
  parseInline: [
    {
      name: "FootnoteReference",
      before: "Link",
      parse(cx, next, pos) {
        if (next !== OPEN_BRACKET) return -1;
        const m = /^\[\^([^\]\s]+)\]/.exec(cx.slice(pos, cx.end));
        return m ? cx.addElement(cx.elt("FootnoteReference", pos, pos + m[0].length)) : -1;
      },
    },
  ],
};

// ---- math --------------------------------------------------------------------

const MATH_OPEN = /^\$\$[ \t]*$/;
const MATH_ONE_LINE = /^\$\$(.+)\$\$[ \t]*$/;

/** Whether a line starts a `$$` block: just `$$`, or `$$tex$$`. */
const startsMath = (line: Line) => !indentedCode(line) && (MATH_OPEN.test(rest(line)) || MATH_ONE_LINE.test(rest(line)));

const MathBlock: MarkdownConfig = {
  defineNodes: [{ name: "MathBlock", block: true }, { name: "MathMark" }, { name: "MathText" }],
  parseBlock: [
    {
      name: "MathBlock",
      before: "IndentedCode",
      parse(cx, line) {
        if (!startsMath(line)) return false;
        const at = cx.lineStart + line.pos;
        const text = rest(line);
        const one = MATH_ONE_LINE.exec(text);
        if (one) {
          const texFrom = at + 2;
          const texTo = texFrom + one[1]!.length;
          const children = [cx.elt("MathMark", at, texFrom), cx.elt("MathText", texFrom, texTo), cx.elt("MathMark", texTo, texTo + 2)];
          cx.nextLine();
          cx.addElement(cx.elt("MathBlock", at, texTo + 2, children));
          return true;
        }
        const marks: Element[] = [cx.elt("MathMark", at, at + 2)];
        let lastText: Element | null = null;
        // The text of a line joins the line before it, unless a quote's marker sits between them.
        const addText = (from: number, to: number) => {
          if (lastText && marks[marks.length - 1] === lastText && lastText.to === from) {
            lastText = cx.elt("MathText", lastText.from, to);
            marks[marks.length - 1] = lastText;
          } else {
            lastText = cx.elt("MathText", from, to);
            marks.push(lastText);
          }
        };
        const depth = () => internals(cx).stack.length;
        let end = at + 2;
        for (let first = true; cx.nextLine() && depthOf(line) >= depth(); first = false) {
          if (!indentedCode(line) && MATH_OPEN.test(rest(line))) {
            for (const m of line.markers) marks.push(m);
            const close = cx.lineStart + line.pos;
            marks.push(cx.elt("MathMark", close, close + 2));
            end = close + 2;
            cx.nextLine();
            break;
          }
          if (!first) addText(cx.lineStart - 1, cx.lineStart);
          for (const m of line.markers) marks.push(m);
          const from = cx.lineStart + line.basePos;
          const to = cx.lineStart + line.text.length;
          if (from < to) addText(from, to);
          end = Math.max(to, cx.lineStart);
        }
        cx.addElement(cx.elt("MathBlock", at, end, marks));
        return true;
      },
      endLeaf: (_cx, line) => startsMath(line),
    },
  ],
};

const INLINE_MATH = /^(?:\$`([^`\n]+)`\$|\$(?![\s$])((?:\\.|[^$\\\n])+?)(?<![\s\\])\$(?![\d$\w]))/;

const InlineMath: MarkdownConfig = {
  defineNodes: [{ name: "InlineMath" }],
  parseInline: [
    {
      name: "InlineMath",
      before: "Emphasis",
      parse(cx, next, pos) {
        if (next !== DOLLAR) return -1;
        // Not in the middle of a word or after another dollar: `a$b$`, `$$x$`.
        const before = cx.char(pos - 1);
        if (before === DOLLAR || (before >= 48 && before <= 57) || (before >= 65 && before <= 90) || (before >= 97 && before <= 122) || before === 95) return -1;
        const m = INLINE_MATH.exec(cx.slice(pos, cx.end));
        if (!m) return -1;
        const open = m[1] !== undefined ? 2 : 1;
        const to = pos + m[0].length;
        return cx.addElement(cx.elt("InlineMath", pos, to, [cx.elt("MathMark", pos, pos + open), cx.elt("MathMark", to - open, to)]));
      },
    },
  ],
};

/** Everything above, to be passed to `markdown({ extensions })` or `parser.configure` next to GFM. */
export const tessela: MarkdownConfig[] = [FrontMatter, Callout, Footnotes, MathBlock, InlineMath];
