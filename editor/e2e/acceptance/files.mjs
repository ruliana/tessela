// The notes folder (the root), new pages and opening files (spec §11).
// The native file dialogs cannot be driven, so a test says what the dialog answers.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { front, makeBundle, read, suite, write } from "../harness.mjs";

/** The next dialog the app opens answers with `filePaths` (empty: the user cancels). */
function answerDialog(s, ...filePaths) {
  return s.app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: paths.length === 0, filePaths: paths });
  }, filePaths);
}

const cardTitle = (s) => s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent);

async function newPage(s, name) {
  await s.win.click("#new-page");
  await s.win.fill("#new-page-name", name);
  await s.win.press("#new-page-name", "Enter");
}

function bundle() {
  return {
    "index.md": "---\nokf_version: 0.2\n---\n\nThe root index.\n",
    "log.md": "# Log\n\nA reserved file, still openable.\n",
    "people/ana.md": `${front("person")}Ana works on the editor.\n`,
  };
}

suite("Files and the notes folder", bundle, (test) => {
  test("the sidebar shows which folder is the root, with its full path", async (s) => {
    assert.equal(await s.win.textContent("#root .root-name"), basename(s.bundle));
    assert.equal(await s.win.textContent("#root .root-path"), s.bundle);
    assert.match(await s.win.getAttribute("#root", "title"), new RegExp(s.bundle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  test("New page creates the file at once, with a title from the name", async (s) => {
    await newPage(s, "My Big Idea");
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "my-big-idea");
    assert.equal(await s.win.isHidden("#new-page-form"), true);
    const text = read(s.bundle, "my-big-idea.md");
    assert.match(text, /^---\ntype: concept\ntitle: "My Big Idea"\n---\n/);
    // The new page is listed and the cursor is in it, so typing goes there.
    assert.ok((await s.texts("#pages .name")).includes("my-big-idea"));
    await s.win.click(".cm-content");
    await s.key("Control+End");
    await s.type("First words");
    await s.saved();
    assert.match(read(s.bundle, "my-big-idea.md"), /First words/);
  });

  test("a slash in the name puts the page in a folder", async (s) => {
    await newPage(s, "projects/Tessela Editor");
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "projects/tessela-editor");
    assert.ok(existsSync(join(s.bundle, "projects", "tessela-editor.md")));
  });

  test("New page on a name that exists opens it and keeps its text", async (s) => {
    await newPage(s, "people/ana");
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "people/ana");
    assert.match(await s.doc(), /Ana works on the editor/);
    assert.match(read(s.bundle, "people/ana.md"), /Ana works on the editor/);
  });

  test("New page refuses an empty or hidden name and says why", async (s) => {
    for (const bad of ["   ", ".secret/x", "../escape"]) {
      await newPage(s, bad);
      await s.win.waitForSelector("#new-page-error:not([hidden])");
      assert.match(await s.win.textContent("#new-page-error"), /name/);
      await s.win.click("#new-page-name", { clickCount: 3 });
    }
    assert.equal(existsSync(join(s.bundle, ".secret")), false);
    assert.equal(existsSync(join(s.bundle, "..", "escape.md")), false);
    await s.key("Escape");
    assert.equal(await s.win.isHidden("#new-page-form"), true);
  });

  test("Ctrl+N asks for a new page and Ctrl+O opens a file", async (s) => {
    await s.win.click(".cm-content");
    await s.key("Control+n");
    await s.win.waitForSelector("#new-page-name", { state: "visible" });
    assert.equal(await s.win.evaluate(() => document.activeElement?.id), "new-page-name");
    await s.key("Escape");
    await answerDialog(s, join(s.bundle, "log.md"));
    await s.key("Control+o");
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "log");
  });

  test("Open file shows a file of the notes folder, even a reserved one", async (s) => {
    await answerDialog(s, join(s.bundle, "index.md"));
    await s.win.click("#open-file");
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "index");
    assert.match(await s.doc(), /The root index/);
  });

  test("Open file edits and saves a file of a folder in the notes folder", async (s) => {
    await answerDialog(s, join(s.bundle, "people", "ana.md"));
    await s.win.click("#open-file");
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "people/ana");
    await s.win.click(".cm-content");
    await s.key("Control+End");
    await s.type(" Also a test.");
    await s.saved();
    assert.match(read(s.bundle, "people/ana.md"), /Also a test\./);
  });

  test("cancelling the dialog changes nothing", async (s) => {
    await answerDialog(s);
    await s.win.click("#open-file");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await s.win.textContent(".card-title"), "people/ana");
    assert.equal(await s.win.isHidden("#notice"), true);
    await s.win.click("#root");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await s.win.textContent("#root .root-path"), s.bundle);
  });

  test("a file outside the root offers its folder as the new root", async (s) => {
    const other = makeBundle({ "elsewhere.md": `${front()}Lives in another folder.\n` });
    await answerDialog(s, join(other, "elsewhere.md"));
    await s.win.click("#open-file");
    await s.win.waitForSelector("#notice:not([hidden])");
    assert.match(await s.win.textContent("#notice"), /outside the notes folder/);
    // Nothing changed yet: the old root is still the root.
    assert.equal(await s.win.textContent("#root .root-path"), s.bundle);
    await s.win.click("#notice-action");
    await s.win.waitForFunction((p) => document.querySelector("#root .root-path")?.textContent === p, other);
    await s.win.waitForSelector("#pages button:has-text('elsewhere')");
    await s.win.click("#pages button:has-text('elsewhere')");
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "elsewhere");
    assert.match(await s.doc(), /Lives in another folder/);
  });

  test("the root can be chosen from the sidebar, and pages follow it", async (s) => {
    const third = makeBundle({ "third.md": `${front()}The third folder.\n` });
    await answerDialog(s, third);
    await s.win.click("#root");
    await s.win.waitForFunction((p) => document.querySelector("#root .root-path")?.textContent === p, third);
    await s.win.waitForSelector("#pages button:has-text('third')");
    assert.ok(!(await s.texts("#pages .name")).includes("elsewhere"));
    // New pages now go to the new root.
    await newPage(s, "created here");
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "created-here");
    assert.ok(existsSync(join(third, "created-here.md")));
    assert.equal(existsSync(join(s.bundle, "created-here.md")), false);
  });
});
