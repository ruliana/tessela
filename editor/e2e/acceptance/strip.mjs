// The sidebar in sections, and the strip along the bottom that reports on the notes.

import assert from "node:assert/strict";
import { daysAgo, front, suite } from "../harness.mjs";

function bundle() {
  return {
    "alpha.md": `${front()}One two three.\n`,
    "beta.md": `${front()}Mentions #alpha.\n`,
    "broken.md": "no frontmatter here\n",
    [`journals/${daysAgo(1)}.md`]: `${front("journal")}A day.\n`,
  };
}

suite("Sidebar and status strip", bundle, (test) => {
  test("the sidebar has Recent, Journals and Concepts as labelled sections", async (s) => {
    await s.open("alpha");
    assert.deepEqual(await s.texts(".sidebar h2"), ["Recent", "Journals", "Concepts"]);
  });

  test("Today comes first, and the notes folder is one quiet line with the number of pages", async (s) => {
    const first = await s.win.evaluate(() => document.querySelector(".sidebar .places button")?.id);
    assert.equal(first, "today");
    assert.match(await s.win.textContent("#root"), /· \d+ pages/);
  });

  test("All opens the days stacked", async (s) => {
    await s.win.click("#journals-all");
    await s.win.waitForFunction(() => document.querySelectorAll(".card").length > 1);
  });

  test("the strip counts the words of the page, without its front matter", async (s) => {
    await s.open("alpha");
    await s.win.waitForFunction(() => document.querySelector("#strip-words")?.textContent === "3 words");
  });

  test("the strip says Saved, and Editing… while there is something to save", async (s) => {
    await s.open("alpha");
    await s.type(" More.");
    assert.match(await s.win.textContent("#strip-status"), /Editing…|Saved/);
    await s.saved();
    await s.win.waitForFunction(() => document.querySelector("#strip-status")?.textContent === "Saved");
    await s.win.waitForFunction(() => document.querySelector("#strip-words")?.textContent === "4 words");
  });

  test("the strip is quiet when the notes are clean and amber when they are not", async (s) => {
    // The demo notes have one page without front matter.
    await s.win.waitForFunction(() => document.querySelector("#problems-toggle")?.textContent?.startsWith("▲"));
    assert.equal(await s.win.getAttribute("#problems-toggle", "data-clean"), "false");
    assert.equal(await s.win.isHidden("#problems"), true);
    await s.win.click("#problems-toggle");
    await s.win.waitForSelector("#problems .problem");
    assert.match(await s.win.textContent("#problems"), /broken\.md/);
  });

  test("Rendered and Source switch from the strip", async (s) => {
    assert.equal(await s.win.locator("#strip #preview-toggle").count(), 1);
    const before = await s.win.getAttribute("#preview-toggle", "aria-pressed");
    await s.win.click("#preview-toggle");
    assert.notEqual(await s.win.getAttribute("#preview-toggle", "aria-pressed"), before);
    await s.win.click("#preview-toggle");
  });
});
