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
  selectBlock,
  stepBlock,
} from "../src/shared/blocks";
import type { PageModel } from "../src/shared/pageModel";
import { modelOf, outline } from "./support/page";

/** The page model of lines, made the way the editor makes it. */
const m = (lines: string[]) => modelOf(lines.join("\n"));

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

function run(marked: string, op: (model: PageModel, sel: Sel) => Result | null): string {
  const { lines, sel } = setup(marked);
  const result = op(m(lines), sel);
  if (!result) return "(not handled)";
  return show(lines, result, sel);
}

const tab = (m: string) => run(m, indent);
const shiftTab = (m: string) => run(m, outdent);
const up = (text: string) => run(text, (l, s) => move(l, s, "up"));
const down = (text: string) => run(text, (l, s) => move(l, s, "down"));

describe("the page model, where the commands read it", () => {
  it("finds paragraphs, the list they own, nested items, and a heading with its section", () => {
    const lines = ["---", "type: concept", "---", "", "# Title", "", "Para", "- a", "  - b", "- c", "", "Next"];
    expect(outline(m(lines))).toBe(
      ["page", "  frontmatter 1-3", "  section 5-12", "    paragraph 7-10", "      item 8-9", "        item 9-9", "      item 10-10", "    paragraph 12-12"].join("\n"),
    );
  });

  it("keeps a blank line between a paragraph and a list", () => {
    expect(outline(m(["Para", "", "- a"]))).toBe("page\n  paragraph 1-1\n  item 3-3");
  });

  it("does not look inside a fenced code block", () => {
    expect(outline(m(["```", "- not an item", "```", "- item"]))).toBe("page\n  code 1-3\n  item 4-4");
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
    expect(selectBlock(m(lines), sel)).toEqual({ anchor: { line: 1, col: 0 }, head: { line: 2, col: 5 } });
  });

  it("selects the parent when a block is already selected", () => {
    const first = setup("- a\n  - b|\n- d");
    const once = selectBlock(m(first.lines), first.sel)!;
    expect(once).toEqual({ anchor: { line: 1, col: 0 }, head: { line: 1, col: 5 } });
    expect(selectBlock(m(first.lines), once)).toEqual({ anchor: { line: 0, col: 0 }, head: { line: 1, col: 5 } });
  });

  it("keeps widening, through the sections, until the whole page is selected", () => {
    const page = "---\ntype: concept\n---\n\nIntro\n\n# One\n\nText|\n\n## Two\n\nDeep\n\n# Three\n\nLast";
    const { lines, sel } = setup(page);
    const picked: string[] = [];
    let now: Sel | null = sel;
    while ((now = selectBlock(m(lines), now))) {
      const [a, b] = [now.anchor, now.head];
      picked.push(`${a.line}-${b.line}`);
    }
    // Text, then the section "One" with "Two" inside it, then the whole page.
    expect(picked).toEqual(["8-8", "6-12", "0-16"]);
  });

  it("goes from an item to its list, and from there to the whole page", () => {
    const { lines, sel } = setup("- a|\n- b");
    const item = selectBlock(m(lines), sel)!;
    expect(item).toEqual({ anchor: { line: 0, col: 0 }, head: { line: 0, col: 3 } });
    const all = { anchor: { line: 0, col: 0 }, head: { line: 1, col: 3 } };
    expect(selectBlock(m(lines), item)).toEqual(all);
    expect(selectBlock(m(lines), all)).toBeNull();
  });

  it("extends over the neighbouring block", () => {
    const { lines, sel } = setup("- a\n- b|\n- c\n- d");
    const one = selectBlock(m(lines), sel)!;
    expect(extendBlocks(m(lines), one, "down")).toEqual({ anchor: { line: 1, col: 0 }, head: { line: 2, col: 3 } });
    expect(extendBlocks(m(lines), one, "up")).toEqual({ anchor: { line: 0, col: 0 }, head: { line: 1, col: 3 } });
  });

  it("takes in a whole list below or above a paragraph, and goes on past it", () => {
    const { lines } = setup("Para\n\n- a\n  - b\n- c\n\nEnd");
    const para: Sel = { anchor: { line: 0, col: 0 }, head: { line: 0, col: 4 } };
    const withList = extendBlocks(m(lines), para, "down")!;
    expect(withList).toEqual({ anchor: { line: 0, col: 0 }, head: { line: 4, col: 3 } });
    expect(extendBlocks(m(lines), withList, "down")).toEqual({ anchor: { line: 0, col: 0 }, head: { line: 6, col: 3 } });
    const end: Sel = { anchor: { line: 6, col: 0 }, head: { line: 6, col: 3 } };
    const up = extendBlocks(m(lines), end, "up")!;
    expect(up).toEqual({ anchor: { line: 2, col: 0 }, head: { line: 6, col: 3 } });
    expect(extendBlocks(m(lines), up, "up")).toEqual({ anchor: { line: 0, col: 0 }, head: { line: 6, col: 3 } });
    // The list alone, as Escape selects it, goes on to the paragraph beside it.
    const list: Sel = { anchor: { line: 2, col: 0 }, head: { line: 4, col: 3 } };
    expect(extendBlocks(m(lines), list, "down")).toEqual({ anchor: { line: 2, col: 0 }, head: { line: 6, col: 3 } });
    expect(extendBlocks(m(lines), list, "up")).toEqual({ anchor: { line: 0, col: 0 }, head: { line: 4, col: 3 } });
  });

  it("leaves a text selection alone", () => {
    const { lines } = setup("- abc\n- def");
    const partial: Sel = { anchor: { line: 0, col: 2 }, head: { line: 0, col: 4 } };
    expect(extendBlocks(m(lines), partial, "down")).toBeNull();
  });
});

