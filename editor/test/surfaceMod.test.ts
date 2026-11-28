// The surface mod's plan: what the writer is on, what Jev is asked, how the answers weigh against the
// cost of interrupting, and which note, if any, is shown. A fake Jev stands in for the service.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { askJev, jevIn } from "../src/main/jev";
import surface from "../src/mods/surface/main";
import {
  type Candidate,
  type Card,
  type Paragraph,
  type Surfacing,
  type Verdict,
  BOUNDARY_MS,
  EXIT,
  IDLE_MS,
  NO_PARAGRAPH,
  Memory,
  Runs,
  VALUE,
  cardsOf,
  costOf,
  decide,
  dismiss,
  judge,
  memories,
  none,
  paragraphOf,
  recordEdit,
  requestFor,
  settleMs,
  thoughtAt,
  toAsk,
  typingOf,
  verdictOf,
  worthOf,
} from "../src/mods/surface/plan";
import { type JevAnswer, type JevRequest, type JevResult, cleanAnswers, isJevRequest } from "../src/shared/jev";
import { modelOf } from "./support/page";
import { lines, runs } from "./support/props";

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

const unit = fc.double({ min: 0, max: 1, noNaN: true });
const verdict: fc.Arbitrary<Verdict> = fc.record({ answers: unit, contradicts: unit, same: unit, overlaps: unit, topic: unit });
const activity: fc.Arbitrary<Paragraph["activity"]> = fc
  .tuple(unit, unit, unit, unit)
  .map(([drafting, editing, reading, idle]) => ({ drafting, editing, reading, idle }));
const paragraph: fc.Arbitrary<Paragraph> = fc.record({ task: unit, date: unit, activity });
const typing = fc.record({ speed: fc.double({ min: 0, max: 20, noNaN: true }), erasing: unit });

describe("pauses", () => {
  it("wait a short while after Enter or the end of a sentence, and a longer one otherwise", () => {
    expect(settleMs("a sentence.")).toBe(IDLE_MS); // the period alone is not yet a pause: the next word may follow
    expect(settleMs("a sentence. ")).toBe(BOUNDARY_MS);
    expect(settleMs("really? ")).toBe(BOUNDARY_MS);
    expect(settleMs('said "no." ')).toBe(BOUNDARY_MS);
    expect(settleMs("para\n")).toBe(BOUNDARY_MS);
    expect(settleMs("item\n- ")).toBe(BOUNDARY_MS);
    expect(settleMs("item\n  1. [ ] ")).toBe(BOUNDARY_MS);
    expect(settleMs("half a wor")).toBe(IDLE_MS);
    expect(settleMs("")).toBe(IDLE_MS);
  });

  it("are one of the two, whatever was typed", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 14 }), (before) => [BOUNDARY_MS, IDLE_MS].includes(settleMs(before))),
      runs(200),
    );
  });

  it("are never short when the last thing typed was a word character", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 8 }), fc.constantFrom("a", "Z", "7", "é"), (before, last) => settleMs(before + last) === IDLE_MS),
      runs(200),
    );
  });
});

describe("typing speed", () => {
  it("counts what was typed in the last seconds, and forgets the rest", () => {
    let log = recordEdit([], { at: 0, added: 100, removed: 0 });
    log = recordEdit(log, { at: 9000, added: 10, removed: 10 });
    expect(log.length).toBe(1);
    const t = typingOf(log, 9000);
    expect(t.speed).toBe(2);
    expect(t.erasing).toBe(0.5);
    expect(typingOf(log, 20000)).toEqual({ speed: 0, erasing: 0 });
  });
});

