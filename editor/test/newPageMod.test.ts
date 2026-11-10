import { describe, expect, it } from "vitest";

import { kindsFrom, moveChoice } from "../src/mods/new-page/plan";

const entry = (name: string, description?: string, type = "template") => ({ path: `templates/${name}.md`, type, description });

describe("the new-page mod's types", () => {
  it("lists Page first, then the templates by name, each with its description", () => {
    expect(kindsFrom([entry("person"), entry("meeting", "Notes of a talk")])).toEqual([
      { type: "concept", label: "Page" },
      { type: "meeting", label: "meeting", description: "Notes of a talk" },
      { type: "person", label: "person" },
    ]);
  });

  it("makes a template named concept the plain Page, and ignores files that are not templates", () => {
    const kinds = kindsFrom([entry("concept", "Anything"), entry("notes", "x", "concept"), { path: "templates/deep/a.md", type: "template" }]);
    expect(kinds).toEqual([{ type: "concept", label: "Page", description: "Anything" }]);
  });

  it("moves the choice one place and stops at the ends", () => {
    const kinds = kindsFrom([entry("a"), entry("b")]);
    expect(moveChoice(kinds, "concept", 1)).toBe("a");
    expect(moveChoice(kinds, "b", 1)).toBe("b");
    expect(moveChoice(kinds, "concept", -1)).toBe("concept");
    expect(moveChoice(kinds, "gone", 1)).toBe("a");
  });
});
