// Adding a link should not mean typing the title and the path twice. Each way of doing it is
// measured against typing the whole Markdown link (test/support/bench.ts): keys pressed,
// letters that must match a file name exactly, what one slip of the finger does, and whether
// a link to a page that does not exist yet is still possible.

import { describe, expect, it } from "vitest";

import { choicesFor, linkPages, pasteLink, splitAlias, titleOf } from "../src/shared/linkFlows";
import { PAGES, SCENARIOS, WAYS, measure, slips, table, type Way } from "./support/bench";

const way = (id: string): Way => WAYS.find((w) => w.id === id)!;
const scenario = (id: string) => SCENARIOS.find((s) => s.id === id)!;
const baseline = (id: string) => measure(way("typeItAll"), scenario(id));
const slipsOf = (wayId: string, id: string) => slips(way(wayId), scenario(id), measure(way(wayId), scenario(id)));

describe("the measurement itself", () => {
  it("types the whole link for the baseline, and gets the link you wanted", () => {
    const m = baseline("existing");
    expect(m.works).toBe(true);
    expect(m.keys).toBe("[Daily TODO](/daily-todo.md)".length);
    // The title is typed once as text and the path once more as a path: every letter by hand.
    expect(m.pathLetters).toBe("/daily-todo.md".length);
  });

  it("every way gets the link that was wanted, in every case", () => {
    for (const w of WAYS) for (const sc of SCENARIOS) expect(measure(w, sc).works, `${w.id} / ${sc.id}`).toBe(true);
  });

  it("slips in the baseline: a wrong path goes unnoticed, a wrong bracket shows, a wrong text is harmless", () => {
    const s = slipsOf("typeItAll", "existing");
    expect(s.tried).toBe(48);
    // The 14 path letters can each be dropped or replaced, and nothing says the file is not there.
    expect(s.silent).toBeGreaterThan(20);
    expect(s.unfinished).toBeGreaterThanOrEqual(1);
    expect(s.tried - s.silent - s.unfinished).toBeGreaterThan(10);
  });
});

/** The ways that are new: each must beat typing it all, wherever it claims to help. */
const NEW_WAYS = ["wikilink", "ctrlL", "titleFirst", "paste"];

describe.each(NEW_WAYS)("%s", (id) => {
  const helpedIn = SCENARIOS.filter((sc) => measure(way(id), sc).helps);

  it("helps somewhere", () => {
    expect(helpedIn.length).toBeGreaterThan(0);
  });

  it.each(helpedIn.map((sc) => sc.id))("%s: fewer keys, no path typed, fewer slips that go wrong", (sid) => {
    const mine = measure(way(id), scenario(sid));
    const base = baseline(sid);
    expect(mine.works).toBe(true);
    expect(mine.keys).toBeLessThan(base.keys);
    expect(mine.pathLetters).toBe(0);
    // Counts, not shares: with fewer keys there are fewer places to slip, which is the point.
    const slipped = slipsOf(id, sid);
    const base_ = slipsOf("typeItAll", sid);
    expect(slipped.silent).toBeLessThanOrEqual(base_.silent);
    expect(slipped.silent + slipped.unfinished).toBeLessThan(base_.silent + base_.unfinished);
  });
});

describe("a page that does not exist yet", () => {
  it.each(["wikilink", "ctrlL", "titleFirst"])("%s links to it, and the path comes from the words", (id) => {
    const m = measure(way(id), scenario("newPage"));
    expect(m.works).toBe(true);
    expect(m.pathLetters).toBe(0);
    expect(m.keys).toBeLessThan(baseline("newPage").keys);
  });

  it("today's list does it too, but needs the closing key to leave the link", () => {
    const m = measure(way("current"), scenario("newPage"));
    expect(m.works).toBe(true);
    expect(m.steps.at(-1)?.key).toBe("Right");
  });
});

describe("a page whose file name is not its title", () => {
  it("is found by its title with the new pickers, and only by its file name today", () => {
    expect(measure(way("wikilink"), scenario("titleDiffers")).neededFileName).toBe(false);
    expect(measure(way("ctrlL"), scenario("titleDiffers")).neededFileName).toBe(false);
    expect(measure(way("titleFirst"), scenario("titleDiffers")).neededFileName).toBe(false);
    expect(measure(way("current"), scenario("titleDiffers")).neededFileName).toBe(true);
  });
});

describe("web addresses", () => {
  it("paste over the selected words is shorter than wrapping the paste in `[](` and `)`", () => {
    expect(measure(way("paste"), scenario("webAddress")).keys).toBe("Anthropic".length + 2);
    expect(baseline("webAddress").keys).toBe("[Anthropic](".length + 2);
  });

  it("leaves other pastes alone", () => {
    expect(pasteLink("Anthropic", "not an address")).toBeNull();
    expect(pasteLink("", "https://example.com")).toBeNull();
    expect(pasteLink("two\nlines", "https://example.com")).toBeNull();
    expect(pasteLink("here", " https://example.com ")).toBe("[here](https://example.com)");
  });
});

describe("the pieces", () => {
  it("titleOf: front matter title, else the first # heading, else the file name", () => {
    expect(titleOf('---\ntype: concept\ntitle: "Daily TODO"\n---\n\n# Other\n', "daily-todo.md")).toBe("Daily TODO");
    expect(titleOf("---\ntype: concept\n---\n\n# Books to read\n\nText", "reading-list.md")).toBe("Books to read");
    expect(titleOf("# Just a heading #\n", "x.md")).toBe("Just a heading");
    expect(titleOf("no title here\n", "project/my-notes.md")).toBe("my notes");
    // Setext headings are not headings in Tessela.
    expect(titleOf("Not a heading\n=============\n", "plain.md")).toBe("plain");
  });

  it("choicesFor: a new page goes first when nothing matches well, last when something does", () => {
    expect(choicesFor(PAGES, "Sprint retro")[0]).toEqual({ text: "Sprint retro", dest: "/sprint-retro.md", fresh: true });
    const dail = choicesFor(PAGES, "dail");
    expect(dail[0]).toMatchObject({ dest: "/daily-todo.md", fresh: false });
    expect(dail.at(-1)).toMatchObject({ fresh: true });
  });

  it("choicesFor: a title that is already a page is not offered as new", () => {
    expect(choicesFor(PAGES, "Tessela").some((c) => c.fresh)).toBe(false);
  });

  it("linkPages: pages by title, plus concepts that are mentioned but have no page", () => {
    const pages = [{ id: "daily-todo", path: "daily-todo.md", title: "Daily TODO" }, { id: "bare", path: "bare.md" }];
    const vocab = [
      { concept: "later", has_page: false, mentions: 1, pages: 1, deprecated: false, use_instead: null, note: null },
      { concept: "bare", has_page: true, mentions: 1, pages: 1, deprecated: false, use_instead: null, note: null },
    ];
    expect(linkPages(pages, vocab)).toEqual([
      { path: "daily-todo.md", title: "Daily TODO" },
      { path: "bare.md", title: "bare" },
      { path: "later.md", title: "later" },
    ]);
  });

  it("splitAlias: text after | is the link text", () => {
    expect(splitAlias("daily|my list")).toEqual({ search: "daily", alias: "my list" });
    expect(splitAlias("daily")).toEqual({ search: "daily", alias: null });
  });
});

describe("the comparison", () => {
  it("prints", () => {
    console.log(table());
    expect(table()).toContain("typeItAll");
  });
});
