// The outline mod (bundled, mods/outline): the headings of the open page as a group in the right
// column, a "Go to heading" command in the palette, and Alt+Up / Alt+Down on a heading line move its
// whole section past the neighbour of the same level.

import assert from "node:assert/strict";
import { front, suite } from "../harness.mjs";

const PAGE = "# Plan\n\nIntro.\n\n## Goals\n\nGoal text.\n\n## Risks\n\nRisk text.\n\n# Notes\n\nNote text.";

const files = () => ({
  "plan.md": front() + PAGE,
  "flat.md": `${front()}# Only\n\nJust one heading.\n`,
  "code.md": `${front()}# Real\n\n\`\`\`sh\n# not a heading\n\`\`\`\n\n## Also real\n`,
});

const entries = (s) => s.texts("#backlinks .bl-group.outline .outline-item");
const cursorLine = (s) => s.win.evaluate(() => getSelection()?.anchorNode?.parentElement?.closest(".cm-line")?.textContent);

/** Puts the cursor at the end of the line that reads `text`. */
async function onLine(s, text) {
  await s.win.locator(".cm-line", { hasText: text }).first().click();
  await s.key("End");
}

suite("Outline mod: the group in the right column", files, (test) => {
  test("a page's headings are listed in order, deeper ones indented", async (s) => {
    await s.open("plan");
    await s.win.waitForSelector("#backlinks .bl-group.outline");
    assert.deepEqual(await entries(s), ["Plan", "Goals", "Risks", "Notes"]);
    assert.deepEqual(await s.win.$$eval(".outline-item", (els) => els.map((e) => e.getAttribute("data-level"))), ["1", "2", "2", "1"]);
    assert.match(await s.win.textContent("#backlinks .bl-group.outline h3"), /^Outline/);
  });

  test("a heading inside a code block is not listed", async (s) => {
    await s.open("code");
    await s.win.waitForFunction(() => document.querySelector("#backlinks .bl-group.outline .outline-item")?.textContent === "Real");
    assert.deepEqual(await entries(s), ["Real", "Also real"]);
  });

  test("a page with a single heading has no outline", async (s) => {
    await s.open("flat");
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "flat");
    await s.win.waitForTimeout(300);
    assert.equal(await s.win.$$eval("#backlinks .bl-group.outline", (e) => e.length), 0);
  });

  test("clicking an entry puts the cursor on that heading, on the same page", async (s) => {
    await s.open("plan");
    await s.win.waitForSelector("#backlinks .bl-group.outline");
    await s.win.click('.outline-item:has-text("Risks")');
    await s.win.waitForFunction(() => getSelection()?.anchorNode?.parentElement?.closest(".cm-line")?.textContent === "## Risks");
    assert.equal(await s.win.$$eval(".card", (e) => e.length), 1);
  });

  test("the outline follows what is written, once the page is saved", async (s) => {
    await s.open("plan");
    await s.key("Control+End");
    await s.key("Enter");
    await s.key("Enter");
    await s.type("# Later");
    await s.saved();
    await s.win.waitForFunction(() => [...document.querySelectorAll(".outline-item")].some((e) => e.textContent === "Later"));
    assert.deepEqual(await entries(s), ["Plan", "Goals", "Risks", "Notes", "Later"]);
  });
});

suite("Outline mod: Go to heading", files, (test) => {
  test("the palette lists the headings, and Enter goes to the one that matches", async (s) => {
    await s.open("plan");
    await s.key("Control+k");
    await s.type("go to heading");
    await s.key("Enter");
    await s.win.waitForSelector("#dialog");
    assert.deepEqual(await s.texts("#dialog .heading-pick"), ["Plan", "Goals", "Risks", "Notes"]);
    await s.type("ris");
    assert.deepEqual(await s.texts("#dialog .heading-pick"), ["Risks"]);
    await s.key("Enter");
    await s.win.waitForFunction(() => !document.querySelector("#dialog"));
    assert.equal(await cursorLine(s), "## Risks");
  });

  test("the arrow keys choose among the matches", async (s) => {
    await s.key("Control+k");
    await s.type("go to heading");
    await s.key("Enter");
    await s.win.waitForSelector("#dialog");
    await s.key("ArrowDown");
    await s.key("ArrowDown");
    await s.key("Enter");
    await s.win.waitForFunction(() => !document.querySelector("#dialog"));
    assert.equal(await cursorLine(s), "## Risks");
  });
});

suite("Outline mod: moving a section", () => ({ "move.md": `${front()}${PAGE}\n` }), (test) => {
  const disk = async (s) => (await s.savedBody("move")).trimEnd();

  test("Alt+Down on a heading moves its section, with what is under it, past the next one", async (s) => {
    await s.open("move");
    await onLine(s, "## Goals");
    await s.key("Alt+ArrowDown");
    assert.equal(await s.body(), "# Plan\n\nIntro.\n\n## Risks\n\nRisk text.\n\n## Goals\n\nGoal text.\n\n# Notes\n\nNote text.\n");
    assert.equal(await cursorLine(s), "## Goals", "the cursor goes with the heading");
    assert.equal(await disk(s), "# Plan\n\nIntro.\n\n## Risks\n\nRisk text.\n\n## Goals\n\nGoal text.\n\n# Notes\n\nNote text.");
  });

  test("Alt+Up moves it back", async (s) => {
    await s.key("Alt+ArrowUp");
    assert.equal(await s.body(), `${PAGE}\n`);
  });

  test("a section with its own sections moves whole", async (s) => {
    await onLine(s, "# Plan");
    await s.key("Alt+ArrowDown");
    assert.equal(await s.body(), "# Notes\n\nNote text.\n\n# Plan\n\nIntro.\n\n## Goals\n\nGoal text.\n\n## Risks\n\nRisk text.\n");
    await s.key("Alt+ArrowUp");
    assert.equal(await s.body(), `${PAGE}\n`);
  });

  test("a section stays within its parent: the first and last of a level do not move out", async (s) => {
    await onLine(s, "## Goals");
    await s.key("Alt+ArrowUp");
    await onLine(s, "## Risks");
    await s.key("Alt+ArrowDown");
    assert.equal(await s.body(), `${PAGE}\n`);
  });

  test("undo puts the sections back in one step", async (s) => {
    await onLine(s, "## Goals");
    await s.key("Alt+ArrowDown");
    await s.key("Control+z");
    assert.equal(await s.body(), `${PAGE}\n`);
  });

  test("off a heading, Alt+Down still moves a list item, as before", async (s) => {
    await s.openWith("items", "- a\n- b");
    await onLine(s, "- a");
    await s.key("Alt+ArrowDown");
    assert.equal(await s.body(), "- b\n- a");
  });
});
