// Typewriter scrolling: where the window should scroll to, so that the line the cursor is on
// stays at the golden ratio from the bottom (a little over three fifths of the way down) while writing.

/** How far down the window the cursor's line is kept: 1/φ, so 38.2% of the window is below it. */
export const TYPEWRITER_FRACTION = (Math.sqrt(5) - 1) / 2;

/** Pixels kept free above and below a selected block that is brought into view. */
export const SELECTION_MARGIN = 16;

/**
 * How many pixels to scroll (positive: the text moves up) so that the cursor's top edge sits at
 * `fraction` of the window's height. `cursorTop` and `viewTop` are in the same coordinates (the
 * window's, as `getBoundingClientRect` gives them). A move under one pixel is none, so that
 * typing along a line does not make the text tremble.
 */
export function typewriterDelta(cursorTop: number, viewTop: number, viewHeight: number, fraction = TYPEWRITER_FRACTION): number {
  const delta = cursorTop - viewTop - viewHeight * fraction;
  return Math.abs(delta) < 1 ? 0 : delta;
}

/**
 * The same for selected blocks, which run from `selTop` to `selBottom`: the start goes to the typewriter
 * line, unless that would push the end out of the window, and then the end rests `SELECTION_MARGIN` above the
 * bottom. A selection taller than the window shows its start, `SELECTION_MARGIN` below the top.
 */
export function selectionDelta(selTop: number, selBottom: number, viewTop: number, viewHeight: number, fraction = TYPEWRITER_FRACTION): number {
  const room = viewHeight - SELECTION_MARGIN - (selBottom - selTop);
  const target = Math.max(SELECTION_MARGIN, Math.min(viewHeight * fraction, room));
  const delta = selTop - viewTop - target;
  return Math.abs(delta) < 1 ? 0 : delta;
}
