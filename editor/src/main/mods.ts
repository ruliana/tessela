// Mods live in the config folder, as mods/<id>/main.js. This finds them and serves their files
// to the window (the window imports them from `tessela-mod://mods/<id>/main.js`).

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import type { ModsInfo } from "../shared/api";

/** The config folder: `$TESSELA_CONFIG`, else the app's own data folder. */
export function configFolder(userData: string, env: string | undefined): string {
  return env ? path.resolve(env) : userData;
}

const MOD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isModId(id: string): boolean {
  return MOD_ID.test(id);
}

/** The ids of the folders in `dir` that have a main.js. */
function modsIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && isModId(e.name) && existsSync(path.join(dir, e.name, "main.js")))
      .map((e) => e.name);
  } catch {
    return []; // No mods folder: no mods.
  }
}

/**
 * The mods to load: the app's own (`bundled`, a folder of mod folders) and every folder in the
 * config folder's mods/ that has a main.js, by name. A mod of the config folder replaces the app's
 * with the same name. Nothing when mods are off.
 */
export function listMods(folder: string, disabled: boolean, bundled?: string): ModsInfo {
  if (disabled) return { folder, disabled, ids: [] };
  const ids = new Set([...(bundled ? modsIn(bundled) : []), ...modsIn(path.join(folder, "mods"))]);
  return { folder, disabled, ids: [...ids].sort() };
}

/** The file a mod asked for, or an error when it is not inside that mod's own folder. */
export function resolveModFile(folder: string, id: string, rel: string, bundled?: string): string {
  if (!isModId(id) || rel === "" || rel.includes("\0") || path.isAbsolute(rel)) throw new Error(`not a mod file: ${id}/${rel}`);
  const own = path.resolve(folder, "mods", id);
  const base = bundled && !existsSync(path.join(own, "main.js")) ? path.resolve(bundled, id) : own;
  const full = path.resolve(base, rel);
  if (path.relative(base, full).startsWith("..")) throw new Error(`outside the mod: ${id}/${rel}`);
  return full;
}

/** `argv` as a list of strings starting with a command name, or an error. */
export function cliArgv(argv: unknown): string[] {
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === "string")) throw new Error("cli: argv must be a list of strings");
  if (!/^[a-z][a-z-]*$/.test(argv[0] as string)) throw new Error(`cli: not a command name: ${String(argv[0])}`);
  return argv as string[];
}
