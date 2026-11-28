// The page model: the rules of its shape on examples, and what must hold on every page as properties.
// How it compares with the index (`tessela blocks`) is in `pageModel.oracle.test.ts`.

import { ChangeSet, EditorState, type Text } from "@codemirror/state";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { pageModel } from "../src/renderer/pageModelField";
import { type PageModel, type PageNode, findAgain, isWhiteSpace } from "../src/shared/pageModel";
import { parsePage } from "../src/shared/pageText";
import { modelOf, outline, settled, stateOf } from "./support/page";
import { page, pageWithExtras } from "./support/pages";
import { lines as wildLines, runs } from "./support/props";

/** The tree of a page as text, one node a line, indented by depth: `kind first-last`. */
const tree = (text: string) => outline(modelOf(text));

describe("white space", () => {
  it("is the same to the check by code unit that trims the end of a node and to the expression that normalizes keys", () => {
    // Rust's `char::is_whitespace`, which is what `tessela-core` trims and splits by.
    const rust = /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/;
    for (let c = 0; c < 0x10000; c++) expect(isWhiteSpace(c), `U+${c.toString(16)}`).toBe(rust.test(String.fromCharCode(c)));
  });
});

describe("sections", () => {
  it("a heading owns what follows it up to the next heading as high or higher", () => {
    expect(tree("intro\n\n# A\n\none\n\n## B\n\ntwo\n\n## C\n\nthree\n\n# D\n\nfour\n")).toBe(
      [
        "page",
        "  paragraph 1-1",
        "  section 3-13",
        "    paragraph 5-5",
        "    section 7-9",
        "      paragraph 9-9",
        "    section 11-13",
        "      paragraph 13-13",
        "  section 15-17",
        "    paragraph 17-17",
      ].join("\n"),
    );
  });

  it("a section ends on its last line with something on it, and a heading with nothing under it ends on its own line", () => {
    const m = modelOf("# A\n\n\n## B\n# C\n\ntext\n\n\n");
    const [a, b, c] = m.nodes.filter((n) => n.kind === "section");
    expect([a!.startLine, a!.endLine, a!.level]).toEqual([1, 4, 1]);
    expect([b!.startLine, b!.endLine, b!.level]).toEqual([4, 4, 2]);
    expect([c!.startLine, c!.endLine, c!.level]).toEqual([5, 7, 1]);
  });

  it("a deeper heading that comes first does not hold a higher one", () => {
    const m = modelOf("### Low\n\n# High\n");
    expect(m.root.children.map((n) => `${n.kind}${n.level}`)).toEqual(["section3", "section1"]);
  });

  it("a `#` line in an item is text, not a section", () => {
    expect(tree("- a\n  # not a heading\n")).toBe("page\n  item 1-2");
  });

  it("is found from a block with `section`", () => {
    const m = modelOf("# A\n\n## B\n\n- item\n");
    const item = m.nodes.find((n) => n.kind === "item")!;
    expect(item.section?.startLine).toBe(3);
    expect(m.sectionOf(item)).toBe(item.section);
    expect(m.sectionOf(item.section!)?.startLine).toBe(1);
    expect(m.sectionOf(m.nodes[0]!)).toBeNull();
  });
});