describe("the thought", () => {
  const page = ["---", "type: concept", "---", "", "# Project", "", "## Risks", "", "The cache may go stale.", "", "- the first item", "  - nested thought", "", "> a quoted idea", ""].join("\n");
  const at = (needle: string, shift = 0) => page.indexOf(needle) + shift;

  it("is the block the cursor is in, with its headings and the items that hold it", () => {
    const model = modelOf(page);
    expect(thoughtAt(model, at("may go", 3))).toMatchObject({ text: "The cache may go stale.", headingPath: ["Project", "Risks"], parents: [], line: 9 });
    expect(thoughtAt(model, at("nested", 2))).toMatchObject({ text: "nested thought", parents: ["the first item"], headingPath: ["Project", "Risks"], line: 12 });
    expect(thoughtAt(model, at("quoted", 2))).toMatchObject({ text: "a quoted idea" });
  });

  it("takes only the item's own text, not what it owns", () => {
    const t = thoughtAt(modelOf(page), at("first item", 2));
    expect(t?.text).toBe("the first item");
    expect(t?.end).toBe(at("the first item") + "the first item".length);
  });

  it("is the block just finished when the cursor is on the empty line after it", () => {
    expect(thoughtAt(modelOf(page), at("stale.", 7))?.text).toBe("The cache may go stale.");
    expect(thoughtAt(modelOf(`# Title\n\n`), 9)).toBeNull(); // only a heading: nothing to say
    expect(thoughtAt(modelOf("First.\n\n# Next\n\n"), 15)).toBeNull(); // a heading came between
  });

  it("is nothing in code, a table or the front matter", () => {
    expect(thoughtAt(modelOf("```\ncode here\n```\n"), 6)).toBeNull();
    expect(thoughtAt(modelOf("| a | b |\n|---|---|\n| c | d |\n"), 4)).toBeNull();
    expect(thoughtAt(modelOf("---\ntype: concept\n---\n\nBody.\n"), 8)).toBeNull();
  });

  it("is always inside the page, on the line it says, for any page and any position", () => {
    fc.assert(
      fc.property(lines, fc.nat(400), (doc, n) => {
        const text = doc.join("\n");
        const model = modelOf(text);
        const t = thoughtAt(model, n % (text.length + 1));
        if (!t) return true;
        const line = text.slice(0, t.from).split("\n").length;
        return t.from <= t.end && t.end <= text.length && t.line === line && t.text.trim() === t.text && t.text !== "";
      }),
      runs(300),
    );
  });
});

