// Tessela's own syntax in the editor's one Markdown tree: front matter, callouts, footnotes and
// math are nodes, so whatever draws, folds or selects them reads the tree and not the lines.

import { GFM, parser } from "@lezer/markdown";
import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { TreeFragment } from "@lezer/common";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { frontmatterEnd, noSetext } from "../src/shared/blocks";
import { calloutKindOf, frontMatterLength, frontMatterYaml, tessela } from "../src/shared/syntax";
import { runs } from "./support/props";

/** What the editor had before: no Tessela syntax. */
const before = parser.configure([GFM, noSetext]);
/** What the editor reads a page with. */
const page = parser.configure([GFM, noSetext, tessela]);

type Tree = ReturnType<typeof page.parse>;

/** The text of every node called `name`, in document order. */
function texts(text: string, name: string, tree: Tree = page.parse(text)): string[] {
  const out: string[] = [];
  tree.iterate({ enter: (n) => void (n.name === name && out.push(text.slice(n.from, n.to))) });
  return out;
}

/** The names of the children of the first node called `name`. */
function children(text: string, name: string): string[] {
  const node = page.parse(text).topNode.getChild(name) ?? find(page.parse(text), name);
  const out: string[] = [];
  for (let c = node?.firstChild; c; c = c.nextSibling) out.push(c.name);
  return out;
}

function find(tree: Tree, name: string) {
  let found: ReturnType<Tree["resolve"]> | null = null;
  tree.iterate({ enter: (n) => (found || n.name !== name ? undefined : ((found = n.node), false)) });
  return found as ReturnType<Tree["resolve"]> | null;
}

/** The names of the top-level blocks of a page. */
function top(text: string): string[] {
  const out: string[] = [];
  for (let c = page.parse(text).topNode.firstChild; c; c = c.nextSibling) out.push(c.name);
  return out;
}

describe("front matter", () => {
  const fm = "---\ntype: concept\ntitle: Foo\n---\n\nbody";

  it("is one node with its two fences and its YAML", () => {
    expect(top(fm)).toEqual(["FrontMatter", "Paragraph"]);
    expect(children(fm, "FrontMatter")).toEqual(["FrontMatterMark", "FrontMatterContent", "FrontMatterMark"]);
    expect(texts(fm, "FrontMatter")).toEqual(["---\ntype: concept\ntitle: Foo\n---"]);
    expect(texts(fm, "FrontMatterContent")).toEqual(["type: concept\ntitle: Foo"]);
  });

  it("closes on `...` too, and may be empty", () => {
    expect(texts("---\na: 1\n...\nx", "FrontMatter")).toEqual(["---\na: 1\n..."]);
    expect(top("---\n---\nx")).toEqual(["FrontMatter", "Paragraph"]);
    expect(children("---\n---\nx", "FrontMatter")).toEqual(["FrontMatterMark", "FrontMatterMark"]);
  });

  it("is front matter only on the first line, and only when something closes it", () => {
    expect(top("x\n---\na: 1\n---\n")).not.toContain("FrontMatter");
    expect(top("\n---\na: 1\n---\n")).not.toContain("FrontMatter");
    expect(top("---\na: 1\nno end")).toEqual(["HorizontalRule", "Paragraph"]);
    // A cut `----` is not a fence.
    expect(top("---\na: 1\n----\nx")).not.toContain("FrontMatter");
  });

  it("finds a closing fence far below the first look-ahead", () => {
    const long = `---\n${"k: v\n".repeat(5000)}---\nbody`;
    expect(top(long)).toEqual(["FrontMatter", "Paragraph"]);
  });

  it("does not read a quoted or listed `---` as front matter", () => {
    expect(top("> ---\n> a\n> ---")).toEqual(["Blockquote"]);
    expect(texts("> ---\n> a\n> ---", "FrontMatter")).toEqual([]);
  });

  it("agrees with frontmatterEnd on where the front matter ends", () => {
    const piece = fc.constantFrom("---", "...", "a: 1", "", "text", "- x", "--- ", "----", "> ---");
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 8 }), (lines) => {
        const text = lines.join("\n");
        const end = frontmatterEnd(lines);
        const nodes = texts(text, "FrontMatter");
        if (end < 0) return nodes.length === 0;
        return nodes.length === 1 && nodes[0] === lines.slice(0, end + 1).join("\n").trimEnd();
      }),
      runs(300),
    );
  });

  it("frontMatterLength is where the closing line ends", () => {
    expect(frontMatterLength("---\na\n---\nb")).toBe(9);
    expect(frontMatterLength("---\na\n")).toBe(-1);
  });
});

