// Small readers for HTML text, shared by the paste conversion and the page-title lookup.

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·", times: "×", euro: "€", pound: "£", deg: "°",
};

/** Replaces the character references of HTML (`&amp;`, `&#8212;`, `&#x2014;`). Unknown names stay as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,8}));/g, (all, dec?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED[name] ?? all;
    const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex!, 16);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : all;
  });
}

/** What a page calls itself: its `<title>`, else its `og:title`, with spaces tidied, or null. */
export function pageTitle(html: string): string | null {
  const title = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1];
  const og = /<meta\s[^>]*(?:property|name)\s*=\s*["']og:title["'][^>]*>/i.exec(html)?.[0];
  const ogContent = og === undefined ? undefined : /content\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(og)?.[1] ?? /content\s*=\s*'([^']*)'/i.exec(og)?.[1];
  for (const raw of [title, ogContent]) {
    const tidy = raw === undefined ? "" : decodeEntities(raw).replace(/\s+/g, " ").trim();
    if (tidy !== "") return tidy.length > 200 ? `${tidy.slice(0, 199).trimEnd()}…` : tidy;
  }
  return null;
}

/** An address whose page may be asked for a title: a web address that does not name this computer or a private network. */
export function isPublicWebUrl(address: string): boolean {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".") && !host.includes(":")) return false;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224);
  }
  if (host.includes(":")) return false;
  return true;
}