describe("blocks and children", () => {
  it("a paragraph owns the list that starts on the line right beneath it", () => {
    expect(tree("Idea\n- one\n  - two\n- three\n")).toBe("page\n  paragraph 1-4\n    item 2-3\n      item 3-3\n    item 4-4");
  });

  it("a blank line keeps a list apart from the paragraph above it, and a heading owns no list", () => {
    expect(tree("Idea\n\n- one\n")).toBe("page\n  paragraph 1-1\n  item 3-3");
    expect(tree("# H\n- one\n")).toBe("page\n  section 1-2\n    item 2-2");
  });

  it("a list is not a node: its items are siblings", () => {
    const m = modelOf("- a\n- b\n\n1. c\n");
    expect(m.root.children.map((n) => n.kind)).toEqual(["item", "item", "item"]);
    expect(m.siblings(m.root.children[1]!)).toEqual(m.root.children);
  });

  it("a fence, a quote and a callout in an item are its children and end its text", () => {
    expect(tree("- text\n  ```\n  code\n  ```\n  > quoted\n\n  > [!TIP]\n  > tip\n")).toBe(
      "page\n  item 1-8\n    code 2-4\n    quote 5-5\n    callout 7-8",
    );
  });

  it("a paragraph, table or HTML in an item is its text before a child and a child after one", () => {
    expect(tree("- text\n\n  more text\n\n  | a |\n  |---|\n  | 1 |\n")).toBe("page\n  item 1-7");
    expect(tree("- text\n  - nested\n\n  after the list\n")).toBe("page\n  item 1-4\n    item 2-2\n    paragraph 4-4");
    expect(tree("- text\n  ```\n  c\n  ```\n\n  after\n\n  <div>x</div>\n")).toBe("page\n  item 1-8\n    code 2-4\n    paragraph 6-6\n    html 8-8");
  });

  it("a child is inside its parent, and an item ends with its last child", () => {
    const m = modelOf("- a\n  - b\n    - c\n- d\n");
    const [a, b, c, d] = m.nodes;
    expect([a!.endLine, b!.endLine, c!.endLine, d!.endLine]).toEqual([3, 3, 3, 4]);
    expect(c!.parent).toBe(b);
    expect(b!.contains(c!)).toBe(true);
    expect(c!.contains(b!)).toBe(false);
  });

  it("the items of a quote, a callout and a footnote definition are its children", () => {
    expect(tree("> intro\n> - one\n>   - two\n")).toBe("page\n  quote 1-3\n    item 2-3\n      item 3-3");
    expect(tree("> [!NOTE]\n> - one\n> - two\n")).toBe("page\n  callout 1-3\n    item 2-2\n    item 3-3");
    expect(tree("[^1]: note\n    - one\n")).toBe("page\n  footnote 1-2\n    item 2-2");
  });

  it("a callout is a quote whose first line is `> [!KIND]` alone", () => {
    expect(modelOf("> [!NOTE]\n> a\n\n> [!NOTE] text\n\n> plain\n").root.children.map((n) => n.kind)).toEqual(["callout", "quote", "quote"]);
  });

  it("tasks are items with a checkbox", () => {
    const m = modelOf("- [ ] a\n- [x] b\n- [X] c\n- [] d\n- e [ ]\n- [ ]\n");
    expect(m.nodes.map((n) => n.task)).toEqual(["open", "done", "done", null, null, null]);
  });

  it("knows tables, HTML, thematic breaks, link definitions and the rest", () => {
    const text = "| a |\n|---|\n| 1 |\n\n<div>x</div>\n\n***\n\n[x]: /y.md\n\n~~~\ncode\n~~~\n\n    indented\n";
    expect(modelOf(text).root.children.map((n) => n.kind)).toEqual(["table", "html", "rule", "other", "code", "code"]);
  });
});

describe("Tessela syntax", () => {
  it("front matter is a node, and the page begins after it", () => {
    expect(tree("---\ntype: concept\n---\n\n# H\n")).toBe("page\n  frontmatter 1-3\n  section 5-5");
  });

  it("front matter that is never closed is a thematic break", () => {
    expect(tree("---\n\ntext\n")).toBe("page\n  rule 1-1\n  paragraph 3-3");
  });

  it("a `$$` block with a blank line inside is one node", () => {
    expect(tree("$$\nx\n\ny\n$$\n\nafter\n")).toBe("page\n  math 1-5\n  paragraph 7-7");
  });

  it("a `$$` block that is never closed runs to the end of what holds it", () => {
    expect(tree("$$\nx\n\n- item\n")).toBe("page\n  math 1-4");
  });

  it("a footnote definition with a continuation is one node", () => {
    expect(tree("[^1]: note\n    continued\n\nafter\n")).toBe("page\n  footnote 1-2\n  paragraph 4-4");
  });
});

