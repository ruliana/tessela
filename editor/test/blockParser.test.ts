// One parser decides where a block starts and ends: Escape, Tab, Alt+Up/Down, the line the
// live preview shows raw and the block focus mode keeps lit all ask it. These tests pin it to
// CommonMark, with Tessela's one extra rule: a paragraph owns the list right beneath it.

import { describe, expect, it } from "vitest";

import { respond } from "../src/renderer/blockKeys";
import { type Sel, blockAt, move } from "../src/shared/blocks";
import type { PageNode } from "../src/shared/pageModel";
import { modelOf } from "./support/page";
import { picked, press, selecting } from "./support/selecting";

/**
 * The blocks of `text` as one line each, `kind first-last` (0-based lines), children indented by two. The
 * page model has no list nodes and makes a heading hold its section, so this draws it the way these
 * tests were written: a run of items at the top is shown as a `list`, and what a heading holds is shown
 * beside it.
 */
function outline(text: string): string[] {
  const out: string[] = [];
  const kind = (n: PageNode) => (n.kind === "paragraph" ? "para" : n.kind === "section" ? "heading" : n.kind === "code" && n.fence ? "fence" : n.kind);
  const line = (n: PageNode, depth: number, own = false) =>
    out.push(`${"  ".repeat(depth)}${kind(n)} ${n.startLine - 1}-${(own && n.kind === "section" ? n.startLine : n.endLine) - 1}`);
  const walk = (nodes: readonly PageNode[], depth: number, top: boolean) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      if (n.kind === "item" && top) {
        let j = i;
        while (nodes[j]?.kind === "item") j++;
        out.push(`${"  ".repeat(depth)}list ${n.startLine - 1}-${nodes[j - 1]!.endLine - 1}`);
        walk(nodes.slice(i, j), depth + 1, false);
        i = j - 1;
        continue;
      }
      line(n, depth, true);
      // A heading's section is drawn beside it; an item's or a paragraph's children, inside.
      if (n.kind === "section") walk(n.children, depth, true);
      else walk(n.children, depth + 1, false);
    }
  };
  walk(modelOf(text).root.children, 0, true);
  return out;
}

const cursor = (line: number, col = 0): Sel => ({ anchor: { line, col }, head: { line, col } });

/** What Escape selects with the cursor on `line`, as `first-last`, or null. */
function escape(text: string, line: number): string | null {
  const sel = picked(selecting(text, line));
  return sel ? `${sel[0]}-${sel[1]}` : null;
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

  it("reads items of any bullet or delimiter as siblings: a list is not a node, a run of items is what it was", () => {
    expect(outline("- a\n* b\n+ c")).toEqual(["list 0-2", "  item 0-0", "  item 1-1", "  item 2-2"]);
    expect(outline("1. a\n2) b")).toEqual(["list 0-1", "  item 0-0", "  item 1-1"]);
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

  it("keeps a code fence inside an item as part of that item, as its child block", () => {
    expect(outline("- a\n  ```\n  - not\n\n  ```\n- b")).toEqual(["list 0-5", "  item 0-4", "    fence 1-4", "  item 5-5"]);
  });

  it("keeps a quote inside an item as part of that item, as its child block", () => {
    expect(outline("- a\n  > quote\n  > more\n- b")).toEqual(["list 0-3", "  item 0-2", "    quote 1-2", "  item 3-3"]);
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
    expect(outline("> - a\n> - b\n\nPara")).toEqual(["quote 0-1", "  item 0-0", "  item 1-1", "para 3-3"]);
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
    const model = modelOf("- a\n  - b\n\n- c\n\npara");
    expect(blockAt(model, 1)?.kind).toBe("item");
    expect(blockAt(model, 1)?.startLine).toBe(2);
    expect(blockAt(model, 0)?.startLine).toBe(1);
    // The blank line between two items belongs to nothing but the page.
    expect(blockAt(model, 2)).toBeNull();
    expect(blockAt(model, 4)).toBeNull();
    expect(blockAt(model, 5)?.kind).toBe("paragraph");
  });

  it("has no block on the blank line under a heading, and the heading's own line is the heading", () => {
    const model = modelOf("# H\n\ntext");
    expect(blockAt(model, 0)?.kind).toBe("section");
    expect(blockAt(model, 1)).toBeNull();
    expect(blockAt(model, 2)?.kind).toBe("paragraph");
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

  it("selects the parent item when an item is already selected, then the page, and then stops", () => {
    const text = ["- a", "  - b", "    - c", "", "Para"].join("\n");
    const widened: string[] = [];
    let state = selecting(text, 2);
    for (let reply = respond(state, "Escape"); ; reply = respond(state, "Escape")) {
      widened.push(picked(state)!.join("-"));
      if (typeof reply !== "object" || reply === null) break;
      state = state.update(reply).state;
    }
    expect(widened).toEqual(["2-2", "1-2", "0-2", "0-4"]);
  });

  it("takes the next block in with Shift+Down, even one beyond the list, and gives it back with Shift+Up", () => {
    const text = ["- a", "- b", "", "Para"].join("\n");
    const one = selecting(text, 1);
    expect(picked(press(one, "Shift-ArrowDown"))).toEqual([1, 3]);
    expect(picked(press(one, "Shift-ArrowUp"))).toEqual([0, 1]);
    expect(picked(press(one, "Shift-ArrowDown", "Shift-ArrowUp"))).toEqual([1, 1]);
  });

  it("extends over blank lines between two paragraphs", () => {
    const one = selecting(["a", "", "", "b", "", "c"].join("\n"), 0);
    expect(picked(press(one, "Shift-ArrowDown"))).toEqual([0, 3]);
  });

  it("moves an item within its list and leaves the paragraph after the blank line where it is", () => {
    const lines = ["- a", "- b", "", " Para"];
    const down = move(modelOf(lines.join("\n")), cursor(0), "down")!;
    expect(down.rows.map((r) => r.text)).toEqual(["- b", "- a", "", " Para"]);
    const last = move(modelOf(lines.join("\n")), cursor(1), "down")!;
    expect(last.rows.map((r) => r.text)).toEqual(lines);
  });
});

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

describe("block selection on generated pages", () => {
  const pages: string[][] = [];
  const next = rng(2026);
  for (let i = 0; i < 400; i++) pages.push(generate(next));

  it("selects, from any line, a range that holds that line", () => {
    for (const page of pages) {
      const model = modelOf(page.join("\n"));
      page.forEach((_, i) => {
        const sel = picked(selecting(page.join("\n"), i));
        if (!sel) return;
        expect(sel[0], `${page.join("\n")}\n@${i}`).toBeLessThanOrEqual(i);
        expect(sel[1], `${page.join("\n")}\n@${i}`).toBeGreaterThanOrEqual(i);
      });
    }
  });
});
