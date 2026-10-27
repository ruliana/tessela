// Calls the `tessela` command line tools. The editor uses the same tools as agents do,
// so what it shows is what they would find.

import { execFile } from "node:child_process";
import path from "node:path";

import type { QueryArgs } from "../shared/api";

export function queryArgv(bundle: string, q: QueryArgs): string[] {
  const argv = ["query", bundle, "--json"];
  for (const r of q.refs ?? []) argv.push("--ref", r);
  if (q.any) argv.push("--any");
  if (q.own) argv.push("--own");
  if (q.text !== undefined) argv.push("--text", q.text);
  if (q.type !== undefined) argv.push("--type", q.type);
  if (q.page !== undefined) argv.push("--page", q.page);
  if (q.from !== undefined) argv.push("--from", q.from);
  if (q.to !== undefined) argv.push("--to", q.to);
  if (q.limit !== undefined) argv.push("--limit", String(q.limit));
  return argv;
}

export function vocabArgv(bundle: string): string[] {
  return ["vocab", bundle, "--json"];
}

export function lintArgv(bundle: string): string[] {
  return ["lint", bundle, "--json"];
}

/**
 * Runs a tool and parses its JSON output. `okCodes` are exit codes that still come with
 * valid output: `tessela lint` exits with 1 when it finds errors.
 */
export function runJson<T>(bin: string, argv: string[], okCodes: number[] = []): Promise<T> {
  return new Promise((resolve, reject) => {
    execFile(bin, argv, { maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = typeof error?.code === "number" ? error.code : undefined;
      if (error && !(code !== undefined && okCodes.includes(code))) {
        reject(new Error(`${bin} ${argv[0]} failed: ${stderr.trim() || error.message}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as T);
      } catch {
        reject(new Error(`${bin} ${argv[0]} did not print JSON`));
      }
    });
  });
}

export interface BinLookup {
  env: string | undefined;
  /** Where a packaged app keeps its extra files; undefined when running from source. */
  resourcesPath: string | undefined;
  /** The folder with the editor's `package.json`; the Rust `target/` is next to it. */
  appPath: string;
  platform: NodeJS.Platform;
  exists: (file: string) => boolean;
}

/**
 * The tessela tool to run: `$TESSELA_BIN`, the one packaged with the app, a build
 * next to the editor, or whatever is on PATH.
 */
export function findTessela(l: BinLookup): string {
  if (l.env) return l.env;
  const exe = l.platform === "win32" ? "tessela.exe" : "tessela";
  const candidates = [
    ...(l.resourcesPath ? [path.join(l.resourcesPath, "bin", exe)] : []),
    ...["release", "debug"].map((profile) => path.resolve(l.appPath, "..", "target", profile, exe)),
  ];
  return candidates.find((c) => l.exists(c)) ?? "tessela";
}
