// The related mod (bundled, mods/related): in place of a graph, a group in the right column with
// what is mentioned together with the open page (and why) and the home pages that lead to it,
// from `tessela related`. Nothing is written to the notes.

import assert from "node:assert/strict";
import { front, suite, write } from "../harness.mjs";

const files = () => ({
  "home.md": `${front("home")}# Home\n\nStart at [Projects](/project/home.md).\n`,
  "project/home.md": `${front("home")}# Projects\n\n[Tessela](/project/tessela.md)\n`,
  "project/tessela.md": `${front()}# Tessela\n\nThe editor.\n`,
  "rust.md": `${front()}# Rust\n`,
  "notes.md": `${front()}Wrote [Tessela](/project/tessela.md) in [Rust](/rust.md) with #cli.\n\nAgain [Tessela](/project/tessela.md) and #cli.\n`,
  "lonely.md": `${front()}Nothing is said with it.\n`,
  "journals/2026-03-04.md": `${front("journal")}[Tessela](/project/tessela.md) and [Rust](/rust.md).\n`,
});

const group = "#backlinks .bl-group.related";
const items = (s) => s.texts(`${group} .related-item`);

/** Shows a page without taking the cursor into it, so a nested path works too. */
async function show(s, path) {
  await s.win.fill("#search", path);
  await s.win.press("#search", "Enter");
    await s.win.waitForFunction((n) => document.querySelector(".card-title")?.textContent === n, path);
}

suite("Related mod", files, (test) => {
  test("a page lists what is mentioned with it, most often first, each with its reason", async (s) => {
    await show(s, "project/tessela");
    await s.win.waitForSelector(`${group} .related-item`);
    assert.match(await s.win.textContent(`${group} h3`), /^Related/);
    const list = await items(s);
    assert.equal(list.length, 2, list.join("|"));
    assert.ok(list.some((r) => /^cli.*together in 2 blocks/.test(r)) && list.some((r) => /^rust.*together in/.test(r)), list.join("|"));
  });

  test("a related page opens when clicked, and a concept without a page is plain text", async (s) => {
    await show(s, "project/tessela");
    await s.win.waitForSelector(`${group} .related-item`);
    assert.equal(await s.win.$$eval(`${group} .related-item.nopage button`, (e) => e.length), 0);
    assert.equal(await s.win.$$eval(`${group} .related-item.nopage`, (e) => e.length), 1);
    await s.win.click(`${group} .related-item:has-text("rust") .related-name`);
    await s.win.waitForFunction(() => [...document.querySelectorAll(".card-title")].some((t) => t.textContent === "rust"));
  });

  test("the home pages that lead to the page are listed, the root's first, and open when clicked", async (s) => {
    await show(s, "project/tessela");
    await s.win.waitForSelector(`${group} .related-home`);
    assert.deepEqual(await s.texts(`${group} .related-home`), ["Home", "project"]);
    await s.win.click(`${group} .related-home:has-text("project")`);
    await s.win.waitForFunction(() => [...document.querySelectorAll(".cm-line")].some((l) => l.textContent === "# Projects"));
  });

  test("a page with nothing around it, and a journal day, have no group", async (s) => {
    await show(s, "lonely");
    await s.win.waitForTimeout(300);
    assert.equal(await s.win.$$eval(group, (e) => e.length), 0);
    await show(s, "2026-03-04");
    await s.win.waitForTimeout(300);
    assert.equal(await s.win.$$eval(group, (e) => e.length), 0);
  });

  test("a mention written after the page was opened shows up", async (s) => {
    await show(s, "project/tessela");
    await s.win.waitForFunction(() => document.querySelectorAll("#backlinks .bl-group.related .related-item").length === 2);
    write(s.bundle, "later.md", `${front()}[Tessela](/project/tessela.md) and #fresh.\n\nMore [Tessela](/project/tessela.md) #fresh.\n\nOnce more [Tessela](/project/tessela.md) #fresh.\n`);
    await s.win.waitForFunction(() => document.querySelectorAll("#backlinks .bl-group.related .related-item").length === 3);
    assert.match((await items(s))[0], /fresh/);
  });
});
