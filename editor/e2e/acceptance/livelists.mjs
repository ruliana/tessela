// The live-lists mod (bundled, mods/live-lists): a ```tessela code fence is drawn as the rows that
// `tessela fence` finds, under the fence. The rows are the window's; nothing is written to the page.

import assert from "node:assert/strict";
import { front, read, suite, write } from "../harness.mjs";

const files = () => ({
  "alpha.md": `${front()}Tagged #rust and #go.\n`,
  "beta.md": `${front()}Tagged #rust.\n`,
});

const fence = (command, info = "tessela") => `\`\`\`${info}\n${command}\n\`\`\`\n`;
const rows = (s) => s.texts(".tessela-live .tessela-row");

/**
 * Opens a page with `body`, the cursor at its end. The harness's own `openWith` clicks the middle
 * of the page, where a row of a list that has already arrived would be; this clicks the first line.
 */
async function openWith(s, name, body) {
  write(s.bundle, `${name}.md`, front() + body);
  await s.win.fill("#search", name);
  await s.win.press("#search", "Enter");
  await s.win.waitForFunction((n) => document.querySelector(".card-title")?.textContent === n, name);
  await s.win.click(".cm-line");
  await s.key("Control+End");
}

async function rowsAre(s, count) {
  await s.win.waitForFunction((n) => document.querySelectorAll(".tessela-live .tessela-row").length === n, count);
  return rows(s);
}

suite("Live lists", files, (test) => {
  test("a tessela fence shows its rows under it, and only a tessela fence does", async (s) => {
    const body = `${fence("query --ref rust")}\n${fence("query --ref go", "sh")}`;
    await openWith(s, "lists", body);
    const list = await rowsAre(s, 2);
    assert.ok(list.some((r) => r.includes("alpha.md")) && list.some((r) => r.includes("beta.md")), list.join("|"));
    assert.equal(await s.win.$$eval(".tessela-live", (e) => e.length), 1);
  });

  test("the rows are never written into the page", async (s) => {
    const before = `${front()}${fence("query --ref rust")}`;
    await openWith(s, "quiet", fence("query --ref rust"));
    await rowsAre(s, 2);
    assert.ok(!(await s.body()).includes("alpha.md"));
    // Type, wait for the save: the file holds the fence and what was typed, no rows.
    await s.type("note");
    await s.saved();
    assert.equal(read(s.bundle, "quiet.md"), `${before}note`);
  });

  test("filters work: a pipe sorts, cuts and counts", async (s) => {
    await openWith(s, "piped", `${fence("query --ref rust | sort -r | head 1")}\n${fence("query --ref rust | wc -l")}`);
    await s.win.waitForFunction(() => document.querySelectorAll(".tessela-live").length === 2);
    await s.win.waitForFunction(() => [...document.querySelectorAll(".tessela-live")].every((e) => e.textContent.length > 0));
    const lists = await s.texts(".tessela-live");
    assert.match(lists[0], /^beta\.md:/);
    assert.equal(lists[1].trim(), "2");
  });

  test("clicking a row opens its page", async (s) => {
    await openWith(s, "opener", fence("query --ref go"));
    await rowsAre(s, 1);
    await s.win.click(".tessela-live .tessela-row");
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "alpha");
  });

  test("a bad command says why, and the page is untouched", async (s) => {
    await openWith(s, "bad", fence("rm -rf /"));
    await s.win.waitForSelector(".tessela-live .tessela-error");
    assert.match(await s.win.textContent(".tessela-live .tessela-error"), /cannot read the command/);
    assert.match(await s.body(), /rm -rf \//);
  });

  test("an empty answer says so", async (s) => {
    await openWith(s, "empty", fence("query --ref nothing-has-this"));
    await s.win.waitForSelector(".tessela-live .tessela-empty");
  });

  test("editing the command updates the rows", async (s) => {
    await openWith(s, "edit", fence("query --ref rust"));
    await rowsAre(s, 2);
    // From the end of the page (an empty line): up over the closing fence, to the command.
    await s.key("ArrowUp");
    await s.key("ArrowUp");
    await s.key("End");
    await s.type(" --ref go");
    await rowsAre(s, 1);
  });

  test("the rows follow the notes when a page changes on disk", async (s) => {
    await openWith(s, "follow", fence("query --ref rust"));
    await rowsAre(s, 2);
    write(s.bundle, "gamma.md", `${front()}Also #rust.\n`);
    await rowsAre(s, 3);
  });
});
