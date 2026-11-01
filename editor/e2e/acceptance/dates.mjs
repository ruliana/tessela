// Dates lead to their journal day: in the text (a plain click where the line is drawn, Ctrl/Cmd+click
// where it is typed), in a table, in the page's properties and in the backlinks. A day without a
// file opens empty, and gets its file on the first edit like any other journal.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { front, suite } from "../harness.mjs";

const SOURCE = "plan";
const withDay = "2026-10-20";
const bare = "2026-10-15";

const files = () => ({
  [`journals/${withDay}.md`]: `---\ntype: journal\ndate: ${withDay}\n---\n\nEntry on the 20th\n`,
  [`${SOURCE}.md`]: `${front()}Kickoff is ${withDay}, and ${bare} has no file yet.\n\nLast line.\n`,
  "table.md": `${front()}| When | What |\n| --- | --- |\n| ${bare} | review |\n\nLast line.\n`,
  "dated.md": `---\ntype: concept\ntitle: Dated\ndate: ${bare}\n---\n\nSome text.\n`,
  "address.md": `${front()}See https://example.com/${withDay}/notes for it.\n\nLast line.\n`,
});

const title = (s) => s.win.textContent(".card-title");
const onDay = (s, day) => s.win.waitForFunction((d) => document.querySelector(".card-title")?.textContent === d, day);
const stays = async (s, name) => {
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await title(s), name);
};

suite("Dates in typed Markdown", files, (test) => {
  test("a plain click on a date only puts the cursor there", async (s) => {
    await s.open(SOURCE);
    await s.win.click(`.cm-date:has-text('${withDay}')`);
    await stays(s, SOURCE);
  });

  test("Ctrl+click on a date opens that day of the journal", async (s) => {
    await s.win.click(`.cm-date:has-text('${withDay}')`, { modifiers: ["Control"] });
    await onDay(s, withDay);
    assert.match(await s.doc(), /Entry on the 20th/);
  });

  test("the backlinks of the day show a date as a link to its own day", async (s) => {
    await s.win.waitForSelector(".backlinks .hit .date");
    assert.deepEqual(await s.texts(".backlinks .hit .date"), [withDay, bare]);
    await s.win.click(`.backlinks .hit .date:has-text('${bare}')`);
    await onDay(s, bare);
  });

  test("a day without a file opens empty and is only created by writing in it", async (s) => {
    assert.equal(existsSync(join(s.bundle, "journals", `${bare}.md`)), false);
    assert.equal(await s.status(), "New page");
    await s.win.click(".cm-content");
    await s.key("Control+End");
    await s.type("Wrote on the 15th");
    await s.saved();
    assert.match(await s.savedBody(`journals/${bare}`), /Wrote on the 15th/);
  });

  test("a date inside a web address is not a link to a day", async (s) => {
    await s.open("address");
    await s.win.click(`.cm-date:has-text('${withDay}')`, { modifiers: ["Control"] });
    await stays(s, "address");
  });
});

suite(
  "Dates in rendered Markdown",
  files,
  (test) => {
    test("a plain click on a date opens its day", async (s) => {
      await s.open(SOURCE);
      await s.win.click(`.cm-date:has-text('${bare}')`);
      await onDay(s, bare);
      assert.equal(await s.status(), "New page");
    });

    test("a date in a table cell opens its day", async (s) => {
      await s.open("table");
      await s.win.waitForSelector(".cm-lp-table a.date");
      await s.win.click(".cm-lp-table a.date");
      await onDay(s, bare);
    });

    test("the date in the properties of a page opens its day", async (s) => {
      await s.open("dated");
      await s.win.waitForSelector(".cm-props-day");
      await s.win.click(".cm-props-day");
      await onDay(s, bare);
    });
  },
  { rendered: true },
);
