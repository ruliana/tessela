// One parser decides where a block starts and ends: Escape, Tab, Alt+Up/Down, the line the
// live preview shows raw and the block focus mode keeps lit all ask it. These tests pin it to
// CommonMark, with Tessela's one extra rule: a paragraph owns the list right beneath it.

import { describe, expect, it } from "vitest";

import {
  type Block,
  type Sel,
  blockAt,
  editedBlockLines,
  extendBlocks,
  move,
  parseBlocks,
  selectBlock,
} from "../src/shared/blocks";

/** The blocks of `text` as one line each, `kind first-last`, children indented by two. */
function outline(text: string): string[] {
  const out: string[] = [];
  const walk = (blocks: Block[], depth: number) => {
    for (const b of blocks) {
      out.push(`${"  ".repeat(depth)}${b.kind} ${b.start}-${b.end}`);
      walk(b.children, depth + 1);
    }
  };
  walk(parseBlocks(text.split("\n")), 0);
  return out;
}

const cursor = (line: number, col = 0): Sel => ({ anchor: { line, col }, head: { line, col } });

/** What Escape selects with the cursor on `line`, as `first-last`, or null. */
function escape(text: string, line: number): string | null {
  const lines = text.split("\n");
  const sel = selectBlock(lines, cursor(line));
  return sel ? `${sel.anchor.line}-${sel.head.line}` : null;
}

describe("the block parser: where a paragraph meets a list item", () => {
  // The bug: a paragraph that is indented under the width of the marker, after a blank
  // line, is not part of the item. It used to be swallowed by it.
  const page = "# TODO\n- Talk to Santista.\n\n This looks good\n Test another row\n\nAn see\nTest";

  it("keeps an item and the paragraph after a blank line apart, even when that paragraph is indented by one space", () => {
    expect(outline(page)).toEqual(["heading 0-0", "list 1-1", "  item 1-1", "para 3-4", "para 6-7"]);
  });

  it("Escape in each of the three rows selects only the block under the cursor", () => {
    expect(escape(page, 1)).toBe("1-1");
    expect(escape(page, 3)).toBe("3-4");
    expect(escape(page, 4)).toBe("3-4");
  });

  it("treats a line of spaces as a blank line", () => {
    expect(outline("- a\n  \n b")).toEqual(["list 0-0", "  item 0-0", "para 2-2"]);
    expect(outline("- a\n \nb")).toEqual(["list 0-0", "  item 0-0", "para 2-2"]);
    expect(outline("a\n   \nb")).toEqual(["para 0-0", "para 2-2"]);
  });

  it("keeps a paragraph that is indented to the text of the item inside it", () => {
    expect(outline("- Talk\n\n  more words\n  and more\n\nOutside")).toEqual([
      "list 0-3",
      "  item 0-3",
      "para 5-5",
    ]);
  });

  it("needs the width of a numbered marker, not of a bullet", () => {
    expect(outline("1. a\n\n  two spaces")).toEqual(["list 0-0", "  item 0-0", "para 2-2"]);
    expect(outline("1. a\n\n   three spaces")).toEqual(["list 0-2", "  item 0-2"]);
    expect(outline("10. a\n\n   three spaces")).toEqual(["list 0-0", "  item 0-0", "para 2-2"]);
    expect(outline("10. a\n\n    four spaces")).toEqual(["list 0-2", "  item 0-2"]);
  });

  it("lets a lazy continuation line, with no blank line, join the item", () => {
    expect(outline("- a\nlazy")).toEqual(["list 0-1", "  item 0-1"]);
    expect(outline("- a\n lazy")).toEqual(["list 0-1", "  item 0-1"]);
    expect(outline("1. a\nlazy\n\nafter")).toEqual(["list 0-1", "  item 0-1", "para 3-3"]);
  });

  it("gives a lazy line to the innermost item", () => {
    expect(outline("- a\n  - b\nlazy\n- c")).toEqual([
      "list 0-3",
      "  item 0-2",
      "    item 1-2",
      "  item 3-3",
    ]);
  });

  it("does not let a lazy line cross a blank line", () => {
    expect(outline("- a\n  - b\n\nlazy")).toEqual(["list 0-1", "  item 0-1", "    item 1-1", "para 3-3"]);
  });
});