describe("keys", () => {
  it("are the block handles of conventions §3, without the page", () => {
    // The handles `tessela blocks` prints for this page, as in the oracle test.
    const m = modelOf("# Title\n\nIntro paragraph\n- item one\n  - nested\n");
    expect(m.nodes.map((n) => n.key)).toEqual(["537b1433", "3d87ced3", "8510fc79", "dab52cf7"]);
  });

  it("are the same for the same text however it is laid out, and count repeats from the second", () => {
    const m = modelOf("same text\n\n- same   text\n\n* same\ttext\n\n# same text\n");
    const keys = m.nodes.map((n) => n.key);
    expect(keys[1]).toBe(keys[0] + ".2");
    expect(keys[2]).toBe(keys[0] + ".3");
    // A heading hashes with its `# `, so it does not repeat a block.
    expect(keys[3]).not.toBe(keys[0]);
    expect(m.nodes.map((n) => n.hash).slice(0, 3)).toEqual([keys[0], keys[0], keys[0]]);
    expect(m.byKey(keys[1]!)).toEqual([m.nodes[1]]);
  });

  it("do not include the checkbox of a task or the text of the items beneath", () => {
    const a = modelOf("- [ ] write\n  - sub\n");
    const b = modelOf("- write\n");
    expect(a.nodes[0]!.key).toBe(b.nodes[0]!.key);
  });
});

describe("finding a node by position", () => {
  const m = modelOf("# H\n\n- one\n  - two\n\n  ```\n  code\n\n  more\n  ```\n\nlast\n");

  it("gives the innermost node, and the page for what nothing holds", () => {
    expect(m.nodeAt(0).kind).toBe("section");
    expect(m.nodeAt(m.doc.line(4).to).toString()).toBe("item@4-4");
    expect(m.nodeAt(m.doc.line(7).from + 3).kind).toBe("code");
    // A blank line inside a fence is in the fence; one between blocks is in what holds them.
    expect(m.nodeAt(m.doc.line(8).from).kind).toBe("code");
    expect(m.nodeAt(m.doc.line(2).from).kind).toBe("section");
    expect(m.nodeAt(m.doc.line(5).from).kind).toBe("item");
    expect(m.nodeAt(m.doc.line(12).to).toString()).toBe("paragraph@12-12");
  });

  it("counts the indentation of a line as part of what the line starts", () => {
    expect(m.nodeAt(m.doc.line(4).from).toString()).toBe("item@4-4");
    expect(m.nodeAt(m.doc.line(4).from + 1).toString()).toBe("item@4-4");
  });

  it("finds the node that covers a whole line", () => {
    expect(m.nodeAtLine(7).kind).toBe("code");
    expect(m.nodeAtLine(5).kind).toBe("item");
    expect(m.nodeAtLine(2).kind).toBe("section");
    expect(m.nodeAtLine(99)).toBe(m.root);
  });

  it("lists the nodes in reading order", () => {
    expect(m.readingOrder().map((n) => n.toString())).toEqual([
      "section@1-12", "item@3-10", "item@4-4", "code@6-10", "paragraph@12-12",
    ]);
  });
});

describe("as state", () => {
  it("is one object until the page changes: a selection or a focus change does not rebuild it", () => {
    const s = stateOf("# A\n\ntext\n");
    const model = s.field(pageModel);
    expect(s.update({ selection: { anchor: 3 } }).state.field(pageModel)).toBe(model);
    const edited = s.update({ changes: { from: 0, insert: "x" } }).state.field(pageModel);
    expect(edited).not.toBe(model);
    expect(edited.complete).toBe(true);
    expect(edited.nodes[0]!.kind).toBe("paragraph");
  });
});

describe("finding a node again after an edit", () => {
  const before = modelOf("a\n\n- one\n  - two\n\nlast\n");
  const two = before.nodes.find((n) => n.startLine === 4)!;

  it("follows a node as text is added above it", () => {
    const changes = ChangeSet.of({ from: 0, insert: "new paragraph\n\n" }, before.doc.length);
    const next = modelOf(changes.apply(before.doc).toString());
    const found = findAgain(next, two, changes);
    expect(found?.toString()).toBe("item@6-6");
    expect(found?.key).toBe(two.key);
  });

  it("finds a node whose own text was typed in, and not one that was deleted", () => {
    const typed = ChangeSet.of({ from: two.from + 2, insert: "x" }, before.doc.length);
    expect(findAgain(modelOf(typed.apply(before.doc).toString()), two, typed)?.kind).toBe("item");
    const gone = ChangeSet.of({ from: before.doc.line(3).from, to: before.doc.length, insert: "" }, before.doc.length);
    expect(findAgain(modelOf(gone.apply(before.doc).toString()), two, gone)).toBeNull();
  });
});

