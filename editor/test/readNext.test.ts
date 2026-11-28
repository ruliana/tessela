// Read next, the plan: which notes to ask Jev about at the end of a page, how its answers rank them,
// which two or three are shown, and that nothing is asked twice or without a key. A fake Jev stands in.

import { Text } from "@codemirror/state";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import readnext from "../src/mods/surface/readnext";
import {
  type Next,
  type Reading,
  EDIT_MS,
  ARRIVE_MS,
  MAX_CHARS,
  MAX_NOTES,
  MIN_RANK,
  SHOWN,
  delayFor,
  excerptOf,
  lastContent,
  nextMemory,
  nextOf,
  notesToAsk,
  pickNext,
  rankOf,
  reachedEnd,
  readNext,
  requestFor,
} from "../src/mods/surface/next";
import type { Candidate } from "../src/mods/surface/plan";
import { type JevAnswer, type JevRequest, type JevResult, isJevRequest } from "../src/shared/jev";
import { runs } from "./support/props";

const candidate = (n: number, extra: Partial<Candidate> = {}): Candidate => ({
  source: "related",
  reason: "also mentions #x",
  score: 0.5,
  kind: "block",
  page: `p${n}`,
  path: `p${n}.md`,
  title: `Page ${n}`,
  line: 3,
  handle: `p${n}#h${n}`,
  heading_path: [],
  excerpt: `Note ${n} says something.`,
  link: `[Page ${n}](/p${n}.md)`,
  task: null,
  ...extra,
});

const page: Reading = { title: "Cache", headings: ["Cache", "Risks"], text: "We chose #rust for the cache. ".repeat(10) };

const unit = fc.double({ min: 0, max: 1, noNaN: true });
const reading = fc.record({ next: unit, covered: unit });
const candidates = fc.array(fc.integer({ min: 0, max: 14 }), { maxLength: 30 }).map((ns) => ns.map((n, i) => candidate(n, { handle: `p${n}#h${i}` })));

/** A Jev that answers every note with the same `next` level (0 to 3) and `covered` probability, and keeps what it was asked. */
function fakeJev(level: number | ((n: number) => number), covered = 0) {
  const asked: JevRequest[] = [];
  const ask = async (request: JevRequest): Promise<JevResult> => {
    asked.push(request);
    const answers: Record<string, JevAnswer> = {};
    for (const name of Object.keys(request.questions)) {
      const n = Number(name.split("_")[1]);
      if (name.startsWith("next_")) answers[name] = { type: "score", score: typeof level === "number" ? level : level(n), probabilities: {}, confidence: 1 };
      else answers[name] = { type: "noul", noul: covered };
    }
    return { ok: true, answers };
  };
  return { ask, asked };
}

describe("when the end has been reached", () => {
  it("the last content is after the last character that is not white space", () => {
    expect(lastContent(Text.of(["# A", "", "text  ", "", "  "]))).toBe(9);
    expect(lastContent(Text.of(["", ""]))).toBe(0);
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 8 }).map((s) => s.replace(/[\r\n]/g, "")), { minLength: 1, maxLength: 12 }), (ls) => {
        const doc = Text.of(ls);
        const last = lastContent(doc);
        const text = doc.toString();
        expect(last).toBe(text.trimEnd().length);
      }),
      runs(200),
    );
  });

  it("a cursor in the last line, or the last line in view, is the end; neither is not", () => {
    expect(reachedEnd(50, 50, false)).toBe(true);
    expect(reachedEnd(10, 50, true)).toBe(true);
    expect(reachedEnd(10, 50, false)).toBe(false);
  });

  it("after an edit it waits longer than after scrolling to the end", () => {
    expect(delayFor(true)).toBe(EDIT_MS);
    expect(delayFor(false)).toBe(ARRIVE_MS);
    expect(EDIT_MS).toBeGreaterThan(ARRIVE_MS);
  });
});

describe("what Jev reads of the page", () => {
  it("a long page is cut to its start and its end, a short one is left as it is", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 3 * MAX_CHARS }), (text) => {
        const cut = excerptOf(text);
        if (text.length <= MAX_CHARS) expect(cut).toBe(text);
        else {
          expect(cut.length).toBeLessThanOrEqual(MAX_CHARS + 3);
          expect(cut.startsWith(text.slice(0, 100))).toBe(true);
          expect(cut.endsWith(text.slice(-100))).toBe(true);
        }
      }),
      runs(100),
    );
  });
});

describe("the notes asked about", () => {
  it("never the page itself, one for each page, in the order given, and not many", () => {
    fc.assert(
      fc.property(candidates, fc.integer({ min: 0, max: 14 }), (list, self) => {
        const path = `p${self}.md`;
        const asked = notesToAsk(list, path);
        expect(asked.length).toBeLessThanOrEqual(MAX_NOTES);
        expect(asked.some((c) => c.path === path)).toBe(false);
        expect(new Set(asked.map((c) => c.path)).size).toBe(asked.length);
        // Each is the first of its page in the list, and the order is the list's.
        const firsts = list.filter((c, i) => c.path !== path && list.findIndex((d) => d.path === c.path) === i);
        expect(asked).toEqual(firsts.slice(0, MAX_NOTES));
      }),
      runs(200),
    );
  });

  it("the request is one Jev takes, with two questions for each note and the page in its state", () => {
    fc.assert(
      fc.property(candidates, (list) => {
        const notes = notesToAsk(list, "none.md");
        const request = requestFor(page, notes);
        expect(Object.keys(request.questions)).toHaveLength(2 * notes.length);
        if (notes.length > 0) expect(isJevRequest(request)).toBe(true);
        expect(JSON.stringify(request.state)).toContain("We chose #rust");
      }),
      runs(60),
    );
  });
});

