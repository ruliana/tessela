// Fold and zoom in the editor, the CodeMirror side of the fold mod. The logic of what can be folded,
// and what a zoom shows, is in shared/folds.ts. A fold hides the lines under a heading, a list item
// or a paragraph with its list. Zoom shows one block and what it owns, with the way back drawn above
// it. Neither touches the page: the window remembers the folds by block key (`FoldStore`), and a
// zoom is for the moment.

import { codeFolding, foldEffect, foldedRanges, syntaxTree, unfoldEffect } from "@codemirror/language";
import { EditorState, type Extension, Prec, type Range, StateEffect, StateField, type Text, Transaction } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType, keymap } from "@codemirror/view";

import { type Crumb, type Fold, foldAround, foldables, foldsOnLoad, foldsToRemember, zoomAt } from "../../shared/folds";
import type { PageModel } from "../../shared/pageModel";
import { parsePage } from "../../shared/pageText";
import type { ModContext } from "../../renderer/mods";

// ---- folds -------------------------------------------------------------------------

const cache = new WeakMap<Text, Fold[]>();

/** The page model of a state: the editor's own, which the mod is handed (`ctx.page`). */
type PageOf = (state: EditorState) => PageModel;

/** What the mod asks of the editor besides the page (`ctx.editor`): which blocks are selected, and a way to say what it hides. */
export type EditorApi = Pick<ModContext["editor"], "hidden" | "selectedBlocks" | "selectBlocks">;

// `ctx.page` and `ctx.editor` are one object for every editor of the window, so `folding` keeps them here.
let page: PageOf;
let editorApi: EditorApi;
function modelOf(state: EditorState): PageModel {
  return page(state);
}

/** The foldable blocks of the page, worked out once for each version of the text. */
function foldsOf(state: EditorState): Fold[] {
  let found = cache.get(state.doc);
  if (!found) {
    const model = modelOf(state);
    found = foldables(model);
    if (model.complete) cache.set(state.doc, found);
  }
  return found;
}

/** What the fold of `f` hides: from the end of its visible line to the end of its last line. */
function hidden(state: { doc: Text }, f: Fold): { from: number; to: number } {
  return { from: state.doc.line(f.line + 1).to, to: state.doc.line(f.last + 1).to };
}

function isFolded(state: EditorState, r: { from: number; to: number }): boolean {
  let found = false;
  foldedRanges(state).between(r.from, r.to, (a, b) => {
    if (a === r.from && b === r.to) found = true;
  });
  return found;
}

/** Whether an update opened or closed a fold (a fold that went with the text it covered counts too). */
function foldChanged(update: ViewUpdate): boolean {
  const effect = update.transactions.some((tr) => tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect)));
  return effect || foldedRanges(update.startState).size !== foldedRanges(update.state).size;
}

/** The text was replaced as a whole by the editor, not typed: a page loaded or read again. */
function isReplacement(tr: Transaction): boolean {
  if (!tr.docChanged || tr.annotation(Transaction.userEvent) !== undefined) return false;
  let whole = false;
  tr.changes.iterChangedRanges((from, to) => {
    whole = from === 0 && to === tr.startState.doc.length;
  });
  return whole;
}

/** What to remember of the page's folds: the blocks folded now, and the ones that fold by themselves and were opened. */
function foldKeys(state: EditorState): string[] {
  return foldsToRemember(foldsOf(state), (f) => isFolded(state, hidden(state, f)));
}

/** Where the window keeps which blocks of a page are folded: keys made by `foldables`, by page. */
export interface FoldStore {
  read(path: string): string[];
  write(path: string, keys: string[]): void;
}

/** A page that has just been loaded folds again what was folded: the blocks whose key is stored, and the fences that run unless they were opened. */
function restoring(path: string, store: FoldStore): Extension {
  return EditorState.transactionExtender.of((tr) => {
    if (!isReplacement(tr)) return null;
    const effects = foldsOnLoad(foldables(parsePage(tr.newDoc.toString())), store.read(path)).map((f) => foldEffect.of(hidden({ doc: tr.newDoc }, f)));
    return effects.length > 0 ? { effects } : null;
  });
}