// ---- properties ----------------------------------------------------------------------------------

/** Pages of every kind: shaped like notes, with math and footnotes, and arbitrary lines. */
const anyPage = fc.oneof(
  { weight: 3, arbitrary: page },
  { weight: 2, arbitrary: pageWithExtras },
  { weight: 2, arbitrary: wildLines.map((ls) => ls.join("\n")) },
);

/** What is wrong with the shape of a model, one problem a line; empty when it is as it should be. */
function broken(model: PageModel): string[] {
  const doc = model.doc;
  const problems: string[] = [];
  const preorder: PageNode[] = [];
  const walk = (n: PageNode) => {
    if (n !== model.root) preorder.push(n);
    n.children.forEach((c, i) => {
      if (c.parent !== n) problems.push(`${c} has the wrong parent`);
      if (c.from < n.from || c.to > n.to) problems.push(`${c} is not inside ${n}`);
      const prev = n.children[i - 1];
      if (prev && !(prev.to < c.from && prev.endLine < c.startLine)) problems.push(`${prev} and ${c} are not apart, under ${n}`);
      walk(c);
    });
  };
  walk(model.root);
  if (preorder.length !== model.nodes.length || preorder.some((n, i) => n !== model.nodes[i])) problems.push("nodes are not in reading order");
  for (const n of model.nodes) {
    if (n.from > n.to) problems.push(`${n} ends before it starts`);
    if (doc.lineAt(n.from).number !== n.startLine || doc.lineAt(n.to).number !== n.endLine) problems.push(`${n} has lines that do not match its range`);
    if (n.kind === "section") {
      const up = n.section;
      if (up && up.level >= n.level) problems.push(`${n} is under a heading as deep or deeper`);
      if (n.parent !== (up ?? model.root)) problems.push(`${n} is not directly under its section`);
    }
    if (n.kind !== "section" && n.level !== 0) problems.push(`${n} has a level`);
  }
  // Every line with something on it belongs to exactly one node, the innermost that covers the whole
  // line, and that is never the page; a section owns its heading line and nothing else.
  for (let line = 1; line <= doc.lines; line++) {
    if (doc.line(line).text.trim() === "") continue;
    const owner = model.nodeAtLine(line);
    if (owner === model.root) problems.push(`line ${line} belongs to no node`);
    else if (owner.kind === "section" && owner.startLine !== line) problems.push(`line ${line} belongs to ${owner} and is not its heading`);
  }
  return problems;
}

describe("properties of every page", () => {
  it("nodes nest, are in order and apart, and every line with text belongs to one node", () => {
    fc.assert(
      fc.property(anyPage, (text) => {
        expect(broken(modelOf(text)), `${text}\n---\n${tree(text)}`).toEqual([]);
      }),
      runs(300),
    );
  });

  it("every position is in some node, and the node covers it", () => {
    fc.assert(
      fc.property(anyPage, fc.nat(), (text, seed) => {
        const m = modelOf(text);
        const pos = seed % (text.length + 1);
        const node = m.nodeAt(pos);
        if (node !== m.root) {
          // Positions in the indentation of a line count as the first character after it.
          const line = m.doc.lineAt(pos);
          const at = Math.max(pos, line.from + /^[ \t]*/.exec(line.text)![0].length);
          expect(node.from <= Math.min(at, node.to) && at <= node.to || pos <= node.to, `${node}`).toBe(true);
        }
        expect(m.nodeAt(pos)).toBe(node);
      }),
      runs(200),
    );
  });
});

/** Replaces `[from, to)` of `doc` and returns the state before and after. */
function edit(text: string, from: number, to: number, insert: string) {
  const before = stateOf(text);
  const tr = before.update({ changes: { from, to, insert } });
  return { before, tr, after: tr.state };
}

const piece = fc.constantFrom("\n", "\n\n", "- ", "1. ", "# ", "> ", "> [!NOTE]\n", "```", "$$", "---", "[^1]: ", "    ", "  ", "x", " word ", "|", "<div>", "[ ] ");