describe("the questions and the answers", () => {
  const thought = { line: 9, from: 0, end: 10, text: "The cache may go stale.", parents: [], headingPath: ["Project"] };
  const writing = { characters_added_per_second: 2, share_of_changes_that_were_deletions: 0 };

  it("ask four things about each note and two about the paragraph, in one request", () => {
    const request = requestFor(thought, writing, [candidate(1), candidate(2)], true);
    expect(Object.keys(request.questions).sort()).toEqual(
      ["activity", "answers_0", "answers_1", "contradicts_0", "contradicts_1", "holds", "topic_0", "topic_1", "written_0", "written_1"].sort(),
    );
    expect(isJevRequest(request)).toBe(true);
    expect((request.state as { notes: unknown[] }).notes).toHaveLength(2);
    expect(Object.keys(requestFor(thought, writing, [candidate(1)], false).questions)).toHaveLength(4);
  });

  const answers = (n: number, v: { a: number; c: number; same: number; overlaps: number; topic: number }): Record<string, JevAnswer> => ({
    [`answers_${n}`]: { type: "noul", noul: v.a },
    [`contradicts_${n}`]: { type: "noul", noul: v.c },
    [`written_${n}`]: { type: "choice", choice: "same", confidence: 0.5, probabilities: { same: v.same, overlaps: v.overlaps, different: 1 - v.same - v.overlaps } },
    [`topic_${n}`]: { type: "score", score: v.topic * 3, confidence: 0.5, probabilities: {} },
  });

  it("read as a verdict, and as nothing when an answer is missing or of the wrong kind", () => {
    expect(verdictOf(answers(1, { a: 0.9, c: 0.1, same: 0.2, overlaps: 0.3, topic: 1 }), 1)).toEqual({ answers: 0.9, contradicts: 0.1, same: 0.2, overlaps: 0.3, topic: 1 });
    const missing = answers(0, { a: 1, c: 1, same: 1, overlaps: 0, topic: 1 });
    delete missing.topic_0;
    expect(verdictOf(missing, 0)).toBeNull();
    expect(verdictOf({ ...answers(0, { a: 1, c: 1, same: 1, overlaps: 0, topic: 1 }), answers_0: { type: "score", score: 1, confidence: 1, probabilities: {} } }, 0)).toBeNull();
  });

  it("read the paragraph's task, date and activity", () => {
    const choice = (probabilities: Record<string, number>): JevAnswer => ({ type: "choice", choice: "x", confidence: 1, probabilities });
    const read = paragraphOf({ holds: choice({ task: 0.7, date: 0.2, neither: 0.1 }), activity: choice({ drafting: 0.6, editing: 0.2, reading: 0.1, idle: 0.1 }) });
    expect(read?.task).toBe(0.7);
    expect(read?.activity.drafting).toBe(0.6);
    expect(paragraphOf({})).toBeNull();
  });

  it("are dropped when they are not of the shape asked for, and kept when they are", () => {
    const clean = cleanAnswers({ a: { type: "noul", noul: 0.4 }, b: { type: "noul", noul: "x" }, c: 5, d: { type: "choice", choice: "same", probabilities: { same: 1, bad: "x" } } });
    expect(Object.keys(clean).sort()).toEqual(["a", "d"]);
    expect(clean.d).toMatchObject({ probabilities: { same: 1 }, confidence: 0 });
  });

  it("go to Jev only for what is not yet known, and are kept by the thought and the note", async () => {
    const calls: JevRequest[] = [];
    const ask = async (request: JevRequest): Promise<JevResult> => {
      calls.push(request);
      const names = Object.keys(request.questions).filter((q) => q.startsWith("topic_")).map((q) => Number(q.slice(6)));
      const out: Record<string, JevAnswer> = {
        holds: { type: "choice", choice: "neither", confidence: 1, probabilities: { task: 0, date: 0, neither: 1 } },
        activity: { type: "choice", choice: "idle", confidence: 1, probabilities: { drafting: 0, editing: 0, reading: 0, idle: 1 } },
      };
      for (const n of names) Object.assign(out, answers(n, { a: 0.5, c: 0, same: 0, overlaps: 0, topic: 1 }));
      return { ok: true, answers: out };
    };
    const memory = memories();
    const notes = [candidate(1), candidate(2)];
    const first = await judge(thought, writing, notes, memory, ask);
    expect(first?.verdicts).toHaveLength(2);
    expect(calls).toHaveLength(1);
    // Same thought, same notes: nothing is asked.
    await judge(thought, writing, notes, memory, ask);
    expect(calls).toHaveLength(1);
    // One new note: only it is asked about (and the paragraph is not).
    await judge(thought, writing, [...notes, candidate(3)], memory, ask);
    expect(calls).toHaveLength(2);
    expect(Object.keys(calls[1]!.questions).sort()).toEqual(["answers_0", "contradicts_0", "topic_0", "written_0"]);
    // Other words, or the same words under another heading, are another thought.
    await judge({ ...thought, text: "Something else." }, writing, notes, memory, ask);
    await judge({ ...thought, headingPath: ["Other"] }, writing, notes, memory, ask);
    expect(calls).toHaveLength(4);
  });

  it("give nothing when Jev fails, and ask again next time", async () => {
    let n = 0;
    const memory = memories();
    const ask = async (): Promise<JevResult> => (++n === 1 ? { ok: false, error: "no network" } : { ok: true, answers: {} });
    expect(await judge(thought, writing, [candidate(1)], memory, ask)).toBeNull();
    expect(await judge(thought, writing, [candidate(1)], memory, ask)).not.toBeNull();
    expect(n).toBe(2);
  });

  it("ask about each note once, the best ones", () => {
    const list = [candidate(1), candidate(1), ...[2, 3, 4, 5].map((n) => candidate(n))];
    expect(toAsk(list, 3).map((c) => c.handle)).toEqual(["p1#h1", "p2#h2", "p3#h3"]);
  });
});

