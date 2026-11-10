// Live preview: Markdown shown rendered, and raw only where the cursor is. Like the
// editing mode of Logseq, the block being edited (a paragraph, a heading, a list item)
// shows its marks and everything else hides them. The text itself never changes, so
// saving, searching and the tools see the same Markdown as always.

import { syntaxTree } from "@codemirror/language";
import { EditorState, type Extension, type Range, StateEffect, StateField, type Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";

import { type Block, editedBlockLines, frontmatterEnd, parseBlocks } from "../shared/blocks";
import { daysInLine } from "../shared/dates";
import { journalDest } from "../shared/pages";
import type { PropertiesArg, PropertiesOverride } from "../shared/mods";
import { type Properties, bodyRepeatsTitle, bodyStart, parseProperties, showWhen } from "../shared/properties";

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

const parsed = new WeakMap<Text, { lines: string[]; blocks: Block[] }>();

/** The page as shared/blocks.ts reads it, once for each version of the document. */
function pageBlocks(doc: Text): { lines: string[]; blocks: Block[] } {
  let page = parsed.get(doc);
  if (!page) {
    const lines = doc.toString().split("\n");
    page = { lines, blocks: parseBlocks(lines) };
    parsed.set(doc, page);
  }
  return page;
}

/**
 * The lines (1-based) of the blocks that hold the selection: these are shown raw. What counts as
 * a block comes from the same parser that Escape and Tab use, so a list item shows its own lines
 * and a paragraph after a blank line is never part of the item above it.
 */
function editedLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  const { lines: text, blocks } = pageBlocks(state.doc);
  for (const { from, to } of state.selection.ranges) {
    const first = state.doc.lineAt(from).number;
    const last = state.doc.lineAt(to).number;
    for (let n = first; n <= last; n++) lines.add(n);
    for (const n of new Set([first, last])) {
      for (const own of editedBlockLines(text, n - 1, blocks)) lines.add(own + 1);
    }
  }
  return lines;
}

/** Whether the line is shown rendered: the editor has no focus, or the cursor is in another block. */
export function renderedLine(view: EditorView, line: number): boolean {
  return !view.hasFocus || !editedLines(view.state).has(line);
}

function build(view: EditorView, opts: PreviewOptions): DecorationSet {
  const { state } = view;
  const raw = view.hasFocus ? editedLines(state) : new Set<number>();
  const ranges: Range<Decoration>[] = [];
  const lineOf = (pos: number) => state.doc.lineAt(pos).number;
  /** Hides `from` to `to`, and the space after it when `space` is set. */
  const hideMark = (from: number, to: number, space = false, deco: Decoration = hide) => {
    if (space && state.sliceDoc(to, to + 1) === " ") to++;
    if (to > from) ranges.push(deco.range(from, to));
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (ref) => {
        const name = ref.name;
        const line = lineOf(ref.from);
        if (name === "FencedCode" || name === "CodeBlock" || name === "Table") return false;
        if (raw.has(line)) return;
        if (name === "HorizontalRule") {
          ranges.push(rule.range(ref.from, ref.to));
        } else if (name === "InlineCode") {
          if (raw.has(lineOf(ref.to))) return;
          ranges.push(inlineCode.range(ref.from, ref.to));
        } else if (name === "CodeMark") {
          if (ref.node.parent?.name === "InlineCode") hideMark(ref.from, ref.to);
        } else if (name === "QuoteMark") {
          ranges.push(quoteLine.range(state.doc.line(line).from));
          hideMark(ref.from, ref.to, true);
        } else if (name === "ListMark") {
          // Ordered lists keep their numbers.
          if (ref.node.parent?.parent?.name === "BulletList") {
            ranges.push(bullet.range(ref.from, ref.to));
          }
        } else if (name === "TaskMarker") {
          const done = /\[[xX]\]/.test(state.sliceDoc(ref.from, ref.to));
          ranges.push((done ? checked : unchecked).range(ref.from, ref.to));
          const task = ref.node.parent;
          if (done && task && task.to > ref.to) ranges.push(doneTask.range(ref.to, task.to));
        } else if (name === "HeaderMark") {
          if (HEADING.test(ref.node.parent?.name ?? "")) hideMark(ref.from, ref.to, true);
        } else if (name === "EmphasisMark" || name === "StrikethroughMark") {
          hideMark(ref.from, ref.to);
        } else if (name === "Image") {
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
          if (open && close && close.to > open.to) ranges.push(linkText.range(open.to, close.from));
        } else if (name === "LinkMark" || name === "URL" || name === "LinkTitle") {
          // Only links written inline, [text](target): a reference [text][ref] stays as typed.
          const parent = ref.node.parent;
          if ((parent?.name === "Link" || parent?.name === "Image") && parent.getChild("URL")) hideMark(ref.from, ref.to);
        }
      },
    });
  }
  return Decoration.set(ranges, true);
}

