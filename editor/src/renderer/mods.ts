// The window's side of mods: loads them from the config folder and gives each a `ctx`.
// A mod is `export default function (ctx) { ... }` in mods/<id>/main.js. Mods are trusted code
// (the owner's own or audited). The one rule kept is that notes change only through `ctx.cli`.

import * as autocomplete from "@codemirror/autocomplete";
import * as commands from "@codemirror/commands";
import * as language from "@codemirror/language";
import * as state from "@codemirror/state";
import { type Extension, Prec } from "@codemirror/state";
import * as view from "@codemirror/view";
import { type EditorView, keymap } from "@codemirror/view";

import { makeSelection } from "../shared/blockSelection";
import type { PageModel, PageNode } from "../shared/pageModel";

import type { ModsInfo } from "../shared/api";
import type { JevRequest, JevResult } from "../shared/jev";
import { type BacklinkContent, type CommandArg, type FenceArg, type ModCommand, type ModEventName, type ModEvents, type ModOverrides, type ModSlash, type ModView, type PageMenuItem, ModRegistry } from "../shared/mods";
import type { Card } from "./card";
import { type Dialog, type DialogOptions, openDialog } from "./dialog";
import { drawer } from "./drawer";
import { el } from "./dom";
import { fenceExtension, refreshFences } from "./fences";
import { pageModel } from "./pageModelField";
import { type Span, isEditing, isRendered, revealChanged } from "./reveal";
import { type HiddenLines, coversRange, hiddenLines, selectedBlocks, selectionSpec } from "./selectMode";

/** An extension a mod gives for each editor, told which page the editor shows. */
export type PageExtension = (page: { path: string }) => Extension;

export const registry = new ModRegistry<EditorView, Extension | PageExtension>();

/** The place at the top of the right column that mods draw in (`slots.mount("side-top")`). It outlives the window's shell. */
export const sideTop = el("div", { class: "side-top", id: "side-top" });

/** The place below the backlinks that mods draw in (`slots.mount("side-bottom")`). It outlives the window's shell. */
export const sideBottom = el("div", { class: "side-bottom", id: "side-bottom" });

/** The place in the sidebar that mods draw in (`slots.mount("sidebar")`). It outlives the window's shell. */
export const sidebarSlot = el("div", { class: "side-mods", id: "side-mods" });

/** What the mods loaded, or why none did: nothing when the window has not asked yet. */
export let modsInfo: ModsInfo | null = null;

const cm = { state, view, language, commands, autocomplete };
// The mods that come with the app are built against these same packages (scripts/build-mods.mjs),
// so what they create (fields, widgets) is made of the editor's own classes.
(globalThis as { __tesselaCm?: typeof cm }).__tesselaCm = cm;

/** What the window lends mods (set by main.ts): the parts of the window a mod may ask for. */
export interface ModHost {
  /** Says something in the sidebar's notice, with a button when there is an `action`. */
  toast(text: string, action?: { label: string; run: () => void }): void;
  /** The page being worked on, or null when none is. */
  current(): string | null;
  /** Saves what the open pages have not saved yet. */
  flush(): Promise<void>;
  /** A page changed place (`to`) or was deleted (`to` null): the window follows it. */
  moved(from: string, to: string | null): Promise<void>;
  /** Shows a page in the window, at `line` when given. */
  open(path: string, line?: number): Promise<void>;
  /** A card for a page that is not one of the window's own: it saves, follows the disk and is flushed like them. */
  card(path: string, options?: { menu?: boolean }): Card;
  /** Makes the right column visible. */
  reveal(): void;
  /** Puts `text` in the page being worked on, at the cursor; false when there is no page to put it in. */
  insert(text: string, options?: { block?: boolean }): boolean;
  /** Shows a mod's view in the middle of the window. */
  showView(id: string, arg?: string): Promise<void>;
}

export const host: ModHost = {
  toast: () => {},
  current: () => null,
  flush: async () => {},
  moved: async () => {},
  open: async () => {},
  card: () => {
    throw new Error("The window has no cards yet");
  },
  reveal: () => {},
  insert: () => false,
  showView: async () => {},
};

