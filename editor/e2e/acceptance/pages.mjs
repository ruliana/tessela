// The pages mod (bundled, mods/pages): rename, move and delete a page, with a preview that comes
// from the CLI's dry run, so nothing changes on disk until the dialog is confirmed. It is the first
// user of the ui (dialog, toast), events and slots (page menu) hooks of the mod host.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { front, read, suite, write } from "../harness.mjs";

const files = () => ({});

async function runCommand(s, label) {
  await s.key("Control+k");
  await s.win.waitForSelector("#palette");
  await s.type(label);
  await s.win.waitForFunction((l) => [...document.querySelectorAll("#palette .palette-item .t")].some((e) => e.textContent === l), label);
  await s.key("Enter");
  await s.win.waitForFunction(() => !document.querySelector("#palette"));
}

/** Waits until the dialog's preview says `text` (a regex source). */
async function preview(s, pattern) {
  await s.win.waitForFunction((p) => new RegExp(p).test(document.querySelector("#dialog #pages-preview")?.textContent ?? ""), pattern);
}

async function gone(s) {
  await s.win.waitForFunction(() => !document.querySelector("#dialog"));
}

const title = (s) => s.win.textContent(".card-title");

async function fillName(s, text) {
  await s.win.fill("#dialog #pages-name", text);
}

suite("Pages mod: rename, move and delete", files, (test) => {
  test("Rename page… previews what will change, and renames only once confirmed", async (s) => {
    write(s.bundle, "ren-a.md", `${front()}See [t](/ren-target.md) and #ren-target.\n`);
    write(s.bundle, "ren-b.md", `${front()}Again [t](/ren-target.md).\n`);
    const before = read(s.bundle, "ren-a.md");
    await s.openWith("ren-target", "Hello");
    await runCommand(s, "Rename page…");
    await s.win.waitForSelector("#dialog #pages-name");
    await fillName(s, "ren-new");
    await preview(s, "3 references in 2 pages will change");
    // A preview only: the disk is as it was.
    assert.ok(existsSync(join(s.bundle, "ren-target.md")));
    assert.ok(!existsSync(join(s.bundle, "ren-new.md")));
    assert.equal(read(s.bundle, "ren-a.md"), before);
    await s.win.click('#dialog [data-action="ok"]');
    await gone(s);
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "ren-new");
    assert.ok(existsSync(join(s.bundle, "ren-new.md")));
    assert.ok(!existsSync(join(s.bundle, "ren-target.md")));
    assert.match(read(s.bundle, "ren-a.md"), /\[t\]\(\/ren-new\.md\) and #ren-new/);
    assert.match(read(s.bundle, "ren-b.md"), /\/ren-new\.md/);
    assert.match(await s.body(), /Hello/);
  });

  test("Escape closes the dialog and leaves everything as it was", async (s) => {
    await s.openWith("keep-me", "Stay");
    await runCommand(s, "Rename page…");
    await s.win.waitForSelector("#dialog #pages-name");
    await fillName(s, "keep-other");
    await preview(s, "will change|No other page");
    await s.key("Escape");
    await gone(s);
    assert.equal(await title(s), "keep-me");
    assert.ok(existsSync(join(s.bundle, "keep-me.md")));
    assert.ok(!existsSync(join(s.bundle, "keep-other.md")));
  });

  test("Move page… moves into a folder and the links follow", async (s) => {
    write(s.bundle, "mv-ref.md", `${front()}Go to [m](/mv-me.md).\n`);
    await s.openWith("mv-me", "Moving");
    await runCommand(s, "Move page…");
    await s.win.waitForSelector("#dialog #pages-name");
    await fillName(s, "stuff/");
    await preview(s, "1 reference in 1 page will change");
    await s.win.click('#dialog [data-action="ok"]');
    await gone(s);
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "stuff/mv-me");
    assert.ok(existsSync(join(s.bundle, "stuff/mv-me.md")));
    assert.ok(!existsSync(join(s.bundle, "mv-me.md")));
    assert.match(read(s.bundle, "mv-ref.md"), /\(\/stuff\/mv-me\.md\)/);
  });

  test("a name that is taken is refused in the preview and cannot be confirmed", async (s) => {
    write(s.bundle, "dup-b.md", `${front()}Already here.\n`);
    await s.openWith("dup-a", "Mine");
    await runCommand(s, "Rename page…");
    await s.win.waitForSelector("#dialog #pages-name");
    await fillName(s, "dup-b");
    await s.win.waitForSelector("#dialog #pages-preview .error");
    assert.equal(await s.win.isDisabled('#dialog [data-action="ok"]'), true);
    await s.key("Escape");
    await gone(s);
    assert.ok(existsSync(join(s.bundle, "dup-a.md")));
  });

  test("Delete page… names the pages that still mention it, then removes the file", async (s) => {
    write(s.bundle, "del-ref.md", `${front()}Was [d](/del-me.md).\n`);
    await s.openWith("del-me", "Bye");
    await s.saved();
    await runCommand(s, "Delete page…");
    await s.win.waitForSelector("#dialog");
    await preview(s, "del-ref");
    assert.ok(existsSync(join(s.bundle, "del-me.md")));
    await s.win.click('#dialog [data-action="ok"]');
    await gone(s);
    assert.ok(!existsSync(join(s.bundle, "del-me.md")));
    assert.ok(existsSync(join(s.bundle, "del-ref.md")));
    // The window no longer shows the page that is gone.
    await s.win.waitForFunction(() => ![...document.querySelectorAll(".card-title")].some((e) => e.textContent === "del-me"));
  });

  test("the page menu in the card head lists the actions of the mod", async (s) => {
    await s.openWith("menu-page", "x");
    await s.win.click(".card .page-menu-button");
    const items = await s.texts(".page-menu .menu-item");
    for (const label of ["Rename page…", "Move page…", "Delete page…"]) assert.ok(items.includes(label), items.join());
    await s.win.click('.page-menu .menu-item:has-text("Rename page…")');
    await s.win.waitForSelector("#dialog #pages-name");
    assert.equal(await s.win.inputValue("#dialog #pages-name"), "menu-page");
    await s.key("Escape");
    await gone(s);
  });

  test("editing a page's title offers to rename the file to match", async (s) => {
    await s.openWith("title-old", "");
    await s.type("# Brand new name");
    await s.win.waitForFunction(() => /Rename the file/.test(document.querySelector("#notice")?.textContent ?? ""));
    await s.win.click("#notice-action");
    await s.win.waitForSelector("#dialog #pages-name");
    assert.equal(await s.win.inputValue("#dialog #pages-name"), "brand-new-name");
    await preview(s, "No other page|will change");
    await s.win.click('#dialog [data-action="ok"]');
    await gone(s);
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "brand-new-name");
    assert.ok(existsSync(join(s.bundle, "brand-new-name.md")));
    assert.ok(!existsSync(join(s.bundle, "title-old.md")));
  });
});
