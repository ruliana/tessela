// Moving the cursor into a construct shows its marks, and the words around them do not jump: a mark at
// the start of a line (heading, quote) is drawn in the margin, a bullet or a checkbox is raw in the
// slot of its glyph, and code keeps its padding. The address of a link is typed under its row. Marks
// inside a line (bold) push the rest of their own line and nothing else. The model side is test/revealShift.test.ts; this measures a real window.

import assert from "node:assert/strict";
import { suite } from "../harness.mjs";

const page = [
  "# Alpha title",
  "",
  "### Bravo smaller",
  "",
  "- charlie item",
  "- [ ] delta task",
  "",
  "> echo quoted",
  "",
  "> > foxtrot nested",
  "",
  "golf **hotel** india `juliet` kilo [lima](https://example.com/some/long/address) mike.",
  "",
  "november last",
].join("\n");

const words = ["Alpha", "Bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november"];

/** Where each word is, and the top and height of each line, in the window. */
const measure = (s) =>
  s.win.evaluate((ws) => {
    const out = { words: {}, lines: [] };
    const walker = document.createTreeWalker(document.querySelector(".cm-content"), NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      for (const w of ws) {
        const at = n.data.indexOf(w);
        if (at < 0 || out.words[w]) continue;
        const range = document.createRange();
        range.setStart(n, at);
        range.setEnd(n, at + w.length);
        const r = range.getBoundingClientRect();
        out.words[w] = { x: r.left, y: r.top };
      }
    }
    for (const l of document.querySelectorAll(".cm-line")) {
      const r = l.getBoundingClientRect();
      out.lines.push({ top: r.top, height: r.height });
    }
    return out;
  }, words);

/** Puts the cursor in the word, then `right` characters from the start of the line (a bullet or a box is raw only with the cursor at it), and waits for the marks to be typed. */
async function enter(s, word, marked, right = -1) {
  await s.win.click(`.cm-line:has-text('${word}') >> text=${word}`);
  if (right >= 0) {
    await s.key("Home");
    for (let i = 0; i < right; i++) await s.key("ArrowRight");
  }
  await s.win.waitForFunction((m) => [...document.querySelectorAll(".cm-line")].some((l) => l.textContent.includes(m)), marked);
}

/** The words that moved by more than half a pixel, by name. */
const moved = (before, after) => words.filter((w) => Math.abs(before.words[w].x - after.words[w].x) > 0.5 || Math.abs(before.words[w].y - after.words[w].y) > 0.5);

suite(
  "No shift when marks reveal",
  null,
  (test) => {
    let base;
    test("the page is drawn, with the cursor away from every mark", async (s) => {
      await s.openWith("shift", page);
      await s.win.click(".cm-line:has-text('november')");
      base = await measure(s);
      assert.equal(Object.keys(base.words).length, words.length);
    });

    for (const [name, word, marked, right] of [
      ["a heading shows its # in the margin", "Alpha", "# Alpha"],
      ["a smaller heading too", "Bravo", "### Bravo"],
      ["a bullet shows its - in the slot of the bullet", "charlie", "- charlie", 0],
      ["a task shows its [ ] in the slot of the box", "delta", "[ ] delta", 2],
      ["a quote shows its > in the margin", "echo", "> echo"],
      ["so does a quote in a quote", "foxtrot", "> > foxtrot"],
    ]) {
      test(`${name}: no word and no line moves`, async (s) => {
        await enter(s, word, marked, right);
        const after = await measure(s);
        assert.deepEqual(moved(base, after), []);
        assert.deepEqual(after.lines, base.lines);
      });
    }

    test("code keeps its padding, and the words before it and on other lines stay", async (s) => {
      await enter(s, "juliet", "`juliet`");
      const after = await measure(s);
      assert.deepEqual(moved(base, after).filter((w) => !["juliet", "kilo", "lima", "mike"].includes(w)), []);
      assert.deepEqual(after.lines, base.lines);
    });

    test("bold pushes the rest of its own line, and nothing else", async (s) => {
      await enter(s, "hotel", "**hotel**");
      const after = await measure(s);
      assert.deepEqual(moved(base, after).filter((w) => !["hotel", "india", "juliet", "kilo", "lima", "mike"].includes(w)), []);
      assert.deepEqual(after.lines, base.lines);
    });

    test("a link shows its address under its row: no word and no line moves", async (s) => {
      // A click on a drawn link opens it, so the cursor gets to the end of the link with keys.
      await s.win.click(".cm-line:has-text('mike') >> text=mike");
      await s.key("End");
      for (let i = 0; i < 6; i++) await s.key("ArrowLeft");
      await s.win.waitForFunction(() => [...document.querySelectorAll(".cm-line")].some((l) => l.textContent.includes("](https://example.com")));
      const after = await measure(s);
      assert.deepEqual(moved(base, after), []);
      assert.deepEqual(after.lines, base.lines);
    });
  },
  // Typewriter scrolling would move every word with the keys that put the cursor in a construct; this is about the marks alone.
  { rendered: true, settings: { editor: { typewriter: false } } },
);
