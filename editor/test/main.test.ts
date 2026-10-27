import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { listPages, readPage, relativeInside, resolveInside, writePage } from "../src/main/files";
import { findTessela, queryArgv } from "../src/main/tessela";

async function bundle(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "tessela-test-"));
  await mkdir(path.join(root, "journals"));
  await writeFile(path.join(root, "journals/2026-10-27.md"), "---\ntype: journal\n---\n\nhi\n");
  await writeFile(path.join(root, "index.md"), "reserved");
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, ".git/x.md"), "hidden");
  return root;
}

describe("files", () => {
  it("lists concept pages but not reserved or hidden files", async () => {
    const root = await bundle();
    expect((await listPages(root)).map((p) => p.id)).toEqual(["journals/2026-10-27"]);
  });

  it("refuses paths outside the bundle", () => {
    for (const bad of ["../x.md", "/etc/passwd.md", "a/../../x.md", ".git/x.md", "x.txt", ""]) {
      expect(() => resolveInside("/tmp/b", bad)).toThrow();
    }
  });

  it("tells whether a file is inside the bundle, and where", () => {
    expect(relativeInside("/tmp/b", "/tmp/b/project/a.md")).toBe("project/a.md");
    expect(relativeInside("/tmp/b", "/tmp/b/a.md")).toBe("a.md");
    expect(relativeInside("/tmp/b", "/tmp/other/a.md")).toBeNull();
    expect(relativeInside("/tmp/b", "/tmp/b-sibling/a.md")).toBeNull();
    expect(relativeInside("/tmp/b", "/tmp/b")).toBeNull();
  });

  it("offers a template for a page that has no file, and writes it on first save", async () => {
    const root = await bundle();
    const page = await readPage(root, "project/new.md");
    expect(page).toMatchObject({ exists: false, hash: null });
    expect(page.text).toContain("type: concept");
    const result = await writePage(root, "project/new.md", `${page.text}hello\n`, null);
    expect(result.ok).toBe(true);
    expect(await readFile(path.join(root, "project/new.md"), "utf8")).toContain("hello");
  });

  it("refuses to overwrite a change it has not seen", async () => {
    const root = await bundle();
    const page = await readPage(root, "journals/2026-10-27.md");
    await writeFile(path.join(root, "journals/2026-10-27.md"), "changed elsewhere");
    const result = await writePage(root, "journals/2026-10-27.md", "mine", page.hash);
    expect(result).toMatchObject({ ok: false, reason: "conflict" });
    expect(await readFile(path.join(root, "journals/2026-10-27.md"), "utf8")).toBe("changed elsewhere");
    // A page that appeared meanwhile also counts as a conflict.
    expect(await writePage(root, "journals/2026-10-27.md", "mine", null)).toMatchObject({ ok: false });
  });

  it("leaves no temporary files behind", async () => {
    const root = await bundle();
    await writePage(root, "a.md", "x", null);
    expect((await listPages(root)).map((p) => p.path)).toContain("a.md");
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(root)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});

describe("queryArgv", () => {
  it("passes every option to the tool", () => {
    expect(
      queryArgv("/b", { refs: ["a", "b"], any: true, from: "2026-01-01", to: "2026-01-31", limit: 5, text: "x" }),
    ).toEqual([
      "query", "/b", "--json", "--ref", "a", "--ref", "b", "--any", "--text", "x",
      "--from", "2026-01-01", "--to", "2026-01-31", "--limit", "5",
    ]);
  });
});

describe("findTessela", () => {
  const base = { env: undefined, resourcesPath: undefined, appPath: "/src/editor", platform: "linux" as const };
  const have = (...files: string[]) => (f: string) => files.includes(f);

  it("prefers $TESSELA_BIN", () => {
    expect(findTessela({ ...base, env: "/x/tessela", exists: have() })).toBe("/x/tessela");
  });

  it("uses the tool packaged with the app", () => {
    const l = { ...base, resourcesPath: "/app/resources", exists: have("/app/resources/bin/tessela", "/src/target/release/tessela") };
    expect(findTessela(l)).toBe("/app/resources/bin/tessela");
    const win = { ...l, platform: "win32" as const, exists: have("/app/resources/bin/tessela.exe") };
    expect(findTessela(win)).toBe("/app/resources/bin/tessela.exe");
  });

  it("falls back to a build next to the editor, then PATH", () => {
    expect(findTessela({ ...base, exists: have("/src/target/debug/tessela") })).toBe("/src/target/debug/tessela");
    expect(findTessela({ ...base, exists: have() })).toBe("tessela");
  });
});
