// The favorites mod (bundled, mods/favorites): a page is marked as a favorite from the palette, the
// key or the page menu, and the marked pages are listed in the sidebar above Recent. The marks are
// the window's, kept in the mod's settings by notes folder: nothing is written to the notes.

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { front, read, suite, write } from "../harness.mjs";

const files = () => ({
  "fav-one.md": `${front()}# One\n`,
  "fav-two.md": `${front()}# Two\n`,
  "projects/fav-deep.md": `${front()}# Deep\n`,
});

const names = (s) => s.texts("#favorites .fav-open .name");

async function runCommand(s, label) {
  await s.key("Control+k");
  await s.win.waitForSelector("#palette");
  await s.type(label);
  await s.win.waitForFunction((l) => [...document.querySelectorAll("#palette .palette-item .t")].some((e) => e.textContent === l), label);
  await s.key("Enter");
  await s.win.waitForFunction(() => !document.querySelector("#palette"));
}

async function listed(s, expected) {
  await s.win.waitForFunction((e) => JSON.stringify([...document.querySelectorAll("#favorites .fav-open .name")].map((n) => n.textContent)) === JSON.stringify(e), expected);
}

suite("Favorites mod: marked pages above Recent", files, (test) => {
  test("nothing is drawn until a page is marked; Toggle favorite marks the open page and unmarks it", async (s) => {
    await s.open("fav-one");
    assert.equal(await s.win.locator("#favorites").count(), 0);
    await runCommand(s, "Toggle favorite");
    await listed(s, ["fav-one"]);
    await runCommand(s, "Toggle favorite");
    await s.win.waitForSelector("#favorites", { state: "detached" });
  });

  test("favorites are listed above Recent, in the order they were marked, and open their page", async (s) => {
    await s.open("fav-two");
    await runCommand(s, "Toggle favorite");
    await s.open("fav-one");
    await s.key("Control+Alt+f"); // the key of Toggle favorite
    await listed(s, ["fav-two", "fav-one"]);
    const above = await s.win.evaluate(() => document.querySelector("#favorites").compareDocumentPosition(document.querySelector("#recent")) & Node.DOCUMENT_POSITION_FOLLOWING);
    assert.ok(above, "Favorites comes before Recent");
    await s.open("projects/fav-deep");
    await s.win.click('#favorites .fav-open:has-text("fav-two")');
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "fav-two");
  });

  test("the star beside a favorite takes it off the list, and the page menu marks the page", async (s) => {
    await s.win.click('#favorites li:has-text("fav-two") .fav-off');
    await listed(s, ["fav-one"]);
    await s.open("fav-two");
    await s.win.click(".page-menu-button");
    await s.win.click('.page-menu .menu-item:has-text("Toggle favorite")');
    await listed(s, ["fav-one", "fav-two"]);
  });

  test("marks are the window's: they survive a reload, and the notes are left as they were", async (s) => {
    const before = readdirSync(s.bundle).sort();
    const text = read(s.bundle, "fav-one.md");
    await s.win.reload();
    await s.win.waitForSelector(".cm-content");
    await listed(s, ["fav-one", "fav-two"]);
    assert.deepEqual(readdirSync(s.bundle).sort(), before);
    assert.equal(read(s.bundle, "fav-one.md"), text);
  });

  test("renaming a favorite keeps it a favorite; deleting it removes it; one deleted outside is hidden", async (s) => {
    await s.open("fav-two");
    await runCommand(s, "Rename page…");
    await s.win.fill("#dialog #pages-name", "fav-renamed");
    await s.win.waitForSelector('#dialog [data-action="ok"]:not([disabled])');
    await s.win.click('#dialog [data-action="ok"]');
    await s.win.waitForFunction(() => !document.querySelector("#dialog"));
    await listed(s, ["fav-one", "fav-renamed"]);

    await s.saved();
    await s.win.click(".cm-content");
    await runCommand(s, "Delete page…");
    await s.win.waitForSelector('#dialog [data-action="ok"]:not([disabled])');
    await s.win.click('#dialog [data-action="ok"]');
    await s.win.waitForFunction(() => !document.querySelector("#dialog"));
    await listed(s, ["fav-one"]);

    // Removed by an agent or by git: the entry is hidden, the notes are not touched.
    const { rmSync } = await import("node:fs");
    rmSync(join(s.bundle, "fav-one.md"));
    await s.win.waitForSelector("#favorites", { state: "detached" });
    assert.ok(!existsSync(join(s.bundle, "fav-one.md")));
    write(s.bundle, "fav-one.md", `${front()}# One again\n`);
    await listed(s, ["fav-one"]);
  });
});
