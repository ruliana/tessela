// The gfm-extras mod (bundled, mods/gfm-extras): the forms of GitHub-flavored Markdown the editor
// did not draw: callouts (`> [!NOTE]`), footnotes, math (`$x$`, `$$` blocks, ```math fences) and
// ```mermaid fences, and the commands "Copy link to this heading" and "Copy as quote". The page is
// always the same Markdown; the drawing is the editor's.

import assert from "node:assert/strict";
import { read, suite } from "../harness.mjs";

async function runCommand(s, label) {
  await s.key("Control+k");
  await s.win.waitForSelector("#palette");
  await s.type(label);
  await s.win.waitForFunction((l) => [...document.querySelectorAll("#palette .palette-item .t")].some((e) => e.textContent === l), label);
  await s.key("Enter");
  await s.win.waitForFunction(() => !document.querySelector("#palette"));
}

/** The clipboard once the command that fills it has written, or what is there after a second. */
async function clipboard(s, before) {
  let text = "";
  for (let i = 0; i < 20; i++) {
    text = await s.app.evaluate(({ clipboard }) => clipboard.readText());
    if (text !== before) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return text;
}

/** Runs the command and returns what it put on the clipboard. */
async function copied(s, label) {
  const before = await s.app.evaluate(({ clipboard }) => clipboard.readText());
  await runCommand(s, label);
  return clipboard(s, before);
}

/** Opens a page with `body`, the cursor at its start. */
async function pageWith(s, name, body) {
  await s.openWith(name, body);
  await s.key("Control+Home");
  await s.win.waitForSelector(".cm-line");
}

/** Puts the cursor at the start of the first line that starts with `text` (as the editor shows the page). */
async function goTo(s, text) {
  const lines = (await s.doc()).split("\n");
  const line = lines.findIndex((l, i) => l.startsWith(text) && lines.indexOf(l) === i);
  assert.ok(line >= 0, `${text} is on a line`);
  await s.key("Control+Home");
  for (let i = 0; i < line; i++) await s.key("ArrowDown");
  await s.key("Home");
}

suite("GFM extras: callouts", () => ({}), (test) => {
  test("a quote that starts with [!WARNING] is drawn as a warning, and a plain quote is not", async (s) => {
    await pageWith(s, "gfm-callout", "> [!WARNING]\n> Mind the gap.\n\n> Just a quote.\n\n```md\n> [!NOTE]\n```\n\nEnd.\n");
    await s.win.waitForSelector(".tessela-callout-warning");
    assert.equal(await s.win.locator(".tessela-callout-warning").count(), 2);
    assert.equal(await s.win.locator(".tessela-callout").count(), 2, "only the warning: not the plain quote, not the fenced example");
    assert.equal(await s.win.textContent(".tessela-callout-title"), "Warning");
    // The marker is drawn as the title, not shown as written.
    assert.doesNotMatch(await s.body(), /\[!WARNING\]/);
  });

  test("with the cursor in the callout its marker shows as written", async (s) => {
    await pageWith(s, "gfm-callout-edit", "> [!TIP]\n> Try this.\n\nEnd.\n");
    await s.win.waitForSelector(".tessela-callout-title");
    await goTo(s, "Tip");
    await s.win.waitForFunction(() => !document.querySelector(".tessela-callout-title"));
    assert.equal(await s.win.locator(".tessela-callout-tip").count(), 2, "it is still a callout, only drawn plainer");
  });
}, { rendered: true });

suite("GFM extras: footnotes", () => ({}), (test) => {
  test("a reference is drawn as its number, numbered by first use, and leads to its definition", async (s) => {
    await pageWith(s, "gfm-foot", "Second[^b] and first[^a].\n\n[^a]: The note A.\n[^b]: The note B.\n\nEnd.\n");
    await s.win.waitForSelector(".tessela-fn-ref");
    assert.deepEqual(await s.win.$$eval(".tessela-fn-ref", (e) => e.map((x) => x.textContent)), ["1", "2"]);
    assert.equal(await s.win.getAttribute(".tessela-fn-ref >> nth=0", "title"), "The note B.");
    await s.win.click(".tessela-fn-ref >> nth=0");
    // The cursor is on the definition of [^b], which is shown as written; the other one is still drawn.
    await s.win.waitForFunction(() => document.querySelectorAll(".tessela-fn-label").length === 1);
    assert.match(await s.doc(), /\[\^b\]: The note B\./);
  });

  test("Insert footnote puts a reference at the cursor and its definition at the end of the page", async (s) => {
    await pageWith(s, "gfm-foot-new", "A claim[^1] that needs it.\n\n[^1]: First.\n");
    await s.key("Control+End");
    await s.key("Enter");
    await s.type("Another claim");
    await runCommand(s, "Insert footnote");
    await s.type("The source.");
    await s.saved();
    const text = read(s.bundle, "gfm-foot-new.md");
    assert.match(text, /Another claim\[\^2\]/);
    assert.match(text, /\n\[\^2\]: The source\.\n?$/);
  });
}, { rendered: true });

suite("GFM extras: math", () => ({}), (test) => {
  test("inline $x$, a $$ block and a ```math fence are typeset; a price is not", async (s) => {
    await pageWith(s, "gfm-math", "Cost $5 and $6 here, and $a^2 + b^2$ there.\n\n$$\n\\frac{1}{2}\n$$\n\n```math\n\\sqrt{x}\n```\n\nEnd.\n");
    await s.win.waitForFunction(() => document.querySelectorAll(".tessela-math math").length >= 1);
    assert.equal(await s.win.locator(".tessela-math-inline math").count(), 1, "one inline formula, not the prices");
    await s.win.waitForFunction(() => document.querySelectorAll(".tessela-live math, .tessela-math-block math").length >= 2);
  });

  test("a formula with an error shows the error and the page goes on", async (s) => {
    await pageWith(s, "gfm-math-bad", "```math\n\\frac{\n```\n\nEnd.\n");
    await s.win.waitForSelector(".tessela-live .tessela-error, .tessela-live math");
    assert.match(await s.body(), /End\./);
  });
}, { rendered: true });

suite("GFM extras: mermaid", () => ({}), (test) => {
  test("a ```mermaid fence is drawn as a diagram under it", async (s) => {
    await pageWith(s, "gfm-mermaid", "```mermaid\ngraph TD\n  A[Start] --> B[End]\n```\n\nEnd.\n");
    await s.win.waitForSelector('.tessela-live[data-fence="mermaid"] svg', { timeout: 30000 });
    assert.match(await s.win.textContent('.tessela-live[data-fence="mermaid"] svg'), /Start/);
  });

  test("a diagram that does not parse shows its error", async (s) => {
    await pageWith(s, "gfm-mermaid-bad", "```mermaid\nthis is not a diagram\n```\n\nEnd.\n");
    await s.win.waitForSelector('.tessela-live[data-fence="mermaid"] .tessela-error', { timeout: 30000 });
  });
}, { rendered: true });

suite("GFM extras: copy commands", () => ({}), (test) => {
  test("Copy link to this heading writes a link to the section the cursor is in", async (s) => {
    await pageWith(s, "gfm-link", "# Top\n\nIntro.\n\n## Fast, and loose!\n\nBody text.\n\n## Fast, and loose!\n\nAgain.\n");
    await goTo(s, "Again.");
    assert.equal(await copied(s, "Copy link to this heading"), "[Fast, and loose!](/gfm-link.md#fast-and-loose-1)");
    await goTo(s, "Body text.");
    assert.equal(await copied(s, "Copy link to this heading"), "[Fast, and loose!](/gfm-link.md#fast-and-loose)");
  });

  test("Copy as quote copies the selection as a quote that links its page", async (s) => {
    await pageWith(s, "gfm-quote", "# Source title\n\nFirst line.\nSecond line.\n");
    await goTo(s, "First line.");
    await s.key("Shift+ArrowDown");
    await s.key("Shift+End");
    assert.equal(await copied(s, "Copy as quote"), "> First line.\n> Second line.\n>\n> — [Source title](/gfm-quote.md)\n");
  });
});
