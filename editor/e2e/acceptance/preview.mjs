// Live preview: Markdown shown rendered, raw only in the block being edited.

import assert from "node:assert/strict";
import { suite } from "../harness.mjs";

const page = [
  "# Big title",
  "",
  "First **bold** and *slanted* and ~~gone~~ and `code` and [site](https://example.com).",
  "",
  "Second line one with **more**",
  "second line two with *this*",
  "",
  "- item one",
  "- [ ] open task",
  "- [x] done task",
  "",
  "> quoted words",
  "",
  "---",
  "",
  "1. numbered",
  "",
  "```js",
  "const **x** = 1;",
  "```",
  "",
  "Last paragraph.",
].join("\n");

/** The line (as shown) that contains `text`. */
const line = (s, text) => s.win.locator(".cm-line", { hasText: text }).first();
const shown = async (s, text) => (await line(s, text).textContent()) ?? "";

async function rendered(s) {
  await s.win.waitForFunction(() => document.querySelector("#preview-toggle")?.getAttribute("aria-pressed") === "true");
}

suite("Live preview", null, (test) => {
  test("is off at first: the Markdown shows as typed", async (s) => {
    // The window remembers the choice, so start from a clean slate.
    await s.win.evaluate(() => localStorage.removeItem("tessela.livePreview"));
    await s.win.reload();
    await s.win.waitForSelector(".cm-content");
    await s.openWith("preview", page);
    assert.equal(await s.win.getAttribute("#preview-toggle", "aria-pressed"), "false");
    assert.ok((await s.doc()).includes("# Big title"));
    assert.ok((await s.doc()).includes("First **bold**"));
  });

  test("the button renders the Markdown outside the block being edited", async (s) => {
    await s.win.click("#preview-toggle");
    await rendered(s);
    // The cursor is in the last paragraph; the rest is rendered.
    assert.equal((await shown(s, "Big title")).trim(), "Big title");
    assert.equal(await shown(s, "First"), "First bold and slanted and gone and code and site.");
    assert.equal(await shown(s, "Last paragraph"), "Last paragraph.");
  });

  test("the block with the cursor stays raw, and the others render", async (s) => {
    await s.win.click(".cm-line:has-text('Last paragraph')");
    assert.equal(await shown(s, "Last paragraph"), "Last paragraph.");
    assert.equal(await shown(s, "First"), "First bold and slanted and gone and code and site.");
    await s.win.click(".cm-line:has-text('First')");
    await s.win.waitForFunction(() => [...document.querySelectorAll(".cm-line")].some((l) => l.textContent.includes("**bold**")));
    assert.equal(await shown(s, "First"), "First **bold** and *slanted* and ~~gone~~ and `code` and [site](https://example.com).");
    assert.equal((await shown(s, "Big title")).trim(), "Big title");
  });

  test("moving the cursor away renders the block again", async (s) => {
    await s.win.click(".cm-line:has-text('Last paragraph')");
    await s.win.waitForFunction(() => ![...document.querySelectorAll(".cm-line")].some((l) => l.textContent.includes("**bold**")));
  });

  test("a paragraph over several lines is edited as one block", async (s) => {
    await s.win.click(".cm-line:has-text('second line two')");
    await s.win.waitForFunction(() => [...document.querySelectorAll(".cm-line")].some((l) => l.textContent.includes("**more**")));
    assert.equal(await shown(s, "second line two"), "second line two with *this*");
    await s.win.click(".cm-line:has-text('Last paragraph')");
    await s.win.waitForFunction(() => ![...document.querySelectorAll(".cm-line")].some((l) => l.textContent.includes("**more**")));
    assert.equal(await shown(s, "Second line one"), "Second line one with more");
    assert.equal(await shown(s, "second line two"), "second line two with this");
  });

  test("the heading mark, bullets and checkboxes are drawn", async (s) => {
    assert.equal((await shown(s, "item one")).replace(/\s+/g, ""), "•itemone");
    assert.ok((await shown(s, "open task")).includes("☐"));
    assert.ok((await shown(s, "done task")).includes("☑"));
    assert.ok(!(await shown(s, "open task")).includes("[ ]"));
  });

  test("quotes lose their mark and get a bar; rules become a line", async (s) => {
    assert.equal((await shown(s, "quoted words")).trim(), "quoted words");
    assert.equal(await s.win.locator(".cm-lp-quote").count(), 1);
    assert.equal(await s.win.locator(".cm-lp-rule").count(), 1);
  });

  test("numbered lists and code blocks stay as written", async (s) => {
    assert.equal(await shown(s, "numbered"), "1. numbered");
    assert.equal(await shown(s, "const"), "const **x** = 1;");
    assert.equal(await shown(s, "```js"), "```js");
  });

  test("links, emphasis and code are styled", async (s) => {
    const style = (text) =>
      s.win.evaluate((t) => {
        const walker = document.createTreeWalker(document.querySelector(".cm-content"), NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (n.data.includes(t)) {
            const st = getComputedStyle(n.parentElement);
            return { weight: Number(st.fontWeight), style: st.fontStyle, deco: st.textDecorationLine, family: st.fontFamily, color: st.color };
          }
        }
        return null;
      }, text);
    assert.ok((await style("bold")).weight >= 700);
    assert.equal((await style("slanted")).style, "italic");
    assert.match((await style("gone")).deco, /line-through/);
    assert.match((await style("code")).family, /mono|Mono|Courier/);
    assert.notEqual((await style("site")).color, (await style("Last paragraph")).color);
  });

  test("typing in a rendered page changes only the Markdown", async (s) => {
    await s.win.click(".cm-line:has-text('Last paragraph')");
    await s.key("End");
    await s.type(" And **more**");
    const body = await s.savedBody("preview");
    assert.ok(body.includes("Last paragraph. And **more**"), body);
    assert.ok(body.includes("# Big title\n\nFirst **bold** and *slanted*"), body);
    assert.ok(body.includes("- [x] done task"), body);
    assert.ok(body.includes("---\n\n1. numbered"), body);
  });

  test("a heading is raw while the cursor is in it", async (s) => {
    await s.win.click(".cm-line:has-text('Big title')");
    await s.win.waitForFunction(() => [...document.querySelectorAll(".cm-line")].some((l) => l.textContent.startsWith("# Big title")));
  });

  test("Ctrl+Alt+M switches it off and on again", async (s) => {
    await s.key("Control+Alt+m");
    await s.win.waitForFunction(() => document.querySelector("#preview-toggle")?.getAttribute("aria-pressed") === "false");
    await s.win.click(".cm-line:has-text('Last paragraph')");
    assert.ok((await s.doc()).includes("First **bold**"));
    assert.ok((await s.doc()).includes("- [ ] open task"));
    await s.key("Control+Alt+m");
    await rendered(s);
    assert.equal(await shown(s, "First"), "First bold and slanted and gone and code and site.");
  });

  test("every card of the journals is rendered, and the choice is remembered", async (s) => {
    await s.win.click("#today");
    await s.win.waitForSelector(".card.compact");
    await s.key("Control+End");
    await s.type("one **bold** day");
    // Leaving the text renders it.
    await s.win.click("#journals-view");
    await s.win.waitForSelector(".card.compact");
    await s.win.waitForFunction(() => [...document.querySelectorAll(".cm-line")].some((l) => l.textContent === "one bold day"));
    await s.win.reload();
    await s.win.waitForSelector(".cm-content");
    assert.equal(await s.win.getAttribute("#preview-toggle", "aria-pressed"), "true");
  });

  test("switching it off for the next tests", async (s) => {
    await s.win.click("#preview-toggle");
    await s.win.waitForFunction(() => document.querySelector("#preview-toggle")?.getAttribute("aria-pressed") === "false");
    await s.win.evaluate(() => localStorage.removeItem("tessela.livePreview"));
  });
});
