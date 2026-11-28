// Typewriter scrolling: while you type or move the cursor with the keys, the window scrolls so that
// the line you are on stays a third of the way down (shared/typewriter.ts). On by default; the
// config folder's settings.json can turn it off (`{"editor": {"typewriter": false}}`).

import type { EditorState, Extension, Transaction } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

import { typewriterDelta } from "../shared/typewriter";

/**
 * Whether a transaction is the user writing or moving: one that asks to scroll the cursor into view,
 * except a click or a drag, which must not move the text under the mouse. A load or a jump to a heading
 * scrolls by its own effect and does not ask.
 */
export function wantsTypewriter(tr: Transaction): boolean {
  return tr.scrollIntoView && !tr.isUserEvent("select.pointer");
}

/**
 * Whether the cursor stays on its line of the page (and no line was added or removed): the writer is
 * typing along it. When the line wraps, the cursor drops a row and the text has to follow, and a jump
 * of a row in the middle of a word reads as the page trembling, so that scroll glides.
 */
export function alongLine(before: EditorState, after: EditorState): boolean {
  return before.doc.lines === after.doc.lines && before.doc.lineAt(before.selection.main.head).number === after.doc.lineAt(after.selection.main.head).number;
}

/** The nearest ancestor that scrolls: the stack of cards, a peek panel, or the editor's own scroller. */
function scroller(view: EditorView): HTMLElement {
  for (let el = view.dom.parentElement; el; el = el.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(el).overflowY)) return el;
  }
  return view.scrollDOM;
}

export function typewriter(enabled: () => boolean): Extension {
  return ViewPlugin.fromClass(
    class {
      update(update: ViewUpdate) {
        if (!enabled() || !update.view.hasFocus || !update.transactions.some(wantsTypewriter)) return;
        const along = alongLine(update.startState, update.state);
        update.view.requestMeasure({
          key: this,
          read: (view) => {
            const box = view.coordsAtPos(view.state.selection.main.head);
            if (!box) return null;
            const area = scroller(view);
            const rect = area.getBoundingClientRect();
            return { area, delta: typewriterDelta(box.top, rect.top, area.clientHeight) };
          },
          write: (found) => {
            if (!found || found.delta === 0) return;
            if (along) found.area.scrollTo({ top: found.area.scrollTop + found.delta, behavior: "smooth" });
            else found.area.scrollTop += found.delta;
          },
        });
      }
    },
  );
}
