// Builds the tessela command line tool and copies it to resources/bin, so the packaged
// app carries the same tool the editor uses behind the scenes (see main/tessela.ts).
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const editor = resolve(import.meta.dirname, "..");
const repo = resolve(editor, "..");
const exe = process.platform === "win32" ? "tessela.exe" : "tessela";

// A CI job that builds for another target passes the Rust target triple.
const target = process.env.TESSELA_TARGET;
const args = ["build", "--release", "-p", "tessela-cli", ...(target ? ["--target", target] : [])];
execFileSync("cargo", args, { cwd: repo, stdio: "inherit" });

const built = resolve(repo, "target", ...(target ? [target] : []), "release", exe);
const out = resolve(editor, "resources", "bin");
mkdirSync(out, { recursive: true });
copyFileSync(built, resolve(out, exe));
console.log(`copied ${built} to ${out}`);
