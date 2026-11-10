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

/** The mods to load: every folder in mods/ that has a main.js, by name. Nothing when mods are off. */
export function listMods(folder: string, disabled: boolean): ModsInfo {
  if (disabled) return { folder, disabled, ids: [] };
  const dir = path.join(folder, "mods");
  let names: string[] = [];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && isModId(e.name) && existsSync(path.join(dir, e.name, "main.js")))
      .map((e) => e.name);
  } catch {
    // No mods folder: no mods.
  }
  return { folder, disabled, ids: names.sort() };
}

/** The file a mod asked for, or an error when it is not inside that mod's own folder. */
export function resolveModFile(folder: string, id: string, rel: string): string {
  if (!isModId(id) || rel === "" || rel.includes("\0") || path.isAbsolute(rel)) throw new Error(`not a mod file: ${id}/${rel}`);
  const base = path.resolve(folder, "mods", id);
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
