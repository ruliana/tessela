// A web address pasted on its own stays as typed until its page title is known, then becomes
// `[title](address)`. The address is tracked as a range that moves with the text around it, so
// the upgrade lands on the right words however much was typed in the meantime, and does nothing
// when the address itself was edited or removed.

import { isolateHistory } from "@codemirror/commands";
import { type ChangeSpec, type EditorState, StateEffect, StateField, type TransactionSpec } from "@codemirror/state";

import { titleLink } from "../shared/paste";

export interface Pending {
  id: number;
  from: number;
  to: number;
  url: string;
}

/** Starts tracking an address that is in the document the transaction makes (positions are after its changes). */
export const trackAddress = StateEffect.define<Pending>();
/** Stops tracking, because the title came or never will. */
export const dropAddress = StateEffect.define<number>();

export const pendingAddresses = StateField.define<readonly Pending[]>({
  create: () => [],
  update(value, tr) {
    let next = value;
    if (!tr.changes.empty) {
      next = next.map((p) => ({ ...p, from: tr.changes.mapPos(p.from, 1), to: tr.changes.mapPos(p.to, -1) }));
    }
    for (const e of tr.effects) {
      if (e.is(trackAddress)) next = [...next, e.value];
      else if (e.is(dropAddress)) next = next.filter((p) => p.id !== e.value);
    }
    return next;
  },
});

/**
 * The transaction that turns the tracked address `id` into a link with `title`, or null when the
 * address is no longer there as it was pasted. One change, so one undo step; the cursor goes with
 * the text (a cursor at the end of the address ends up at the end of the link).
 */
export function upgradeAddress(state: EditorState, id: number, title: string): TransactionSpec | null {
  const found = state.field(pendingAddresses, false)?.find((p) => p.id === id);
  if (found === undefined || title.trim() === "") return found === undefined ? null : { effects: dropAddress.of(id) };
  const intact = found.from < found.to && state.sliceDoc(found.from, found.to) === found.url;
  if (!intact) return { effects: dropAddress.of(id) };
  const change: ChangeSpec = { from: found.from, to: found.to, insert: titleLink(title, found.url) };
  // Its own undo step, so one undo brings back the address and a second removes it.
  return { changes: change, effects: dropAddress.of(id), userEvent: "input.paste.title", annotations: isolateHistory.of("before") };
}
