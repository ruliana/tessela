// Live preview: Markdown shown rendered, and as typed only where the cursor is. The rule that
// decides which is in `reveal.ts` and is the same for everything that is drawn: only the exact
// construct under the cursor (a bold span, a link, the marks of a heading) shows its Markdown, and
// the rest of the block that is being edited stays drawn. A table, the front matter and the like
// are widgets, and open as a whole when the cursor enters them. The text itself never changes, so
// saving, searching and the tools see the same Markdown as always.

import { syntaxTree } from "@codemirror/language";
import { EditorState, type Extension, type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

import { daysInLine } from "../shared/dates";
import { allowedHtml } from "../shared/html";
import { type PageNode } from "../shared/pageModel";
import { journalDest } from "../shared/pages";
import type { PropertiesArg, PropertiesOverride } from "../shared/mods";
import { type Properties, bodyRepeatsTitle, bodyStart, parseProperties, showWhen } from "../shared/properties";
import { pageModel } from "./pageModelField";
import { isEditing, rendered, revealChanged } from "./reveal";
import { coversRange } from "./selectMode";

class Glyph extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly cls: string,
  ) {
    super();
  }
  override eq(other: Glyph): boolean {
    return other.text === this.text && other.cls === this.cls;
  }
  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = this.cls;
    span.textContent = this.text;
    return span;
  }
}

/** Dispatch this when what the decorations depend on (a picture that failed to load) has changed. */
const imageFailed = StateEffect.define<null>();

/** Addresses of pictures that could not be loaded: they are drawn as their description instead. */
const failedImages = new Set<string>();

/** A picture drawn in the text. It never gets wider than the text, however narrow the window. */
class ImageWidget extends WidgetType {
  constructor(
    private readonly src: string,
    private readonly alt: string,
  ) {
    super();
  }
  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }
  /** A click on the picture puts the cursor there, which shows its Markdown. */
  override ignoreEvent(): boolean {
    return false;
  }
  override toDOM(view: EditorView): HTMLElement {
    const img = document.createElement("img");
    img.className = "cm-lp-image";
    img.src = this.src;
    img.alt = this.alt;
    img.title = this.alt;
    // A picture that cannot be loaded shows its description instead: the text is redrawn, not the widget patched.
    img.onerror = () => {
      failedImages.add(this.src);
      view.dispatch({ effects: imageFailed.of(null) });
    };
    return img;
  }
}

const hide = Decoration.replace({});
const missing = Decoration.mark({ class: "cm-lp-missing" });
const bullet = Decoration.replace({ widget: new Glyph("•", "cm-lp-bullet") });
const unchecked = Decoration.replace({ widget: new Glyph("☐", "cm-lp-check") });
const checked = Decoration.replace({ widget: new Glyph("☑", "cm-lp-check cm-lp-checked") });
const rule = Decoration.replace({ widget: new Glyph("", "cm-lp-rule") });
const quoteLine = Decoration.line({ class: "cm-lp-quote" });
const inlineCode = Decoration.mark({ class: "cm-lp-code" });
const doneTask = Decoration.mark({ class: "cm-lp-done" });
const linkText = Decoration.mark({ class: "cm-lp-link" });

const HEADING = /^ATXHeading[1-6]$/;

export interface DrawnRange {
  from: number;
  to: number;
}

/**
 * Draws the Markdown of the text: marks hidden, bullets, boxes, rules and pictures in their place. A
 * construct that the cursor is in (see `reveal.ts`) is left as typed, and nothing else is: the rest
 * of its block is drawn like any other. `visible` is the part of the page to draw.
 */
