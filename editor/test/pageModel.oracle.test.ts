// The page model against `tessela-core`. The model reads a page from the editor's syntax tree and the
// index reads it with pulldown-cmark; `tessela blocks PAGE --json` is the index's answer. Where
// conventions §3 says what a page is made of, the two must agree: which lines start and end a block,
// its kind, its parent and section, and its handle. The differences that are meant are listed here,
// each as a test that shows it, so that they are not discovered by users.
//
// The tool is `$TESSELA_BIN` or the build in `../target` (`cargo build -p tessela-cli`). CI builds it.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";

import { findTessela } from "../src/main/tessela";
import { INDEXED_KINDS, type PageNode } from "../src/shared/pageModel";
import { page, pageWithExtras } from "./support/pages";
import { modelOf, outline } from "./support/page";
import { runs } from "./support/props";

const tool = findTessela({
  env: process.env.TESSELA_BIN,
  resourcesPath: undefined,
  appPath: path.resolve(__dirname, ".."),
  platform: process.platform,
  exists: existsSync,
});
/** A property run starts the tool once per page. */
const SLOW = 120_000;
const haveTool = path.isAbsolute(tool) && existsSync(tool);

interface Block {
  handle: string;
  kind: string;
  line: number;
  end_line: number;
  parent: string | null;
  section: string | null;
  task: string | null;
}
interface Heading {
  handle: string;
  level: number;
  line: number;
  end_line: number;
  parent: string | null;
}

const dir = mkdtempSync(path.join(tmpdir(), "tessela-oracle-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** What the index says about a page. */
function index(text: string): { blocks: Block[]; headings: Heading[] } {
  writeFileSync(path.join(dir, "p.md"), text);
  const run = spawnSync(tool, ["blocks", "p.md", "--bundle", dir, "--json"], { encoding: "utf8" });
  const answer = JSON.parse(run.stdout) as { ok: boolean; blocks: Block[]; headings: Heading[] };
  if (!answer.ok) throw new Error(`tessela blocks failed: ${run.stdout}`);
  return answer;
}

/** Without the page ID: `p#9f2c41d0` is the key `9f2c41d0`. */
const keyOf = (handle: string | null) => (handle === null ? null : handle.slice(handle.indexOf("#") + 1));

/**
 * The nodes of the model that the index has an opinion about, in reading order. The differences
 * that are meant, each shown by a test below:
 *
 *  - The index lists no front matter, `$$` block, footnote definition, thematic break or link
 *    definition: the model has those as nodes of their own kinds.
 *  - A quote, callout or footnote definition is one block in the index, whose items are not blocks.
 *    In the model its list items are children, so that they can be stepped to, moved and folded.
 *  - A `$$` block that is in an item ends the text of the item in the model; the index reads it as
 *    text. One with a blank line in it is one node in the model and two paragraphs in the index.
 *  - Front matter: the model takes `...` as a closing line and a `---` that is never closed as a
 *    thematic break; the index wants `---` and takes the page for malformed.
 *  - An ordered item that is not numbered 1 does not interrupt a paragraph in the model (CommonMark);
 *    pulldown-cmark lets it in a nested item.
 */
function visible(root: PageNode): PageNode[] {
  const out: PageNode[] = [];
  const walk = (n: PageNode, inside: boolean) => {
    for (const c of n.children) {
      if (!inside && INDEXED_KINDS.includes(c.kind)) out.push(c);
      walk(c, inside || c.kind === "quote" || c.kind === "callout" || c.kind === "footnote");
    }
  };
  walk(root, false);
  return out;
}

/** What the two disagree on in `text`, as readable lines; empty when they agree. */
function disagreements(text: string): string[] {
  const rust = index(text);
  const model = modelOf(text);
  const problems: string[] = [];
  const sections = model.nodes.filter((n) => n.kind === "section");
  if (sections.length !== rust.headings.length) problems.push(`headings: model ${sections.length}, index ${rust.headings.length}`);
  sections.forEach((s, i) => {
    const h = rust.headings[i];
    if (!h) return;
    const want = { level: h.level, line: h.line, end: h.end_line, parent: keyOf(h.parent), key: keyOf(h.handle) };
    const got = { level: s.level, line: s.startLine, end: s.endLine, parent: s.section?.key ?? null, key: s.key };
    if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`heading ${i}: model ${JSON.stringify(got)}, index ${JSON.stringify(want)}`);
  });
  const nodes = visible(model.root);
  if (nodes.length !== rust.blocks.length) problems.push(`blocks: model ${nodes.length}, index ${rust.blocks.length}`);
  nodes.forEach((n, i) => {
    const b = rust.blocks[i];
    if (!b) return;
    const parent = n.parent && INDEXED_KINDS.includes(n.parent.kind) ? n.parent.key : null;
    const want = { kind: b.kind, line: b.line, end: b.end_line, parent: keyOf(b.parent), section: keyOf(b.section), key: keyOf(b.handle), task: b.task };
    const got = { kind: n.kind, line: n.startLine, end: n.endLine, parent, section: n.section?.key ?? null, key: n.key, task: n.task };
    if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`block ${i}: model ${JSON.stringify(got)}, index ${JSON.stringify(want)}`);
  });
  return problems;
}