describe("a model built after an edit is the one built from the text", () => {
  it("whatever the edit, however the parser reuses what it had", () => {
    fc.assert(
      fc.property(anyPage, fc.nat(), fc.nat({ max: 12 }), fc.array(piece, { maxLength: 3 }), (text, a, len, parts) => {
        const from = a % (text.length + 1);
        const { after } = edit(text, from, Math.min(text.length, from + len), parts.join(""));
        const fresh = modelOf(after.doc.toString());
        const got = settled(after);
        expect(outline(got), after.doc.toString()).toBe(outline(fresh));
        expect(got.nodes.map((n) => n.key)).toEqual(fresh.nodes.map((n) => n.key));
      }),
      runs(300),
    );
  });

  it("also when the parser had no time to reach the end: the model is partial, and whole once it has", () => {
    // The parser gets a short budget for each version. A page this long is not parsed within it
    // on any machine, as a slow runner would not parse a short one.
    const long = Array.from({ length: 30_000 }, (_, i) => `- item ${i} with **bold** and a [link](/x.md)\n  more`).join("\n");
    const { after } = edit(long, 0, 0, "- new\n");
    expect(after.field(pageModel).complete).toBe(false);
    const got = settled(after);
    expect(got.complete).toBe(true);
    expect(outline(got)).toBe(outline(modelOf(after.doc.toString())));
  });
});

describe("identity", () => {
  /** Replaces a run of letters that lies outside `node` by other letters, or adds a paragraph at the end. */
  const outside = (doc: Text, node: PageNode, pick: number, letters: string) => {
    const words = [...doc.toString().matchAll(/[A-Za-z]+/g)].filter((m) => m.index + m[0].length <= node.from || m.index >= node.to);
    const w = words[pick % (words.length + 1)];
    return w ? { from: w.index, to: w.index + w[0].length, insert: letters } : { from: doc.length, insert: "\nappended paragraph\n" };
  };

  it("a node survives edits made elsewhere on the page: it is found again, the same node of the same text", () => {
    fc.assert(
      fc.property(page, fc.nat(), fc.nat(), fc.stringMatching(/^[a-z]{1,5}$/), (text, which, pick, letters) => {
        const before = stateOf(text);
        const model = before.field(pageModel);
        const nodes = model.nodes.filter((n) => n.kind !== "frontmatter");
        fc.pre(nodes.length > 0);
        const node = nodes[which % nodes.length]!;
        const tr = before.update({ changes: outside(before.doc, node, pick, letters) });
        const found = findAgain(tr.state.field(pageModel), node, tr.changes);
        expect(found, `${node} in\n${text}`).not.toBeNull();
        expect(found!.kind).toBe(node.kind);
        expect(found!.hash).toBe(node.hash);
        expect(found!.startLine).toBe(node.startLine);
        // A section grows with what is added at the end of the page, and nothing else does.
        if (node.kind !== "section") expect(found!.endLine).toBe(node.endLine);
      }),
      runs(300),
    );
  });
});

describe("what a command needs to know about a node", () => {
  it("tells a fenced block, with its info string and whether it closed, from an indented one", () => {
    const fences = (text: string) => modelOf(text).nodes.filter((n) => n.kind === "code").map((n) => n.fence);
    expect(fences("```js title\ncode\n```")).toEqual([{ info: "js title", closed: true }]);
    expect(fences("~~~\nnever closed")).toEqual([{ info: "", closed: false }]);
    expect(fences("- a\n  ```tessela\n  q\n  ```")).toEqual([{ info: "tessela", closed: true }]);
    expect(fences("text\n\n    indented")).toEqual([null]);
  });

  it("is called by its first line, without a marker, a checkbox or the #s", () => {
    const m = modelOf("# Title ##\n\n- [x] done task\n  more\n\n1. numbered\n\nplain\nparagraph");
    expect(m.nodes.map((n) => n.label)).toEqual(["Title", "done task", "numbered", "plain"]);
  });
});

describe("the same page, with or without an editor", () => {
  it("is read the same by the state field and by `parsePage`, which commands use on text they have just made", () => {
    fc.assert(
      fc.property(page, (text) => {
        expect(outline(parsePage(text))).toBe(outline(modelOf(text)));
      }),
      runs(200),
    );
  });
});
