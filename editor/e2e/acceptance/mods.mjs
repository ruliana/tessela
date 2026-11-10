// Mods: code in the config folder's mods/<id>/main.js adds to the editor through `ctx`
// (commands, keys, the / menu, CodeMirror extensions, settings, the tessela CLI). The harness
// installs them into the profile, which is the config folder.

import assert from "node:assert/strict";
import { front, suite } from "../harness.mjs";

const files = () => ({
  "alpha.md": `${front()}Tagged #rust and #go.\n`,
  "beta.md": `${front()}Tagged #rust.\n`,
});

const hello = `export default (ctx) => {
  ctx.commands.add({ id: "hello", label: "Say hello from a mod", run: () => { document.body.dataset.modHello = "ran"; } });
};`;

const good = {
  hello,
  keys: `export default (ctx) => {
    ctx.commands.add({
      id: "stamp",
      label: "Stamp the page",
      keys: "Mod-Alt-j",
      run: ({ view }) => view.dispatch({ changes: { from: view.state.selection.main.head, insert: "STAMPED" } }),
    });
  };`,
  slash: `export default (ctx) => {
    ctx.slash.add({ label: "Signature", detail: "-- me", text: "-- me", cursor: 5, where: "anywhere" });
  };`,
  editor: `export default (ctx) => {
    ctx.editor.extend(ctx.cm.view.EditorView.editorAttributes.of({ "data-mod-editor": "on" }));
  };`,
  settings: `export default (ctx) => {
    document.body.dataset.modCount = String(ctx.settings.get("n") ?? 0);
    ctx.commands.add({ id: "count", label: "Count one more", run: () => ctx.settings.set("n", (ctx.settings.get("n") ?? 0) + 1) });
  };`,
  cli: `export default (ctx) => {
    ctx.commands.add({
      id: "vocab",
      label: "Count the concepts",
      run: async () => { document.body.dataset.modVocab = String((await ctx.cli(["vocab"])).concepts.length); },
    });
  };`,
  override: `export default (ctx) => {
    ctx.commands.add({ id: "today", label: "Go to today, the mod way", run: () => { document.body.dataset.modToday = "ran"; } });
  };`,
};

const palette = (s) => s.win.locator("#palette");
const items = (s) => s.texts("#palette .palette-item .t");

async function runCommand(s, label) {
  await s.key("Control+k");
  await palette(s).waitFor();
  await s.type(label);
  await s.win.waitForFunction((l) => [...document.querySelectorAll("#palette .palette-item .t")].some((e) => e.textContent === l), label);
  await s.key("Enter");
  await s.win.waitForFunction(() => !document.querySelector("#palette"));
}

suite("Mods in the config folder", files, (test) => {
  test("a mod adds a command to the palette, and running it runs the mod's code", async (s) => {
    await runCommand(s, "Say hello from a mod");
    assert.equal(await s.win.evaluate(() => document.body.dataset.modHello), "ran");
  });

  test("a command with keys runs from the editor with the editor's view", async (s) => {
    await s.open("alpha");
    await s.key("Control+Alt+j");
    assert.match(await s.body(), /STAMPED/);
  });

  test("a mod adds an item to the / menu", async (s) => {
    await s.open("beta");
    await s.type(" /Signat");
    // Wait for the item itself: the menu can be open, still listing what the first letters matched.
    await s.win.waitForSelector(".cm-tooltip-autocomplete li:has-text('Signature')");
    await s.key("Enter");
    assert.match(await s.body(), /-- me/);
  });

  test("a mod adds a CodeMirror extension to every editor", async (s) => {
    await s.open("alpha");
    assert.equal(await s.win.$$eval('.cm-editor[data-mod-editor="on"]', (e) => e.length > 0), true);
  });

  test("a mod's settings are kept when the window reloads", async (s) => {
    await runCommand(s, "Count one more");
    await runCommand(s, "Count one more");
    await s.win.reload();
    await s.win.waitForSelector(".cm-content");
    assert.equal(await s.win.evaluate(() => document.body.dataset.modCount), "2");
  });

  test("a mod runs the tessela CLI on the open notes folder", async (s) => {
    await runCommand(s, "Count the concepts");
    await s.win.waitForFunction(() => document.body.dataset.modVocab !== undefined);
    // #rust and #go, plus the concepts the pages themselves stand for.
    assert.ok(Number(await s.win.evaluate(() => document.body.dataset.modVocab)) >= 2);
  });

  test("a mod's command with the id of a built-in one takes its place", async (s) => {
    await s.key("Control+k");
    await palette(s).waitFor();
    await s.type("Go to today");
    await s.win.waitForFunction(() => document.querySelector("#palette .palette-item .t"));
    const list = await items(s);
    assert.ok(list.includes("Go to today, the mod way"), list.join());
    assert.ok(!list.includes("Go to today"), list.join());
    await s.key("Enter");
    await s.win.waitForFunction(() => document.body.dataset.modToday === "ran");
  });

  test("the palette can show which mods are loaded", async (s) => {
    await runCommand(s, "Show the mods");
    const text = await s.win.textContent("#notice");
    for (const id of Object.keys(good)) assert.ok(text.includes(id), text);
  });
}, { mods: good });

suite("Mods switched off", files, (test) => {
  test("--no-mods starts the editor without any mod", async (s) => {
    await s.key("Control+k");
    await palette(s).waitFor();
    await s.type("Say hello");
    assert.ok(!(await items(s)).includes("Say hello from a mod"));
    await s.key("Escape");
  });
}, { mods: { hello }, args: ["--no-mods"] });

suite("A broken mod", files, (test) => {
  test("the other mods and the editor still work, and the failure is listed", async (s) => {
    await runCommand(s, "Say hello from a mod");
    assert.equal(await s.win.evaluate(() => document.body.dataset.modHello), "ran");
    await s.open("alpha");
    await s.type("still typing");
    assert.match(await s.body(), /still typing/);
    await runCommand(s, "Show the mods");
    const text = await s.win.textContent("#notice");
    assert.ok(/broken/.test(text) && /on purpose/.test(text), text);
  });

  test("a command that throws is reported and does not stop the editor", async (s) => {
    await runCommand(s, "Throw from a mod");
    await s.open("beta");
    await s.type("fine");
    assert.match(await s.body(), /fine/);
  });
}, {
  mods: {
    hello,
    broken: `throw new Error("broken on purpose");`,
    thrower: `export default (ctx) => { ctx.commands.add({ id: "throw", label: "Throw from a mod", run: () => { throw new Error("boom"); } }); };`,
  },
});
