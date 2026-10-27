// Drives the built app in a real window: save, smart link, backlinks, external change.
// Run with `npm run e2e` (needs a display: `xvfb-run -a npm run e2e` on a server).
import { _electron as electron } from "playwright-core";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const bundle = mkdtempSync(join(tmpdir(), "tessela-e2e-"));
mkdirSync(join(bundle, "journals"));
mkdirSync(join(bundle, "project"));
writeFileSync(
  join(bundle, "project/tessela.md"),
  "---\ntype: project\n---\n\nThe editor project.\n",
);
writeFileSync(join(bundle, "broken.md"), "no frontmatter here, searchable-needle\n");
const day = new Date();
const today = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
writeFileSync(
  join(bundle, "journals/2020-01-01.md"),
  "---\ntype: journal\ndate: 2020-01-01\n---\n\nWorked on #project/tessela today.\n",
);

const root = resolve(import.meta.dirname, "..");
// E2E_PACKAGED=release/linux-unpacked/tessela runs the packaged app, which must find the
// tessela tool it carries (so TESSELA_BIN is not set for it).
const packaged = process.env.E2E_PACKAGED;
if (!packaged) process.env.TESSELA_BIN ??= resolve(root, "../target/debug/tessela");
else delete process.env.TESSELA_BIN;
const app = await electron.launch(
  packaged
    ? { executablePath: resolve(root, packaged), args: ["--no-sandbox", `--bundle=${bundle}`], env: { ...process.env } }
    : { args: [join(root, "dist/main.cjs"), "--no-sandbox", `--bundle=${bundle}`], env: { ...process.env } },
);
const win = await app.firstWindow();
await win.waitForSelector(".cm-content");

// Opens on the journals: today first, then the earlier day, each in its own editor.
await win.waitForFunction(() => document.querySelectorAll(".card").length === 2);
assert.match(await win.textContent("#stack"), /2020-01-01/);
assert.match(await win.textContent("#stack"), /Worked on #project\/tessela today/);

// Opens on today's journal; typing autosaves to disk.
await win.click(".cm-content");
await win.keyboard.type("Hello from the e2e test");
const journal = join(bundle, "journals", `${today}.md`);
await win.waitForFunction(() => document.querySelector(".status")?.textContent === "Saved");
assert.match(readFileSync(journal, "utf8"), /Hello from the e2e test/);
assert.match(readFileSync(journal, "utf8"), /^---\ntype: journal/);

// Ctrl+L on a selected word makes it the link text and leaves the cursor in the target.
await win.keyboard.press("Control+a");
await win.keyboard.type("see");
await win.keyboard.press("Shift+Home");
await win.keyboard.press("Control+l");
await win.keyboard.type("/project/tessela.md");
await win.waitForFunction(() => document.querySelector(".status")?.textContent === "Saved");
assert.match(readFileSync(journal, "utf8"), /\[see\]\(\/project\/tessela\.md\)/);

// The journal on an earlier day is its own editor and saves on its own.
await win.click("#journals-view");
await win.waitForFunction(() => document.querySelectorAll(".card").length === 2);
await win.click(".card:nth-child(2) .cm-content");
await win.keyboard.press("Control+End");
await win.keyboard.type(" and more");
await win.waitForFunction(() => document.querySelectorAll(".status")[1]?.textContent === "Saved");
assert.match(readFileSync(join(bundle, "journals/2020-01-01.md"), "utf8"), /today\.\n and more/);

// Searching finds text inside pages; the sidebar also shows what lint found.
await win.fill("#search", "searchable-needle");
await win.waitForSelector("#results .hit");
assert.match(await win.textContent("#results"), /broken/);
await win.fill("#search", "");
await win.click("#problems-toggle");
await win.waitForSelector("#problems .problem.error");
assert.match(await win.textContent("#problems"), /broken\.md/);
await win.click("#problems .problem.error");
await win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "broken");

// The project page lists the journal block that mentions it.
await win.click("#pages button:has-text('project/tessela')");
await win.waitForSelector("#backlinks .hit");
assert.match(await win.textContent("#backlinks"), /Worked on #project\/tessela today/);
assert.match(await win.textContent("#backlinks"), /see/);

// Undo right after opening a page must not blank it (or save an empty file over it).
await win.click(".cm-content");
await win.keyboard.press("Control+z");
await new Promise((r) => setTimeout(r, 1500));
assert.match(await win.textContent(".cm-content"), /type: project/);
assert.match(readFileSync(join(bundle, "project/tessela.md"), "utf8"), /type: project/);

// Tab starts a list and nests it, Shift+Tab undoes that, Alt+Up moves a block.
const saved = () => win.waitForFunction(() => document.querySelector(".status")?.textContent === "Saved");
const bodyOf = (file) => readFileSync(join(bundle, file), "utf8").replace(/^---\n[\s\S]*?\n---\n\n?/, "");
await win.fill("#search", "blocks");
await win.press("#search", "Enter");
await win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "blocks");
await win.click(".cm-content");
await win.keyboard.press("Control+End");
await win.keyboard.type("Para one");
await win.keyboard.press("Tab");
await win.keyboard.press("Enter");
await win.keyboard.type("child");
await win.keyboard.press("Tab");
await saved();
assert.equal(bodyOf("blocks.md"), "- Para one\n  - child");
await win.keyboard.press("Enter");
await win.keyboard.type("second");
await win.keyboard.press("Shift+Tab");
await win.keyboard.press("Alt+ArrowUp");
await saved();
assert.equal(bodyOf("blocks.md"), "- second\n- Para one\n  - child");
await win.keyboard.press("Shift+Tab");
await saved();
assert.equal(bodyOf("blocks.md"), "second\n\n- Para one\n  - child");

// Formatting: Ctrl+B marks a word, typing `*` over a selection surrounds it, `/` inserts
// today's date, and Ctrl+Enter ticks a task.
await win.fill("#search", "fmt");
await win.press("#search", "Enter");
await win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "fmt");
await win.click(".cm-content");
await win.keyboard.press("Control+End");
await win.keyboard.type("format");
await win.keyboard.press("Control+b");
await win.keyboard.press("End");
await win.keyboard.type(" and more");
await win.keyboard.press("Shift+Home");
await win.keyboard.type("*");
await win.keyboard.press("End");
await win.keyboard.press("Enter");
await win.keyboard.type("due /tod");
await win.waitForSelector(".cm-tooltip-autocomplete");
await win.keyboard.press("Enter");
await win.keyboard.press("Enter");
await win.keyboard.type("write the thing");
await win.keyboard.press("Control+Enter");
await saved();
const day2 = new Date();
const dayText = `${day2.getFullYear()}-${String(day2.getMonth() + 1).padStart(2, "0")}-${String(day2.getDate()).padStart(2, "0")}`;
const body = bodyOf("fmt.md");
assert.ok(body.includes("***format** and more*"), body);
assert.ok(body.includes(`due ${dayText}`), body);
assert.match(body, /- \[ \] write the thing/);

// A change made by another program shows up without a reload.
await win.click("#pages button:has-text('project/tessela')");
await win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "project/tessela");
writeFileSync(
  join(bundle, "project/tessela.md"),
  "---\ntype: project\n---\n\nChanged outside.\n",
);
await win.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("Changed outside."));

await win.screenshot({ path: process.env.SHOT ?? join(tmpdir(), "tessela-e2e.png") });
await app.close();
console.log("e2e ok");
