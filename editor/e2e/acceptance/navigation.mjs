// Moving around: journals newest first, the Recent list and Go back / Go forward (Super+[ and Super+]).
// Each suite shares one window and runs in order.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { daysAgo, front, localDay, suite } from "../harness.mjs";

const today = localDay();
const tomorrow = daysAgo(-1);
const nextWeek = daysAgo(-7);

const journal = (day) => `---\ntype: journal\ndate: ${day}\n---\n\nEntry for ${day}\n`;

/** Opens the page called `name` through the search box, like a user would. */
async function visit(s, name) {
  await s.win.fill("#search", name);
  await s.win.press("#search", "Enter");
  await s.win.waitForFunction((n) => document.querySelector(".card-title")?.textContent === n, name);
}

const recent = (s) => s.texts("#recent-list .name");
const title = (s) => s.win.textContent(".card-title");
/** The journals view, which here is only today (no journal has a file). */
const journals = (s) =>
  s.win.waitForFunction((day) => document.querySelector(".card-title")?.textContent === day, today);
const forgetSettings = (s) =>
  s.win.evaluate(() => {
    for (const key of Object.keys(localStorage)) if (key.startsWith("tessela.recent:")) localStorage.removeItem(key);
  });

suite(
  "Journals order",
  () => ({
    [`journals/${tomorrow}.md`]: journal(tomorrow),
    [`journals/${nextWeek}.md`]: journal(nextWeek),
    [`journals/${daysAgo(1)}.md`]: journal(daysAgo(1)),
    [`journals/${daysAgo(30)}.md`]: journal(daysAgo(30)),
    [`journals/${daysAgo(10)}.md`]: journal(daysAgo(10)),
  }),
  (test) => {
    test("the stack runs from the most recent day to the oldest, days after today included", async (s) => {
      await s.win.waitForFunction(() => document.querySelectorAll(".card").length === 6);
      assert.deepEqual(await s.texts(".card-title"), [nextWeek, tomorrow, today, daysAgo(1), daysAgo(10), daysAgo(30)]);
    });

    test("the sidebar list has the same order", async (s) => {
      assert.deepEqual(await s.texts("#journals li"), [nextWeek, tomorrow, daysAgo(1), daysAgo(10), daysAgo(30)]);
    });

    test("the Today button puts the cursor in today's editor, not in the first one", async (s) => {
      await s.win.click("#today");
      await s.win.waitForFunction(
        (day) => document.activeElement?.closest(".card")?.querySelector(".card-title")?.textContent === day,
        today,
      );
    });
  },
);

const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];

