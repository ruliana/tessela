// Live preview: Markdown shown rendered, raw only in the block being edited.

import assert from "node:assert/strict";
import { suite, write } from "../harness.mjs";

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

const withTable = [
  "Intro paragraph.",
  "",
  "| Name | Count | Note |",
  "| :--- | ---: | :---: |",
  "| alpha | 1 | **big** and `code` |",
  "| beta | 22 | [site](https://example.com/t) |",
  "",
  "After the table.",
].join("\n");

const withLinks = [
  "Web [site](https://example.com/page) here.",
  "",
  "Concept [project](/project/tessela.md) there.",
  "",
  "Last paragraph.",
].join("\n");

/** The window remembers the choice between runs, so every suite starts from the preview being off. */
async function startOff(s) {
  await s.win.evaluate(() => localStorage.removeItem("tessela.livePreview"));
  await s.win.reload();
  await s.win.waitForSelector(".cm-content");
}

/** Replaces the system's opener, so the test can see what was asked to open. */
async function stubOpener(s) {
  await s.app.evaluate(({ shell }) => {
    globalThis.__opened = [];
    shell.openExternal = async (url) => void globalThis.__opened.push(url);
  });
}
const opened = (s) => s.app.evaluate(() => globalThis.__opened);

suite("Live preview tables and links", () => ({ "project/tessela.md": "---\ntype: project\n---\n\nThe project.\n" }), (test) => {
  test("a table is drawn as a table", async (s) => {
    await startOff(s);
    await stubOpener(s);
    await s.openWith("tables", withTable);
    await s.win.click("#preview-toggle");
    await s.win.waitForSelector(".cm-lp-table");
    assert.deepEqual(await s.texts(".cm-lp-table th"), ["Name", "Count", "Note"]);
    assert.deepEqual(await s.texts(".cm-lp-table tbody tr:first-child td"), ["alpha", "1", "big and code"]);
    assert.ok(!(await s.doc()).includes("| alpha"), "the rows are not shown as text");
  });

  test("columns follow the alignment, and cells show their formatting", async (s) => {
    const align = await s.win.$$eval(".cm-lp-table th", (ths) => ths.map((t) => getComputedStyle(t).textAlign));
    assert.deepEqual(align, ["left", "right", "center"]);
    assert.equal(await s.win.locator(".cm-lp-table strong").textContent(), "big");
    assert.equal(await s.win.locator(".cm-lp-table code").textContent(), "code");
  });

  test("clicking the table shows it as text, with the cursor in that row", async (s) => {
    await s.win.click(".cm-lp-table td:has-text('beta')");
    await s.win.waitForFunction(() => !document.querySelector(".cm-lp-table"));
    const doc = await s.doc();
    assert.ok(doc.includes("| alpha | 1 | **big** and `code` |"), doc);
    assert.ok(doc.includes("| :--- | ---: | :---: |"), doc);
    await s.key("Home");
    await s.type("| gamma | 3 | x |\n");
    assert.ok((await s.doc()).includes("| gamma | 3 | x |"));
  });

  test("leaving the table draws it again, and the file keeps the Markdown", async (s) => {
    await s.win.click(".cm-line:has-text('After the table')");
    await s.win.waitForSelector(".cm-lp-table");
    assert.deepEqual(await s.texts(".cm-lp-table tbody tr:nth-child(2) td"), ["gamma", "3", "x"]);
    const body = await s.savedBody("tables");
    assert.ok(body.includes("| Name | Count | Note |\n| :--- | ---: | :---: |\n| alpha | 1 | **big** and `code` |\n| gamma | 3 | x |\n| beta |"), body);
  });

  test("a link in a table opens the address", async (s) => {
    await s.win.click(".cm-lp-table a");
    assert.deepEqual(await opened(s), ["https://example.com/t"]);
    // The table is still drawn: following a link is not editing.
    assert.equal(await s.win.locator(".cm-lp-table").count(), 1);
  });

  test("with the preview off, the table is plain text", async (s) => {
    await s.win.click("#preview-toggle");
    await s.win.waitForFunction(() => !document.querySelector(".cm-lp-table"));
    assert.ok((await s.doc()).includes("| :--- | ---: | :---: |"));
  });

  test("a link drawn as text opens with a plain click", async (s) => {
    await s.openWith("links", withLinks);
    await s.win.click("#preview-toggle");
    await s.win.waitForSelector(".cm-lp-link");
    await s.win.click(".cm-lp-link:has-text('site')");
    assert.deepEqual((await opened(s)).slice(1), ["https://example.com/page"]);
  });

  test("a link to a concept opens its page", async (s) => {
    await s.win.click(".cm-lp-link:has-text('project')");
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "project/tessela");
    assert.ok((await s.doc()).includes("The project."));
    await s.open("links");
    await s.win.waitForSelector(".cm-lp-link");
  });

  test("in the block being edited a plain click only places the cursor", async (s) => {
    await s.win.click(".cm-line:has-text('Web')");
    await s.win.waitForFunction(() => [...document.querySelectorAll(".cm-line")].some((l) => l.textContent.includes("](https://example.com/page)")));
    const before = (await opened(s)).length;
    await s.win.click(".cm-line:has-text('](https://example.com/page)') >> text=site");
    assert.equal((await opened(s)).length, before);
  });

  test("Ctrl+click opens it even then, and also with the preview off", async (s) => {
    const before = (await opened(s)).length;
    await s.win.click(".cm-line:has-text('](https://example.com/page)') >> text=site", { modifiers: ["Control"] });
    assert.equal((await opened(s)).length, before + 1);
    await s.win.click("#preview-toggle");
    await s.win.waitForFunction(() => document.querySelector("#preview-toggle")?.getAttribute("aria-pressed") === "false");
    await s.win.click(".cm-line:has-text('Last paragraph')");
    const plain = (await opened(s)).length;
    await s.win.click(".cm-line:has-text('](https://example.com/page)') >> text=site");
    assert.equal((await opened(s)).length, plain, "a plain click does not follow links");
    await s.win.click(".cm-line:has-text('](https://example.com/page)') >> text=site", { modifiers: ["Control"] });
    assert.equal((await opened(s)).length, plain + 1);
    await s.win.evaluate(() => localStorage.removeItem("tessela.livePreview"));
  });
});

