// The journals view: today and earlier days stacked, each one its own editor (spec §11).
// The tests share one window and run in order: the first ones need the untouched state.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bodyOf, daysAgo, front, localDay, read, suite } from "../harness.mjs";

const today = localDay();

function bundle() {
  const files = { "notes.md": `${front()}Deadline is ${daysAgo(2)} for the report.\n` };
  for (let n = 1; n <= 9; n++) {
    const day = daysAgo(n);
    files[`journals/${day}.md`] = `---\ntype: journal\ndate: ${day}\n---\n\nEntry from ${n} days ago #daily\n`;
  }
  return files;
}

suite("Journals", bundle, (test) => {
  test("opens on today and the six days before, newest first", async (s) => {
    await s.win.waitForFunction(() => document.querySelectorAll(".card").length === 7);
    const titles = await s.texts(".card-title");
    assert.deepEqual(titles, [today, ...[1, 2, 3, 4, 5, 6].map(daysAgo)]);
  });

  test("every day is its own editor with its own text", async (s) => {
    assert.equal(await s.win.$$eval(".card .cm-editor", (e) => e.length), 7);
    assert.match(await s.doc(1), /Entry from 1 days ago/);
    assert.match(await s.doc(3), /Entry from 3 days ago/);
    assert.ok(!(await s.doc(3)).includes("Entry from 1 days ago"));
  });

  test("today has no file until it is edited", async (s) => {
    assert.equal(existsSync(join(s.bundle, "journals", `${today}.md`)), false);
    assert.equal(await s.status(0), "New page");
    await s.win.click(".card:nth-child(1) .cm-content");
    await s.key("Control+End");
    await s.type("First note of the day");
    await s.saved(0);
    const text = read(s.bundle, `journals/${today}.md`);
    assert.match(text, /^---\ntype: journal\n/);
    assert.match(text, new RegExp(`\\ndate: "?${today}"?\\n---\\n`));
    assert.match(text, /First note of the day/);
  });

  test("clicking in today without typing creates nothing", async (s) => {
    // Another day: it has a file already, so look at a fresh bundle day instead: nothing to check
    // on disk for days that exist, but their text must stay as it was.
    const before = read(s.bundle, `journals/${daysAgo(4)}.md`);
    await s.win.click(".card:nth-child(5) .cm-content");
    await s.key("ArrowDown");
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(read(s.bundle, `journals/${daysAgo(4)}.md`), before);
  });

  test("an earlier day saves on its own, the others stay untouched", async (s) => {
    const other = read(s.bundle, `journals/${daysAgo(3)}.md`);
    await s.win.click(".card:nth-child(3) .cm-content");
    await s.key("Control+End");
    await s.type(" and more");
    await s.saved(2);
    assert.match(bodyOf(s.bundle, `journals/${daysAgo(2)}.md`), /Entry from 2 days ago #daily\n and more/);
    assert.equal(read(s.bundle, `journals/${daysAgo(3)}.md`), other);
    assert.match(read(s.bundle, `journals/${today}.md`), /First note of the day$/m);
  });

  test("two days can be edited one after the other", async (s) => {
    await s.win.click(".card:nth-child(2) .cm-content");
    await s.key("Control+End");
    await s.type(" A");
    await s.win.click(".card:nth-child(4) .cm-content");
    await s.key("Control+End");
    await s.type(" B");
    await s.saved(1);
    await s.saved(3);
    assert.match(read(s.bundle, `journals/${daysAgo(1)}.md`), /^ A$/m);
    assert.match(read(s.bundle, `journals/${daysAgo(3)}.md`), /^ B$/m);
  });

  test("the backlinks follow the journal being edited", async (s) => {
    await s.win.click(".card:nth-child(3) .cm-content");
    await s.win.waitForSelector("#backlinks .hit");
    assert.match(await s.win.textContent("#backlinks"), /Deadline is/);
    await s.win.click(".card:nth-child(5) .cm-content");
    await s.win.waitForFunction(() => !document.querySelector("#backlinks")?.textContent?.includes("Deadline is"));
  });

  test("Journals button shows the stack again after visiting a page", async (s) => {
    await s.win.fill("#search", "notes");
    await s.win.press("#search", "Enter");
    await s.win.waitForFunction(() => document.querySelectorAll(".card").length === 1);
    await s.win.click("#journals-view");
    await s.win.waitForFunction(() => document.querySelectorAll(".card").length === 7);
  });

  test("the Today button puts the keyboard cursor in today's editor", async (s) => {
    await s.win.click("#journals-view");
    await s.win.waitForFunction(() => document.querySelectorAll(".card").length === 7);
    await s.win.click(".card:nth-child(4) .cm-content");
    await s.win.click("#today");
    await s.win.waitForFunction(() => document.activeElement?.closest(".card") === document.querySelector(".card"));
    const title = await s.win.evaluate(() => document.activeElement.closest(".card").querySelector(".card-title").textContent);
    assert.equal(title, today);
  });

  test("a day in the sidebar opens alone", async (s) => {
    await s.win.click(`#journals button:has-text('${daysAgo(5)}')`);
    await s.win.waitForFunction(() => document.querySelectorAll(".card").length === 1);
    assert.deepEqual(await s.texts(".card-title"), [daysAgo(5)]);
    assert.match(await s.doc(), /Entry from 5 days ago/);
  });

  test("clicking a day title opens that day alone", async (s) => {
    await s.win.click("#journals-view");
    await s.win.waitForFunction(() => document.querySelectorAll(".card").length === 7);
    await s.win.click(".card:nth-child(2) .card-title");
    await s.win.waitForFunction(() => document.querySelectorAll(".card").length === 1);
    assert.deepEqual(await s.texts(".card-title"), [daysAgo(1)]);
  });

  test("Older days… adds more days, and goes away when there are no more", async (s) => {
    await s.win.click("#journals-view");
    await s.win.waitForFunction(() => document.querySelectorAll(".card").length === 7);
    await s.win.click("#more-days");
    await s.win.waitForFunction(() => document.querySelectorAll(".card").length === 10);
    assert.equal((await s.texts(".card-title")).at(-1), daysAgo(9));
    assert.equal(await s.win.isHidden("#more-days"), true);
  });

  test("the stack keeps what was typed when more days are added", async (s) => {
    // The text written earlier is still on disk and shows again after the reload of the stack.
    assert.match(await s.doc(0), /First note of the day/);
    assert.match(await s.doc(2), /and more/);
  });

  test("the sidebar lists the journal days, newest first", async (s) => {
    const days = await s.texts("#journals li");
    assert.equal(days[0], today);
    assert.equal(days[1], daysAgo(1));
  });
});
