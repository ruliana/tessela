// Property tests for smart paste: HTML to Markdown, where a pasted list lands, and the title
// upgrade. They run on text and on an editor state, with no window.

import { EditorState } from "@codemirror/state";
import { GFM, parser } from "@lezer/markdown";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { htmlToMarkdown } from "../src/shared/htmlToMarkdown";
import { normalizeList, place, planPaste, titleLink } from "../src/shared/paste";
import { tessela } from "../src/shared/syntax";
import { dropAddress, pendingAddresses, trackAddress, upgradeAddress } from "../src/renderer/pasteTitle";
import { runs } from "./support/props";

// ---------------------------------------------------------------- a small document model, written both ways

type Inline = { kind: "text" | "b" | "i" | "s" | "code" | "a"; text: string };
type Item = { inlines: Inline[]; sub: List | null };
interface List {
  ordered: boolean;
  items: Item[];
}
type Block =
  | { kind: "p"; inlines: Inline[] }
  | { kind: "h"; level: number; inlines: Inline[] }
  | { kind: "list"; list: List }
  | { kind: "pre"; lang: string; code: string }
  | { kind: "quote"; inlines: Inline[] };

const word = fc.stringMatching(/^[a-z]{1,6}$/);
const phrase = fc.array(word, { minLength: 1, maxLength: 3 }).map((w) => w.join(" "));
const inline: fc.Arbitrary<Inline> = fc.record({ kind: fc.constantFrom("text", "text", "b", "i", "s", "code", "a"), text: phrase });
const inlines = fc.array(inline, { minLength: 1, maxLength: 4 });

const item = (sub: fc.Arbitrary<List | null>): fc.Arbitrary<Item> => fc.record({ inlines, sub });
const flat: fc.Arbitrary<List> = fc.record({ ordered: fc.boolean(), items: fc.array(item(fc.constant(null)), { minLength: 1, maxLength: 3 }) });
const nested: fc.Arbitrary<List> = fc.record({ ordered: fc.boolean(), items: fc.array(item(fc.option(flat.chain((l) => fc.constant(l)), { nil: null })), { minLength: 1, maxLength: 3 }) });
const deeper: fc.Arbitrary<List> = fc.record({ ordered: fc.boolean(), items: fc.array(item(fc.option(nested, { nil: null })), { minLength: 1, maxLength: 3 }) });

const block: fc.Arbitrary<Block> = fc.oneof(
  fc.record({ kind: fc.constant("p" as const), inlines }),
  fc.record({ kind: fc.constant("h" as const), level: fc.integer({ min: 1, max: 6 }), inlines }),
  fc.record({ kind: fc.constant("list" as const), list: deeper }),
  fc.record({ kind: fc.constant("pre" as const), lang: fc.constantFrom("", "js", "rust"), code: fc.array(phrase, { minLength: 1, maxLength: 3 }).map((l) => l.join("\n")) }),
  fc.record({ kind: fc.constant("quote" as const), inlines }),
);
const doc = fc.array(block, { minLength: 1, maxLength: 4 });

const HREF = "https://example.com/x";
const mdInline = (i: Inline): string =>
  ({ text: i.text, b: `**${i.text}**`, i: `*${i.text}*`, s: `~~${i.text}~~`, code: `\`${i.text}\``, a: `[${i.text}](${HREF})` })[i.kind];
const htmlInline = (i: Inline): string =>
  ({ text: i.text, b: `<strong>${i.text}</strong>`, i: `<em>${i.text}</em>`, s: `<del>${i.text}</del>`, code: `<code>${i.text}</code>`, a: `<a href="${HREF}">${i.text}</a>` })[i.kind];

const indent = (text: string, first: string, rest: string) => text.split("\n").map((l, n) => (n === 0 ? first : rest) + l).join("\n");

function mdList(list: List): string {
  return list.items
    .map((it, n) => {
      const marker = list.ordered ? `${n + 1}. ` : "- ";
      const body = it.inlines.map(mdInline).join(" ") + (it.sub ? `\n${mdList(it.sub)}` : "");
      return indent(body, marker, " ".repeat(marker.length));
    })
    .join("\n");
}
const htmlList = (list: List): string =>
  `<${list.ordered ? "ol" : "ul"}>${list.items.map((it) => `<li>${it.inlines.map(htmlInline).join(" ")}${it.sub ? htmlList(it.sub) : ""}</li>`).join("")}</${list.ordered ? "ol" : "ul"}>`;

