import { describe, expect, it } from "vitest";

import { changedPages, describeChange, folderOf, mentioning, nameForTitle, stemOf } from "../src/mods/pages/plan";
import { ModRegistry } from "../src/shared/mods";
import { emptyHistory, relocate, relocateRecent, visit } from "../src/shared/nav";

describe("the pages mod's words", () => {
  const answer = (updated: { path: string; links: number; tags: number }[]) => ({ from: "a.md", to: "b.md", updated, warnings: [] });

  it("counts references and pages, leaving out the moved page itself", () => {
    const a = answer([{ path: "x.md", links: 2, tags: 1 }, { path: "y.md", links: 1, tags: 0 }, { path: "b.md", links: 4, tags: 0 }]);
    expect(describeChange(a)).toBe("4 references in 2 pages will change.");
    expect(changedPages(a)).toEqual(["x.md", "y.md"]);
    expect(describeChange(answer([{ path: "x.md", links: 1, tags: 0 }]))).toBe("1 reference in 1 page will change.");
    expect(describeChange(answer([]))).toMatch(/No other page/);
  });

  it("names a file after a title, or gives up", () => {
    expect(nameForTitle("  Brand New Name ")).toBe("brand-new-name");
    expect(nameForTitle("a/b")).toBeNull();
    expect(nameForTitle("   ")).toBeNull();
    expect(stemOf("notes/idea.md")).toBe("idea");
    expect(folderOf("notes/idea.md")).toBe("notes/");
    expect(folderOf("idea.md")).toBe("");
  });

  it("lists the pages that mention a page once each, not the page itself", () => {
    const hits = [{ path: "a.md" }, { path: "b.md" }, { path: "b.md" }, { path: "me.md" }];
    expect(mentioning(hits, "me.md")).toEqual({ pages: ["a.md", "b.md"], mentions: 3 });
  });
});

describe("mod events and the page menu", () => {
  it("tells the listeners, reports one that throws, and forgets a mod that failed to load", async () => {
    const r = new ModRegistry();
    const heard: string[] = [];
    const failed: string[] = [];
    r.onFailure = (f) => failed.push(f.message);
    r.on("m", "page-saved", ({ path }) => heard.push(path));
    r.on("bad", "page-saved", () => {
      throw new Error("boom");
    });
    const stop = r.on("m", "changed", ({ paths }) => heard.push(...paths));
    r.emit("page-saved", { path: "a.md" });
    r.emit("changed", { paths: ["b.md"] });
    stop();
    r.emit("changed", { paths: ["c.md"] });
    expect(heard).toEqual(["a.md", "b.md"]);
    expect(failed).toEqual(["on page-saved: boom"]);

    await r.load("late", () => {
      r.on("late", "page-opened", () => heard.push("late"));
      r.addPageMenuItem("late", { label: "x", run: () => {} });
      throw new Error("no");
    });
    r.emit("page-opened", { path: "z.md" });
    expect(heard).not.toContain("late");
    expect(r.pageMenuItems()).toEqual([]);
  });
});

describe("a page that changed place", () => {
  it("is followed in the history and the recent list, and dropped when it is deleted", () => {
    let h = emptyHistory();
    for (const path of ["a.md", "b.md", "a.md"]) h = visit(h, { kind: "page", path });
    expect(relocate(h, "a.md", "c.md").places).toEqual([
      { kind: "page", path: "c.md" },
      { kind: "page", path: "b.md" },
      { kind: "page", path: "c.md" },
    ]);
    const gone = relocate(h, "a.md", null);
    expect(gone.places).toEqual([{ kind: "page", path: "b.md" }]);
    expect(gone.at).toBe(0);
    expect(relocate(emptyHistory(), "a.md", null)).toEqual(emptyHistory());
    expect(relocateRecent(["x.md", "a.md", "c.md"], "a.md", "c.md")).toEqual(["x.md", "c.md"]);
    expect(relocateRecent(["x.md", "a.md"], "a.md", null)).toEqual(["x.md"]);
  });
});
