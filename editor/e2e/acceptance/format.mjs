// Formatting keys, surround, auto-close, URL paste, tasks and the smart link (spec §11).

import assert from "node:assert/strict";
import { suite } from "../harness.mjs";

/** Puts `text` on the system clipboard and pastes it with Ctrl+V. */
async function paste(s, text) {
  await s.app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text);
  await s.key("Control+v");
}

suite("Formatting keys", null, (test) => {
  test("Ctrl+B marks the word at the cursor, and takes the mark off again", async (s) => {
    await s.openWith("fmt-bold", "");
    await s.type("hello");
    await s.key("Control+b");
    assert.equal(await s.body(), "**hello**");
    await s.key("Control+b");
    assert.equal(await s.body(), "hello");
  });

  test("Ctrl+B marks a selection of several words", async (s) => {
    await s.openWith("fmt-sel", "");
    await s.type("two words");
    await s.key("Shift+Home");
    await s.key("Control+b");
    assert.equal(await s.body(), "**two words**");
  });

  test("Ctrl+I italic, Ctrl+E code, Ctrl+Shift+X strikethrough", async (s) => {
    await s.openWith("fmt-marks", "");
    await s.type("one");
    await s.key("Control+i");
    await s.key("End");
    await s.type(" two");
    await s.key("Control+e");
    await s.key("End");
    await s.type(" three");
    await s.key("Control+Shift+x");
    assert.equal(await s.body(), "*one* `two` ~~three~~");
  });

  test("italic on a bold word stacks, and each toggles on its own", async (s) => {
    await s.openWith("fmt-stack", "");
    await s.type("word");
    await s.key("Control+b");
    await s.key("Control+i");
    assert.equal(await s.body(), "***word***");
    await s.key("Control+i");
    assert.equal(await s.body(), "**word**");
  });

  test("a mark on an empty spot inserts the pair and leaves the cursor inside", async (s) => {
    await s.openWith("fmt-empty", "");
    await s.key("Control+b");
    await s.type("x");
    assert.equal(await s.body(), "**x**");
  });

  test("a mark can be undone", async (s) => {
    await s.openWith("fmt-undo", "");
    await s.type("word");
    await s.key("Control+b");
    await s.key("Control+z");
    assert.equal(await s.body(), "word");
  });

  test("marks reach the disk", async (s) => {
    await s.openWith("fmt-save", "");
    await s.type("kept");
    await s.key("Control+b");
    assert.equal(await s.savedBody("fmt-save"), "**kept**");
  });
});

suite("Surround and auto-close", null, (test) => {
  for (const [typed, expected] of [
    ["*", "*word*"],
    ["_", "_word_"],
    ["~", "~word~"],
    ["(", "(word)"],
    ["[", "[word]"],
    ["{", "{word}"],
    ['"', '"word"'],
    ["`", "`word`"],
  ]) {
    test(`typing ${typed} over a selection surrounds it`, async (s) => {
      await s.openWith(`surround-${typed.charCodeAt(0)}`, "");
      await s.type("word");
      await s.key("Shift+Home");
      await s.type(typed);
      assert.equal(await s.body(), expected);
    });
  }

  test("surrounding keeps the text selected, so it can be wrapped again", async (s) => {
    await s.openWith("surround-twice", "");
    await s.type("word");
    await s.key("Shift+Home");
    await s.type("*");
    await s.type("*");
    assert.equal(await s.body(), "**word**");
  });

  test("surrounding can be undone", async (s) => {
    await s.openWith("surround-undo", "");
    await s.type("word");
    await s.key("Shift+Home");
    await s.type("*");
    await s.key("Control+z");
    assert.equal(await s.body(), "word");
  });

  for (const [open, pair] of [
    ["(", "()"],
    ["[", "[]"],
    ["{", "{}"],
    ['"', '""'],
    ["`", "``"],
  ]) {
    test(`${open} closes itself`, async (s) => {
      await s.openWith(`autoclose-${open.charCodeAt(0)}`, "");
      await s.type(open);
      assert.equal(await s.body(), pair);
      await s.type("x");
      assert.equal(await s.body(), `${open}x${pair[1]}`);
    });
  }

  test("typing the closing bracket steps over the one already there", async (s) => {
    await s.openWith("autoclose-over", "");
    await s.type("(x)");
    assert.equal(await s.body(), "(x)");
    await s.type("(y)");
    assert.equal(await s.body(), "(x)(y)");
  });

  test("Backspace on an empty pair removes both", async (s) => {
    await s.openWith("autoclose-back", "");
    await s.type("[");
    await s.key("Backspace");
    assert.equal(await s.body(), "");
  });

  test("an apostrophe is text, not a pair", async (s) => {
    await s.openWith("autoclose-apos", "");
    await s.type("don't");
    assert.equal(await s.body(), "don't");
  });

  test("a bracket typed in front of a word does not close", async (s) => {
    await s.openWith("autoclose-word", "");
    await s.type("word");
    await s.key("Home");
    await s.type("(");
    assert.equal(await s.body(), "(word");
  });

  test("a link typed by hand: [text](url) comes out right", async (s) => {
    await s.openWith("autoclose-link", "");
    await s.type("[text](https://example.com)");
    assert.equal(await s.body(), "[text](https://example.com)");
  });
});