/** Keeps the store up to date: at once when a fold opens or closes, a little later while its page is being typed in. */
function remembering(path: string, store: FoldStore): Extension {
  return ViewPlugin.fromClass(
    class {
      timer: number | undefined;
      constructor(readonly view: EditorView) {}
      save = (): void => {
        this.timer = undefined;
        store.write(path, foldKeys(this.view.state));
      };
      update(update: ViewUpdate) {
        if (foldChanged(update)) {
          window.clearTimeout(this.timer);
          this.save();
        } else if (update.docChanged && foldedRanges(update.state).size > 0) {
          window.clearTimeout(this.timer);
          this.timer = window.setTimeout(this.save, 400);
        }
      }
      destroy() {
        window.clearTimeout(this.timer);
      }
    },
  );
}

function headLine(state: EditorState): number {
  return state.doc.lineAt(state.selection.main.head).number - 1;
}

function dispatchFold(view: EditorView, effects: StateEffect<{ from: number; to: number }>[], covered: { from: number; to: number }[]): void {
  // The cursor in a line that disappears goes to the line that stays.
  const head = view.state.selection.main.head;
  const inside = covered.filter((r) => head > r.from && head <= r.to);
  const at = inside.length > 0 ? Math.min(...inside.map((r) => r.from)) : head;
  view.dispatch({ effects, selection: { anchor: at }, scrollIntoView: true });
}

/**
 * In select mode, folds (or opens) the selected blocks, and they stay selected. False when blocks
 * are not selected, so that the key does what it does at the cursor.
 */
function foldSelected(view: EditorView, fold: boolean): boolean {
  const { state } = view;
  const blocks = editorApi.selectedBlocks(state);
  if (blocks.length === 0) return false;
  const keys = new Set(blocks.map((b) => b.key));
  const effects: StateEffect<{ from: number; to: number }>[] = [];
  for (const f of foldsOf(state)) {
    if (!keys.has(f.key)) continue;
    const r = hidden(state, f);
    if (fold !== isFolded(state, r)) effects.push(fold ? foldEffect.of(r) : unfoldEffect.of(r));
  }
  if (effects.length > 0) view.dispatch({ effects, ...editorApi.selectBlocks(state, blocks[0]!, blocks[blocks.length - 1]) });
  return true;
}

/** Folds the block around the cursor; pressed again, the block around that. */
function foldHere(view: EditorView): boolean {
  if (foldSelected(view, true)) return true;
  const { state } = view;
  const folds = foldsOf(state);
  for (let skip = 0; ; skip++) {
    const f = foldAround(folds, headLine(state), skip);
    if (!f) return false;
    const r = hidden(state, f);
    if (isFolded(state, r)) continue;
    dispatchFold(view, [foldEffect.of(r)], [r]);
    return true;
  }
}

/** Opens the folded block at the cursor. */
function unfoldHere(view: EditorView): boolean {
  if (foldSelected(view, false)) return true;
  const { state } = view;
  const folds = foldsOf(state);
  for (let skip = 0; ; skip++) {
    const f = foldAround(folds, headLine(state), skip);
    if (!f) return false;
    const r = hidden(state, f);
    if (!isFolded(state, r)) continue;
    view.dispatch({ effects: unfoldEffect.of(r), scrollIntoView: true });
    return true;
  }
}

/** Shows the outline down to `level` (1 is the top lines only), or all of it for null. */
export function foldToLevel(view: EditorView, level: number | null): void {
  const { state } = view;
  const effects: StateEffect<{ from: number; to: number }>[] = [];
  const covered: { from: number; to: number }[] = [];
  for (const f of foldsOf(state)) {
    const r = hidden(state, f);
    const want = level !== null && f.depth >= level - 1;
    if (want) covered.push(r);
    if (want && !isFolded(state, r)) effects.push(foldEffect.of(r));
    else if (!want && isFolded(state, r)) effects.push(unfoldEffect.of(r));
  }
  if (effects.length > 0) dispatchFold(view, effects, covered);
}

