// What the editor colours: Markdown, tags, dates, links, front matter and code (spec §11).

import assert from "node:assert/strict";
import { front, suite } from "../harness.mjs";

function bundle() {
  return { "project/tessela.md": `${front("project")}The editor project.\n` };
}

/** The computed style of the text node that holds `text`. */
function styleOf(s, text) {
  return s.win.evaluate((t) => {
    const walker = document.createTreeWalker(document.querySelector(".cm-content"), NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.data.includes(t)) {
        const st = getComputedStyle(n.parentElement);
        return { color: st.color, weight: Number(st.fontWeight), style: st.fontStyle, size: parseFloat(st.fontSize), deco: st.textDecorationLine, family: st.fontFamily };
      }
    }
    return null;
  }, text);
}

const page = [
  "# Title one",
  "",
  "## Title two",
  "",
  "Plain **bold** and *italic* and ~~gone~~ and `inline` and [site](https://example.com).",
  "",
  "> quoted words",
  "",
  "- #project/tessela #newidea 2026-10-27 2026-10-27 14:30:00-03:00 2026-13-45",
  "- [t](/project/tessela.md) [n](/newone.md) [paper](./paper.pdf)",
  "",
  "`#nottag 2026-10-27` and `[c](/code.md)`",
  "",
  "```js",
  "const x = 1; // note #nottag",
  "```",
  "",
  "```python",
  "def go(): return 'text'",
  "```",
].join("\n");

