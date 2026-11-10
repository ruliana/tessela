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

import type { ModContext } from "../../renderer/mods";
import { CALLOUTS, asQuote, calloutKind, displayMath, footnotesOf, footnoteDefinition, footnoteRefs, headingLink, inlineMath, nextLabel, pageTitle } from "./plan";

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

// ---- where the Markdown is drawn ------------------------------------------------

/** Whether the window shows Markdown rendered (the live preview adds `cm-preview` to the editor). */
const rendered = (state: EditorState): boolean => state.facet(EditorView.editorAttributes).some((a) => typeof a === "object" && /\bcm-preview\b/.test((a as { class?: string }).class ?? ""));

/** The lines (0 is the first) that are in a code block, where none of this applies. */
function codeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "FencedCode" && node.name !== "CodeBlock") return;
      for (let n = state.doc.lineAt(node.from).number; n <= state.doc.lineAt(node.to).number; n++) lines.add(n - 1);
      return false;
    },
  });
  return lines;
}

const inInlineCode = (state: EditorState, pos: number) => syntaxTree(state).resolveInner(pos, 1).name === "InlineCode";

// ---- widgets --------------------------------------------------------------------

class Title extends WidgetType {
  constructor(readonly kind: keyof typeof CALLOUTS) {
    super();
  }
  override eq(o: Title): boolean {
    return o.kind === this.kind;
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
  override toDOM(): HTMLElement {
    const dom = element(this.display ? "div" : "span", `tessela-math ${this.display ? "tessela-math-block" : "tessela-math-inline"}`, this.tex);
    void typeset(dom, this.tex, this.display);
    return dom;
  }
}

// ---- the drawing in the text ----------------------------------------------------

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const draw = rendered(state);
  const code = codeLines(state);
  const lines = doc.toString().split("\n");
  const notes = footnotesOf(lines, (i) => code.has(i));
  const ranges: Range<Decoration>[] = [];
  /** Where the cursor is the construct shows as written. */
  const editing = (from: number, to: number) => view.hasFocus && state.selection.ranges.some((r) => r.from <= to && r.to >= from);
  const at = (line: number, column: number) => doc.line(line + 1).from + column;

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "Blockquote") return;
      const first = doc.lineAt(node.from);
      const kind = calloutKind(first.text);
      if (!kind) return;
      for (let n = first.number; n <= doc.lineAt(node.to).number; n++) {
        ranges.push(Decoration.line({ class: `tessela-callout tessela-callout-${kind}${n === first.number ? " tessela-callout-first" : ""}` }).range(doc.line(n).from));
      }
      const marker = first.text.indexOf("[");
      if (draw && !editing(first.from, first.to)) {
        ranges.push(Decoration.replace({ widget: new Title(kind) }).range(first.from + marker, first.to - (first.text.length - first.text.trimEnd().length)));
      }
    },
  });

  for (const [i, text] of lines.entries()) {
    if (code.has(i)) continue;
    const def = footnoteDefinition(text);
    if (def) {
      const n = notes.numbers.get(def.id);
      ranges.push(Decoration.line({ class: "tessela-fn-def" }).range(at(i, 0)));
      if (draw && n !== undefined && !editing(at(i, 0), at(i, def.to))) {
        ranges.push(Decoration.replace({ widget: new Number_(n, true, null, at(notes.first.get(def.id)!, 0)) }).range(at(i, 0), at(i, def.to)));
      }
    }
    for (const r of footnoteRefs(text)) {
      if (inInlineCode(state, at(i, r.from) + 1)) continue;
      const n = notes.numbers.get(r.id);
      const defined = notes.defs.get(r.id);
      if (draw && n !== undefined && !editing(at(i, r.from), at(i, r.to))) {
        ranges.push(Decoration.replace({ widget: new Number_(n, false, defined?.text ?? null, defined ? at(defined.line, 0) : null) }).range(at(i, r.from), at(i, r.to)));
      } else {
        ranges.push(Decoration.mark({ class: "tessela-fn-raw" }).range(at(i, r.from), at(i, r.to)));
      }
    }
    if (draw && text.includes("$")) {
      for (const m of inlineMath(text)) {
        if (!editing(at(i, m.from), at(i, m.to))) ranges.push(Decoration.replace({ widget: new Formula(m.tex, false) }).range(at(i, m.from), at(i, m.to)));
      }
    }
  }
  return Decoration.set(ranges, true);
}

const drawing = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(update: ViewUpdate) {
      const mode = rendered(update.startState) !== rendered(update.state);
      if (update.docChanged || update.selectionSet || update.focusChanged || mode || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** `$$` blocks are typeset under their closing line; the source stays as written. */
const blocks = StateField.define<DecorationSet>({
  create: (state) => blocksOf(state),
  update: (value, tr) => (tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState) ? blocksOf(tr.state) : value),
  provide: (f) => EditorView.decorations.from(f),
});

function blocksOf(state: EditorState): DecorationSet {
  const code = codeLines(state);
  const found = displayMath(state.doc.toString().split("\n"), (i) => code.has(i));
  return Decoration.set(found.map((b) => Decoration.widget({ widget: new Formula(b.tex, true), block: true, side: 1 }).range(state.doc.line(b.to + 1).to)));
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

const extension: Extension = [drawing, blocks, theme];

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
  ctx.editor.extend(extension);

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
      const label = nextLabel(text.split("\n"));
      const ref = `[^${label}]`;
      // The definition goes at the end, after a blank line; after another definition, right under it.
      const trailing = text.length - text.trimEnd().length;
      const lastLine = text.trimEnd().split("\n").pop() ?? "";
      const tail = `${footnoteDefinition(lastLine) ? "\n" : "\n\n"}[^${label}]: `;
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
