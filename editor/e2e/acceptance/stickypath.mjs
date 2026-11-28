// The sticky heading path: scrolled into a long page, the bar at the top of the editor names the
// headings you are under, and a click on one goes there. Heading lines wrap in balanced lines.

import assert from "node:assert/strict";
import { front, localDay, suite } from "../harness.mjs";

const filler = (n) => Array.from({ length: n }, (_, i) => `Paragraph ${i + 1} with some words to fill a line of the page.`).join("\n\n");
const PAGE = `# Project\n\nIntro.\n\n## Design\n\n${filler(30)}\n\n### Risks\n\n${filler(30)}\n\n## Plan\n\n${filler(30)}\n`;

const crumbs = (s) => s.win.$$eval(".cm-stickypath-bar:not([hidden]) button", (els) => els.map((e) => e.textContent));
const scrollTo = (s, y) => s.win.evaluate((top) => void (document.querySelector(".stack").scrollTop = top), y);
const waitFor = (s, want) =>
  s.win.waitForFunction((w) => JSON.stringify([...document.querySelectorAll(".cm-stickypath-bar:not([hidden]) button")].map((b) => b.textContent)) === JSON.stringify(w), want);

suite("Sticky heading path", () => ({ "long.md": front() + PAGE }), (test) => {
  test("at the top of the page there is no bar", async (s) => {
    await s.open("long");
    // Opening a page puts the cursor at its end, so the window goes to the end and the bar appears.
    // Wait for that, then go to the top: the bar leaves when the window gets there.
    await waitFor(s, ["Project", "Plan"]);
    await s.key("Control+Home");
    await s.win.waitForFunction(() => document.querySelector(".stack").scrollTop === 0);
    await waitFor(s, []);
  });

  test("scrolled into a section, it shows the headings above, outermost first", async (s) => {
    // About 60 px a paragraph: the Design section runs from 250 px to about 2,100 px.
    await scrollTo(s, 1200);
    await waitFor(s, ["Project", "Design"]);
  });

  test("it follows the scroll into a deeper section and back", async (s) => {
    await scrollTo(s, 1e6);
    await waitFor(s, ["Project", "Plan"]);
    await scrollTo(s, 3000);
    await waitFor(s, ["Project", "Design", "Risks"]);
  });

  test("a click on a heading in the bar puts the cursor on it, and the bar drops what is no longer above", async (s) => {
    await s.win.click('.cm-stickypath-bar button:has-text("Design")');
    await s.win.waitForFunction(() => getSelection()?.anchorNode?.parentElement?.closest(".cm-line")?.textContent === "## Design");
    await waitFor(s, ["Project"]);
    await scrollTo(s, 3000);
    await waitFor(s, ["Project", "Design", "Risks"]);
    await s.win.click('.cm-stickypath-bar button:has-text("Project")');
    await s.win.waitForFunction(() => getSelection()?.anchorNode?.parentElement?.closest(".cm-line")?.textContent === "# Project");
    await waitFor(s, []);
  });

  test("heading lines wrap balanced, and prose lines wrap pretty, but code lines keep their wrapping", async (s) => {
    assert.equal(await s.win.$eval(".cm-line:not(.cm-heading-line)", (e) => getComputedStyle(e).textWrap), "pretty");
    assert.equal(await s.win.$$eval(".cm-heading-line", (e) => e.length) >= 1, true);
    assert.equal(await s.win.$eval(".cm-heading-line", (e) => getComputedStyle(e).textWrap), "balance");
  });
});

// In the journals the text is at the left of its column, not centred. The bar spans the editor all the same,
// with an opaque background, so that no text shows past it, and its crumbs start where the text starts.
const today = localDay();
suite("Sticky heading path in a journal", () => ({ [`journals/${today}.md`]: `---\ntype: journal\ndate: ${today}\n---\n\n# Day\n\n${filler(40)}\n` }), (test) => {
  test("the bar is as wide as the editor, and the crumbs start where the text does", async (s) => {
    await s.win.waitForSelector(".card .cm-line");
    await scrollTo(s, 600);
    await s.win.waitForSelector(".cm-stickypath-bar:not([hidden])");
    const r = await s.win.evaluate(() => {
      const bar = document.querySelector(".cm-stickypath-bar:not([hidden])");
      const editor = bar.closest(".cm-editor").getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      const line = bar.closest(".cm-editor").querySelector(".cm-line").getBoundingClientRect();
      const crumb = bar.querySelector("button").getBoundingClientRect();
      return { left: b.left - editor.left, right: editor.right - b.right, crumb: crumb.left - line.left, opaque: getComputedStyle(bar).backgroundColor };
    });
    assert.ok(Math.abs(r.left) < 1 && Math.abs(r.right) < 1, `the bar is ${r.left}px in from the left, ${r.right}px from the right`);
    assert.ok(Math.abs(r.crumb - 24) < 2, `the crumb starts ${r.crumb}px from the left of the text`);
    assert.notEqual(r.opaque, "rgba(0, 0, 0, 0)");
  });
});