describe("what a note is worth", () => {
  it("is between 0 and its best reason's value, and a contradiction counts for more than a neighbour", () => {
    fc.assert(
      fc.property(verdict, paragraph, (v, p) => {
        const card = worthOf(candidate(1), v, p);
        return card.worth >= 0 && card.worth <= VALUE.contradicts;
      }),
      runs(200),
    );
    const sure: Verdict = { answers: 0, contradicts: 1, same: 0, overlaps: 0, topic: 1 };
    const near: Verdict = { answers: 0, contradicts: 0, same: 0, overlaps: 0, topic: 1 };
    expect(worthOf(candidate(1), sure, NO_PARAGRAPH)).toMatchObject({ why: "contradicts", worth: 1 });
    expect(worthOf(candidate(1), near, NO_PARAGRAPH)).toMatchObject({ why: "topic", worth: VALUE.topic });
  });

  it("is nothing for a note off the topic, whatever else Jev says, unless it is a date that matters", () => {
    fc.assert(
      fc.property(unit, unit, unit, unit, (a, c, s, o) => worthOf(candidate(1), { answers: a, contradicts: c, same: s, overlaps: o, topic: 0 }, NO_PARAGRAPH).worth === 0),
      runs(200),
    );
    const off: Verdict = { answers: 0, contradicts: 0, same: 0, overlaps: 0, topic: 0 };
    const dated: Paragraph = { ...NO_PARAGRAPH, date: 1 };
    expect(worthOf(candidate(1, { source: "agenda" }), off, dated)).toMatchObject({ why: "date", worth: VALUE.date });
    expect(worthOf(candidate(1, { source: "related" }), off, dated).worth).toBe(0);
  });

  it("only rises when Jev is surer", () => {
    fc.assert(
      fc.property(verdict, unit, (v, more) => {
        const bigger = { ...v, answers: Math.max(v.answers, more), contradicts: Math.max(v.contradicts, more), same: Math.max(v.same, more), topic: Math.max(v.topic, more) };
        return worthOf(candidate(1), bigger, NO_PARAGRAPH).worth >= worthOf(candidate(1), v, NO_PARAGRAPH).worth;
      }),
      runs(200),
    );
  });

  it("lists the best first and leaves out the notes Jev said nothing usable about", () => {
    const strong: Verdict = { answers: 1, contradicts: 0, same: 0, overlaps: 0, topic: 1 };
    const weak: Verdict = { answers: 0, contradicts: 0, same: 0, overlaps: 0, topic: 0.5 };
    const list = cardsOf([candidate(1), candidate(2), candidate(3)], [weak, null, strong], NO_PARAGRAPH);
    expect(list.map((c) => c.candidate.handle)).toEqual(["p3#h3", "p1#h1"]);
  });
});

describe("the cost of interrupting", () => {
  it("grows with typing speed and halves at the end of a paragraph", () => {
    fc.assert(
      fc.property(typing, typing, activity, fc.boolean(), (a, b, act, end) => {
        const [slow, fast] = a.speed <= b.speed ? [a, b] : [b, a];
        const low = costOf({ ...slow, erasing: 0 }, end, act);
        const high = costOf({ ...fast, erasing: 0 }, end, act);
        const cost = costOf(slow, false, act);
        return low <= high + 1e-12 && costOf(slow, true, act) <= cost + 1e-12 && cost > 0 && Number.isFinite(cost);
      }),
      runs(200),
    );
  });

  it("is lower for a reader than for a writer in full flow", () => {
    const t = { speed: 3, erasing: 0 };
    const reading = { drafting: 0, editing: 0, reading: 1, idle: 0 };
    const drafting = { drafting: 1, editing: 0, reading: 0, idle: 0 };
    expect(costOf(t, false, reading)).toBeLessThan(costOf(t, false, drafting));
  });
});

