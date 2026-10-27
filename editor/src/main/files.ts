// Reading and writing pages safely. The files are the only source of truth, so a
// write is atomic and refuses to overwrite a change it has not seen (spec §9).

import { createHash } from "node:crypto";
import { promises as fs, watch } from "node:fs";
import path from "node:path";

import type { PageEntry, PageFile, WriteResult } from "../shared/api";
import { newPageText, pageId } from "../shared/pages";

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** The absolute path of a page, or an error when `rel` could leave the bundle. */
export function resolveInside(root: string, rel: string): string {
  if (rel === "" || rel.includes("\0") || path.isAbsolute(rel) || !rel.endsWith(".md")) {
    throw new Error(`not a page path: ${rel}`);
  }
  const full = path.resolve(root, rel);
  const relative = path.relative(root, full);
  const parts = relative.split(path.sep);
  if (relative.startsWith("..") || path.isAbsolute(relative) || parts.some((p) => p.startsWith("."))) {
    throw new Error(`outside the bundle: ${rel}`);
  }
  return full;
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function readPage(root: string, rel: string): Promise<PageFile> {
  const text = await readIfExists(resolveInside(root, rel));
  if (text === null) return { path: rel, exists: false, text: newPageText(rel), hash: null };
  return { path: rel, exists: true, text, hash: hashText(text) };
}

export async function writePage(
  root: string,
  rel: string,
  text: string,
  expectedHash: string | null,
): Promise<WriteResult> {
  const file = resolveInside(root, rel);
  const current = await readIfExists(file);
  const diskHash = current === null ? null : hashText(current);
  if (diskHash !== expectedHash) return { ok: false, reason: "conflict", diskHash };
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Write next to the page and rename, so a reader never sees half a file.
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, text, "utf8");
  await fs.rename(temp, file);
  return { ok: true, hash: hashText(text) };
}

const RESERVED = new Set(["index.md", "log.md"]);

/** Every concept page in the bundle, like `tessela` itself sees them. */
export async function listPages(root: string): Promise<PageEntry[]> {
  const found: PageEntry[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else if (entry.name.endsWith(".md") && !RESERVED.has(entry.name)) {
        found.push({ id: pageId(rel), path: rel });
      }
    }
  }
  await walk(root, "");
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/** Tells `listener` which pages changed on disk, a moment after the last change. */
export function watchBundle(root: string, listener: (paths: string[]) => void): () => void {
  let pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(root, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const rel = filename.split(path.sep).join("/");
    if (!rel.endsWith(".md") || rel.split("/").some((p) => p.startsWith("."))) return;
    pending.add(rel);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const paths = [...pending];
      pending = new Set();
      listener(paths);
    }, 150);
  });
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