describe("the block parser: lists", () => {
  it("nests by the width of the marker", () => {
    expect(outline("- a\n  - b\n    - c\n- d")).toEqual([
      "list 0-3",
      "  item 0-2",
      "    item 1-2",
      "      item 2-2",
      "  item 3-3",
    ]);
  });

  it("returns several levels in one step", () => {
    expect(outline("- a\n  - b\n    - c\n- d\n  - e")).toEqual([
      "list 0-4",
      "  item 0-2",
      "    item 1-2",
      "      item 2-2",
      "  item 3-4",
      "    item 4-4",
    ]);
  });

  it("makes an item a sibling when it is indented by less than the text of the one above", () => {
    expect(outline("- a\n - b")).toEqual(["list 0-1", "  item 0-0", "  item 1-1"]);
    expect(outline("- a\n  - b")).toEqual(["list 0-1", "  item 0-1", "    item 1-1"]);
    expect(outline("- a\n   - b")).toEqual(["list 0-1", "  item 0-1", "    item 1-1"]);
    expect(outline("- a\n    - b")).toEqual(["list 0-1", "  item 0-1", "    item 1-1"]);
  });

  it("keeps a loose list, with blank lines between its items, together", () => {
    expect(outline("- a\n\n- b\n\n  - c\n\n- d\n\nAfter")).toEqual([
      "list 0-6",
      "  item 0-0",
      "  item 2-4",
      "    item 4-4",
      "  item 6-6",
      "para 8-8",
    ]);
  });

  it("ends a list at a heading, a fence or a rule with no blank line before it", () => {
    expect(outline("- a\n# H")).toEqual(["list 0-0", "  item 0-0", "heading 1-1"]);
    expect(outline("- a\n```\ncode\n```")).toEqual(["list 0-0", "  item 0-0", "fence 1-3"]);
    expect(outline("- a\n***")).toEqual(["list 0-0", "  item 0-0", "rule 1-1"]);
  });

  it("starts a new list when the bullet or the delimiter changes", () => {
    expect(outline("- a\n* b\n+ c")).toEqual([
      "list 0-0", "  item 0-0", "list 1-1", "  item 1-1", "list 2-2", "  item 2-2",
    ]);
    expect(outline("1. a\n2) b")).toEqual(["list 0-0", "  item 0-0", "list 1-1", "  item 1-1"]);
  });

  it("reads ordered lists, with any start number", () => {
    expect(outline("3. a\n4. b\n   - c")).toEqual(["list 0-2", "  item 0-0", "  item 1-2", "    item 2-2"]);
  });

  it("reads an empty item, and text on the next line as part of it", () => {
    expect(outline("-\n- b")).toEqual(["list 0-1", "  item 0-0", "  item 1-1"]);
    expect(outline("-\n  foo\n- b")).toEqual(["list 0-2", "  item 0-1", "  item 2-2"]);
  });

  it("reads task items as items", () => {
    expect(outline("- [ ] a\n- [x] b\n  - [ ] c")).toEqual([
      "list 0-2", "  item 0-0", "  item 1-2", "    item 2-2",
    ]);
  });

  it("does not start a list for a marker with no space after it", () => {
    expect(outline("-a\n*b\n1.c")).toEqual(["para 0-2"]);
  });

  it("does not turn a hashtag into a heading", () => {
    expect(outline("#tag text\n\n# real")).toEqual(["para 0-0", "heading 2-2"]);
  });

  it("keeps a code fence inside an item as part of that item", () => {
    expect(outline("- a\n  ```\n  - not\n\n  ```\n- b")).toEqual(["list 0-5", "  item 0-4", "  item 5-5"]);
  });

  it("keeps a quote inside an item as part of that item", () => {
    expect(outline("- a\n  > quote\n  > more\n- b")).toEqual(["list 0-3", "  item 0-2", "  item 3-3"]);
  });

  it("keeps a table inside an item as part of that item", () => {
    expect(outline("- a\n  | x | y |\n  |---|---|\n  | 1 | 2 |\n- b")).toEqual([
      "list 0-4", "  item 0-3", "  item 4-4",
    ]);
  });

  it("does not let a list item swallow a following paragraph that begins at the margin", () => {
    expect(outline("- a\n  - b\n\nPara")).toEqual(["list 0-1", "  item 0-1", "    item 1-1", "para 3-3"]);
  });

  it("does not read a numbered line as a list inside a four-space indented code block", () => {
    expect(outline("Para\n\n    - code\n    - more")).toEqual(["para 0-0", "code 2-3"]);
  });
});