describe("callouts", () => {
  it("are a quote that starts with a marker", () => {
    const text = "> [!NOTE]\n> text\n\nafter";
    expect(top(text)).toEqual(["Callout", "Paragraph"]);
    expect(children(text, "Callout")).toEqual(["QuoteMark", "CalloutMark", "QuoteMark", "Paragraph"]);
    expect(texts(text, "CalloutMark")).toEqual(["[!NOTE]"]);
    expect(texts(text, "Callout")).toEqual(["> [!NOTE]\n> text"]);
  });

  it("come in five kinds, in any case", () => {
    for (const kind of ["NOTE", "tip", "Important", "WARNING", "caution"]) {
      const text = `> [!${kind}]\n> x`;
      expect(top(text)).toEqual(["Callout"]);
      expect(calloutKindOf(texts(text, "CalloutMark")[0]!)).toBe(kind.toLowerCase());
    }
    expect(calloutKindOf("[!NOPE]")).toBeNull();
  });

  it("are a plain quote when the marker is not alone on its line, or not first, or not one of the five", () => {
    expect(top("> [!NOTE] title\n> x")).toEqual(["Blockquote"]);
    expect(top("> text\n> [!NOTE]")).toEqual(["Blockquote"]);
    expect(top("> [!INFO]\n> x")).toEqual(["Blockquote"]);
    expect(top("    > [!NOTE]")).toEqual(["CodeBlock"]);
  });

  // Today's tree makes the quote one paragraph and one list, with no way to tell a callout from a quote.
  it("hold a list: the callout is a node, and the items are its children", () => {
    const text = "> [!TIP]\n> - one\n> - two\n\nafter";
    expect(top(text)).toEqual(["Callout", "Paragraph"]);
    expect(top(text.replace("[!TIP]", "[!INFO]"))).toEqual(["Blockquote", "Paragraph"]);
    const callout = find(page.parse(text), "Callout")!;
    const list = callout.getChild("BulletList")!;
    expect(list.getChildren("ListItem")).toHaveLength(2);
    expect(text.slice(list.from, list.to)).toBe("- one\n> - two");
    expect(before.parse(text).topNode.firstChild!.name).toBe("Blockquote");
  });

  it("end where the quote ends, and keep a lazy line", () => {
    expect(texts("> [!NOTE]\n> a\nlazy\n\nb", "Callout")).toEqual(["> [!NOTE]\n> a\nlazy"]);
    expect(top("> [!NOTE]\nplain")).toEqual(["Callout", "Paragraph"]);
  });

  it("nest in lists and quotes, and hold fences", () => {
    expect(texts("- item\n  > [!NOTE]\n  > x\n- next", "Callout")).toEqual(["> [!NOTE]\n  > x"]);
    expect(texts("> outer\n>\n> > [!WARNING]\n> > deep", "Callout")).toEqual(["> [!WARNING]\n> > deep"]);
    const fenced = "> [!NOTE]\n> ```js\n> let x\n> ```";
    expect(find(page.parse(fenced), "Callout")!.getChild("FencedCode")).not.toBeNull();
  });
});

