// Typewriter scrolling: where the window should scroll to, so that the line the cursor is on
// stays a third of the way down while writing.

/** How far down the window the cursor's line is kept (a fraction of its height). */
export const TYPEWRITER_FRACTION = 1 / 3;

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
