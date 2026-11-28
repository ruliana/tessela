// The sentence level of focus mode: inside the block the cursor is in (the lines `cm-focus-cur`
// marks), the text outside the current sentence gets `cm-focus-out`, and the window's focus setting
// (`data-focus-unit="sentence"`) makes it dim. The marks exist only while sentence focus is on: they cut
// the text of a paragraph into pieces, and a row that is full to within a pixel wraps differently when its
// pieces change, so a word would jump between rows as the cursor moved through the sentences.

import { type EditorState } from "@codemirror/state";
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

import { refreshDecorations } from "./decorations";

import { sentenceAt } from "../shared/sentences";
import { LINE_BLOCKS, currentLines } from "./livePreview";
import { pageModel } from "./pageModelField";

const outside = Decoration.mark({ class: "cm-focus-out" });

/**
 * The ranges of the current block that are not the current sentence: none unless one cursor or
 * selection sits in the own text of a paragraph or item (a heading, a fence or a blank line is one line
 * or nothing, and has no sentences to tell apart).
 */
export function outsideSentence(state: EditorState): { from: number; to: number }[] {
  const { ranges } = state.selection;
  const sel = ranges[0];
  const model = state.field(pageModel, false);
  if (ranges.length !== 1 || !sel || !model) return [];
  const head = state.doc.lineAt(sel.head);
  const node = model.nodeAtLine(head.number);
  if (head.text.trim() === "" || node === model.root || node.kind === "section" || LINE_BLOCKS.has(node.kind)) return [];
  // The own lines of the block that touch the cursor's line.
  const lines = currentLines(state);
  let first = head.number;
  let last = head.number;
  while (lines.has(first - 1)) first--;
  while (lines.has(last + 1) && last < state.doc.lines) last++;
  const start = state.doc.line(first).from;
  const end = state.doc.line(last).to;
  if (sel.from < start || sel.to > end) return [];
  const text = state.sliceDoc(start, end);
  const sentence = sentenceAt(text, sel.head - start);
  // The whole selection counts as current, so that selecting a sentence does not dim it.
  const from = Math.min(start + sentence.from, sel.from);
  const to = Math.max(start + sentence.to, sel.to);
  return [
    ...(from > start ? [{ from: start, to: from }] : []),
    ...(to < end ? [{ from: to, to: end }] : []),
  ];
}

/** The dimmed marks for a state: none unless sentence focus is on and the editor has the keyboard focus. */
export function sentenceDecorations(state: EditorState, on: boolean, hasFocus: boolean): DecorationSet {
  if (!on || !hasFocus) return Decoration.none;
  return Decoration.set(outsideSentence(state).map((r) => outside.range(r.from, r.to)), true);
}

/** `on` is asked at every change; `refresh()` of the editor makes it ask again when it flips. */
export function sentenceMarks(on: () => boolean) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = sentenceDecorations(view.state, on(), view.hasFocus);
      }
      update(update: ViewUpdate) {
        const refresh = update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshDecorations)));
        if (update.docChanged || update.selectionSet || update.focusChanged || refresh) {
          this.decorations = sentenceDecorations(update.state, on(), update.view.hasFocus);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}
