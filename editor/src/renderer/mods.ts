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

import type { ModsInfo } from "../shared/api";
import { type BacklinkContent, type FenceArg, type ModCommand, type ModEventName, type ModEvents, type ModSlash, type ModView, type PageMenuItem, ModRegistry } from "../shared/mods";
import type { Card } from "./card";
import { type Dialog, type DialogOptions, openDialog } from "./dialog";
import { el } from "./dom";
import { fenceExtension, refreshFences } from "./fences";

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
  commands: { add(command: ModCommand<EditorView>): void };
  slash: { add(item: ModSlash): void };
  /** Extensions for every editor; a function is called for each, with the page the editor shows. */
  editor: { extend(extension: Extension | PageExtension): void };
  settings: { get(name: string): unknown; set(name: string, value: unknown): void };
  /** Runs a tessela command on the open notes folder and returns its `{api, ok, ...}` JSON (see Api.cli). */
  cli(argv: string[], options?: { input?: string | Uint8Array }): Promise<unknown>;
  /** Parts of the window every mod looks alike with. */
  ui: {
    dialog(options: DialogOptions): Dialog;
    toast(text: string, action?: { label: string; run: () => void }): void;
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
  /** The pages in the window. */
  pages: {
    current(): string | null;
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

function contextFor(mod: string): ModContext {
  const api = window.tessela;
  return {
    id: mod,
    commands: { add: (command) => registry.addCommand(mod, command) },
    slash: { add: (item) => registry.addSlash(mod, item) },
    editor: { extend: (extension) => registry.addExtension(mod, extension) },
    settings: settingsOf(mod),
    ui: { dialog: (options) => openDialog(options), toast: (text, action) => host.toast(text, action) },
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
    pages: {
      current: () => host.current(),
      flush: () => host.flush(),
      moved: (from, to) => host.moved(from, to),
      open: (path, line) => host.open(path, line),
      card: (path, options) => host.card(path, options),
    },
    cli: (argv, options) => api.cli(argv, options?.input),
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