export function inlineDecorations(state: EditorState, visible: readonly DrawnRange[], opts: Pick<PreviewOptions, "imageUrl">): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const lineOf = (pos: number) => state.doc.lineAt(pos);
  const typed = (from: number, to: number) => isEditing(state, { from, to });
  /** Hides `from` to `to`, and the space after it when `space` is set. */
  const hideMark = (from: number, to: number, space = false) => {
    if (space && state.sliceDoc(to, to + 1) === " ") to++;
    if (to > from) ranges.push(hide.range(from, to));
  };
  /** Whether the construct that a mark belongs to is drawn. */
  const drawn = (parent: SyntaxNode | null) => parent !== null && !typed(parent.from, parent.to);

  for (const { from, to } of visible) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (ref) => {
        const name = ref.name;
        if (name === "FencedCode" || name === "CodeBlock" || name === "Table" || name === "MathBlock" || name === "FrontMatter") return false;
        if (name === "HorizontalRule") {
          if (!typed(ref.from, ref.to)) ranges.push(rule.range(ref.from, ref.to));
        } else if (name === "InlineCode") {
          if (!typed(ref.from, ref.to)) ranges.push(inlineCode.range(ref.from, ref.to));
        } else if (name === "CodeMark") {
          if (ref.node.parent?.name === "InlineCode" && drawn(ref.node.parent)) hideMark(ref.from, ref.to);
        } else if (name === "QuoteMark") {
          // Every line of a quote has the bar; the `>` is shown on the line the cursor is on.
          const line = lineOf(ref.from);
          ranges.push(quoteLine.range(line.from));
          if (!typed(line.from, line.to)) hideMark(ref.from, ref.to, true);
        } else if (name === "ListMark") {
          // Ordered lists keep their numbers. A bullet is typed when the cursor is at it.
          if (ref.node.parent?.parent?.name === "BulletList" && !typed(ref.from, ref.to + 1)) {
            ranges.push(bullet.range(ref.from, ref.to));
          }
        } else if (name === "TaskMarker") {
          const done = /\[[xX]\]/.test(state.sliceDoc(ref.from, ref.to));
          if (!typed(ref.from, ref.to + 1)) ranges.push((done ? checked : unchecked).range(ref.from, ref.to));
          const task = ref.node.parent;
          if (done && task && task.to > ref.to) ranges.push(doneTask.range(ref.to, task.to));
        } else if (name === "HeaderMark") {
          if (HEADING.test(ref.node.parent?.name ?? "") && drawn(ref.node.parent)) hideMark(ref.from, ref.to, true);
        } else if (name === "EmphasisMark" || name === "StrikethroughMark") {
          if (drawn(ref.node.parent)) hideMark(ref.from, ref.to);
        } else if (name === "Image") {
          if (typed(ref.from, ref.to)) return false;
          const url = ref.node.getChild("URL");
          const marks = ref.node.getChildren("LinkMark");
          const src = url ? opts.imageUrl(state.sliceDoc(url.from, url.to)) : null;
          if (src === null || marks.length < 2) return;
          const alt = state.sliceDoc(marks[0]!.to, marks[1]!.from);
          if (failedImages.has(src)) {
            ranges.push(hide.range(ref.from, marks[0]!.to), missing.range(marks[0]!.to, marks[1]!.from), hide.range(marks[1]!.from, ref.to));
            return false;
          }
          ranges.push(Decoration.replace({ widget: new ImageWidget(src, alt) }).range(ref.from, ref.to));
          return false;
        } else if (name === "Link") {
          const open = ref.node.getChild("URL") ? ref.node.getChild("LinkMark") : null;
          const close = open?.nextSibling;
          if (open && close && close.to > open.to && !typed(ref.from, ref.to)) ranges.push(linkText.range(open.to, close.from));
        } else if (name === "LinkMark" || name === "URL" || name === "LinkTitle") {
          // Only links written inline, [text](target): a reference [text][ref] stays as typed.
          const parent = ref.node.parent;
          if ((parent?.name === "Link" || parent?.name === "Image") && parent.getChild("URL") && drawn(parent)) hideMark(ref.from, ref.to);
        }
      },
    });
  }
  return Decoration.set(ranges, true);
}