suite(
  "Recent pages",
  () => ({ ...Object.fromEntries(names.map((n) => [`${n}.md`, `${front()}The ${n} page.\n`])), "journals/2031-05-20.md": journal("2031-05-20") }),
  (test) => {
    test("the list is hidden until a page was visited", async (s) => {
      await forgetSettings(s);
      assert.equal(await s.win.isHidden("#recent"), true);
    });

    test("it sits between the Today button and New page", async (s) => {
      await visit(s, "alpha");
      assert.equal(await s.win.isVisible("#recent"), true);
      const order = await s.win.evaluate(() => {
        const before = (a, b) => !!(document.querySelector(a).compareDocumentPosition(document.querySelector(b)) & 4);
        return [before("#today", "#recent"), before("#recent", "#new-page")];
      });
      assert.deepEqual(order, [true, true]);
      assert.equal(await s.win.textContent("#recent h2"), "Recent");
    });

    test("the most recently opened page is first", async (s) => {
      for (const n of names.slice(1, 4)) await visit(s, n);
      assert.deepEqual(await recent(s), ["delta", "gamma", "beta", "alpha"]);
    });

    test("opening a page again moves it to the top without repeating it", async (s) => {
      await visit(s, "alpha");
      assert.deepEqual(await recent(s), ["alpha", "delta", "gamma", "beta"]);
    });

    test("shows 6 by default, with no box to change it", async (s) => {
      for (const n of names.slice(4)) await visit(s, n);
      assert.equal(await s.win.locator("#recent-size").count(), 0);
      assert.deepEqual(await recent(s), ["theta", "eta", "zeta", "epsilon", "alpha", "delta"]);
    });

    test("recent.shown in the config folder's settings.json says how many, from 1 to 30, else 6", async (s) => {
      const shown = async (setting) => {
        writeFileSync(join(s.profile, "settings.json"), JSON.stringify({ recent: { shown: setting } }));
        await s.win.reload();
        await s.win.waitForSelector(".cm-content");
        return (await recent(s)).length;
      };
      assert.equal(await shown(3), 3);
      assert.equal(await shown(8), 8);
      assert.equal(await shown(0), 6);
      assert.equal(await shown("many"), 6);
    });

    test("journal days are left out of the list, unless recent.dates in settings.json is true", async (s) => {
      await s.win.fill("#search", "journals/2031-05-20");
      await s.win.press("#search", "Enter");
      await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "2031-05-20");
      await visit(s, "beta");
      assert.equal((await recent(s)).includes("2031-05-20"), false);
      writeFileSync(join(s.profile, "settings.json"), JSON.stringify({ recent: { dates: true } }));
      await s.win.reload();
      await s.win.waitForSelector(".cm-content");
      assert.equal((await recent(s)).includes("2031-05-20"), true);
      writeFileSync(join(s.profile, "settings.json"), "{}");
      await s.win.reload();
      await s.win.waitForSelector(".cm-content");
    });

    test("clicking an entry opens that page and moves it to the top", async (s) => {
      await s.win.click("#recent-list button:has-text('zeta')");
      await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "zeta");
      assert.equal((await recent(s))[0], "zeta");
      assert.equal(await s.win.getAttribute("#recent-list li:first-child button", "aria-current"), "page");
      await forgetSettings(s);
    });
  },
);

suite(
  "Go back and Go forward",
  () => Object.fromEntries(["one", "two", "three", "four"].map((n) => [`${n}.md`, `${front()}Page ${n}.\n`])),
  (test) => {
    test("nothing to go back to at first", async (s) => {
      await journals(s);
      assert.equal(await s.win.isDisabled("#go-back"), true);
      assert.equal(await s.win.isDisabled("#go-forward"), true);
      await s.key("Meta+[");
      assert.equal(await title(s), today);
    });

    test("Super+[ goes back through the pages, Super+] forward again", async (s) => {
      await visit(s, "one");
      await visit(s, "two");
      await visit(s, "three");
      await s.win.click(".cm-content");
      await s.key("Meta+[");
      await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "two");
      await s.key("Meta+[");
      await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "one");
      await s.key("Meta+]");
      await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "two");
      await s.key("Meta+]");
      await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "three");
      assert.equal(await s.win.isDisabled("#go-forward"), true);
    });

    test("going back does not type or indent in the editor", async (s) => {
      await s.win.click(".cm-content");
      await s.key("Control+End");
      await s.key("Meta+[");
      await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "two");
      assert.equal((await s.body()).trim(), "Page two.");
    });

    test("it goes back past the first page to the journals, and the buttons do the same", async (s) => {
      await s.win.click("#go-back");
      await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "one");
      await s.win.click("#go-back");
      await journals(s);
      assert.equal(await s.win.isDisabled("#go-back"), true);
      await s.win.click("#go-forward");
      await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "one");
      assert.equal(await s.win.isDisabled("#go-back"), false);
    });

    test("opening something new drops what was ahead", async (s) => {
      await visit(s, "four");
      assert.equal(await s.win.isDisabled("#go-forward"), true);
      await s.key("Meta+[");
      await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "one");
      await s.key("Meta+]");
      await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "four");
      assert.equal(await title(s), "four");
    });

    test("Ctrl+[ and Ctrl+] are left to the editor", async (s) => {
      await s.win.click(".cm-content");
      await s.key("Control+[");
      assert.equal(await title(s), "four");
    });
  },
);
