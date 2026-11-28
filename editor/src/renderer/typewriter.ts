// Typewriter scrolling: while you type or move the cursor with the keys, the window scrolls so that
// the line you are on stays a third of the way down (shared/typewriter.ts). On by default; the
// config folder's settings.json can turn it off (`{"editor": {"typewriter": false}}`).

import type { Extension, Transaction } from "@codemirror/state";
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
            if (found && found.delta !== 0) found.area.scrollTop += found.delta;
          },
        });
      }
    },
  );
}
