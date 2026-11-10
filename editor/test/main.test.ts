import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { existsSync } from "node:fs";

import { relativeInside, resolveImage, resolveInside } from "../src/main/files";
import { addPageVia, findTessela, lintArgv, pagesArgv, queryArgv, readPageVia, runJson, savePageVia, vocabArgv, watchVia } from "../src/main/tessela";

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
  it("shows pictures of the bundle and nothing else", () => {
    expect(resolveImage("/tmp/b", "assets/a b.PNG")).toBe(path.resolve("/tmp/b/assets/a b.PNG"));
    for (const bad of ["../a.png", "/etc/a.png", ".hidden/a.png", "notes.md", "a.png/../../x.txt", "a\0.png", ""]) {
      expect(() => resolveImage("/tmp/b", bad), bad).toThrow();
    }
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
});

// Saving goes through the real `tessela` tool: `cargo build -p tessela-cli` makes one, or set
// TESSELA_BIN. Without a build there is nothing to test against, so these are skipped.
const tool = findTessela({
  env: process.env.TESSELA_BIN,
  resourcesPath: undefined,
  appPath: path.resolve(__dirname, ".."),
  platform: process.platform,
  exists: existsSync,
});
const haveTool = path.isAbsolute(tool) && existsSync(tool);

describe.skipIf(!haveTool)("reading through the tessela tool", () => {
  it("gets the lists out of the answer envelope", async () => {
    const root = await bundle();
    await writeFile(path.join(root, "a.md"), "---\ntype: concept\n---\n\n- one #topic\n");
    expect(await runJson<unknown[]>(tool, queryArgv(root, { refs: ["topic"] }), "hits")).toHaveLength(1);
    expect(await runJson<{ concept: string }[]>(tool, vocabArgv(root), "concepts")).toContainEqual(
      expect.objectContaining({ concept: "topic" }),
    );
    expect(Array.isArray(await runJson(tool, lintArgv(root), "diagnostics", [1]))).toBe(true);
  });

  it("lists concept pages, not reserved or hidden files, with the title each gives itself", async () => {
    const root = await bundle();
    await writeFile(path.join(root, "daily-todo.md"), '---\ntype: concept\ntitle: "Daily TODO"\n---\n\n# Other\n');
    await writeFile(path.join(root, "reading-list.md"), "---\ntype: concept\n---\n\n# Books to read\n");
    await writeFile(path.join(root, "bare-page.md"), "no heading");
    const pages = await runJson<{ path: string; title: string }[]>(tool, pagesArgv(root), "pages");
    const titles = Object.fromEntries(pages.map((p) => [p.path, p.title]));
    expect(Object.keys(titles).sort()).toEqual(["bare-page.md", "daily-todo.md", "journals/2026-10-27.md", "reading-list.md"]);
    expect(titles["daily-todo.md"]).toBe("Daily TODO");
    expect(titles["reading-list.md"]).toBe("Books to read");
    expect(titles["bare-page.md"]).toBe("bare page");
  });

  it("reports a failure the tool describes as JSON", async () => {
    await expect(runJson(tool, queryArgv("/nowhere/at/all", {}), "hits")).rejects.toThrow(/not a directory/);
  });
});