suite("Paste a URL over a selection", null, (test) => {
  test("makes a link of the selected text", async (s) => {
    await s.openWith("paste-link", "");
    await s.type("the docs");
    await s.key("Shift+Home");
    await paste(s, "https://example.com/docs");
    assert.equal(await s.body(), "[the docs](https://example.com/docs)");
    assert.equal(await s.savedBody("paste-link"), "[the docs](https://example.com/docs)");
  });

  test("works with mailto:", async (s) => {
    await s.openWith("paste-mail", "");
    await s.type("write me");
    await s.key("Shift+Home");
    await paste(s, "mailto:me@example.com");
    assert.equal(await s.body(), "[write me](mailto:me@example.com)");
  });

  test("pasting the link can be undone", async (s) => {
    await s.openWith("paste-undo", "");
    await s.type("the docs");
    await s.key("Shift+Home");
    await paste(s, "https://example.com");
    await s.key("Control+z");
    assert.equal(await s.body(), "the docs");
  });

  test("a URL pasted with nothing selected is plain text", async (s) => {
    await s.openWith("paste-plain", "");
    await paste(s, "https://example.com");
    assert.equal(await s.body(), "https://example.com");
  });

  test("a URL pasted over several lines replaces them, it is not a link", async (s) => {
    await s.openWith("paste-lines", "");
    await s.enter("one\ntwo");
    await s.key("Shift+ArrowUp");
    await s.key("Shift+Home");
    await paste(s, "https://example.com");
    assert.equal(await s.body(), "https://example.com");
    await s.key("Control+z");
    assert.equal(await s.body(), "one\ntwo");
  });

  test("other text pasted over a selection replaces it", async (s) => {
    await s.openWith("paste-text", "");
    await s.type("old words");
    await s.key("Shift+Home");
    await paste(s, "new words");
    assert.equal(await s.body(), "new words");
  });
});