const toMd = (b: Block): string => {
  switch (b.kind) {
    case "p": return b.inlines.map(mdInline).join(" ");
    case "h": return `${"#".repeat(b.level)} ${b.inlines.map(mdInline).join(" ")}`;
    case "list": return mdList(b.list);
    case "pre": return `\`\`\`${b.lang}\n${b.code}\n\`\`\``;
    case "quote": return `> ${b.inlines.map(mdInline).join(" ")}`;
  }
};
const toHtml = (b: Block): string => {
  switch (b.kind) {
    case "p": return `<p>${b.inlines.map(htmlInline).join(" ")}</p>`;
    case "h": return `<h${b.level}>${b.inlines.map(htmlInline).join(" ")}</h${b.level}>`;
    case "list": return htmlList(b.list);
    case "pre": return `<pre><code class="language-${b.lang}">${b.code}</code></pre>`.replace('class="language-"', "");
    case "quote": return `<blockquote><p>${b.inlines.map(htmlInline).join(" ")}</p></blockquote>`;
  }
};

describe("HTML to Markdown", () => {
  it("writes the Markdown a page of lists, headings, marks, code and quotes was written as", () => {
    fc.assert(
      fc.property(doc, (blocks) => {
        const html = `<meta charset='utf-8'><!--StartFragment-->${blocks.map(toHtml).join("\n")}<!--EndFragment-->`;
        expect(htmlToMarkdown(html).markdown).toBe(blocks.map(toMd).join("\n\n"));
      }),
      runs(300),
    );
  });

  it("a pasted list keeps its nesting: each item sits under the one it was under", () => {
    fc.assert(
      fc.property(deeper, (list) => {
        const out = htmlToMarkdown(htmlList(list));
        expect(out.rich).toBe(true);
        expect(out.markdown).toBe(mdList(list));
        // The same list read back by the page parser nests the same way.
        const depth = (l: List): number => 1 + Math.max(0, ...l.items.map((i) => (i.sub ? depth(i.sub) : 0)));
        let level = 0;
        let max = 0;
        parser.configure([GFM, ...tessela]).parse(out.markdown).iterate({
          enter(n) {
            if (n.name === "BulletList" || n.name === "OrderedList") max = Math.max(max, ++level);
          },
          leave(n) {
            if (n.name === "BulletList" || n.name === "OrderedList") level--;
          },
        });
        expect(max).toBe(depth(list));
      }),
      runs(100),
    );
  });

  const text = fc.stringMatching(/^[a-z0-9 .\-+#>*_`[\]()<>!~|$&\\:/;=]{1,24}$/).map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s !== "");
  const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  it("text comes out as the same text: whatever Markdown would read as something else is escaped", () => {
    const p = parser.configure([GFM, ...tessela]);
    fc.assert(
      fc.property(text, (t) => {
        const md = htmlToMarkdown(`<p>${escapeHtml(t)}</p>`).markdown;
        const tree = p.parse(md);
        const escapes: number[] = [];
        const names = new Set<string>();
        tree.iterate({
          enter(n) {
            names.add(n.name);
            if (n.name === "Escape") escapes.push(n.from);
          },
        });
        // One paragraph and escapes: no emphasis, link, code, list, heading, quote, tag, entity or math came out of plain words.
        expect([...names].filter((n) => !["Document", "Paragraph", "Escape"].includes(n))).toEqual([]);
        let plain = md;
        for (const at of escapes.reverse()) plain = plain.slice(0, at) + plain.slice(at + 1);
        expect(plain).toBe(t);
      }),
      runs(500),
    );
  });
});

// ---------------------------------------------------------------- where a pasted list lands

const listText = fc
  .array(fc.tuple(fc.integer({ min: 0, max: 3 }), word), { minLength: 1, maxLength: 6 })
  .map((rows) => rows.map(([depth, w]) => `${"  ".repeat(depth)}- ${w}`).join("\n"));

describe("a pasted list", () => {
  it("over an empty item takes that item's place and nests from there", () => {
    fc.assert(
      fc.property(listText, fc.integer({ min: 0, max: 4 }), fc.constantFrom("", "> "), fc.constantFrom("- ", "* ", "1. ", "- [ ] "), (list, depth, quote, marker) => {
        const lead = quote + " ".repeat(depth * 2);
        const { back, insert } = place(lead + marker, list);
        expect(back).toBe(marker.length);
        const line = (lead + marker).slice(0, lead.length + marker.length - back) + insert;
        const want = list.split("\n").map((l) => lead + l).join("\n");
        expect(line).toBe(want);
      }),
      runs(200),
    );
  });

  it("anywhere else keeps its lines, each indented to the line it lands on", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 12 }).map((s) => s.replace(/\n/g, "")), fc.array(fc.string({ maxLength: 8 }).map((s) => s.replace(/\n/g, "")), { minLength: 1, maxLength: 4 }), (before, lines) => {
        const text = lines.join("\n");
        const { back, insert } = place(before, text);
        // What the paste adds is only leading whitespace and quote marks on the lines after the first.
        const out = insert.split("\n");
        expect(out.length).toBe(lines.length);
        out.forEach((l, n) => {
          if (n === 0) expect(l).toBe(back > 0 ? l : lines[0]);
          else expect(l.trim() === "" ? lines[n]!.trim() === "" : l.endsWith(lines[n]!)).toBe(true);
        });
      }),
      runs(200),
    );
  });

  it("indented with tabs becomes indented with spaces, and means the same nesting", () => {
    fc.assert(
      fc.property(listText, (list) => {
        const tabbed = list.replace(/^( +)/gm, (sp) => "\t".repeat(sp.length / 2));
        expect(normalizeList(tabbed)).toBe(list);
      }),
      runs(100),
    );
  });

  it("is left alone when it is not all a list", () => {
    expect(normalizeList("\t- a\nand then\n- b")).toBe("\t- a\nand then\n- b");
  });
});

