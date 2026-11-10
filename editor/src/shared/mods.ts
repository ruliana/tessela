// Mods: code that adds to the editor through a `ctx` (commands, keys, `/` menu items and editor
// extensions). This is the registry behind it. It knows nothing of the window, so it is easy to
// test; the window's side is renderer/mods.ts.

import type { SlashItem } from "./slash";

/** What a command is run with. `view` is the editor in use, when there is one. */
export interface CommandArg<V = unknown> {
  view?: V;
}

export interface ModCommand<V = unknown> {
  /** A mod's command with the id of a built-in one takes its place. */
  id: string;
  /** What the palette lists. */
  label: string;
  /** The keys that do the same, shown at the right of the palette. */
  hint?: string;
  /** CodeMirror key names ("Mod-Alt-j") that run the command while an editor has the focus. */
  keys?: string;
  run: (arg: CommandArg<V>) => unknown;
}

/** A `/` menu item as a mod gives it; where it can be used defaults to anywhere in a line. */
export interface ModSlash {
  label: string;
  detail?: string;
  text: string;
  cursor?: number;
  where?: "line" | "anywhere";
  suggest?: boolean;
}

/** The names a mod can listen to, with what each is told. */
export interface ModEvents {
  /** A page was loaded into the window. */
  "page-opened": { path: string };
  /** A page's text reached the disk. */
  "page-saved": { path: string };
  /** The page's title (front matter `title:`, else its first `#` heading) changed in a save. */
  "title-edited": { path: string; from: string; to: string };
  /** Pages changed on disk (by an agent, git or the CLI). */
  changed: { paths: string[] };
}

export type ModEventName = keyof ModEvents;

/** An entry a mod adds to the menu in a page's head. */
export interface PageMenuItem {
  label: string;
  run: (page: { path: string }) => unknown;
}

export interface ModFailure {
  mod: string;
  message: string;
}

export function slashFrom(item: ModSlash): SlashItem {
  return {
    label: item.label,
    detail: item.detail ?? item.text,
    text: item.text,
    cursor: item.cursor ?? item.text.length,
    where: item.where ?? "anywhere",
    ...(item.suggest ? { suggest: true } : {}),
  };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type Owned<T> = T & { mod: string };

type Listener = Owned<{ name: ModEventName; fn: (payload: never) => unknown }>;

export class ModRegistry<V = unknown, E = unknown> {
  private readonly commandById = new Map<string, Owned<ModCommand<V>>>();
  private slash: Owned<SlashItem>[] = [];
  private extensions: Owned<{ extension: E }>[] = [];
  private pageMenu: Owned<PageMenuItem>[] = [];
  private listeners: Listener[] = [];
  readonly loaded: string[] = [];
  readonly failures: ModFailure[] = [];
  /** Told about every failure, so the window can say so. */
  onFailure: (failure: ModFailure) => void = () => {};

  addCommand(mod: string, command: ModCommand<V>): void {
    this.commandById.set(command.id, { ...command, mod });
  }

  addSlash(mod: string, item: ModSlash): void {
    this.slash.push({ ...slashFrom(item), mod });
  }

  addExtension(mod: string, extension: E): void {
    this.extensions.push({ extension, mod });
  }

  addPageMenuItem(mod: string, item: PageMenuItem): void {
    this.pageMenu.push({ ...item, mod });
  }

  /** The mods' entries for the menu in a page's head. */
  pageMenuItems(): Owned<PageMenuItem>[] {
    return this.pageMenu;
  }

  /** Listens to an event for a mod. Returns the way to stop. */
  on<N extends ModEventName>(mod: string, name: N, fn: (payload: ModEvents[N]) => unknown): () => void {
    const listener: Listener = { mod, name, fn: fn as (payload: never) => unknown };
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Tells the mods that listen. One that throws is reported and the others still hear it. */
  emit<N extends ModEventName>(name: N, payload: ModEvents[N]): void {
    for (const l of this.listeners.filter((x) => x.name === name)) {
      this.call(l.mod, `on ${name}`, () => (l.fn as (p: ModEvents[N]) => unknown)(payload));
    }
  }

  slashItems(): SlashItem[] {
    return this.slash;
  }

  editorExtensions(): E[] {
    return this.extensions.map((e) => e.extension);
  }

  /** Commands that have keys, for the editor to bind. */
  keyed(): ModCommand<V>[] {
    return [...this.commandById.values()].filter((c) => c.keys);
  }

  /**
   * The built-in commands with the mods' on top: a mod's command replaces the built-in one
   * that has its id, and the others follow.
   */
  commands<T extends { id: string }>(builtin: T[], make: (c: ModCommand<V>) => T): T[] {
    const merged = builtin.map((b) => {
      const mod = this.commandById.get(b.id);
      return mod ? make(mod) : b;
    });
    const known = new Set(builtin.map((b) => b.id));
    return [...merged, ...[...this.commandById.values()].filter((c) => !known.has(c.id)).map(make)];
  }

  /** Runs a mod's command. A command that throws, or whose promise fails, is reported and goes no further. */
  run(command: ModCommand<V>, arg: CommandArg<V>): void {
    this.call((command as Partial<Owned<ModCommand<V>>>).mod ?? "?", command.label, () => command.run(arg));
  }

  /** Runs something a mod gave: a throw, or a promise that fails, is reported as the mod's. */
  call(mod: string, what: string, fn: () => unknown): void {
    const fail = (e: unknown) => this.fail(mod, `${what}: ${messageOf(e)}`);
    try {
      const result = fn();
      if (result instanceof Promise) result.catch(fail);
    } catch (e) {
      fail(e);
    }
  }

  /** Loads one mod. If it fails, what it had already added is taken back and the others go on. */
  async load(mod: string, register: () => unknown): Promise<void> {
    try {
      await register();
      this.loaded.push(mod);
    } catch (e) {
      this.remove(mod);
      this.fail(mod, messageOf(e));
    }
  }

  private remove(mod: string): void {
    for (const [id, c] of this.commandById) if (c.mod === mod) this.commandById.delete(id);
    this.slash = this.slash.filter((s) => s.mod !== mod);
    this.extensions = this.extensions.filter((e) => e.mod !== mod);
    this.pageMenu = this.pageMenu.filter((i) => i.mod !== mod);
    this.listeners = this.listeners.filter((l) => l.mod !== mod);
  }

  fail(mod: string, message: string): void {
    const failure = { mod, message };
    this.failures.push(failure);
    this.onFailure(failure);
  }
}

/** One line for the notice: which mods are loaded and which failed. */
export function describeMods(loaded: string[], failures: ModFailure[], folder: string, disabled: boolean): string {
  if (disabled) return "Mods are switched off (--no-mods).";
  const parts: string[] = [];
  parts.push(loaded.length > 0 ? `Mods loaded: ${loaded.join(", ")}.` : `No mods are loaded. Put one in ${folder}/mods/NAME/main.js.`);
  if (failures.length > 0) parts.push(`Failed: ${failures.map((f) => `${f.mod} (${f.message})`).join("; ")}.`);
  return parts.join(" ");
}
