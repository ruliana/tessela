import { describe, expect, it } from "vitest";

import { homeLabel, isEmpty, togetherRows, trailOf } from "../src/mods/related/plan";

describe("the related mod's plan", () => {
  it("names a home page after its folder, and the root's Home", () => {
    expect(homeLabel("home.md")).toBe("Home");
    expect(homeLabel("project/home.md")).toBe("project");
    expect(homeLabel("a/b/home.md")).toBe("a/b");
  });

  it("leaves the root's home page out of a trail made of folders, since every page has it", () => {
    const home = (path: string) => ({ path, title: "home" });
    const chain = [home("home.md"), home("project/home.md")];
    expect(trailOf({ together: [], chain, chain_by: "links" }).length).toBe(2);
    expect(trailOf({ together: [], chain, chain_by: "folders" }).map((h) => h.path)).toEqual(["project/home.md"]);
    expect(isEmpty({ together: [], chain: [home("home.md")], chain_by: "folders" })).toBe(true);
  });

  it("keeps the first rows and knows when there is nothing to show", () => {
    const t = (concept: string) => ({ concept, page: null, reason: "together in 1 block" });
    expect(togetherRows({ together: ["a", "b", "c"].map(t), chain: [], chain_by: "links" }, 2).map((r) => r.concept)).toEqual(["a", "b"]);
    expect(isEmpty({ together: [], chain: [], chain_by: "links" })).toBe(true);
    expect(isEmpty({ together: [t("a")], chain: [], chain_by: "links" })).toBe(false);
  });
});
