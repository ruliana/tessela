// Typewriter scrolling: while you type or move the cursor with the keys, the window scrolls so that
// the line you are on stays at the golden ratio from the bottom (shared/typewriter.ts). On by default; the
// config folder's settings.json can turn it off (`{"editor": {"typewriter": false}}`).

import type { Extension, Transaction } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

import { selectionDelta, typewriterDelta } from "../shared/typewriter";
import { isSelecting } from "./selectMode";

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

/** How far the window should scroll for the selected blocks of `view`, from line blocks: the start of a tall selection may be outside the drawn lines. */
function selectionScroll(view: EditorView, area: HTMLElement): number {
  const { from, to } = view.state.selection.main;
  const top = view.documentTop + view.lineBlockAt(from).top;
  const bottom = view.documentTop + view.lineBlockAt(to).bottom;
  return selectionDelta(top, bottom, area.getBoundingClientRect().top, area.clientHeight);
}

export function typewriter(enabled: () => boolean): Extension {
  return [
    // Select mode: CodeMirror scrolls the selection's head (the end of it, going down) into view after the
    // writes of a measure, which would undo ours, so the selection is placed here, in place of that scroll.
    EditorView.scrollHandler.of((view, range) => {
      if (!enabled() || !isSelecting(view.state) || range.head !== view.state.selection.main.head) return false;
      const area = scroller(view);
      area.scrollTop += selectionScroll(view, area);
      return true;
    }),
    ViewPlugin.fromClass(
      class {
        update(update: ViewUpdate) {
          if (!enabled() || !update.view.hasFocus || !update.transactions.some(wantsTypewriter)) return;
          update.view.requestMeasure({
            key: this,
            read: (view) => {
              const area = scroller(view);
              // Heights of lines not drawn yet are estimates, so a selection is placed again once they are measured.
              if (isSelecting(view.state)) return { area, delta: selectionScroll(view, area) };
              const box = view.coordsAtPos(view.state.selection.main.head);
              if (!box) return null;
              return { area, delta: typewriterDelta(box.top, area.getBoundingClientRect().top, area.clientHeight) };
            },
            write: (found) => {
              if (found && found.delta !== 0) found.area.scrollTop += found.delta;
            },
          });
        }
      },
    ),
  ];
}