// ---- tables ------------------------------------------------------------------
//
// A table is read from the syntax tree: its cells are TableCell nodes with the inline nodes of the
// page inside them, so a cell shows what any other text shows, and nothing here parses Markdown.

type Align = "left" | "center" | "right" | null;

/** The text of a cell as runs: plain text, or an element with runs inside it. */
type Run = string | { tag: "strong" | "em" | "del" | "code" | "a"; href?: string; children: Run[] };

interface ParsedTable {
  head: Run[][];
  aligns: Align[];
  /** The rows under the header; `line` is the line of the row counted from the first line of the table. */
  rows: { line: number; cells: Run[][] }[];
}

/** The alignment of each column, from the delimiter row (`| :--- | ---: |`). */
function alignsOf(row: string): Align[] {
  let text = row.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text.split("|").map((c): Align => {
    const cell = c.trim();
    return cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : null;
  });
}

const RUN_TAG: Record<string, "strong" | "em" | "del"> = { StrongEmphasis: "strong", Emphasis: "em", Strikethrough: "del" };

/** The run that an inline node is, or null for a node that is just its text. */
function runOf(state: EditorState, node: SyntaxNode): Run | null {
  switch (node.name) {
    case "Escape":
      return state.sliceDoc(node.from + 1, node.to);
    case "InlineCode": {
      const [open, close] = [node.firstChild, node.lastChild];
      const code = open && close && open !== close ? state.sliceDoc(open.to, close.from) : state.sliceDoc(node.from, node.to);
      // In a cell, `\|` is a pipe, even in code.
      return { tag: "code", children: [code.replace(/\\\|/g, "|")] };
    }
    case "StrongEmphasis":
    case "Emphasis":
    case "Strikethrough": {
      const [open, close] = [node.firstChild, node.lastChild];
      if (!open || !close || open === close) return null;
      return { tag: RUN_TAG[node.name]!, children: runsIn(state, node, open.to, close.from) };
    }
    case "Link": {
      const url = node.getChild("URL");
      const [open, close] = node.getChildren("LinkMark");
      if (!url || !open || !close) return null;
      return { tag: "a", href: state.sliceDoc(url.from, url.to), children: runsIn(state, node, open.to, close.from) };
    }
    default:
      return null;
  }
}

/** The runs of the text from `from` to `to`, which `node` holds: the nodes it has are runs, the text between them is text. */
function runsIn(state: EditorState, node: SyntaxNode, from: number, to: number): Run[] {
  const out: Run[] = [];
  let at = from;
  const text = (end: number) => {
    if (end > at) out.push(state.sliceDoc(at, end));
  };
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.to <= from || c.from >= to) continue;
    const run = runOf(state, c);
    if (run === null) continue;
    text(c.from);
    out.push(run);
    at = c.to;
  }
  text(to);
  return out;
}

/** The cells of a row, by column: a pipe starts the next one, and an empty cell has no node of its own. */
function cellsOf(state: EditorState, row: SyntaxNode, columns: number): Run[][] {
  const cells: Run[][] = Array.from({ length: columns }, () => []);
  const leading = row.firstChild?.name === "TableDelimiter" && row.firstChild.from === row.from;
  let pipes = 0;
  for (let c = row.firstChild; c; c = c.nextSibling) {
    if (c.name === "TableDelimiter") pipes++;
    else if (c.name === "TableCell") {
      const column = pipes - (leading ? 1 : 0);
      if (column < columns) cells[column] = runsIn(state, c, c.from, c.to);
    }
  }
  return cells;
}

/** The table that a `Table` node of the syntax tree is; null when it has no header or delimiter row. */
export function readTable(state: EditorState, table: SyntaxNode): ParsedTable | null {
  const header = table.getChild("TableHeader");
  const delimiter = table.getChild("TableDelimiter");
  if (!header || !delimiter) return null;
  const aligns = alignsOf(state.sliceDoc(delimiter.from, delimiter.to));
  const first = state.doc.lineAt(table.from).number;
  const columns = Math.max(1, header.getChildren("TableCell").length, aligns.length);
  const head = cellsOf(state, header, columns);
  const rows = table.getChildren("TableRow").map((row) => ({ line: state.doc.lineAt(row.from).number - first, cells: cellsOf(state, row, columns) }));
  return { head, aligns, rows };
}

