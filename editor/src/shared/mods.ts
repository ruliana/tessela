// Mods: code that adds to the editor through a `ctx` (commands, keys, `/` menu items and editor
// extensions). This is the registry behind it. It knows nothing of the window, so it is easy to
// test; the window's side is renderer/mods.ts.

import type { ModsInfo } from "./api";
import type { Properties } from "./properties";
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
  /** A notes folder was opened (or another one chosen): what a mod holds of the old one is stale. */
  "bundle-opened": Record<string, never>;
}

export type ModEventName = keyof ModEvents;

/** An entry a mod adds to the menu in a page's head. */
export interface PageMenuItem {
  label: string;
  run: (page: { path: string }) => unknown;
}

/** What a fence renderer is told: the text between the fence's lines and the page it is in. */
export interface FenceArg {
  body: string;
  path: string;
}

/** Draws a fence's body: the result (text or a DOM node, or a promise of one) is shown under the fence. */
export type FenceRender = (fence: FenceArg) => unknown;

/** What a view is asked to draw: `arg` is what the view was opened with (a folder, say). */
export interface ViewArg {
  arg?: string;
}

/** A view a mod gives: it fills the middle of the window, as the journals do, and has a row in the sidebar. */
export interface ModView {
  /** Names the view for `views.open` and the history. */
  id: string;
  /** The sidebar row's text. */
  label: string;
  /** The sidebar row's tooltip. */
  title?: string;
  /** One character before the label. */
  glyph?: string;
  /** Fills `container`. Called again, on the same container, when the notes change while the view is shown. */
  render: (container: HTMLElement, view: ViewArg) => unknown;
}

/**
 * What a mod puts in the backlinks of a page: a node of its own, drawn above the mentions page by
 * page (`first`) or below them. `taken` are handles of mentions it shows itself, so they are not
 * listed a second time.
 */
export interface BacklinkContent {
  node: unknown;
  first?: boolean;
  taken?: string[];
}

/** Draws a group for the open page, or nothing (null) when the page has none. */
export type BacklinkGroup = (page: { path: string }) => BacklinkContent | null | undefined | Promise<BacklinkContent | null | undefined>;

/** What the window tells a mod that draws the front matter of a page. */
export interface PropertiesArg {
  /** The page the front matter belongs to. */
  path: string;
  /** What the front matter says, read the way the built-in drawing reads it. */
  props: Properties;
  /** The title to draw above the properties, or null when the page's own heading already is one. */
  title: string | null;
  /** The front matter as written, from the opening `---` to the closing one. */
  source: string;
  /** Puts the cursor at the start of the text (a click on the title means "write here"). */
  toBody(): void;
  /** Shows the YAML to edit it. */
  editYaml(): void;
  /** Follows a link as clicking it in the page would (`/journals/2026-10-27.md`). */
  openLink(dest: string): void;
}

/** Draws a page's front matter in place of the built-in title and row of properties. */
export interface PropertiesOverride {
  /** The element to show. It is drawn again, as a new one, whenever the front matter changes. */
  draw(arg: PropertiesArg): HTMLElement;
}

/** What the window asks of a mod that takes the sidebar search over. */
export interface SearchOverride {
  /**
   * Fills `results` for what was typed in the search box. Answer true to have `results` shown, false
   * to hide it. `stale()` turns true once something else has been typed, so a slow answer can stop.
   */
  run(arg: { input: string; results: HTMLElement; stale: () => boolean }): boolean | Promise<boolean>;
  /** The part of what was typed that filters the page names in the sidebar (all of it when left out). */
  names?(input: string): string;
}

/**
 * The built-in contributions a mod can replace, by id (`ctx.override.add(id, replacement)`). A
 * built-in command is replaced by adding a command with its id; these are the ones that are not
 * commands.
 */
export interface ModOverrides {
  /** The search under the sidebar's search box. */
  search: SearchOverride;
  /** The title and properties drawn in place of a page's front matter. */
  properties: PropertiesOverride;
}

export type OverrideId = keyof ModOverrides;

