import { describe, expect, it } from "vitest";

import { headingAt, headings, matching, moveSection } from "../src/mods/outline/plan";

const PAGE = ["# Plan", "", "Intro.", "", "## Goals", "", "Goal text.", "", "## Risks", "", "Risk text.", "", "# Notes", "", "Note text."];

describe("the outline mod's headings", () => {
  it("lists the # headings of the page, and not those in code, quotes or lists", () => {
    const lines = ["---", "type: concept", "---", "", "# Real", "", "```sh", "# no", "```", "", "> # quoted", "", "- # in a list", "", "### Deep ###"];
    expect(headings(lines)).toEqual([
      { line: 4, level: 1, text: "Real" },
      { line: 14, level: 3, text: "Deep" },
    ]);
  });

  it("finds the heading a line is under, and filters by words in any order", () => {
    const list = headings(PAGE);
    expect(headingAt(list, 6)?.text).toBe("Goals");
    expect(headingAt(list, 0)?.text).toBe("Plan");
    expect(headingAt(headings(["text", "# A"]), 0)).toBeNull();
    expect(matching(list, "ris").map((h) => h.text)).toEqual(["Risks"]);
    expect(matching(list, "").length).toBe(4);
  });
});

describe("moving a section", () => {
  it("swaps it with the next one of its level, keeping the blank lines where they were", () => {
    const moved = moveSection(PAGE, 4, "down")!;
    expect(moved.lines).toEqual(["# Plan", "", "Intro.", "", "## Risks", "", "Risk text.", "", "## Goals", "", "Goal text.", "", "# Notes", "", "Note text."]);
    expect(moved.shift).toBe(4);
    expect(moveSection(moved.lines, 8, "up")!.lines).toEqual(PAGE);
  });

  it("takes the sections under it along, and keeps the end of the page as it was", () => {
    const moved = moveSection(PAGE, 0, "down")!;
    expect(moved.lines).toEqual(["# Notes", "", "Note text.", "", "# Plan", "", "Intro.", "", "## Goals", "", "Goal text.", "", "## Risks", "", "Risk text."]);
    expect(moved.lines.length).toBe(PAGE.length);
  });

  it("does not move a section out of its parent, or a line that is not a heading", () => {
    expect(moveSection(PAGE, 4, "up")).toBeNull();
    expect(moveSection(PAGE, 8, "down")).toBeNull();
    expect(moveSection(PAGE, 0, "up")).toBeNull();
    expect(moveSection(PAGE, 2, "down")).toBeNull();
  });
});
