// The gfm-extras mod: what GitHub draws in Markdown and the editor did not. Callouts (`> [!NOTE]`),
// footnotes and inline math are drawn in the text, where the Markdown is rendered and the cursor
// is not; `$$` blocks and ```math and ```mermaid fences are drawn under their source. Nothing is
// written to the page: it reads the same on GitHub, in an agent's context and here. Two commands
// copy a link to a heading and a selection as a quote with its source. The typesetting (KaTeX, as
// MathML, so it needs no fonts) and the diagrams (Mermaid) are big, so they are separate files
// loaded the first time a page has one.

import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

import type { ModContext } from "../../renderer/mods";
import { blockNodes } from "../../shared/syntax";
import { CALLOUTS, type CalloutKind, type FootnoteDef, type FootnoteRef, asQuote, headingLink, nextLabel, numberFootnotes, pageTitle } from "./plan";

const lazy = <T>(name: string): Promise<T> => import(/* @vite-ignore */ new URL(`./${name}.js`, import.meta.url).href) as Promise<T>;
let katexLoaded: Promise<{ render(tex: string, display: boolean): string }> | undefined;
let mermaidLoaded: Promise<{ draw(source: string, id: string, dark: boolean): Promise<string> }> | undefined;
const katex = () => (katexLoaded ??= lazy("katex"));
const mermaid = () => (mermaidLoaded ??= lazy("mermaid"));

const element = (tag: string, className: string, text = ""): HTMLElement => Object.assign(document.createElement(tag), { className, textContent: text });

function fromHtml(html: string): Node {
  const t = document.createElement("template");
  t.innerHTML = html;
  return t.content;
}

const dark = () => {
  const theme = document.documentElement.dataset.theme;
  return theme === "dark" || (theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
};

/** TeX as MathML in `into`; what KaTeX says is wrong is shown as an error instead. */
async function typeset(into: HTMLElement, tex: string, display: boolean): Promise<void> {
  try {
    into.replaceChildren(fromHtml((await katex()).render(tex, display)));
  } catch (e) {
    into.replaceChildren(Object.assign(element("span", "tessela-error", e instanceof Error ? e.message.replace(/^KaTeX parse error: /, "") : String(e))));
  }
}

// ---- widgets --------------------------------------------------------------------

class Title extends WidgetType {
  constructor(readonly kind: keyof typeof CALLOUTS) {
    super();
  }
  override eq(o: Title): boolean {
    return o.kind === this.kind;
  }
  /** A click on the title puts the cursor there, which shows the marker. */
  override ignoreEvent(): boolean {
    return false;
  }
  override toDOM(): HTMLElement {
    return element("span", "tessela-callout-title", CALLOUTS[this.kind]);
  }
}

/** A footnote's number in the text, or beside its definition. A click goes to the other end. */
class Number_ extends WidgetType {
  constructor(
    readonly n: number,
    readonly definition: boolean,
    readonly note: string | null,
    readonly goto: number | null,
  ) {
    super();
  }
  override eq(o: Number_): boolean {
    return o.n === this.n && o.definition === this.definition && o.note === this.note && o.goto === this.goto;
  }
  override toDOM(view: EditorView): HTMLElement {
    const text = this.definition ? `${this.n}.` : String(this.n);
    const dom = element(this.definition ? "span" : "sup", this.definition ? "tessela-fn-label" : "tessela-fn-ref", text);
    if (this.note !== null) dom.title = this.note;
    else if (!this.definition) {
      dom.classList.add("tessela-fn-missing");
      dom.title = "No definition for this footnote";
    }
    const { goto } = this;
    if (goto !== null) {
      dom.addEventListener("mousedown", (e) => {
        e.preventDefault();
        view.dispatch({ selection: { anchor: Math.min(goto, view.state.doc.length) }, effects: EditorView.scrollIntoView(goto, { y: "center" }) });
        view.focus();
      });
    }
    return dom;
  }
  override ignoreEvent(): boolean {
    return this.goto !== null;
  }
}

class Formula extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
    /** It stands in for blocks that are selected: it wears the class the editor draws selected blocks with. */
    readonly selected = false,
  ) {
    super();
  }
  override eq(o: Formula): boolean {
    return o.tex === this.tex && o.display === this.display && o.selected === this.selected;
  }
  /** A click on a formula puts the cursor at it, which shows its TeX. */
  override ignoreEvent(): boolean {
    return false;
  }
  override toDOM(): HTMLElement {
    const dom = element(this.display ? "div" : "span", `tessela-math ${this.display ? "tessela-math-block" : "tessela-math-inline"}${this.selected ? " cm-block-selected" : ""}`, this.tex);
    void typeset(dom, this.tex, this.display);
    return dom;
  }
}

