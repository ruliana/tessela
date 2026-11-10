// Builds the mods that come with the app: each src/mods/<id>/main.ts becomes dist/mods/<id>/main.js,
// one file with what it imports from the app's own code (it is loaded by the window like any mod).

import { build } from "esbuild";
import { readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = join(root, "src/mods");
const ids = readdirSync(source, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(source, e.name, "main.ts")))
  .map((e) => e.name);

await build({
  entryPoints: Object.fromEntries(ids.map((id) => [`${id}/main`, join(source, id, "main.ts")])),
  outdir: join(root, "dist/mods"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  logLevel: "warning",
});
