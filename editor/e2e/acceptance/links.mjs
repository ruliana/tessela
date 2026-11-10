// Adding a link without typing the title and the path twice: Ctrl+L search, `](` and paste
// over selected words.

import assert from "node:assert/strict";
import { front, suite } from "../harness.mjs";

const popup = (s) => s.texts(".cm-tooltip-autocomplete li");

/** Waits until the popup has narrowed to `label` (see menus.mjs for why Enter is held back). */
async function menu(s, label) {
  await s.win.waitForFunction(
    (l) => document.querySelector('.cm-tooltip-autocomplete li[aria-selected="true"]')?.textContent?.startsWith(l),
    label,
  );
  await s.win.waitForTimeout(200);
}

/** Pastes `text` the way the clipboard would, into the focused editor. */
function paste(s, text) {
  return s.win.evaluate((t) => {
    const data = new DataTransfer();
    data.setData("text/plain", t);
    document.querySelector(".cm-content").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

function bundle() {
  return {
    "daily-todo.md": '---\ntype: concept\ntitle: "Daily TODO"\n---\n\nThings to do.\n',
    "reading-list.md": `${front()}# Books to read\n`,
    "project/tessela.md": `${front("project")}The editor project.\n`,
  };
}

suite("Adding links: Ctrl+L search and ](", bundle, (test) => {
  test("Ctrl+L with nothing selected searches for the page and fills in the text and the path", async (s) => {
    await s.openWith("ctrl-l-search", "");
    await s.key("Control+l");
    await s.type("dai");
    await menu(s, "Daily TODO");
    await s.key("Enter");
    assert.equal(await s.body(), "[Daily TODO](/daily-todo.md)");
    await s.type(" ok");
    assert.equal(await s.body(), "[Daily TODO](/daily-todo.md) ok");
  });

  test("a link made by searching can be undone in one step", async (s) => {
    await s.openWith("ctrl-l-undo", "");
    await s.key("Control+l");
    await s.type("dai");
    await menu(s, "Daily TODO");
    await s.key("Enter");
    await s.key("Control+z");
    assert.ok(!(await s.body()).includes("daily-todo.md"));
  });

  test("a title with no page offers a link to a new page, with the path made from the words", async (s) => {
    await s.openWith("ctrl-l-new", "");
    await s.key("Control+l");
    await s.type("Sprint retro");
    await menu(s, "Sprint retro");
    assert.match((await popup(s))[0], /new page/);
    await s.key("Enter");
    assert.equal(await s.body(), "[Sprint retro](/sprint-retro.md)");
  });

  test("a page whose file name is not its title is found by the title", async (s) => {
    await s.openWith("ctrl-l-heading", "");
    await s.key("Control+l");
    await s.type("books");
    await menu(s, "Books to read");
    await s.key("Enter");
    assert.equal(await s.body(), "[Books to read](/reading-list.md)");
  });

  test("selected words keep their text and look for the page by what is typed", async (s) => {
    await s.openWith("ctrl-l-words", "");
    await s.type("my todo list");
    await s.key("Shift+Home");
    await s.key("Control+l");
    await s.type("dai");
    await menu(s, "Daily TODO");
    await s.key("Enter");
    assert.equal(await s.body(), "[my todo list](/daily-todo.md)");
  });

  test("[Title]( offers the page of that title first", async (s) => {
    await s.openWith("title-first", "");
    await s.type("[Books to read](");
    await menu(s, "Books to read");
    await s.key("Enter");
    assert.equal(await s.body(), "[Books to read](/reading-list.md)");
  });

  test("an address typed after ]( is left alone", async (s) => {
    await s.openWith("target-url", "");
    await s.type("[x](https://exa");
    await s.win.waitForTimeout(300);
    assert.equal(await s.win.locator(".cm-tooltip-autocomplete").count(), 0);
  });
});

suite("Adding links: paste over selection", bundle, (test) => {
  test("an address pasted over selected words makes them the link text", async (s) => {
    await s.openWith("paste-url", "");
    await s.type("Anthropic");
    await s.key("Shift+Home");
    await paste(s, "https://www.anthropic.com");
    assert.equal(await s.body(), "[Anthropic](https://www.anthropic.com)");
    await s.type(" site");
    assert.equal(await s.body(), "[Anthropic](https://www.anthropic.com) site");
  });

  test("it can be undone in one step", async (s) => {
    await s.openWith("paste-undo", "");
    await s.type("Anthropic");
    await s.key("Shift+Home");
    await paste(s, "https://www.anthropic.com");
    await s.key("Control+z");
    assert.equal(await s.body(), "Anthropic");
  });

  test("other text pasted over a selection replaces it as usual", async (s) => {
    await s.openWith("paste-text", "");
    await s.type("Anthropic");
    await s.key("Shift+Home");
    await paste(s, "not an address");
    assert.equal(await s.body(), "not an address");
  });

  test("an address pasted with nothing selected stays an address", async (s) => {
    await s.openWith("paste-bare", "");
    await paste(s, "https://www.anthropic.com");
    assert.equal(await s.body(), "https://www.anthropic.com");
  });
});