// ---------------------------------------------------------------- the plan

const input = (over: Partial<Parameters<typeof planPaste>[0]>) => ({ plain: "", html: "", types: [], hasFiles: false, selected: "", before: "", inCode: false, inLink: false, ...over });

describe("the paste plan", () => {
  const url = fc.stringMatching(/^[a-z]{2,8}$/).map((h) => `https://${h}.example.com/path`);

  it("a bare address stays as it is and asks for its title; selected words become its link", () => {
    fc.assert(
      fc.property(url, phrase, (u, words) => {
        expect(planPaste(input({ plain: `${u}\n`, before: "see " }))).toEqual({ back: 0, insert: u, title: u });
        expect(planPaste(input({ plain: u, selected: words }))).toEqual({ back: 0, insert: `[${words}](${u})`, title: null });
      }),
      runs(100),
    );
  });

  it("an address on this computer is not asked for a title, and nor is one in a link", () => {
    for (const u of ["http://localhost:3000/a", "http://192.168.1.5/a", "http://10.0.0.1/", "http://127.0.0.1/", "http://intranet/wiki", "https://user:pw@example.com/"]) {
      expect(planPaste(input({ plain: u }))?.title, u).toBeNull();
    }
    expect(planPaste(input({ plain: "https://example.com/", inLink: true }))?.title).toBeNull();
  });

  it("leaves code, files and plain words to the ordinary paste", () => {
    expect(planPaste(input({ plain: "https://example.com", inCode: true }))).toBeNull();
    expect(planPaste(input({ plain: "", html: '<img src="https://e.com/a.png">', hasFiles: true }))).toBeNull();
    expect(planPaste(input({ plain: "just some words", html: "<span style='color:red'>just some words</span>" }))).toBeNull();
    expect(planPaste(input({ plain: "one\ntwo", html: "<div>one</div><div>two</div>", before: "" }))).toBeNull();
    expect(planPaste(input({ plain: "const x = 1;", html: "<b>const</b> x = 1;", types: ["text/plain", "text/html", "vscode-editor-data"] }))).toBeNull();
  });

  it("HTML that says more than the plain text is written as Markdown, and the plain text is not read", () => {
    fc.assert(
      fc.property(doc, fc.string(), (blocks, plain) => {
        const html = blocks.map(toHtml).join("");
        const conv = htmlToMarkdown(html);
        fc.pre(conv.rich);
        const plan = planPaste(input({ plain, html }));
        expect(plan?.insert).toBe(place("", normalizeList(conv.markdown)).insert);
        expect(plan?.title).toBeNull();
      }),
      runs(100),
    );
  });
});