// ---- tables ------------------------------------------------------------------

type Align = "left" | "center" | "right" | null;

interface ParsedTable {
  head: string[];
  aligns: Align[];
  rows: string[][];
}

/** The cells of a table row: the pipes at the ends are optional and `\|` is a pipe in a cell. */
function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  return text.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function parseTable(lines: string[]): ParsedTable | null {
  if (lines.length < 2 || !DELIMITER.test(lines[1] ?? "")) return null;
  const aligns = splitRow(lines[1] ?? "").map((c): Align =>
    c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null,
  );
  return { head: splitRow(lines[0] ?? ""), aligns, rows: lines.slice(2).map(splitRow) };
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(~~[^~]+~~)|(\*[^*]+\*)|\[([^\]]*)\]\(([^)\s]*)\)/g;

/** Appends plain text; a date in it is a link to its journal day. */
function appendText(text: string, parent: HTMLElement): void {
  let last = 0;
  for (const d of daysInLine(text)) {
    parent.append(text.slice(last, d.from));
    const a = Object.assign(document.createElement("a"), { textContent: text.slice(d.from, d.to), className: "date" });
    a.dataset.href = journalDest(d.day);
    parent.append(a);
    last = d.to;
  }
  parent.append(text.slice(last));
}

/** Appends the text of a table cell with its inline Markdown (code, bold, italic, strike, links) drawn. */
function renderInline(text: string, parent: HTMLElement): void {
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    appendText(text.slice(last, at), parent);
    last = at + m[0].length;
    if (m[1]) parent.append(Object.assign(document.createElement("code"), { textContent: m[1].slice(1, -1) }));
    else if (m[2]) parent.append(Object.assign(document.createElement("strong"), { textContent: m[2].slice(2, -2) }));
    else if (m[3]) parent.append(Object.assign(document.createElement("del"), { textContent: m[3].slice(2, -2) }));
    else if (m[4]) parent.append(Object.assign(document.createElement("em"), { textContent: m[4].slice(1, -1) }));
    else {
      const a = Object.assign(document.createElement("a"), { textContent: m[5] ?? "" });
      a.dataset.href = m[6] ?? "";
      parent.append(a);
    }
  }
  appendText(text.slice(last), parent);
}

class TableWidget extends WidgetType {
  constructor(
    private readonly table: ParsedTable,
    private readonly source: string,
    private readonly openLink: (dest: string) => void,
  ) {
    super();
  }
  override eq(other: TableWidget): boolean {
    return other.source === this.source;
  }
  override ignoreEvent(): boolean {
    return true;
  }
  override toDOM(view: EditorView): HTMLElement {
    const { head, aligns, rows } = this.table;
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-tablewrap";
    const table = document.createElement("table");
    table.className = "cm-lp-table";
    const row = (cells: string[], tag: "th" | "td", index: number) => {
      const tr = document.createElement("tr");
      tr.dataset.row = String(index);
      // Every row has as many cells as the header, however many were typed.
      for (let i = 0; i < head.length; i++) {
        const cell = document.createElement(tag);
        const align = aligns[i];
        if (align) cell.style.textAlign = align;
        renderInline(cells[i] ?? "", cell);
        tr.append(cell);
      }
      return tr;
    };
    const thead = document.createElement("thead");
    thead.append(row(head, "th", 0));
    const tbody = document.createElement("tbody");
    rows.forEach((cells, i) => tbody.append(row(cells, "td", i + 2)));
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

const focusChanged = StateEffect.define<boolean>();

const hasFocus = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) => tr.effects.reduce((v, e) => (e.is(focusChanged) ? e.value : v), value),
});

