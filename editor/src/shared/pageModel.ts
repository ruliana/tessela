// The page model: what the editor knows about the structure of a page. It is the one answer to
// "what blocks does this page have, and what holds what", built once for each version of the
// document from the CodeMirror syntax tree (see `editor/ARCHITECTURE.md`, principle 1). Selection,
// folds, zoom, live preview and the mods read it; none of them parses the page for itself.
//
// The tree it makes:
//
//   page
//   ├── frontmatter
//   ├── paragraph            a top-level block
//   │   └── item             the list that starts on the line right beneath a paragraph is owned by it
//   │       ├── item         a nested item
//   │       └── code         a fence, quote or callout inside an item is a child of the item
//   └── section              a heading, and everything below it up to the next heading as high or higher
//       ├── paragraph
//       └── section          a deeper heading
//
// Kinds are those of `docs/conventions.md` §3, so that the model and `tessela blocks` (which is the
// test oracle, see `test/pageModel.oracle.test.ts`) use the same words:
//
//   paragraph, item, code, quote, callout, table, html   blocks, as the index has them
//   section                                              a heading and what it owns (the index calls it a heading)
//   frontmatter, math, footnote, rule, other             nodes the index does not list: front matter, `$$` blocks,
//                                                        footnote definitions, thematic breaks, link definitions
//   page                                                 the root
//
// Rules of the shape (conventions §3):
//
//   - A list is not a node: its items are children of what holds the list (an item, the paragraph that
//     owns it, a section or the page). A run of siblings is what a list was.
//   - In an item, a nested list, a fence, a quote, a callout or a `$$` block is a child of the item and ends
//     the item's own text; a paragraph, table or HTML block before it is part of that text, and one after
//     it is a child. A `#` line in an item is text, never a section.
//   - A quote, callout or footnote definition holds its list items as children (they can be stepped to,
//     moved and folded like any others); the rest of what is in it is its own text.
//   - Where a node ends: with everything it owns, without the blank lines after it.
//
// A node is found again after an edit by mapping its position through the change (`findAgain`). Across
// sessions it is its `key`, which is the part of a block handle after the `#` (conventions §3).

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { type ChangeDesc, type EditorState, MapMode, type Text } from "@codemirror/state";
import type { SyntaxNode, Tree } from "@lezer/common";
import { blake3 } from "@noble/hashes/blake3";

export type PageKind =
  | "page"
  | "frontmatter"
  | "section"
  | "paragraph"
  | "item"
  | "code"
  | "quote"
  | "callout"
  | "table"
  | "html"
  | "math"
  | "footnote"
  | "rule"
  | "other";

/** The kinds that `tessela blocks` lists as blocks. */
export const INDEXED_KINDS: readonly PageKind[] = ["paragraph", "item", "code", "quote", "callout", "table", "html"];

export type TaskState = "open" | "done";

export class PageNode {
  /** What it is; see the kinds above. */
  readonly kind: PageKind;
  /** Where it starts: the first character that is not indentation (for an item, its marker). */
  readonly from: number;
  /** Where it ends, with everything it owns and without blank space after it. */
  readonly to: number;
  /** The line it starts on, 1-based like CodeMirror's `Line.number`, and the one it ends on, both included. */
  readonly startLine: number;
  readonly endLine: number;
  readonly parent: PageNode | null;
  readonly children: readonly PageNode[] = [];
  /** For a section, the level of its heading, 1 to 6. For the rest, 0. */
  readonly level: number;
  /** For an item that starts with a checkbox: whether it is ticked. */
  readonly task: TaskState | null;
  /** For a fenced code block: its info string (`js`, `tessela`) and whether the closing fence is there. Null for the rest, indented code included. */
  readonly fence: { info: string; closed: boolean } | null;

  /** What the key is a hash of, before normalizing; read once the keys are wanted. */
  readonly #keyText: () => string;
  readonly #model: PageModel;

