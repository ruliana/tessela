import { describe, expect, it } from "vitest";

import { foldAround, foldables, foldsOnLoad, foldsToRemember, zoomAt } from "../src/shared/folds";

const lines = (text: string) => text.split("\n");

describe("foldables", () => {
  it("folds a heading with its section, a list item with what is nested in it, and a paragraph's list", () => {
    const l = lines(["# One", "Intro:", "- a", "  - b", "- c", "", "## Two", "text", "", "# Three", "x"].join("\n"));
    const f = foldables(l);
    expect(f.map((x) => [x.key, x.line, x.last, x.depth])).toEqual([
      ["heading:# One#0", 0, 7, 0],
      ["para:Intro:#0", 1, 4, 1],
      ["item:- a#0", 2, 3, 2],
      ["heading:## Two#0", 6, 7, 1],
      ["heading:# Three#0", 9, 10, 0],
    ]);
  });

  it("leaves out blocks with nothing under them, and the front matter", () => {
    expect(foldables(lines("---\ntype: concept\n---\n\n# Empty\n\n# Also empty\n"))).toEqual([]);
  });

  it("folds the continuation of a wrapped item, and a paragraph folds only the list under it", () => {
    const f = foldables(lines("- one\n  more of one\n- two\n\nHello\nstill hello\n- x"));
    expect(f.map((x) => [x.line, x.last])).toEqual([
      [0, 1],
      [5, 6],
    ]);
  });

  it("tells equal lines apart by their order, so a changed line opens its fold", () => {
    const f = foldables(lines("- a\n  - x\n- a\n  - y"));
    expect(f.map((x) => x.key)).toEqual(["item:- a#0", "item:- a#1"]);
  });

  it("finds the block around a line, the next one up when asked", () => {
    const f = foldables(lines("- a\n  - b\n    - c\n- d"));
    expect(foldAround(f, 2)?.line).toBe(1);
    expect(foldAround(f, 2, 1)?.line).toBe(0);
    expect(foldAround(f, 3)).toBeNull();
  });
});

describe("code fences", () => {
  const page = lines("# A\n\n```js\nlet x;\n```\n\n```mermaid\ngraph TD\n```\n\n```tessela\nquery\n```\n\n```mermaid\nunclosed");

  it("folds a fence from its first line to its last, and one that runs folds by itself once it is closed", () => {
    expect(foldables(page).filter((f) => f.line > 0).map((f) => [f.line, f.last, f.auto])).toEqual([
      [2, 4, false],
      [6, 8, true],
      [10, 12, true],
      [14, 15, false],
    ]);
  });

  it("starts a page with its running fences folded, and remembers only what was changed from that", () => {
    const folds = foldables(page);
    const auto = folds.filter((f) => f.auto);
    expect(foldsOnLoad(folds, [])).toEqual(auto);
    expect(foldsToRemember(folds, (f) => f.auto)).toEqual([]);
    // The first one opened by hand, an ordinary fence folded by hand.
    const plain = folds.find((f) => f.key === "fence:```js#0")!;
    const kept = foldsToRemember(folds, (f) => f === plain || f === auto[1]);
    expect(kept).toEqual(["fence:```js#0", "-fence:```mermaid#0"]);
    expect(foldsOnLoad(folds, kept)).toEqual([plain, auto[1]]);
  });
});

describe("zoomAt", () => {
  const page = lines(["# Top", "", "## Part", "", "- a", "  - b", "    - c", "- d", "", "## Other", "x"].join("\n"));

  it("shows an item with what it owns, and the way back: headings, then the items around it", () => {
    expect(zoomAt(page, 6)).toEqual({
      start: 6,
      end: 6,
      trail: [
        { line: 0, text: "Top" },
        { line: 2, text: "Part" },
        { line: 4, text: "a" },
        { line: 5, text: "b" },
      ],
    });
    expect(zoomAt(page, 4)?.end).toBe(6);
  });

  it("shows a heading's whole section, under the headings above it", () => {
    expect(zoomAt(page, 2)).toEqual({ start: 2, end: 7, trail: [{ line: 0, text: "Top" }] });
    expect(zoomAt(page, 9)).toEqual({ start: 9, end: 10, trail: [{ line: 0, text: "Top" }] });
    expect(zoomAt(page, 0)).toEqual({ start: 0, end: 10, trail: [] });
  });

  it("has nothing to zoom on a blank line", () => {
    expect(zoomAt(page, 3)).toBeNull();
  });
});