const report = (text: string) => `${text}\n--- model\n${outline(modelOf(text))}\n--- differences\n${disagreements(text).join("\n")}`;

describe.skipIf(!haveTool)("the page model and `tessela blocks` agree", () => {
  it("on a page with every construct the conventions name", () => {
    const text = [
      "---", "type: concept", "---", "",
      "# Title", "",
      "Intro paragraph", "- item one", "  - nested", "  ```js", "  code", "  ```", "  > quote in item", "  more after the quote",
      "- [ ] open task", "- [x] done task", "",
      "## Sub", "", "1. first", "2. second", "   - under second", "",
      "> [!NOTE]", "> a callout", "", "> plain quote", "",
      "| a | b |", "| --- | --- |", "| 1 | 2 |", "",
      "<div>raw</div>", "", "---", "",
      "# Next", "text", "",
    ].join("\n");
    expect(disagreements(text), report(text)).toEqual([]);
  });

  it("on generated pages", () => {
    fc.assert(
      fc.property(page, (text) => {
        expect(disagreements(text), report(text)).toEqual([]);
      }),
      runs(150),
    );
  }, SLOW);
});

describe.skipIf(!haveTool)("the differences that are meant", () => {
  it("a `$$` block with a blank line inside is one node; the index reads two paragraphs", () => {
    const text = "$$\nx\n\ny\n$$\n";
    expect(modelOf(text).root.children.map((n) => `${n.kind} ${n.startLine}-${n.endLine}`)).toEqual(["math 1-5"]);
    expect(index(text).blocks.map((b) => `${b.kind} ${b.line}-${b.end_line}`)).toEqual(["paragraph 1-2", "paragraph 4-5"]);
  });

  it("a footnote definition with a continuation is one node; the index does not list it", () => {
    const text = "[^1]: note\n    continued\n";
    expect(modelOf(text).root.children.map((n) => `${n.kind} ${n.startLine}-${n.endLine}`)).toEqual(["footnote 1-2"]);
    expect(index(text).blocks.map((b) => b.kind)).not.toContain("footnote");
  });

  it("the items of a callout are children of it; the index has the callout alone", () => {
    const text = "> [!NOTE]\n> - one\n> - two\n";
    expect(outline(modelOf(text))).toBe("page\n  callout 1-3\n    item 2-2\n    item 3-3");
    expect(index(text).blocks.map((b) => b.kind)).toEqual(["callout"]);
  });

  it("a thematic break and a link definition are nodes; the index lists neither", () => {
    const text = "a\n\n***\n\n[x]: /y.md\n";
    expect(modelOf(text).root.children.map((n) => n.kind)).toEqual(["paragraph", "rule", "other"]);
    expect(index(text).blocks.map((b) => b.kind)).toEqual(["paragraph"]);
  });

  it("math in an item ends its text and is a child; the index keeps it in the text", () => {
    const text = "- item\n  $$\n  x\n  $$\n";
    expect(outline(modelOf(text))).toBe("page\n  item 1-4\n    math 2-4");
    expect(index(text).blocks.map((b) => `${b.kind} ${b.line}-${b.end_line}`)).toEqual(["item 1-4"]);
  });

  it("front matter that is never closed is a thematic break; the index takes the page for malformed and lists no block", () => {
    const text = "---\n\ntext\n";
    expect(modelOf(text).root.children.map((n) => n.kind)).toEqual(["rule", "paragraph"]);
    expect(index(text).blocks).toEqual([]);
  });

  it("front matter may be closed by `...` for the model; the index wants `---`", () => {
    const text = "---\ntype: concept\n...\n\ntext\n";
    expect(modelOf(text).root.children.map((n) => n.kind)).toEqual(["frontmatter", "paragraph"]);
    expect(index(text).blocks).toEqual([]);
  });

  it("an ordered item that is not numbered 1 does not interrupt the paragraph of a nested item; the index lets it", () => {
    const text = "- a\n  - b\n  2) c\n";
    expect(outline(modelOf(text))).toBe("page\n  item 1-3\n    item 2-3");
    expect(index(text).blocks.map((b) => `${b.kind} ${b.line}-${b.end_line}`)).toEqual(["item 1-3", "item 2-2", "item 3-3"]);
  });

  it("agree on pages with math and footnotes when what the index cannot see is left out", () => {
    fc.assert(
      fc.property(pageWithExtras, (text) => {
        // The index reads a `$$` block with a blank line as two paragraphs and a footnote
        // definition as text: those pages differ by design, as shown above.
        fc.pre(!/^\$\$|^\[\^/m.test(text));
        expect(disagreements(text), report(text)).toEqual([]);
      }),
      runs(50),
    );
  }, SLOW);
});

describe("the oracle", () => {
  it("is available in CI", () => {
    if (process.env.CI) expect(haveTool, `no tessela binary at ${tool}: run cargo build -p tessela-cli`).toBe(true);
  });
});
