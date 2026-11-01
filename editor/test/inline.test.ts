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

  it("makes a date in plain text a part of its own", () => {
    expect(inlineParts("Met on 2026-10-27 about #agents")).toEqual([
      { kind: "text", text: "Met on " },
      { kind: "date", text: "2026-10-27", day: "2026-10-27" },
      { kind: "text", text: " about " },
      { kind: "tag", text: "#agents" },
    ]);
    expect(inlineParts("at 2026-10-27 09:00:00-03:00")[1]).toEqual({ kind: "date", text: "2026-10-27 09:00:00-03:00", day: "2026-10-27" });
  });

  it("leaves dates in code, links and addresses as they are", () => {
    expect(inlineParts("`2026-10-27`").map((p) => p.kind)).toEqual(["code"]);
    expect(inlineParts("[2026-10-27](/journals/2026-10-27.md)").map((p) => p.kind)).toEqual(["link"]);
    expect(inlineParts("https://a.b/2026-10-27").map((p) => p.kind)).toEqual(["text"]);
  });

  it("shows a picture as its description", () => {
    expect(inlineParts("![a map](map.png)")).toEqual([{ kind: "text", text: "a map" }]);
  });
});
