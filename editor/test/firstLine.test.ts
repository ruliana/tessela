// Typing on the first line of a page must not turn the front matter into a heading.

import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { GFM } from "@lezer/markdown";
import { describe, expect, it } from "vitest";

import { noSetext } from "../src/shared/blocks";
import { frontMatterGuard } from "../src/renderer/livePreview";

/** The node names of the page's tree, the way the editor's language builds it (editor.ts). */
function nodes(text: string): string[] {
  const state = EditorState.create({
    doc: text,
    extensions: [yamlFrontmatter({ content: markdown({ extensions: [GFM, noSetext] }) })],
  });
  const names: string[] = [];
  ensureSyntaxTree(state, state.doc.length, 5000)!.iterate({ enter: (n) => void names.push(n.name) });
  return names;
}

// What `tessela add` writes for a new page.
const page = '---\ntype: concept\ntitle: "Foo"\n---\n\n';

describe("no setext headings", () => {
  it("text in front of the front matter is not a heading", () => {
    const names = nodes("hello" + page);
    expect(names.filter((n) => n.includes("Heading"))).toEqual([]);
  });

  it("text under the front matter is a paragraph, and # still makes a heading", () => {
    expect(nodes(page + "hello")).toContain("Paragraph");
    expect(nodes(page + "# hello")).toContain("ATXHeading1");
  });

  it("a line of dashes under text is a rule", () => {
    expect(nodes("hello\n---\n")).toContain("HorizontalRule");
  });
});

describe("the caret and the front matter", () => {
  // Line 1 `---`, 2 `type`, 3 `title`, 4 `---`, 5 blank, 6 the body.
  const start = (head: number) => EditorState.create({ doc: page + "body", selection: { anchor: head }, extensions: [frontMatterGuard()] });
  const bodyHead = (page + "body").length;

  it("sends a caret moved up from the body to the first property", () => {
    const state = start(bodyHead).update({ selection: { anchor: 0 }, userEvent: "select" }).state;
    expect(state.selection.main.head).toBe(state.doc.line(2).to);
  });

  it("does the same for the closing ---", () => {
    const from = start(bodyHead);
    const state = from.update({ selection: { anchor: from.doc.line(4).to }, userEvent: "select" }).state;
    expect(state.selection.main.head).toBe(state.doc.line(2).to);
  });

  it("lets the caret move inside the front matter once it is there", () => {
    const state = start(start(bodyHead).doc.line(2).to).update({ selection: { anchor: 0 }, userEvent: "select" }).state;
    expect(state.selection.main.head).toBe(0);
  });

  it("leaves a caret that is not the user's alone: a page opened at line 1", () => {
    const state = start(bodyHead).update({ selection: { anchor: 0 } }).state;
    expect(state.selection.main.head).toBe(0);
  });

  it("leaves a selection alone, and a page without front matter", () => {
    const sel = start(bodyHead).update({ selection: { anchor: 0, head: 5 }, userEvent: "select" }).state;
    expect(sel.selection.main.from).toBe(0);
    const plain = EditorState.create({ doc: "a\nb\nc", selection: { anchor: 4 }, extensions: [frontMatterGuard()] });
    expect(plain.update({ selection: { anchor: 0 }, userEvent: "select" }).state.selection.main.head).toBe(0);
  });
});
