// The reveal policy: the one rule that decides whether Markdown is shown as typed or drawn. Live
// preview, the tables and the front matter header, the gfm-extras mod and the link clicks all ask
// it, so they cannot disagree (see `editor/ARCHITECTURE.md`, principle 4):
//
//   - Only the exact construct under the cursor is shown as typed: a bold span, a link, a
//     footnote reference, a callout title, the marks of a heading or a list item.
//   - A block widget (a table, a `$$` block, the front matter) opens as a whole when the cursor is
//     inside it.
//   - Everything else stays drawn, including the rest of the block that is being edited.
//   - In select mode nothing is shown as typed: blocks are selected, not edited.
//   - An editor without the keyboard focus draws everything.
//
// "Under the cursor" means a selection range touches the construct, its ends included: a cursor
// right after `**bold**` is still in it.
//
// The facts it needs are kept in one place each: the focus here (`editorFocus`), the mode in
// `blockSelection` (selectMode.ts) and whether the Markdown is drawn at all in the `rendered` facet that live preview
// provides. Nobody else keeps a copy, and nobody reads a CSS class to find them out.

import { type EditorState, type Extension, Facet, StateEffect, StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { blockSelection } from "./selectMode";

/** A piece of the page, `from` to `to` (both ends count as touching). */
export interface Span {
  from: number;
  to: number;
}

const focusChanged = StateEffect.define<boolean>();

/** Whether the editor has the keyboard focus: the only place that is kept. */
export const editorFocus = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) => tr.effects.reduce((v, e) => (e.is(focusChanged) ? e.value : v), value),
});

/** Whether the Markdown is drawn at all (live preview is on). Live preview provides `true`. */
export const rendered = Facet.define<boolean, boolean>({ combine: (values) => values.some(Boolean) });

/** What the editor needs from the policy: keeps `editorFocus` up to date. Part of every editor. */
export function revealPolicy(): Extension {
  return [editorFocus, EditorView.focusChangeEffect.of((_state, focusing) => focusChanged.of(focusing))];
}

/** Sets the focus without a view, for a test. */
export const focusEffect = (focused: boolean) => focusChanged.of(focused);

/** Whether the Markdown is drawn rather than typed in this editor at all (live preview is on). */
export function isRendered(state: EditorState): boolean {
  return state.facet(rendered);
}

/**
 * Whether the person is editing `span`: the editor has the focus, no blocks are selected and a
 * selection range touches it. What is being edited shows as typed; what is not shows drawn.
 */
export function isEditing(state: EditorState, span: Span): boolean {
  if (!state.field(editorFocus, false) || state.field(blockSelection, false)) return false;
  return state.selection.ranges.some((r) => r.from <= span.to && r.to >= span.from);
}

/** Whether `span` is shown drawn: the Markdown is rendered at all, and the cursor is not in it. */
export function isDrawn(state: EditorState, span: Span): boolean {
  return isRendered(state) && !isEditing(state, span);
}

/**
 * Whether what is shown as typed may differ between two states: the selection, the focus, the mode
 * or the preview is not the same. A change of the text is for the caller to check, as it also moves
 * the syntax tree.
 */
export function revealChanged(before: EditorState, after: EditorState): boolean {
  return (
    !before.selection.eq(after.selection) ||
    before.field(editorFocus, false) !== after.field(editorFocus, false) ||
    before.field(blockSelection, false) !== after.field(blockSelection, false) ||
    isRendered(before) !== isRendered(after)
  );
}