  /** @internal */
  constructor(
    model: PageModel,
    kind: PageKind,
    range: { from: number; to: number; startLine: number; endLine: number },
    parent: PageNode | null,
    extra: { level?: number; task?: TaskState | null; fence?: PageNode["fence"]; keyText?: () => string } = {},
  ) {
    this.#model = model;
    this.kind = kind;
    this.from = range.from;
    this.to = range.to;
    this.startLine = range.startLine;
    this.endLine = range.endLine;
    this.parent = parent;
    this.level = extra.level ?? 0;
    this.task = extra.task ?? null;
    this.fence = extra.fence ?? null;
    this.#keyText = extra.keyText ?? (() => "");
  }

  /** The model this node belongs to: a node is one of one version of the page. */
  get model(): PageModel {
    return this.#model;
  }

  /** @internal */
  get keyText(): string {
    return this.#keyText();
  }

  /**
   * The identity of the node across sessions: the hash of its normalized text, as in a block handle
   * (`9f2c41d0`), with `.2` from the second identical node on (`9f2c41d0.2`). The handle that
   * `tessela blocks` prints is the page ID, `#` and this.
   */
  get key(): string {
    return this.#model.keyOf(this);
  }

  /** The key without the ordinal: equal for nodes of equal text. */
  get hash(): string {
    return this.key.split(".")[0]!;
  }

  /** The first line of its text without the list marker, checkbox or `#`s: what a trail or a fold is called. */
  get label(): string {
    return this.keyText.split("\n")[0]!.trim();
  }

  /** The number of lines it covers. */
  get lines(): number {
    return this.endLine - this.startLine + 1;
  }

  /** The nodes between this one and the page, nearest first. */
  *ancestors(): Generator<PageNode> {
    for (let n = this.parent; n; n = n.parent) yield n;
  }

  /** The nearest section above it (not itself): the heading whose section the node is in. */
  get section(): PageNode | null {
    for (const a of this.ancestors()) if (a.kind === "section") return a;
    return null;
  }

  /** Whether `other` is this node or lies inside it. */
  contains(other: PageNode): boolean {
    for (let n: PageNode | null = other; n; n = n.parent) if (n === this) return true;
    return false;
  }

  toString(): string {
    return `${this.kind}@${this.startLine}-${this.endLine}`;
  }
}

/** A node while it is being built. */
type Building = { children: PageNode[]; to: number; endLine: number };

export class PageModel {
  /** The page: the root of the tree, from the start of the document to its end. */
  readonly root: PageNode;
  /** Every node but the root in reading order: a node comes before its children, and before what follows it. */
  readonly nodes: readonly PageNode[] = [];
  /** False when the syntax tree did not reach the end of the document, so the model shows the start of the page only. */
  readonly complete: boolean;

  #keys: Map<PageNode, string> | null = null;

  constructor(
    readonly doc: Text,
    readonly tree: Tree,
    complete = true,
  ) {
    this.complete = complete;
    this.root = new PageNode(this, "page", { from: 0, to: doc.length, startLine: 1, endLine: doc.lines }, null, { keyText: () => "" });
  }

  /** The nodes in reading order: what Up and Down step through. */
  readingOrder(): readonly PageNode[] {
    return this.nodes;
  }

  /** The nodes that share the parent of `node`, in order, itself included. */
  siblings(node: PageNode): readonly PageNode[] {
    return node.parent ? node.parent.children : [node];
  }

  parentOf(node: PageNode): PageNode | null {
    return node.parent;
  }

  /** The heading section that holds `node`, or null when it is above the first heading. */
  sectionOf(node: PageNode): PageNode | null {
    return node.section;
  }

  /**
   * The innermost node at a position. A position in the indentation of a line counts as being at the
   * first character after it, so the start of an indented list item is in the item. Blank lines and the
   * space between nodes belong to what holds them, and the page holds everything.
   */
  nodeAt(pos: number): PageNode {
    const at = Math.max(0, Math.min(pos, this.doc.length));
    const line = this.doc.lineAt(at);
    const indent = /^[ \t]*/.exec(line.text)![0].length;
    const p = at - line.from < indent && indent < line.length ? line.from + indent : at;
    let node = this.root;
    for (let child = childAt(node, p); child; child = childAt(node, p)) node = child;
    return node;
  }