// ---- reading the page -----------------------------------------------------------
//
// What is drawn is found in the syntax tree, where Tessela's own syntax (callouts, footnotes, math)
// is nodes next to the CommonMark ones: nothing here scans the lines.

const KINDS = new Set<string>(Object.keys(CALLOUTS));

/**
 * The footnote references, the definitions and the label of each, in the order of the page. Both start
 * with `[^`, so the text is searched for that (a fast scan) and the tree says what each hit is, if
 * anything: a walk of the whole tree to find them costs ten times as much on a long page.
 */
export function footnotesIn(state: EditorState): { refs: FootnoteRef[]; defs: FootnoteDef[] } {
  const refs: FootnoteRef[] = [];
  const defs: FootnoteDef[] = [];
  const tree = syntaxTree(state);
  const text = state.doc.toString();
  for (let at = text.indexOf("[^"); at >= 0; at = text.indexOf("[^", at + 2)) {
    const node = tree.resolveInner(at, 1);
    if (node.from !== at) continue;
    if (node.name === "FootnoteReference") {
      refs.push({ id: text.slice(node.from + 2, node.to - 1), from: node.from, to: node.to });
    } else if (node.name === "FootnoteLabel" && node.parent?.name === "FootnoteDefinition") {
      const def = node.parent;
      const label = { from: node.from, to: node.to };
      defs.push({ id: text.slice(label.from + 2, label.to - 2), from: def.from, label, text: text.slice(label.to, def.to).replace(/\s+/g, " ").trim() });
    }
  }
  return { refs, defs };
}

/** Inline math: the TeX between its two marks. */
function inlineMathOf(state: EditorState, node: SyntaxNode): { tex: string; from: number; to: number } | null {
  const [open, close] = node.getChildren("MathMark");
  return open && close ? { tex: state.sliceDoc(open.to, close.from), from: node.from, to: node.to } : null;
}

/** `$$` blocks that have a closing line: the TeX, and the lines they take. One that never closes is not drawn. */
function mathBlocksOf(state: EditorState): { tex: string; from: number; to: number; top: boolean }[] {
  const out: ReturnType<typeof mathBlocksOf> = [];
  for (const node of blockNodes(syntaxTree(state)).mathBlocks) {
    const marks = node.getChildren("MathMark");
    const text = node.getChild("MathText");
    if (marks.length < 2 || !text) continue;
    const first = state.doc.lineAt(node.from);
    const last = state.doc.lineAt(node.to);
    // Only a block that starts its line can stand in for its lines; one in a list or a quote is drawn under its source.
    out.push({ tex: state.sliceDoc(text.from, text.to).trim(), from: first.from, to: last.to, top: first.from === node.from });
  }
  return out;
}

// ---- the drawing in the text ----------------------------------------------------

/** What the editor says about the Markdown being drawn: `ctx.editor`'s reveal policy. */
export interface Reveal {
  rendered(state: EditorState): boolean;
  isEditing(state: EditorState, range: { from: number; to: number }): boolean;
  /** The range lies in the selected blocks (select mode). */
  isSelected?(state: EditorState, range: { from: number; to: number }): boolean;
}

/** A part of the page that is on the screen. */
export interface Visible {
  from: number;
  to: number;
}

