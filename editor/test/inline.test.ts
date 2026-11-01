import { describe, expect, it } from "vitest";

import { inlineParts } from "../src/shared/inline";

describe("inlineParts", () => {
  it("cuts text, tags and links apart", () => {
    expect(inlineParts("Decide for [Tessela](/tessela.md) with #agents now")).toEqual([
      { kind: "text", text: "Decide for " },
      { kind: "link", text: "Tessela", dest: "/tessela.md" },
      { kind: "text", text: " with " },
      { kind: "tag", text: "#agents" },
      { kind: "text", text: " now" },
    ]);
  });

  it("handles code, bold, italic and strike", () => {
    expect(inlineParts("`a` **b** *c* ~~d~~").map((p) => p.kind)).toEqual(["code", "text", "bold", "text", "italic", "text", "strike"]);
  });

  it("does not take a heading anchor or a hash in a word for a tag", () => {
    expect(inlineParts("see page#anchor and C#").every((p) => p.kind === "text")).toBe(true);
  });

  it("shows a picture as its description", () => {
    expect(inlineParts("![a map](map.png)")).toEqual([{ kind: "text", text: "a map" }]);
  });
});
