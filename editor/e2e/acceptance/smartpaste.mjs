// Smart paste: a bare address becomes a link with the page's title once it is known, HTML
// becomes Markdown, and a pasted list nests where it lands. The title lookup is stubbed in the
// main process, so the test needs no network.

import assert from "node:assert/strict";
import { suite } from "../harness.mjs";

/** Makes the main process answer every title lookup with `title` after `delay` ms. */
async function stubTitles(s, title, delay = 0) {
  await s.app.evaluate(
    ({ ipcMain }, [t, d]) => {
      ipcMain.removeHandler("pageTitle");
      ipcMain.handle("pageTitle", () => new Promise((resolve) => setTimeout(resolve, d, t)));
    },
    [title, delay],
  );
}

/** Pastes `text` (and `html`) into the editor as a paste event with both formats, like a browser's copy. */
function paste(s, text, html) {
  return s.win.evaluate(
    ({ text, html }) => {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      if (html !== undefined) data.setData("text/html", html);
      document.querySelector(".cm-content").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    },
    { text, html },
  );
}

suite("Smart paste", null, (test) => {
  test("an address pasted alone becomes a link with the page title, and undo brings the address back, then removes it", async (s) => {
    await stubTitles(s, "Example Domain");
    await s.openWith("sp-title", "See ");
    await paste(s, "https://example.com/docs");
    await s.win.waitForFunction(() => document.querySelector(".cm-content").textContent.includes("[Example Domain](https://example.com/docs)"));
    assert.equal(await s.body(), "See [Example Domain](https://example.com/docs)");
    await s.key("Control+z");
    assert.equal(await s.body(), "See https://example.com/docs");
    await s.key("Control+z");
    assert.equal(await s.body(), "See ");
  });

  test("what is typed while the title is on its way stays, and the title lands on the address", async (s) => {
    await stubTitles(s, "Slow page", 400);
    await s.openWith("sp-slow", "");
    await paste(s, "https://example.com/a");
    await s.type(" typed meanwhile");
    await s.win.waitForFunction(() => document.querySelector(".cm-content").textContent.includes("[Slow page]"));
    assert.equal(await s.body(), "[Slow page](https://example.com/a) typed meanwhile");
  });

  test("an address whose page has no title stays as pasted", async (s) => {
    await stubTitles(s, null, 100);
    await s.openWith("sp-none", "");
    await paste(s, "https://example.com/none");
    await s.win.waitForTimeout(400);
    assert.equal(await s.body(), "https://example.com/none");
  });

  test("HTML becomes Markdown: marks, links and a nested list", async (s) => {
    await s.openWith("sp-html", "");
    await paste(
      s,
      "Bold link\none\ntwo\nthree",
      '<meta charset="utf-8"><p><b>Bold</b> <a href="https://example.com/x">link</a></p><ul><li>one<ul><li>two</li></ul></li><li>three</li></ul>',
    );
    assert.equal(await s.body(), "**Bold** [link](https://example.com/x)\n\n- one\n  - two\n- three");
  });

  test("a list pasted over an empty nested item takes its place and indentation", async (s) => {
    await s.openWith("sp-nest", "- top\n  - ");
    await paste(s, "a\nb", "<ul><li>a<ul><li>b</li></ul></li></ul>");
    assert.equal(await s.body(), "- top\n  - a\n    - b");
  });

  test("plain words and code are pasted as they are", async (s) => {
    await s.openWith("sp-plain", "");
    await paste(s, "just *words*", "<span style='color:red'>just *words*</span>");
    assert.equal(await s.body(), "just *words*");
  });
});