describe("select mode", () => {
  const page = ["Intro", "", "```js", "let a", "", "let b", "```", "", "- one", "  - child", "- two", "", "> quote"];
  const sel = (line: number, end = line): Sel => ({ anchor: { line, col: 0 }, head: { line: end, col: page[end]!.length } });
  const lines = (s: Sel | null) => (s ? [s.anchor.line, s.head.line] : null);

  it("steps through the blocks in the order they are read, code blocks and nested items included", () => {
    expect(lines(stepBlock(m(page), sel(0), "down"))).toEqual([2, 6]);
    expect(lines(stepBlock(m(page), sel(2, 6), "down"))).toEqual([8, 9]);
    expect(lines(stepBlock(m(page), sel(8, 9), "down"))).toEqual([10, 10]);
    expect(lines(stepBlock(m(page), sel(8, 8), "down"))).toEqual([9, 9]);
    expect(lines(stepBlock(m(page), sel(9), "down"))).toEqual([10, 10]);
    expect(lines(stepBlock(m(page), sel(10), "up"))).toEqual([9, 9]);
    expect(lines(stepBlock(m(page), sel(12), "up"))).toEqual([10, 10]);
    expect(lines(stepBlock(m(page), sel(8), "up"))).toEqual([2, 6]);
  });

  it("stays put at the first and the last block", () => {
    expect(stepBlock(m(page), sel(0), "up")).toBeNull();
    expect(stepBlock(m(page), sel(12), "down")).toBeNull();
    expect(stepBlock(m(["---", "type: x", "---", "", "Only"]), sel(4), "up")).toBeNull();
  });

  it("adds an item below an item, after the items nested in it", () => {
    const below = blockBelow(m(page), sel(8, 9));
    expect(below).toEqual({ at: { line: 9, col: 9 }, insert: "\n- ", caret: 3 });
    expect(blockBelow(m(page), sel(9)).insert).toBe("\n  - ");
    expect(blockBelow(m(["1. a", "- [x] b"]), sel(0)).insert).toBe("\n2. ");
    expect(blockBelow(m(["- [x] b"]), sel(0)).insert).toBe("\n- [ ] ");
  });

  it("adds a paragraph below any other block, with the gap kept", () => {
    expect(blockBelow(m(page), sel(2, 6))).toEqual({ at: { line: 7, col: 0 }, insert: "\n\n", caret: 1 });
    expect(blockBelow(m(page), sel(12))).toEqual({ at: { line: 12, col: 7 }, insert: "\n\n", caret: 2 });
    expect(blockBelow(m(["# H", "text"]), sel(0)).insert).toBe("\n\n\n");
  });
});

