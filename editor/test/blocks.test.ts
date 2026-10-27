import { describe, expect, it } from "vitest";

import {
  type Result,
  type Sel,
  extendBlocks,
  indent,
  mapPos,
  move,
  outdent,
  parseBlocks,
  selectBlock,
} from "../src/shared/blocks";

/** `text` with `|` at the cursor, or `<` and `>` around a selection. Returns lines and selection. */
function setup(marked: string): { lines: string[]; sel: Sel } {
  const raw = marked.split("\n");
  const find = (ch: string) => {
    for (let line = 0; line < raw.length; line++) {
      const col = raw[line]!.indexOf(ch);
      if (col >= 0) return { line, col };
    }
    return null;
  };
  const cursor = find("|");
  const start = find("<");
  const end = find(">");
  const strip = (s: string) => s.replace(/[|<>]/g, "");
  const lines = raw.map(strip);
  if (start && end) {
    // `>` is on a line after `<` has been removed from its own line only.
    const col = end.line === start.line ? end.col - 1 : end.col;
    return { lines, sel: { anchor: start, head: { line: end.line, col } } };
  }
  const pos = cursor ?? { line: 0, col: 0 };
  return { lines, sel: { anchor: pos, head: pos } };
}

function show(lines: string[], result: Result, sel: Sel): string {
  const out = result.rows.map((r) => r.text);
  const head = mapPos(result, sel.head);
  out[head.line] = `${out[head.line]!.slice(0, head.col)}|${out[head.line]!.slice(head.col)}`;
  return out.join("\n");
}

function run(marked: string, op: (lines: string[], sel: Sel) => Result | null): string {
  const { lines, sel } = setup(marked);
  const result = op(lines, sel);
  if (!result) return "(not handled)";
  return show(lines, result, sel);
}

const tab = (m: string) => run(m, indent);
const shiftTab = (m: string) => run(m, outdent);
const up = (m: string) => run(m, (l, s) => move(l, s, "up"));
const down = (m: string) => run(m, (l, s) => move(l, s, "down"));

describe("parseBlocks", () => {
  it("finds paragraphs, the list they own, and nested items", () => {
    const lines = ["---", "type: concept", "---", "", "# Title", "", "Para", "- a", "  - b", "- c", "", "Next"];
    const blocks = parseBlocks(lines);
    expect(blocks.map((b) => [b.kind, b.start, b.end])).toEqual([
      ["frontmatter", 0, 2],
      ["heading", 4, 4],
      ["para", 6, 9],
      ["para", 11, 11],
    ]);
    const para = blocks[2]!;
    expect(para.children.map((c) => [c.start, c.end])).toEqual([[7, 8], [9, 9]]);
    expect(para.children[0]!.children.map((c) => c.start)).toEqual([8]);
  });

  it("keeps a blank line between a paragraph and a list", () => {
    const blocks = parseBlocks(["Para", "", "- a"]);
    expect(blocks.map((b) => b.kind)).toEqual(["para", "list"]);
  });

  it("does not look inside a fenced code block", () => {
    const blocks = parseBlocks(["```", "- not an item", "```", "- item"]);
    expect(blocks.map((b) => [b.kind, b.start, b.end])).toEqual([
      ["fence", 0, 2],
      ["list", 3, 3],
    ]);
  });
});

describe("Tab", () => {
  it("turns a paragraph into a list item", () => {
    expect(tab("Hello wor|ld")).toBe("- Hello wor|ld");
  });

  it("keeps the cursor on the same character", () => {
    expect(tab("Hel|lo")).toBe("- Hel|lo");
  });

  it("nests the list a paragraph owns beneath the new item", () => {
    expect(tab("Pa|ra\n- a")).toBe("- Pa|ra\n  - a");
  });

  it("nests an item under the item before it", () => {
    expect(tab("- a\n- b|")).toBe("- a\n  - b|");
  });

  it("does nothing for the first item, which has nothing to nest under", () => {
    expect(tab("- a|\n- b")).toBe("- a|\n- b");
  });

  it("takes the children along", () => {
    expect(tab("- a\n- b|\n  - c")).toBe("- a\n  - b|\n    - c");
  });

  it("nests under a numbered item at the width of its marker", () => {
    expect(tab("1. a\n2. b|")).toBe("1. a\n   2. b|");
  });

  it("starts a list on an empty line", () => {
    expect(tab("Para\n\n|")).toBe("Para\n\n- |");
  });

  it("starts a nested item below an item", () => {
    expect(tab("- a\n|")).toBe("- a\n  - |");
  });

  it("nests every selected item under the one before the selection", () => {
    expect(tab("- a\n<- b\n- c>")).toBe("- a\n  - b\n  - c|");
  });

  it("leaves front matter and code to Tab's usual behaviour", () => {
    expect(tab("---\ntype: x|\n---")).toBe("(not handled)");
    expect(tab("```\ncod|e\n```")).toBe("(not handled)");
  });

  it("leaves a heading alone", () => {
    expect(tab("# Title|")).toBe("# Title|");
  });
});