/**
 * Callouts, footnotes and inline math, drawn where the Markdown is rendered and the cursor is not in
 * them. The reveal policy is the editor's (`ctx.editor.isEditing`), the same one that hides the `**`
 * of a bold span: a construct is typed where the cursor touches it, and nothing else is.
 *
 * Only what is in `visible` is drawn, and it is found in one walk of the tree over that part. Footnotes
 * are the exception that reads further: a note's number counts the references before it, and its text
 * and place are in its definition, wherever that is. The walk of the whole page for them is made only
 * when something to draw is among them, which is rare.
 */
export function textDecorations(state: EditorState, reveal: Reveal, visible: readonly Visible[] = [{ from: 0, to: state.doc.length }]): DecorationSet {
  const doc = state.doc;
  const draw = reveal.rendered(state);
  const editing = (from: number, to: number) => reveal.isEditing(state, { from, to });
  const ranges: Range<Decoration>[] = [];
  let footnotes = false;

  for (const view of visible) {
    syntaxTree(state).iterate({
      from: view.from,
      to: view.to,
      enter: (node) => {
        switch (node.name) {
          case "FencedCode":
          case "CodeBlock":
          case "MathBlock":
            return false;
          case "FootnoteReference":
          case "FootnoteDefinition":
            footnotes = true;
            return;
          case "Callout": {
            const mark = node.node.getChild("CalloutMark");
            const kind = mark ? state.sliceDoc(mark.from + 2, mark.to - 1).toLowerCase() : "";
            if (!mark || !KINDS.has(kind)) return;
            const top = doc.lineAt(node.from);
            const first = Math.max(top.number, doc.lineAt(Math.max(node.from, view.from)).number);
            const last = Math.min(doc.lineAt(node.to).number, doc.lineAt(Math.min(node.to, view.to)).number);
            for (let n = first; n <= last; n++) {
              ranges.push(Decoration.line({ class: `tessela-callout tessela-callout-${kind}${n === top.number ? " tessela-callout-first" : ""}` }).range(doc.line(n).from));
            }
            if (draw && mark.to >= view.from && mark.from <= view.to && !editing(top.from, top.to)) ranges.push(Decoration.replace({ widget: new Title(kind as CalloutKind) }).range(mark.from, mark.to));
            return;
          }
          case "InlineMath": {
            if (!draw) return;
            const m = inlineMathOf(state, node.node);
            if (m && !editing(m.from, m.to)) ranges.push(Decoration.replace({ widget: new Formula(m.tex, false) }).range(m.from, m.to));
          }
        }
      },
    });
  }

  if (footnotes) drawFootnotes(state, visible, draw, editing, ranges);
  return Decoration.set(ranges, true);
}

/** The footnotes among `visible`, numbered by the whole page. */
function drawFootnotes(state: EditorState, visible: readonly Visible[], draw: boolean, editing: (from: number, to: number) => boolean, ranges: Range<Decoration>[]): void {
  const lineStart = (pos: number) => state.doc.lineAt(pos).from;
  const seen = (from: number, to: number) => visible.some((v) => to >= v.from && from <= v.to);
  const { refs, defs } = footnotesIn(state);
  const notes = numberFootnotes(refs, defs);
  for (const def of defs) {
    if (!seen(def.from, def.label.to)) continue;
    const n = notes.numbers.get(def.id);
    ranges.push(Decoration.line({ class: "tessela-fn-def" }).range(lineStart(def.from)));
    const firstRef = notes.first.get(def.id);
    if (draw && n !== undefined && !editing(def.label.from, def.label.to)) {
      ranges.push(Decoration.replace({ widget: new Number_(n, true, null, firstRef === undefined ? null : lineStart(firstRef)) }).range(def.label.from, def.label.to));
    }
  }
  for (const r of refs) {
    if (!seen(r.from, r.to)) continue;
    const n = notes.numbers.get(r.id);
    const defined = notes.defs.get(r.id);
    if (draw && n !== undefined && !editing(r.from, r.to)) {
      ranges.push(Decoration.replace({ widget: new Number_(n, false, defined?.text ?? null, defined ? lineStart(defined.from) : null) }).range(r.from, r.to));
    } else {
      ranges.push(Decoration.mark({ class: "tessela-fn-raw" }).range(r.from, r.to));
    }
  }
}

