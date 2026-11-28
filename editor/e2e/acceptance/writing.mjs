// Writing aids: typewriter scrolling (on by default, off in settings.json) and the sentence level of focus mode.

import assert from "node:assert/strict";
import { front, suite } from "../harness.mjs";

const paragraphs = Array.from({ length: 60 }, (_, i) => `Paragraph ${i}. It has a second sentence. And a third one.`);

function bundle() {
  return { "long.md": `${front()}${paragraphs.join("\n\n")}\n` };
}

/** Puts the cursor on the first line of paragraph `n` (a paragraph and a blank line take two lines, below the front matter). */
async function goTo(s, n) {
  await s.key("Control+Home");
  for (let i = 0; i < 4 + 2 * n; i++) await s.key("ArrowDown");
  await s.key("Home");
}

/** How far down the scrolling area the cursor is, as a fraction of its height. */
const cursorFraction = (s) =>
  s.win.evaluate(() => {
    const area = document.querySelector(".stack");
    const caret = document.querySelector(".cm-cursor");
    const a = area.getBoundingClientRect();
    return (caret.getBoundingClientRect().top - a.top) / a.height;
  });

const onTheThird = (s) =>
  s.win.waitForFunction(() => {
    const a = document.querySelector(".stack").getBoundingClientRect();
    return Math.abs((document.querySelector(".cm-cursor").getBoundingClientRect().top - a.top) / a.height - 1 / 3) < 0.04;
  });

/**
 * Waits until the window has drawn the frame after the keys so far. Typewriter scrolling is a measure
 * the editor runs in the next frame, so the cursor being on the third already proves nothing about the
 * last key: its scroll can still be on its way, and would undo a scroll the test makes before it lands.
 */
const frameDrawn = (s) => s.win.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

suite("Typewriter scrolling and sentence focus", bundle, (test) => {
  test("typing keeps the line a third of the way down the window", async (s) => {
    await s.open("long");
    await goTo(s, 30);
    await onTheThird(s);
    await frameDrawn(s); // the last key's scroll has landed
    // The wheel moves the text away from the third; typing brings the line back.
    await s.win.evaluate(() => (document.querySelector(".stack").scrollTop += 150));
    assert.ok(Math.abs((await cursorFraction(s)) - 1 / 3) > 0.1, "the text was moved off the third");
    await s.type("!");
    await onTheThird(s);
    assert.ok(Math.abs((await cursorFraction(s)) - 1 / 3) < 0.04, `the cursor is at ${await cursorFraction(s)} of the window`);
    for (let i = 0; i < 6; i++) await s.key("ArrowDown");
    await frameDrawn(s);
    assert.ok(Math.abs((await cursorFraction(s)) - 1 / 3) < 0.04, "moving with the keys keeps it there");
  });

  test("Ctrl+Shift+. dims all but the current sentence, and Ctrl+. leaves focus mode", async (s) => {
    await s.open("long");
    await goTo(s, 5);
    await s.key("Control+Shift+.");
    await s.win.waitForFunction(() => document.querySelector(".shell")?.dataset.focus === "1" && document.querySelector(".shell").dataset.focusUnit === "sentence");
    await s.win.waitForFunction(() => {
      const out = [...document.querySelectorAll(".cm-focus-out")];
      return out.length > 0 && out.every((e) => Number(getComputedStyle(e).opacity) < 0.5) && out.map((e) => e.textContent).join("").includes("It has a second sentence.");
    });
    assert.equal(await s.win.evaluate(() => [...document.querySelectorAll(".cm-line")].find((l) => l.textContent.includes("Paragraph 5."))?.querySelector(".cm-focus-out")?.textContent.includes("Paragraph 5.")), false);
    await s.key("Control+Shift+.");
    await s.win.waitForFunction(() => document.querySelector(".shell").dataset.focusUnit === "block");
    await s.key("Control+.");
    await s.win.waitForFunction(() => document.querySelector(".shell").dataset.focus === "0");
  });
});

suite("Typewriter scrolling switched off", bundle, (test) => {
  test("settings.json can turn it off", async (s) => {
    await s.open("long");
    await goTo(s, 30);
    await s.win.evaluate(() => (document.querySelector(".stack").scrollTop += 150));
    const before = await s.win.evaluate(() => document.querySelector(".stack").scrollTop);
    await s.type("!");
    const after = await s.win.evaluate(() => document.querySelector(".stack").scrollTop);
    assert.equal(after, before, "typing does not move the window");
  });
}, { settings: { editor: { typewriter: false } } });
