// What a block edit that moves text does to the editor's folds. A fold is a range of the text, and a
// swap of two blocks replaces both, so the folds inside them would go with the text they covered. The
// edit says where each block went (`blockMoves` on its transaction, `shared/blockEdit.ts`) and the folds
// are put back on the same text at its new place, in the same transaction, so one undo is one step.
//
// Undo and redo get there through the history: the move leaves a `carried` effect in it for each fold that
// travelled, which says where the fold was and where it went, and applying it (and then inverting it, for
// redo) puts the fold back on the text.

import { invertedEffects } from "@codemirror/commands";
import { foldEffect, foldedRanges } from "@codemirror/language";
import { EditorState, StateEffect, type Transaction } from "@codemirror/state";

import { blockMoves } from "../shared/blockEdit";

interface Span {
  from: number;
  to: number;
}

/** A fold that went along with the text it covered: where it is in the page before the transaction, and where it is after. */
interface Carried {
  before: Span;
  after: Span;
}

const carried = StateEffect.define<Carried>({
  map(value, changes) {
    const span = (s: Span): Span | null => {
      const from = changes.mapPos(s.from, 1);
      const to = changes.mapPos(s.to, -1);
      return from < to ? { from, to } : null;
    };
    const before = span(value.before);
    const after = span(value.after);
    return before && after ? { before, after } : undefined;
  },
});

/** The folds that the transaction carries: the ones inside a range its edit moved, or those that its history effects say. */
function carriedBy(tr: Transaction): Carried[] {
  const found: Carried[] = [];
  for (const e of tr.effects) if (e.is(carried)) found.push(e.value);
  const moves = tr.annotation(blockMoves);
  if (!moves || !tr.docChanged) return found;
  foldedRanges(tr.startState).between(0, tr.startState.doc.length, (from, to) => {
    const m = moves.find((x) => from >= x.from && to <= x.to);
    if (m) found.push({ before: { from, to }, after: { from: from + m.by, to: to + m.by } });
  });
  return found;
}

export const foldsFollowMoves = [
  EditorState.transactionExtender.of((tr) => {
    // CodeMirror adds the folds of one transaction as one sorted set: in the order of the page they land in.
    const effects = carriedBy(tr)
      .sort((a, b) => a.after.from - b.after.from)
      .map((c) => foldEffect.of(c.after));
    return effects.length > 0 ? { effects } : null;
  }),
  // What undo applies, and what it leaves for redo: the same fold, the other way round.
  invertedEffects.of((tr) => carriedBy(tr).map((c) => carried.of({ before: c.after, after: c.before }))),
];
