// Home pages: a link from a `home.md` says the page matters, so in the backlinks those mentions
// come first, the most specific folder's home first, marked and tinted.

import assert from "node:assert/strict";
import { front, suite } from "../harness.mjs";

const home = (title) => `---\ntype: home\ntitle: ${title}\n---\n\nStart with [Topic](/topic.md).\n`;

const files = () => ({
  "topic.md": `${front()}What it is.\n\nLast line.\n`,
  "a-note.md": `${front()}This mentions [Topic](/topic.md) too.\n\nLast line.\n`,
  "home.md": home("Home"),
  "sub/home.md": home("Sub home"),
});

suite("Home pages in the backlinks", files, (test) => {
  test("home pages come first, the most specific folder's first, and are marked", async (s) => {
    await s.open("topic");
    await s.win.waitForSelector("#backlinks .bl-group");
    assert.deepEqual(await s.texts("#backlinks .bl-group h3 button"), ["sub/home", "home", "a-note"]);
    assert.deepEqual(await s.texts("#backlinks .bl-home"), ["Home", "Home"]);
    assert.equal(await s.win.$$eval("#backlinks .bl-group.home", (els) => els.length), 2);
  });

  test("a page that no home page links to has plain backlinks", async (s) => {
    await s.open("a-note");
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "a-note");
    await s.win.waitForSelector("#backlinks .empty");
    assert.equal(await s.win.$$eval("#backlinks .bl-home", (els) => els.length), 0);
  });
});
