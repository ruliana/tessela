// Read next: when the cursor or the view reaches the end of a page, the two or three notes to go on to,
// listed under the page. It asks `tessela surface --whole` for notes that bear on the whole page and
// Jev which of them is the natural next read (see next.ts). The list is a block widget after the last
// line, so the text above it never moves. Without a Jev key (see main.ts) this does nothing at all.

import { type EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";

import { el } from "../../renderer/dom";
import type { ModContext } from "../../renderer/mods";
import { cliOf } from "../kit";
import { type Pick, type Reading, MIN_WORDS, delayFor, lastContent, nextMemory, notesToAsk, pickNext, reachedEnd, readNext, wordCount } from "./next";
import { type Surfaced, Runs } from "./plan";

/** How many candidates `tessela surface` is asked for: several may be of one page, and one note is kept for each. */
const LIMIT = 30;

const WHY = "Read next";

export default function (ctx: ModContext): void {
  if (!ctx.jev.on) return;

  const cli = cliOf(ctx);
  const runs = new Runs();
  const memory = nextMemory();
  /** The editor being written in, counted per change: an answer for an older text is dropped. */
  let version = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let owner: EditorView | null = null;

  // ---- the list under the page ----

  class List extends WidgetType {
    constructor(readonly picks: readonly Pick[]) {
      super();
    }

    override eq(other: List): boolean {
      return this.picks.length === other.picks.length && this.picks.every((p, i) => p.candidate.handle === other.picks[i]!.candidate.handle);
    }

    override toDOM(): HTMLElement {
      const rows = this.picks.map(({ candidate: c }) =>
        el(
          "li",
          { class: "read-next-item" },
          el("button", { class: "read-next-title", type: "button", title: `Open ${c.path}`, onclick: () => void ctx.pages.open(c.path, c.line) }, c.title),
          el("span", { class: "read-next-reason" }, c.reason),
          el("div", { class: "read-next-excerpt" }, c.excerpt),
        ),
      );
      return el("section", { class: "read-next", ariaLabel: WHY }, el("h3", {}, WHY), el("ul", {}, ...rows));
    }

    override ignoreEvent(): boolean {
      return false;
    }
  }

  const show = StateEffect.define<readonly Pick[]>();

  const field = StateField.define<{ picks: readonly Pick[]; decorations: DecorationSet }>({
    create: () => ({ picks: [], decorations: Decoration.none }),
    update(value, tr) {
      let picks = value.picks;
      for (const e of tr.effects) if (e.is(show)) picks = e.value;
      if (picks === value.picks && !tr.docChanged) return value;
      if (picks.length === 0) return { picks, decorations: Decoration.none };
      const widget = Decoration.widget({ widget: new List(picks), block: true, side: 1 }).range(tr.state.doc.length);
      return { picks, decorations: Decoration.set([widget]) };
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
  });

  // ---- the end of the page ----

  /** The nearest ancestor that scrolls the page. */
  function scrollerOf(view: EditorView): HTMLElement {
    for (let node = view.dom.parentElement; node; node = node.parentElement) if (/auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
    return view.scrollDOM;
  }

  function lastOnScreen(view: EditorView, last: number): boolean {
    const at = view.coordsAtPos(last);
    return at !== null && at.bottom <= scrollerOf(view).getBoundingClientRect().bottom;
  }

  /** Whether the writer is at the end of the page: the cursor in its last line, or the last line in view. */
  function atEnd(view: EditorView): boolean {
    const last = lastContent(view.state.doc);
    return reachedEnd(view.state.selection.main.head, last, lastOnScreen(view, last));
  }

  function readingOf(state: EditorState, path: string): Reading {
    const text = state.doc.toString();
    const model = ctx.page(state);
    const headings = model.nodes.filter((n) => n.kind === "section").map((n) => n.label);
    return { title: headings[0] ?? path.replace(/\.md$/, "").split("/").pop() ?? path, headings, text };
  }

  function clear(view: EditorView): void {
    if (view.state.field(field, false)?.picks.length) view.dispatch({ effects: show.of([]) });
  }

  async function run(view: EditorView, path: string): Promise<void> {
    if (ctx.pages.current() !== path || !view.dom.isConnected) return;
    if (!atEnd(view)) return clear(view);
    const reading = readingOf(view.state, path);
    if (!enough(reading.text)) return clear(view);
    const ran = version;
    const job = runs.start(ran);
    const found = await cli<Surfaced>(["surface", path, "--whole", "--text", "-", "--limit", String(LIMIT)], reading.text);
    if (job.stale(version) || !found.ok) return;
    const notes = notesToAsk(found.candidates, path);
    if (notes.length === 0) return clear(view);
    const readings = await readNext(reading, notes, memory, (request) => ctx.jev.ask(request, { signal: job.signal }));
    if (job.stale(version) || !readings || !view.dom.isConnected) return;
    // The writer may have left the end while Jev was thinking.
    if (!atEnd(view)) return clear(view);
    view.dispatch({ effects: show.of(pickNext(notes, readings)) });
  }

  function schedule(view: EditorView, path: string, edited: boolean): void {
    clearTimeout(timer);
    timer = setTimeout(() => void run(view, path), delayFor(edited));
  }

  ctx.editor.extend(({ path }) => [
    field,
    ViewPlugin.fromClass(
      class {
        readonly scroller: HTMLElement;
        readonly onScroll = (): void => {
          if (!this.view.dom.closest("#peek")) schedule(this.view, path, false);
        };

        constructor(readonly view: EditorView) {
          // Reading down to the end is not a change of the editor: the scroller says so.
          this.scroller = scrollerOf(view);
          this.scroller.addEventListener("scroll", this.onScroll, { passive: true });
        }

        update(update: ViewUpdate): void {
          const view = update.view;
          if (view.dom.closest("#peek")) return;
          const typed = update.transactions.some((t) => t.isUserEvent("input") || t.isUserEvent("delete"));
          if (update.docChanged && typed) {
            version++;
            runs.cancel();
          }
          // Where the end is on screen is read when the timer runs: the layout is not to be read in an update.
          if (!update.docChanged && !update.selectionSet && !update.geometryChanged && !update.viewportChanged) return;
          owner = view;
          schedule(view, path, typed);
        }

        destroy(): void {
          this.scroller.removeEventListener("scroll", this.onScroll);
          if (owner === this.view) forget();
        }
      },
    ),
  ]);

  function forget(): void {
    clearTimeout(timer);
    runs.cancel();
    owner = null;
  }

  ctx.events.on("bundle-opened", forget);
}

/** A page with nothing much on it has nothing to be followed. */
const enough = (text: string): boolean => wordCount(text) >= MIN_WORDS;
