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

// A change made by another program shows up without a reload.
writeFileSync(
  join(bundle, "project/tessela.md"),
  "---\ntype: project\n---\n\nChanged outside.\n",
);
await win.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("Changed outside."));

await win.screenshot({ path: process.env.SHOT ?? join(tmpdir(), "tessela-e2e.png") });
await app.close();
console.log("e2e ok");
