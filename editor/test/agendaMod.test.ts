import { describe, expect, it } from "vitest";

import { dayBefore, dayOfJournal, dueOn, monthView, shiftMonth, tickPatch, ticked, type TaskHit } from "../src/mods/agenda/plan";
import { ModRegistry } from "../src/shared/mods";

const task = (handle: string, path: string, dates: string[], state: "open" | "done" = "open", line = 1): TaskHit => ({
  handle,
  path,
  line,
  text: handle,
  dates,
  task: state,
});

describe("what is due on a journal day", () => {
  const hits = [
    task("a", "p.md", ["2031-05-20"]),
    task("done", "p.md", ["2031-05-20"], "done"),
    task("undated", "p.md", []),
    task("old", "p.md", ["2020-01-15"]),
    task("range", "p.md", ["2020-01-01", "2031-05-20"]),
    task("own", "journals/2031-05-20.md", ["2031-05-20"]),
    task("a", "p.md", ["2031-05-20"]),
  ];

  it("keeps the open tasks that name the day, once each, and leaves out the page itself", () => {
    const due = dueOn(hits, "2031-05-20", "2026-11-10", "journals/2031-05-20.md");
    expect(due.map((d) => d.hit.handle)).toEqual(["a", "range"]);
    expect(due.every((d) => !d.overdue)).toBe(true);
  });

  it("adds the overdue ones, oldest first, on today only", () => {
    const today = dueOn(hits, "2026-11-10", "2026-11-10", "journals/2026-11-10.md");
    expect(today.map((d) => [d.hit.handle, d.overdue])).toEqual([["old", true]]);
    expect(dueOn(hits, "2026-11-11", "2026-11-10", "journals/2026-11-11.md")).toEqual([]);
  });

  it("reads the day of a journal page and the day before it", () => {
    expect(dayOfJournal("journals/2031-05-20.md")).toBe("2031-05-20");
    expect(dayOfJournal("journals/notes.md")).toBeNull();
    expect(dayOfJournal("a/journals/2031-05-20.md")).toBeNull();
    expect(dayBefore("2026-03-01")).toBe("2026-02-28");
  });
});

describe("ticking a task", () => {
  it("ticks only an open box, whatever the list marker", () => {
    expect(ticked("- [ ] write")).toBe("- [x] write");
    expect(ticked("    * [ ] deep")).toBe("    * [x] deep");
    expect(ticked("2. [ ] numbered")).toBe("2. [x] numbered");
    expect(ticked("- [x] done")).toBeNull();
    expect(ticked("- plain")).toBeNull();
  });

  it("writes a one-line patch, with the end-of-file marker when the line has no newline", () => {
    const text = "---\ntype: concept\n---\n\n- [ ] one\n- [ ] two";
    expect(tickPatch("a.md", text, 5, "one")).toBe("--- a/a.md\n+++ b/a.md\n@@ -5,1 +5,1 @@\n-- [ ] one\n+- [x] one\n");
    expect(tickPatch("a.md", text, 6, "two")).toBe(
      "--- a/a.md\n+++ b/a.md\n@@ -6,1 +6,1 @@\n-- [ ] two\n\\ No newline at end of file\n+- [x] two\n\\ No newline at end of file\n",
    );
  });

  it("refuses when the line is no longer that task", () => {
    const text = "- [ ] one\n- [x] two\n";
    expect(tickPatch("a.md", text, 1, "something else")).toBeNull();
    expect(tickPatch("a.md", text, 2, "two")).toBeNull();
    expect(tickPatch("a.md", text, 9, "one")).toBeNull();
  });
});

describe("the month strip", () => {
  it("lays out a month from Monday, marking files, mentions and today", () => {
    const v = monthView(2031, 5, new Set(["2031-05-20"]), new Set(["2031-05-20", "2031-05-21"]), "2031-05-22");
    expect(v.title).toBe("May 2031");
    expect(v.pad).toBe(3); // 1 May 2031 is a Thursday
    expect(v.cells).toHaveLength(31);
    expect(v.cells.find((c) => c.n === 20)).toMatchObject({ file: true, mention: false });
    expect(v.cells.find((c) => c.n === 21)).toMatchObject({ file: false, mention: true });
    expect(v.cells.find((c) => c.n === 22)).toMatchObject({ today: true });
    expect([v.from, v.to]).toEqual(["2031-05-01", "2031-05-31"]);
  });

  it("moves across years", () => {
    expect(shiftMonth([2031, 1], -1)).toEqual([2030, 12]);
    expect(shiftMonth([2031, 12], 1)).toEqual([2032, 1]);
  });
});

describe("backlink groups of mods", () => {
  it("collects what each mod draws, reports a mod that fails, and drops a mod that did not load", async () => {
    const r = new ModRegistry();
    const failures: string[] = [];
    r.onFailure = (f) => failures.push(f.mod);
    await r.load("good", () => r.addBacklinkGroup("good", ({ path }) => ({ node: path, first: true, taken: ["h"] })));
    await r.load("quiet", () => r.addBacklinkGroup("quiet", () => null));
    await r.load("broken", () => r.addBacklinkGroup("broken", () => Promise.reject(new Error("no"))));
    await r.load("bad", () => {
      r.addBacklinkGroup("bad", () => ({ node: "x" }));
      throw new Error("no");
    });
    expect(await r.backlinkContent("p.md")).toEqual([{ node: "p.md", first: true, taken: ["h"] }]);
    expect(failures).toEqual(["bad", "broken"]);
  });
});