/** A page open for editing, as a mod gets it: put `root` somewhere, `load` it, `destroy` it when done. */
export type PageCard = Pick<Card, "root" | "path" | "view" | "load" | "flush" | "focus" | "destroy">;

// Whatever a fence's renderer shows may come from other pages: ask again when the notes change.
registry.on("fences", "changed", () => refreshFences());
registry.on("fences", "page-saved", () => refreshFences());

function settingsOf(mod: string) {
  const key = `tessela.mod.${mod}`;
  const read = (): Record<string, unknown> => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
      return saved && typeof saved === "object" ? (saved as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  return {
    get: (name: string): unknown => read()[name],
    set(name: string, value: unknown): void {
      try {
        localStorage.setItem(key, JSON.stringify({ ...read(), [name]: value }));
      } catch {
        // Settings are a convenience.
      }
    },
  };
}

/** What a mod is handed. */
export interface ModContext {
  readonly id: string;
  commands: {
    add(command: ModCommand<EditorView>): void;
    /** Runs the command with this id (a mod's, such as `peek.page`), told `arg`; false when there is none. */
    run(id: string, arg?: CommandArg<EditorView>): boolean;
  };
  slash: { add(item: ModSlash): void };
  /**
   * The editor, for extensions that draw the page. `extend` adds an extension to every editor; a
   * function is called for each, with the page the editor shows. The rest is the reveal policy, the
   * one rule that says whether Markdown is shown as typed or drawn: ask it, and read neither the
   * focus nor a CSS class. Only the exact construct under the cursor is typed; a block widget opens
   * as a whole when the cursor is inside it; in select mode nothing is typed.
   * - `isEditing(state, range)`: the cursor is in `range`, so the Markdown there shows as typed.
   * - `rendered(state)`: the window shows the Markdown drawn at all (live preview is on).
   * - `revealChanged(before, after)`: what is typed may differ between two states (the selection, the
   *   focus, the mode or the preview changed): decorations are made again when it is true, or the text changed.
   *
   * Select mode (blocks selected as blocks) is a value in the state, not a CSS class:
   * - `selectedBlocks(state)`: the selected blocks as nodes of `ctx.page(state)`, in page order (a selected
   *   block includes the blocks it owns), or none while the person is editing.
   * - `isSelected(state, range)`: `range` lies in the selected blocks: a widget that stands in for a block
   *   wears the class `cm-block-selected` then (the editor draws the lines of the blocks itself).
   * - `selectBlocks(state, anchor, head?)`: the part of a transaction that selects the run of blocks from
   *   `anchor` to `head` (both nodes of `ctx.page(state)`); merge it into the `dispatch` of a command that
   *   keeps the blocks selected. Anything else that sets the selection or the text ends select mode.
   * - `hidden(provide)`: an extension that says which lines (1-based, `{ from, to }`) the mod hides, as the
   *   fold mod's zoom does; block selection does not step to or widen to a block that starts on one.
   */
  editor: {
    extend(extension: Extension | PageExtension): void;
    isEditing(state: state.EditorState, range: Span): boolean;
    rendered(state: state.EditorState): boolean;
    revealChanged(before: state.EditorState, after: state.EditorState): boolean;
    selectedBlocks(state: state.EditorState): PageNode[];
    isSelected(state: state.EditorState, range: Span): boolean;
    selectBlocks(state: state.EditorState, anchor: PageNode, head?: PageNode): state.TransactionSpec;
    hidden(provide: (state: state.EditorState) => readonly HiddenLines[]): Extension;
  };
  /**
   * The structure of the page in `state`: sections, blocks and their children, as the editor reads
   * them (see `shared/pageModel.ts`). Read it instead of scanning the text for lines.
   */
  page(state: state.EditorState): PageModel;
  settings: { get(name: string): unknown; set(name: string, value: unknown): void };
  /** Runs a tessela command on the open notes folder and returns its `{api, ok, ...}` JSON (see Api.cli). */
  cli(argv: string[], options?: { input?: string | Uint8Array }): Promise<unknown>;
  /**
   * Jev, TypeSafe AI's decision model: typed questions about one `state`, answered with probabilities.
   * `on` is false unless the config folder's settings.json has a key or a `baseUrl` (`{"jev": {"key": "..."}}`;
   * a proxy that holds the key needs only `baseUrl`; `model` is optional): a mod that needs Jev does nothing at all then, with no fallback. The key stays
   * in the main process. `ask` fails with `{ ok: false, error }` instead of throwing, and stops when `signal` aborts.
   */
  jev: { on: boolean; ask(request: JevRequest, options?: { signal?: AbortSignal }): Promise<JevResult> };
  /** Parts of the window every mod looks alike with. */
  ui: {
    dialog(options: DialogOptions): Dialog;
    toast(text: string, action?: { label: string; run: () => void }): void;
    /**
     * A drawer for the sidebar (put `root` in `slots.mount("sidebar")`): a head that folds it away
     * with a click or the keyboard, and a `body` to fill. Whether it is folded is remembered by the
     * window under the mod's id and `id`, so the mod does nothing about it.
     */
    drawer(options: { id: string; title: string; aside?: Node }): { root: HTMLElement; body: HTMLElement };
  };
  /** What happens in the window; `on` returns the way to stop listening. */
  events: { on<N extends ModEventName>(name: N, listener: (payload: ModEvents[N]) => unknown): () => void };
  /** Code fences drawn by a mod: under each closed fence whose info string is `info`, the editor shows what `render` gives for its body (a DOM node or text, or a promise of one). Nothing is written to the page. */
  fences: { add(info: string, render: (fence: FenceArg) => Node | string | Promise<Node | string>): void };
  /**
   * Named places in the window. `add("page-menu", ...)` puts an entry in the menu in a page's head.
   * `mount("side-top")` gives the element at the top of the right column, above the backlinks, and
   * `mount("side-bottom")` the one below them (empty, neither is drawn); `reveal` opens the column
   * if it was folded away. `mount("sidebar")` gives
   * the element in the sidebar, under the places and above the recent pages (empty, it is not drawn;
   * its `reveal` does nothing).
   */
  slots: {
    add(slot: "page-menu", item: PageMenuItem): void;
    mount(slot: "side-top" | "side-bottom" | "sidebar"): { root: HTMLElement; reveal(): void };
  };
  /** Groups in the right-hand backlinks of the open page: `first` puts one above the mentions, and `taken` (handles) keeps those mentions from being listed twice. */
  backlinks: { add(group: (page: { path: string }) => BacklinkContent | null | undefined | Promise<BacklinkContent | null | undefined>): void };
  /**
   * Replaces a built-in contribution by its id, as `ModOverrides` lists them (today the sidebar
   * `search`). A mod's command with the id of a built-in one replaces that command in the same way.
   */
  override: { add<K extends keyof ModOverrides>(id: K, replacement: ModOverrides[K]): void };
  /** The pages in the window. */
  pages: {
    current(): string | null;
    /** Puts `text` in the page being worked on, at the cursor; false when no page is open. With `block`, `text` starts a line of its own. */
    insert(text: string, options?: { block?: boolean }): boolean;
    flush(): Promise<void>;
    /** After `rename`, `move` or `remove` through `cli`: the window follows the page (`to` null: it is gone). */
    moved(from: string, to: string | null): Promise<void>;
    /** Shows a page (at `line` when given), as clicking a link to it would. */
    open(path: string, line?: number): Promise<void>;
    /** A card for a page beside the window's own, to put in a slot; `menu: false` leaves out the page menu. */
    card(path: string, options?: { menu?: boolean }): PageCard;
  };
  /** Views of a mod's own: each has a row in the sidebar and fills the middle of the window, as the journals do. */
  views: {
    add(view: ModView): void;
    /** Shows the view, handing it `arg`; going back in the window returns to what was shown before. */
    open(id: string, arg?: string): Promise<void>;
  };
  /** The notes folder, or null while none is open. */
  bundle(): Promise<string | null>;
  /** The CodeMirror packages the editor uses, so a mod does not bundle its own copy. */
  cm: typeof cm;
}

let jevCalls = 0;

/** One call to Jev through the main process; aborting `signal` stops it there too. */
async function askJev(api: Window["tessela"], request: JevRequest, signal?: AbortSignal): Promise<JevResult> {
  if (signal?.aborted) return { ok: false, error: "cancelled" };
  const id = ++jevCalls;
  const stop = () => void api.jevCancel(id);
  signal?.addEventListener("abort", stop, { once: true });
  try {
    return await api.jev(id, request);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

function contextFor(mod: string): ModContext {
  const api = window.tessela;
  return {
    id: mod,
    commands: { add: (command) => registry.addCommand(mod, command), run: (id, arg = {}) => registry.runById(id, arg) },
    slash: { add: (item) => registry.addSlash(mod, item) },
    editor: {
      extend: (extension) => registry.addExtension(mod, extension),
      isEditing,
      rendered: isRendered,
      revealChanged,
      selectedBlocks,
      isSelected: (editorState, range) => coversRange(editorState, range.from, range.to),
      selectBlocks: (editorState, anchor, head = anchor) => {
        const sel = makeSelection(anchor, head);
        return sel ? selectionSpec(editorState, sel) : {};
      },
      hidden: (provide) => hiddenLines.of(provide),
    },
    page: (editorState) => editorState.field(pageModel),
    settings: settingsOf(mod),
    ui: {
      dialog: (options) => openDialog(options),
      toast: (text, action) => host.toast(text, action),
      drawer: ({ id, title, aside }) => drawer(`${mod}:${id}`, title, aside),
    },
    events: { on: (name, listener) => registry.on(mod, name, listener) },
    fences: { add: (info, render) => registry.addFence(mod, info, render) },
    slots: {
      add: (_slot, item) => registry.addPageMenuItem(mod, item),
      mount: (slot) =>
        slot === "sidebar"
          ? { root: sidebarSlot, reveal: () => {} }
          : { root: slot === "side-bottom" ? sideBottom : sideTop, reveal: () => host.reveal() },
    },
    backlinks: { add: (group) => registry.addBacklinkGroup(mod, group) },
    override: { add: (id, replacement) => registry.addOverride(mod, id, replacement) },
    pages: {
      current: () => host.current(),
      insert: (text, options) => host.insert(text, options),
      flush: () => host.flush(),
      moved: (from, to) => host.moved(from, to),
      open: (path, line) => host.open(path, line),
      card: (path, options) => host.card(path, options),
    },
    cli: (argv, options) => api.cli(argv, options?.input),
    jev: { on: modsInfo?.jev === true, ask: (request, options) => askJev(api, request, options?.signal) },
    views: { add: (view) => registry.addView(mod, view), open: (id, arg) => host.showView(id, arg) },
    bundle: () => api.bundle(),
    cm,
  };
}

/** Loads every mod before the first page opens, so what they add to the editor is in place. */
export async function loadMods(): Promise<void> {
  try {
    modsInfo = await window.tessela.mods();
  } catch (e) {
    registry.fail("mods", String(e));
    return;
  }
  for (const id of modsInfo.ids) {
    await registry.load(id, async () => {
      const module = (await import(/* @vite-ignore */ `tessela-mod://mods/${id}/main.js`)) as { default?: unknown };
      if (typeof module.default !== "function") throw new Error("main.js must export a function by default");
      await (module.default as (ctx: ModContext) => unknown)(contextFor(id));
    });
  }
}

/** The extensions every editor gets from mods: the keys of their commands, then what they added. */
export function modExtensions(path: string): Extension[] {
  const keys = registry.keyed().map((c) => ({
    key: c.keys as string,
    run: (v: EditorView) => {
      registry.run(c, { view: v });
      return true;
    },
  }));
  const own = registry.hasFences() ? [fenceExtension(path, (info) => registry.fenceRenderer(info))] : [];
  return [Prec.high(keymap.of(keys)), ...own, ...registry.editorExtensions().map((e) => (typeof e === "function" ? e({ path }) : e))];
}