describe("what is shown", () => {
  const card = (n: number, worth: number): Card => ({ candidate: candidate(n), worth, why: "answers" });
  const round = (worths: number[]) => worths.map((w, i) => card(i + 1, w)).sort((a, b) => b.worth - a.worth);

  it("shows the best note when it beats the cost, and nothing when none does", () => {
    expect(decide(none(), round([0.2, 0.3]), 0.5, 1)).toMatchObject({ change: "none", state: { shown: null } });
    const shown = decide(none(), round([0.2, 0.8]), 0.5, 1);
    expect(shown.change).toBe("show");
    expect(shown.state.shown?.candidate.handle).toBe("p2#h2");
  });

  it("shows a paragraph one new card, whatever comes after it", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.array(unit, { minLength: 1, maxLength: 4 }), unit, fc.integer({ min: 1, max: 3 })), { maxLength: 12 }), (rounds) => {
        let state: Surfacing = none();
        const shownIn = new Map<number, Set<string>>();
        for (const [worths, cost, para] of rounds.sort((a, b) => a[2] - b[2])) {
          const d = decide(state, round(worths), cost, para);
          state = d.state;
          if (d.change === "show") shownIn.set(para, (shownIn.get(para) ?? new Set()).add(d.state.shown!.candidate.handle));
        }
        return [...shownIn.values()].every((s) => s.size <= 1);
      }),
      runs(300),
    );
  });

  it("never shows a note that is worth less than the cost, as a new card", () => {
    fc.assert(
      fc.property(fc.array(unit, { minLength: 1, maxLength: 5 }), unit, (worths, cost) => {
        const d = decide(none(), round(worths), cost, 1);
        return d.change !== "show" || d.state.shown!.worth > cost;
      }),
      runs(200),
    );
  });

  it("keeps a card while its worth stays in the band between entering and leaving, so it does not flicker", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.2, max: 0.9, noNaN: true }), fc.array(unit, { minLength: 1, maxLength: 12 }), (cost, wobble) => {
        let state = decide(none(), round([cost + 0.01]), cost, 1).state;
        for (const w of wobble) {
          const worth = cost * EXIT + (cost + 0.01 - cost * EXIT) * w; // anywhere from the exit line to where it entered
          const d = decide(state, round([worth]), cost, 1);
          if (d.change !== "keep") return false;
          state = d.state;
        }
        return state.shown !== null;
      }),
      runs(200),
    );
  });

  it("takes a card away when its worth drops well below the cost, and does not bring another in the same paragraph", () => {
    let d = decide(none(), round([0.9, 0.8]), 0.5, 1);
    d = decide(d.state, round([0.1, 0.95]), 0.5, 1);
    expect(d.change).toBe("hide");
    d = decide(d.state, round([0.1, 0.95]), 0.5, 1);
    expect(d).toMatchObject({ change: "none", state: { shown: null } });
    // The next paragraph may have its own.
    expect(decide(d.state, round([0.1, 0.95]), 0.5, 2).change).toBe("show");
  });

  it("takes the card away with its paragraph", () => {
    const d = decide(none(), round([0.9]), 0.5, 1);
    expect(decide(d.state, round([0.9]), 0.5, 2).state.shown?.candidate.handle).toBe("p1#h1"); // a new paragraph may show it again
    const quiet = decide(d.state, [], 0.5, 2);
    expect(quiet.change).toBe("hide");
  });

  it("lets a note that drops out of the list go gradually, not at once", () => {
    let d = decide(none(), round([0.6]), 0.5, 1);
    d = decide(d.state, [], 0.5, 1);
    expect(d.change).toBe("keep");
    d = decide(d.state, [], 0.5, 1);
    expect(d.change).toBe("hide");
  });

  it("never offers a dismissed note again", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.array(unit, { minLength: 1, maxLength: 3 }), fc.integer({ min: 1, max: 4 })), { maxLength: 10 }), (rounds) => {
        let state = dismiss(decide(none(), round([0.99, 0.98, 0.97]), 0.1, 1).state);
        const gone = state.dismissed.size;
        for (const [worths, para] of rounds) {
          // Whatever is offered, the dismissed note p1 is among the cards with the best worth.
          const list = [card(1, 1), ...round(worths).map((c, i) => ({ ...c, candidate: candidate(i + 2) }))];
          state = decide(state, list, 0.1, para).state;
          if (state.shown?.candidate.handle === "p1#h1") return false;
        }
        return gone === 1;
      }),
      runs(200),
    );
  });
});

describe("runs and stale answers", () => {
  it("drops an answer for an older text, or after a cancel, or when another run began", () => {
    const runs = new Runs();
    const first = runs.start(3);
    expect(first.stale(3)).toBe(false);
    expect(first.stale(4)).toBe(true); // the text moved on
    const second = runs.start(4);
    expect(first.signal.aborted).toBe(true);
    expect(first.stale(3)).toBe(true);
    expect(second.stale(4)).toBe(false);
    runs.cancel(); // a key was typed
    expect(second.stale(4)).toBe(true);
    expect(second.signal.aborted).toBe(true);
  });

  it("forgets the least recently used answer", () => {
    const memory = new Memory<number>(2);
    memory.set("a", 1);
    memory.set("b", 2);
    memory.get("a");
    memory.set("c", 3);
    expect([memory.get("a"), memory.get("b"), memory.get("c")]).toEqual([1, undefined, 3]);
  });
});

