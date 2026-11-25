// Select mode: after Escape the selected blocks stay selected as blocks. They are drawn as
// Markdown, like any block without the cursor, and the keys act on blocks (see blockKeys.ts).
// Anything that moves the selection or changes the text any other way, a click above all,
// goes back to editing.

import { StateEffect, StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** Put this on the transaction that selects blocks, so the editor knows it is select mode. */
export const enterSelectMode = StateEffect.define<null>();

export const selectMode = StateField.define<boolean>({
  create: () => false,
  update: (on, tr) => tr.effects.some((e) => e.is(enterSelectMode)) || (on && !tr.docChanged && tr.selection === undefined),
  // The editor wears a class while it is on, so that the caret can hide: the blocks are what is selected.
  provide: (f) => EditorView.editorAttributes.from(f, (on) => (on ? { class: "cm-select-mode" } : { class: "" })),
});
