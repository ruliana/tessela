// The fold mod: fold and zoom in the editor. Ctrl+Up folds the block at the cursor, Ctrl+Down opens
// it, Ctrl+Alt+Right zooms in on a block and Ctrl+Alt+Left zooms out; the palette folds the page to
// a level. A fold is the window's, not the page's: it is kept in this mod's settings, by page and by
// block key, and nothing is written to the notes.

import type { EditorView } from "@codemirror/view";

import type { CommandArg } from "../../shared/mods";
import type { ModContext } from "../../renderer/mods";
import { type FoldStore, foldToLevel, folding, zoomIn, zoomOut } from "./folding";

/** Pages remembered at most, the least recently folded going first. */
const PAGES = 300;

function storeIn(settings: ModContext["settings"]): FoldStore {
  const all = (): Record<string, string[]> => {
    const saved = settings.get("folds");
    return saved && typeof saved === "object" && !Array.isArray(saved) ? (saved as Record<string, string[]>) : {};
  };
  return {
    read(path) {
      const keys = all()[path];
      return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : [];
    },
    write(path, keys) {
      const folds = all();
      delete folds[path];
      if (keys.length > 0) folds[path] = keys;
      for (const old of Object.keys(folds).slice(0, Math.max(0, Object.keys(folds).length - PAGES))) delete folds[old];
      settings.set("folds", folds);
    },
  };
}

export default function (ctx: ModContext): void {
  ctx.editor.extend(({ path }) => folding(path, storeIn(ctx.settings)));

  const mac = navigator.userAgent.includes("Mac");
  const mod = mac ? "⌘" : "Ctrl";
  const on = (act: (view: EditorView) => unknown) => ({ view }: CommandArg<EditorView>) => {
    if (view) act(view);
  };
  for (const level of [1, 2, 3]) {
    ctx.commands.add({ id: `fold-${level}`, label: `Fold the page to level ${level}`, run: on((v) => foldToLevel(v, level)) });
  }
  ctx.commands.add({ id: "unfold-all", label: "Unfold the whole page", run: on((v) => foldToLevel(v, null)) });
  ctx.commands.add({ id: "zoom-in", label: "Zoom in on the current block", hint: `${mod} Alt →`, run: on(zoomIn) });
  ctx.commands.add({ id: "zoom-out", label: "Zoom out", hint: `${mod} Alt ←`, run: on(zoomOut) });
}
