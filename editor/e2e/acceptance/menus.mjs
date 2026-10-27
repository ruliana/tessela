// The / menu, Ctrl+F, concept suggestions and Ctrl-click (spec §11).

import assert from "node:assert/strict";
import { front, localDay, suite } from "../harness.mjs";

const popup = (s) => s.texts(".cm-tooltip-autocomplete li");

/**
 * Waits until the menu has narrowed to `label`. The popup updates a moment after typing, and
 * CodeMirror ignores Enter for a short while after it opens, so the key is held back a little.
 */
async function menu(s, label) {
  await s.win.waitForFunction(
    (l) => document.querySelector('.cm-tooltip-autocomplete li[aria-selected="true"]')?.textContent?.startsWith(l),
    label,
  );
  await s.win.waitForTimeout(200);
}

function bundle() {
  return {
    "project/tessela.md": `${front("project")}The editor project.\n`,
    "journals/2020-01-01.md": "---\ntype: journal\ndate: 2020-01-01\n---\n\nWorked on #project/tessela today and #other-idea.\n",
  };
}

suite("Slash menu", bundle, (test) => {
  test("/ at the start of a line offers blocks, dates, link and tag", async (s) => {
    await s.openWith("slash-all", "");
    await s.type("/");
    await s.win.waitForSelector(".cm-tooltip-autocomplete");
    const items = (await popup(s)).join(" | ");
    for (const label of ["Heading 1", "Heading 2", "Heading 3", "Bullet list", "Numbered list", "Task", "Quote", "Code block", "Table", "Divider", "Today", "Tomorrow", "Yesterday", "Now", "Link", "Tag"]) {
      assert.ok(items.includes(label), `${label} in ${items}`);
    }
  });

  test("typing narrows the menu", async (s) => {
    await s.openWith("slash-narrow", "");
    await s.type("/head");
    await s.win.waitForSelector(".cm-tooltip-autocomplete");
    const items = await popup(s);
    assert.equal(items.length, 3, items.join("|"));
    assert.ok(items.every((i) => i.includes("Heading")));
  });

  const blocks = [
    ["/heading", "", "# "],
    ["/bullet", "", "- "],
    ["/numbered", "", "1. "],
    ["/task", "", "- [ ] "],
    ["/quote", "", "> "],
    ["/divider", "", "***\n"],
  ];
  for (const [typed, , inserted] of blocks) {
    test(`${typed} inserts ${JSON.stringify(inserted)}`, async (s) => {
      await s.openWith(`slash-${typed.slice(1)}`, "");
      await s.type(typed);
      await menu(s, { "/heading": "Heading 1", "/bullet": "Bullet list", "/numbered": "Numbered list", "/task": "Task", "/quote": "Quote", "/divider": "Divider" }[typed]);
      await s.key("Enter");
      await s.type("x");
      assert.equal(await s.body(), `${inserted}x`);
    });
  }

  test("the arrow keys pick another heading level", async (s) => {
    await s.openWith("slash-h2", "");
    await s.type("/head");
    await menu(s, "Heading 1");
    await s.key("ArrowDown");
    await s.key("Enter");
    await s.type("Title");
    assert.equal(await s.body(), "## Title");
  });

  test("/code inserts a fenced block with the cursor inside", async (s) => {
    await s.openWith("slash-code", "");
    await s.type("/code");
    await menu(s, "Code block");
    await s.key("Enter");
    await s.type("let a");
    assert.equal(await s.body(), "```\nlet a\n```");
  });

  test("/table inserts a table", async (s) => {
    await s.openWith("slash-table", "");
    await s.type("/table");
    await menu(s, "Table");
    await s.key("Enter");
    assert.equal(await s.body(), "| Column | Column |\n| --- | --- |\n|  |  |");
  });

  test("/today, /tomorrow and /yesterday insert the dates", async (s) => {
    const day = (n) => {
      const d = new Date();
      d.setDate(d.getDate() + n);
      return localDay(d);
    };
    for (const [word, n] of [["today", 0], ["tomorrow", 1], ["yesterday", -1]]) {
      await s.openWith(`slash-${word}`, "");
      await s.type(`due /${word}`);
      await menu(s, word[0].toUpperCase() + word.slice(1));
      await s.key("Enter");
      assert.equal(await s.body(), `due ${day(n)}`, word);
    }
  });

  test("/now inserts the date and time with the offset", async (s) => {
    await s.openWith("slash-now", "");
    await s.type("at /now");
    await menu(s, "Now");
    await s.key("Enter");
    assert.match(await s.body(), /^at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  });

  test("/link inserts []() with the cursor in the text", async (s) => {
    await s.openWith("slash-link", "");
    await s.type("see /link");
    await menu(s, "Link");
    await s.key("Enter");
    await s.type("here");
    assert.equal(await s.body(), "see [here]()");
  });

  test("/tag inserts # and offers the existing concepts", async (s) => {
    await s.openWith("slash-tag", "");
    await s.type("about /tag");
    await menu(s, "Tag");
    await s.key("Enter");
    await s.win.waitForFunction(() => [...document.querySelectorAll(".cm-tooltip-autocomplete li")].some((l) => l.textContent.includes("project/tessela")));
    await s.key("Escape");
    assert.equal(await s.body(), "about #");
  });

  test("in the middle of a line only dates, link and tag are offered", async (s) => {
    await s.openWith("slash-mid", "");
    await s.type("word /");
    await s.win.waitForSelector(".cm-tooltip-autocomplete");
    const items = (await popup(s)).join("|");
    assert.ok(items.includes("Today") && items.includes("Link") && items.includes("Tag"), items);
    assert.ok(!items.includes("Heading") && !items.includes("Table"), items);
  });

  test("a / inside a URL or a path is not a menu", async (s) => {
    await s.openWith("slash-url", "");
    await s.type("https://example.com/head");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await s.win.locator(".cm-tooltip-autocomplete").count(), 0);
    assert.equal(await s.body(), "https://example.com/head");
  });

  test("Escape closes the menu and leaves what was typed", async (s) => {
    await s.openWith("slash-esc", "");
    await s.type("/head");
    await s.win.waitForSelector(".cm-tooltip-autocomplete");
    await s.key("Escape");
    await s.win.waitForFunction(() => !document.querySelector(".cm-tooltip-autocomplete"));
    assert.equal(await s.body(), "/head");
  });

  test("a heading from the menu reaches the disk", async (s) => {
    await s.openWith("slash-save", "");
    await s.type("/head");
    await menu(s, "Heading 1");
    await s.key("Enter");
    await s.type("Saved title");
    assert.equal(await s.savedBody("slash-save"), "# Saved title");
  });

  test("the menu works after a list marker too", async (s) => {
    await s.openWith("slash-list", "- ");
    await s.type("/task");
    await menu(s, "Task");
    await s.key("Enter");
    await s.type("x");
    assert.equal(await s.body(), "- - [ ] x");
  });
});

