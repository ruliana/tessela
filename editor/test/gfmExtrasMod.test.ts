import { describe, expect, it } from "vitest";

import { asQuote, headingLink, nextLabel, numberFootnotes, pageTitle } from "../src/mods/gfm-extras/plan";

describe("footnote numbers", () => {
  const ref = (id: string, from: number) => ({ id, from, to: from + id.length + 3 });
  const def = (id: string, from: number, text = "") => ({ id, from, label: { from, to: from + id.length + 4 }, text });

  it("are given by the first reference, and the definitions and first references are found by label", () => {
    const f = numberFootnotes([ref("b", 1), ref("a", 10), ref("b", 20)], [def("a", 30, "Note A goes on."), def("b", 50, "Note B"), def("orphan", 70)]);
    expect([...f.numbers]).toEqual([["b", 1], ["a", 2]]);
    expect(f.first.get("a")).toBe(10);
    expect(f.defs.get("a")?.text).toBe("Note A goes on.");
  });

  it("take the first definition of a label that is defined twice", () => {
    expect(numberFootnotes([ref("a", 0)], [def("a", 10, "first"), def("a", 30, "second")]).defs.get("a")?.text).toBe("first");
  });

  it("pick the smallest number that no label uses for the next one", () => {
    expect(nextLabel([])).toBe("1");
    expect(nextLabel(["1", "2", "x"])).toBe("3");
    expect(nextLabel(["2"])).toBe("1");
  });
});

describe("what the copy commands write", () => {
  const page = ["---", "title: My page", "---", "", "# Top", "text", "## Fast, and loose!", "a", "## Fast, and loose!", "b"];

  it("links the heading the line is under, telling repeated headings apart as GitHub does", () => {
    expect(headingLink(page, 7, "dir/my-page.md")).toBe("[Fast, and loose!](/dir/my-page.md#fast-and-loose)");
    expect(headingLink(page, 9, "dir/my-page.md")).toBe("[Fast, and loose!](/dir/my-page.md#fast-and-loose-1)");
    expect(headingLink(["text", "# A"], 0, "p.md")).toBeNull();
  });

  it("names a page by its title, then its first heading, then its file", () => {
    expect(pageTitle(page, "x.md")).toBe("My page");
    expect(pageTitle(["# Heading", "x"], "x.md")).toBe("Heading");
    expect(pageTitle(["x"], "notes/big-idea.md")).toBe("big idea");
  });

  it("makes a quote with a source line", () => {
    expect(asQuote("one\n\ntwo\n", "T", "a/t.md")).toBe("> one\n>\n> two\n>\n> — [T](/a/t.md)\n");
  });
});
