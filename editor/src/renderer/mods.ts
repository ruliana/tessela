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
import { type ModCommand, type ModEventName, type ModEvents, type ModSlash, type PageMenuItem, ModRegistry } from "../shared/mods";
import { type Dialog, type DialogOptions, openDialog } from "./dialog";

export const registry = new ModRegistry<EditorView, Extension>();

/** What the mods loaded, or why none did: nothing when the window has not asked yet. */
export let modsInfo: ModsInfo | null = null;

const cm = { state, view, language, commands, autocomplete };

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
}

export const host: ModHost = { toast: () => {}, current: () => null, flush: async () => {}, moved: async () => {} };

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
  editor: { extend(extension: Extension): void };
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
  /** Named places in the window. `page-menu` is the menu in a page's head. */
  slots: { add(slot: "page-menu", item: PageMenuItem): void };
  /** The pages in the window. */
  pages: {
    current(): string | null;
    flush(): Promise<void>;
    /** After `rename`, `move` or `remove` through `cli`: the window follows the page (`to` null: it is gone). */
    moved(from: string, to: string | null): Promise<void>;
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
    slots: { add: (_slot, item) => registry.addPageMenuItem(mod, item) },
    pages: { current: () => host.current(), flush: () => host.flush(), moved: (from, to) => host.moved(from, to) },
    cli: (argv, options) => api.cli(argv, options?.input),
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
export function modExtensions(): Extension[] {
  const keys = registry.keyed().map((c) => ({
    key: c.keys as string,
    run: (v: EditorView) => {
      registry.run(c, { view: v });
      return true;
    },
  }));
  return [Prec.high(keymap.of(keys)), ...registry.editorExtensions()];
}
