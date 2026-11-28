/// <reference types="vite/client" />
// An editor of the window as a state, without the window: the page language and model, and every
// extension the editor and the built-in mods add, in the order `createEditor` puts them (keep the two
// in step). A state update runs the fields, which is the part of a keystroke that happens in the
// transaction. What a view plugin draws needs a window to run, so each is listed here with the
// function it calls, and a test runs them on a viewport as the window would.

import { history } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import * as cmState from "@codemirror/state";
import { EditorState, type Extension } from "@codemirror/state";
import * as cmView from "@codemirror/view";
import { type DecorationSet, EditorView, drawSelection } from "@codemirror/view";

import { chevronDecorations } from "../../src/mods/fold/folding";
import { textDecorations } from "../../src/mods/gfm-extras/main";
import { blockKeymap } from "../../src/renderer/blockKeys";
import { markDecorations, queryableMarks } from "../../src/renderer/decorations";
import { fenceExtension } from "../../src/renderer/fences";
import { formatting } from "../../src/renderer/formatKeys";
import { stickyHeadings } from "../../src/renderer/headingPath";
import { focusMarks, inlineDecorations, livePreview } from "../../src/renderer/livePreview";
import type { ModContext, PageExtension } from "../../src/renderer/mods";
import { pasting } from "../../src/renderer/paste";
import { pageLanguage, pageModel } from "../../src/renderer/pageModelField";
import { focusEffect, isEditing, isRendered, revealChanged, revealPolicy } from "../../src/renderer/reveal";
import { coversRange, hiddenLines, selectedBlocks } from "../../src/renderer/selectMode";
import { previewOptions } from "./reveal";

export interface Viewport {
  from: number;
  to: number;
}

/** One thing the window draws with a view plugin: from the state and the part of the page on screen, decorations. */
export interface Provider {
  name: string;
  /** `viewport`: the work should be in what is on the screen. `page`: it reads the whole page. */
  scope: "viewport" | "page";
  draw(state: EditorState, viewport: Viewport): DecorationSet;
}

const reveal = { rendered: isRendered, isEditing };

/** What a mod is handed that it can use without a window: the editor's own parts. The rest does nothing. */
function contextFor(id: string, added: (Extension | PageExtension)[]): ModContext {
  const inert: unknown = new Proxy(() => inert, { get: (_t, key) => (key === "then" ? undefined : inert), apply: () => inert });
  const own: Record<string, unknown> = {
    id,
    editor: {
      extend: (extension: Extension | PageExtension) => added.push(extension),
      isEditing,
      rendered: isRendered,
      revealChanged,
      selectedBlocks,
      isSelected: (state: EditorState, range: Viewport) => coversRange(state, range.from, range.to),
      selectBlocks: () => ({}),
      hidden: (provide: Parameters<typeof hiddenLines.of>[0]) => hiddenLines.of(provide),
    },
    page: (state: EditorState) => state.field(pageModel),
    settings: { get: () => undefined, set: () => {} },
    cm: { state: cmState, view: cmView },
  };
  return new Proxy(own, { get: (t, key: string) => (key in t ? t[key] : inert) }) as unknown as ModContext;
}

const MODS = import.meta.glob("../../src/mods/*/main.ts", { eager: true });
const SOURCES = import.meta.glob("../../src/mods/*/main.ts", { eager: true, query: "?raw", import: "default" });

/** What the built-in mods add to the editor of `path`: the main file of each mod that calls `editor.extend` is run as the window runs it. */
function modExtensions(path: string): Extension[] {
  const added: (Extension | PageExtension)[] = [];
  // Some mods listen to the window as they start; the window is not there, and nothing it would tell them happens.
  const inert: unknown = new Proxy(() => inert, { get: (_t, key) => (key === "then" ? undefined : inert), apply: () => inert });
  const globals = globalThis as unknown as Record<string, unknown>;
  const had = { window: globals.window, document: globals.document };
  Object.assign(globals, { window: inert, document: inert });
  try {
    for (const [file, module] of Object.entries(MODS)) {
      if (!/\beditor\.extend\(/.test(String(SOURCES[file]))) continue;
      const main = (module as { default?: unknown }).default;
      if (typeof main !== "function") throw new Error(`${file} does not export a function`);
      void (main as (ctx: ModContext) => unknown)(contextFor(file, added));
    }
  } finally {
    for (const [name, value] of Object.entries(had)) {
      if (value === undefined) delete globals[name];
      else globals[name] = value;
    }
  }
  return added.map((e) => (typeof e === "function" ? e({ path }) : e));
}

/** The editor of a page: its state, and what its view plugins draw. */
export function typingEditor(doc: string): { state: EditorState; providers: Provider[] } {
  const path = "page.md";
  const written = new Set<string>();
  const marks = { pageDir: () => "", written: () => written };
  const extensions: Extension[] = [
    history(),
    drawSelection(),
    EditorView.lineWrapping,
    pageLanguage(),
    pageModel,
    stickyHeadings,
    revealPolicy(),
    queryableMarks(marks),
    focusMarks(),
    livePreview(previewOptions),
    blockKeymap,
    formatting,
    pasting(),
    ...modExtensions(path),
    // The fences that mods draw (live lists, math, diagrams): a widget after each.
    fenceExtension(path, () => () => null),
  ];
  let state = EditorState.create({ doc, extensions });
  // The parser has had its time, as in a window that has been open for a moment.
  ensureSyntaxTree(state, state.doc.length, 10_000);
  state = state.update({ effects: focusEffect(true) }).state;
  const providers: Provider[] = [
    { name: "live preview: inline marks", scope: "viewport", draw: (s, v) => inlineDecorations(s, [v], previewOptions) },
    { name: "tags, links and dates", scope: "viewport", draw: (s, v) => markDecorations(s, [v], marks) },
    { name: "fold chevrons", scope: "viewport", draw: chevronDecorations },
    { name: "gfm-extras: callouts, footnotes, inline math", scope: "viewport", draw: (s, v) => textDecorations(s, reveal, [v]) },
  ];
  return { state, providers };
}
