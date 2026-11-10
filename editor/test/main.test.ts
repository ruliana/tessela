import { EventEmitter } from "node:events";
import type { watch } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { existsSync } from "node:fs";

import { listPages, relativeInside, resolveImage, resolveInside, watchBundle } from "../src/main/files";
import { addPageVia, findTessela, lintArgv, queryArgv, readPageVia, runJson, savePageVia, vocabArgv } from "../src/main/tessela";

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

  it("lists each page with the title it gives itself", async () => {
    const root = await bundle();
    await writeFile(path.join(root, "daily-todo.md"), '---\ntype: concept\ntitle: "Daily TODO"\n---\n\n# Other\n');
    await writeFile(path.join(root, "reading-list.md"), "---\ntype: concept\n---\n\n# Books to read\n");
    await writeFile(path.join(root, "bare-page.md"), "no heading");
    const titles = Object.fromEntries((await listPages(root)).map((p) => [p.path, p.title]));
    expect(titles["daily-todo.md"]).toBe("Daily TODO");
    expect(titles["reading-list.md"]).toBe("Books to read");
    expect(titles["bare-page.md"]).toBe("bare page");
  });

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

  it("reports a failure the tool describes as JSON", async () => {
    await expect(runJson(tool, queryArgv("/nowhere/at/all", {}), "hits")).rejects.toThrow(/not a directory/);
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

describe("watchBundle", () => {
  // What fs.watch does on a Mac that has run out of folder watchers: EMFILE, after it returned.
  const emfile = Object.assign(new Error("EMFILE: too many open files, watch"), { code: "EMFILE" });
  const brokenWatch = (): { fake: typeof watch; started: () => number } => {
    let n = 0;
    const fake = (() => {
      n++;
      const w = Object.assign(new EventEmitter(), { close: () => {} });
      setTimeout(() => w.emit("error", emfile), 5);
      return w;
    }) as unknown as typeof watch;
    return { fake, started: () => n };
  };
  const until = async (done: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 25));
    expect(done()).toBe(true);
  };

  it("keeps reporting changes when the system watcher fails after it started", async () => {
    const root = await bundle();
    const heard = new Set<string>();
    const warn = vi.fn();
    const { fake } = brokenWatch();
    const stop = watchBundle(root, (paths) => paths.forEach((p) => heard.add(p)), { watch: fake, pollMs: 20, retryMs: 60_000, warn });
    await new Promise((r) => setTimeout(r, 100));
    await writeFile(path.join(root, "new.md"), "new");
    await writeFile(path.join(root, "journals/2026-10-27.md"), "changed elsewhere");
    await writeFile(path.join(root, ".git/y.md"), "hidden");
    await until(() => heard.has("new.md") && heard.has("journals/2026-10-27.md"));
    stop();
    expect(heard.has(".git/y.md")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("EMFILE"));
  });

  it("does not throw when the system watcher cannot start", async () => {
    const root = await bundle();
    const heard = new Set<string>();
    const refuse = (() => {
      throw emfile;
    }) as unknown as typeof watch;
    const stop = watchBundle(root, (paths) => paths.forEach((p) => heard.add(p)), { watch: refuse, pollMs: 20, retryMs: 60_000, warn: () => {} });
    await new Promise((r) => setTimeout(r, 100));
    await writeFile(path.join(root, "late.md"), "x");
    await until(() => heard.has("late.md"));
    stop();
  });

  it("tries the system watcher again later", async () => {
    const root = await bundle();
    const { fake, started } = brokenWatch();
    const stop = watchBundle(root, () => {}, { watch: fake, pollMs: 20, retryMs: 50, warn: () => {} });
    await until(() => started() >= 3);
    stop();
    const after = started();
    await new Promise((r) => setTimeout(r, 150));
    expect(started()).toBe(after);
  });

  it("stops looking at the files once the system watcher works again", async () => {
    const root = await bundle();
    const heard = new Set<string>();
    let calls = 0;
    let deliver: ((event: string, filename: string) => void) | undefined;
    const flaky = ((_root: string, _opts: unknown, cb: (event: string, filename: string) => void) => {
      const w = Object.assign(new EventEmitter(), { close: () => {} });
      if (++calls === 1) setTimeout(() => w.emit("error", emfile), 5);
      else deliver = cb;
      return w;
    }) as unknown as typeof watch;
    const stop = watchBundle(root, (paths) => paths.forEach((p) => heard.add(p)), { watch: flaky, pollMs: 20, retryMs: 60, warn: () => {} });
    await until(() => deliver !== undefined);
    await writeFile(path.join(root, "quiet.md"), "x");
    await new Promise((r) => setTimeout(r, 200));
    expect(heard.has("quiet.md")).toBe(false);
    deliver!("change", "heard.md");
    await until(() => heard.has("heard.md"));
    stop();
  });
});
