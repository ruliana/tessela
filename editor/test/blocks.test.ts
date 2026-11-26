import { describe, expect, it } from "vitest";

import {
  type Result,
  type Sel,
  blockBelow,
  extendBlocks,
  indent,
  mapPos,
  move,
  outdent,
  parseBlocks,
  selectBlock,
  stepBlock,
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

describe("moving past a rule", () => {
  it("does not turn the lines between two rules into front matter", () => {
    // Moving the paragraph down would put a rule on the first line, and the next rule closes it.
    expect(down("Pa|ra\n\n---\n\n---")).toBe("Pa|ra\n\n---\n\n---");
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

  it("keeps widening, through the sections, until the whole page is selected", () => {
    const page = "---\ntype: concept\n---\n\nIntro\n\n# One\n\nText|\n\n## Two\n\nDeep\n\n# Three\n\nLast";
    const { lines, sel } = setup(page);
    const picked: string[] = [];
    let now: Sel | null = sel;
    while ((now = selectBlock(lines, now))) {
      const [a, b] = [now.anchor, now.head];
      picked.push(`${a.line}-${b.line}`);
    }
    // Text, then the section "One" with "Two" inside it, then the whole page.
    expect(picked).toEqual(["8-8", "6-12", "0-16"]);
  });

  it("goes from an item to its list, and from there to the whole page", () => {
    const { lines, sel } = setup("- a|\n- b");
    const item = selectBlock(lines, sel)!;
    expect(item).toEqual({ anchor: { line: 0, col: 0 }, head: { line: 0, col: 3 } });
    const all = { anchor: { line: 0, col: 0 }, head: { line: 1, col: 3 } };
    expect(selectBlock(lines, item)).toEqual(all);
    expect(selectBlock(lines, all)).toBeNull();
  });

  it("extends over the neighbouring block", () => {
    const { lines, sel } = setup("- a\n- b|\n- c\n- d");
    const one = selectBlock(lines, sel)!;
    expect(extendBlocks(lines, one, "down")).toEqual({ anchor: { line: 1, col: 0 }, head: { line: 2, col: 3 } });
    expect(extendBlocks(lines, one, "up")).toEqual({ anchor: { line: 0, col: 0 }, head: { line: 1, col: 3 } });
  });

  it("takes in a whole list below or above a paragraph, and goes on past it", () => {
    const { lines } = setup("Para\n\n- a\n  - b\n- c\n\nEnd");
    const para: Sel = { anchor: { line: 0, col: 0 }, head: { line: 0, col: 4 } };
    const withList = extendBlocks(lines, para, "down")!;
    expect(withList).toEqual({ anchor: { line: 0, col: 0 }, head: { line: 4, col: 3 } });
    expect(extendBlocks(lines, withList, "down")).toEqual({ anchor: { line: 0, col: 0 }, head: { line: 6, col: 3 } });
    const end: Sel = { anchor: { line: 6, col: 0 }, head: { line: 6, col: 3 } };
    const up = extendBlocks(lines, end, "up")!;
    expect(up).toEqual({ anchor: { line: 2, col: 0 }, head: { line: 6, col: 3 } });
    expect(extendBlocks(lines, up, "up")).toEqual({ anchor: { line: 0, col: 0 }, head: { line: 6, col: 3 } });
    // The list alone, as Escape selects it, goes on to the paragraph beside it.
    const list: Sel = { anchor: { line: 2, col: 0 }, head: { line: 4, col: 3 } };
    expect(extendBlocks(lines, list, "down")).toEqual({ anchor: { line: 2, col: 0 }, head: { line: 6, col: 3 } });
    expect(extendBlocks(lines, list, "up")).toEqual({ anchor: { line: 0, col: 0 }, head: { line: 4, col: 3 } });
  });

  it("leaves a text selection alone", () => {
    const { lines } = setup("- abc\n- def");
    const partial: Sel = { anchor: { line: 0, col: 2 }, head: { line: 0, col: 4 } };
    expect(extendBlocks(lines, partial, "down")).toBeNull();
  });
});

describe("select mode", () => {
  const page = ["Intro", "", "```js", "let a", "", "let b", "```", "", "- one", "  - child", "- two", "", "> quote"];
  const sel = (line: number, end = line): Sel => ({ anchor: { line, col: 0 }, head: { line: end, col: page[end]!.length } });
  const lines = (s: Sel | null) => (s ? [s.anchor.line, s.head.line] : null);

  it("steps through the blocks in the order they are read, code blocks and nested items included", () => {
    expect(lines(stepBlock(page, sel(0), "down"))).toEqual([2, 6]);
    expect(lines(stepBlock(page, sel(2, 6), "down"))).toEqual([8, 9]);
    expect(lines(stepBlock(page, sel(8, 9), "down"))).toEqual([10, 10]);
    expect(lines(stepBlock(page, sel(8, 8), "down"))).toEqual([9, 9]);
    expect(lines(stepBlock(page, sel(9), "down"))).toEqual([10, 10]);
    expect(lines(stepBlock(page, sel(10), "up"))).toEqual([9, 9]);
    expect(lines(stepBlock(page, sel(12), "up"))).toEqual([10, 10]);
    expect(lines(stepBlock(page, sel(8), "up"))).toEqual([2, 6]);
  });

  it("stays put at the first and the last block", () => {
    expect(stepBlock(page, sel(0), "up")).toBeNull();
    expect(stepBlock(page, sel(12), "down")).toBeNull();
    expect(stepBlock(["---", "type: x", "---", "", "Only"], sel(4), "up")).toBeNull();
  });

  it("adds an item below an item, after the items nested in it", () => {
    const below = blockBelow(page, sel(8, 9));
    expect(below).toEqual({ at: { line: 9, col: 9 }, insert: "\n- ", caret: 3 });
    expect(blockBelow(page, sel(9)).insert).toBe("\n  - ");
    expect(blockBelow(["1. a", "- [x] b"], sel(0)).insert).toBe("\n2. ");
    expect(blockBelow(["- [x] b"], sel(0)).insert).toBe("\n- [ ] ");
  });

  it("adds a paragraph below any other block, with the gap kept", () => {
    expect(blockBelow(page, sel(2, 6))).toEqual({ at: { line: 7, col: 0 }, insert: "\n\n", caret: 1 });
    expect(blockBelow(page, sel(12))).toEqual({ at: { line: 12, col: 7 }, insert: "\n\n", caret: 2 });
    expect(blockBelow(["# H", "text"], sel(0)).insert).toBe("\n\n\n");
  });
});