class Chevron extends WidgetType {
  constructor(readonly folded: boolean) {
    super();
  }
  override eq(other: Chevron): boolean {
    return other.folded === this.folded;
  }
  override toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement("span");
    dom.className = `cm-foldmark${this.folded ? " folded" : ""}`;
    dom.setAttribute("aria-hidden", "true");
    dom.title = this.folded ? "Unfold" : "Fold";
    dom.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const line = view.state.doc.lineAt(view.posAtDOM(dom)).number - 1;
      const f = foldsOf(view.state).find((x) => x.line === line);
      if (!f) return;
      const r = hidden(view.state, f);
      view.dispatch({ effects: isFolded(view.state, r) ? unfoldEffect.of(r) : foldEffect.of(r) });
    });
    return dom;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

/** The chevrons of the folds whose line is in the viewport. */
export function chevronDecorations(state: EditorState, viewport: { from: number; to: number }): DecorationSet {
  const marks: Range<Decoration>[] = [];
  for (const f of foldsOf(state)) {
    const line = state.doc.line(f.line + 1);
    if (line.to < viewport.from || line.from > viewport.to) continue;
    marks.push(Decoration.widget({ widget: new Chevron(isFolded(state, hidden(state, f))), side: -1 }).range(line.from));
  }
  return Decoration.set(marks);
}

/** A chevron before each line that can fold, shown on hover and always on one that is folded. */
const chevrons = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = chevronDecorations(view.state, view.viewport);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state) || foldedRanges(update.startState) !== foldedRanges(update.state)) {
        this.decorations = chevronDecorations(update.state, update.view.viewport);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

const placeholder = codeFolding({
  preparePlaceholder: (state, range) => state.doc.lineAt(range.to).number - state.doc.lineAt(range.from).number,
  placeholderDOM(_view, onclick, count: number) {
    const dom = document.createElement("span");
    dom.className = "cm-foldchip";
    dom.textContent = `… ${count} ${count === 1 ? "line" : "lines"}`;
    dom.title = "Unfold";
    dom.addEventListener("click", onclick);
    return dom;
  },
});

// ---- zoom --------------------------------------------------------------------------

const zoomEffect = StateEffect.define<{ from: number; to: number } | null>();

interface ZoomState {
  from: number;
  to: number;
  deco: DecorationSet;
}

class Trail extends WidgetType {
  constructor(readonly crumbs: Crumb[]) {
    super();
  }
  override eq(other: Trail): boolean {
    return other.crumbs.length === this.crumbs.length && other.crumbs.every((c, i) => c.line === this.crumbs[i]!.line && c.text === this.crumbs[i]!.text);
  }
  override toDOM(view: EditorView): HTMLElement {
    const nav = document.createElement("nav");
    nav.className = "cm-zoomtrail";
    nav.setAttribute("aria-label", "Zoomed in. The way back");
    const crumb = (text: string, go: () => void): void => {
      if (nav.childNodes.length > 0) nav.append(" › ");
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        go();
        view.focus();
      });
      nav.append(b);
    };
    crumb("Page", () => view.dispatch({ effects: zoomEffect.of(null) }));
    for (const c of this.crumbs) crumb(c.text || "…", () => zoomToLine(view, c.line));
    return nav;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

class End extends WidgetType {
  override toDOM(): HTMLElement {
    const dom = document.createElement("div");
    dom.className = "cm-zoomend";
    return dom;
  }
  override eq(): boolean {
    return true;
  }
}

function zoomState(state: EditorState, from: number, to: number): ZoomState {
  const trail = zoomAt(modelOf(state), state.doc.lineAt(from).number - 1)?.trail ?? [];
  const widget = new Trail(trail);
  const marks: Range<Decoration>[] = [];
  // Everything before the block is replaced by the trail, everything after it by nothing.
  if (from > 1) marks.push(Decoration.replace({ widget, block: true }).range(0, from - 1));
  else marks.push(Decoration.widget({ widget, block: true, side: -1 }).range(0));
  if (to < state.doc.length) marks.push(Decoration.replace({ widget: new End(), block: true }).range(to, state.doc.length));
  return { from, to, deco: Decoration.set(marks) };
}

const zoomField = StateField.define<ZoomState | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(zoomEffect)) return e.value ? zoomState(tr.state, e.value.from, e.value.to) : null;
    }
    if (!value || !tr.docChanged) return value;
    // Another page, or the same one read again: back to the whole of it.
    if (isReplacement(tr)) return null;
    // What is typed at either edge belongs to the block.
    const from = tr.changes.mapPos(value.from, -1);
    const to = tr.changes.mapPos(value.to, 1);
    return from <= to ? zoomState(tr.state, from, to) : null;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (z) => z?.deco ?? Decoration.none),
    EditorView.atomicRanges.of((view) => view.state.field(f)?.deco ?? Decoration.none),
  ],
});

