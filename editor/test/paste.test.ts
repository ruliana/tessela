// Smart paste on real clipboard HTML, and the page-title lookup. The properties are in
// props.paste.test.ts; these are the shapes that browsers and office programs actually send.

import { describe, expect, it } from "vitest";

import { isPublicWebUrl, pageTitle } from "../src/shared/htmlText";
import { htmlToMarkdown } from "../src/shared/htmlToMarkdown";
import { fetchTitle } from "../src/main/title";

const md = (html: string) => htmlToMarkdown(html).markdown;

describe("clipboard HTML from real programs", () => {
  it("Google Docs: a wrapper with normal weight, styled spans for marks, nested lists beside their item", () => {
    const html =
      `<meta charset='utf-8'><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span style="font-weight:700">Bold</span>` +
      `<span style="font-weight:400"> and </span><span style="font-style:italic">slanted</span></p>` +
      `<ul><li aria-level="1"><p>one</p></li><ul><li aria-level="2"><p>two</p></li></ul><li><p>three</p></li></ul></b>`;
    expect(md(html)).toBe("**Bold** and *slanted*\n\n- one\n  - two\n- three");
  });

  it("a browser: spans with styles around plain words are plain words", () => {
    const html = `<meta charset='utf-8'><span style="color: rgb(0, 0, 0); font-weight: 400; font-style: normal;">just words</span>`;
    expect(htmlToMarkdown(html)).toEqual({ markdown: "just words", rich: false });
  });

  it("a link whose text is its address is the address, so the title can still be asked for", () => {
    expect(htmlToMarkdown(`<a href="https://example.com/a">https://example.com/a</a>`)).toEqual({ markdown: "https://example.com/a", rich: false });
    expect(md(`<a href="https://example.com/a?x=(1)">here</a> and <a href="#top">top</a>`)).toBe("[here](https://example.com/a?x=%281%29) and top");
  });

  it("tables, task items, code and images", () => {
    expect(md(`<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1|2</td><td><b>x</b><br>y</td></tr></tbody></table>`)).toBe(
      "| A | B |\n| --- | --- |\n| 1\\|2 | **x**<br>y |",
    );
    expect(md(`<ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> todo</li></ul>`)).toBe("- [x] done\n- [ ] todo");
    expect(md(`<pre class="language-ts"><code>let a = \`x\`;\n</code></pre>`)).toBe("```ts\nlet a = `x`;\n```");
    expect(md(`<pre>a \`\`\` b</pre>`)).toBe("````\na ``` b\n````");
    expect(md(`<p>use <code>a\`b</code> and <img src="https://e.com/p.png" alt="pic"> and <img src="data:image/png;base64,AAAA" alt="inline"></p>`)).toBe("use ``a`b`` and ![pic](https://e.com/p.png) and inline");
  });

  it("marks hug the words and spaces stay outside; a table that only lays out a page is just its content", () => {
    expect(md(`<p>a<b> bold </b>b <i></i>c</p>`)).toBe("a **bold** b c");
    expect(md(`<table><tr><td><p>one</p><p>two</p></td></tr></table>`)).toBe("one\n\ntwo");
  });

  it("words that look like Markdown are escaped, so a quoted `1. ` or `- ` is not a list", () => {
    expect(md(`<p>1. not</p><p>- nor</p><p># nor</p><p>3 * 4 and a_b and _c</p>`)).toBe("1\\. not\n\n\\- nor\n\n\\# nor\n\n3 \\* 4 and a_b and \\_c");
  });

  it("drops what is not content: scripts, styles, comments", () => {
    expect(md(`<style>p{}</style><!--x--><script>alert(1)</script><h3>Hi &amp; bye&nbsp;now</h3>`)).toBe("### Hi & bye now");
  });
});

describe("page titles", () => {
  it("come from the title, else og:title, tidied and cut", () => {
    expect(pageTitle("<head><title>\n  A &amp; B — Site\n</title>")).toBe("A & B — Site");
    expect(pageTitle(`<head><meta property="og:title" content="Only OG"></head>`)).toBe("Only OG");
    expect(pageTitle("<head><title> </title></head>")).toBeNull();
    expect(pageTitle(`<title>${"x".repeat(300)}</title>`)?.length).toBe(200);
  });

  it("are asked for only from public web addresses", () => {
    for (const u of ["https://example.com/a", "http://93.184.216.34/"]) expect(isPublicWebUrl(u), u).toBe(true);
    for (const u of ["ftp://example.com", "file:///etc/passwd", "http://localhost/", "http://[::1]/", "http://172.16.0.1/", "http://169.254.169.254/", "http://nas/", "not a url"]) {
      expect(isPublicWebUrl(u), u).toBe(false);
    }
  });
});

describe("fetching a title", () => {
  const page = (body: string[], init: ResponseInit = { headers: { "content-type": "text/html; charset=utf-8" } }) => {
    const enc = new TextEncoder();
    return new Response(new ReadableStream({ start(c) { for (const part of body) c.enqueue(enc.encode(part)); c.close(); } }), init);
  };
  const returning = (res: () => Response) => {
    const calls: string[] = [];
    return { calls, fetch: async (url: string) => (calls.push(url), res()) };
  };

  it("reads the title even when it arrives in pieces, and stops at the end of the head", async () => {
    const f = returning(() => page(["<html><head><ti", "tle>Hel", "lo</title></head><body>", "x".repeat(1000)]));
    expect(await fetchTitle("https://example.com/", f.fetch)).toBe("Hello");
  });

  it("gives null for a page that is not HTML, has no title, or fails", async () => {
    expect(await fetchTitle("https://example.com/", returning(() => page(["{}"], { headers: { "content-type": "application/json" } })).fetch)).toBeNull();
    expect(await fetchTitle("https://example.com/", returning(() => page(["<p>no title</p>"])).fetch)).toBeNull();
    expect(await fetchTitle("https://example.com/", returning(() => page(["<title>x</title>"], { status: 404, headers: { "content-type": "text/html" } })).fetch)).toBeNull();
    expect(await fetchTitle("https://example.com/", async () => { throw new Error("offline"); })).toBeNull();
  });

  it("does not wait for a slow page", async () => {
    const hang = (_url: string, init: { signal: AbortSignal }) => new Promise<Response>((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const started = Date.now();
    expect(await fetchTitle("https://example.com/", hang, 30)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("does not ask about this computer or other programs' addresses", async () => {
    const f = returning(() => page(["<title>secret</title>"]));
    for (const u of ["http://localhost:8080/", "http://10.0.0.2/admin", "file:///etc/hosts", 42]) expect(await fetchTitle(u, f.fetch)).toBeNull();
    expect(f.calls).toEqual([]);
  });
});
