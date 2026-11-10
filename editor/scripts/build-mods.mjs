// Builds the mods that come with the app: each src/mods/<id>/main.ts becomes dist/mods/<id>/main.js,
// one file with what it imports from the app's own code (it is loaded by the window like any mod).
// The CodeMirror packages are not copied into it: the window hands its own to every mod (`ctx.cm`,
// also on `globalThis.__tesselaCm`), so an `import ... from "@codemirror/state"` in a built-in mod
// reads from there. Two copies of those packages would not agree on what a state field is.

import { build } from "esbuild";
import { readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = join(root, "src/mods");
const ids = readdirSync(source, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(source, e.name, "main.ts")))
  .map((e) => e.name);

const SHARED = ["state", "view", "language", "commands", "autocomplete"];

const sharedCodeMirror = {
  name: "shared-codemirror",
  setup(b) {
    b.onResolve({ filter: new RegExp(`^@codemirror/(${SHARED.join("|")})$`) }, (args) => ({ path: args.path, namespace: "cm" }));
    b.onLoad({ filter: /.*/, namespace: "cm" }, async (args) => {
      const name = args.path.replace("@codemirror/", "");
      const names = Object.keys(await import(args.path)).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n) && n !== "default");
      const contents = `const m = globalThis.__tesselaCm.${name};\nexport const { ${names.join(", ")} } = m;\n`;
      return { contents, loader: "js", resolveDir: root };
    });
  },
};

await build({
  entryPoints: Object.fromEntries(ids.map((id) => [`${id}/main`, join(source, id, "main.ts")])),
  outdir: join(root, "dist/mods"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  logLevel: "warning",
  plugins: [sharedCodeMirror],
});
