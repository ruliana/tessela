// Fold and zoom (spec §11): Ctrl+Up folds the block at the cursor, Ctrl+Down opens it, and
// Ctrl+Alt+Right / Left zoom in on a block and out again. A fold is the window's, not the
// page's: the notes on disk never change.

import assert from "node:assert/strict";
import { front, read, suite, write } from "../harness.mjs";

const outline = "- one\n  - under one\n  - more\n- two\n  - under two\n- three";

const folded = (s) => s.win.$$eval(".cm-foldchip", (els) => els.map((e) => e.textContent));
/** Puts the cursor on line `n` (0 is the first) of a body of `total` lines, which the page ends with. */
async function goTo(s, n, total) {
  await s.key("Control+End");
  for (let i = total - 1; i > n; i--) await s.key("ArrowUp");
  await s.key("Home");
}

const shown = (s) => s.texts(".cm-line");

suite("Fold and zoom", () => ({ "other.md": `${front()}Other.\n` }), (test) => {
  test("Ctrl+Up folds the item at the cursor, Ctrl+Down opens it, and the file is untouched", async (s) => {
    await s.openWith("fold-item", outline);
    await goTo(s, 0, 6);
    await s.key("Control+ArrowUp");
    assert.deepEqual(await folded(s), ["… 2 lines"]);
    assert.ok(!(await shown(s)).some((l) => l.includes("under one")), "the lines under it are hidden");
    await s.key("Control+ArrowDown");
    assert.deepEqual(await folded(s), []);
    assert.equal(read(s.bundle, "fold-item.md"), front() + outline, "folding never writes to the page");
  });

  test("on a leaf, Ctrl+Up folds the item around it, and again the one around that", async (s) => {
    await s.openWith("fold-up", "- one\n  - two\n    - three\n- other");
    await goTo(s, 2, 4);
    await s.key("Control+ArrowUp");
    assert.equal((await folded(s)).length, 1);
    await s.key("Control+ArrowUp");
    const lines = await shown(s);
    assert.ok(!lines.some((l) => l.includes("two")), "the item one level up folds as well");
    assert.ok(lines.some((l) => l.startsWith("- one")) && lines.includes("- other"));
  });

  test("a heading folds its section, up to the next heading of its level", async (s) => {
    await s.openWith("fold-heading", "# A\n\ntext a\n\n## A1\n\ntext a1\n\n# B\n\ntext b");
    await goTo(s, 0, 11);
    await s.key("Control+ArrowUp");
    const lines = await shown(s);
    assert.ok(lines.some((l) => l.startsWith("# A")) && lines.includes("# B") && lines.includes("text b"));
    assert.ok(!lines.some((l) => l.includes("text a")));
  });

  test("a click on the chip opens the fold", async (s) => {
    await s.openWith("fold-chip", outline);
    await goTo(s, 0, 6);
    await s.key("Control+ArrowUp");
    await s.win.click(".cm-foldchip");
    assert.deepEqual(await folded(s), []);
  });

  test("the palette folds the page to a level and opens it all again", async (s) => {
    await s.openWith("fold-level", "# A\n\n- x\n  - y\n\n# B\n\n- z");
    await s.key("Control+k");
    await s.type("fold the page to level 1");
    await s.key("Enter");
    assert.equal((await folded(s)).length, 2, "both sections fold");
    await s.key("Control+k");
    await s.type("unfold the whole");
    await s.key("Enter");
    assert.deepEqual(await folded(s), []);
  });

  test("a fold is remembered when the page is left and opened again, and a changed block opens", async (s) => {
    await s.openWith("fold-memory", outline);
    await goTo(s, 0, 6);
    await s.key("Control+ArrowUp");
    await s.win.waitForTimeout(700);
    await s.open("other");
    await s.open("fold-memory");
    assert.deepEqual(await folded(s), ["… 2 lines"]);
    await s.open("other");
    write(s.bundle, "fold-memory.md", front() + outline.replace("- one", "- uno"));
    await s.open("fold-memory");
    assert.deepEqual(await folded(s), [], "the block was rewritten while the page was away");
  });

  test("zoom shows one block with the way back, and zoom out restores the page", async (s) => {
    await s.openWith("zoom", "# Top\n\n- a\n  - b\n    - c\n- d");
    await goTo(s, 4, 6);
    await s.key("Control+Alt+ArrowRight");
    assert.deepEqual(await shown(s).then((l) => l.filter((x) => x !== "")), ["    - c"]);
    assert.deepEqual(await s.texts(".cm-zoomtrail button"), ["Page", "Top", "a", "b"]);
    await s.key("Control+Alt+ArrowLeft");
    assert.deepEqual(await s.texts(".cm-zoomtrail button"), ["Page", "Top", "a"]);
    await s.win.click(".cm-zoomtrail button");
    assert.equal(await s.win.$$eval(".cm-zoomtrail", (e) => e.length), 0);
    assert.ok((await shown(s)).includes("- d"));
  });

  test("while zoomed, select all and typing reach only the block shown", async (s) => {
    await s.openWith("zoom-edit", "- keep\n- mine\n  - inner\n- keep too");
    await goTo(s, 1, 4);
    await s.key("Control+Alt+ArrowRight");
    await s.key("Control+a");
    await s.type("- changed");
    await s.key("Control+Alt+ArrowLeft");
    await s.key("Control+Alt+ArrowLeft");
    assert.equal(await s.body(), "- keep\n- changed\n- keep too");
    assert.equal(await s.savedBody("zoom-edit"), "- keep\n- changed\n- keep too");
  });
});

suite("Zoom with the page rendered", null, (test) => {
  test("zoom covers the drawn properties too, and leaves the way back", async (s) => {
    await s.openWith("zoom-rendered", "# Top\n\n- a\n  - b\n- c");
    await s.key("Control+End");
    await s.key("ArrowUp");
    await s.key("ArrowUp");
    await s.key("Control+Alt+ArrowRight");
    assert.equal(await s.win.$$eval(".cm-props", (e) => e.length), 0);
    assert.deepEqual(await s.texts(".cm-zoomtrail button"), ["Page", "Top"]);
    await s.key("Control+Alt+ArrowLeft");
    await s.key("Control+Alt+ArrowLeft");
    assert.equal(await s.win.$$eval(".cm-props", (e) => e.length), 1);
  });
}, { rendered: true });
