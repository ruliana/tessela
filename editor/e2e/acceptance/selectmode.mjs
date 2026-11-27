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
    await s.win.click(".cm-line:has-text('First') >> text=bold");
    assert.equal(await shown(s, "First"), "First **bold** paragraph.", "the construct with the cursor is raw");
    await s.key("Escape");
    assert.equal(await shown(s, "First"), "First bold paragraph.");
    assert.equal(await picked(s), "First bold paragraph.");
    await s.win.waitForSelector(".cm-line.cm-block-selected"); // the editor draws it on its next frame
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

  test("a click on the selected block itself also gets out", async (s) => {
    await select(s, "sel-click-in", "First");
    await s.win.click(".cm-line:has-text('First')");
    // The click is past the end of the text: the cursor is at the end of the paragraph, in none of its constructs.
    assert.equal(await shown(s, "First"), "First bold paragraph.");
    assert.equal(await s.win.locator(".cm-select-mode").count(), 0, "select mode is left");
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

  test("Space edits from the start of the block", async (s) => {
    await select(s, "sel-space", "Second");
    await s.key(" ");
    // The cursor is at the start of the block, in none of its constructs: they stay drawn.
    assert.equal(await shown(s, "Second"), "Second para", "back in edit mode");
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
    assert.equal(await shown(s, "QSecond"), "QSecond para");
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

// What select mode did wrong before it was a state of its own: it did not know about folds, a zoom,
// Backspace or focus mode, and it drew the selection differently for each kind of block.
suite("Select mode, as blocks", null, (test) => {
  const mode = (s) => s.win.locator(".shell").getAttribute("data-focus");

  test("Up and Down skip what a fold hides, and come back to the folded block", async (s) => {
    await s.openWith("sel-fold", PAGE);
    await s.win.click(".cm-line:has-text('item')");
    await s.key("Control+ArrowUp");
    await s.win.waitForSelector(".cm-foldchip");
    await s.key("Escape");
    await s.key("ArrowDown");
    assert.equal(await picked(s), "item three", "the child inside the fold is not a stop");
    await s.key("ArrowUp");
    assert.ok((await picked(s)).startsWith("item one"), "going up lands on the folded block, not on its child");
    assert.ok(!(await picked(s)).startsWith("child two"));
  });

  test("Esc stops at a zoom, and Up and Down stay inside it", async (s) => {
    await s.openWith("sel-zoom", PAGE);
    await s.win.click(".cm-line:has-text('child two')");
    await s.key("Control+Alt+ArrowRight"); // zoom in on the child
    await s.key("Control+Alt+ArrowLeft"); // and out one level: on `item one` and what is nested in it
    await s.win.waitForSelector(".cm-zoomtrail");
    await s.key("Escape");
    assert.equal(await picked(s), "child two");
    await s.key("Escape");
    assert.equal(await picked(s), "item one child two", "the item is the widest block in view");
    await s.key("ArrowDown");
    assert.equal(await picked(s), "item one child two", "nothing after the zoomed block is reachable");
    await s.key("Escape");
    assert.equal(await s.win.locator(".cm-select-mode").count(), 0, "nothing wider in the zoom: Esc leaves select mode");
    assert.equal(await s.selected(), "");
  });

  test("Backspace removes the selected blocks, selects the next one and stays in select mode", async (s) => {
    await select(s, "sel-backspace", "Second");
    await s.key("Backspace");
    assert.equal(await picked(s), "item one child two", "the next block is selected");
    assert.equal(await s.win.locator(".cm-select-mode").count(), 1);
    assert.equal(await saved(s, "sel-backspace"), PAGE.replace("Second *para*\ncontinues\n\n", "").replace(/^# Title\n\n/, ""));
    await select(s, "sel-delete-last", "Last");
    await s.key("Delete");
    assert.equal(await picked(s), "```js const **x** = 1; let y = 2; ```", "the block before, at the end of the page");
    assert.equal(await saved(s, "sel-delete-last"), PAGE.replace("\n\nLast end.", "").replace(/^# Title\n\n/, ""));
  });

  test("focus mode does not take Esc first: the block is selected, and focus mode ends with the page selected", async (s) => {
    await s.openWith("sel-focus", PAGE);
    await s.win.click(".cm-line:has-text('Second')");
    await s.key("Control+.");
    await s.win.waitForFunction(() => document.querySelector(".shell")?.dataset.focus === "1");
    await s.key("Escape");
    assert.equal(await picked(s), "Second para continues", "the first Esc selects the block");
    assert.equal(await mode(s), "1");
    for (let i = 0; i < 12 && (await s.win.locator(".cm-select-mode").count()) > 0 && (await mode(s)) === "1"; i++) {
      await s.key("Escape");
      if ((await mode(s)) === "1") assert.equal(await s.win.locator(".cm-select-mode").count(), 1);
    }
    assert.equal(await mode(s), "0", "with nothing left to widen, Esc leaves focus mode");
  });

  test("every selected line, and a selected table, are drawn by the same class", async (s) => {
    await s.openWith("sel-draw", "First line\ncontinues\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nEnd");
    await s.win.click(".cm-line:has-text('continues')");
    await s.key("Escape");
    assert.equal(await s.win.locator(".cm-line.cm-block-selected").count(), 2);
    assert.equal(await s.win.locator(".cm-selectionLayer").evaluate((el) => getComputedStyle(el).display), "none", "the text selection is not what is drawn");
    await s.key("ArrowDown");
    await s.win.waitForSelector(".cm-lp-tablewrap.cm-block-selected");
    assert.equal(await s.win.locator(".cm-line.cm-block-selected").count(), 0, "a table is a widget: it wears the class, not its lines");
  });

  test("Shift+click on another block takes in everything between", async (s) => {
    await select(s, "sel-shift-click", "First");
    await s.win.click(".cm-line:has-text('Last end')", { modifiers: ["Shift"] });
    const text = await picked(s);
    assert.ok(text.startsWith("First bold paragraph.") && text.endsWith("Last end."), text);
    assert.equal(await s.win.locator(".cm-select-mode").count(), 1);
  });

  test("Ctrl+D duplicates the blocks and selects the copy, Ctrl+Enter ticks the selected items", async (s) => {
    await s.openWith("sel-dup", "- [ ] one\n- two\n\nend");
    await s.win.click(".cm-line:has-text('one')");
    await s.key("Escape");
    await s.key("Control+Enter");
    await s.key("Control+d");
    assert.equal(await saved(s, "sel-dup"), "- [x] one\n- [x] one\n- two\n\nend");
    assert.equal(await picked(s), "one");
  });
}, { rendered: true });
