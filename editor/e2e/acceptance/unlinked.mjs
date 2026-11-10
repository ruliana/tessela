// The unlinked mod (bundled, mods/unlinked): under the backlinks of a page, the places in other
// pages that name it in plain words (its title, an alias), each with a Link button that turns
// the words into a link through the tool. It is the first user of the side-bottom slot.

import assert from "node:assert/strict";
import { front, read, suite, write } from "../harness.mjs";

const files = () => ({
  "machine-learning.md": `---\ntype: concept\ntitle: Machine Learning\naliases: [ML]\n---\n\nIts own text says machine learning, which is not a mention.\n`,
  "notes.md": `${front()}Studied machine learning today.\n\nAlready [machine learning](/machine-learning.md) linked.\n\nMore on ML and machine learning too.\n`,
  "quiet.md": `${front()}Nothing about the subject here.\n`,
  "journals/2026-03-04.md": `${front("journal")}Tried an ML course.\n`,
});

const rows = (s) => s.texts("#unlinked .unlinked-hit");
const gone = (s) => s.win.waitForFunction(() => !document.querySelector("#unlinked"));

/** One bundle serves the whole suite and a test may link things, so each test starts from the same files. */
async function show(s, name) {
  for (const [path, text] of Object.entries(files())) write(s.bundle, path, text);
  await s.win.fill("#search", name);
  await s.win.press("#search", "Enter");
  await s.win.waitForFunction((n) => document.querySelector(".card-title")?.textContent === n, name);
}

suite("Unlinked mod", files, (test) => {
  test("a page lists the plain-words mentions of it under the backlinks, and not its own text or links", async (s) => {
    await show(s, "machine-learning");
    await s.win.waitForSelector("#side-bottom #unlinked .unlinked-hit");
    assert.match(await s.win.textContent("#unlinked .unlinked-title"), /4 unlinked mentions/);
    const list = await rows(s);
    assert.equal(list.length, 4, list.join("|"));
    assert.ok(list.some((r) => /Studied/.test(r)) && list.some((r) => /Tried an ML course/.test(r)), list.join("|"));
    assert.ok(!list.some((r) => /Already/.test(r) || /Its own text/.test(r)), list.join("|"));
    // It sits below the backlinks.
    assert.ok(await s.win.evaluate(() => document.querySelector("#backlinks .backlinks-body + #side-bottom") !== null));
  });

  test("Link turns the words into a link, changes nothing else, and the mention leaves the list", async (s) => {
    await show(s, "machine-learning");
    await s.win.waitForSelector("#unlinked .unlinked-hit");
    const before = read(s.bundle, "notes.md");
    await s.win.click('#unlinked .unlinked-hit:has-text("Studied") .unlinked-link');
    await s.win.waitForFunction(() => document.querySelectorAll("#unlinked .unlinked-hit").length === 3);
    assert.equal(read(s.bundle, "notes.md"), before.replace("Studied machine learning today", "Studied [machine learning](/machine-learning.md) today"));
    // It is a backlink now.
    await s.win.waitForFunction(() => /notes/.test(document.querySelector(".backlinks-body")?.textContent ?? ""));
  });

  test("linking one of two mentions in a block keeps the words' own spelling, and the block leaves the list", async (s) => {
    await show(s, "machine-learning");
    await s.win.waitForFunction(() => document.querySelectorAll("#unlinked .unlinked-hit").length === 4);
    await s.win.locator('#unlinked .unlinked-hit:has-text("More on") .unlinked-link').first().click();
    // The block reaches the page now, so it is a backlink and its other mention is not listed.
    await s.win.waitForFunction(() => document.querySelectorAll("#unlinked .unlinked-hit").length === 2);
    assert.match(read(s.bundle, "notes.md"), /More on \[ML\]\(\/machine-learning\.md\) and machine learning too\./);
  });

  test("clicking the text opens the page that has it", async (s) => {
    await show(s, "machine-learning");
    await s.win.waitForSelector("#unlinked .unlinked-hit");
    await s.win.click('#unlinked .unlinked-hit:has-text("Tried an ML course") .unlinked-text');
    await s.win.waitForFunction(() => document.querySelector(".pane .card-title")?.textContent === "2026-03-04");
  });

  test("a page that nothing names in plain words shows nothing, and so does a journal day", async (s) => {
    await show(s, "quiet");
    await gone(s);
    write(s.bundle, "journals/2026-03-05.md", `${front("journal")}Plain day.\n`);
    await s.win.fill("#search", "2026-03-05");
    await s.win.press("#search", "Enter");
    await s.win.waitForFunction(() => document.querySelector(".pane .card-title")?.textContent === "2026-03-05");
    await gone(s);
  });

  test("a mention written after the page was opened shows up", async (s) => {
    await show(s, "machine-learning");
    await s.win.waitForFunction(() => document.querySelectorAll("#unlinked .unlinked-hit").length === 4);
    write(s.bundle, "quiet.md", `${front()}Now it talks about machine learning.\n`);
    await s.win.waitForFunction(() => document.querySelectorAll("#unlinked .unlinked-hit").length === 5);
  });
});