describe("footnotes", () => {
  // Today's tree makes the continuation an indented code block after the definition's paragraph.
  it("a definition with a continuation line is one node", () => {
    const text = "[^1]: first\n    second\n\n[^2]: other";
    expect(top(text)).toEqual(["FootnoteDefinition", "FootnoteDefinition"]);
    expect(texts(text, "FootnoteDefinition")).toEqual(["[^1]: first\n    second", "[^2]: other"]);
    expect(texts(text, "FootnoteLabel")).toEqual(["[^1]:", "[^2]:"]);
    expect(before.parse(text).topNode.getChildren("FootnoteDefinition")).toHaveLength(0);
  });

  it("holds more paragraphs, after a blank line, when they are indented", () => {
    const text = "[^1]: first\n\n    second para\n\nback to the page";
    expect(top(text)).toEqual(["FootnoteDefinition", "Paragraph"]);
    expect(find(page.parse(text), "FootnoteDefinition")!.getChildren("Paragraph")).toHaveLength(2);
  });

  it("holds a lazy line, and a new definition ends the one above it", () => {
    expect(texts("[^1]: a\nlazy\n[^2]: b", "FootnoteDefinition")).toEqual(["[^1]: a\nlazy", "[^2]: b"]);
  });

  it("is not a definition when indented like code or without an id", () => {
    expect(top("    [^1]: x")).toEqual(["CodeBlock"]);
    expect(top("[^]: x")).not.toContain("FootnoteDefinition");
    expect(top("[^a b]: x")).not.toContain("FootnoteDefinition");
  });

  it("references are inline nodes, not in code, not the label of a definition", () => {
    const text = "see[^1] and [^note-2], `[^3]`, [^ no]\n\n[^1]: def";
    expect(texts(text, "FootnoteReference")).toEqual(["[^1]", "[^note-2]"]);
  });
});

describe("math", () => {
  // Today a blank line ends the paragraph, so the block is two paragraphs with a `$$` in each.
  it("a `$$` block with a blank line inside is one node", () => {
    const text = "$$\na = b\n\nc = d\n$$\n\nafter";
    expect(top(text)).toEqual(["MathBlock", "Paragraph"]);
    expect(texts(text, "MathBlock")).toEqual(["$$\na = b\n\nc = d\n$$"]);
    expect(children(text, "MathBlock")).toEqual(["MathMark", "MathText", "MathMark"]);
    expect(texts(text, "MathText")).toEqual(["a = b\n\nc = d"]);
    expect(before.parse(text).topNode.getChildren("MathBlock")).toHaveLength(0);
  });

  it("is one line when written as `$$tex$$`", () => {
    expect(texts("$$x^2$$\nnext", "MathBlock")).toEqual(["$$x^2$$"]);
    expect(texts("$$x^2$$\nnext", "MathText")).toEqual(["x^2"]);
  });

  it("interrupts a paragraph", () => {
    expect(top("text\n$$\nx\n$$")).toEqual(["Paragraph", "MathBlock"]);
  });

  it("is not markup inside: emphasis and links are TeX", () => {
    const names: string[] = [];
    page.parse("$$\na *b* c [d](e)\n$$").iterate({ enter: (n) => void names.push(n.name) });
    expect(names).not.toContain("Emphasis");
    expect(names).not.toContain("Link");
  });

  it("an unclosed block runs to the end of what holds it, with one mark", () => {
    const text = "$$\nx\n\ny";
    expect(top(text)).toEqual(["MathBlock"]);
    expect(children(text, "MathBlock")).toEqual(["MathMark", "MathText"]);
    expect(texts("> $$\n> x\n\nafter", "MathBlock")).toEqual(["$$\n> x"]);
    expect(top("> $$\n> x\n\nafter")).toEqual(["Blockquote", "Paragraph"]);
  });

  it("lives in a quote, with its markers, and in a list item", () => {
    const quoted = "> $$\n> a\n>\n> b\n> $$\n\nafter";
    expect(top(quoted)).toEqual(["Blockquote", "Paragraph"]);
    expect(find(page.parse(quoted), "MathBlock")!.getChildren("MathMark")).toHaveLength(2);
    // The quote's markers split the text, and nothing else is in the way.
    expect(texts(quoted, "MathText").filter((t) => /\S/.test(t))).toEqual(["a\n", "b"]);
    const listed = "- item\n  $$\n  a\n\n  b\n  $$\n- next";
    expect(top(listed)).toEqual(["BulletList"]);
    expect(texts(listed, "MathBlock")).toEqual(["$$\n  a\n\n  b\n  $$"]);
  });

  it("is code when indented four spaces", () => {
    expect(top("    $$\n    x\n    $$")).toEqual(["CodeBlock"]);
  });

  it("inline math follows the rules of the page", () => {
    const math = (t: string) => texts(t, "InlineMath");
    expect(math("a $x^2$ b")).toEqual(["$x^2$"]);
    expect(math("a $`x_1`$ b")).toEqual(["$`x_1`$"]);
    expect(math("costs $5 and $6")).toEqual([]);
    expect(math("$ x$ and $x $")).toEqual([]);
    expect(math("a$b$c")).toEqual([]);
    expect(math("`$x$`")).toEqual([]);
    expect(math("\\$x$")).toEqual([]);
    expect(math("$a_b$ and *c*")).toEqual(["$a_b$"]);
    expect(children("a $x$ b", "InlineMath")).toEqual(["MathMark", "MathMark"]);
  });
});

