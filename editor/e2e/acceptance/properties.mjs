// The front matter of a page, drawn as a title and one line of properties (rendered mode).

import assert from "node:assert/strict";
import { daysAgo, suite } from "../harness.mjs";

const day = daysAgo(1);

function bundle() {
  return {
    "project/tessela.md": '---\ntype: project\ntitle: "Tessela"\ntags: [okf, rust]\ntimestamp: "2026-10-27 09:00:00-03:00"\n---\n\nThe editor project.\n\nSecond paragraph.\n',
    "plain.md": "---\ntype: concept\n---\n\nNo title in the front matter.\n",
    "same.md": '---\ntype: concept\ntitle: "Same"\n---\n\n# Same\n\nText.\n',
    [`journals/${day}.md`]: `---\ntype: journal\ntitle: "${day}"\ndate: "${day}"\n---\n\nA day.\n`,
  };
}

const lines = (s) => s.win.$$eval(".cm-line", (ls) => ls.map((l) => l.textContent));

suite(
  "Properties",
  bundle,
  (test) => {
    test("Markdown is rendered when the window opens for the first time", async (s) => {
      assert.equal(await s.win.getAttribute("#preview-toggle", "aria-pressed"), "true");
    });

    test("the front matter is drawn as a title and a line of properties", async (s) => {
      await s.open("project/tessela");
      await s.win.waitForSelector(".cm-props-title");
      assert.equal(await s.win.textContent(".cm-props-title"), "Tessela");
      const chips = await s.texts(".cm-props-chip");
      assert.deepEqual(chips, ["project", "#okf", "#rust", "27 Oct 2026, 09:00"]);
      assert.equal(await s.win.getAttribute(".cm-props-when", "title"), "timestamp: 2026-10-27 09:00:00-03:00");
      assert.ok(!(await lines(s)).some((l) => l.startsWith("type:")), "the YAML is hidden");
    });

    test("a page opens with the cursor in its text, so the properties stay drawn", async (s) => {
      await s.open("project/tessela");
      await s.win.keyboard.press("Control+Home");
      await s.win.waitForFunction(() => document.querySelector(".cm-line")?.textContent?.startsWith("---"));
      await s.open("plain");
      await s.open("project/tessela");
      assert.ok(await s.win.$(".cm-props-title"));
    });

    test("Edit properties shows the YAML, and leaving it draws the properties again", async (s) => {
      await s.open("project/tessela");
      await s.win.hover(".cm-props");
      await s.win.click(".cm-props-edit");
      await s.win.waitForFunction(() => !document.querySelector(".cm-props-title"));
      assert.ok((await lines(s)).some((l) => l.startsWith("type: project")));
      await s.win.click(".cm-line:has-text('Second paragraph')");
      await s.win.waitForSelector(".cm-props-title");
    });

    test("typing after a click on the title writes in the text, not in front of the front matter", async (s) => {
      await s.open("plain");
      await s.win.click(".cm-props");
      await s.type("First line");
      await s.saved();
      const text = (await import("node:fs")).readFileSync(`${s.bundle}/plain.md`, "utf8");
      assert.ok(text.startsWith("---\ntype: concept\n---\n"), text);
      assert.ok(text.includes("First line"), text);
      assert.ok(await s.win.$(".cm-props"));
    });

    test("going up into the properties lands on the first property, never on line 1", async (s) => {
      await s.open("same");
      await s.key("Control+Home");
      await s.win.waitForFunction(() => document.querySelector(".cm-line")?.textContent === "---");
      await s.type("x");
      // A heading would be drawn bigger than the text: the line with the typed letter is not.
      const sizes = await s.win.$$eval(".cm-line", (ls) => ls.slice(0, 4).map((l) => getComputedStyle(l.querySelector("span") ?? l).fontSize));
      assert.ok(sizes.every((z) => z === sizes[0]), sizes.join());
      assert.equal((await lines(s))[0], "---");
    });

    test("a page without a title in its front matter is titled by its name", async (s) => {
      await s.open("plain");
      await s.win.waitForSelector(".cm-props-title");
      assert.equal(await s.win.textContent(".cm-props-title"), "plain");
    });

    test("a heading that repeats the title is not drawn twice", async (s) => {
      await s.open("same");
      await s.win.waitForSelector(".cm-props-row");
      assert.equal(await s.win.locator(".cm-props-title").count(), 0);
      assert.ok((await lines(s)).some((l) => l.trim() === "Same"));
    });

    test("a journal day shows no front matter and no properties", async (s) => {
      await s.win.click("#journals-view");
      await s.win.waitForFunction(() => document.querySelectorAll(".card").length > 1);
      assert.equal(await s.win.locator(".cm-props-title, .cm-props-row").count(), 0);
      const all = (await lines(s)).join("\n");
      assert.ok(!all.includes("type: journal"), all);
      assert.ok(all.includes("A day."), all);
    });

    test("the properties are still on disk exactly as written", async (s) => {
      await s.open("project/tessela");
      await s.key("Control+End");
      await s.type(" Added.");
      await s.saved();
      const text = (await import("node:fs")).readFileSync(`${s.bundle}/project/tessela.md`, "utf8");
      assert.ok(text.startsWith('---\ntype: project\ntitle: "Tessela"\ntags: [okf, rust]\ntimestamp: "2026-10-27 09:00:00-03:00"\n---\n'), text);
    });

    test("turning rendering off shows the YAML as written", async (s) => {
      await s.open("project/tessela");
      await s.win.click("#preview-toggle");
      await s.win.waitForFunction(() => !document.querySelector(".cm-props-title"));
      assert.ok((await lines(s)).some((l) => l.startsWith("type: project")));
      await s.win.click("#preview-toggle");
    });
  },
  { rendered: true },
);
