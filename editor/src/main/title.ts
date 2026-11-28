// Asks a web page for its title, for the editor's smart paste. Short on purpose: a page that does
// not answer in a few seconds keeps its address as pasted. Only the start of the page is read.

import { isPublicWebUrl, pageTitle } from "../shared/htmlText";

export const TITLE_TIMEOUT_MS = 4000;
const MAX_BYTES = 256 * 1024;

type Fetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string>; redirect: "follow" }) => Promise<Response>;

/** The title of the page at `url`, or null when there is none, the page is not HTML, it is slow, or the address is not a public web page. */
export async function fetchTitle(url: unknown, fetchImpl: Fetch, timeoutMs = TITLE_TIMEOUT_MS): Promise<string | null> {
  if (typeof url !== "string" || !isPublicWebUrl(url)) return null;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: abort.signal, headers: { accept: "text/html,application/xhtml+xml", "user-agent": "Mozilla/5.0 (compatible; Tessela)" }, redirect: "follow" });
    const type = res.headers.get("content-type") ?? "text/html";
    if (!res.ok || !/html/i.test(type) || res.body === null) return null;
    const charset = /charset=["']?([\w-]+)/i.exec(type)?.[1];
    let decoder: TextDecoder;
    try {
      decoder = new TextDecoder(charset ?? "utf-8");
    } catch {
      decoder = new TextDecoder();
    }
    const reader = res.body.getReader();
    let text = "";
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      text += decoder.decode(value, { stream: true });
      // The title is in the head; stop once it is closed or the head is over.
      if (/<\/title\s*>|<\/head\s*>|<body[\s>]/i.test(text) || bytes >= MAX_BYTES) break;
    }
    void reader.cancel().catch(() => undefined);
    return pageTitle(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
