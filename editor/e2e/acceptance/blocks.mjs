// Tab, Shift+Tab, Alt+Up/Down and block selection (spec §11, "Editing keys").

import assert from "node:assert/strict";
import { suite } from "../harness.mjs";

suite("Tab and Shift+Tab", null, (test) => {
  test("Tab turns a paragraph into a list item", async (s) => {
    await s.openWith("tab-para", "Just text");
    await s.key("Tab");
    assert.equal(await s.body(), "- Just text");
    assert.equal(await s.savedBody("tab-para"), "- Just text");
  });

  test("Tab starts a list item on an empty line", async (s) => {
    await s.openWith("tab-empty", "Intro\n\n");
    await s.key("Tab");
    await s.type("fresh");
    assert.equal(await s.body(), "Intro\n\n- fresh");
  });

  test("Tab nests an item under the one before it", async (s) => {
    await s.openWith("tab-nest", "- one\n- two\n- three");
    await s.key("Tab");
    assert.equal(await s.body(), "- one\n- two\n  - three");
    await s.key("Tab");
    assert.equal(await s.body(), "- one\n- two\n  - three", "already under the last sibling that can take it");
  });

  test("Tab nests deeper, one level at a time", async (s) => {
    await s.openWith("tab-deep", "- one\n  - two\n  - three");
    await s.key("Tab");
    assert.equal(await s.body(), "- one\n  - two\n    - three");
  });

  test("Tab on the first item of a list has nothing to nest under", async (s) => {
    await s.openWith("tab-first", "- one\n- two");
    await s.key("ArrowUp");
    await s.key("Tab");
    assert.equal(await s.body(), "- one\n- two", "the first item stays where it is");
    await s.key("ArrowDown");
    await s.key("Tab");
    assert.equal(await s.body(), "- one\n  - two");
  });

  test("Tab takes the children along", async (s) => {
    await s.openWith("tab-children", "- one\n- two\n  - under two");
    await s.key("ArrowUp");
    await s.key("Tab");
    assert.equal(await s.body(), "- one\n  - two\n    - under two");
  });

  test("Shift+Tab moves a nested item out", async (s) => {
    await s.openWith("shift-nested", "- one\n  - two");
    await s.key("Shift+Tab");
    assert.equal(await s.body(), "- one\n- two");
  });

  test("Shift+Tab on a top-level item returns it to a paragraph", async (s) => {
    await s.openWith("shift-top", "- one\n- two");
    await s.key("Shift+Tab");
    assert.equal(await s.body(), "- one\n\ntwo");
    assert.equal(await s.savedBody("shift-top"), "- one\n\ntwo");
  });

  test("Shift+Tab on the only item leaves a plain paragraph", async (s) => {
    await s.openWith("shift-only", "- alone");
    await s.key("Shift+Tab");
    assert.equal(await s.body(), "alone");
  });

  test("Shift+Tab on a paragraph does nothing", async (s) => {
    await s.openWith("shift-para", "plain");
    await s.key("Shift+Tab");
    assert.equal(await s.body(), "plain");
  });

  test("Tab then Shift+Tab is a round trip", async (s) => {
    await s.openWith("tab-round", "Para\n\nOther");
    await s.key("Tab");
    await s.key("Shift+Tab");
    assert.equal(await s.body(), "Para\n\nOther");
  });

  test("a selection of several paragraphs becomes several items", async (s) => {
    await s.openWith("tab-many", "one\n\ntwo");
    await s.key("Escape");
    await s.key("Shift+ArrowUp");
    await s.key("Tab");
    assert.equal(await s.body(), "- one\n\n- two");
  });

  test("Tab in the front matter keeps its usual behaviour", async (s) => {
    await s.openWith("tab-front", "text");
    await s.key("Control+Home");
    await s.key("ArrowDown"); // the "type: concept" line
    await s.key("End");
    await s.key("Tab");
    const doc = await s.doc();
    assert.ok(!doc.includes("- type"), "the front matter must not become a list");
    assert.match(doc, /^---\n\s+type: concept\n---/, "Tab indents the line as it does in any text");
  });

  test("Tab in a code block keeps its usual behaviour", async (s) => {
    await s.openWith("tab-code", "```js\nlet a\n```");
    await s.key("ArrowUp");
    await s.key("Tab");
    const body = await s.body();
    assert.ok(!body.includes("- let a"), body);
    assert.match(body, /\n\s+let a\n/, body);
  });

  test("Tab and Shift+Tab can be undone with one Ctrl+Z each", async (s) => {
    await s.openWith("tab-undo", "word");
    await s.key("Tab");
    assert.equal(await s.body(), "- word");
    await s.key("Control+z");
    assert.equal(await s.body(), "word");
  });
});

