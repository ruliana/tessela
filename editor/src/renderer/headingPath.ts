// Long pages while writing: a bar that sticks to the top of the editor with the headings you have
// scrolled under (`Project › Design › Risks`), and a mark on the lines of headings so that they wrap
// in balanced lines. The path comes from the page model (`shared/headingPath.ts`); a click on a heading
// in it goes there. There is no reading mode: the bar is part of the one editor.

import { searchPanelOpen } from "@codemirror/search";
import { type EditorState, type Extension, type Range, RangeSet, StateField } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

import { type Crumb, headingCrumbs } from "../shared/headingPath";
import type { PageModel } from "../shared/pageModel";
import { pageModel } from "./pageModelField";

const headingLine = Decoration.line({ class: "cm-heading-line" });

/** A line decoration on the first line of each heading, for CSS (`text-wrap: balance`). */
const headingLines = StateField.define<{ model: PageModel; marks: RangeSet<Decoration> }>({
  create: (state) => marksOf(state.field(pageModel), state),
  update(value, tr) {
    const model = tr.state.field(pageModel);
    return model === value.model ? value : marksOf(model, tr.state);
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.marks),
});

function marksOf(model: PageModel, state: EditorState) {
  const ranges: Range<Decoration>[] = [];
  for (const n of model.nodes) if (n.kind === "section") ranges.push(headingLine.range(state.doc.line(n.startLine).from));
  return { model, marks: Decoration.set(ranges) };
}

class StickyPath {
  readonly dom = document.createElement("div");
  readonly bar = document.createElement("nav");
  crumbs: Crumb[] = [];
  /** What was drawn last, to leave the DOM alone when nothing changed. */
  drawn = "";
  readonly onScroll: (e: Event) => void;

  constructor(readonly view: EditorView) {
    // It has no height of its own, so showing it moves nothing; the bar is drawn over the text.
    this.dom.className = "cm-stickypath";
    this.bar.className = "cm-stickypath-bar";
    this.bar.setAttribute("aria-label", "Heading path");
    this.bar.hidden = true;
    this.dom.append(this.bar);
    view.dom.prepend(this.dom);
    this.bar.addEventListener("mousedown", (e) => e.preventDefault());
    this.bar.addEventListener("click", (e) => {
      const at = (e.target as HTMLElement).closest("button")?.dataset.index;
      if (at !== undefined) this.go(this.crumbs[Number(at)]);
    });
    // The page scrolls in a container around the editor, and scroll events do not bubble.
    this.onScroll = (e) => {
      if (e.target instanceof Node && e.target.contains(view.dom)) this.measure();
    };
    window.addEventListener("scroll", this.onScroll, { capture: true, passive: true });
    this.measure();
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) for (const c of this.crumbs) c.from = update.changes.mapPos(c.from, -1);
    if (update.docChanged || update.viewportChanged || update.geometryChanged) this.measure();
  }

  measure(): void {
    this.view.requestMeasure<{ pos: number } | null>({
      key: this,
      read: (view) => {
        if (searchPanelOpen(view.state)) return null;
        const bar = this.dom.getBoundingClientRect();
        const content = view.contentDOM.getBoundingClientRect();
        // Nothing has gone up behind the bar yet: the top of the page shows its own headings.
        if (content.top >= bar.top) return null;
        return { pos: view.posAtCoords({ x: content.left + content.width / 2, y: bar.top + 1 }, false) };
      },
      write: (at, view) => this.draw(at === null ? [] : headingCrumbs(view.state.field(pageModel), at.pos)),
    });
  }

  draw(crumbs: Crumb[]): void {
    this.crumbs = crumbs;
    const key = crumbs.map((c) => `${c.from}:${c.text}`).join("\n");
    if (key === this.drawn) return;
    this.drawn = key;
    this.bar.hidden = crumbs.length === 0;
    const parts: Node[] = [];
    crumbs.forEach((c, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.textContent = "›";
        sep.setAttribute("aria-hidden", "true");
        parts.push(sep);
      }
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.index = String(i);
      b.textContent = c.text || "(untitled)";
      parts.push(b);
    });
    this.bar.replaceChildren(...parts);
  }

  go(crumb: Crumb | undefined): void {
    if (!crumb) return;
    const { view } = this;
    // The bar covers the top of the window, so the heading is put below it.
    const margin = this.bar.getBoundingClientRect().height + 16;
    view.dispatch({ selection: { anchor: crumb.from }, effects: EditorView.scrollIntoView(crumb.from, { y: "start", yMargin: margin }) });
    view.focus();
  }

  destroy(): void {
    window.removeEventListener("scroll", this.onScroll, { capture: true });
    this.dom.remove();
  }
}

/** The sticky heading path, and the mark on heading lines. */
export const stickyHeadings: Extension = [headingLines, ViewPlugin.fromClass(StickyPath)];
