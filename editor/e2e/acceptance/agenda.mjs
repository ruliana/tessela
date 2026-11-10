// The agenda mod (bundled, mods/agenda): tasks are plain `- [ ]` items and a due date is a date
// written in them. A journal day shows the open tasks that name it in a "Due" group at the top of its
// backlinks (today also shows the overdue ones), a task is ticked on its tile through the CLI, and a
// month strip in the sidebar marks the days that have a file and the days that are only mentioned.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { front, localDay, suite } from "../harness.mjs";

const today = localDay();
const DAY = "2031-05-20";
const MENTIONED = "2031-05-21";

const PLAN = [
  `- [ ] Send the draft ${DAY}`,
  `- [x] Book the room ${DAY}`,
  "- [ ] A task with no date",
  `- Call about ${DAY} (not a task)`,
  `- [ ] Review the notes ${MENTIONED}`,
  "",
].join("\n");

const files = () => ({
  [`journals/${DAY}.md`]: `---\ntype: journal\ndate: ${DAY}\n---\n\nThe day itself.\n`,
  "projects/plan.md": `${front()}${PLAN}`,
  "projects/bills.md": `${front()}- [ ] Pay the rent 2020-01-15\n- [x] Old thing 2020-01-16\n`,
});

/** Opens the journal day `day` and waits for its card. */
async function onDay(s, day) {
  await s.win.fill("#search", `journals/${day}`);
  await s.win.press("#search", "Enter");
  await s.win.waitForFunction((d) => document.querySelector(".card-title")?.textContent === d, day);
}

const due = (s) => s.texts("#backlinks .bl-group.due .task .text");

suite("Agenda mod: the Due group of a journal day", files, (test) => {
  test("a day lists the open tasks that name it, first, and only those", async (s) => {
    await onDay(s, DAY);
    await s.win.waitForSelector("#backlinks .bl-group.due");
    assert.match(await s.win.textContent("#backlinks .bl-group.due h3"), /^Due/);
    assert.deepEqual(await due(s), [`Send the draft ${DAY}`]);
    // It sits above the mentions page by page.
    assert.equal(await s.win.evaluate(() => document.querySelector("#backlinks .bl-group")?.classList.contains("due")), true);
  });

  test("what is in Due is not listed a second time, and the rest of the mentions stay", async (s) => {
    const all = await s.texts("#backlinks .hit .text, #backlinks .task .text");
    assert.equal(all.filter((t) => t.includes("Send the draft")).length, 1);
    assert.ok(all.some((t) => t.includes("Book the room")), "a done task is an ordinary mention");
    assert.ok(all.some((t) => t.includes("Call about")), "so is a line that is not a task");
    assert.ok(!all.some((t) => t.includes("Pay the rent")));
  });

  test("the tile opens the page of the task", async (s) => {
    // (A date in the text opens its day; the line above it is the tile itself.)
    await s.win.click("#backlinks .bl-group.due .task .where");
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "projects/plan");
    await onDay(s, DAY);
    await s.win.waitForSelector("#backlinks .bl-group.due");
  });

  test("ticking a task changes that one line of its page and the task leaves Due", async (s) => {
    const path = join(s.bundle, "projects/plan.md");
    const before = readFileSync(path, "utf8");
    await s.win.click("#backlinks .bl-group.due .task input[type=checkbox]");
    await s.win.waitForFunction(() => !document.querySelector("#backlinks .bl-group.due"));
    const after = readFileSync(path, "utf8");
    assert.equal(after, before.replace(`- [ ] Send the draft ${DAY}`, `- [x] Send the draft ${DAY}`));
    // Done now: an ordinary mention, no longer due.
    const all = await s.texts("#backlinks .hit .text");
    assert.ok(all.some((t) => t.includes("Send the draft")));
  });

  test("a day that nothing is due on has no Due group", async (s) => {
    await onDay(s, "2031-05-22");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await s.win.locator("#backlinks .bl-group.due").count(), 0);
    await s.win.fill("#search", "projects/plan");
    await s.win.press("#search", "Enter");
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "projects/plan");
    assert.equal(await s.win.locator("#backlinks .bl-group.due").count(), 0);
  });
});

suite("Agenda mod: overdue tasks sit under today", files, (test) => {
  test("today lists the open tasks whose dates have passed, marked as overdue", async (s) => {
    await onDay(s, today);
    await s.win.waitForSelector("#backlinks .bl-group.due .task.overdue");
    assert.deepEqual(await due(s), ["Pay the rent 2020-01-15"]);
  });

  test("another day does not", async (s) => {
    await onDay(s, DAY);
    await s.win.waitForSelector("#backlinks .bl-group.due");
    assert.ok(!(await due(s)).some((t) => t.includes("Pay the rent")));
    assert.equal(await s.win.locator("#backlinks .task.overdue").count(), 0);
  });

  test("ticking an overdue task writes it done", async (s) => {
    await onDay(s, today);
    await s.win.waitForSelector("#backlinks .bl-group.due .task.overdue");
    await s.win.click("#backlinks .bl-group.due .task.overdue input[type=checkbox]");
    await s.win.waitForFunction(() => !document.querySelector("#backlinks .bl-group.due"));
    assert.match(readFileSync(join(s.bundle, "projects/bills.md"), "utf8"), /- \[x\] Pay the rent 2020-01-15\n- \[x\] Old thing 2020-01-16\n/);
  });
});

suite("Agenda mod: the month strip", files, (test) => {
  const day = (d) => `#month-strip .day[data-day="${d}"]`;

  test("it follows the journal day that is open, and marks files and mentions", async (s) => {
    await onDay(s, DAY);
    await s.win.waitForSelector("#month-strip .month-title");
    assert.equal(await s.win.textContent("#month-strip .month-title"), "May 2031");
    assert.match((await s.win.getAttribute(day(DAY), "class")) ?? "", /\bfile\b/);
    const mentioned = (await s.win.getAttribute(day(MENTIONED), "class")) ?? "";
    assert.match(mentioned, /\bmention\b/);
    assert.doesNotMatch(mentioned, /\bfile\b/);
    const plain = (await s.win.getAttribute(day("2031-05-22"), "class")) ?? "";
    assert.doesNotMatch(plain, /\b(file|mention)\b/);
    assert.equal(await s.win.locator("#month-strip .day").count(), 31);
  });

  test("a day of the strip opens that journal day", async (s) => {
    await s.win.click(day(MENTIONED));
    await s.win.waitForFunction((d) => document.querySelector(".card-title")?.textContent === d, MENTIONED);
  });

  test("the arrows move by a month, and today is marked in its month", async (s) => {
    const title = (t) => s.win.waitForFunction((x) => document.querySelector("#month-strip .month-title")?.textContent === x, t);
    await s.win.click("#month-strip .month-prev");
    await title("April 2031");
    await s.win.click("#month-strip .month-next");
    await title("May 2031");
    await s.win.click("#month-strip .month-next");
    await title("June 2031");
    await s.win.click("#month-strip .month-today");
    await s.win.waitForSelector(`${day(today)}.is-today`);
  });
});