describe("the block parser: paragraphs", () => {
  it("owns the list that begins right beneath it", () => {
    expect(outline("Idea\n- a\n  - b\n- c\n\nNext")).toEqual([
      "para 0-3", "  item 1-2", "    item 2-2", "  item 3-3", "para 5-5",
    ]);
  });

  it("owns a numbered list that starts at 1, and only that", () => {
    expect(outline("Idea\n1. a\n2. b")).toEqual(["para 0-2", "  item 1-1", "  item 2-2"]);
    expect(outline("Total:\n2. foo")).toEqual(["para 0-1"]);
  });

  it("does not own a list after a blank line", () => {
    expect(outline("Para\n\n- a")).toEqual(["para 0-0", "list 2-2", "  item 2-2"]);
  });

  it("does not own an empty item, which cannot interrupt a paragraph", () => {
    expect(outline("Para\n-")).toEqual(["para 0-1"]);
    expect(outline("Para\n*\nafter")).toEqual(["para 0-2"]);
  });

  it("takes several lines, up to the list", () => {
    expect(outline("one\ntwo\nthree\n- a")).toEqual(["para 0-3", "  item 3-3"]);
  });

  it("is ended by a heading, a fence, a quote or a rule", () => {
    expect(outline("a\n# H")).toEqual(["para 0-0", "heading 1-1"]);
    expect(outline("a\n```\nx\n```")).toEqual(["para 0-0", "fence 1-3"]);
    expect(outline("a\n> q")).toEqual(["para 0-0", "quote 1-1"]);
    expect(outline("a\n\n***\nb")).toEqual(["para 0-0", "rule 2-2", "para 3-3"]);
  });

  it("is not owned by a heading: a list after a heading is a list", () => {
    expect(outline("# H\n- a")).toEqual(["heading 0-0", "list 1-1", "  item 1-1"]);
  });

  it("is split at each blank line, however many", () => {
    expect(outline("a\n\n\n\nb\nc\n\nd")).toEqual(["para 0-0", "para 4-5", "para 7-7"]);
  });

  it("includes lines indented by up to three spaces, and past them", () => {
    expect(outline("  a\n   b\n      c")).toEqual(["para 0-2"]);
  });

  it("does not let a paragraph take a list that is nested in an item", () => {
    expect(outline("- Para\n  - sub")).toEqual(["list 0-1", "  item 0-1", "    item 1-1"]);
  });
});

describe("the block parser: headings and rules", () => {
  it("reads ATX headings of every level, with closing hashes, up to three spaces in", () => {
    expect(outline("# a\n## b ##\n###### c\n   # d")).toEqual(["heading 0-0", "heading 1-1", "heading 2-2", "heading 3-3"]);
  });

  it("does not read seven hashes as a heading", () => {
    expect(outline("####### x")).toEqual(["para 0-0"]);
  });

  it("does not read a line of dashes or equals under text as a heading", () => {
    expect(outline("Title\n=====\n\nPara")).toEqual(["para 0-1", "para 3-3"]);
    expect(outline("Title\n-----\nPara")).toEqual(["para 0-0", "rule 1-1", "para 2-2"]);
  });

  it("reads rules that look like bullets", () => {
    expect(outline("***\n\n- - -\n\n___\n\n---")).toEqual(["rule 0-0", "rule 2-2", "rule 4-4", "rule 6-6"]);
  });

  it("does not take a heading for the start of a list", () => {
    expect(outline("# - a")).toEqual(["heading 0-0"]);
  });
});

describe("the block parser: code", () => {
  it("reads a fence as one block, whatever is inside it", () => {
    expect(outline("```\n# not a heading\n\n- not an item\n```\nAfter")).toEqual(["fence 0-4", "para 5-5"]);
  });

  it("reads tilde fences, longer fences and an info string", () => {
    expect(outline("~~~js\ncode\n~~~")).toEqual(["fence 0-2"]);
    expect(outline("````md\n```\ninner\n```\n````")).toEqual(["fence 0-4"]);
    expect(outline("```\na\n~~~\nb\n```")).toEqual(["fence 0-4"]);
  });

  it("closes a fence only with a fence at least as long", () => {
    expect(outline("````\na\n```\nb\n````\nc")).toEqual(["fence 0-4", "para 5-5"]);
  });

  it("runs an unclosed fence to the end of the page", () => {
    expect(outline("a\n\n```\ncode\n\nmore")).toEqual(["para 0-0", "fence 2-5"]);
  });

  it("does not read backticks in the info string as a fence", () => {
    expect(outline("``` a`b\ntext")).toEqual(["para 0-1"]);
  });

  it("reads an indented code block, which a blank line does not end", () => {
    expect(outline("    a\n\n    b\n\nPara")).toEqual(["code 0-2", "para 4-4"]);
  });
});