suite("Ctrl+Enter tasks", null, (test) => {
  test("makes a task of a paragraph, then ticks and unticks it", async (s) => {
    await s.openWith("task-para", "");
    await s.type("write the thing");
    await s.key("Control+Enter");
    assert.equal(await s.body(), "- [ ] write the thing");
    await s.key("Control+Enter");
    assert.equal(await s.body(), "- [x] write the thing");
    await s.key("Control+Enter");
    assert.equal(await s.body(), "- [ ] write the thing");
  });

  test("the cursor stays in the text", async (s) => {
    await s.openWith("task-cursor", "");
    await s.type("buy milk");
    await s.key("Control+Enter");
    await s.type("!");
    assert.equal(await s.body(), "- [ ] buy milk!");
  });

  test("makes a task of a list item, keeping its indent", async (s) => {
    await s.openWith("task-item", "- one\n  - two");
    await s.key("Control+Enter");
    assert.equal(await s.body(), "- one\n  - [ ] two");
  });

  test("works on numbered items", async (s) => {
    await s.openWith("task-number", "1. first");
    await s.key("Control+Enter");
    assert.equal(await s.body(), "1. [ ] first");
  });

  test("ticks an upper-case [X] task off", async (s) => {
    await s.openWith("task-upper", "- [X] done");
    await s.key("Control+Enter");
    assert.equal(await s.body(), "- [ ] done");
  });

  test("makes a task of an empty line, with the cursor ready for the text", async (s) => {
    await s.openWith("task-empty", "Intro\n\n");
    await s.key("Control+Enter");
    assert.equal(await s.body(), "Intro\n\n- [ ] ");
    await s.type("buy milk");
    assert.equal(await s.body(), "Intro\n\n- [ ] buy milk");
  });

  test("on an empty line inside a list the task keeps the indent", async (s) => {
    await s.openWith("task-empty-nested", "- one\n  ");
    await s.key("Control+Enter");
    assert.equal(await s.body(), "- one\n  - [ ] ");
  });

  test("does nothing on a heading: no task, no new line", async (s) => {
    await s.openWith("task-heading", "# Title\n\ntext");
    await s.key("ArrowUp");
    await s.key("ArrowUp");
    await s.key("Control+Enter");
    assert.equal(await s.body(), "# Title\n\ntext");
  });

  test("does nothing on a quote", async (s) => {
    await s.openWith("task-quote", "> quoted");
    await s.key("Control+Enter");
    assert.equal(await s.body(), "> quoted");
  });

  test("a task reaches the disk", async (s) => {
    await s.openWith("task-save", "");
    await s.type("ship it");
    await s.key("Control+Enter");
    assert.equal(await s.savedBody("task-save"), "- [ ] ship it");
  });

  test("Ctrl+Enter is undone in one step", async (s) => {
    await s.openWith("task-undo", "");
    await s.type("ship it");
    await s.key("Control+Enter");
    await s.key("Control+z");
    assert.equal(await s.body(), "ship it");
  });
});

suite("Smart link (Ctrl+L)", null, (test) => {
  test("a URL becomes [](url) with the cursor in the text", async (s) => {
    await s.openWith("link-url", "");
    await s.type("https://example.com");
    await s.key("Shift+Home");
    await s.key("Control+l");
    assert.equal(await s.body(), "[](https://example.com)");
    await s.type("Ex");
    assert.equal(await s.body(), "[Ex](https://example.com)");
  });

  test("a file path becomes [](path) with the cursor in the text", async (s) => {
    await s.openWith("link-file", "");
    await s.type("/project/tessela.md");
    await s.key("Shift+Home");
    await s.key("Control+l");
    await s.type("T");
    assert.equal(await s.body(), "[T](/project/tessela.md)");
  });

  test("other text becomes [text]() with the cursor in the target", async (s) => {
    await s.openWith("link-text", "");
    await s.type("Some text");
    await s.key("Shift+Home");
    await s.key("Control+l");
    assert.equal(await s.body(), "[Some text]()");
    await s.win.waitForSelector(".cm-tooltip-autocomplete");
    assert.match((await s.texts(".cm-tooltip-autocomplete li"))[0], /some-text/, "the slug of the text is offered first");
    await s.key("Escape");
    await s.type("/x.md");
    assert.equal(await s.body(), "[Some text](/x.md)");
  });

  test("with nothing selected it inserts []()", async (s) => {
    await s.openWith("link-none", "");
    await s.key("Control+l");
    assert.equal(await s.body(), "[]()");
    await s.type("name");
    assert.equal(await s.body(), "[name]()");
  });

  test("a link made with Ctrl+L can be undone", async (s) => {
    await s.openWith("link-undo", "");
    await s.type("Some text");
    await s.key("Shift+Home");
    await s.key("Control+l");
    await s.key("Escape");
    await s.key("Control+z");
    assert.equal(await s.body(), "Some text");
  });
});
