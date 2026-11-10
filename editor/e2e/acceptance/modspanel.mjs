// The Mods panel ("Show the mods" in the palette): every mod with where it comes from and whether it
// loaded, the error of one that failed, and a switch to turn a mod off or on. A switch is kept in the
// config folder's settings.json and takes effect when the window reloads ("Apply and reload").

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { front, suite } from "../harness.mjs";

const files = () => ({ "alpha.md": `${front()}Some text.\n` });

const hello = `export default (ctx) => {
  ctx.commands.add({ id: "hello", label: "Say hello from a mod", run: () => {} });
};`;

async function openPanel(s) {
  await s.key("Control+k");
  await s.win.locator("#palette").waitFor();
  await s.type("Show the mods");
  await s.key("Enter");
  await s.win.waitForSelector(".mods-panel");
}

const status = (s, id) => s.win.textContent(`.mod-row[data-mod="${id}"] .mod-status`);
const source = (s, id) => s.win.textContent(`.mod-row[data-mod="${id}"] .mod-source`);

/** Presses Apply and waits for the window to come back from its reload. */
async function apply(s) {
  const loaded = s.win.waitForEvent("load");
  await s.win.click(".dialog-actions .primary", { noWaitAfter: true });
  await loaded;
  await s.win.waitForSelector(".cm-content");
}

async function hasCommand(s, label) {
  await s.key("Control+k");
  await s.win.locator("#palette").waitFor();
  await s.type(label);
  await s.win.waitForTimeout(150);
  const found = (await s.texts("#palette .palette-item .t")).includes(label);
  await s.key("Escape");
  return found;
}

suite("The Mods panel", files, (test) => {
  test("lists the mods of the app and of the config folder, and says which failed and why", async (s) => {
    await openPanel(s);
    assert.equal(await source(s, "outline"), "app");
    assert.equal(await status(s, "outline"), "Loaded");
    assert.equal(await source(s, "hello"), "yours");
    assert.equal(await status(s, "hello"), "Loaded");
    assert.equal(await status(s, "broken"), "Failed");
    assert.match(await s.win.textContent('.mod-row[data-mod="broken"] .mod-error'), /on purpose/);
  });

  test("a mod switched off stays off after Apply, and on again after switching it back", async (s) => {
    assert.equal(await hasCommand(s, "Say hello from a mod"), true);
    await openPanel(s);
    assert.equal(await s.win.isDisabled(".dialog-actions .primary"), true, "nothing to apply yet");
    await s.win.uncheck('.mod-row[data-mod="hello"] input[type=checkbox]');
    await apply(s);
    assert.deepEqual(JSON.parse(readFileSync(resolve(s.profile, "settings.json"), "utf8")).mods.off, ["hello"]);
    assert.equal(await hasCommand(s, "Say hello from a mod"), false);
    await openPanel(s);
    assert.equal(await status(s, "hello"), "Off");
    await s.win.check('.mod-row[data-mod="hello"] input[type=checkbox]');
    await apply(s);
    assert.equal(await hasCommand(s, "Say hello from a mod"), true);
    assert.deepEqual(JSON.parse(readFileSync(resolve(s.profile, "settings.json"), "utf8")).mods.off, []);
  });

  test("an app mod can be switched off too, and the others go on", async (s) => {
    await openPanel(s);
    await s.win.uncheck('.mod-row[data-mod="outline"] input[type=checkbox]');
    await apply(s);
    assert.equal(await hasCommand(s, "Go to heading"), false);
    assert.equal(await hasCommand(s, "Say hello from a mod"), true);
  });
}, {
  mods: { hello, broken: `throw new Error("broken on purpose");` },
});

suite("The Mods panel with --no-mods", files, (test) => {
  test("says the mods are switched off and offers no switches", async (s) => {
    await openPanel(s);
    assert.match(await s.win.textContent(".mods-panel"), /--no-mods/);
    assert.equal(await s.win.locator(".mod-row input").count(), 0);
  });
}, { mods: { hello }, args: ["--no-mods"] });
