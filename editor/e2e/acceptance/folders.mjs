// The folders mod (bundled, mods/folders): a view of one folder, built from `tessela index --dir`.
// It is the first user of the views hook (a mod's own view in the middle of the window).

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { front, read, suite, write } from "../harness.mjs";

const files = () => ({
  "home.md": `${front("home")}# Start here\n\nRead [Ada](people/ada.md) first.\n`,
  "people/ada.md": `---\ntype: concept\ndescription: Wrote the first program\n---\n\nAda.\n`,
  "people/bob.md": `${front()}Bob.\n`,
  "projects/plan.md": `${front()}A plan.\n`,
  "projects/sub/deep.md": `${front()}Deep.\n`,
  "logs/2026-11-01.md": `${front("journal")}one\n`,
  "logs/2026-11-02.md": `${front("journal")}two\n`,
});

const view = ".mod-view";
const names = (s, selector) => s.win.$$eval(`${view} ${selector}`, (e) => e.map((x) => x.textContent));

async function show(s, folder = "") {
  await s.win.click("#view-folders");
  await s.win.waitForSelector(`${view}[data-view="folders"] .folders-here`);
  if (folder) await goDown(s, folder);
}

/** Opens the folder shown in the list by its name (`people`, not `people/`). */
async function goDown(s, name) {
  await s.win.click(`${view} .folders-folder:has-text("${name}")`);
  await s.win.waitForFunction((n) => document.querySelector(".mod-view .folders-here")?.textContent.endsWith(n), name);
}

const title = (s) => s.win.textContent(".card-title");
const palette = async (s, label) => {
  await s.key("Control+k");
  await s.win.waitForSelector("#palette");
  await s.type(label);
  await s.win.waitForFunction((l) => [...document.querySelectorAll("#palette .palette-item .t")].some((e) => e.textContent === l), label);
  await s.key("Enter");
};

suite("Folders mod", files, (test) => {
  test("the sidebar's Folders row shows the root: its folders with their page counts, and its pages", async (s) => {
    await show(s);
    const folders = await names(s, ".folders-folder");
    for (const [name, count] of [["people", "2"], ["projects", "2"], ["logs", "2"]]) {
      assert.ok(folders.some((f) => f.includes(name) && f.includes(count)), `${name} ${count}: ${folders.join("|")}`);
    }
    // The folder's own pages: only the pages of the root, not what is below it.
    const pages = await names(s, ".folders-pages .folders-title");
    assert.ok(pages.includes("home"), pages.join("|"));
    assert.ok(!pages.includes("ada"), pages.join("|"));
  });

  test("a folder's pages show their description, and clicking one opens it", async (s) => {
    await show(s, "people");
    const pages = await names(s, ".folders-pages .folders-page");
    assert.ok(pages.some((p) => p.includes("ada") && p.includes("Wrote the first program")), pages.join("|"));
    await s.win.click(`${view} .folders-pages .folders-page:has-text("ada")`);
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "people/ada");
    assert.equal(await s.win.$$eval(view, (e) => e.length), 0);
  });

  test("the breadcrumb goes up, and Go back returns to the folder before", async (s) => {
    await show(s, "projects");
    await goDown(s, "sub");
    assert.equal((await s.win.textContent(`${view} .folders-here`)).trim(), "projects/sub");
    await s.win.click(`${view} .folders-crumb:has-text("projects")`);
    await s.win.waitForFunction(() => document.querySelector(".mod-view .folders-here")?.textContent === "projects");
    await s.win.click("#go-back");
    await s.win.waitForFunction(() => document.querySelector(".mod-view .folders-here")?.textContent === "projects/sub");
    await s.win.click(`${view} .folders-crumb:has-text("Notes")`);
    await s.win.waitForFunction(() => document.querySelector(".mod-view .folders-here")?.textContent === "Notes");
  });

  test("a folder with a home page shows where to start: the home page and what it links to", async (s) => {
    await show(s);
    const start = await names(s, ".folders-start .folders-page");
    assert.ok(start.some((p) => p.includes("ada")), start.join("|"));
    await s.win.click(`${view} .folders-open-home`);
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "home");
  });

  test("a folder without one offers to write it, and writes a home page only when asked", async (s) => {
    await show(s, "projects");
    assert.ok(!existsSync(join(s.bundle, "projects/home.md")));
    assert.equal(await s.win.$$eval(`${view} .folders-open-home`, (e) => e.length), 0);
    await s.win.click(`${view} .folders-write-home`);
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "projects/home");
    assert.match(read(s.bundle, "projects/home.md"), /type: home/);
    // The folder now has its home page.
    await show(s, "projects");
    await s.win.waitForSelector(`${view} .folders-open-home`);
  });

  test("a folder's journal days are listed newest first", async (s) => {
    await show(s, "logs");
    const days = await names(s, ".folders-journal .folders-page");
    assert.equal(days.length, 2);
    assert.ok(days[0].includes("2026-11-02") && days[1].includes("2026-11-01"), days.join("|"));
  });

  test("the view follows the notes when a page appears on disk", async (s) => {
    await show(s, "people");
    write(s.bundle, "people/carol.md", `${front()}Carol.\n`);
    await s.win.waitForFunction(() => [...document.querySelectorAll(".mod-view .folders-pages .folders-page")].some((e) => e.textContent.includes("carol")));
  });

  test("the palette and a page's menu show the folder of the page", async (s) => {
    await s.open("people/bob");
    await palette(s, "Show folders");
    await s.win.waitForFunction(() => document.querySelector(".mod-view .folders-here")?.textContent === "people");
    await s.win.click(`${view} .folders-pages .folders-page:has-text("ada")`);
    await s.win.waitForSelector(".card .page-menu-button");
    await s.win.click(".card .page-menu-button");
    await s.win.click('.page-menu .menu-item:has-text("Show folder")');
    await s.win.waitForFunction(() => document.querySelector(".mod-view .folders-here")?.textContent === "people");
  });

  test("the sidebar row is marked while the view is shown, and the editor comes back by opening a page", async (s) => {
    await show(s);
    assert.equal(await s.win.getAttribute("#view-folders", "aria-current"), "page");
    await s.win.click("#journals-view");
    await s.win.waitForSelector(".card");
    assert.equal(await s.win.$$eval(view, (e) => e.length), 0);
    assert.equal(await s.win.getAttribute("#view-folders", "aria-current"), null);
  });
});