/**
 * `$$` blocks. Drawn, one takes the place of its source, and where the cursor is in it, or the
 * Markdown is not rendered, it is typeset under its closing line and the source stays as written.
 */
export function mathDecorations(state: EditorState, reveal: Reveal): DecorationSet {
  const draw = reveal.rendered(state);
  const ranges: Range<Decoration>[] = [];
  for (const b of mathBlocksOf(state)) {
    const widget = new Formula(b.tex, true);
    if (draw && b.top && !reveal.isEditing(state, { from: b.from, to: b.to })) {
      const selected = reveal.isSelected?.(state, { from: b.from, to: b.to }) ?? false;
      ranges.push(Decoration.replace({ widget: selected ? new Formula(b.tex, true, true) : widget, block: true }).range(b.from, b.to));
    } else {
      ranges.push(Decoration.widget({ widget, block: true, side: 1 }).range(b.to));
    }
  }
  return Decoration.set(ranges, true);
}

/** Decorations that depend on what is typed are made again when the text, the tree, what is revealed or what is on the screen changes. */
function drawing(ctx: ModContext): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = textDecorations(view.state, ctx.editor, view.visibleRanges);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || ctx.editor.revealChanged(update.startState, update.state) || syntaxTree(update.startState) !== syntaxTree(update.state)) {
          this.decorations = textDecorations(update.state, ctx.editor, update.view.visibleRanges);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** Block widgets cannot come from a plugin, so `$$` blocks are a field. */
function blocks(ctx: ModContext): Extension {
  return StateField.define<DecorationSet>({
    create: (state) => mathDecorations(state, ctx.editor),
    update: (value, tr) =>
      tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState) || ctx.editor.revealChanged(tr.startState, tr.state) ? mathDecorations(tr.state, ctx.editor) : value,
    provide: (f) => EditorView.decorations.from(f),
  });
}

const theme = EditorView.baseTheme({
  ".tessela-callout": { borderLeft: "3px solid var(--callout)", paddingLeft: "12px !important", background: "color-mix(in srgb, var(--callout) 9%, transparent)", color: "var(--text) !important", fontStyle: "normal !important" },
  ".tessela-callout-first": { paddingTop: "4px", borderTopRightRadius: "4px" },
  ".tessela-callout-note": { "--callout": "var(--syn-fn)" },
  ".tessela-callout-tip": { "--callout": "var(--accent)" },
  ".tessela-callout-important": { "--callout": "var(--syn-keyword)" },
  ".tessela-callout-warning": { "--callout": "var(--warn)" },
  ".tessela-callout-caution": { "--callout": "var(--error)" },
  ".tessela-callout-title": { color: "var(--callout)", fontFamily: "var(--sans)", fontSize: "0.82em", fontWeight: "600", letterSpacing: "0.06em", textTransform: "uppercase" },
  ".tessela-fn-ref": { color: "var(--link)", cursor: "pointer", fontFamily: "var(--sans)", fontSize: "0.72em", fontWeight: "600", padding: "0 1px" },
  ".tessela-fn-missing": { color: "var(--error)", cursor: "default" },
  ".tessela-fn-raw": { color: "var(--link)" },
  ".tessela-fn-def": { fontSize: "0.9em", color: "var(--muted)" },
  ".tessela-fn-label": { color: "var(--link)", cursor: "pointer", fontFamily: "var(--sans)", fontWeight: "600", marginRight: "4px" },
  ".tessela-math-block": { textAlign: "center", padding: "8px 30px", overflowX: "auto" },
  ".tessela-math-inline": { whiteSpace: "nowrap" },
  ".tessela-diagram": { display: "flex", justifyContent: "center", padding: "6px 30px", overflowX: "auto" },
  ".tessela-diagram svg": { maxWidth: "100%", height: "auto" },
});