function zoomToLine(view: EditorView, line: number): void {
  const { state } = view;
  const found = zoomAt(modelOf(state), line);
  if (!found) return;
  const from = state.doc.line(found.start + 1).from;
  const to = state.doc.line(found.end + 1).to;
  const head = state.selection.main.head;
  view.dispatch({
    effects: zoomEffect.of({ from, to }),
    selection: head >= from && head <= to ? undefined : { anchor: from },
    scrollIntoView: true,
  });
}

/** Shows only the block at the cursor and what it owns. */
export function zoomIn(view: EditorView): boolean {
  const { state } = view;
  const found = zoomAt(modelOf(state), headLine(state));
  if (!found) return false;
  const z = state.field(zoomField);
  const from = state.doc.line(found.start + 1).from;
  if (z && z.from === from) return true;
  zoomToLine(view, found.start);
  return true;
}

/** Goes one level back: to the block around the one shown, or to the page. */
export function zoomOut(view: EditorView): boolean {
  const z = view.state.field(zoomField);
  if (!z) return false;
  const found = zoomAt(modelOf(view.state), view.state.doc.lineAt(z.from).number - 1);
  const parent = found?.trail[found.trail.length - 1];
  if (parent) zoomToLine(view, parent.line);
  else view.dispatch({ effects: zoomEffect.of(null), scrollIntoView: true });
  return true;
}

/** Text outside the zoomed block is out of reach, so an edit that touches it is not made. */
const guard = EditorState.transactionFilter.of((tr) => {
  const z = tr.startState.field(zoomField);
  if (!z || !tr.docChanged) return tr;
  const event = tr.annotation(Transaction.userEvent);
  if (event === undefined || event === "undo" || event === "redo") return tr;
  let outside = false;
  tr.changes.iterChangedRanges((from, to) => {
    if (from < z.from || to > z.to) outside = true;
  });
  return outside ? [] : tr;
});

function selectZoomed(view: EditorView): boolean {
  const z = view.state.field(zoomField);
  if (!z) return false;
  view.dispatch({ selection: { anchor: z.from, head: z.to } });
  return true;
}

/** Everything the fold mod adds to the editor of the page at `path`. */
export function folding(path: string, store: FoldStore, pageOf: PageOf, editor: EditorApi): Extension {
  page = pageOf;
  editorApi = editor;
  return [
    placeholder,
    // Block selection does not go to blocks that the zoom hides, as it does not to those in a fold.
    editor.hidden((state) => {
      const z = state.field(zoomField, false);
      return z ? [{ from: 1, to: state.doc.lineAt(z.from).number - 1 }, { from: state.doc.lineAt(z.to).number + 1, to: state.doc.lines }] : [];
    }),
    chevrons,
    // Above the page's other block widgets (the properties), which the zoom has to cover.
    Prec.highest(zoomField),
    guard,
    restoring(path, store),
    remembering(path, store),
    Prec.high(
      keymap.of([
        { key: "Mod-ArrowUp", run: foldHere },
        { key: "Mod-ArrowDown", run: unfoldHere },
        { key: "Mod-Alt-ArrowRight", run: zoomIn },
        { key: "Mod-Alt-ArrowLeft", run: zoomOut },
        { key: "Mod-a", run: selectZoomed },
      ]),
    ),
  ];
}
