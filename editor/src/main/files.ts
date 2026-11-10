// Finding pages and watching for changes. Reading and writing a page is `tessela`'s job
// (see tessela.ts), so every writer follows the same rules (spec §9).

import { type FSWatcher, promises as fs, watch } from "node:fs";
import path from "node:path";

import type { PageEntry } from "../shared/api";
import { titleOf } from "../shared/linkFlows";
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

/** The title of a page, read from the first few kilobytes of the file (front matter and the top of the text). */
async function titleAtTop(file: string, rel: string): Promise<string> {
  let head = "";
  try {
    const handle = await fs.open(file, "r");
    try {
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      head = buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    // A file that cannot be read is listed by its name.
  }
  return titleOf(head, rel);
}

/** Every concept page in the bundle, like `tessela` itself sees them. */
export async function listPages(root: string): Promise<PageEntry[]> {
  const found: PageEntry[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else if (entry.name.endsWith(".md") && !RESERVED.has(entry.name)) {
        found.push({ id: pageId(rel), path: rel, title: await titleAtTop(path.join(dir, entry.name), rel) });
      }
    }
  }
  await walk(root, "");
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

export interface WatchOptions {
  /** The operating system watcher; replaced in tests. */
  watch?: typeof watch;
  /** How often the fallback looks at the files when the system watcher is not available. */
  pollMs?: number;
  /** How long to wait before trying the system watcher again. */
  retryMs?: number;
  warn?: (message: string) => void;
}

/** Every page of the bundle with a stamp that changes when the file does; hidden folders are skipped. */
async function stamps(root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else if (entry.name.endsWith(".md")) {
        try {
          const st = await fs.stat(path.join(dir, entry.name));
          found.set(rel, `${st.mtimeMs}:${st.size}`);
        } catch {
          // Gone since the listing.
        }
      }
    }
  }
  await walk(root, "");
  return found;
}

/**
 * Tells `listener` which pages changed on disk, a moment after the last change.
 * macOS gives out a limited number of folder watchers to the whole machine (1024), and
 * `fs.watch` then fails with EMFILE. A failed watcher must not stop the editor: it falls back
 * to looking at the files every few seconds, and tries the system watcher again now and then.
 */
export function watchBundle(root: string, listener: (paths: string[]) => void, options: WatchOptions = {}): () => void {
  const { watch: startWatch = watch, pollMs = 2000, retryMs = 60_000, warn = console.warn } = options;
  let pending = new Set<string>();
  let debounce: NodeJS.Timeout | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | undefined;
  let closed = false;

  const changed = (rel: string): void => {
    pending.add(rel);
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const paths = [...pending];
      pending = new Set();
      listener(paths);
    }, 150);
  };

  // Each polling run has a number, so a run that was replaced while it read the files ends quietly.
  let run = 0;
  let snapshot: Map<string, string> | undefined;
  const poll = async (id: number): Promise<void> => {
    if (closed || watcher || id !== run) return;
    const now = await stamps(root);
    if (closed || watcher || id !== run) return;
    if (snapshot) {
      for (const [rel, stamp] of now) if (snapshot.get(rel) !== stamp) changed(rel);
      for (const rel of snapshot.keys()) if (!now.has(rel)) changed(rel);
    }
    snapshot = now;
    pollTimer = setTimeout(() => void poll(id), pollMs);
  };

  const fallBack = (err: unknown): void => {
    watcher = undefined;
    if (closed) return;
    warn(`cannot watch ${root}, looking at it every ${pollMs / 1000} s instead: ${err instanceof Error ? err.message : err}`);
    clearTimeout(pollTimer);
    void poll(++run);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(tryWatching, retryMs);
  };

  function tryWatching(): void {
    if (closed) return;
    try {
      const w = startWatch(root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const rel = filename.toString().split(path.sep).join("/");
        if (!rel.endsWith(".md") || rel.split("/").some((p) => p.startsWith("."))) return;
        changed(rel);
      });
      w.on("error", (err) => {
        w.close();
        if (w === watcher) fallBack(err);
      });
      watcher = w;
      run++;
      clearTimeout(pollTimer);
    } catch (err) {
      fallBack(err);
    }
  }

  tryWatching();
  return () => {
    closed = true;
    clearTimeout(debounce);
    clearTimeout(pollTimer);
    clearTimeout(retryTimer);
    watcher?.close();
  };
}
