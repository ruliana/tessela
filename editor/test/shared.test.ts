import { describe, expect, it } from "vitest";

import type { Diagnostic, VocabEntry } from "../src/shared/api";
import { slugFirst, suggest } from "../src/shared/complete";
import { conceptAt, linkTargetId, refsInLine } from "../src/shared/links";
import { summary, visibleProblems } from "../src/shared/problems";
import { excerpt, searchable } from "../src/shared/search";
import { conceptPath, isJournalPath, localDay, newPageText } from "../src/shared/pages";
import { smartLink } from "../src/shared/smartLink";

describe("smartLink", () => {
  it("puts a URL or path in the target and leaves the cursor in the text", () => {
    expect(smartLink("https://example.com")).toEqual({
      text: "[](https://example.com)",
      cursor: 1,
      inTarget: false,
    });
    expect(smartLink("/project/tessela.md").text).toBe("[](/project/tessela.md)");
    expect(smartLink("../notes/a.md").cursor).toBe(1);
  });

  it("makes other text the link text and leaves the cursor in the target", () => {
    const edit = smartLink("the editor");
    expect(edit.text).toBe("[the editor]()");
    expect(edit.text.slice(0, edit.cursor)).toBe("[the editor](");
    expect(edit.inTarget).toBe(true);
  });

  it("with nothing selected makes an empty link with the cursor in the text", () => {
    expect(smartLink("")).toEqual({ text: "[]()", cursor: 1, inTarget: false });
  });
});

describe("references", () => {
  it("finds tags and concept links, not URLs, code-ish or word-internal hashes", () => {
    const refs = refsInLine("Met #project/Tessela and [x](/people/ana.md), see [w](https://a.b/c.md) a#b #123", "");
    expect(refs.map((r) => [r.kind, r.id])).toEqual([
      ["tag", "project/tessela"],
      ["link", "people/ana"],
    ]);
  });

  it("resolves relative link targets against the page folder", () => {
    expect(linkTargetId("../people/Ana.md", "project")).toBe("people/ana");
    expect(linkTargetId("x.md#top", "a/b")).toBe("a/b/x");
    expect(linkTargetId("pic.png", "")).toBeNull();
  });

  it("finds the concept under a column", () => {
    const line = "text #rust here";
    expect(conceptAt(line, 7, "")?.id).toBe("rust");
    expect(conceptAt(line, 1, "")).toBeNull();
  });
});

describe("pages", () => {
  it("turns names into concept paths", () => {
    expect(conceptPath("#Project / My Tessela")).toBe("project/my-tessela.md");
  });

  it("knows journals and today's date", () => {
    expect(isJournalPath("journals/2026-10-27.md")).toBe(true);
    expect(isJournalPath("project/journals/2026-10-27.md")).toBe(false);
    expect(localDay(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("starts new pages with frontmatter that has a type", () => {
    expect(newPageText("journals/2026-10-27.md")).toContain("type: journal");
    expect(newPageText("journals/2026-10-27.md")).toContain('date: "2026-10-27"');
    expect(newPageText("project/my-tessela.md")).toContain('title: "my tessela"');
  });
});

describe("suggest", () => {
  const entry = (concept: string, mentions: number, extra: Partial<VocabEntry> = {}): VocabEntry => ({
    concept,
    has_page: true,
    mentions,
    pages: 1,
    deprecated: false,
    use_instead: null,
    note: null,
    ...extra,
  });
  const vocab = [
    entry("project/tessela", 3),
    entry("rust", 9),
    entry("trust", 1),
    entry("task", 5, { use_instead: "todo" }),
    entry("todo", 2, { has_page: false }),
  ];

  it("ranks prefix matches before contains, then by use", () => {
    expect(suggest(vocab, "#r").map((s) => s.concept)).toEqual(["rust", "project/tessela", "trust"]);
  });

  it("leaves out aliases and says when a page is missing", () => {
    expect(suggest(vocab, "t").map((s) => s.concept)).not.toContain("task");
    expect(suggest(vocab, "todo")[0]?.detail).toBe("2 mentions, no page yet");
  });
});

describe("problems", () => {
  const d = (severity: Diagnostic["severity"], path: string, line: number | null): Diagnostic => ({
    rule: "x",
    severity,
    path,
    line,
    message: "m",
  });

  it("hides info and puts errors first", () => {
    const list = visibleProblems([d("warning", "a.md", 1), d("info", "z.md", 1), d("error", "b.md", 3), d("error", "b.md", 2)]);
    expect(list.map((p) => `${p.severity} ${p.path}:${p.line}`)).toEqual([
      "error b.md:2",
      "error b.md:3",
      "warning a.md:1",
    ]);
  });

  it("summarizes the counts", () => {
    expect(summary([])).toBe("No problems");
    expect(summary([d("error", "a.md", 1), d("warning", "a.md", 1), d("warning", "a.md", 2)])).toBe(
      "1 error, 2 warnings",
    );
  });
});

describe("search", () => {
  it("ignores a single character", () => {
    expect(searchable(" a ")).toBeNull();
    expect(searchable(" ab ")).toBe("ab");
  });

  it("cuts a long text around the match", () => {
    const text = `${"lorem ".repeat(40)}needle ${"ipsum ".repeat(40)}`;
    const out = excerpt(text, "needle");
    expect(out).toContain("needle");
    expect(out.length).toBeLessThan(160);
    expect(out.startsWith("…")).toBe(true);
    expect(excerpt("short text", "x")).toBe("short text");
  });
});

describe("slugFirst", () => {
  const items = [
    { concept: "rust", detail: "3 mentions" },
    { concept: "some-text", detail: "1 mention" },
  ];

  it("offers the slug of the link text first when it is new", () => {
    expect(slugFirst(items, "Other Words").map((s) => s.concept)).toEqual(["other-words", "rust", "some-text"]);
    expect(slugFirst(items, "Other Words")[0]?.detail).toBe("new page");
  });

  it("moves an existing concept to the top instead of listing it twice", () => {
    expect(slugFirst(items, "Some text").map((s) => s.concept)).toEqual(["some-text", "rust"]);
    expect(slugFirst(items, "Some text")[0]?.detail).toBe("1 mention");
  });

  it("leaves the list alone when there is no text, or when what was typed rules the slug out", () => {
    expect(slugFirst(items, "  ")).toBe(items);
    expect(slugFirst(items, "Other Words", "ru")).toBe(items);
  });
});