describe("the block parser: quotes, tables, html", () => {
  it("reads a quote as one block, with a lazy line and a list inside it", () => {
    expect(outline("> a\n> b\nlazy\n\n> c")).toEqual(["quote 0-2", "quote 4-4"]);
    expect(outline("> - a\n> - b\n\nPara")).toEqual(["quote 0-1", "para 3-3"]);
  });

  it("reads a table as one block that ends at the first blank line", () => {
    expect(outline("| a | b |\n|---|---|\n| 1 | 2 |\n\nPara")).toEqual(["table 0-2", "para 4-4"]);
  });

  it("reads a link reference definition as a block of its own", () => {
    expect(outline("[x]: http://x\n\nPara")).toEqual(["other 0-0", "para 2-2"]);
  });

  it("reads html and comment blocks", () => {
    expect(outline("<div>\nx\n</div>\n\nPara")).toEqual(["html 0-2", "para 4-4"]);
    expect(outline("<!-- note -->\n\nPara")).toEqual(["html 0-0", "para 2-2"]);
  });
});

describe("the block parser: front matter", () => {
  it("reads it as its own block, and the page after it", () => {
    expect(outline("---\ntype: concept\n---\n\n# Title\n- a")).toEqual([
      "frontmatter 0-2", "heading 4-4", "list 5-5", "  item 5-5",
    ]);
  });

  it("does not read it when it is not closed", () => {
    expect(outline("---\ntype: x\n\n- a")).toEqual(["rule 0-0", "para 1-1", "list 3-3", "  item 3-3"]);
  });

  it("does not read a rule later in the page as front matter", () => {
    expect(outline("Para\n\n---\n\nPara")).toEqual(["para 0-0", "rule 2-2", "para 4-4"]);
  });

  it("does not look for lists in it", () => {
    expect(outline("---\ntags:\n  - a\n  - b\n---\n- c")).toEqual(["frontmatter 0-4", "list 5-5", "  item 5-5"]);
  });
});

describe("the block parser: edge cases", () => {
  it("reads an empty page, and a page of blank lines", () => {
    expect(outline("")).toEqual([]);
    expect(outline("\n\n  \n")).toEqual([]);
  });

  it("does not count trailing blank lines in a block", () => {
    expect(outline("- a\n\n\n")).toEqual(["list 0-0", "  item 0-0"]);
    expect(outline("para\n\n")).toEqual(["para 0-0"]);
  });

  it("ignores a carriage return at the end of a line", () => {
    expect(outline("- a\r\n\r\npara\r\n")).toEqual(["list 0-0", "  item 0-0", "para 2-2"]);
  });

  it("keeps the first line of an item when the item's text has inline markup", () => {
    expect(outline("- **bold** [[link]] `code`\n- #tag")).toEqual(["list 0-1", "  item 0-0", "  item 1-1"]);
  });

  it("finds the innermost block at a line", () => {
    const blocks = parseBlocks(["- a", "  - b", "", "- c", "", "para"]);
    expect(blockAt(blocks, 1)?.kind).toBe("item");
    expect(blockAt(blocks, 1)?.start).toBe(1);
    expect(blockAt(blocks, 0)?.start).toBe(0);
    expect(blockAt(blocks, 2)?.kind).toBe("list");
    expect(blockAt(blocks, 4)).toBeNull();
    expect(blockAt(blocks, 5)?.kind).toBe("para");
  });

  it("records where the text of an item starts, for children that nest under it", () => {
    const item = (text: string) => parseBlocks(text.split("\n"))[0]!.children[0]!.offset;
    expect(item("- a")).toBe(2);
    expect(item("  - a")).toBe(4);
    expect(item("1. a")).toBe(3);
    expect(item("10. a")).toBe(4);
    expect(item("-   a")).toBe(4);
    expect(item("-")).toBe(2);
  });
});

