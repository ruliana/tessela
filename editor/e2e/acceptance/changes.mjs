// The changes mod (bundled, mods/changes): a view of what differs between the notes and an earlier
// state in git (`tessela changes`), block by block, where each change is kept or put back.
// Put back writes through the CLI; keeping writes nothing.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { front, read, suite, write } from "../harness.mjs";

const NOTES = `${front()}# Notes\n\nFirst block.\n\nSecond block.\n\nThird block.\n\nFourth block.\n\nFifth block.\n`;

const files = () => ({
  "notes.md": NOTES,
  "other.md": `${front()}Other.\n`,
  "gone.md": `${front()}Will go.\n`,
});

const git = (s, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: s.bundle, encoding: "utf8" });

/** Commits the notes as they are now: the state the changes are compared with. */
function baseline(s) {
  git(s, "init", "-q");
  git(s, "add", "-A");
  git(s, "commit", "-q", "--allow-empty", "-m", "baseline");
}

const view = '.mod-view[data-view="changes"]';

async function show(s) {
  await s.win.click("#view-changes");
  await s.win.waitForSelector(`${view} .changes-summary, ${view} .changes-error`);
}

const page = (path) => `${view} .changes-page[data-path="${path}"]`;
const kinds = (s, path) => s.win.$$eval(`${page(path)} .change`, (e) => e.map((x) => `${x.classList.contains("added") ? "+" : x.classList.contains("removed") ? "-" : "~"} ${x.querySelector(".change-text").textContent.trim()}`));
const gone = (s, selector) => s.win.waitForFunction((q) => !document.querySelector(q), selector);

/** The notes edited: the first block changed, the third removed, a sixth added (blocks between them stay, so each is one change). */
const EDITED = `${front()}# Notes\n\nFirst block, edited.\n\nSecond block.\n\nFourth block.\n\nFifth block.\n\nSixth block.\n`;

suite("Changes mod", files, (test) => {
  test("a folder that is not in git says so, instead of showing nothing", async (s) => {
    await show(s);
    assert.match(await s.win.textContent(`${view} .changes-error`), /git/);
  });

  test("the Changes row lists the pages that differ from the last commit, with each block that changed", async (s) => {
    baseline(s);
    write(s.bundle, "notes.md", EDITED);
    write(s.bundle, "other.md", `${front()}Other.\n\nAn added block.\n`);
    await show(s);
    await s.win.waitForSelector(page("notes.md"));
    assert.deepEqual(await kinds(s, "notes.md"), ["~ First block, edited.", "- Third block.", "+ Sixth block."]);
    assert.deepEqual(await kinds(s, "other.md"), ["+ An added block."]);
    // A page that did not change is not listed, and a changed block shows what it was.
    assert.equal(await s.win.$$eval(page("gone.md"), (e) => e.length), 0);
    assert.match(await s.win.textContent(`${page("notes.md")} .change.changed .change-old`), /First block\./);
    assert.equal(await s.win.getAttribute("#view-changes", "aria-current"), "page");
  });

  test("Put back on a changed block restores what it was, and the change leaves the list", async (s) => {
    await show(s);
    await s.win.click(`${page("notes.md")} .change.changed .change-revert`);
    await gone(s, `${page("notes.md")} .change.changed`);
    assert.match(read(s.bundle, "notes.md"), /First block\.\n\nSecond block\./);
    assert.ok(!read(s.bundle, "notes.md").includes("edited"));
    // The other changes are still there, untouched.
    assert.deepEqual(await kinds(s, "notes.md"), ["- Third block.", "+ Sixth block."]);
  });

  test("Put back on a removed block writes it again, and on an added block takes it out", async (s) => {
    await s.win.click(`${page("notes.md")} .change.removed .change-revert`);
    await gone(s, `${page("notes.md")} .change.removed`);
    assert.match(read(s.bundle, "notes.md"), /Second block\.\n\nThird block\.\n\nFourth block\./);
    await s.win.click(`${page("notes.md")} .change.added .change-revert`);
    // Nothing differs any more, so the page is gone from the list.
    await gone(s, page("notes.md"));
    assert.equal(read(s.bundle, "notes.md"), NOTES);
  });

  test("Keep hides a change and writes nothing; Show kept brings it back", async (s) => {
    const before = read(s.bundle, "other.md");
    await s.win.click(`${page("other.md")} .change .change-keep`);
    await gone(s, page("other.md"));
    assert.equal(read(s.bundle, "other.md"), before);
    // It stays kept when the view is drawn again.
    await s.win.click("#journals-view");
    await show(s);
    assert.equal(await s.win.$$eval(page("other.md"), (e) => e.length), 0);
    await s.win.click(`${view} .changes-show-kept`);
    await s.win.waitForSelector(`${page("other.md")} .change.kept`);
  });

  test("a deleted page can be put back whole, and a page that is new can be deleted after a confirmation", async (s) => {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(join(s.bundle, "gone.md"));
    write(s.bundle, "fresh.md", `${front()}Brand new.\n`);
    await s.win.click("#journals-view");
    await show(s);
    await s.win.waitForSelector(`${page("gone.md")} .changes-status`);
    assert.equal((await s.win.textContent(`${page("gone.md")} .changes-status`)).trim(), "deleted");
    await s.win.click(`${page("gone.md")} .changes-page-revert`);
    await gone(s, page("gone.md"));
    assert.equal(read(s.bundle, "gone.md"), `${front()}Will go.\n`);

    await s.win.click(`${page("fresh.md")} .changes-page-revert`);
    await s.win.waitForSelector("#dialog");
    assert.ok(existsSync(join(s.bundle, "fresh.md")), "nothing is deleted before the confirmation");
    await s.win.click('#dialog [data-action="ok"]');
    await gone(s, page("fresh.md"));
    assert.ok(!existsSync(join(s.bundle, "fresh.md")));
  });

  test("the view follows the disk, and compares with another revision when asked", async (s) => {
    write(s.bundle, "notes.md", `${NOTES}\nLive block.\n`);
    await s.win.waitForSelector(`${page("notes.md")} .change.added`);
    // Commit it: nothing differs from the last commit now, but it does from the one before.
    git(s, "add", "-A");
    git(s, "commit", "-q", "-m", "second");
    // Git moved and the notes did not, so the window looks again when it is returned to.
    await s.win.evaluate(() => window.dispatchEvent(new Event("focus")));
    await gone(s, page("notes.md"));
    await s.win.fill(`${view} .changes-since`, "HEAD~1");
    await s.win.press(`${view} .changes-since`, "Enter");
    await s.win.waitForSelector(`${page("notes.md")} .change.added`);
    assert.match((await kinds(s, "notes.md")).join("|"), /\+ Live block\./);
    // A revision git does not know is said, not shown as empty.
    await s.win.fill(`${view} .changes-since`, "nope-not-a-rev");
    await s.win.press(`${view} .changes-since`, "Enter");
    await s.win.waitForSelector(`${view} .changes-error`);
  });

  test("the palette shows the view", async (s) => {
    await s.win.click("#journals-view");
    await s.key("Control+k");
    await s.win.waitForSelector("#palette");
    await s.type("Show changes");
    await s.win.waitForFunction(() => [...document.querySelectorAll("#palette .palette-item .t")].some((e) => e.textContent === "Show changes"));
    await s.key("Enter");
    await s.win.waitForSelector(view);
  });
});
