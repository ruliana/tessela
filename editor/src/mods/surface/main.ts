// The surface mod: while you write, the one note that matters appears in the margin at a pause, and only
// when it is worth the interruption. At a pause (600 ms of nothing, the end of a sentence, Enter) it asks
// `tessela surface` for the notes that bear on the block under the cursor, asks Jev typed questions about
// each (does it answer this, contradict it, say it already, how close is it), and weighs the answers
// against what an interruption costs now. One card at most for each paragraph, level with it, and the text
// never moves. When nobody has typed for a while the same results go to the right column instead.
//
// Without a Jev key (config folder settings.json, `{"jev": {"key": "..."}}`) this mod does nothing at all.
// Everything is read through `ctx.cli` and `ctx.jev`; nothing is written to the notes.

import type { EditorView, ViewUpdate } from "@codemirror/view";

import { el } from "../../renderer/dom";
import type { ModContext } from "../../renderer/mods";
import { cliOf } from "../kit";
import { type Outcome, Ledger, adjust, learn, thresholdsFrom } from "./learn";
import {
  type Burst,
  type Card,
  type Surfaced,
  type Surfacing,
  PANEL_MS,
  WHY_LABEL,
  Runs,
  cardsOf,
  costOf,
  decide,
  dismiss,
  judge,
  memories,
  none,
  panelCards,
  recordEdit,
  settleMs,
  thoughtAt,
  toAsk,
  typingOf,
} from "./plan";

/** A card needs this much width; where the text leaves less beside it, the card goes over the right column instead. */
const MIN_ROOM = 190;
const MAX_ROOM = 280;
const GAP = 18;

const IS_MAC = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
const MOD = IS_MAC ? "⌘" : "Ctrl+";

