// Select mode: Escape selects the block at the cursor and the keys then act on blocks, not on text.

import assert from "node:assert/strict";
import { suite } from "../harness.mjs";

const PAGE = [
  "# Title",
  "",
  "First **bold** paragraph.",
  "",
  "Second *para*",
  "continues",
  "",
  "- item **one**",
  "  - child two",
  "- item three",
  "",
  "```js",
  "const **x** = 1;",
  "",
  "let y = 2;",
  "```",
  "",
  "Last end.",
].join("\n");

/** Puts the cursor in the line that has `text`, then Escape: the block of that line is selected. */
async function select(s, name, text, extra = 0) {
  await s.openWith(name, PAGE);
  await s.win.click(`.cm-line:has-text('${text}')`);
  await s.key("Escape");
  for (let i = 0; i < extra; i++) await s.key("Escape");
}

const shown = async (s, text) => ((await s.win.locator(".cm-line", { hasText: text }).first().textContent()) ?? "").replace(/\s+/g, " ").trim();
/** The selected text as it is drawn: bullets and the spacing around them do not count. */
const picked = async (s) => (await s.selected()).replace(/[•☐☑]/g, "").replace(/\s+/g, " ").trim();
const saved = async (s, name) => (await s.savedBody(name)).replace(/^# Title\n\n/, "");

suite("Select mode", null, (test) => {
  test("the selected block is drawn as Markdown, like the ones without the cursor", async (s) => {
    await s.openWith("sel-look", PAGE);
    await s.win.click(".cm-line:has-text('First')");
    assert.equal(await shown(s, "First"), "First **bold** paragraph.", "the block with the cursor is raw");
    await s.key("Escape");
    assert.equal(await shown(s, "First"), "First bold paragraph.");
    assert.equal(await picked(s), "First bold paragraph.");
    await s.win.waitForSelector(".cm-selectionBackground"); // the editor draws it on its next frame
    await s.key("Escape");
    assert.equal(await shown(s, "item one"), "• item one", "wider selections are drawn rendered too");
  });

  test("Up and Down go to the block before and after, code blocks and nested items included", async (s) => {
    await select(s, "sel-nav", "First");
    await s.key("ArrowDown");
    assert.equal(await picked(s), "Second para continues");
    await s.key("ArrowDown");
    assert.equal(await picked(s), "item one child two", "an item is selected with what is nested in it");
    await s.key("ArrowDown");
    assert.equal(await picked(s), "item three");
    await s.key("ArrowDown");
    assert.equal(await picked(s), "```js const **x** = 1; let y = 2; ```", "the code block is one block, blank line and all");
    await s.key("ArrowDown");
    assert.equal(await picked(s), "Last end.");
    await s.key("ArrowDown");
    assert.equal(await picked(s), "Last end.", "nothing below: it stays");
    await s.key("ArrowUp");
    assert.equal(await picked(s), "```js const **x** = 1; let y = 2; ```");
    await s.key("ArrowUp");
    assert.equal(await picked(s), "item three");
    await s.key("ArrowUp");
    assert.equal(await picked(s), "child two", "going up enters the nested items");
    await s.key("ArrowUp");
    assert.equal(await picked(s), "item one child two");
  });

  test("a code block can be entered and left with the arrows from either side", async (s) => {
    await select(s, "sel-code", "let y");
    assert.equal(await picked(s), "```js const **x** = 1; let y = 2; ```");
    await s.key("ArrowUp");
    assert.equal(await picked(s), "item three");
    await s.key("ArrowDown");
    await s.key("ArrowDown");
    assert.equal(await picked(s), "Last end.");
  });

  test("Esc still widens the selection, and the arrows then leave from the wider one", async (s) => {
    await select(s, "sel-wide", "child two");
    assert.equal(await picked(s), "child two");
    await s.key("Escape");
    assert.equal(await picked(s), "item one child two");
    await s.key("Escape");
    assert.equal(await picked(s), "item one child two item three");
    await s.key("ArrowDown");
    assert.equal(await picked(s), "```js const **x** = 1; let y = 2; ```");
  });

  test("a click anywhere leaves select mode and puts the cursor there", async (s) => {
    await select(s, "sel-click", "Second");
    await s.win.click(".cm-line:has-text('Last end')");
    assert.equal(await s.selected(), "");
    await s.type("!");
    assert.match(await saved(s, "sel-click"), /Last[^\n]*!/);
    assert.ok((await saved(s, "sel-click")).includes("Second *para*\ncontinues\n"));
  });

  test("a click on the selected block itself also gets out, and shows it as typed", async (s) => {
    await select(s, "sel-click-in", "First");
    await s.win.click(".cm-line:has-text('First')");
    assert.equal(await shown(s, "First"), "First **bold** paragraph.");
    assert.equal(await s.selected(), "");
    await s.key("Home");
    await s.type("> ");
    assert.equal((await saved(s, "sel-click-in")).split("\n")[0], "> First **bold** paragraph.");
  });

  test("Enter adds a paragraph below and edits it", async (s) => {
    await select(s, "sel-enter", "First");
    await s.key("Enter");
    await s.type("new");
    assert.equal(await saved(s, "sel-enter"), PAGE.replace("First **bold** paragraph.\n", "First **bold** paragraph.\n\nnew\n").replace(/^# Title\n\n/, ""));
  });

  test("Enter below a list item adds an item after the ones nested in it", async (s) => {
    await select(s, "sel-enter-item", "item one");
    await s.key("Enter");
    await s.type("new");
    assert.ok((await saved(s, "sel-enter-item")).includes("- item **one**\n  - child two\n- new\n- item three"));
  });

  test("Enter below a nested item adds a sibling of it", async (s) => {
    await select(s, "sel-enter-child", "child two");
    await s.key("Enter");
    await s.type("new");
    assert.ok((await saved(s, "sel-enter-child")).includes("  - child two\n  - new\n- item three"));
  });

  test("Enter below a code block adds a paragraph after the fence, and below several blocks after the last", async (s) => {
    await select(s, "sel-enter-code", "let y");
    await s.key("Enter");
    await s.type("after");
    assert.ok((await saved(s, "sel-enter-code")).includes("let y = 2;\n```\n\nafter\n\nLast end."));
    await select(s, "sel-enter-many", "Second");
    await s.key("Shift+ArrowUp");
    await s.key("Enter");
    await s.type("fresh");
    assert.ok((await saved(s, "sel-enter-many")).includes("continues\n\nfresh\n\n- item"));
  });

  test("Space edits from the start of the block, and the block shows as typed", async (s) => {
    await select(s, "sel-space", "Second");
    await s.key(" ");
    assert.equal(await shown(s, "Second"), "Second *para*", "back in edit mode");
    await s.type("X");
    assert.ok((await saved(s, "sel-space")).includes("\nXSecond *para*\ncontinues\n"), "no space was typed");
  });

  test("Left arrow does the same as Space, Right arrow edits from the end", async (s) => {
    await select(s, "sel-left", "Second");
    await s.key("ArrowLeft");
    await s.type("X");
    assert.ok((await saved(s, "sel-left")).includes("\nXSecond *para*\ncontinues\n"));
    await select(s, "sel-right", "Second");
    await s.key("ArrowRight");
    await s.type("X");
    assert.ok((await saved(s, "sel-right")).includes("\nSecond *para*\ncontinuesX\n"));
  });

  test("with several blocks selected, Left goes to the start of the first and Right to the end of the last", async (s) => {
    await select(s, "sel-many-end", "First");
    await s.key("Shift+ArrowDown");
    await s.key("ArrowRight");
    await s.type("X");
    assert.ok((await saved(s, "sel-many-end")).includes("continuesX\n\n- item"));
    await select(s, "sel-many-left", "First");
    await s.key("Shift+ArrowDown");
    await s.key("ArrowLeft");
    await s.type("X");
    assert.ok((await saved(s, "sel-many-left")).startsWith("XFirst **bold** paragraph."));
  });

  test("a character starts editing at the start of the block and is typed there", async (s) => {
    await select(s, "sel-type", "Second");
    await s.type("Q");
    assert.equal(await shown(s, "QSecond"), "QSecond *para*");
    await s.type("w");
    assert.ok((await saved(s, "sel-type")).includes("\nQwSecond *para*\ncontinues\n"));
  });

  test("a character does not replace what was selected, however much of the page it was", async (s) => {
    await select(s, "sel-type-all", "Second", 3);
    await s.type("#");
    const body = await s.savedBody("sel-type-all");
    assert.ok(body.includes("First **bold** paragraph.") && body.includes("Last end."), body);
  });

  test("a selected footnote and callout are drawn as formatted, like the ones without the cursor", async (s) => {
    const page = "Claim[^1] here.\n\n[^1]: The note.\n\n> [!WARNING]\n> Mind the gap.\n\nEnd.";
    await s.openWith("sel-gfm", page);
    await s.win.click(".cm-line:has-text('Claim')");
    await s.win.waitForSelector(".tessela-callout-title"); // the callout is not under the cursor
    await s.key("Escape");
    await s.win.waitForSelector(".tessela-fn-ref");
    assert.equal(await s.win.locator(".tessela-fn-raw").count(), 0, "the selected reference is the number, not [^1]");
    await s.key("ArrowDown");
    assert.equal(await s.win.locator(".tessela-fn-label").count(), 1, "the selected definition shows its number");
    await s.key("ArrowDown");
    assert.equal((await picked(s)).toLowerCase(), "warning mind the gap.", "the selected callout shows its title, not [!WARNING]");
    assert.equal(await s.win.locator(".tessela-callout-title").count(), 1);
  });

  test("Shift+Down goes from a paragraph into the list below, and on past it", async (s) => {
    await select(s, "sel-into-list", "Second");
    await s.key("Shift+ArrowDown");
    assert.equal(await picked(s), "Second para continues item one child two item three");
    await s.key("Shift+ArrowDown");
    assert.ok((await picked(s)).endsWith("item three ```js const **x** = 1; let y = 2; ```"));
  });

  test("the keys of the editor keep working on the selection: a selected group moves and nests", async (s) => {
    await select(s, "sel-keys", "First");
    await s.key("Alt+ArrowDown");
    assert.ok((await saved(s, "sel-keys")).startsWith("Second *para*\ncontinues\n\nFirst **bold** paragraph."));
    assert.equal(await picked(s), "First bold paragraph.", "still selected and drawn as Markdown after the move");
    await s.key("ArrowDown");
    assert.equal(await picked(s), "item one child two", "and the arrows still step from it");
  });
}, { rendered: true });
