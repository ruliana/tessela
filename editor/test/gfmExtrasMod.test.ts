import { describe, expect, it } from "vitest";

import { asQuote, calloutKind, displayMath, footnoteRefs, footnotesOf, headingLink, inlineMath, nextLabel, pageTitle } from "../src/mods/gfm-extras/plan";

describe("the gfm-extras mod's reading of a page", () => {
  it("knows the five callout markers, in any case, and nothing else", () => {
    expect(calloutKind("> [!NOTE]")).toBe("note");
    expect(calloutKind(">[!warning]  ")).toBe("warning");
    expect(calloutKind("> [!CAUTION] and text")).toBeNull();
    expect(calloutKind("> [!DANGER]")).toBeNull();
    expect(calloutKind("[!NOTE]")).toBeNull();
  });

  it("numbers footnotes by their first reference and keeps the definitions' text", () => {
    const lines = ["B[^b] a[^a] again[^b].", "", "[^a]: Note A", "    goes on.", "[^b]: Note B", "[^orphan]: nobody cites me"];
    const f = footnotesOf(lines);
    expect([...f.numbers]).toEqual([["b", 1], ["a", 2]]);
    expect(f.defs.get("a")).toEqual({ line: 2, text: "Note A goes on." });
    expect(f.first.get("a")).toBe(0);
    expect(footnoteRefs("[^a]: text with [^b]").map((r) => r.id)).toEqual(["b"]);
    expect(nextLabel(lines)).toBe("1");
    expect(nextLabel(["[^1]", "[^2]: x"])).toBe("3");
  });

  it("finds inline math, but not prices or code", () => {
    expect(inlineMath("Cost $5 and $6, then $a+b$.").map((m) => m.tex)).toEqual(["a+b"]);
    expect(inlineMath("GitHub's $`x_1`$ form").map((m) => m.tex)).toEqual(["x_1"]);
    expect(inlineMath("code `$x$` is not math").length).toBe(0);
    expect(inlineMath("escaped \\$x\\$ too").length).toBe(0);
  });

  it("finds $$ blocks on one line and across lines, not inside code", () => {
    const lines = ["$$ a^2 $$", "text", "$$", "\\frac{1}{2}", "$$", "```", "$$", "```"];
    expect(displayMath(lines, (i) => i >= 5)).toEqual([
      { from: 0, to: 0, tex: "a^2" },
      { from: 2, to: 4, tex: "\\frac{1}{2}" },
    ]);
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