describe("the answers", () => {
  const answers = (score: number, covered: number): Record<string, JevAnswer> => ({
    next_0: { type: "score", score, probabilities: {}, confidence: 1 },
    covered_0: { type: "noul", noul: covered },
  });

  it("read as numbers from 0 to 1; an answer missing or of another kind is no reading", () => {
    expect(nextOf(answers(3, 0), 0)).toEqual({ next: 1, covered: 0 });
    expect(nextOf(answers(0, 1), 0)).toEqual({ next: 0, covered: 1 });
    expect(nextOf({}, 0)).toBeNull();
    expect(nextOf({ ...answers(2, 0), covered_0: { type: "score", score: 1, probabilities: {}, confidence: 1 } }, 0)).toBeNull();
    fc.assert(
      fc.property(fc.double({ min: -5, max: 9 }), fc.double({ min: -2, max: 2 }), (score, covered) => {
        const r = nextOf(answers(score, covered), 0)!;
        for (const v of [r.next, r.covered, rankOf(r)]) expect(v >= 0 && v <= 1).toBe(true);
      }),
      runs(100),
    );
  });

  it("a note the page already says ranks lower, and a more natural one ranks higher", () => {
    fc.assert(
      fc.property(reading, reading, (a, b) => {
        if (a.next === b.next && a.covered <= b.covered) expect(rankOf(a)).toBeGreaterThanOrEqual(rankOf(b));
        if (a.covered === b.covered && a.next >= b.next) expect(rankOf(a)).toBeGreaterThanOrEqual(rankOf(b));
      }),
      runs(200),
    );
  });
});

describe("the notes shown", () => {
  it("at most three, best first, every one good enough, and none that had no reading", () => {
    fc.assert(
      fc.property(candidates, fc.array(fc.option(reading, { nil: null }), { maxLength: 30 }), (list, readings) => {
        const picks = pickNext(list, readings);
        expect(picks.length).toBeLessThanOrEqual(SHOWN);
        for (const p of picks) expect(p.rank).toBeGreaterThanOrEqual(MIN_RANK);
        for (let i = 1; i < picks.length; i++) expect(picks[i - 1]!.rank).toBeGreaterThanOrEqual(picks[i]!.rank);
        for (const p of picks) {
          const n = list.indexOf(p.candidate);
          expect(readings[n]).toBeTruthy();
        }
        // Whatever is left out is not better than what is shown.
        const best = Math.max(0, ...list.map((_, n) => (readings[n] ? rankOf(readings[n] as Next) : 0)));
        if (best >= MIN_RANK) expect(picks[0]!.rank).toBe(best);
        else expect(picks).toEqual([]);
      }),
      runs(300),
    );
  });
});

describe("asking Jev", () => {
  it("asks once for a page and its notes, then nothing for the same page and notes", async () => {
    const notes = [candidate(1), candidate(2), candidate(3)];
    const jev = fakeJev((n) => (n === 1 ? 3 : 1));
    const memory = nextMemory();
    const first = await readNext(page, notes, memory, jev.ask);
    expect(jev.asked).toHaveLength(1);
    expect(pickNext(notes, first!).map((p) => p.candidate.title)).toEqual(["Page 2"]);
    const again = await readNext(page, notes, memory, jev.ask);
    expect(jev.asked).toHaveLength(1);
    expect(again).toEqual(first);
  });

  it("asks only about the notes it was not asked about, and again when the page says something else", async () => {
    const jev = fakeJev(3);
    const memory = nextMemory();
    await readNext(page, [candidate(1)], memory, jev.ask);
    await readNext(page, [candidate(1), candidate(2)], memory, jev.ask);
    expect(jev.asked).toHaveLength(2);
    expect(Object.keys(jev.asked[1]!.questions)).toEqual(["next_0", "covered_0"]);
    expect(JSON.stringify(jev.asked[1]!.state)).toContain("Page 2");
    expect(JSON.stringify(jev.asked[1]!.state)).not.toContain("Page 1");
    await readNext({ ...page, text: `${page.text} And more.` }, [candidate(1)], memory, jev.ask);
    expect(jev.asked).toHaveLength(3);
  });

  it("a failed call is no answer, and is asked again the next time", async () => {
    const memory = nextMemory();
    let calls = 0;
    const failing = async (): Promise<JevResult> => (calls++, { ok: false, error: "network" });
    expect(await readNext(page, [candidate(1)], memory, failing)).toBeNull();
    expect(await readNext(page, [candidate(1)], memory, failing)).toBeNull();
    expect(calls).toBe(2);
  });

  it("nothing is asked when there are no notes", async () => {
    const jev = fakeJev(3);
    expect(await readNext(page, [], nextMemory(), jev.ask)).toEqual([]);
    expect(jev.asked).toEqual([]);
  });
});

describe("without a Jev key", () => {
  it("read next adds nothing and asks nothing", () => {
    let calls = 0;
    const touched: string[] = [];
    const trap = new Proxy({}, { get: (_t, name) => () => void touched.push(String(name)) });
    const ctx = { jev: { on: false, ask: async () => void calls++ }, editor: trap, events: trap, cli: async () => void calls++, pages: trap };
    readnext(ctx as never);
    expect(calls).toBe(0);
    expect(touched).toEqual([]);
  });
});
