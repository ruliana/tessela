import { describe, expect, it } from "vitest";

import { describeMods, ModRegistry } from "../src/shared/mods";

const cmd = (id: string, label = id) => ({ id, label, run: () => {} });

describe("ModRegistry", () => {
  it("lets a mod's command take the place of the built-in one with its id", () => {
    const r = new ModRegistry();
    r.addCommand("m", cmd("today", "Mod today"));
    r.addCommand("m", cmd("extra", "Extra"));
    const list = r.commands([{ id: "today", label: "Today" }, { id: "theme", label: "Theme" }], (c) => ({ id: c.id, label: c.label }));
    expect(list.map((c) => c.label)).toEqual(["Mod today", "Theme", "Extra"]);
  });

  it("takes back what a failing mod had already added and keeps the others", async () => {
    const r = new ModRegistry();
    await r.load("good", () => r.addCommand("good", cmd("a")));
    await r.load("bad", () => {
      r.addCommand("bad", cmd("b"));
      r.addSlash("bad", { label: "x", text: "x" });
      throw new Error("nope");
    });
    expect(r.loaded).toEqual(["good"]);
    expect(r.failures).toEqual([{ mod: "bad", message: "nope" }]);
    expect(r.commands([], (c) => ({ id: c.id }))).toEqual([{ id: "a" }]);
    expect(r.slashItems()).toEqual([]);
  });

  it("reports a command that throws, or whose promise fails, without throwing itself", async () => {
    const r = new ModRegistry();
    const seen: string[] = [];
    r.onFailure = (f) => seen.push(f.message);
    await r.load("m", () => {
      r.addCommand("m", { ...cmd("sync", "Sync"), run: () => { throw new Error("boom"); } });
      r.addCommand("m", { ...cmd("async", "Async"), run: async () => { throw new Error("later"); } });
    });
    const [sync, async_] = r.commands([], (c) => c);
    r.run(sync!, {});
    r.run(async_!, {});
    await new Promise((done) => setTimeout(done, 0));
    expect(seen).toEqual(["Sync: boom", "Async: later"]);
  });
});

describe("describeMods", () => {
  it("lists loaded and failed mods, and says when they are off or none exist", () => {
    expect(describeMods(["a", "b"], [{ mod: "c", message: "bad" }], "/cfg", false)).toBe("Mods loaded: a, b. Failed: c (bad).");
    expect(describeMods([], [], "/cfg", false)).toContain("/cfg/mods/NAME/main.js");
    expect(describeMods([], [], "/cfg", true)).toContain("--no-mods");
  });
});

describe("the mods that come with the app", () => {
  it("are listed with the user's, and a user mod with the same name replaces one", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { listMods, resolveModFile } = await import("../src/main/mods");
    const root = mkdtempSync(path.join(tmpdir(), "tessela-mods-"));
    const put = (dir: string, id: string) => {
      mkdirSync(path.join(dir, id), { recursive: true });
      writeFileSync(path.join(dir, id, "main.js"), "");
    };
    const bundled = path.join(root, "bundled");
    const config = path.join(root, "config");
    put(bundled, "pages");
    put(bundled, "other");
    put(path.join(config, "mods"), "pages");
    put(path.join(config, "mods"), "mine");
    expect(listMods(config, false, bundled).ids).toEqual(["mine", "other", "pages"]);
    expect(listMods(config, true, bundled).ids).toEqual([]);
    expect(resolveModFile(config, "pages", "main.js", bundled)).toBe(path.join(config, "mods/pages/main.js"));
    expect(resolveModFile(config, "other", "main.js", bundled)).toBe(path.join(bundled, "other/main.js"));
    expect(() => resolveModFile(config, "other", "../pages/main.js", bundled)).toThrow();
  });
});

describe("AGENTS.md in the config folder", () => {
  it("is written when missing, kept up to date while it carries the marker, and left alone once the person owns it", async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { AGENTS_MARKER, installAgents } = await import("../src/main/mods");
    const folder = path.join(mkdtempSync(path.join(tmpdir(), "tessela-agents-")), "not-yet-there");
    const file = path.join(folder, "AGENTS.md");
    installAgents(folder, "# Mods v1\n");
    expect(readFileSync(file, "utf8")).toBe(`${AGENTS_MARKER}\n\n# Mods v1\n`);
    installAgents(folder, "# Mods v2\n");
    expect(readFileSync(file, "utf8")).toBe(`${AGENTS_MARKER}\n\n# Mods v2\n`);
    writeFileSync(file, "# My own notes for agents\n");
    installAgents(folder, "# Mods v3\n");
    expect(readFileSync(file, "utf8")).toBe("# My own notes for agents\n");
  });

  it("does not throw when the folder cannot be written", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { installAgents } = await import("../src/main/mods");
    const plainFile = path.join(mkdtempSync(path.join(tmpdir(), "tessela-agents-")), "file");
    writeFileSync(plainFile, "");
    expect(() => installAgents(path.join(plainFile, "inside"), "x")).not.toThrow();
  });

  it("is the mod-writing skill without its front matter", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { agentsText } = await import("../src/main/mods");
    const skill = readFileSync(path.resolve(import.meta.dirname, "../../skills/tessela-mods/SKILL.md"), "utf8");
    const text = agentsText(skill);
    expect(text.startsWith("# Writing a mod for the Tessela editor")).toBe(true);
    expect(text).not.toContain("name: tessela-mods");
  });
});