export interface ModFailure {
  mod: string;
  message: string;
}

function slashFrom(item: ModSlash): SlashItem {
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
  private viewById = new Map<string, Owned<ModView>>();
  private backlinkGroups: Owned<{ group: BacklinkGroup }>[] = [];
  private fenceRenders = new Map<string, Owned<{ render: FenceRender }>>();
  private overrides = new Map<OverrideId, Owned<{ replacement: ModOverrides[OverrideId] }>>();
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

  /** A mod's view. One with the id of another replaces it. */
  addView(mod: string, view: ModView): void {
    this.viewById.set(view.id, { ...view, mod });
  }

  view(id: string): Owned<ModView> | undefined {
    return this.viewById.get(id);
  }

  views(): Owned<ModView>[] {
    return [...this.viewById.values()];
  }

  addBacklinkGroup(mod: string, group: BacklinkGroup): void {
    this.backlinkGroups.push({ group, mod });
  }

  /**
   * What the mods put in the backlinks of the page at `path`, in the order they were added. A mod
   * whose group fails is reported, and the others still show.
   */
  async backlinkContent(path: string): Promise<BacklinkContent[]> {
    const made = await Promise.all(
      this.backlinkGroups.map(async (g) => {
        try {
          return (await g.group({ path })) ?? null;
        } catch (e) {
          this.fail(g.mod, `backlinks: ${messageOf(e)}`);
          return null;
        }
      }),
    );
    return made.filter((c): c is BacklinkContent => c !== null);
  }

  /** A mod replaces a built-in contribution (see `ModOverrides`). Of two mods that replace the same one, the one loaded last wins. */
  addOverride<K extends OverrideId>(mod: string, id: K, replacement: ModOverrides[K]): void {
    this.overrides.set(id, { replacement, mod });
  }

  /** The mod that holds the override `id`. */
  overrideOwner(id: OverrideId): string | undefined {
    return this.overrides.get(id)?.mod;
  }

  /** What a mod put in place of the built-in contribution `id`, if one did. */
  override<K extends OverrideId>(id: K): ModOverrides[K] | undefined {
    return this.overrides.get(id)?.replacement as ModOverrides[K] | undefined;
  }

  /** A mod draws the code fences whose info string is `info`. Another mod's renderer for it is replaced. */
  addFence(mod: string, info: string, render: FenceRender): void {
    this.fenceRenders.set(info, { render, mod });
  }

  /** The renderer for the fences named `info`, if a mod gave one. */
  fenceRenderer(info: string): FenceRender | undefined {
    return this.fenceRenders.get(info)?.render;
  }

  hasFences(): boolean {
    return this.fenceRenders.size > 0;
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
    for (const [id, v] of this.viewById) if (v.mod === mod) this.viewById.delete(id);
    this.backlinkGroups = this.backlinkGroups.filter((g) => g.mod !== mod);
    for (const [info, f] of this.fenceRenders) if (f.mod === mod) this.fenceRenders.delete(info);
    for (const [id, o] of this.overrides) if (o.mod === mod) this.overrides.delete(id);
  }

  fail(mod: string, message: string): void {
    const failure = { mod, message };
    this.failures.push(failure);
    this.onFailure(failure);
  }
}

/** What the Mods panel shows of one mod. */
export interface ModRow {
  id: string;
  source: "app" | "config";
  /** `failed` when it threw while loading (then it is not running), `off` when switched off in settings.json. */
  status: "loaded" | "failed" | "off";
  /** What went wrong, loading or since: each is a line. */
  errors: string[];
}

/** The mods with whether each loaded, failed or is off, and the failures that were reported for it. */
export function modRows(info: ModsInfo, loaded: string[], failures: ModFailure[]): ModRow[] {
  return info.mods.map((m) => ({
    id: m.id,
    source: m.source,
    status: m.off ? "off" : loaded.includes(m.id) ? "loaded" : "failed",
    errors: failures.filter((f) => f.mod === m.id).map((f) => f.message),
  }));
}
