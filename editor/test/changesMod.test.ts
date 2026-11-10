import { describe, expect, it } from "vitest";

import { type Change, type PageChange, keptKey, putBack, remember, restoredPage, summary } from "../src/mods/changes/plan";

const change = (c: Partial<Change> & Pick<Change, "kind" | "line" | "raw">): Change => ({ unit: "block", heading_path: [], text: c.raw, ...c });

const NOW = "# Notes\n\nFirst edited.\n\nSecond.\n\nFourth.\n";

describe("putting a change back", () => {
  it("restores the old lines of a changed block", () => {
    const c = change({ kind: "changed", line: 3, raw: "First edited.", old_raw: "First." });
    expect(putBack(NOW, c)).toBe("# Notes\n\nFirst.\n\nSecond.\n\nFourth.\n");
  });

  it("takes out an added block with the blank line after it, or before it when it is the last", () => {
    expect(putBack(NOW, change({ kind: "added", line: 5, raw: "Second." }))).toBe("# Notes\n\nFirst edited.\n\nFourth.\n");
    expect(putBack(NOW, change({ kind: "added", line: 7, raw: "Fourth." }))).toBe("# Notes\n\nFirst edited.\n\nSecond.\n");
  });

  it("writes a removed block again at the first boundary between blocks from its old line", () => {
    const c = change({ kind: "removed", line: 7, raw: "Third." });
    expect(putBack(NOW, c)).toBe("# Notes\n\nFirst edited.\n\nSecond.\n\nThird.\n\nFourth.\n");
    // Past the end of the page it goes last.
    expect(putBack(NOW, change({ kind: "removed", line: 40, raw: "Last." }))).toBe(`${NOW}\nLast.\n`);
    // A line in the middle of a block waits for the block to end.
    expect(putBack("A\nB\n\nC\n", change({ kind: "removed", line: 2, raw: "X" }))).toBe("A\nB\n\nX\n\nC\n");
  });

  it("refuses when the page no longer reads as it did", () => {
    expect(putBack(NOW, change({ kind: "changed", line: 3, raw: "Something else.", old_raw: "First." }))).toBeNull();
    expect(putBack(NOW, change({ kind: "added", line: 99, raw: "Nowhere." }))).toBeNull();
  });
});

describe("the rest of the view's rules", () => {
  it("writes a deleted page again from its removed units, in order", () => {
    const page: PageChange = {
      path: "a.md",
      status: "deleted",
      hash: null,
      changes: [
        change({ kind: "removed", line: 5, raw: "Body." }),
        change({ kind: "removed", unit: "properties", line: 1, raw: "---\ntype: concept\n---" }),
        change({ kind: "removed", unit: "heading", line: 5, raw: "# Title" }),
      ],
    };
    expect(restoredPage(page)).toBe("---\ntype: concept\n---\n\n# Title\n\nBody.\n");
    expect(restoredPage({ ...page, changes: [] })).toBeNull();
  });

  it("remembers kept changes by their text, not by where they sit, and forgets the oldest", () => {
    const a = keptKey("a.md", change({ kind: "added", line: 3, raw: "X" }));
    expect(a).toBe(keptKey("a.md", change({ kind: "added", line: 9, raw: "X" })));
    expect(a).not.toBe(keptKey("b.md", change({ kind: "added", line: 3, raw: "X" })));
    expect(remember(["old"], "a", "old")).toEqual(["a", "old"]);
    expect(remember(Array.from({ length: 500 }, (_, i) => String(i)), "new").at(-1)).toBe("new");
  });

  it("counts what is left and what was kept", () => {
    expect([summary(0, 0, 0), summary(2, 5, 0), summary(1, 1, 3), summary(0, 0, 2)]).toEqual([
      "Nothing differs.",
      "5 changes in 2 pages",
      "1 change in 1 page · 3 kept",
      "Nothing left to look at · 2 kept",
    ]);
  });
});
