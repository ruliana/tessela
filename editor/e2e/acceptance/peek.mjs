// The peek mod (bundled, mods/peek): one page, concept or day shown at the top of the right column
// for the link the cursor is in, without leaving the page being written. It is the first user of the
// side-top slot, and shows the same card the journal stack uses, so it can be edited.

import assert from "node:assert/strict";
import { front, read, suite, write } from "../harness.mjs";

const files = () => ({
  "peek-target.md": `${front()}# Peek target\n\nTarget body.\n`,
  "peek-other.md": `${front()}Also see [t](/peek-target.md) and #peek-ghost and 2026-03-04.\n`,
  "journals/2026-03-04.md": `${front("journal")}Day text.\n`,
});

async function runCommand(s, label) {
  await s.key("Control+k");
  await s.win.waitForSelector("#palette");
  await s.type(label);
  await s.win.waitForFunction((l) => [...document.querySelectorAll("#palette .palette-item .t")].some((e) => e.textContent === l), label);
  await s.key("Enter");
  await s.win.waitForFunction(() => !document.querySelector("#palette"));
}

/** A page whose text is `body`, with the cursor one character into `marker` (found in what the editor shows). */
async function pageWith(s, name, body, marker) {
  await s.openWith(name, body);
  const text = await s.doc();
  const at = text.indexOf(marker);
  assert.ok(at >= 0, `${marker} is in the page`);
  const line = text.slice(0, at).split("\n").length - 1;
  const column = at - (text.lastIndexOf("\n", at - 1) + 1) + 1;
  await s.key("Control+Home");
  for (let i = 0; i < line; i++) await s.key("ArrowDown");
  await s.key("Home");
  for (let i = 0; i < column; i++) await s.key("ArrowRight");
}

const peek = (s) => s.win.locator("#side-top #peek");
const gone = (s) => s.win.waitForFunction(() => !document.querySelector("#side-top #peek"));

suite("Peek mod", files, (test) => {
  test("Peek at the link under the cursor shows the page above the backlinks, and it can be edited", async (s) => {
    await pageWith(s, "peek-a", "Read [t](/peek-target.md) now.\n", "(/peek");
    await runCommand(s, "Peek at the link under the cursor");
    await s.win.waitForSelector("#side-top #peek .card");
    assert.equal(await s.win.textContent("#peek .card-title"), "peek-target");
    // The page being written stays where it was, and the peek sits above the backlinks.
    assert.equal(await s.win.textContent(".pane .card-title"), "peek-a");
    assert.ok(await s.win.evaluate(() => !!document.querySelector("#backlinks #side-top + *")));
    assert.match(await s.win.textContent("#peek .card .cm-content"), /Target body\./);
    // Editing the peek saves the peeked page.
    await s.win.click("#peek .cm-content");
    await s.key("Control+End");
    await s.type(" Added in peek.");
    await s.win.waitForFunction(() => /Saved/.test(document.querySelector("#peek .status")?.textContent ?? ""));
    assert.match(read(s.bundle, "peek-target.md"), /Added in peek\./);
  });

  test("Escape closes the peek and puts the cursor back; Enter goes to the page", async (s) => {
    await pageWith(s, "peek-b", "Read [t](/peek-target.md) now.\n", "(/peek");
    await runCommand(s, "Peek at the link under the cursor");
    await peek(s).waitFor();
    await s.key("Escape");
    await gone(s);
    // The cursor is back in the page being written.
    await s.type("X");
    assert.match(await s.body(), /X/);
    await s.key("Backspace");
    await runCommand(s, "Peek at the link under the cursor");
    await peek(s).waitFor();
    await s.win.waitForSelector("#peek .card .cm-content");
    await s.key("Enter");
    await s.win.waitForFunction(() => document.querySelector(".pane .card-title")?.textContent === "peek-target");
    await gone(s);
  });

  test("a concept with no page shows what mentions it, and a mention leads there", async (s) => {
    await pageWith(s, "peek-c", "Think of #peek-ghost here.\n", "#peek-ghost");
    await runCommand(s, "Peek at the link under the cursor");
    await peek(s).waitFor();
    assert.match(await s.win.textContent("#peek"), /not written yet/);
    await s.win.waitForSelector("#peek .peek-mentions .hit");
    const hits = await s.texts("#peek .peek-mentions .hit");
    assert.ok(hits.some((h) => /Also see/.test(h)), hits.join("|"));
    await s.win.click('#peek .peek-mentions .hit:has-text("Also see")');
    await s.win.waitForFunction(() => document.querySelector(".pane .card-title")?.textContent === "peek-other");
  });

  test("a date shows its journal day and what mentions it", async (s) => {
    await pageWith(s, "peek-d", "Due 2026-03-04 sharp.\n", "2026-03-04");
    await runCommand(s, "Peek at the link under the cursor");
    await s.win.waitForSelector("#peek .peek-mentions .hit");
    await s.win.waitForFunction(() => /Day text\./.test(document.querySelector("#peek .card .cm-content")?.textContent ?? ""));
    const hits = await s.texts("#peek .peek-mentions .hit");
    assert.ok(hits.some((h) => /Also see/.test(h)), hits.join("|"));
  });

  test("with the cursor outside a link it says so, and a second peek replaces the first", async (s) => {
    await pageWith(s, "peek-e", "Plain words and [t](/peek-target.md) and #peek-ghost.\n", "Plain");
    await runCommand(s, "Peek at the link under the cursor");
    await s.win.waitForFunction(() => /link/.test(document.querySelector("#notice")?.textContent ?? ""));
    assert.equal(await peek(s).count(), 0);
    await s.key("End");
    await s.key("ArrowLeft");
    await runCommand(s, "Peek at the link under the cursor");
    await peek(s).waitFor();
    assert.match(await s.win.textContent("#peek"), /not written yet/);
    await s.key("Escape");
    await gone(s);
  });

  test("the key opens the peek from the editor", async (s) => {
    await pageWith(s, "peek-f", "Read [t](/peek-target.md) now.\n", "(/peek");
    await s.key("Control+Alt+p");
    await s.win.waitForSelector("#peek .card");
  });
});