// What the old reading of the page got wrong, and the page model gets right: blocks inside blocks.
describe("blocks inside items, callouts and math", () => {
  const sel = (line: number, end = line, page: string[] = []): Sel => ({ anchor: { line, col: 0 }, head: { line: end, col: page[end]?.length ?? 0 } });
  const span = (s: Sel | null) => (s ? [s.anchor.line, s.head.line] : null);

  it("selects a fence in a list item as a block of its own, and widens from it to the item", () => {
    const page = ["- a", "  ```js", "  x", "", "  y", "  ```", "- b"];
    const model = m(page);
    const first = selectBlock(model, sel(4).anchor && { anchor: { line: 4, col: 0 }, head: { line: 4, col: 0 } });
    expect(span(first)).toEqual([1, 5]);
    expect(span(selectBlock(model, first!))).toEqual([0, 5]);
  });

  it("widens from a nested item to the item that holds it, not to the run of its siblings: only a list at the top is a list", () => {
    const page = ["- one", "  - child", "  - other", "- two"];
    const found = selectBlock(m(page), { anchor: { line: 1, col: 0 }, head: { line: 1, col: 9 } });
    expect(span(found)).toEqual([0, 2]);
  });

  it("steps to a fence in a list item, and on to the next item", () => {
    const page = ["- a", "  ```js", "  x", "  ```", "- b"];
    expect(span(stepBlock(m(page), sel(0), "down"))).toEqual([1, 3]);
    expect(span(stepBlock(m(page), sel(1, 3, page), "down"))).toEqual([4, 4]);
    expect(span(stepBlock(m(page), sel(4), "up"))).toEqual([1, 3]);
  });

  it("steps to the list items of a callout, from the block after it", () => {
    const page = ["> [!NOTE]", "> - one", "> - two", "", "After"];
    expect(span(stepBlock(m(page), sel(4), "up"))).toEqual([2, 2]);
    expect(span(stepBlock(m(page), sel(2), "up"))).toEqual([1, 1]);
    expect(span(stepBlock(m(page), sel(1), "up"))).toEqual([0, 2]);
  });

  it("selects a $$ block whole, with the blank line inside it", () => {
    const page = ["$$", "a", "", "b", "$$", "", "after"];
    const cursor = (line: number): Sel => ({ anchor: { line, col: 0 }, head: { line, col: 0 } });
    expect(span(selectBlock(m(page), cursor(3)))).toEqual([0, 4]);
    expect(span(stepBlock(m(page), sel(6), "up"))).toEqual([0, 4]);
  });

  /** Runs `op` with the cursor at the start of `line`, and shows the resulting lines. */
  const at = (page: string[], line: number, op: (model: PageModel, sel: Sel) => Result | null): string[] | null => {
    const result = op(m(page), { anchor: { line, col: 2 }, head: { line, col: 2 } });
    return result ? result.rows.map((r) => r.text) : null;
  };

  it("does not nest an item of a quote with Tab, which would put spaces in front of the `>`", () => {
    const page = ["> - a", "> - b"];
    expect(at(page, 1, indent)).toEqual(page);
  });

  it("moves an item of a callout past its neighbour, `>` and all", () => {
    expect(at(["> [!NOTE]", "> - one", "> - two"], 1, (model, s) => move(model, s, "down"))).toEqual(["> [!NOTE]", "> - two", "> - one"]);
  });
});

describe("a heading owns its section", () => {
  it("moves with its section: Alt+Down on a heading takes what is under it past the next section", () => {
    expect(down("# A|\ntext\n\n# B\nmore")).toBe("# B\nmore\n\n# A|\ntext");
  });

  it("takes in the whole section with Shift+Down, after the heading line alone", () => {
    const { lines } = setup("# A\ntext\n\n# B");
    const heading: Sel = { anchor: { line: 0, col: 0 }, head: { line: 0, col: 3 } };
    expect(extendBlocks(m(lines), heading, "down")).toEqual({ anchor: { line: 0, col: 0 }, head: { line: 1, col: 4 } });
  });

  it("lets the last block of a section move into the next one, and back", () => {
    const page = "# A\ntext|\n\n# B\n\nmore";
    const moved = down(page);
    expect(moved).toBe("# A\n# B\n\ntext|\n\nmore");
    expect(up(moved)).toBe(page);
  });
});