describe("Escape and block selection over blank lines", () => {
  it("selects an item and what is nested in it, and no paragraph beyond", () => {
    expect(escape("- a\n  - b\n\nPara", 0)).toBe("0-1");
    expect(escape("- a\n  - b\n\nPara", 1)).toBe("1-1");
  });

  it("selects the continuation paragraph of an item together with the item", () => {
    expect(escape("- a\n\n  more\n\nPara", 2)).toBe("0-2");
  });

  it("selects a paragraph, not the list under it, when the cursor is in the paragraph's own text", () => {
    expect(escape("Idea\n- a\n- b\n\nNext", 0)).toBe("0-2");
  });

  it("selects nothing on a blank line", () => {
    expect(escape("- a\n\nPara", 1)).toBeNull();
  });

  it("selects a whole fence, a quote and a table from any line of it", () => {
    expect(escape("```\na\n\nb\n```\nafter", 3)).toBe("0-4");
    expect(escape("> a\n> b\n\n> c", 1)).toBe("0-1");
    expect(escape("| a |\n|---|\n| 1 |\n\nx", 2)).toBe("0-2");
  });

  it("selects a heading as one line", () => {
    expect(escape("# H\n- a", 0)).toBe("0-0");
    expect(escape("Title\n=====\n\nPara", 1)).toBe("0-1");
  });

  it("selects the parent item when an item is already selected, and then stops", () => {
    const lines = ["- a", "  - b", "    - c", "", "Para"];
    const one = selectBlock(lines, cursor(2))!;
    const two = selectBlock(lines, one)!;
    const three = selectBlock(lines, two)!;
    expect([one, two, three].map((s) => `${s.anchor.line}-${s.head.line}`)).toEqual(["2-2", "1-2", "0-2"]);
    expect(selectBlock(lines, three)).toBeNull();
  });

  it("extends a selection over the next sibling but not into a paragraph beyond the list", () => {
    const lines = ["- a", "- b", "", "Para"];
    const one = selectBlock(lines, cursor(1))!;
    expect(extendBlocks(lines, one, "down")).toBeNull();
    expect(extendBlocks(lines, one, "up")).toEqual({ anchor: { line: 0, col: 0 }, head: { line: 1, col: 3 } });
  });

  it("extends over blank lines between two paragraphs", () => {
    const lines = ["a", "", "", "b", "", "c"];
    const one = selectBlock(lines, cursor(0))!;
    expect(extendBlocks(lines, one, "down")).toEqual({ anchor: { line: 0, col: 0 }, head: { line: 3, col: 1 } });
  });

  it("moves an item within its list and leaves the paragraph after the blank line where it is", () => {
    const lines = ["- a", "- b", "", " Para"];
    const down = move(lines, cursor(0), "down")!;
    expect(down.rows.map((r) => r.text)).toEqual(["- b", "- a", "", " Para"]);
    const last = move(lines, cursor(1), "down")!;
    expect(last.rows.map((r) => r.text)).toEqual(lines);
  });
});

describe("the lines of the block being edited", () => {
  const lines = (text: string, at: number) => editedBlockLines(text.split("\n"), at);

  it("is a paragraph's lines, and not the list under it", () => {
    expect(lines("one\ntwo\n- a", 0)).toEqual([0, 1]);
    expect(lines("one\ntwo\n- a", 2)).toEqual([2]);
  });

  it("is an item's own lines, and not the items nested in it", () => {
    expect(lines("- a\n  lazy\n  - b\n- c", 0)).toEqual([0, 1]);
    expect(lines("- a\n  - b\n- c", 1)).toEqual([1]);
  });

  it("is an item and its continuation paragraphs, with the nested list left out", () => {
    expect(lines("- a\n  - b\n\n  after\n- c", 0)).toEqual([0, 3]);
  });

  it("is a heading's line, and a quote's lines", () => {
    expect(lines("# H\n- a", 0)).toEqual([0]);
    expect(lines("> a\n> b", 1)).toEqual([0, 1]);
  });

  it("is nothing for a blank line, and the line itself in a fence", () => {
    expect(lines("a\n\nb", 1)).toEqual([]);
    expect(lines("```\na\n\nb\n```", 3)).toEqual([3]);
  });
});

// ---- generated pages -------------------------------------------------------------------

