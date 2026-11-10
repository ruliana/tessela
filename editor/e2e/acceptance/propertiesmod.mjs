// The properties mod (bundled, mods/properties): the properties drawn at the top of a page can be
// changed where they are drawn. A type, a tag, the date and a plain value each open a small editor;
// a change rewrites that one key through the CLI and leaves every other byte of the page alone.

import assert from "node:assert/strict";
import { read, suite, write } from "../harness.mjs";

const PROJECT = '---\ntype: project\ntitle: "Tessela"\ntags: [okf, rust]\ntimestamp: "2026-10-27 09:00:00-03:00"\nowner: ana\n---\n\nThe editor project.\n';
const BLOCK = '---\ntype: concept\ntitle: "Block"\n# kept as written\ntags:\n  - one\n  - two\n  - three\nnote: keep   this  spacing\n---\n\nBody.\n';

const files = () => ({
  "project/tessela.md": PROJECT,
  "block.md": BLOCK,
  "decision.md": "---\ntype: decision\n---\n\nChose it. #machine-learning\n",
  "howto.md": "---\ntype: howto\n---\n\nSteps. #machine-learning #deep-learning\n",
});

const chips = (s) => s.texts(".cm-props-chip");

/** Waits until the page on disk satisfies `ok`, and returns its text. */
async function onDisk(s, path, ok) {
  const until = Date.now() + 8000;
  for (;;) {
    const text = read(s.bundle, path);
    if (ok(text)) return text;
    if (Date.now() > until) assert.fail(`${path} on disk:\n${text}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Writes the page and shows it. (Session.open also clicks the middle of the page, which can be a chip.) */
async function start(s, name, text) {
  write(s.bundle, `${name}.md`, text);
  await s.win.fill("#search", name);
  await s.win.press("#search", "Enter");
  await s.win.waitForFunction((n) => document.querySelector(".card-title")?.textContent === n.split("/").pop() || document.querySelector(".card-title")?.textContent === n, name);
  await s.win.waitForSelector(".cm-props-row");
}

suite(
  "Properties mod",
  files,
  (test) => {
    test("the type chip offers the types the notes have, and a pick rewrites only that line", async (s) => {
      await start(s, "project/tessela", PROJECT);
      await s.win.click(".cm-props-type");
      await s.win.waitForSelector(".prop-pop .prop-input");
      const options = await s.texts(".prop-pop .prop-opt");
      assert.deepEqual([...options].sort(), ["concept", "decision", "howto"], "the types in use, without the page's own");
      await s.win.click('.prop-pop .prop-opt:text-is("decision")');
      const text = await onDisk(s, "project/tessela.md", (t) => t.includes("type: decision"));
      assert.equal(text, PROJECT.replace("type: project", "type: decision"));
      await s.win.waitForFunction(() => document.querySelector(".cm-props-type")?.textContent === "decision");
      assert.equal(await s.win.locator(".prop-pop").count(), 0);
    });

    test("a tag is changed by typing its replacement; the other tags stay as written", async (s) => {
      await start(s, "project/tessela", PROJECT);
      await s.win.click(".cm-props-tag >> text=#rust");
      await s.win.fill(".prop-pop .prop-input", "Golang");
      await s.key("Enter");
      const text = await onDisk(s, "project/tessela.md", (t) => t.includes("golang"));
      assert.equal(text, PROJECT.replace("[okf, rust]", "[okf, golang]"));
      await s.win.waitForFunction(() => [...document.querySelectorAll(".cm-props-tag")].some((c) => c.textContent === "#golang"));
    });

    test("a tag is added from the vocabulary of the notes", async (s) => {
      await start(s, "project/tessela", PROJECT);
      await s.win.click(".prop-add-tag");
      await s.type("mach");
      await s.win.waitForSelector('.prop-pop .prop-opt:text-is("machine-learning")');
      assert.ok(!(await s.texts(".prop-pop .prop-opt")).includes("okf"), "a tag the page has is not offered again");
      await s.win.click('.prop-pop .prop-opt:text-is("machine-learning")');
      const text = await onDisk(s, "project/tessela.md", (t) => t.includes("machine-learning"));
      assert.equal(text, PROJECT.replace("[okf, rust]", "[okf, rust, machine-learning]"));
    });

    test("a tag is removed from a block list without touching the lines around it", async (s) => {
      await start(s, "block", BLOCK);
      assert.deepEqual(await chips(s), ["concept", "#one", "#two", "#three", "note keep   this  spacing"]);
      await s.win.click(".cm-props-tag >> text=#two");
      await s.win.click(".prop-pop .prop-remove");
      const text = await onDisk(s, "block.md", (t) => !t.includes("two"));
      assert.equal(text, BLOCK.replace("  - two\n", ""));
      await s.win.waitForFunction(() => document.querySelectorAll(".cm-props-tag").length === 2);
    });

    test("a block list takes a new tag after the last one, and a page without tags gets the key", async (s) => {
      await start(s, "block", BLOCK);
      await s.win.click(".prop-add-tag");
      await s.type("four");
      await s.key("Enter");
      const text = await onDisk(s, "block.md", (t) => t.includes("four"));
      assert.equal(text, BLOCK.replace("  - three\n", "  - three\n  - four\n"));
      const bare = "---\ntype: concept\n---\n\nNo tags yet.\n";
      await start(s, "bare", bare);
      await s.win.click(".prop-add-tag");
      await s.type("first");
      await s.key("Enter");
      assert.equal(await onDisk(s, "bare.md", (t) => t.includes("first")), "---\ntype: concept\ntags: [first]\n---\n\nNo tags yet.\n");
    });

    test("the date is changed with a typed value, quoted as it was, and a wrong value is refused", async (s) => {
      await start(s, "project/tessela", PROJECT);
      await s.win.hover(".cm-props");
      await s.win.click(".prop-edit-when");
      await s.win.fill(".prop-pop .prop-input", "next week");
      await s.key("Enter");
      assert.equal(await s.win.getAttribute(".prop-pop .prop-input", "aria-invalid"), "true");
      assert.equal(read(s.bundle, "project/tessela.md"), PROJECT, "nothing was written");
      await s.win.fill(".prop-pop .prop-input", "2026-12-01 10:30:00-03:00");
      await s.key("Enter");
      const text = await onDisk(s, "project/tessela.md", (t) => t.includes("2026-12-01"));
      assert.equal(text, PROJECT.replace("2026-10-27 09:00:00-03:00", "2026-12-01 10:30:00-03:00"));
      await s.win.waitForFunction(() => document.querySelector(".cm-props-when")?.textContent === "1 Dec 2026, 10:30");
    });

    test("the date offers Today and Now, as the / menu does", async (s) => {
      await start(s, "project/tessela", PROJECT);
      await s.win.hover(".cm-props");
      await s.win.click(".prop-edit-when");
      assert.deepEqual(await s.texts(".prop-pop .prop-opt"), ["Today", "Tomorrow", "Yesterday", "Now"]);
      await s.win.click('.prop-pop .prop-opt:text-is("Now")');
      const text = await onDisk(s, "project/tessela.md", (t) => !t.includes("2026-10-27"));
      assert.match(text, /\ntimestamp: "\d{4}-\d\d-\d\d \d\d:\d\d:\d\d[+-]\d\d:\d\d"\n/);
      assert.equal(text.replace(/\ntimestamp: .*\n/, "\ntimestamp: X\n"), PROJECT.replace(/\ntimestamp: .*\n/, "\ntimestamp: X\n"));
    });

    test("the date still opens its day when clicked", async (s) => {
      write(s.bundle, "journals/2026-10-27.md", '---\ntype: journal\ntitle: "2026-10-27"\ndate: "2026-10-27"\n---\n\nThat day.\n');
      await start(s, "project/tessela", PROJECT.replace(/timestamp: ".*"/, 'timestamp: "2026-10-27"'));
      await s.win.click(".cm-props-day");
      await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "2026-10-27");
    });

    test("a plain value is edited in place, and emptied it takes its key away", async (s) => {
      await start(s, "project/tessela", PROJECT);
      await s.win.click(".cm-props-other");
      await s.win.fill(".prop-pop .prop-input", "bia");
      await s.key("Enter");
      assert.equal(await onDisk(s, "project/tessela.md", (t) => t.includes("owner: bia")), PROJECT.replace("owner: ana", "owner: bia"));
      await s.win.waitForFunction(() => document.querySelector(".cm-props-other")?.textContent === "owner bia");
      await s.win.click(".cm-props-other");
      await s.win.fill(".prop-pop .prop-input", "");
      await s.key("Enter");
      assert.equal(await onDisk(s, "project/tessela.md", (t) => !t.includes("owner")), PROJECT.replace("owner: ana\n", ""));
    });

    test("Escape closes the editor and writes nothing", async (s) => {
      await start(s, "project/tessela", PROJECT);
      await s.win.click(".cm-props-other");
      await s.win.fill(".prop-pop .prop-input", "zed");
      await s.key("Escape");
      assert.equal(await s.win.locator(".prop-pop").count(), 0);
      await s.win.waitForTimeout(500);
      assert.equal(read(s.bundle, "project/tessela.md"), PROJECT);
    });

    test("what was typed in the page is saved first, so the change does not lose it", async (s) => {
      await start(s, "project/tessela", PROJECT);
      await s.win.click(".cm-line >> text=The editor project.");
      await s.key("End");
      await s.type(" More.");
      await s.win.click(".cm-props-type");
      await s.win.click('.prop-pop .prop-opt:text-is("howto")');
      const text = await onDisk(s, "project/tessela.md", (t) => t.includes("type: howto"));
      assert.equal(text, PROJECT.replace("type: project", "type: howto").replace("The editor project.", "The editor project. More."));
    });

    test("clicking the title still lands in the text, and the other chips are unchanged", async (s) => {
      await start(s, "project/tessela", PROJECT);
      assert.deepEqual(await chips(s), ["project", "#okf", "#rust", "27 Oct 2026, 09:00", "owner ana"]);
      await s.win.click(".cm-props-title");
      await s.type("Typed");
      await s.saved();
      assert.ok(read(s.bundle, "project/tessela.md").startsWith(PROJECT.slice(0, PROJECT.indexOf("\n---\n") + 5)));
    });
  },
  { rendered: true },
);

suite(
  "Properties mod: switched off",
  () => ({ "p.md": PROJECT }),
  (test) => {
    test("with --no-mods the properties are drawn, and no editor opens", async (s) => {
      await s.open("p");
      await s.win.waitForSelector(".cm-props-row");
      assert.equal(await s.win.locator(".prop-add-tag, .prop-edit-when").count(), 0);
      await s.win.click(".cm-props-type");
      assert.equal(await s.win.locator(".prop-pop").count(), 0);
    });
  },
  { rendered: true, args: ["--no-mods"] },
);
