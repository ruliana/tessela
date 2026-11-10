import { describe, expect, it } from "vitest";

import { countMentions, mentionsOf, peekAt } from "../src/mods/peek/plan";

describe("the peek mod's targets", () => {
  it("finds the link, tag or date the cursor is in", () => {
    const line = "See [t](/notes/idea.md) and #big-plan on 2026-03-04.";
    expect(peekAt(line, 8, "")).toEqual({ kind: "concept", id: "notes/idea", path: "notes/idea.md" });
    expect(peekAt(line, 30, "")).toEqual({ kind: "concept", id: "big-plan", path: "big-plan.md" });
    expect(peekAt(line, 45, "")).toEqual({ kind: "day", day: "2026-03-04", id: "journals/2026-03-04", path: "journals/2026-03-04.md" });
    expect(peekAt(line, 2, "")).toBeNull();
  });

  it("resolves a relative link from the page's folder, and sees a journal link as a day", () => {
    expect(peekAt("[x](../other.md)", 5, "notes/deep")?.path).toBe("notes/other.md");
    expect(peekAt("[d](/journals/2026-03-04.md)", 5, "")).toMatchObject({ kind: "day", day: "2026-03-04" });
    expect(peekAt("[w](https://example.com/x)", 5, "")).toBeNull();
  });

  it("lists each mention once and leaves out the peeked page", () => {
    const hits = [{ handle: "a", path: "a.md" }, { handle: "a", path: "a.md" }, { handle: "b", path: "me.md" }];
    expect(mentionsOf(hits, "me.md")).toEqual([{ handle: "a", path: "a.md" }]);
    expect([0, 1, 3].map(countMentions)).toEqual(["No mentions", "1 mention", "3 mentions"]);
  });
});
