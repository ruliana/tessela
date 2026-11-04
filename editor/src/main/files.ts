// Finding pages and watching for changes. Reading and writing a page is `tessela`'s job
// (see tessela.ts), so every writer follows the same rules (spec §9).

import { promises as fs, watch } from "node:fs";
import path from "node:path";

import type { PageEntry } from "../shared/api";
import { pageId } from "../shared/pages";

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

const IMAGE_TYPES = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

/** The absolute path of a picture in the bundle, or an error when `rel` is not one that may be shown. */
export function resolveImage(root: string, rel: string): string {
  if (rel === "" || rel.includes("\0") || path.isAbsolute(rel) || !IMAGE_TYPES.test(rel)) {
    throw new Error(`not a picture: ${rel}`);
  }
  const full = path.resolve(root, rel);
  const relative = path.relative(root, full);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative.split(path.sep).some((p) => p.startsWith("."))) {
    throw new Error(`outside the bundle: ${rel}`);
  }
  return full;
}

/**
 * The page path (relative, with `/`) of an absolute file when it lives inside the bundle, or
 * null when it does not. It does not check that the file is a page `resolveInside` accepts.
 */
export function relativeInside(root: string, file: string): string | null {
  const relative = path.relative(root, file);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
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
