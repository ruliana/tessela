// Lists in a window: a wrapped line hangs under the first letter after its marker, and a bullet that
// holds a picture is a figure (no bullet, the picture a block of its own, the text around it a caption).
// The decorations are checked in test/listLayout.test.ts; this measures the result.

import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { suite } from "../harness.mjs";

// A real 1x1 PNG, stretched by the page to the width of the text.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const long = (word) => Array.from({ length: 40 }, (_, i) => `${word}${i}`).join(" ");
const page = [
  `- ${long("alpha")}`,
  `  - ${long("bravo")}`,
  `    - [ ] ${long("charlie")}`,
  `1. ${long("delta")}`,
  "",
  "- ![](/assets/pic.png) Sticky mixing against the underlying text",
  "- Another bullet",
  "- A caption before the picture ![](/assets/pic.png)",
  "",
  "end",
].join("\n");

/** For the line that holds `word`: the left edge of each visual line of its text, and where the word is. */
const lines = (s, word) =>
  s.win.evaluate((w) => {
    const line = [...document.querySelectorAll(".cm-line")].find((l) => l.textContent.includes(w));
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    const lefts = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.data.includes(w) && lefts.length === 0) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      // One rect per visual line of this run of text; the tops tell which line each is on.
      for (const r of range.getClientRects()) if (r.width > 0) lefts.push({ top: Math.round(r.top), left: r.left });
    }
    const tops = [...new Set(lefts.map((l) => l.top))].sort((a, b) => a - b);
    return tops.map((t) => Math.min(...lefts.filter((l) => l.top === t).map((l) => l.left)));
  }, word);

suite(
  "Lists hang and pictures are figures",
  null,
  (test) => {
    test("a wrapped line starts where the first letter after the marker is", async (s) => {
      mkdirSync(join(s.bundle, "assets"), { recursive: true });
      writeFileSync(join(s.bundle, "assets", "pic.png"), PNG);
      await s.openWith("lists", page);
      await s.win.click(".cm-line:has-text('end')");
      for (const word of ["alpha0", "bravo0", "charlie0", "delta0"]) {
        const lefts = await lines(s, word);
        assert.ok(lefts.length >= 3, `${word} wraps (${lefts.length} lines)`);
        const first = lefts[0];
        for (const [i, l] of lefts.slice(1).entries()) assert.ok(Math.abs(l - first) < 1, `${word}: line ${i + 2} starts at ${l}, the text at ${first}`);
      }
    });

    test("a nested item starts under the text of the item above it", async (s) => {
      const [a] = await lines(s, "alpha0");
      const [b] = await lines(s, "bravo0");
      assert.ok(b > a, "the nested bullet is further in");
      // Its bullet sits where the text of its parent starts, give or take the box of the bullet itself.
      const bullet = await s.win.evaluate(() => [...document.querySelectorAll(".cm-line")].find((l) => l.textContent.includes("bravo0")).querySelector(".cm-lp-bullet").getBoundingClientRect().left);
      assert.ok(Math.abs(bullet - a) < 3, `the bullet at ${bullet}, the text above at ${a}`);
    });

    test("a bullet with a picture has no bullet, no line above the picture, and its text under it as a caption", async (s) => {
      const info = await s.win.evaluate(() => {
        const find = (text) => [...document.querySelectorAll(".cm-line")].find((l) => l.textContent.includes(text));
        const line = find("Sticky mixing");
        const img = line.querySelector("img.cm-lp-figure");
        const cap = line.querySelector(".cm-lp-caption");
        const i = img?.getBoundingClientRect();
        // Where the first letter of the text of the next bullet is.
        const walker = document.createTreeWalker(find("Another bullet"), NodeFilter.SHOW_TEXT);
        let run = walker.nextNode();
        while (run && !run.data.includes("Another")) run = walker.nextNode();
        const range = document.createRange();
        range.setStart(run, run.data.indexOf("Another"));
        range.setEnd(run, run.data.indexOf("Another") + 1);
        return {
          bullets: line.querySelectorAll(".cm-lp-bullet").length,
          img: !!img,
          above: i ? i.top - line.getBoundingClientRect().top : null,
          captionBelow: img && cap ? cap.getBoundingClientRect().top - i.bottom : null,
          imgLeft: i?.left,
          siblingTextLeft: range.getBoundingClientRect().left,
        };
      });
      assert.equal(info.bullets, 0, "no bullet");
      assert.ok(info.img, "the picture is drawn as a figure");
      assert.ok(info.above < 8, `the picture is ${info.above}px under the top of its line`);
      assert.ok(info.captionBelow >= -1 && info.captionBelow < 12, `the caption is just under the picture (${info.captionBelow})`);
      assert.ok(Math.abs(info.imgLeft - info.siblingTextLeft) < 2, `the picture starts where the text of the bullets does (${info.imgLeft}, ${info.siblingTextLeft})`);
    });

    test("with the text before the picture, it is the picture's alt and its caption", async (s) => {
      const info = await s.win.evaluate(() => {
        const line = [...document.querySelectorAll(".cm-line")].find((l) => l.textContent.includes("A caption before"));
        const img = line.querySelector("img.cm-lp-figure");
        return { alt: img?.alt, bullets: line.querySelectorAll(".cm-lp-bullet").length, caption: line.querySelector(".cm-lp-caption")?.textContent };
      });
      assert.deepEqual(info, { alt: "A caption before the picture", bullets: 0, caption: "A caption before the picture" });
    });

    test("a click on the picture opens its Markdown, and the figure is a bullet-less line still", async (s) => {
      await s.win.click("img.cm-lp-figure >> nth=0");
      await s.win.waitForFunction(() => [...document.querySelectorAll(".cm-line")].some((l) => l.textContent.includes("![](/assets/pic.png)") && !l.querySelector("img.cm-lp-figure")));
      const text = await s.doc();
      assert.ok(text.includes("- ![](/assets/pic.png) Sticky mixing against the underlying text") || text.includes("![](/assets/pic.png) Sticky mixing"), text);
      // Typing in it goes where the cursor is, and the page keeps its Markdown.
      await s.key("End");
      await s.type("!");
      assert.ok((await s.doc()).includes("Sticky mixing against the underlying text!"));
    });
  },
  { rendered: true },
);
