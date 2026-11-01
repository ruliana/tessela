// Backlinks drawn as text with their place in the page, and the dateline of each journal day.

import assert from "node:assert/strict";
import { daysAgo, front, localDay, suite } from "../harness.mjs";

function bundle() {
  return {
    "target.md": `${front()}The target page.\n`,
    "source.md": `${front()}# Plan\n\n## Phase one\n\nSee [Target](/target.md) and **soon** #target now.\n\n- A [Target](/target.md) item\n`,
    "other.md": `${front()}Also about #target.\n`,
    [`journals/${daysAgo(1)}.md`]: `${front("journal")}Yesterday.\n`,
  };
}

suite("Backlink tiles and datelines", bundle, (test) => {
  test("backlinks say how many mentions in how many pages", async (s) => {
    await s.open("target");
    await s.win.waitForSelector("#backlinks .hit");
    assert.equal(await s.win.textContent("#backlinks h2"), "Backlinks (3)");
    assert.equal(await s.win.textContent("#backlinks .sub"), "3 mentions in 2 pages");
  });

  test("a mention is drawn as text: no Markdown marks, tags as chips, links underlined", async (s) => {
    const tile = s.win.locator("#backlinks .hit", { hasText: "See Target" });
    assert.equal((await tile.locator(".text").textContent()).trim(), "See Target and soon #target now.");
    assert.equal(await tile.locator(".tag").textContent(), "#target");
    assert.equal(await tile.locator(".lnk").textContent(), "Target");
    assert.equal(await tile.locator("strong").textContent(), "soon");
  });

  test("a tile says where in its page the mention is, by the headings above it", async (s) => {
    const where = await s.win.locator("#backlinks .hit", { hasText: "See Target" }).locator(".where").textContent();
    assert.equal(where, "Plan › Phase one");
  });

  test("pages are grouped, with how many mentions each has", async (s) => {
    assert.deepEqual(await s.texts("#backlinks h3 button"), ["other", "source"]);
    assert.deepEqual(await s.texts("#backlinks h3 .n"), ["1", "2"]);
  });

  test("each journal day opens with its number, the weekday and its date", async (s) => {
    await s.win.click("#journals-view");
    await s.win.waitForFunction(() => document.querySelectorAll(".dateline").length > 1);
    const today = new Date();
    assert.equal(await s.win.locator(".dateline .n").first().textContent(), String(today.getDate()).padStart(2, "0"));
    assert.equal(await s.win.locator(".dateline .w").first().textContent(), today.toLocaleDateString("en-US", { weekday: "long" }));
    assert.equal(await s.win.locator(".dateline .card-title").first().textContent(), localDay());
  });

  test("only today is tagged Today", async (s) => {
    assert.deepEqual(await s.texts(".today-tag"), ["Today"]);
    assert.equal(await s.win.locator(".card").first().locator(".today-tag").count(), 1);
  });

  test("the dateline stays in view while the day is scrolled", async (s) => {
    const position = await s.win.$eval(".dateline", (d) => getComputedStyle(d).position);
    assert.equal(position, "sticky");
  });
});