/** The text of runs without any element: what a cell reads as. */
export function runText(runs: readonly Run[]): string {
  return runs.map((r) => (typeof r === "string" ? r : runText(r.children))).join("");
}

/** Appends text with the HTML on the allowlist (shared/html.ts) drawn; anything else in it stays as typed. */
function appendHtml(text: string, parent: HTMLElement): void {
  for (const piece of allowedHtml(text)) {
    parent.append(typeof piece === "string" ? piece : document.createElement(piece.element));
  }
}

/** Appends plain text; a date in it is a link to its journal day. */
function appendText(text: string, parent: HTMLElement): void {
  let last = 0;
  for (const d of daysInLine(text)) {
    appendHtml(text.slice(last, d.from), parent);
    const a = Object.assign(document.createElement("a"), { textContent: text.slice(d.from, d.to), className: "date" });
    a.dataset.href = journalDest(d.day);
    parent.append(a);
    last = d.to;
  }
  appendHtml(text.slice(last), parent);
}

/** Appends the runs of a table cell: code, bold, italic, strike and links drawn, the rest as text. */
function appendRuns(runs: readonly Run[], parent: HTMLElement): void {
  for (const run of runs) {
    if (typeof run === "string") {
      appendText(run, parent);
    } else if (run.tag === "code") {
      parent.append(Object.assign(document.createElement("code"), { textContent: runText(run.children) }));
    } else {
      const el = parent.appendChild(document.createElement(run.tag));
      if (run.href !== undefined) el.dataset.href = run.href;
      appendRuns(run.children, el);
    }
  }
}

class TableWidget extends WidgetType {
  constructor(
    private readonly table: ParsedTable,
    private readonly source: string,
    private readonly openLink: (dest: string) => void,
    private readonly selected: boolean,
  ) {
    super();
  }
  override eq(other: TableWidget): boolean {
    return other.source === this.source && other.selected === this.selected;
  }
  override ignoreEvent(): boolean {
    return true;
  }
  override toDOM(view: EditorView): HTMLElement {
    const { head, aligns, rows } = this.table;
    const wrap = document.createElement("div");
    wrap.className = this.selected ? "cm-lp-tablewrap cm-block-selected" : "cm-lp-tablewrap";
    const table = document.createElement("table");
    table.className = "cm-lp-table";
    const row = (cells: Run[][], tag: "th" | "td", line: number) => {
      const tr = document.createElement("tr");
      tr.dataset.row = String(line);
      // Every row has as many cells as the header, however many were typed.
      for (let i = 0; i < head.length; i++) {
        const cell = document.createElement(tag);
        const align = aligns[i];
        if (align) cell.style.textAlign = align;
        appendRuns(cells[i] ?? [], cell);
        tr.append(cell);
      }
      return tr;
    };
    const thead = document.createElement("thead");
    thead.append(row(head, "th", 0));
    const tbody = document.createElement("tbody");
    for (const r of rows) tbody.append(row(r.cells, "td", r.line));
    table.append(thead, tbody);
    wrap.append(table);
    wrap.addEventListener("mousedown", (event) => {
      const target = event.target as HTMLElement;
      event.preventDefault();
      const dest = target.closest("a")?.dataset.href;
      if (dest !== undefined) return this.openLink(dest);
      // Anywhere else puts the cursor in the row that was clicked, which shows the table as text.
      const start = view.state.doc.lineAt(view.posAtDOM(wrap)).number;
      const rel = Number(target.closest("tr")?.dataset.row ?? 0);
      const line = view.state.doc.line(Math.min(start + rel, view.state.doc.lines));
      view.dispatch({ selection: { anchor: line.to }, scrollIntoView: true });
      view.focus();
    });
    return wrap;
  }
}

