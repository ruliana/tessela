// Calls the `tessela` command line tools. The editor uses the same tools as agents do,
// so what it shows is what they would find.

import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";

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

export function pagesArgv(bundle: string): string[] {
  return ["pages", bundle, ...CALL];
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

export interface WatchOptions {
  /** Where a problem is reported; the editor keeps working without watching. */
  warn?: (message: string) => void;
  /** How long to wait before starting `tessela watch` again after it ended. */
  restartMs?: number;
}

/**
 * Tells `listener` which pages changed on disk, as `tessela watch` reports them. The tool does the
 * watching (the system's watcher, or looking at the files when that fails) and the grouping of
 * changes that come close together. It stops when this process does, and is started again if it
 * ends early. Returns a function that stops watching.
 */
export function watchVia(
  bin: string,
  bundle: string,
  listener: (paths: string[]) => void,
  { warn = console.warn, restartMs = 5000 }: WatchOptions = {},
): () => void {
  let stopped = false;
  let child: ReturnType<typeof spawn> | undefined;
  let timer: NodeJS.Timeout | undefined;

  const start = (): void => {
    const proc = spawn(bin, ["watch", bundle, ...CALL, "--exit-on-stdin-close"], { stdio: ["pipe", "pipe", "pipe"] });
    child = proc;
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
    createInterface({ input: proc.stdout! }).on("line", (line) => {
      let event: { event?: string; ok?: boolean; paths?: string[]; mode?: string; reason?: string; error?: { message?: string } };
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.ok === false) warn(`tessela watch: ${event.error?.message ?? "failed"}`);
      else if (event.event === "changed" && event.paths) listener(event.paths);
      else if (event.event === "mode" && event.mode === "polling") {
        warn(`cannot watch ${bundle}, looking at it every few seconds instead: ${event.reason ?? ""}`);
      }
    });
    // A tool that is missing or too old ends at once; try again later rather than in a tight loop.
    const ended = (why: string): void => {
      if (child !== proc) return;
      child = undefined;
      if (stopped) return;
      warn(`tessela watch ended (${why}); trying again in ${restartMs / 1000} s`);
      timer = setTimeout(start, restartMs);
    };
    proc.on("error", (err) => ended(err.message));
    proc.on("exit", (code) => ended(`exit ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    // Ending early closes the pipe; that is reported above.
    proc.stdin?.on("error", () => {});
  };

  start();
  return () => {
    stopped = true;
    clearTimeout(timer);
    child?.kill();
  };
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
export function runEdit<T>(bin: string, bundle: string, argv: string[], input: string | Uint8Array = ""): Promise<T | EditFailure> {
  return runCall(bin, [...argv, "--bundle", bundle, ...CALL], argv[0] ?? "", input);
}

/** Runs one `tessela` call whose answer is JSON on stdout, success or failure alike. */
function runCall<T>(bin: string, full: string[], name: string, input: string | Uint8Array): Promise<T | EditFailure> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, full, { maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      try {
        resolve(JSON.parse(stdout) as T | EditFailure);
      } catch {
        const text = stderr.trim() || error?.message || "it printed nothing";
        const old = /unrecognized subcommand|unexpected argument/.test(text);
        reject(
          new Error(
            old
              ? `The tessela tool is too old for this editor (it has no \`${name}\` command). Update it.`
              : `${bin} ${name} failed: ${text}`,
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

/** What a mod sent to a command's standard input: text or bytes, else nothing. */
export function cliInput(input: unknown): string | Uint8Array {
  if (typeof input === "string" || input instanceof Uint8Array) return input;
  return "";
}

/** The commands that take the folder as their first argument; the others take `--bundle`. */
const POSITIONAL = new Set(["lint", "query", "index", "vocab", "pages"]);

/**
 * Runs any `tessela` command for a mod, adding the folder, `--json` and the API version. The answer
 * is the command's `{api, ok, ...}` JSON as it is; a failure (`ok: false`) is a result, not an error.
 */
export function cliVia(bin: string, bundle: string, argv: string[], input: string | Uint8Array = ""): Promise<unknown> {
  const [command = "", ...rest] = argv;
  if (!POSITIONAL.has(command)) return runEdit(bin, bundle, argv, input);
  return runCall(bin, [command, bundle, ...rest, ...CALL], command, input);
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