describe("without a Jev key", () => {
  it("the mod adds nothing and asks nothing", () => {
    let calls = 0;
    const touched: string[] = [];
    const trap = new Proxy({}, { get: (_t, name) => () => void touched.push(String(name)) });
    const ctx = { jev: { on: false, ask: async () => void calls++ }, commands: trap, editor: trap, events: trap, slots: trap, cli: async () => void calls++ };
    surface(ctx as never);
    expect(calls).toBe(0);
    expect(touched).toEqual([]);
  });
});

describe("the Jev client", () => {
  const config = { key: "k-1", baseUrl: "https://jev.test", model: "jev-latest" };
  const request: JevRequest = { state: "hello", questions: { q: { type: "noul", instructions: "Is it?" } } };
  const answer = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

  it("asks the service with the key, the model, and the state and questions, and cleans the answers", async () => {
    let seen: { url: string; init: { headers: Record<string, string>; body: string } } | null = null;
    const result = await askJev(config, request, async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ answers: { q: { type: "noul", noul: 0.9 }, junk: 1 } }));
    }, new AbortController().signal);
    expect(result).toEqual({ ok: true, answers: { q: { type: "noul", noul: 0.9 } } });
    expect(seen!.url).toBe("https://jev.test/v1/systemone");
    expect(seen!.init.headers.authorization).toBe("Bearer k-1");
    expect(JSON.parse(seen!.init.body)).toEqual({ model: "jev-latest", ...request });
  });

  it("answers with a reason, and never the key, when there is no key, the call fails or it is cancelled", async () => {
    const live = new AbortController().signal;
    expect(await askJev(null, request, answer({}), live)).toEqual({ ok: false, error: "no Jev key" });
    expect(await askJev(config, { state: 1, questions: {} }, answer({}), live)).toEqual({ ok: false, error: "not a Jev request" });
    expect(await askJev(config, request, answer({}, 429), live)).toEqual({ ok: false, error: "Jev answered 429" });
    const down = await askJev(config, request, async () => Promise.reject(new Error("connect ECONNREFUSED with k-1")), live);
    expect(down).toEqual({ ok: false, error: "Jev could not be reached" });
    const stop = new AbortController();
    const slow = (_url: string, init: { signal: AbortSignal }) => new Promise<Response>((_ok, fail) => init.signal.addEventListener("abort", () => fail(new Error("aborted"))));
    const pending = askJev(config, request, slow, stop.signal);
    stop.abort();
    expect(await pending).toEqual({ ok: false, error: "cancelled" });
    expect(await askJev(config, request, slow, live, 20)).toEqual({ ok: false, error: "Jev did not answer in time" });
  });

  it("rejects requests that are not named questions of the three kinds", () => {
    expect(isJevRequest(request)).toBe(true);
    expect(isJevRequest({ state: "x", questions: { q: { type: "choice", instructions: "?", criteria: { a: "A" } } } })).toBe(true);
    expect(isJevRequest({ state: "x", questions: { q: { type: "score", instructions: "?", criteria: ["low"] } } })).toBe(false);
    expect(isJevRequest({ state: "x", questions: { q: { type: "other", instructions: "?" } } })).toBe(false);
    expect(isJevRequest({ questions: request.questions })).toBe(false);
    expect(isJevRequest(null)).toBe(false);
  });
});

describe("the Jev settings", () => {
  it("need a key; the address and the model are optional", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const folder = () => mkdtempSync(join(tmpdir(), "tessela-jev-"));
    const withSettings = (settings: unknown) => {
      const dir = folder();
      writeFileSync(join(dir, "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
      return dir;
    };
    expect(jevIn(folder())).toBeNull();
    expect(jevIn(withSettings("not json"))).toBeNull();
    expect(jevIn(withSettings({ jev: {} }))).toBeNull();
    expect(jevIn(withSettings({ jev: { key: "  " } }))).toBeNull();
    expect(jevIn(withSettings({ jev: { key: "abc" } }))).toEqual({ key: "abc", baseUrl: "https://api.typesafe.ai", model: "jev-latest" });
    expect(jevIn(withSettings({ jev: { key: "abc", baseUrl: "http://127.0.0.1:9/", model: "m" } }))).toEqual({ key: "abc", baseUrl: "http://127.0.0.1:9", model: "m" });
    expect(jevIn(withSettings({ jev: { key: "abc", baseUrl: "file:///etc" } }))?.baseUrl).toBe("https://api.typesafe.ai");
  });
});