  /** The innermost node that covers a whole line (1-based), the page for a line nothing holds. */
  nodeAtLine(line: number): PageNode {
    let node = this.root;
    for (;;) {
      const next = node.children.find((c) => c.startLine <= line && line <= c.endLine);
      if (!next) return node;
      node = next;
    }
  }

  /** The nodes that have a key, `9f2c41d0` or `9f2c41d0.2`, in reading order. */
  byKey(key: string): PageNode[] {
    return this.nodes.filter((n) => n.key === key);
  }

  /** @internal */
  keyOf(node: PageNode): string {
    if (node === this.root) return "page";
    if (node.kind === "frontmatter") return "frontmatter";
    if (!this.#keys) {
      const keys = new Map<PageNode, string>();
      const seen = new Map<string, number>();
      for (const n of this.nodes) {
        if (n.kind === "frontmatter") continue;
        const normalized = normalize(n.keyText);
        const hash = hashOf(n.kind === "section" ? `# ${normalized}` : normalized);
        const count = (seen.get(hash) ?? 0) + 1;
        seen.set(hash, count);
        keys.set(n, count === 1 ? hash : `${hash}.${count}`);
      }
      this.#keys = keys;
    }
    return this.#keys.get(node) ?? "";
  }

  /** @internal Adds the nodes in the order they were made, which is reading order. */
  register(node: PageNode): void {
    (this.nodes as PageNode[]).push(node);
  }
}

/** The child of `node` that holds `pos`, by bisection over its ordered, separate children. */
function childAt(node: PageNode, pos: number): PageNode | null {
  const cs = node.children;
  let lo = 0;
  let hi = cs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cs[mid]!;
    if (pos < c.from) hi = mid - 1;
    else if (pos > c.to) lo = mid + 1;
    else return c;
  }
  return null;
}

/**
 * The node that stands for `node` in `next`, the model of the document after `changes`; null when it
 * was deleted or is no longer what it was. The position of its start is mapped through the change and
 * the innermost node of the same kind that holds it is taken.
 */
export function findAgain(next: PageModel, node: PageNode, changes: ChangeDesc): PageNode | null {
  const pos = changes.mapPos(node.from, 1, MapMode.TrackDel);
  if (pos === null) return null;
  let found = next.nodeAt(pos);
  while (found.kind !== node.kind) {
    if (!found.parent) return null;
    found = found.parent;
  }
  return found;
}

/** How long to wait for the parser to reach the end of the page when the model is made. */
const PARSE_BUDGET_MS = 50;

/** The model of the document of a state, from the syntax tree its Markdown language keeps. */
export function pageModelOf(state: EditorState): PageModel {
  const whole = ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET_MS);
  return buildPageModel(state.doc, whole ?? syntaxTree(state), whole !== null);
}

// ---- keys: the hash of a block handle, as `tessela-core` computes it ------------------------------

/** White space as Rust's `str::trim` and `split_whitespace` mean it. */
const WS = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WS_RUN = new RegExp(`[${WS}]+`, "g");
const WS_EDGES = new RegExp(`^[${WS}]+|[${WS}]+$`, "g");
const WS_CHAR = new RegExp(`^[${WS}]$`);
const WS_START = new RegExp(`^[${WS}]+`);
const WS_END = new RegExp(`[${WS}]+$`);

const trimWs = (s: string) => s.replace(WS_EDGES, "");
const trimStartWs = (s: string) => s.replace(WS_START, "");
const trimEndWs = (s: string) => s.replace(WS_END, "");
const normalize = (s: string) => trimWs(s).replace(WS_RUN, " ");

const encoder = new TextEncoder();

