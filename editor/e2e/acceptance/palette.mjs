// The command palette (Ctrl+K), the panels that fold away and focus mode.

import assert from "node:assert/strict";
import { front, suite } from "../harness.mjs";

function bundle() {
  return {
    "alpha.md": `${front()}First paragraph of alpha.\n\nSecond paragraph of alpha.\n`,
    "beta.md": `${front()}The beta page.\n`,
    "project/gamma.md": `${front()}Gamma, mentions #later.\n`,
  };
}

const palette = (s) => s.win.locator("#palette");
const items = (s) => s.texts("#palette .palette-item .t");
const title = (s, name) => s.win.waitForFunction((n) => document.querySelector(".card-title")?.textContent === n, name);

suite("Command palette and focus", bundle, (test) => {
  test("Ctrl+K opens the palette with the input ready, Escape closes it", async (s) => {
    await s.key("Control+k");
    await palette(s).waitFor();
    assert.equal(await s.win.evaluate(() => document.activeElement?.id), "palette-input");
    await s.key("Escape");
    await s.win.waitForFunction(() => !document.querySelector("#palette"));
  });

  test("with nothing typed it lists the pages used lately, then the commands", async (s) => {
    await s.open("beta");
    await s.key("Control+k");
    await palette(s).waitFor();
    const list = await items(s);
    assert.equal(list[0], "beta");
    assert.ok(list.includes("New page") && list.includes("Go to today"), list.join());
    await s.key("Escape");
  });

  test("typing finds a page, and Enter opens it", async (s) => {
    await s.key("Control+k");
    await s.type("gam");
    await s.win.waitForFunction(() => document.querySelector("#palette .palette-item .t")?.textContent === "project/gamma");
    await s.key("Enter");
    await title(s, "project/gamma");
    await s.win.waitForFunction(() => !document.querySelector("#palette"));
  });

  test("a concept without a page is found, and marked as not written", async (s) => {
    await s.key("Control+k");
    await s.type("later");
    await s.win.waitForSelector("#palette .note");
    assert.equal(await s.win.textContent("#palette .note"), "not written yet");
    await s.key("Escape");
  });

  test("a name that matches nothing offers to create the page", async (s) => {
    await s.key("Control+k");
    await s.type("brand new idea");
    await s.win.waitForFunction(() => document.querySelector("#palette .palette-item .t")?.textContent === "Create “brand new idea”");
    await s.key("Enter");
    await title(s, "brand-new-idea");
  });

  test("the arrow keys pick another item", async (s) => {
    await s.key("Control+k");
    await s.type("a");
    await s.key("ArrowDown");
    assert.equal(await s.win.getAttribute("#palette-item-1", "aria-selected"), "true");
    await s.key("ArrowUp");
    assert.equal(await s.win.getAttribute("#palette-item-0", "aria-selected"), "true");
    await s.key("Escape");
  });

  test("a command runs from the palette", async (s) => {
    await s.key("Control+k");
    await s.type("hide the sidebar");
    await s.win.waitForFunction(() => document.querySelector("#palette .palette-item .t")?.textContent === "Hide the sidebar");
    await s.key("Enter");
    await s.win.waitForFunction(() => document.querySelector(".shell")?.dataset.sidebar === "0");
    assert.equal(await s.win.isHidden(".sidebar"), true);
  });

  test("Ctrl+\\ and Ctrl+Shift+\\ fold the sidebar and the backlinks, and it is remembered", async (s) => {
    await s.key("Control+\\");
    await s.win.waitForFunction(() => document.querySelector(".shell")?.dataset.sidebar === "1");
    await s.key("Control+Shift+\\");
    await s.win.waitForFunction(() => document.querySelector(".shell")?.dataset.backlinks === "0");
    assert.equal(await s.win.isHidden("#backlinks"), true);
    await s.win.reload();
    await s.win.waitForSelector(".cm-content");
    assert.equal(await s.win.getAttribute(".shell", "data-backlinks"), "0");
    await s.key("Control+Shift+\\");
    await s.win.waitForFunction(() => document.querySelector(".shell")?.dataset.backlinks === "1");
  });

  test("focus mode hides both panels, dims the other blocks, and Escape leaves it", async (s) => {
    await s.open("alpha");
    await s.win.click(".cm-line:has-text('First paragraph')");
    await s.key("Control+.");
    await s.win.waitForFunction(() => document.querySelector(".shell")?.dataset.focus === "1");
    assert.equal(await s.win.isHidden(".sidebar"), true);
    assert.equal(await s.win.isHidden("#backlinks"), true);
    await s.win.waitForFunction(() => {
      const opacity = (t) => Number(getComputedStyle([...document.querySelectorAll(".cm-line")].find((l) => l.textContent.includes(t))).opacity);
      return opacity("Second paragraph") < 0.5 && opacity("First paragraph") === 1;
    });
    await s.win.click(".cm-line:has-text('Second paragraph')");
    await s.win.waitForFunction(() => {
      const opacity = (t) => Number(getComputedStyle([...document.querySelectorAll(".cm-line")].find((l) => l.textContent.includes(t))).opacity);
      return opacity("First paragraph") < 0.5 && opacity("Second paragraph") === 1;
    });
    await s.key("Escape");
    await s.win.waitForFunction(() => document.querySelector(".shell")?.dataset.focus === "0");
    await s.win.waitForSelector(".sidebar", { state: "visible" });
  });

  test("the strip has a Focus button too", async (s) => {
    await s.win.click("#focus-toggle");
    assert.equal(await s.win.getAttribute("#focus-toggle", "aria-pressed"), "true");
    await s.win.click("#focus-toggle");
    assert.equal(await s.win.getAttribute("#focus-toggle", "aria-pressed"), "false");
  });
});
