// Live preview: Markdown shown rendered, and raw only where the cursor is. Like the
// editing mode of Logseq, the block being edited (a paragraph, a heading, a list item)
// shows its marks and everything else hides them. The text itself never changes, so
// saving, searching and the tools see the same Markdown as always.

import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";

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

const hide = Decoration.replace({});
const bullet = Decoration.replace({ widget: new Glyph("•", "cm-lp-bullet") });
const unchecked = Decoration.replace({ widget: new Glyph("☐", "cm-lp-check") });
const checked = Decoration.replace({ widget: new Glyph("☑", "cm-lp-check cm-lp-checked") });
const rule = Decoration.replace({ widget: new Glyph("", "cm-lp-rule") });
const quoteLine = Decoration.line({ class: "cm-lp-quote" });
const inlineCode = Decoration.mark({ class: "cm-lp-code" });
const doneTask = Decoration.mark({ class: "cm-lp-done" });
const linkText = Decoration.mark({ class: "cm-lp-link" });

const HEADING = /^ATXHeading[1-6]$/;

/** The lines (1-based) of the blocks that hold the selection: these are shown raw. */
function editedLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  const tree = syntaxTree(state);
  const addBlock = (pos: number) => {
    for (let node = tree.resolveInner(pos, 0) as { name: string; from: number; to: number; parent: unknown } | null; node; ) {
      // A paragraph that spans several lines is one block.
      if (node.name === "Paragraph") {
        for (let n = state.doc.lineAt(node.from).number; n <= state.doc.lineAt(node.to).number; n++) lines.add(n);
        return;
      }
      node = node.parent as typeof node;
    }
  };
  for (const { from, to } of state.selection.ranges) {
    for (let n = state.doc.lineAt(from).number; n <= state.doc.lineAt(to).number; n++) lines.add(n);
    addBlock(from);
    addBlock(to);
  }
  return lines;
}

/** Whether the line is shown rendered: the editor has no focus, or the cursor is in another block. */
export function renderedLine(view: EditorView, line: number): boolean {
  return !view.hasFocus || !editedLines(view.state).has(line);
}

function build(view: EditorView): DecorationSet {
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
        } else if (name === "Link" || name === "Image") {
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

/** Appends the text of a table cell with its inline Markdown (code, bold, italic, strike, links) drawn. */
function renderInline(text: string, parent: HTMLElement): void {
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    parent.append(text.slice(last, at));
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
  parent.append(text.slice(last));
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

const focusChanged = StateEffect.define<boolean>();

const hasFocus = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) => tr.effects.reduce((v, e) => (e.is(focusChanged) ? e.value : v), value),
});

/** Draws each table as a table, unless the cursor is in it. Block widgets cannot come from a plugin. */
function tables(openLink: (dest: string) => void): Extension {
  const build = (state: EditorState): DecorationSet => {
    const focused = state.field(hasFocus);
    const ranges: Range<Decoration>[] = [];
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
}

export function livePreview(opts: PreviewOptions): Extension {
  return [
    tables(opts.openLink),
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = build(view);
        }
        update(update: ViewUpdate) {
          const tree = syntaxTree(update.startState) !== syntaxTree(update.state);
          if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged || tree) {
            this.decorations = build(update.view);
          }
        }
      },
      { decorations: (v) => v.decorations },
    ),
  ];
}
