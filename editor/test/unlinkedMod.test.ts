import { describe, expect, it } from "vitest";

import { conceptFor, countUnlinked, entriesOf, linked } from "../src/mods/unlinked/plan";

const ml = { text: "ML", line: 3, column: 8, link: "[ML](/machine-learning.md)" };

describe("the unlinked mod's plan", () => {
  it("asks for pages, not for journal days", () => {
    expect(conceptFor("notes/idea.md")).toBe("notes/idea");
    expect(conceptFor("journals/2026-03-04.md")).toBeNull();
    expect(conceptFor(null)).toBeNull();
  });

  it("makes one entry per mention and marks each where it is in the block", () => {
    const hit = { handle: "h", path: "a.md", line: 3, text: "ML and ML", mentions: [ml, { ...ml, column: 14 }] };
    const entries = entriesOf([hit]);
    expect(entries.map((e) => e.parts)).toEqual([["", "ML", " and ML"], ["ML and ", "ML", ""]]);
    expect([0, 1, 4].map(countUnlinked)).toEqual(["No unlinked mentions", "1 unlinked mention", "4 unlinked mentions"]);
  });

  it("writes the link in place of the words and leaves every other byte", () => {
    const text = "one\r\ntwo\r\nRead ML now\nlast";
    expect(linked(text, { ...ml, line: 3, column: 5 })).toBe("one\r\ntwo\r\nRead [ML](/machine-learning.md) now\nlast");
  });

  it("counts the column in bytes, not letters", () => {
    expect(linked("café ML", { ...ml, line: 1, column: 6 })).toBe("café [ML](/machine-learning.md)");
  });

  it("refuses when the words are not where the tool saw them", () => {
    expect(linked("Read XX now", { ...ml, line: 1, column: 5 })).toBeNull();
    expect(linked("short", { ...ml, line: 4, column: 0 })).toBeNull();
  });

  it("finds the words itself without a column, but only when they are there once", () => {
    const m = { ...ml, line: 1, column: null };
    expect(linked("Read ML now", m)).toBe("Read [ML](/machine-learning.md) now");
    expect(linked("ML and ML", m)).toBeNull();
  });
});