// ---- properties ----------------------------------------------------------------

/** The front matter drawn as a title and one line of properties; its YAML shows when it is edited. */
class PropertiesWidget extends WidgetType {
  constructor(
    private readonly props: Properties,
    private readonly title: string | null,
    private readonly source: string,
    private readonly edit: () => void,
    private readonly toBody: () => void,
    private readonly openLink: (dest: string) => void,
    private readonly drawn?: (() => HTMLElement | null) | undefined,
  ) {
    super();
  }
  override eq(other: PropertiesWidget): boolean {
    return other.source === this.source && other.title === this.title && (other.drawn === undefined) === (this.drawn === undefined);
  }
  override ignoreEvent(): boolean {
    return true;
  }
  override toDOM(): HTMLElement {
    // A mod that draws the properties is asked first; one that fails leaves the built-in drawing.
    const custom = this.drawn?.();
    if (custom) return custom;
    const { props } = this;
    const wrap = document.createElement("div");
    wrap.className = "cm-props";
    // The editor ignores clicks on the title, and typing after one went nowhere (or, with the
    // caret left on line 1, in front of the front matter). A click means "write here": go to the
    // text. The buttons and the day link below handle their own clicks.
    wrap.addEventListener("mousedown", (event) => {
      if (event.target instanceof Element && event.target.closest("button, .cm-props-day")) return;
      event.preventDefault();
      this.toBody();
    });
    if (this.title !== null) {
      const h = document.createElement("h1");
      h.className = "cm-props-title";
      h.textContent = this.title;
      wrap.append(h);
    }
    const row = document.createElement("div");
    row.className = "cm-props-row";
    const chip = (text: string, cls: string, title?: string) => {
      const span = document.createElement("span");
      span.className = `cm-props-chip ${cls}`;
      span.textContent = text;
      if (title) span.title = title;
      row.append(span);
    };
    if (props.type) chip(props.type, "cm-props-type", "type");
    for (const tag of props.tags) chip(`#${tag}`, "cm-props-tag");
    if (props.when) {
      chip(showWhen(props.when.value), "cm-props-when", `${props.when.key}: ${props.when.value}`);
      // The date of the page leads to that day's journal.
      const day = daysInLine(props.when.value)[0]?.day;
      const when = row.lastElementChild as HTMLElement;
      if (day !== undefined && props.when.value.startsWith(day)) {
        when.classList.add("cm-props-day");
        when.addEventListener("mousedown", (event) => {
          event.preventDefault();
          this.openLink(journalDest(day));
        });
      }
    }
    for (const { key, value } of props.others.slice(0, 3)) chip(`${key} ${value}`, "cm-props-other");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-props-edit";
    button.textContent = "Edit properties";
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      this.edit();
    });
    row.append(button);
    wrap.append(row);
    return wrap;
  }
}

/** What the mod that draws the properties gives, or null when it throws, so the built-in drawing takes over. */
function drawnBy(override: PropertiesOverride, arg: PropertiesArg): HTMLElement | null {
  try {
    return override.draw(arg);
  } catch (e) {
    console.error("The mod that draws properties failed:", e);
    return null;
  }
}

/** A journal day's front matter says what the day's heading already does, so it draws nothing. */
class NothingWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  override toDOM(): HTMLElement {
    const div = document.createElement("div");
    div.className = "cm-props-none";
    return div;
  }
}

/** The front matter of the page, as the page model has it; the model is not there in an editor without one. */
function frontMatterOf(state: EditorState): PageNode | null {
  return state.field(pageModel, false)?.root.children.find((n) => n.kind === "frontmatter") ?? null;
}

/**
 * The widgets that stand in for whole blocks: the front matter as a title and a line of
 * properties, and each table as a table. Where the cursor is in one of them it is shown as text,
 * as a whole: there is no half-drawn table. Selected blocks (select mode) are drawn.
 */