export default function (ctx: ModContext): void {
  // No key: no calls, no cards, no commands. There is no fallback.
  if (!ctx.jev.on) return;

  const cli = cliOf(ctx);
  const side = ctx.slots.mount("side-bottom");
  const runs = new Runs();
  const memory = memories();
  // What the writer does with cards moves the bar for the question that raised them; the numbers are kept in the window's settings.
  const ledger = new Ledger();
  let thresholds = thresholdsFrom(ctx.settings.get("thresholds"));

  let log: Burst[] = [];
  /** The text of the editor being written in, counted per change: an answer for an older one is dropped. */
  let version = 0;
  let paragraph = 0;
  /** The paragraph last asked about, kept in step with the text. */
  let anchor: { view: EditorView; from: number; to: number } | null = null;
  let state: Surfacing = none();
  let cards: Card[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let panelTimer: ReturnType<typeof setTimeout> | undefined;
  /** The editor that last asked for a run: only its end ends the state (an editor of a page left behind may be destroyed late). */
  let owner: EditorView | null = null;
  /** The page the state is about: another page starts afresh. */
  let tracked = "";
  /** The card on show in the margin, and the editor it is drawn in. */
  let drawn: { root: HTMLElement; view: EditorView } | null = null;
  /** The card the ledger knows to be on show, and the paragraph it was raised for. */
  let shownCard: { card: Card; paragraph: number } | null = null;
  let panel: HTMLElement | null = null;

  /** What became of `card`: the bar of the question that raised it moves, once for each card. */
  function outcome(card: Card, what: Outcome, of = paragraph): void {
    const learned = ledger.settle(card, of, what);
    if (!learned) return;
    thresholds = learn(thresholds, learned.why, learned.outcome);
    ctx.settings.set("thresholds", thresholds);
  }

  /** The card in the margin went, unless the writer already did something with it, and `next` (if any) is the one that came in its place. */
  function sync(next: Card | null): void {
    const was = shownCard;
    const same = was !== null && was.card.candidate.handle === next?.candidate.handle && was.paragraph === paragraph;
    if (was && !same) outcome(was.card, "ignored", was.paragraph);
    if (next && !same) {
      ledger.raise(next, paragraph);
      shownCard = { card: next, paragraph };
    } else if (!next) shownCard = null;
  }

  // ---- the margin card ----

  function removeCard(): void {
    if (!drawn) return;
    document.removeEventListener("scroll", onScroll, true);
    drawn.root.remove();
    drawn = null;
  }

  const onScroll = (): void => {
    if (drawn) place(drawn.view);
  };

  /** Where a card goes for `view`: beside the text if the margin is wide enough, else over the right column; null when neither is. */
  function slotFor(view: EditorView): { left: number; width: number } | null {
    const editor = view.dom.getBoundingClientRect();
    const text = view.contentDOM.getBoundingClientRect();
    const room = editor.right - text.right - GAP * 2;
    if (room >= MIN_ROOM) return { left: text.right + GAP, width: Math.min(MAX_ROOM, room) };
    const column = document.getElementById("backlinks")?.getBoundingClientRect();
    if (column && column.width >= MIN_ROOM + 24) return { left: column.left + 12, width: column.width - 24 };
    return null;
  }

  /** The nearest ancestor that scrolls the page: a card is only shown while its paragraph is in view. */
  function scrollerOf(view: EditorView): HTMLElement {
    for (let node = view.dom.parentElement; node; node = node.parentElement) if (/auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
    return view.scrollDOM;
  }

  /** Puts the card level with its paragraph, right of the text. Nothing in the text moves. */
  function place(view: EditorView): void {
    if (!drawn || drawn.view !== view) return;
    const target = drawn;
    view.requestMeasure({
      key: place,
      read: (v) => {
        const at = v.coordsAtPos(Math.min(anchor?.from ?? 0, v.state.doc.length));
        const area = scrollerOf(v).getBoundingClientRect();
        return at ? { top: at.top, area, slot: slotFor(v) } : null;
      },
      write: (found) => {
        if (drawn !== target) return;
        const height = target.root.offsetHeight;
        const hidden = !found || !found.slot || found.top < found.area.top || found.top + height > found.area.bottom;
        target.root.style.visibility = hidden ? "hidden" : "";
        if (!found || !found.slot) return;
        Object.assign(target.root.style, { top: `${found.top}px`, left: `${found.slot.left}px`, width: `${found.slot.width}px` });
      },
    });
  }

  function drawCard(view: EditorView, card: Card): void {
    const { candidate } = card;
    const where = candidate.heading_path.join(" › ");
    const root = el(
      "aside",
      { class: "surface-card", role: "note", ariaLabel: "A note that may matter here" },
      el("div", { class: "surface-why" }, WHY_LABEL[card.why]),
      el("button", { class: "surface-title", type: "button", title: `Open ${candidate.path}`, onclick: () => (outcome(card, "opened"), void ctx.pages.open(candidate.path, candidate.line)) }, candidate.title),
      ...(where === "" ? [] : [el("div", { class: "surface-where" }, where)]),
      el("div", { class: "surface-excerpt" }, candidate.excerpt),
      el("div", { class: "surface-keys" }, `${MOD}Alt+↵ peek · ${MOD}Alt+I link · Esc dismiss`),
    );
    removeCard();
    drawn = { root, view };
    document.body.append(root);
    document.addEventListener("scroll", onScroll, true);
    place(view);
  }

  // ---- the right column ----

  function removePanel(): void {
    panel?.remove();
    panel = null;
  }

  function drawPanel(list: Card[]): void {
    removePanel();
    if (list.length === 0) return;
    const rows = list.map((c) =>
      el(
        "div",
        { class: "surface-item" },
        el("button", { class: "surface-name", type: "button", title: `Open ${c.candidate.path}`, onclick: () => (outcome(c, "opened"), void ctx.pages.open(c.candidate.path, c.candidate.line)) }, c.candidate.title),
        el("span", { class: "surface-reason" }, `${WHY_LABEL[c.why]} · ${c.candidate.reason}`),
        el("button", { class: "surface-link", type: "button", title: "Insert a link at the cursor", onclick: () => (outcome(c, "linked"), ctx.pages.insert(c.candidate.link)) }, "Link"),
      ),
    );
    panel = el("section", { class: "bl-group surface-panel" }, el("h3", {}, "Worth a look", el("span", { class: "n" }, String(list.length))), ...rows);
    side.root.append(panel);
    side.reveal();
  }

  // ---- the loop ----

  /** What the cards are now: drawn in the margin when there is room, else listed in the right column. */
  function apply(view: EditorView, change: Surfacing, how: "show" | "keep" | "hide" | "none"): void {
    state = change;
    const card = state.shown;
    if (how === "hide" || !card) {
      removeCard();
      return;
    }
    if (slotFor(view) === null) {
      removeCard();
      drawPanel(panelCards(cards, state.dismissed));
      return;
    }
    if (how === "show" || !drawn || drawn.view !== view) drawCard(view, card);
    else place(view);
  }

  function hide(): void {
    removeCard();
    state = { ...state, shown: null };
    sync(null);
  }

  function dismissCard(): boolean {
    if (!state.shown || !drawn) return false;
    outcome(state.shown, "dismissed");
    state = dismiss(state);
    removeCard();
    return true;
  }

  async function run(view: EditorView, path: string): Promise<void> {
    if (!view.hasFocus || ctx.pages.current() !== path) return;
    if (tracked !== path) {
      forget();
      tracked = path;
      owner = view;
    }
    const thought = thoughtAt(ctx.page(view.state), view.state.selection.main.head);
    if (!thought) return hide();
    const head = view.state.selection.main.head;
    const ran = version;
    const now = Date.now();
    const typing = typingOf(log, now);
    const job = runs.start(ran);

    await ctx.pages.flush();
    if (job.stale(version)) return;
    const found = await cli<Surfaced>(["surface", path, "--at", String(thought.line), "--text", "-", "--limit", "20"], thought.text);
    if (job.stale(version) || !found.ok) return;
    const notes = toAsk(found.candidates);
    if (notes.length === 0) {
      cards = [];
      return hide();
    }
    const writing = { characters_added_per_second: Math.round(typing.speed * 10) / 10, share_of_changes_that_were_deletions: Math.round(typing.erasing * 100) / 100 };
    const judged = await judge(thought, writing, notes, memory, (request) => ctx.jev.ask(request, { signal: job.signal }));
    if (job.stale(version) || !judged) return;

    // The paragraph is the block's start, followed through the edits that came since it was last asked about.
    if (anchor?.view !== view || anchor.from !== thought.from) paragraph++;
    anchor = { view, from: thought.from, to: thought.end };
    cards = adjust(cardsOf(notes, judged.verdicts, judged.paragraph), thresholds);
    const cost = costOf(typing, head >= thought.end, judged.paragraph.activity);
    const next = decide(state, cards, cost, paragraph);
    sync(next.state.shown);
    apply(view, next.state, next.change);
    clearTimeout(panelTimer);
    panelTimer = setTimeout(idle, Math.max(0, PANEL_MS - (Date.now() - now)));
  }

  /** Nobody has typed for a while: the results go to the right column and the margin is left to the text. */
  function idle(): void {
    if (cards.length === 0) return;
    removeCard();
    state = { ...state, shown: null };
    sync(null);
    drawPanel(panelCards(cards, state.dismissed));
  }

  // ---- the editor ----

  ctx.editor.extend(({ path }) =>
    ctx.cm.view.ViewPlugin.fromClass(
      class {
        constructor(readonly view: EditorView) {}

        update(update: ViewUpdate): void {
          const view = update.view;
          if (view.dom.closest("#peek")) return;
          if (anchor?.view === view && update.docChanged) anchor = { view, from: update.changes.mapPos(anchor.from, -1), to: update.changes.mapPos(anchor.to, 1) };
          if (drawn?.view === view && (update.docChanged || update.geometryChanged || update.viewportChanged)) place(view);
          // The card belongs to its paragraph: a cursor that has left it ends it.
          if (drawn?.view === view && update.selectionSet && anchor?.view === view) {
            const head = update.state.selection.main.head;
            if (head < anchor.from || head > anchor.to + 1) hide();
          }
          const typed = update.transactions.some((t) => t.isUserEvent("input") || t.isUserEvent("delete"));
          if (!update.docChanged || !typed || !view.hasFocus) return;
          owner = view;

          let added = 0;
          let removed = 0;
          update.changes.iterChanges((from, to, _f, _t, inserted) => {
            removed += to - from;
            added += inserted.length;
          });
          log = recordEdit(log, { at: Date.now(), added, removed });
          version++;
          runs.cancel();
          clearTimeout(timer);
          clearTimeout(panelTimer);
          removePanel();
          const head = update.state.selection.main.head;
          timer = setTimeout(() => void run(view, path), settleMs(update.state.doc.sliceString(Math.max(0, head - 12), head)));
        }

        destroy(): void {
          if (owner === this.view) forget();
        }
      },
    ),
  );

  // Esc dismisses the card, above the editor's own keys (a peek in the way takes it first).
  ctx.editor.extend(
    ctx.cm.state.Prec.highest(
      ctx.cm.view.keymap.of([
        {
          key: "Escape",
          run: () => {
            if (document.querySelector(".cm-tooltip-autocomplete")) return false;
            return dismissCard();
          },
        },
      ]),
    ),
  );

  const nothing = () => ctx.ui.toast("No note is suggested right now.");

  ctx.commands.add({
    id: "surface.peek",
    label: "Peek at the suggested note",
    keys: "Mod-Alt-Enter",
    run: ({ view }) => {
      const card = state.shown;
      if (!card) return nothing();
      outcome(card, "opened");
      ctx.commands.run("peek.page", { view, page: card.candidate.path });
    },
  });

  ctx.commands.add({
    id: "surface.link",
    label: "Link the suggested note",
    keys: "Mod-Alt-i",
    run: () => {
      const card = state.shown;
      if (!card) return nothing();
      outcome(card, "linked");
      ctx.pages.insert(card.candidate.link);
    },
  });

  function forget(): void {
    sync(null);
    runs.cancel();
    clearTimeout(timer);
    clearTimeout(panelTimer);
    removeCard();
    removePanel();
    owner = null;
    cards = [];
    anchor = null;
    state = none();
    paragraph = 0;
    tracked = "";
  }

  ctx.events.on("bundle-opened", forget);
}
