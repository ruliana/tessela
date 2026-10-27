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
const day = new Date();
const today = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
writeFileSync(
  join(bundle, "journals/2020-01-01.md"),
  "---\ntype: journal\ndate: 2020-01-01\n---\n\nWorked on #project/tessela today.\n",
);

const root = resolve(import.meta.dirname, "..");
process.env.TESSELA_BIN ??= resolve(root, "../target/debug/tessela");
const app = await electron.launch({
  args: [join(root, "dist/main.cjs"), "--no-sandbox", `--bundle=${bundle}`],
  env: { ...process.env },
});
const win = await app.firstWindow();
await win.waitForSelector(".cm-content");

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