export function blockWidgets(state: EditorState, opts: PreviewOptions): DecorationSet {
  const { openLink } = opts;
  const ranges: Range<Decoration>[] = [];
  const front = frontMatterOf(state);
  if (front) {
    const fmEnd = front.endLine - 1;
    const from = state.doc.line(1).from;
    // The blank lines after the front matter go with it, when there is text below them.
    let last = fmEnd + 1;
    while (last < state.doc.lines && state.doc.line(last + 1).text.trim() === "") last++;
    const to = state.doc.line(last < state.doc.lines ? last : fmEnd + 1).to;
    if (!isEditing(state, { from, to })) {
      const head = Array.from({ length: Math.min(state.doc.lines, 200) }, (_, i) => state.doc.line(i + 1).text);
      const props = parseProperties(head, fmEnd);
      const source = head.slice(0, fmEnd + 1).join("\n");
      const edit = () => {
        const view = opts.view();
        if (!view) return;
        // The cursor goes to the end of the first property, which shows the YAML.
        view.dispatch({ selection: { anchor: view.state.doc.line(2).to }, scrollIntoView: true });
        view.focus();
      };
      const toBody = () => {
        const view = opts.view();
        if (!view) return;
        view.dispatch({ selection: { anchor: bodyStart(view.state.doc.toString()) }, scrollIntoView: true });
        view.focus();
      };
      const title = bodyRepeatsTitle(head, fmEnd, props.title ?? opts.pageName()) ? null : (props.title ?? opts.pageName());
      const override = opts.properties();
      const path = opts.pagePath();
      const drawn = override ? () => drawnBy(override, { path, props, title, source, toBody, editYaml: edit, openLink }) : undefined;
      const widget = props.type === "journal" ? new NothingWidget() : new PropertiesWidget(props, title, source, edit, toBody, openLink, drawn);
      ranges.push(Decoration.replace({ widget, block: true }).range(from, to));
    }
  }
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "Table") return;
      const first = state.doc.lineAt(node.from);
      const last = state.doc.lineAt(node.to);
      // A table inside a list or a quote is left as text: there is no line to replace.
      if (first.from !== node.from) return false;
      if (isEditing(state, { from: first.from, to: last.to })) return false;
      const table = readTable(state, node.node);
      if (table) {
        const source = state.sliceDoc(first.from, last.to);
        const selected = coversRange(state, first.from, last.to);
        ranges.push(Decoration.replace({ widget: new TableWidget(table, source, openLink, selected), block: true }).range(first.from, last.to));
      }
      return false;
    },
  });
  return Decoration.set(ranges, true);
}

