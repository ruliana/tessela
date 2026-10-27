import { describe, expect, it } from "vitest";

import type { VocabEntry } from "../src/shared/api";
import { suggest } from "../src/shared/complete";
import { conceptAt, linkTargetId, refsInLine } from "../src/shared/links";
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