describe("Shift+Tab", () => {
  it("moves a nested item out one level", () => {
    expect(shiftTab("- a\n  - b|")).toBe("- a\n- b|");
    expect(shiftTab("- a\n  - b\n    - c|")).toBe("- a\n  - b\n  - c|");
  });

  it("takes the children along", () => {
    expect(shiftTab("- a\n  - b|\n    - c")).toBe("- a\n- b|\n  - c");
  });

  it("turns a top-level item back into a paragraph", () => {
    expect(shiftTab("- Hel|lo")).toBe("Hel|lo");
  });

  it("separates the paragraph from the list around it", () => {
    expect(shiftTab("- a\n- b|\n- c")).toBe("- a\n\nb|\n\n- c");
  });

  it("moves what was nested under it out with it", () => {
    expect(shiftTab("- a|\n  - b")).toBe("a|\n- b");
  });

  it("leaves a plain paragraph alone", () => {
    expect(shiftTab("Hello|")).toBe("Hello|");
  });

  it("round-trips with Tab", () => {
    expect(shiftTab(tab("Hel|lo"))).toBe("Hel|lo");
  });
});

describe("move", () => {
  it("swaps an item with its sibling, children included", () => {
    expect(up("- a\n- b|\n  - c")).toBe("- b|\n  - c\n- a");
    expect(down("- a|\n- b\n  - c")).toBe("- b\n  - c\n- a|");
  });

  it("does not leave the level of the item", () => {
    expect(up("- a\n  - b|")).toBe("- a\n  - b|");
    expect(down("- a\n  - b|\n- c")).toBe("- a\n  - b|\n- c");
  });

  it("moves a paragraph with the list it owns", () => {
    expect(down("A|\n- a1\n\nB")).toBe("B\n\nA|\n- a1");
    expect(up("A\n\nB|\n- b1")).toBe("B|\n- b1\n\nA");
  });

  it("does not move a paragraph above the front matter", () => {
    expect(up("---\ntype: x\n---\n\nA|")).toBe("---\ntype: x\n---\n\nA|");
  });

  it("moves a group of selected items", () => {
    expect(down("<- a\n- b>\n- c")).toBe("- c\n- a\n- b|");
  });
});

describe("block selection", () => {
  it("selects the block at the cursor, with its children", () => {
    const { lines, sel } = setup("- a\n- b|\n  - c\n- d");
    expect(selectBlock(lines, sel)).toEqual({ anchor: { line: 1, col: 0 }, head: { line: 2, col: 5 } });
  });

  it("selects the parent when a block is already selected", () => {
    const first = setup("- a\n  - b|\n- d");
    const once = selectBlock(first.lines, first.sel)!;
    expect(once).toEqual({ anchor: { line: 1, col: 0 }, head: { line: 1, col: 5 } });
    expect(selectBlock(first.lines, once)).toEqual({ anchor: { line: 0, col: 0 }, head: { line: 1, col: 5 } });
  });

  it("extends over the neighbouring block", () => {
    const { lines, sel } = setup("- a\n- b|\n- c\n- d");
    const one = selectBlock(lines, sel)!;
    expect(extendBlocks(lines, one, "down")).toEqual({ anchor: { line: 1, col: 0 }, head: { line: 2, col: 3 } });
    expect(extendBlocks(lines, one, "up")).toEqual({ anchor: { line: 0, col: 0 }, head: { line: 1, col: 3 } });
  });

  it("leaves a text selection alone", () => {
    const { lines } = setup("- abc\n- def");
    const partial: Sel = { anchor: { line: 0, col: 2 }, head: { line: 0, col: 4 } };
    expect(extendBlocks(lines, partial, "down")).toBeNull();
  });
});