/** A small deterministic random generator, so a failure can be reproduced. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const PIECES = [
  "", "", "  ", "text", "more text", " indented", "  two", "   three", "    four",
  "- a", "  - b", "    - c", "- ", "-", "* x", "1. one", "2. two", "   - under one", "10. ten",
  "# H", "## H2", "#tag", "Title", "=====", "-----", "***", "- - -", "---",
  "```", "```js", "~~~", "  ```", "> quote", "> - in quote", "| a | b |", "|---|---|",
  "<div>", "<!-- c -->", "[x]: http://x", "- [ ] task", "  lazy",
];

function generate(next: () => number): string[] {
  const count = 1 + Math.floor(next() * 14);
  return Array.from({ length: count }, () => PIECES[Math.floor(next() * PIECES.length)]!);
}

describe("the block parser on generated pages", () => {
  const pages: string[][] = [];
  const next = rng(2026);
  for (let i = 0; i < 400; i++) pages.push(generate(next));

  const all = (blocks: Block[]): Block[] => blocks.flatMap((b) => [b, ...all(b.children)]);

  it("never throws, and keeps every range inside the page", () => {
    for (const page of pages) {
      for (const b of all(parseBlocks(page))) {
        expect(b.start, page.join("\n")).toBeGreaterThanOrEqual(0);
        expect(b.end, page.join("\n")).toBeLessThan(page.length);
        expect(b.end, page.join("\n")).toBeGreaterThanOrEqual(b.start);
      }
    }
  });

  it("starts and ends every block on a line with text", () => {
    for (const page of pages) {
      for (const b of all(parseBlocks(page))) {
        expect(page[b.start]!.trim(), `${page.join("\n")} @${b.kind} ${b.start}`).not.toBe("");
        expect(page[b.end]!.trim(), `${page.join("\n")} @${b.kind} ${b.end}`).not.toBe("");
      }
    }
  });

  it("orders top-level blocks and never lets two overlap", () => {
    for (const page of pages) {
      const blocks = parseBlocks(page);
      for (let i = 1; i < blocks.length; i++) {
        expect(blocks[i]!.start, page.join("\n")).toBeGreaterThan(blocks[i - 1]!.end);
      }
    }
  });

  it("keeps children inside their parent, in order, with the parent set", () => {
    for (const page of pages) {
      for (const b of all(parseBlocks(page))) {
        let last = b.start - 1;
        for (const c of b.children) {
          expect(c.parent, page.join("\n")).toBe(b);
          expect(c.start, page.join("\n")).toBeGreaterThan(last);
          expect(c.end, page.join("\n")).toBeLessThanOrEqual(b.end);
          last = c.end;
        }
      }
    }
  });

  it("covers every line with text by exactly one top-level block", () => {
    for (const page of pages) {
      const blocks = parseBlocks(page);
      page.forEach((line, i) => {
        if (line.trim() === "") return;
        const hits = blocks.filter((b) => i >= b.start && i <= b.end);
        expect(hits.length, `${page.join("\n")}\n@${i}`).toBe(1);
      });
    }
  });

  it("never has a blank line inside a heading, a rule or the own text of a paragraph", () => {
    for (const page of pages) {
      for (const b of all(parseBlocks(page))) {
        if (b.kind !== "para" && b.kind !== "heading" && b.kind !== "rule") continue;
        const last = b.kind === "para" && b.children.length > 0 ? b.children[0]!.start - 1 : b.end;
        for (let i = b.start; i <= last; i++) {
          expect(page[i]!.trim(), `${page.join("\n")}\n@${b.kind} ${b.start}-${b.end}`).not.toBe("");
        }
      }
    }
  });

  it("selects, from any line, a range that holds that line and stays inside one top-level block", () => {
    for (const page of pages) {
      const blocks = parseBlocks(page);
      page.forEach((_, i) => {
        const sel = selectBlock(page, cursor(i));
        if (!sel) return;
        const top = blocks.find((b) => i >= b.start && i <= b.end)!;
        expect(top, `${page.join("\n")}\n@${i}`).toBeDefined();
        expect(sel.anchor.line, `${page.join("\n")}\n@${i}`).toBeGreaterThanOrEqual(top.start);
        expect(sel.head.line, `${page.join("\n")}\n@${i}`).toBeLessThanOrEqual(top.end);
        expect(sel.anchor.line).toBeLessThanOrEqual(i);
        expect(sel.head.line).toBeGreaterThanOrEqual(i);
      });
    }
  });
});