/** The first 8 hex digits of the BLAKE3 hash of the text. */
function hashOf(text: string): string {
  const bytes = blake3(encoder.encode(text));
  let hex = "";
  for (let i = 0; i < 4; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return hex;
}

const CHECKBOXES: readonly (readonly [string, TaskState])[] = [
  ["[ ] ", "open"],
  ["[x] ", "done"],
  ["[X] ", "done"],
];

/** A line without its list marker: `-`, `*`, `+` or digits and `.` or `)`, followed by a space or nothing. */
function stripListMarker(line: string): string {
  line = trimEndWs(line);
  const first = line[0];
  if (first !== undefined && "-*+".includes(first)) {
    const rest = line.slice(1);
    if (rest === "" || rest.startsWith(" ")) return trimStartWs(rest);
  }
  const digits = /^\d*/.exec(line)![0].length;
  if (digits > 0 && (line[digits] === "." || line[digits] === ")")) {
    const rest = line.slice(digits + 1);
    if (rest === "" || rest.startsWith(" ")) return trimStartWs(rest);
  }
  return line;
}

/** The task state of the item whose own source is `raw`. */
function taskOf(raw: string): TaskState | null {
  const first = stripListMarker(trimStartWs(trimEndWs(raw).split("\n")[0] ?? ""));
  return CHECKBOXES.find(([box]) => first.startsWith(box))?.[1] ?? null;
}

/** The text of an item without its marker, checkbox and the indent of its continuation lines. */
function itemText(raw: string): string {
  const [head = "", ...rest] = trimEndWs(raw).split("\n");
  let first = stripListMarker(trimStartWs(head));
  const box = CHECKBOXES.find(([b]) => first.startsWith(b));
  if (box) first = first.slice(box[0].length);
  return trimWs([first, ...rest.map(trimStartWs)].join("\n"));
}

/** The text of a heading: after the `#`s, before a closing sequence. Both ends are trimmed of `#`, like the index does. */
function headingText(line: string): string {
  return trimWs(trimWs(line).replace(/^#+/, "").replace(/#+$/, ""));
}

// ---- building ------------------------------------------------------------------------------------

const HEADING = /^ATXHeading([1-6])$/;

/** What each leaf node of the syntax tree is. Lists and headings are handled apart. */
const LEAF: Record<string, PageKind> = {
  Paragraph: "paragraph",
  FencedCode: "code",
  CodeBlock: "code",
  Blockquote: "quote",
  Callout: "callout",
  Table: "table",
  HTMLBlock: "html",
  CommentBlock: "html",
  ProcessingInstructionBlock: "html",
  HorizontalRule: "rule",
  MathBlock: "math",
  FootnoteDefinition: "footnote",
  LinkReference: "other",
};

/** Containers that hold list items as children. */
const HOLDS_ITEMS = new Set<PageKind>(["quote", "callout", "footnote"]);

/** What ends the own text of a list item and becomes its child instead. */
const ENDS_ITEM_TEXT = new Set<PageKind>(["code", "quote", "callout", "math"]);

const isList = (n: SyntaxNode) => n.name === "BulletList" || n.name === "OrderedList";

/**
 * Reads the syntax tree of `doc` into the page model. It looks only at the structure the tree has
 * (see `syntax.ts` for the nodes Tessela adds), never at the lines.
 */
export function buildPageModel(doc: Text, tree: Tree, complete = true): PageModel {
  const model = new PageModel(doc, tree, complete);
  const building = (n: PageNode) => n as unknown as Building;

  const sliceTo = (from: number, to: number) => doc.sliceString(from, to);

  /** Makes a node and adds it to `parent`. The end of the range is moved back over white space. */
  const make = (
    kind: PageKind,
    from: number,
    to: number,
    parent: PageNode,
    extra: { level?: number; task?: TaskState | null; fence?: PageNode["fence"]; keyText?: () => string } = {},
  ): PageNode => {
    let end = to;
    while (end > from && WS_CHAR.test(doc.sliceString(end - 1, end))) end--;
    const node = new PageNode(
      model,
      kind,
      { from, to: end, startLine: doc.lineAt(from).number, endLine: doc.lineAt(end).number },
      parent,
      extra,
    );
    building(parent).children.push(node);
    model.register(node);
    return node;
  };

  /** A node of a syntax node that is a leaf of the model: the key is the hash of its source. */
  const leaf = (kind: PageKind, n: SyntaxNode, parent: PageNode): PageNode =>
    make(kind, n.from, n.to, parent, { fence: n.name === "FencedCode" ? fenceOf(n) : null, keyText: () => sliceTo(n.from, n.to) });

  /** The info string of a fenced block and whether its closing fence is there: the syntax tree says both. */
  const fenceOf = (n: SyntaxNode): { info: string; closed: boolean } => {
    let info = "";
    let marks = 0;
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.name === "CodeMark") marks++;
      else if (c.name === "CodeInfo") info = sliceTo(c.from, c.to).trim();
    }
    return { info, closed: marks >= 2 };
  };

  /** The items of a list, as children of `parent`. */
  const items = (list: SyntaxNode, parent: PageNode) => {
    for (let c = list.firstChild; c; c = c.nextSibling) if (c.name === "ListItem") item(c, parent);
  };

  /** Quotes, callouts and footnote definitions hold list items; everything else in them is their text. */
  const holder = (kind: PageKind, n: SyntaxNode, parent: PageNode): PageNode => {
    const node = leaf(kind, n, parent);
    if (HOLDS_ITEMS.has(kind)) for (let c = n.firstChild; c; c = c.nextSibling) if (isList(c)) items(c, node);
    return node;
  };

  const item = (li: SyntaxNode, parent: PageNode): PageNode => {
    // The text of the item runs to where its first child block starts.
    let textEnd = li.to;
    let ended = false;
    const kids: { n: SyntaxNode; kind: PageKind | "list" }[] = [];
    for (let c = li.firstChild; c; c = c.nextSibling) {
      const kind: PageKind | "list" | undefined = isList(c) ? "list" : LEAF[c.name];
      if (!kind) continue;
      if (!ended && (kind === "list" || ENDS_ITEM_TEXT.has(kind))) {
        ended = true;
        textEnd = c.from;
      }
      // Before that, a paragraph, a table and the like are the item's text; after it, children.
      if (ended) kids.push({ n: c, kind });
    }
    const raw = sliceTo(li.from, Math.max(li.from, textEnd));
    const node = make("item", li.from, li.to, parent, { task: taskOf(raw), keyText: () => itemText(raw) });
    for (const { n, kind } of kids) {
      if (kind === "list") items(n, node);
      else holder(kind, n, node);
    }
    return node;
  };

  const heading = (n: SyntaxNode, level: number, parent: PageNode): PageNode =>
    make("section", n.from, n.to, parent, { level, keyText: () => headingText(sliceTo(n.from, doc.lineAt(n.from).to)) });

  // The sections open at this point of the page, outermost first.
  const open: PageNode[] = [];
  /** The last top-level paragraph, while nothing has come between it and the next line. */
  let owner: PageNode | null = null;

  for (let n = tree.topNode.firstChild; n; n = n.nextSibling) {
    const level = Number(HEADING.exec(n.name)?.[1] ?? 0);
    if (level > 0) {
      while (open.length > 0 && open[open.length - 1]!.level >= level) open.pop();
      open.push(heading(n, level, open[open.length - 1] ?? model.root));
      owner = null;
      continue;
    }
    const parent = open[open.length - 1] ?? model.root;
    if (n.name === "FrontMatter") {
      leaf("frontmatter", n, model.root);
      owner = null;
    } else if (isList(n)) {
      // A list that starts on the line right under a paragraph is owned by it.
      const above = owner && doc.lineAt(n.from).number === owner.endLine + 1 ? owner : null;
      items(n, above ?? parent);
      owner = null;
    } else {
      const kind = LEAF[n.name] ?? "other";
      const node = holder(kind, n, parent);
      owner = kind === "paragraph" ? node : null;
    }
  }

  // Everything ends with what it owns: the last descendant, and for a section the last thing below it.
  const finish = (node: PageNode) => {
    const b = building(node);
    for (const c of node.children) {
      finish(c);
      if (c.to > b.to) {
        b.to = c.to;
        b.endLine = c.endLine;
      }
    }
  };
  for (const c of model.root.children) finish(c);
  return model;
}
