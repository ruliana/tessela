// The window's way to Jev. The key lives in the config folder's settings.json and stays in this
// process: the window asks, this calls the service and hands back the answers.
//
//   { "jev": { "key": "...", "baseUrl": "https://api.typesafe.ai", "model": "jev-latest" } }
//
// Only `key` is needed. `baseUrl` points at another service that speaks the same API (OpenRouter is
// `https://openrouter.ai/api`, with `"model": "typesafe/jev-1.14"`). Without a key every Jev feature is off.

import { readFileSync } from "node:fs";
import path from "node:path";

import { type JevResult, cleanAnswers, isJevRequest } from "../shared/jev";

export const DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_MODEL = "jev-latest";
export const JEV_TIMEOUT_MS = 10_000;

export interface JevConfig {
  key: string;
  /** Without a trailing slash. */
  baseUrl: string;
  model: string;
}

/** The Jev settings of the config folder: null without a key, or when settings.json is missing or unreadable. */
export function jevIn(folder: string): JevConfig | null {
  let saved: { key?: unknown; baseUrl?: unknown; model?: unknown } = {};
  try {
    const jev = (JSON.parse(readFileSync(path.join(folder, "settings.json"), "utf8")) as { jev?: unknown }).jev;
    if (typeof jev === "object" && jev !== null) saved = jev;
  } catch {
    return null;
  }
  const key = typeof saved.key === "string" ? saved.key.trim() : "";
  if (key === "") return null;
  const base = typeof saved.baseUrl === "string" ? saved.baseUrl.trim().replace(/\/+$/, "") : "";
  const model = typeof saved.model === "string" ? saved.model.trim() : "";
  return { key, baseUrl: /^https?:\/\//i.test(base) ? base : DEFAULT_BASE_URL, model: model === "" ? DEFAULT_MODEL : model };
}

type Fetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>;

/** Asks Jev the questions of `request` (see `Api.jev`). A failure is a result, never a throw. */
export async function askJev(config: JevConfig | null, request: unknown, fetchImpl: Fetch, signal: AbortSignal, timeoutMs = JEV_TIMEOUT_MS): Promise<JevResult> {
  if (config === null) return { ok: false, error: "no Jev key" };
  if (!isJevRequest(request)) return { ok: false, error: "not a Jev request" };
  const abort = new AbortController();
  const stop = () => abort.abort();
  if (signal.aborted) return { ok: false, error: "cancelled" };
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, timeoutMs);
  try {
    const res = await fetchImpl(`${config.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.key}` },
      body: JSON.stringify({ model: config.model, state: request.state, questions: request.questions }),
      signal: abort.signal,
    });
    if (!res.ok) return { ok: false, error: `Jev answered ${res.status}` };
    const body = (await res.json()) as { answers?: unknown };
    return { ok: true, answers: cleanAnswers(body.answers) };
  } catch {
    return { ok: false, error: signal.aborted ? "cancelled" : abort.signal.aborted ? "Jev did not answer in time" : "Jev could not be reached" };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}
