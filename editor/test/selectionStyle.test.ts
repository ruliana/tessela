import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = readFileSync(new URL("../src/renderer/style.css", import.meta.url), "utf8");

// CodeMirror draws the selection in a layer behind the text, and a code block's line
// background paints over it. The layer has to sit above, with a translucent colour.
it("draws the selection above code block backgrounds", () => {
  expect(css).toMatch(/\.cm-selectionLayer\s*\{\s*z-index:\s*150\s*!important/);
  expect(css).toMatch(/\.cm-selectionBackground[^{]*\{\s*background:\s*var\(--selection\)/);
  expect(css.match(/--selection:\s*rgba\(/g)).toHaveLength(3);
});