const extension = (ctx: ModContext): Extension => [drawing(ctx), blocks(ctx), theme];

// ---- the mod --------------------------------------------------------------------

/** Puts `text` on the clipboard; true when it got there. */
async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const box = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(box);
    box.select();
    const done = document.execCommand("copy");
    box.remove();
    return done;
  }
}

let drawings = 0;

export default function (ctx: ModContext): void {
  ctx.editor.extend(extension(ctx));

  ctx.fences.add("math", async ({ body }) => {
    const dom = element("div", "tessela-math tessela-math-block", body);
    await typeset(dom, body.trim(), true);
    return dom;
  });

  ctx.fences.add("mermaid", async ({ body }) => {
    const id = `tessela-mermaid-${drawings++}`;
    const svg = await (await mermaid()).draw(body, id, dark());
    const dom = element("div", "tessela-diagram");
    dom.append(fromHtml(svg));
    return dom;
  });

  const linesOf = (view: EditorView) => view.state.doc.toString().split("\n");

  ctx.commands.add({
    id: "gfm.heading-link",
    label: "Copy link to this heading",
    run: async ({ view }) => {
      const path = ctx.pages.current();
      if (!view || path === null) return ctx.ui.toast("Open a page first.");
      const link = headingLink(linesOf(view), view.state.doc.lineAt(view.state.selection.main.head).number - 1, path);
      if (link === null) return ctx.ui.toast("The cursor is above the first heading.");
      view.focus();
      ctx.ui.toast((await copy(link)) ? `Copied ${link}` : "Could not copy to the clipboard.");
    },
  });

  ctx.commands.add({
    id: "gfm.quote",
    label: "Copy as quote",
    run: async ({ view }) => {
      const path = ctx.pages.current();
      if (!view || path === null) return ctx.ui.toast("Open a page first.");
      const { main } = view.state.selection;
      // Without a selection, the line the cursor is on.
      const range = main.empty ? view.state.doc.lineAt(main.head) : main;
      const text = view.state.sliceDoc(range.from, range.to);
      if (text.trim() === "") return ctx.ui.toast("Select the text to quote.");
      view.focus();
      ctx.ui.toast((await copy(asQuote(text, pageTitle(linesOf(view), path), path))) ? "Copied the quote." : "Could not copy to the clipboard.");
    },
  });

  ctx.commands.add({
    id: "gfm.footnote",
    label: "Insert footnote",
    run: ({ view }) => {
      if (!view) return;
      const doc = view.state.doc;
      const text = doc.toString();
      const { refs, defs } = footnotesIn(view.state);
      const label = nextLabel([...refs, ...defs].map((n) => n.id));
      const ref = `[^${label}]`;
      // The definition goes at the end, after a blank line; after another definition, right under it.
      const trailing = text.length - text.trimEnd().length;
      const last = ctx.page(view.state).nodes.at(-1);
      const afterDefinition = last !== undefined && [last, ...last.ancestors()].some((n) => n.kind === "footnote");
      const tail = `${afterDefinition ? "\n" : "\n\n"}[^${label}]: `;
      const head = view.state.selection.main.head;
      const cursor = doc.length - trailing + ref.length + tail.length;
      view.dispatch({
        changes: [
          { from: head, insert: ref },
          { from: doc.length - trailing, to: doc.length, insert: tail },
        ],
        selection: { anchor: cursor },
        effects: EditorView.scrollIntoView(cursor, { y: "center" }),
        userEvent: "input",
      });
      view.focus();
    },
  });

  ctx.slash.add({ label: "Callout", detail: "> [!NOTE]", text: "> [!NOTE]\n> ", where: "line" });
  ctx.slash.add({ label: "Math block", detail: "$$ … $$", text: "$$\n\n$$", cursor: 3, where: "line" });
  ctx.slash.add({ label: "Diagram", detail: "```mermaid", text: "```mermaid\n\n```", cursor: 11, where: "line" });
}