suite("Find (Ctrl+F)", bundle, (test) => {
  test("opens a search panel at the top and finds every match", async (s) => {
    await s.openWith("find-basic", "apple banana apple cherry\n\nApple pie and an apple");
    await s.key("Control+f");
    await s.win.waitForSelector(".cm-search");
    await s.type("apple");
    await s.win.waitForFunction(() => document.querySelectorAll(".cm-searchMatch").length === 4);
  });

  test("Enter goes to the next match, Shift+Enter to the one before", async (s) => {
    await s.key("Enter");
    assert.equal((await s.selected()).toLowerCase(), "apple");
    const first = await s.win.$$eval(".cm-searchMatch", (m) => m.findIndex((e) => e.classList.contains("cm-searchMatch-selected")));
    await s.key("Enter");
    const second = await s.win.$$eval(".cm-searchMatch", (m) => m.findIndex((e) => e.classList.contains("cm-searchMatch-selected")));
    assert.notEqual(first, second);
    await s.key("Shift+Enter");
    const back = await s.win.$$eval(".cm-searchMatch", (m) => m.findIndex((e) => e.classList.contains("cm-searchMatch-selected")));
    assert.equal(back, first);
  });

  test("Escape closes the panel and gives the editor the keyboard back", async (s) => {
    await s.key("Escape");
    await s.win.waitForFunction(() => !document.querySelector(".cm-search"));
    await s.type("Z");
    assert.match(await s.doc(), /Z/);
  });

  test("is not case sensitive unless asked", async (s) => {
    await s.openWith("find-case", "Apple apple APPLE");
    await s.key("Control+f");
    await s.type("apple");
    await s.win.waitForFunction(() => document.querySelectorAll(".cm-searchMatch").length === 3);
    await s.win.check(".cm-search input[name=case]");
    await s.win.waitForFunction(() => document.querySelectorAll(".cm-searchMatch").length === 1);
  });

  test("starts from the selected text", async (s) => {
    await s.openWith("find-selected", "one two one two");
    await s.key("Control+Home");
    for (let i = 0; i < 4; i++) await s.key("ArrowDown");
    await s.key("Home");
    await s.key("Shift+Control+ArrowRight");
    await s.key("Control+f");
    assert.equal(await s.win.inputValue(".cm-search input[name=search]"), "one");
  });

  test("replace all", async (s) => {
    await s.openWith("find-replace", "red car, red house");
    await s.key("Control+f");
    await s.type("red");
    await s.win.fill(".cm-search input[name=replace]", "blue");
    await s.win.click(".cm-search button[name=replaceAll]");
    assert.equal(await s.body(), "blue car, blue house");
    assert.equal(await s.savedBody("find-replace"), "blue car, blue house");
  });

  test("searches the page that has the focus, not the others", async (s) => {
    await s.win.click("#journals-view");
    await s.win.waitForFunction(() => document.querySelectorAll(".card").length === 2);
    await s.win.click(".card:nth-child(2) .cm-content");
    await s.key("Control+f");
    await s.win.waitForSelector(".cm-search");
    assert.equal(await s.win.locator(".card:nth-child(2) .cm-search").count(), 1);
    assert.equal(await s.win.locator(".card:nth-child(1) .cm-search").count(), 0);
    await s.key("Escape");
  });
});

