// The heading path of a position: examples of the rules, and properties against the page model's sections.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { headingCrumbs, headingPath } from "../src/shared/headingPath";
import { modelOf } from "./support/page";
import { page, pageWithExtras } from "./support/pages";
import { runs } from "./support/props";

const path = (text: string, at: string | number) =>
  headingPath(modelOf(text), typeof at === "number" ? at : text.indexOf(at)).map((n) => n.label);

describe("headingPath", () => {
  const text = "---\ntype: concept\n---\n\nintro\n\n# Project\n\nabout\n\n## Design\n\ndesign text\n\n### Risks\n\nrisk text\n\n## Plan\n\nplan text\n\n# Other\n\nlast\n";

  it("is the headings you are under, the outermost first", () => {
    expect(path(text, "risk text")).toEqual(["Project", "Design", "Risks"]);
    expect(path(text, "design text")).toEqual(["Project", "Design"]);
    expect(path(text, "plan text")).toEqual(["Project", "Plan"]);
    expect(path(text, "last")).toEqual(["Other"]);
  });

  it("includes the heading the position is on, from its first character on", () => {
    expect(path(text, "## Design")).toEqual(["Project", "Design"]);
    expect(path(text, text.indexOf("### Risks") + 2)).toEqual(["Project", "Design", "Risks"]);
  });

  it("is empty above the first heading and in the front matter", () => {
    expect(path(text, "intro")).toEqual([]);
    expect(path(text, "type:")).toEqual([]);
    expect(path("no headings at all\n", 3)).toEqual([]);
  });

  it("stays under a heading through the blank lines that follow it, and ends where a heading as high begins", () => {
    expect(path("# A\n\ntext\n\n\n\n## B\n", 12)).toEqual(["A"]);
    expect(path("# A\n## B\ntext\n\n\n# C\n", 12)).toEqual(["A", "B"]);
    expect(path("# A\n## B\ntext\n\n\n# C\n", 20)).toEqual(["C"]);
  });

  it("ignores a `#` line that is text in an item or a fence, and lets a deeper heading stand alone", () => {
    expect(path("# A\n\n- x\n  # not a heading\n\n```\n# nor this\n```\n", "nor this")).toEqual(["A"]);
    expect(path("### Low\n\ntext\n", "text")).toEqual(["Low"]);
  });

  it("writes a heading as plain text, without its marks", () => {
    const text = "# **Bold** and [a link](/x.md) `code`\n\ntext\n";
    expect(headingCrumbs(modelOf(text), text.indexOf("text"))).toEqual([{ text: "Bold and a link code", from: 0 }]);
  });
});

describe("headingPath, on any page", () => {
  const anyPage = fc.oneof(page, pageWithExtras);

  it("is a chain of sections: each holds the next, and the levels go down", () => {
    fc.assert(
      fc.property(anyPage, fc.nat(), (text, n) => {
        const model = modelOf(text);
        const p = headingPath(model, n % (text.length + 1));
        for (let i = 1; i < p.length; i++) {
          expect(p[i]!.kind).toBe("section");
          expect(p[i]!.parent).toBe(p[i - 1]);
          expect(p[i]!.level).toBeGreaterThan(p[i - 1]!.level);
        }
        if (p.length > 0) expect(p[0]!.kind).toBe("section");
      }),
      runs(150),
    );
  });

  it("ends in the nearest heading above the position: no section starts between it and the position", () => {
    fc.assert(
      fc.property(anyPage, fc.nat(), (text, n) => {
        const model = modelOf(text);
        const pos = n % (text.length + 1);
        const p = headingPath(model, pos);
        const before = model.nodes.filter((s) => s.kind === "section" && s.from <= pos);
        expect(p.at(-1) ?? null).toBe(before.at(-1) ?? null);
      }),
      runs(150),
    );
  });

  it("holds for every position inside a section's own text: the section is on the path", () => {
    fc.assert(
      fc.property(anyPage, fc.nat(), (text, n) => {
        const model = modelOf(text);
        const sections = model.nodes.filter((s) => s.kind === "section");
        fc.pre(sections.length > 0);
        const s = sections[n % sections.length]!;
        const pos = s.from + (n % (s.to - s.from + 1));
        expect(headingPath(model, pos)).toContain(s);
      }),
      runs(150),
    );
  });
});
