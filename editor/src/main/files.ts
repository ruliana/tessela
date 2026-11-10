// Safe paths inside the bundle. Reading, writing, listing and watching pages is `tessela`'s job
// (see tessela.ts), so every client follows the same rules (spec §9).

import path from "node:path";

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
