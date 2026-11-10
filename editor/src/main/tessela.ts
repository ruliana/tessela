// Calls the `tessela` command line tools. The editor uses the same tools as agents do,
// so what it shows is what they would find.

import { execFile } from "node:child_process";
import path from "node:path";

import type { PageFile, QueryArgs, WriteResult } from "../shared/api";

/** The version of the `tessela` edit commands this editor was written for. */
export const TESSELA_API = 2;

/** What every call says about itself: JSON answers, written for this version of the contract. */
const CALL = ["--json", "--api", String(TESSELA_API)];

export function queryArgv(bundle: string, q: QueryArgs): string[] {
  const argv = ["query", bundle, ...CALL];
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
  return ["vocab", bundle, ...CALL];
}

export function lintArgv(bundle: string): string[] {
  return ["lint", bundle, ...CALL];
}

/**
 * Runs a read command (`query`, `vocab`, `lint`, ...) and returns the list it answers with, found
 * under `key` of the `{"api", "ok", ...}` envelope. `okCodes` are exit codes that still come with
 * a valid answer: `tessela lint` exits with 1 when it finds errors.
 */
export function runJson<T>(bin: string, argv: string[], key: string, okCodes: number[] = []): Promise<T> {
  return new Promise((resolve, reject) => {
    execFile(bin, argv, { maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      let answer: { ok?: boolean; error?: { message?: string }; [key: string]: unknown } | undefined;
      try {
        answer = JSON.parse(stdout);
      } catch {
        // Reported below.
      }
      if (answer?.ok === false) {
        reject(new Error(`${bin} ${argv[0]} failed: ${answer.error?.message ?? "no reason given"}`));
        return;
      }
      const code = typeof error?.code === "number" ? error.code : undefined;
      if (error && !(code !== undefined && okCodes.includes(code))) {
        reject(new Error(`${bin} ${argv[0]} failed: ${stderr.trim() || error.message}`));
        return;
      }
      if (!answer || !(key in answer)) {
        reject(new Error(`${bin} ${argv[0]} did not print the expected JSON`));
        return;
      }
      resolve(answer[key] as T);
    });
  });
}

/** The error part of what the edit commands print when they fail. */
interface EditFailure {
  ok: false;
  error: { code: string; message: string; disk_hash?: string | null };
}

/**
 * Runs an edit command (`read`, `add`, `save`, ...), passing `input` on stdin. The tool prints
 * JSON on success and on failure, so a non-zero exit with JSON is a result, not a crash.
 */
export function runEdit<T>(bin: string, bundle: string, argv: string[], input = ""): Promise<T | EditFailure> {
  return new Promise((resolve, reject) => {
    const full = [...argv, "--bundle", bundle, "--json", "--api", String(TESSELA_API)];
    const child = execFile(bin, full, { maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      try {
        resolve(JSON.parse(stdout) as T | EditFailure);
      } catch {
        const text = stderr.trim() || error?.message || "it printed nothing";
        const old = /unrecognized subcommand|unexpected argument/.test(text);
        reject(
          new Error(
            old
              ? `The tessela tool is too old for this editor (it has no \`${argv[0]}\` command). Update it.`
              : `${bin} ${argv[0]} failed: ${text}`,
          ),
        );
      }
    });
    // A tool that exits before reading its input closes the pipe; that is reported above.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

function failure(argv0: string, f: EditFailure): Error {
  return new Error(`tessela ${argv0}: ${f.error.message}`);
}

/** The page as `tessela read` sees it; a page without a file comes with the template for one. */
export async function readPageVia(bin: string, bundle: string, rel: string): Promise<PageFile> {
  const r = await runEdit<{ ok: true; path: string; exists: boolean; text: string; hash: string | null }>(
    bin,
    bundle,
    ["read", rel],
  );
  if (!r.ok) throw failure("read", r);
  return { path: r.path, exists: r.exists, text: r.text, hash: r.hash };
}

/**
 * Saves a page with `tessela save`. It writes only when the file on disk still has `expectedHash`
 * (null: there must be no file yet); otherwise the answer is a conflict and nothing is written.
 */
export async function savePageVia(
  bin: string,
  bundle: string,
  rel: string,
  text: string,
  expectedHash: string | null,
): Promise<WriteResult> {
  const r = await runEdit<{ ok: true; hash: string }>(
    bin,
    bundle,
    ["save", rel, "--expect", expectedHash ?? "new"],
    text,
  );
  if (r.ok) return { ok: true, hash: r.hash };
  if (r.error.code === "conflict") return { ok: false, reason: "conflict", diskHash: r.error.disk_hash ?? null };
  throw failure("save", r);
}

/** Creates a page from the template with `tessela add`; false when the page already exists. */
export async function addPageVia(bin: string, bundle: string, rel: string, title?: string): Promise<boolean> {
  const argv = ["add", rel];
  if (title) argv.push(`--title=${title}`);
  const r = await runEdit<{ ok: true }>(bin, bundle, argv);
  if (r.ok) return true;
  if (r.error.code === "exists") return false;
  throw failure("add", r);
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
