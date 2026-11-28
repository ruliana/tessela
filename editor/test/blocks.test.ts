import { describe, expect, it } from "vitest";

import { type BlockEdit, follow } from "../src/shared/blockEdit";
import { type Sel, indent, lineAbove, move, outdent } from "../src/shared/blocks";
import type { PageModel } from "../src/shared/pageModel";
import { textOf } from "./support/edits";
import { modelOf, outline } from "./support/page";
import { offsetOf } from "./support/selecting";

/** The page model of lines, made the way the editor makes it. */
const m = (lines: string[]) => modelOf(lines.join("\n"));

/** `text` with `|` at the cursor, or `<` and `>` around a selection. Returns lines and selection (offsets). */
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
  const text = lines.join("\n");
  const offset = (p: { line: number; col: number }) => offsetOf(text, p.line, p.col);
  if (start && end) {
    // `>` is on a line after `<` has been removed from its own line only.
    const col = end.line === start.line ? end.col - 1 : end.col;
    return { lines, sel: { anchor: offset(start), head: offset({ line: end.line, col }) } };
  }
  const pos = offset(cursor ?? { line: 0, col: 0 });
  return { lines, sel: { anchor: pos, head: pos } };
}

/** The page after the edit, with `|` where the head of the selection has gone. */
function show(lines: string[], edit: BlockEdit, sel: Sel): string {
  const text = textOf(lines, edit).join("\n");
  const head = follow(edit, sel.head);
  return `${text.slice(0, head)}|${text.slice(head)}`;
}

function run(marked: string, op: (model: PageModel, sel: Sel) => BlockEdit | null): string {
  const { lines, sel } = setup(marked);
  const edit = op(m(lines), sel);
  if (!edit) return "(not handled)";
  return show(lines, edit, sel);
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

describe("select mode", () => {
  const page = ["Intro", "", "```js", "let a", "", "let b", "```", "", "- one", "  - child", "- two", "", "> quote"];
  const text = page.join("\n");
  const sel = (line: number, end = line): Sel => ({ anchor: offsetOf(text, line), head: offsetOf(text, end, page[end]!.length) });
  const at = (line: number, col: number) => offsetOf(text, line, col);

  it("opens an item above an item, with the same marker and indentation, and a task unticked", () => {
    expect(lineAbove(m(page), at(8, 3))).toEqual({ at: at(8, 0), insert: "- \n", caret: 2 });
    expect(lineAbove(m(page), at(9, 0))).toEqual({ at: at(9, 0), insert: "  - \n", caret: 4 });
    expect(lineAbove(m(["1. a"]), 0)!.insert).toBe("1. \n");
    expect(lineAbove(m(["- [x] b"]), 0)!.insert).toBe("- [ ] \n");
  });

  it("opens a paragraph above a block, with a blank line between, and a plain line inside one", () => {
    expect(lineAbove(m(page), at(0, 2))).toEqual({ at: 0, insert: "\n\n", caret: 0 });
    expect(lineAbove(m(page), at(12, 3))).toEqual({ at: at(12, 0), insert: "\n\n", caret: 0 });
    // Inside a block: the line before it is not blank, so it is a line of the same block.
    expect(lineAbove(m(page), at(3, 0))).toEqual({ at: at(3, 0), insert: "\n", caret: 0 });
    expect(lineAbove(m(["a", "b"]), 2)).toEqual({ at: 2, insert: "\n", caret: 0 });
  });

  it("leaves the front matter alone", () => {
    expect(lineAbove(m(["---", "type: x", "---", "", "text"]), 5)).toBeNull();
  });
});

// What the old reading of the page got wrong, and the page model gets right: blocks inside blocks.
describe("blocks inside items, callouts and math", () => {
  /** Runs `op` with the cursor two columns into `line`, and shows the resulting lines. */
  const at = (page: string[], line: number, op: (model: PageModel, sel: Sel) => BlockEdit | null): string[] | null => {
    const cursor = offsetOf(page.join("\n"), line, 2);
    const edit = op(m(page), { anchor: cursor, head: cursor });
    return edit ? textOf(page, edit) : null;
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

  it("lets the last block of a section move into the next one, and back", () => {
    const page = "# A\ntext|\n\n# B\n\nmore";
    const moved = down(page);
    expect(moved).toBe("# A\n# B\n\ntext|\n\nmore");
    expect(up(moved)).toBe(page);
  });
});