suite("Syntax highlighting", bundle, (test) => {
  test("opens the page to colour", async (s) => {
    await s.openWith("syntax", page);
    await s.win.waitForSelector(".cm-tag");
    await s.win.waitForSelector(".cm-codeblock");
  });

  test("tags are coloured, and the ones without a page are shown as unwritten", async (s) => {
    assert.deepEqual(await s.texts(".cm-tag"), ["#project/tessela", "#newidea"]);
    assert.deepEqual(await s.texts(".cm-tag.cm-unwritten"), ["#newidea"]);
  });

  test("a tag looks different from the text around it", async (s) => {
    const tag = await s.win.evaluate(() => getComputedStyle(document.querySelector(".cm-tag")).backgroundColor);
    assert.notEqual(tag, "rgba(0, 0, 0, 0)");
  });

  test("dates and datetimes are coloured, impossible dates are not", async (s) => {
    assert.deepEqual(await s.texts(".cm-date"), ["2026-10-27", "2026-10-27 14:30:00-03:00"]);
    assert.deepEqual(await s.texts(".cm-datetime"), ["2026-10-27 14:30:00-03:00"]);
  });

  test("links to concepts are marked, and the ones with no page are unwritten", async (s) => {
    assert.deepEqual(await s.texts(".cm-concept"), ["[t](/project/tessela.md)", "[n](/newone.md)"]);
    assert.deepEqual(await s.texts(".cm-concept.cm-unwritten"), ["[n](/newone.md)"]);
  });

  test("links to other files are marked as files", async (s) => {
    assert.deepEqual(await s.texts(".cm-file"), ["[paper](./paper.pdf)"]);
  });

  test("tags, dates and links inside code are not coloured", async (s) => {
    const all = (await s.texts(".cm-tag")).join() + (await s.texts(".cm-date")).join() + (await s.texts(".cm-concept")).join();
    assert.ok(!all.includes("nottag") && !all.includes("code.md"), all);
  });

  test("headings are bigger and bold", async (s) => {
    const body = await styleOf(s, "Plain ");
    const h1 = await styleOf(s, "Title one");
    const h2 = await styleOf(s, "Title two");
    assert.ok(h1.size > h2.size && h2.size > body.size, JSON.stringify({ h1, h2, body }));
    assert.ok(h1.weight >= 700 && h2.weight >= 700);
  });

  test("bold, italic and strikethrough", async (s) => {
    assert.ok((await styleOf(s, "bold")).weight >= 700);
    assert.equal((await styleOf(s, "italic")).style, "italic");
    assert.match((await styleOf(s, "gone")).deco, /line-through/);
  });

  test("inline code is monospace and coloured", async (s) => {
    const code = await styleOf(s, "inline");
    const body = await styleOf(s, "Plain ");
    assert.match(code.family, /mono|Mono|Courier/);
    assert.notEqual(code.color, body.color);
  });

  test("links have their own colour, quotes are muted", async (s) => {
    const body = await styleOf(s, "Plain ");
    assert.notEqual((await styleOf(s, "site")).color, body.color);
    assert.notEqual((await styleOf(s, "quoted words")).color, body.color);
  });

  test("fenced code gets a block background on every line", async (s) => {
    assert.equal(await s.win.locator(".cm-codeblock").count(), 6);
  });

  test("code in a fenced block is coloured in the language it names (js)", async (s) => {
    await s.win.waitForFunction(() => {
      const line = [...document.querySelectorAll(".cm-codeblock")].find((l) => l.textContent.includes("const x"));
      const colors = new Set([...(line?.querySelectorAll("span") ?? [])].map((x) => getComputedStyle(x).color));
      return colors.size >= 3;
    });
    const keyword = await styleOf(s, "const");
    const number = await styleOf(s, "1");
    const comment = await styleOf(s, "// note");
    assert.notEqual(keyword.color, number.color);
    assert.notEqual(keyword.color, comment.color);
    assert.equal(comment.style, "italic");
  });

  test("code in another language (python)", async (s) => {
    await s.win.waitForFunction(() => {
      const line = [...document.querySelectorAll(".cm-codeblock")].find((l) => l.textContent.includes("def go"));
      const colors = new Set([...(line?.querySelectorAll("span") ?? [])].map((x) => getComputedStyle(x).color));
      return colors.size >= 3;
    });
  });

  test("front matter is coloured as YAML", async (s) => {
    await s.openWith("syntax-front", "text");
    await s.win.waitForFunction(() => {
      const line = [...document.querySelectorAll(".cm-line")].find((l) => l.textContent.startsWith("type:"));
      const colors = new Set([...(line?.querySelectorAll("span") ?? [])].map((x) => getComputedStyle(x).color));
      return colors.size >= 2;
    });
  });

  test("tags in the front matter are coloured and mark the page itself", async (s) => {
    await s.openWith("syntax-fm-tags", "text");
    await s.key("Control+Home");
    await s.key("ArrowDown");
    await s.key("End");
    await s.key("Enter");
    await s.type("tags: [project/tessela, nowhere]");
    await s.key("End");
    await s.win.waitForFunction(() => document.querySelectorAll(".cm-tag").length === 2);
    assert.deepEqual(await s.texts(".cm-tag"), ["project/tessela", "nowhere"]);
    assert.deepEqual(await s.texts(".cm-tag.cm-unwritten"), ["nowhere"]);
  });

  test("colours follow what is typed", async (s) => {
    await s.openWith("syntax-live", "");
    await s.type("#fresh-idea and 2030-01-02");
    await s.win.waitForSelector(".cm-tag");
    assert.deepEqual(await s.texts(".cm-tag"), ["#fresh-idea"]);
    assert.deepEqual(await s.texts(".cm-date"), ["2030-01-02"]);
    await s.key("Control+a");
    await s.key("Delete");
    await s.win.waitForFunction(() => document.querySelectorAll(".cm-tag, .cm-date").length === 0);
  });

  test("a tag turns from unwritten to written once its page exists", async (s) => {
    await s.openWith("syntax-written", "mentions #soon-written");
    await s.win.waitForSelector(".cm-tag.cm-unwritten");
    await s.win.click(".cm-tag", { modifiers: ["Control"] });
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "soon-written");
    await s.key("Control+End");
    await s.type("now it exists");
    await s.saved();
    await s.open("syntax-written");
    await s.win.waitForSelector(".cm-tag");
    await s.win.waitForFunction(() => !document.querySelector(".cm-tag.cm-unwritten"));
  });
});