// ---------------------------------------------------------------- the title upgrade

const URL_ = "https://example.com/some/page";

function started(before: string, after: string, cursorAtEnd: boolean) {
  const text = before + URL_ + after;
  const from = before.length;
  const to = from + URL_.length;
  let state = EditorState.create({ doc: text, extensions: [pendingAddresses], selection: { anchor: cursorAtEnd ? to : 0 } });
  state = state.update({ effects: trackAddress.of({ id: 1, from, to, url: URL_ }) }).state;
  return state;
}

const edit = fc.record({ side: fc.constantFrom("before", "after"), at: fc.double({ min: 0, max: 1, noNaN: true }), cut: fc.double({ min: 0, max: 1, noNaN: true }), insert: fc.string({ maxLength: 5 }).map((s) => s.replace(/\r/g, "")) });

describe("upgrading a pasted address to a titled link", () => {
  const around = fc.string({ maxLength: 20 }).map((s) => s.replace(/\r/g, ""));

  it("lands on the address however the text around it changed, as one change that keeps the cursor with it", () => {
    fc.assert(
      fc.property(around, around, fc.boolean(), fc.array(edit, { maxLength: 6 }), phrase, (before, after, atEnd, edits, title) => {
        let state = started(before, after, atEnd);
        for (const e of edits) {
          const [p] = state.field(pendingAddresses);
          const len = state.doc.length;
          const [lo, hi] = e.side === "before" ? [0, p!.from] : [p!.to, len];
          const from = lo + Math.floor(e.at * (hi - lo));
          const to = Math.min(hi, from + Math.floor(e.cut * 4));
          state = state.update({ changes: { from, to, insert: e.insert } }).state;
        }
        const [p] = state.field(pendingAddresses);
        const spec = upgradeAddress(state, 1, title)!;
        const next = state.update(spec).state;
        const link = titleLink(title, URL_);
        expect(next.doc.toString()).toBe(state.sliceDoc(0, p!.from) + link + state.sliceDoc(p!.to));
        expect(next.field(pendingAddresses)).toEqual([]);
        if (atEnd && edits.length === 0) expect(next.selection.main.head).toBe(p!.from + link.length);
      }),
      runs(300),
    );
  });

  it("does nothing when the address itself was edited or deleted", () => {
    fc.assert(
      fc.property(around, around, fc.integer({ min: 0, max: URL_.length - 1 }), fc.integer({ min: 1, max: 4 }), fc.boolean(), (before, after, at, cut, removeAll) => {
        let state = started(before, after, false);
        const from = before.length + (removeAll ? 0 : at);
        const to = removeAll ? before.length + URL_.length : Math.min(before.length + URL_.length, from + cut);
        state = state.update({ changes: { from, to, insert: removeAll ? "" : "X" } }).state;
        const spec = upgradeAddress(state, 1, "Title");
        expect(spec?.changes).toBeUndefined();
        const next = state.update(spec ?? {}).state;
        expect(next.doc.toString()).toBe(state.doc.toString());
      }),
      runs(200),
    );
  });

  it("is not done twice, and a title that never came lets go of the address", () => {
    const state = started("a ", " b", true);
    const once = state.update(upgradeAddress(state, 1, "T")!).state;
    expect(upgradeAddress(once, 1, "T")).toBeNull();
    expect(state.update({ effects: dropAddress.of(1) }).state.field(pendingAddresses)).toEqual([]);
    expect(upgradeAddress(state, 1, "  ")?.changes).toBeUndefined();
  });
});