suite("Concept suggestions and Ctrl-click", bundle, (test) => {
  test("# suggests the concepts that exist", async (s) => {
    await s.openWith("sugg-tag", "");
    await s.type("#proj");
    await menu(s, "project/tessela");
    assert.ok((await popup(s)).some((i) => i.includes("project/tessela")));
    await s.key("Enter");
    assert.equal(await s.body(), "#project/tessela");
  });

  test("it shows the concepts that only appear in tags, too", async (s) => {
    await s.openWith("sugg-new", "");
    await s.type("#oth");
    await s.win.waitForSelector(".cm-tooltip-autocomplete");
    assert.ok((await popup(s)).some((i) => i.includes("other-idea")));
  });

  test("a # in the middle of a word is not a tag", async (s) => {
    await s.openWith("sugg-word", "");
    await s.type("abc#proj");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await s.win.locator(".cm-tooltip-autocomplete").count(), 0);
  });

  test("]( suggests pages and fills in the path", async (s) => {
    await s.openWith("sugg-link", "");
    await s.type("[x](proj");
    await menu(s, "project/tessela");
    await s.key("Enter");
    assert.equal(await s.body(), "[x](/project/tessela.md)");
  });

  test("Ctrl-click on a tag opens its page", async (s) => {
    await s.openWith("click-tag", "");
    await s.type("see #project/tessela");
    await s.key("Escape");
    await s.win.click(".cm-tag", { modifiers: ["Control"] });
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "project/tessela");
  });

  test("Ctrl-click on a link to a page opens it", async (s) => {
    await s.openWith("click-link", "[the project](/project/tessela.md)");
    await s.win.click(".cm-concept", { modifiers: ["Control"] });
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "project/tessela");
  });

  test("Ctrl-click on a tag with no page opens a new one from a template", async (s) => {
    await s.openWith("click-new", "idea about #brand-new-thing");
    await s.win.click(".cm-tag", { modifiers: ["Control"] });
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "brand-new-thing");
    assert.equal(await s.status(), "New page");
    assert.match(await s.doc(), /^---\ntype: /);
  });

  test("a plain click on a tag only moves the cursor", async (s) => {
    await s.openWith("click-plain", "see #project/tessela");
    await s.win.click(".cm-tag");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await s.win.textContent(".card-title"), "click-plain");
  });
});
