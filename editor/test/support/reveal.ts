// An editor state as the live preview sees it, without a window: the page language and model, the
// reveal policy, and the facts it reads (focus, select mode, whether the Markdown is drawn).

import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";

import type { PreviewOptions } from "../../src/renderer/livePreview";
import { pageLanguage, pageModel } from "../../src/renderer/pageModelField";
import { focusEffect, rendered, revealPolicy } from "../../src/renderer/reveal";
import { selectModeState, selectionSpec } from "../../src/renderer/selectMode";
import { widenBlock } from "../../src/shared/blockSelection";

export interface Where {
  /** The cursor, or the start of the selection. Defaults to the start of the page. */
  at?: number;
  /** The end of the selection. */
  to?: number;
  /** The editor has the keyboard focus. Defaults to true. */
  focused?: boolean;
  /** Blocks are selected (select mode). */
  selecting?: boolean;
  /** The Markdown is drawn at all (live preview is on). Defaults to true. */
  preview?: boolean;
  extensions?: Extension[];
}

export function revealState(doc: string, where: Where = {}): EditorState {
  const { at = 0, to = at, focused = true, selecting = false, preview = true, extensions = [] } = where;
  let state = EditorState.create({
    doc,
    selection: EditorSelection.single(at, to),
    extensions: [pageLanguage(), pageModel, revealPolicy(), selectModeState, preview ? rendered.of(true) : [], ...extensions],
  });
  if (focused) state = state.update({ effects: focusEffect(true) }).state;
  if (selecting) {
    // The block at the selection (the first block of the page when it is in none) is selected.
    const found = widenBlock(state.field(pageModel), { from: at, to }) ?? widenBlock(state.field(pageModel), { from: 0, to: 0 });
    if (found) state = state.update(selectionSpec(state, found)).state;
  }
  return state;
}

export const previewOptions: PreviewOptions = {
  openLink: () => {},
  imageUrl: () => null,
  pageName: () => "Page",
  pagePath: () => "page.md",
  properties: () => undefined,
  view: () => null,
};

/** What a decoration set holds, in order: `from-to kind`, with the widget's class name or the mark's class. */
export function describe(set: DecorationSet): string[] {
  const out: string[] = [];
  const cursor = set.iter();
  for (; cursor.value; cursor.next()) {
    const spec = cursor.value.spec as { widget?: { constructor: { name: string } }; class?: string };
    const kind = spec.widget ? spec.widget.constructor.name : spec.class ? `.${spec.class}` : "hide";
    out.push(`${cursor.from}-${cursor.to} ${kind}`);
  }
  return out;
}