/** Draws each table as a table, unless the cursor is in it. Block widgets cannot come from a plugin. */
function tables(opts: PreviewOptions): Extension {
  const { openLink } = opts;
  const build = (state: EditorState): DecorationSet => {
    const focused = state.field(hasFocus);
    const ranges: Range<Decoration>[] = [];
    const head = Array.from({ length: Math.min(state.doc.lines, 200) }, (_, i) => state.doc.line(i + 1).text);
    const fmEnd = frontmatterEnd(head);
    if (fmEnd > 0) {
      const from = state.doc.line(1).from;
      // The blank lines after the front matter go with it, when there is text below them.
      let last = fmEnd + 1;
      while (last < state.doc.lines && state.doc.line(last + 1).text.trim() === "") last++;
      const to = state.doc.line(last < state.doc.lines ? last : fmEnd + 1).to;
      if (!(focused && state.selection.ranges.some((r) => r.from <= to && r.to >= from))) {
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
        if (focused && state.selection.ranges.some((r) => r.from <= last.to && r.to >= first.from)) return false;
        const lines = Array.from({ length: last.number - first.number + 1 }, (_, i) => state.doc.line(first.number + i).text);
        const table = parseTable(lines);
        if (table) {
          const source = lines.join("\n");
          ranges.push(Decoration.replace({ widget: new TableWidget(table, source, openLink), block: true }).range(first.from, last.to));
        }
        return false;
      },
    });
    return Decoration.set(ranges, true);
  };
  const field = StateField.define<DecorationSet>({
    create: (state) => build(state),
    update(value, tr) {
      const changed =
        tr.docChanged ||
        tr.selection !== undefined ||
        tr.effects.some((e) => e.is(focusChanged)) ||
        syntaxTree(tr.startState) !== syntaxTree(tr.state);
      return changed ? build(tr.state) : value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
  return [
    hasFocus,
    field,
    EditorView.focusChangeEffect.of((_state, focusing) => focusChanged.of(focusing)),
  ];
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
    const { doc } = tr.state;
    const lines = Array.from({ length: Math.min(doc.lines, 200) }, (_, i) => doc.line(i + 1).text);
    const end = frontmatterEnd(lines);
    // No front matter, or nothing in it to edit.
    if (end < 2) return tr;
    const to = doc.line(end + 1).to;
    // Outside it, or already editing it.
    if (head > to || tr.startState.selection.main.head <= to) return tr;
    return [tr, { selection: { anchor: doc.line(2).to }, scrollIntoView: true }];
  });
}

export function livePreview(opts: PreviewOptions): Extension {
  return [
    // Lets what mods draw know the Markdown is shown rendered.
    EditorView.editorAttributes.of({ class: "cm-preview" }),
    frontMatterGuard(),
    tables(opts),
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = build(view, opts);
        }
        update(update: ViewUpdate) {
          const tree = syntaxTree(update.startState) !== syntaxTree(update.state);
          const failed = update.transactions.some((tr) => tr.effects.some((e) => e.is(imageFailed)));
          if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged || tree || failed) {
            this.decorations = build(update.view, opts);
          }
        }
      },
      { decorations: (v) => v.decorations },
    ),
  ];
}

// ---- focus -------------------------------------------------------------------

const currentBlock = Decoration.line({ class: "cm-focus-cur" });

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
        for (const n of [...editedLines(view.state)].sort((a, b) => a - b)) {
          if (n <= view.state.doc.lines) ranges.push(currentBlock.range(view.state.doc.line(n).from));
        }
        return Decoration.set(ranges, true);
      }
    },
    { decorations: (v) => v.decorations },
  );
}