describe("the editor's language", () => {
  it("reads the page with these nodes, and the YAML of the front matter with the YAML parser", () => {
    const state = EditorState.create({ doc: "---\ntype: concept\n---\n> [!NOTE]\n> x\n\n$$\na\n\nb\n$$", extensions: [markdown({ extensions: [GFM, noSetext, tessela, frontMatterYaml] })] });
    const names = new Set<string>();
    ensureSyntaxTree(state, state.doc.length, 5000)!.iterate({ enter: (n) => void names.add(n.name) });
    for (const name of ["FrontMatter", "Stream", "Callout", "CalloutMark", "MathBlock"]) expect(names).toContain(name);
  });
});

describe("the whole parser", () => {
  const piece = fc.constantFrom(
    "---", "...", "a: 1", "> ", "> [!NOTE]", "> [!TIP]", "- ", "  ", "    ", "$$", "$x$", "$$x$$", "[^1]: ", "[^1]", "text", "`", "```", "*", "",
    "# h", "|a|b|", "\t", "1. ", "\\",
  );
  const lineArb = fc.array(piece, { maxLength: 4 }).map((p) => p.join(""));
  const pages = fc.array(lineArb, { maxLength: 12 }).map((l) => l.join("\n"));

  /** Every node lies inside its parent, and its children come in order without overlap. */
  function wellFormed(tree: Tree): boolean {
    let ok = true;
    tree.iterate({
      enter: (n) => {
        let end = n.from;
        for (let c = n.node.firstChild; c; c = c.nextSibling) {
          if (c.from < end || c.to > n.to || c.to < c.from) ok = false;
          end = c.to;
        }
      },
    });
    return ok;
  }

  it("builds a well-formed tree for any page", () => {
    fc.assert(
      fc.property(pages, (text) => {
        const tree = page.parse(text);
        return tree.length === text.length && wellFormed(tree);
      }),
      runs(500),
    );
  });

  it("a math block is always opened by a mark, a callout always carries its marker", () => {
    fc.assert(
      fc.property(pages, (text) => {
        const tree = page.parse(text);
        let ok = true;
        tree.iterate({
          enter: (n) => {
            if (n.name === "MathBlock" && n.node.firstChild?.name !== "MathMark") ok = false;
            if (n.name === "Callout" && n.node.getChild("CalloutMark") === null) ok = false;
            if (n.name === "FootnoteDefinition" && n.node.firstChild?.name !== "FootnoteLabel") ok = false;
          },
        });
        return ok;
      }),
      runs(500),
    );
  });

  it("reading again after an edit gives the tree of reading from scratch", () => {
    const edit = fc.tuple(pages, fc.nat(60), fc.nat(10), fc.constantFrom("", "---", "\n---\n", "$$", "\n$$\n", "> [!NOTE]\n", "[^1]: x", "    ", "\n\n"));
    fc.assert(
      fc.property(edit, ([text, at, cut, insert]) => {
        const from = Math.min(at, text.length);
        const to = Math.min(from + cut, text.length);
        const next = text.slice(0, from) + insert + text.slice(to);
        const first = page.parse(text);
        const fragments = TreeFragment.applyChanges(TreeFragment.addTree(first), [{ fromA: from, toA: to, fromB: from, toB: from + insert.length }]);
        const again = page.parse(next, fragments);
        return again.toString() === page.parse(next).toString();
      }),
      runs(500),
    );
  });
});
