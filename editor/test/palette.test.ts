import { describe, expect, it } from "vitest";

import { candidates, rank, score } from "../src/shared/palette";

describe("score", () => {
  it("ranks an exact match over a prefix over a word start over the middle", () => {
    const s = (label: string) => score(label, "rust");
    expect(s("rust")).toBeGreaterThan(s("rust-lang")!);
    expect(s("rust-lang")).toBeGreaterThan(s("project/rust")!);
    expect(s("project/rust")).toBeGreaterThan(s("trusty")!);
    expect(s("trusty")).toBeGreaterThan(s("r-u-s-t")!);
    expect(s("python")).toBeNull();
  });

  it("matches everything for an empty query", () => {
    expect(score("anything", "  ")).not.toBeNull();
  });
});

describe("rank", () => {
  it("sorts by score and keeps the given order for ties", () => {
    const items = [{ label: "b-rust" }, { label: "rust" }, { label: "a-rust" }, { label: "go" }];
    expect(rank(items, "rust", 10).map((i) => i.label)).toEqual(["rust", "b-rust", "a-rust"]);
    expect(rank(items, "rust", 2)).toHaveLength(2);
  });
});

describe("candidates", () => {
  it("lists pages and unwritten concepts once", () => {
    const pages = [
      { id: "rust", path: "rust.md" },
      { id: "journals/2026-11-01", path: "journals/2026-11-01.md" },
    ];
    const vocab = [
      { concept: "rust", has_page: true, mentions: 3, pages: 1, deprecated: false, use_instead: null, note: null },
      { concept: "later", has_page: false, mentions: 1, pages: 1, deprecated: false, use_instead: null, note: null },
      { concept: "journals/2026-11-01", has_page: false, mentions: 1, pages: 1, deprecated: false, use_instead: null, note: null },
    ];
    expect(candidates(pages, vocab)).toEqual([
      { label: "rust", path: "rust.md", unwritten: false },
      { label: "journals/2026-11-01", path: "journals/2026-11-01.md", unwritten: false },
      { label: "later", path: "later.md", unwritten: true },
    ]);
  });
});
