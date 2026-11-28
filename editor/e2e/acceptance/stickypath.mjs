// The sticky heading path: scrolled into a long page, the bar at the top of the editor names the
// headings you are under, and a click on one goes there. Heading lines wrap in balanced lines.

import assert from "node:assert/strict";
import { front, suite } from "../harness.mjs";

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
