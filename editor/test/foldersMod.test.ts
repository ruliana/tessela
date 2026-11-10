import { describe, expect, it } from "vitest";

import { cleanDir, folderOf, homePath, homeTitle, trail } from "../src/mods/folders/plan";
import { ModRegistry } from "../src/shared/mods";
import { emptyHistory, samePlace, visit } from "../src/shared/nav";

describe("the folders mod's paths", () => {
  it("walks from the root down to a folder, and names the home page it would have", () => {
    expect(trail("projects/sub")).toEqual([
      { name: "", path: "" },
      { name: "projects", path: "projects" },
      { name: "sub", path: "projects/sub" },
    ]);
    expect(trail("")).toEqual([{ name: "", path: "" }]);
    expect(cleanDir("/projects/")).toBe("projects");
    expect(folderOf("projects/sub/deep.md")).toBe("projects/sub");
    expect(folderOf("home.md")).toBe("");
    expect([homePath(""), homePath("people"), homeTitle(""), homeTitle("a/people")]).toEqual(["home.md", "people/home.md", "Home", "People home"]);
  });
});

describe("views", () => {
  it("are a mod's own, go when the mod fails, and are told apart in the history by what they were opened with", async () => {
    const r = new ModRegistry();
    const render = () => {};
    r.addView("a", { id: "v", label: "V", render });
    await r.load("bad", () => {
      r.addView("bad", { id: "w", label: "W", render });
      throw new Error("nope");
    });
    expect(r.views().map((v) => v.id)).toEqual(["v"]);
    expect(r.view("w")).toBeUndefined();

    expect(samePlace({ kind: "view", id: "v", arg: "x" }, { kind: "view", id: "v", arg: "x" })).toBe(true);
    expect(samePlace({ kind: "view", id: "v" }, { kind: "view", id: "v", arg: "" })).toBe(true);
    expect(samePlace({ kind: "view", id: "v", arg: "x" }, { kind: "view", id: "v", arg: "y" })).toBe(false);
    expect(visit(visit(emptyHistory(), { kind: "journals" }), { kind: "view", id: "v" }).at).toBe(1);
  });
});