describe.skipIf(!haveTool)("watching through the tessela tool", () => {
  const until = async (done: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 25));
    expect(done()).toBe(true);
  };

  it("hears the pages that change, and not hidden ones", async () => {
    const root = await bundle();
    const heard = new Set<string>();
    const stop = watchVia(tool, root, (paths) => paths.forEach((p) => heard.add(p)), { warn: () => {} });
    // The tool needs a moment to start; changes made before it is ready are not reported.
    for (let i = 0; i < 100 && !heard.has("new.md"); i++) {
      await writeFile(path.join(root, ".git/y.md"), `hidden ${i}`);
      await writeFile(path.join(root, "new.md"), `new ${i}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    stop();
    expect(heard.has("new.md")).toBe(true);
    expect(heard.has(".git/y.md")).toBe(false);
  });

  it("says so and tries again when the tool cannot be run", async () => {
    const warn = vi.fn();
    const stop = watchVia("/no/such/tessela", "/tmp", () => {}, { warn, restartMs: 20 });
    await until(() => warn.mock.calls.length >= 2);
    stop();
    const after = warn.mock.calls.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(warn.mock.calls.length).toBe(after);
  });
});

describe.skipIf(!haveTool)("saving through the tessela tool", () => {
  it("offers a template for a page that has no file, and writes it on first save", async () => {
    const root = await bundle();
    const page = await readPageVia(tool, root, "project/new.md");
    expect(page).toMatchObject({ exists: false, hash: null });
    expect(page.text).toContain("type: concept");
    const result = await savePageVia(tool, root, "project/new.md", `${page.text}hello\n`, null);
    expect(result.ok).toBe(true);
    expect(await readFile(path.join(root, "project/new.md"), "utf8")).toContain("hello");
  });

  it("reads the hash that a save must be based on", async () => {
    const root = await bundle();
    const page = await readPageVia(tool, root, "journals/2026-10-27.md");
    expect(page).toMatchObject({ exists: true, text: "---\ntype: journal\n---\n\nhi\n" });
    const result = await savePageVia(tool, root, "journals/2026-10-27.md", "mine\n", page.hash);
    expect(result.ok).toBe(true);
    // Saving again with the old hash is stale.
    expect(await savePageVia(tool, root, "journals/2026-10-27.md", "late\n", page.hash)).toMatchObject({
      ok: false,
      reason: "conflict",
    });
    expect(await readFile(path.join(root, "journals/2026-10-27.md"), "utf8")).toBe("mine\n");
  });

  it("refuses to overwrite a change it has not seen", async () => {
    const root = await bundle();
    const page = await readPageVia(tool, root, "journals/2026-10-27.md");
    await writeFile(path.join(root, "journals/2026-10-27.md"), "changed elsewhere");
    const result = await savePageVia(tool, root, "journals/2026-10-27.md", "mine", page.hash);
    expect(result).toMatchObject({ ok: false, reason: "conflict" });
    expect(await readFile(path.join(root, "journals/2026-10-27.md"), "utf8")).toBe("changed elsewhere");
    // A page that appeared meanwhile also counts as a conflict.
    expect(await savePageVia(tool, root, "journals/2026-10-27.md", "mine", null)).toMatchObject({ ok: false });
  });

  it("sends text of any size and shape untouched", async () => {
    const root = await bundle();
    const text = `---\ntype: concept\n---\n\n${"línea ünï ✓ \"q\" \\ \r\n".repeat(20000)}`;
    expect((await savePageVia(tool, root, "big.md", text, null)).ok).toBe(true);
    expect(await readFile(path.join(root, "big.md"), "utf8")).toBe(text);
  });

  it("creates a page from the template, and says when it is already there", async () => {
    const root = await bundle();
    expect(await addPageVia(tool, root, "project/idea.md", "My Idea")).toBe(true);
    expect(await readFile(path.join(root, "project/idea.md"), "utf8")).toBe(
      '---\ntype: concept\ntitle: "My Idea"\n---\n\n',
    );
    expect(await addPageVia(tool, root, "project/idea.md")).toBe(false);
  });

  it("fails loudly on a path outside the bundle", async () => {
    const root = await bundle();
    await expect(savePageVia(tool, root, "../x.md", "x", null)).rejects.toThrow(/outside|leave the bundle|invalid/i);
  });

  it("leaves no temporary files behind", async () => {
    const root = await bundle();
    await savePageVia(tool, root, "a.md", "x", null);
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(root)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});

describe("queryArgv", () => {
  it("passes every option to the tool", () => {
    expect(
      queryArgv("/b", { refs: ["a", "b"], any: true, from: "2026-01-01", to: "2026-01-31", limit: 5, text: "x" }),
    ).toEqual([
      "query", "/b", "--json", "--api", "2", "--ref", "a", "--ref", "b", "--any", "--text", "x",
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