const filler = Array.from({ length: 60 }, (_, i) => `Filler paragraph number ${i + 1}.\n`).join("\n");

const longPage = [
  "[Go to the second part](#second-heading) and [again](#Second%20Heading) and [nowhere](#missing).",
  "",
  "## First heading",
  "",
  filler,
  "## Second heading",
  "",
  "Text under the second heading.",
  "",
  "[Back to the top](#first-heading)",
  "",
  filler,
].join("\n");

const widePage = [
  "![the wide picture](assets/wide.svg)",
  "",
  "![gone](assets/nothing.png)",
  "",
  "| First column | Second column | Third column |",
  "| --- | --- | --- |",
  "| A fairly long sentence that has to wrap | Another long sentence that also has to wrap | And a third long sentence for good measure |",
  "| short | short | short |",
  "",
  "End of the page.",
].join("\n");

const wide = '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="400"><rect width="1600" height="400" fill="#2f6f5e"/></svg>';

/** The window, in pixels wide. */
const resize = (s, width) =>
  s.app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setSize(w, 860), width);

suite("Live preview anchors, pictures and width", () => ({ "assets/wide.svg": wide }), (test) => {
  test("a link to #heading scrolls to that heading", async (s) => {
    await startOff(s);
    await s.openWith("long", longPage);
    await s.key("Control+Home");
    // The block with the cursor is shown as text, so move the cursor to another one.
    await s.win.click(".cm-line:has-text('Filler paragraph number 3.')");
    await s.win.click("#preview-toggle");
    await s.win.waitForSelector(".cm-lp-link");
    const top = () =>
      s.win.evaluate(() => {
        const line = [...document.querySelectorAll(".cm-line")].find((l) => l.textContent.includes("Second heading"));
        return line ? Math.round(line.getBoundingClientRect().top) : null;
      });
    const before = await top();
    assert.ok(before === null || before > 860, `the heading starts out of sight (${before})`);
    await s.win.click(".cm-lp-link:has-text('Go to the second part')");
    await s.win.waitForFunction(() => {
      const line = [...document.querySelectorAll(".cm-line")].find((l) => l.textContent.includes("Second heading"));
      const r = line?.getBoundingClientRect();
      return r && r.top >= 0 && r.bottom <= window.innerHeight;
    });
  });

  test("the heading is where the cursor is, and a link back works too", async (s) => {
    await s.win.click(".cm-lp-link:has-text('Back to the top')");
    await s.win.waitForFunction(() => {
      const line = [...document.querySelectorAll(".cm-line")].find((l) => l.textContent.includes("First heading"));
      const r = line?.getBoundingClientRect();
      return r && r.top >= 0 && r.bottom <= window.innerHeight;
    });
  });

  test("an anchor in another spelling, or one that does not exist", async (s) => {
    await s.win.click(".cm-lp-link:has-text('nowhere')");
    // Nothing happens, and nothing breaks: the next link still works.
    await s.win.click(".cm-lp-link:has-text('again')");
    await s.win.waitForFunction(() => {
      const line = [...document.querySelectorAll(".cm-line")].find((l) => l.textContent.includes("Second heading"));
      const r = line?.getBoundingClientRect();
      return r && r.top >= 0 && r.bottom <= window.innerHeight;
    });
  });

  test("a picture of the notes folder is shown, and a missing one shows its description", async (s) => {
    await s.openWith("wide", widePage);
    // Still on from the test before.
    await s.win.waitForFunction(() => document.querySelector("#preview-toggle")?.getAttribute("aria-pressed") === "true");
    await s.win.waitForFunction(() => {
      const img = document.querySelector(".cm-lp-image");
      return img && img.naturalWidth > 0;
    });
    await s.win.waitForSelector(".cm-lp-missing");
    assert.equal(await s.win.locator(".cm-lp-missing").textContent(), "gone");
    assert.equal(await s.win.locator(".cm-lp-image").getAttribute("alt"), "the wide picture");
  });

  test("the picture is shown as text while its line is being edited", async (s) => {
    assert.equal(await s.win.locator(".cm-lp-image").count(), 1);
    await s.win.click(".cm-lp-image");
    await s.win.waitForFunction(() => [...document.querySelectorAll(".cm-line")].some((l) => l.textContent.includes("![the wide picture](assets/wide.svg)")));
    assert.equal(await s.win.locator(".cm-lp-image").count(), 0);
    await s.win.click(".cm-line:has-text('End of the page')");
  });

  test("tables and pictures fit the window, with a margin on both sides", async (s) => {
    for (const width of [1360, 1000, 800]) {
      await resize(s, width);
      await s.win.waitForFunction((w) => Math.abs(window.outerWidth - w) < 40, width);
      const fit = await s.win.evaluate(() => {
        const content = document.querySelector(".cm-content").getBoundingClientRect();
        const box = (sel) => document.querySelector(sel).getBoundingClientRect();
        return ["img.cm-lp-image", ".cm-lp-table"].map((sel) => {
          const r = box(sel);
          return { sel, left: r.left - content.left, right: content.right - r.right, width: r.width };
        });
      });
      for (const f of fit) {
        assert.ok(f.left >= 20 && f.right >= 20, `${f.sel} has margins at ${width}: ${JSON.stringify(fit)}`);
      }
    }
    await resize(s, 1360);
  });

  test("the cells of a narrow table wrap instead of running out of the window", async (s) => {
    await resize(s, 800);
    await s.win.waitForFunction(() => Math.abs(window.outerWidth - 800) < 40);
    const rows = await s.win.evaluate(() => document.querySelector(".cm-lp-table tbody tr").getBoundingClientRect().height);
    assert.ok(rows > 40, `the long cells take several lines (${rows}px)`);
    const page = await s.win.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(page <= 0, `the page does not scroll sideways (${page}px)`);
    await resize(s, 1360);
  });

  test("switching it off for the next tests", async (s) => {
    await s.win.click("#preview-toggle");
    await s.win.waitForFunction(() => document.querySelector("#preview-toggle")?.getAttribute("aria-pressed") === "false");
    await s.win.evaluate(() => localStorage.removeItem("tessela.livePreview"));
  });
});