suite("Block move and select", null, (test) => {
  test("Alt+Up moves a paragraph above the one before it", async (s) => {
    await s.openWith("move-up", "Alpha\n\nBeta\n\nGamma");
    await s.key("Alt+ArrowUp");
    assert.equal(await s.body(), "Alpha\n\nGamma\n\nBeta");
  });

  test("Alt+Down moves a paragraph below the next one", async (s) => {
    await s.openWith("move-down", "Alpha\n\nBeta\n\nGamma");
    await s.key("ArrowUp");
    await s.key("ArrowUp");
    await s.key("Alt+ArrowDown");
    assert.equal(await s.body(), "Alpha\n\nGamma\n\nBeta");
  });

  test("the cursor stays in the block that moved", async (s) => {
    await s.openWith("move-cursor", "Alpha\n\nBeta");
    await s.key("Alt+ArrowUp");
    await s.type("!");
    assert.equal(await s.body(), "Beta!\n\nAlpha");
  });

  test("Alt+Up at the top does nothing", async (s) => {
    await s.openWith("move-top", "Alpha\n\nBeta");
    await s.key("ArrowUp");
    await s.key("ArrowUp");
    await s.key("Alt+ArrowUp");
    assert.equal(await s.body(), "Alpha\n\nBeta");
  });

  test("Alt+Up at the bottom of the page: Alt+Down does nothing", async (s) => {
    await s.openWith("move-bottom", "Alpha\n\nBeta");
    await s.key("Alt+ArrowDown");
    assert.equal(await s.body(), "Alpha\n\nBeta");
  });

  test("an item moves with the items nested in it", async (s) => {
    await s.openWith("move-item", "- one\n- two\n  - under two\n- three");
    await s.key("ArrowUp");
    await s.key("ArrowUp");
    await s.key("Alt+ArrowUp");
    assert.equal(await s.body(), "- two\n  - under two\n- one\n- three");
  });

  test("an item only swaps with its siblings", async (s) => {
    await s.openWith("move-sibling", "- one\n  - a\n  - b\n- two");
    await s.key("ArrowUp");
    await s.key("Alt+ArrowUp");
    assert.equal(await s.body(), "- one\n  - b\n  - a\n- two");
    await s.key("Alt+ArrowUp");
    assert.equal(await s.body(), "- one\n  - b\n  - a\n- two", "a first child does not leave its parent");
  });

  test("a paragraph moves with the list it owns", async (s) => {
    await s.openWith("move-owner", "Heading text\n- owned\n- also owned\n\nOther");
    await s.key("Alt+ArrowUp");
    assert.equal(await s.body(), "Other\n\nHeading text\n- owned\n- also owned");
  });

  test("a moved block can be moved back with undo", async (s) => {
    await s.openWith("move-undo", "Alpha\n\nBeta");
    await s.key("Alt+ArrowUp");
    await s.key("Control+z");
    assert.equal(await s.body(), "Alpha\n\nBeta");
  });

  test("moving saves the page", async (s) => {
    await s.openWith("move-save", "Alpha\n\nBeta");
    await s.key("Alt+ArrowUp");
    assert.equal(await s.savedBody("move-save"), "Beta\n\nAlpha");
  });

  test("in a code block Alt+Up moves a line, as in any editor, and not the block", async (s) => {
    await s.openWith("move-code", "Intro\n\n```\nline one\nline two\n```");
    await s.key("ArrowUp");
    await s.key("Alt+ArrowUp");
    assert.equal(await s.body(), "Intro\n\n```\nline two\nline one\n```");
  });

  test("Esc selects the block at the cursor", async (s) => {
    await s.openWith("sel-block", "Alpha\n\nBeta line\ncontinues\n\nGamma");
    await s.key("ArrowUp");
    await s.key("ArrowUp");
    await s.key("Escape");
    assert.equal(await s.selected(), "Beta line\ncontinues");
  });

  test("Shift+Down and Shift+Up take in more blocks", async (s) => {
    await s.openWith("sel-more", "Alpha\n\nBeta\n\nGamma\n\nDelta");
    await s.key("ArrowUp");
    await s.key("ArrowUp");
    await s.key("Escape");
    assert.equal(await s.selected(), "Gamma");
    await s.key("Shift+ArrowDown");
    assert.match(await s.selected(), /^Gamma\s+Delta$/);
    await s.key("Shift+ArrowUp");
    assert.match(await s.selected(), /^Beta\s+Gamma\s+Delta$/, "Shift+Up takes in the block before");
  });

  test("Esc on an item selects the item, Esc again its parent", async (s) => {
    await s.openWith("sel-parent", "- one\n  - child\n  - other\n- two");
    await s.key("ArrowUp");
    await s.key("ArrowUp");
    await s.key("Escape");
    assert.equal(await s.selected(), "  - child");
    await s.key("Escape");
    assert.equal(await s.selected(), "- one\n  - child\n  - other");
  });

  test("a selected group moves together", async (s) => {
    await s.openWith("sel-move", "Alpha\n\nBeta\n\nGamma\n\nDelta");
    await s.key("ArrowUp");
    await s.key("ArrowUp");
    await s.key("Escape");
    await s.key("Shift+ArrowDown");
    await s.key("Alt+ArrowUp");
    assert.equal(await s.body(), "Alpha\n\nGamma\n\nDelta\n\nBeta");
  });

  test("Shift+Tab on a selected group un-lists all of it", async (s) => {
    await s.openWith("sel-outdent", "- one\n- two\n- three");
    await s.key("ArrowUp");
    await s.key("Escape");
    await s.key("Shift+ArrowDown");
    await s.key("Shift+Tab");
    assert.equal(await s.body(), "- one\n\ntwo\n\nthree");
  });
});

suite("Selection across lines", null, (test) => {
  test("a selection that continues onto the next line starts where the text does", async (s) => {
    await s.openWith("select-lines", "First line here\nSecond line here");
    await s.key("Control+Home");
    await s.key("Shift+ArrowDown");
    await s.key("Shift+End");
    const { text, selection } = await s.win.evaluate(() => {
      const line = document.querySelectorAll(".cm-line")[1];
      const range = document.createRange();
      range.selectNodeContents(line);
      const rects = [...document.querySelectorAll(".cm-selectionBackground")].map((r) => r.getBoundingClientRect().left);
      return { text: range.getBoundingClientRect().left, selection: Math.min(...rects) };
    });
    assert.ok(Math.abs(selection - text) <= 2, `selection starts at ${selection}, text at ${text}`);
  });
});
