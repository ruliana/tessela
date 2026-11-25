import { describe, expect, it } from "vitest";

import { followed, present, readList, toggled } from "../src/mods/favorites/plan";

describe("the favorites list", () => {
  it("marks a page last and unmarks it on the second time", () => {
    expect(toggled(["a.md"], "b.md")).toEqual(["a.md", "b.md"]);
    expect(toggled(["a.md", "b.md"], "a.md")).toEqual(["b.md"]);
  });

  it("follows a page that moved, keeps its place, and drops one that was deleted", () => {
    expect(followed(["a.md", "b.md", "c.md"], "b.md", "x/b.md")).toEqual(["a.md", "x/b.md", "c.md"]);
    expect(followed(["a.md", "b.md"], "a.md", null)).toEqual(["b.md"]);
    // Moving onto a page that is already a favorite leaves one of them.
    expect(followed(["a.md", "b.md"], "a.md", "b.md")).toEqual(["b.md"]);
  });

  it("hides what is no longer on disk without forgetting it, and reads only paths from what was saved", () => {
    expect(present(["a.md", "gone.md", "b.md"], ["b.md", "a.md"])).toEqual(["a.md", "b.md"]);
    expect(readList(["a.md", 3, "", "a.md", null, "b.md"])).toEqual(["a.md", "b.md"]);
    expect(readList({ not: "a list" })).toEqual([]);
  });
});
