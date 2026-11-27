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
  ) {
    super();
  }
  override eq(o: Formula): boolean {
    return o.tex === this.tex && o.display === this.display;
  }
  /** A click on a formula puts the cursor at it, which shows its TeX. */
  override ignoreEvent(): boolean {
    return false;
  }
  override toDOM(): HTMLElement {
    const dom = element(this.display ? "div" : "span", `tessela-math ${this.display ? "tessela-math-block" : "tessela-math-inline"}`, this.tex);
    void typeset(dom, this.tex, this.display);
    return dom;
  }
}

// ---- reading the page -----------------------------------------------------------
//
// What is drawn is found in the syntax tree, where Tessela's own syntax (callouts, footnotes, math)
// is nodes next to the CommonMark ones: nothing here scans the lines.

const KINDS = new Set<string>(Object.keys(CALLOUTS));

/** The callouts: the kind each `> [!NOTE]` says, and where its first line and marker are. */
function calloutsOf(state: EditorState): { kind: CalloutKind; from: number; to: number; first: { from: number; to: number }; marker: { from: number; to: number } }[] {
  const out: ReturnType<typeof calloutsOf> = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "Callout") return;
      const mark = node.node.getChild("CalloutMark");
      const kind = mark ? state.sliceDoc(mark.from + 2, mark.to - 1).toLowerCase() : "";
      if (!mark || !KINDS.has(kind)) return;
      const first = state.doc.lineAt(node.from);
      out.push({ kind: kind as CalloutKind, from: node.from, to: node.to, first: { from: first.from, to: first.to }, marker: { from: mark.from, to: mark.to } });
    },
  });
  return out;
}

/** The footnote references, the definitions and the label of each, in the order of the page. */
function footnotesIn(state: EditorState): { refs: FootnoteRef[]; defs: FootnoteDef[] } {
  const refs: FootnoteRef[] = [];
  const defs: FootnoteDef[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === "FootnoteReference") {
        refs.push({ id: state.sliceDoc(node.from + 2, node.to - 1), from: node.from, to: node.to });
      } else if (node.name === "FootnoteDefinition") {
        const label = node.node.getChild("FootnoteLabel");
        if (!label) return;
        const text = state.sliceDoc(label.to, node.to).replace(/\s+/g, " ").trim();
        defs.push({ id: state.sliceDoc(label.from + 2, label.to - 2), from: node.from, label: { from: label.from, to: label.to }, text });
      }
    },
  });
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
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "MathBlock") return;
      const marks = node.node.getChildren("MathMark");
      const text = node.node.getChild("MathText");
      if (marks.length < 2 || !text) return false;
      const first = state.doc.lineAt(node.from);
      const last = state.doc.lineAt(node.to);
      // Only a block that starts its line can stand in for its lines; one in a list or a quote is drawn under its source.
      out.push({ tex: state.sliceDoc(text.from, text.to).trim(), from: first.from, to: last.to, top: first.from === node.from });
      return false;
    },
  });
  return out;
}

// ---- the drawing in the text ----------------------------------------------------

/** What the editor says about the Markdown being drawn: `ctx.editor`'s reveal policy. */
export interface Reveal {
  rendered(state: EditorState): boolean;
  isEditing(state: EditorState, range: { from: number; to: number }): boolean;
}

/**
 * Callouts, footnotes and inline math, drawn where the Markdown is rendered and the cursor is not in
 * them. The reveal policy is the editor's (`ctx.editor.isEditing`), the same one that hides the `**`
 * of a bold span: a construct is typed where the cursor touches it, and nothing else is.
 */
export function textDecorations(state: EditorState, reveal: Reveal): DecorationSet {
  const doc = state.doc;
  const draw = reveal.rendered(state);
  const editing = (from: number, to: number) => reveal.isEditing(state, { from, to });
  const ranges: Range<Decoration>[] = [];

  for (const { kind, from, to, first, marker } of calloutsOf(state)) {
    const top = doc.lineAt(from).number;
    for (let n = top; n <= doc.lineAt(to).number; n++) {
      ranges.push(Decoration.line({ class: `tessela-callout tessela-callout-${kind}${n === top ? " tessela-callout-first" : ""}` }).range(doc.line(n).from));
    }
    if (draw && !editing(first.from, first.to)) ranges.push(Decoration.replace({ widget: new Title(kind) }).range(marker.from, marker.to));
  }

  const { refs, defs } = footnotesIn(state);
  const notes = numberFootnotes(refs, defs);
  const lineStart = (pos: number) => doc.lineAt(pos).from;
  for (const def of defs) {
    const n = notes.numbers.get(def.id);
    ranges.push(Decoration.line({ class: "tessela-fn-def" }).range(lineStart(def.from)));
    const firstRef = notes.first.get(def.id);
    if (draw && n !== undefined && !editing(def.label.from, def.label.to)) {
      ranges.push(Decoration.replace({ widget: new Number_(n, true, null, firstRef === undefined ? null : lineStart(firstRef)) }).range(def.label.from, def.label.to));
    }
  }
  for (const r of refs) {
    const n = notes.numbers.get(r.id);
    const defined = notes.defs.get(r.id);
    if (draw && n !== undefined && !editing(r.from, r.to)) {
      ranges.push(Decoration.replace({ widget: new Number_(n, false, defined?.text ?? null, defined ? lineStart(defined.from) : null) }).range(r.from, r.to));
    } else {
      ranges.push(Decoration.mark({ class: "tessela-fn-raw" }).range(r.from, r.to));
    }
  }

  if (draw) {
    syntaxTree(state).iterate({
      enter: (node) => {
        if (node.name === "FencedCode" || node.name === "CodeBlock" || node.name === "MathBlock") return false;
        if (node.name !== "InlineMath") return;
        const m = inlineMathOf(state, node.node);
        if (m && !editing(m.from, m.to)) ranges.push(Decoration.replace({ widget: new Formula(m.tex, false) }).range(m.from, m.to));
      },
    });
  }
  return Decoration.set(ranges, true);
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
      ranges.push(Decoration.replace({ widget, block: true }).range(b.from, b.to));
    } else {
      ranges.push(Decoration.widget({ widget, block: true, side: 1 }).range(b.to));
    }
  }
  return Decoration.set(ranges, true);
}

/** Decorations that depend on what is typed are made again when the text, the tree or what is revealed changes. */
function drawing(ctx: ModContext): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = textDecorations(view.state, ctx.editor);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || ctx.editor.revealChanged(update.startState, update.state) || syntaxTree(update.startState) !== syntaxTree(update.state)) {
          this.decorations = textDecorations(update.state, ctx.editor);
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