/** Block widgets cannot come from a plugin, so they are a field that is made again when what they show changes. */
function blocks(opts: PreviewOptions): Extension {
  return StateField.define<DecorationSet>({
    create: (state) => blockWidgets(state, opts),
    update(value, tr) {
      const changed = tr.docChanged || revealChanged(tr.startState, tr.state) || syntaxTree(tr.startState) !== syntaxTree(tr.state);
      return changed ? blockWidgets(tr.state, opts) : value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

export interface PreviewOptions {
  /** A link drawn in a table was clicked. */
  openLink: (dest: string) => void;
  /** Where a picture can be loaded from, or null when it cannot be shown. */
  imageUrl: (dest: string) => string | null;
  /** The name of the open page, for a title when the front matter has none. */
  pageName: () => string;
  /** The path of the open page. */
  pagePath: () => string;
  /** What a mod draws in place of the front matter, when one does. */
  properties: () => PropertiesOverride | undefined;
  /** The editor, once it exists. */
  view: () => EditorView | null;
}

/**
 * The caret never walks into the front matter that is drawn as a title: a click on the title or
 * an arrow key up from the body would put it on line 1 (or on the closing `---`), and typing
 * there breaks the front matter. It goes to the first property instead, where the YAML opens for
 * editing, the same place as "Edit properties". Only a caret the user moved is sent there: a
 * selection, a page opening at a line and the Edit properties button are left alone. (A click on
 * the title goes to the start of the text: see PropertiesWidget.)
 */
export function frontMatterGuard(): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (tr.docChanged || !tr.selection || !tr.isUserEvent("select")) return tr;
    const { head, empty } = tr.selection.main;
    if (!empty) return tr;
    const front = frontMatterOf(tr.startState);
    // No front matter, or nothing in it to edit.
    if (!front || front.endLine < 3) return tr;
    const { doc } = tr.state;
    const to = doc.line(front.endLine).to;
    // Outside it, or already editing it.
    if (head > to || tr.startState.selection.main.head <= to) return tr;
    return [tr, { selection: { anchor: doc.line(2).to }, scrollIntoView: true }];
  });
}

export function livePreview(opts: PreviewOptions): Extension {
  return [
    // Tells the reveal policy, and what mods draw, that the Markdown is shown rendered.
    rendered.of(true),
    frontMatterGuard(),
    blocks(opts),
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = inlineDecorations(view.state, view.visibleRanges, opts);
        }
        update(update: ViewUpdate) {
          const tree = syntaxTree(update.startState) !== syntaxTree(update.state);
          const failed = update.transactions.some((tr) => tr.effects.some((e) => e.is(imageFailed)));
          if (update.docChanged || update.viewportChanged || tree || failed || revealChanged(update.startState, update.state)) {
            this.decorations = inlineDecorations(update.state, update.view.visibleRanges, opts);
          }
        }
      },
      { decorations: (v) => v.decorations },
    ),
  ];
}

// ---- focus -------------------------------------------------------------------

const currentBlock = Decoration.line({ class: "cm-focus-cur" });

/** The kinds that are not one text: only the line the cursor is on counts as the current block. */
const LINE_BLOCKS = new Set(["frontmatter", "code", "html", "math"]);

/**
 * The lines (1-based) of the blocks that hold the selection: the lines of the selection, and the own
 * text of the block on its first and last line: a list item has its own lines without the items
 * nested in it, a paragraph without the list it owns, and a block that is not one text (a fence) has
 * the line alone. Blank lines belong to none.
 */
export function currentLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  const model = state.field(pageModel, false);
  for (const { from, to } of state.selection.ranges) {
    const first = state.doc.lineAt(from).number;
    const last = state.doc.lineAt(to).number;
    for (let n = first; n <= last; n++) lines.add(n);
    if (!model) continue;
    for (const n of new Set([first, last])) {
      if (state.doc.line(n).text.trim() === "") continue;
      const node = model.nodeAtLine(n);
      if (node === model.root) continue;
      if (LINE_BLOCKS.has(node.kind) || node.kind === "section") {
        lines.add(node.kind === "section" ? node.startLine : n);
        continue;
      }
      for (let m = node.startLine; m <= node.endLine; m++) {
        if (state.doc.line(m).text.trim() === "" || node.children.some((c) => m >= c.startLine && m <= c.endLine)) continue;
        lines.add(m);
      }
    }
  }
  return lines;
}

/**
 * Marks the lines of the block the cursor is in, so focus mode can dim the rest. The mark is
 * always there and only the window's focus setting makes it matter.
 */
export function focusMarks(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.focusChanged || update.viewportChanged) {
          this.decorations = this.build(update.view);
        }
      }
      build(view: EditorView): DecorationSet {
        if (!view.hasFocus) return Decoration.none;
        const ranges: Range<Decoration>[] = [];
        for (const n of [...currentLines(view.state)].sort((a, b) => a - b)) {
          if (n <= view.state.doc.lines) ranges.push(currentBlock.range(view.state.doc.line(n).from));
        }
        return Decoration.set(ranges, true);
      }
    },
    { decorations: (v) => v.decorations },
  );
}
