// The window's way to Jev. The key lives in the config folder's settings.json and stays in this
// process: the window asks, this calls the service and hands back the answers.
//
//   { "jev": { "key": "...", "baseUrl": "https://api.typesafe.ai", "model": "jev-latest" } }
//
// Jev is on when `key` or `baseUrl` is set. `baseUrl` points at another service that speaks the same API
// (OpenRouter is `https://openrouter.ai/api`, with `"model": "typesafe/jev-1.14"`); a proxy that holds the
// key itself needs only that, and the call then carries no authorization. With neither, every Jev feature
// is off. At startup `checkJev` says whether the service answers.

import { readFileSync } from "node:fs";
import path from "node:path";

import { type JevResult, cleanAnswers, isJevRequest } from "../shared/jev";

export const DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_MODEL = "jev-latest";
export const JEV_TIMEOUT_MS = 10_000;

export interface JevConfig {
  /** Empty when the service holds the key itself (a proxy). */
  key: string;
  /** Without a trailing slash. */
  baseUrl: string;
  model: string;
}

/** The Jev settings of the config folder: null with neither a key nor an address, or when settings.json is missing or unreadable. */
export function jevIn(folder: string): JevConfig | null {
  let saved: { key?: unknown; baseUrl?: unknown; model?: unknown } = {};
  try {
    const jev = (JSON.parse(readFileSync(path.join(folder, "settings.json"), "utf8")) as { jev?: unknown }).jev;
    if (typeof jev === "object" && jev !== null) saved = jev;
  } catch {
    return null;
  }
  const key = typeof saved.key === "string" ? saved.key.trim() : "";
  const base = typeof saved.baseUrl === "string" ? saved.baseUrl.trim().replace(/\/+$/, "") : "";
  const address = /^https?:\/\//i.test(base) ? base : "";
  if (key === "" && address === "") return null;
  const model = typeof saved.model === "string" ? saved.model.trim() : "";
  return { key, baseUrl: address === "" ? DEFAULT_BASE_URL : address, model: model === "" ? DEFAULT_MODEL : model };
}

type Fetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>;
type Probe = (url: string, init: { method: "GET"; headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

/**
 * Whether the configured service answers: null when Jev is not configured, else ok or why not. It asks
 * the endpoint with a GET, which a service that is up answers with anything but a server error, a refusal
 * of the key, or "not found" (it expects a POST); no question is asked and no model is run.
 */
export async function checkJev(config: JevConfig | null, fetchImpl: Probe, signal: AbortSignal, timeoutMs = JEV_TIMEOUT_MS): Promise<{ ok: true } | { ok: false; error: string } | null> {
  if (config === null) return null;
  const at = config.baseUrl;
  const abort = new AbortController();
  const stop = () => abort.abort();
  if (signal.aborted) return { ok: false, error: "cancelled" };
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, timeoutMs);
  try {
    const res = await fetchImpl(`${at}/v1/systemone`, { method: "GET", headers: config.key === "" ? {} : { authorization: `Bearer ${config.key}` }, signal: abort.signal });
    if (res.status === 401 || res.status === 403) return { ok: false, error: config.key === "" ? `Jev at ${at} needs a key` : `Jev at ${at} refused the key` };
    if (res.status === 404) return { ok: false, error: `Jev was not found at ${at}` };
    if (res.status >= 500) return { ok: false, error: `Jev at ${at} answered ${res.status}` };
    return { ok: true };
  } catch {
    return { ok: false, error: signal.aborted ? "cancelled" : abort.signal.aborted ? `Jev at ${at} did not answer in time` : `Jev could not be reached at ${at}` };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}

/** Asks Jev the questions of `request` (see `Api.jev`). A failure is a result, never a throw. */
export async function askJev(config: JevConfig | null, request: unknown, fetchImpl: Fetch, signal: AbortSignal, timeoutMs = JEV_TIMEOUT_MS): Promise<JevResult> {
  if (config === null) return { ok: false, error: "Jev is not configured" };
  if (!isJevRequest(request)) return { ok: false, error: "not a Jev request" };
  const abort = new AbortController();
  const stop = () => abort.abort();
  if (signal.aborted) return { ok: false, error: "cancelled" };
  signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, timeoutMs);
  try {
    const res = await fetchImpl(`${config.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: config.key === "" ? { "content-type": "application/json" } : { "content-type": "application/json", authorization: `Bearer ${config.key}` },
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
