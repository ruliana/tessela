import { describe, expect, it } from "vitest";

import { listOf } from "../src/mods/live-lists/list";
import { ModRegistry } from "../src/shared/mods";

describe("what a live list shows", () => {
  it("opens the page a row came from, and only a page", () => {
    const view = listOf({
      ok: true,
      rows: [
        { text: "a.md:5:hello", source: { path: "a.md", line: 5 } },
        { text: "people/  (2 pages)", source: { path: "people", pages: 2 } },
        { text: "2", source: null },
      ],
    });
    expect(view).toEqual({
      kind: "rows",
      rows: [{ text: "a.md:5:hello", open: { path: "a.md", line: 5 } }, { text: "people/  (2 pages)" }, { text: "2" }],
      more: 0,
    });
  });

  it("counts the rows it leaves out, and says when there are none or the command failed", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ text: String(i), source: null }));
    expect(listOf({ ok: true, rows }, 3)).toMatchObject({ kind: "rows", more: 2 });
    expect(listOf({ ok: true, rows: [] })).toEqual({ kind: "empty" });
    expect(listOf({ ok: false, error: { code: "invalid-input", message: "no such command" } })).toEqual({ kind: "error", message: "no such command" });
    expect(listOf(undefined).kind).toBe("error");
  });
});

describe("fence renderers of mods", () => {
  it("lets a mod draw an info string, and takes it back when the mod fails to load", async () => {
    const r = new ModRegistry();
    r.onFailure = () => {};
    await r.load("good", () => r.addFence("good", "tessela", () => "x"));
    await r.load("bad", () => {
      r.addFence("bad", "other", () => "y");
      throw new Error("no");
    });
    expect(r.hasFences()).toBe(true);
    expect(r.fenceRenderer("tessela")).toBeDefined();
    expect(r.fenceRenderer("other")).toBeUndefined();
  });
});
