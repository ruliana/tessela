// What the surface mod learns from what the writer does with its cards: one threshold for each question
// that can raise a card, moved by opening, linking, dismissing or ignoring, and kept in the window's settings.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { type Candidate, type Card, type Why, VALUE, decide, none } from "../src/mods/surface/plan";
import {
  type Outcome,
  type Thresholds,
  HIGH,
  LOW,
  Ledger,
  OUTCOMES,
  RATE,
  TARGET,
  adjust,
  fresh,
  learn,
  thresholdsFrom,
} from "../src/mods/surface/learn";

const WHYS = Object.keys(VALUE) as Why[];
const why = fc.constantFrom(...WHYS);
const outcome = fc.constantFrom(...OUTCOMES);
const level = fc.double({ min: LOW, max: HIGH, noNaN: true });
const thresholds: fc.Arbitrary<Thresholds> = fc
  .tuple(...WHYS.map(() => level))
  .map((ns) => Object.fromEntries(WHYS.map((w, i) => [w, ns[i]!])) as Thresholds);
const steps = fc.array(fc.tuple(why, outcome), { maxLength: 60 });

const candidate = (n: number): Candidate => ({
  source: "related",
  reason: "r",
  score: 0.5,
  kind: "block",
  page: `p${n}`,
  path: `p${n}.md`,
  title: `Page ${n}`,
  line: 1,
  handle: `p${n}#h`,
  heading_path: [],
  excerpt: "x",
  link: `[P](/p${n}.md)`,
  task: null,
});
const card = (n: number, worth: number, reason: Why): Card => ({ candidate: candidate(n), worth, why: reason });

describe("the threshold of a question", () => {
  it("starts at 1 for every question", () => {
    expect(fresh()).toEqual(Object.fromEntries(WHYS.map((w) => [w, 1])));
  });

  it("stays between the bounds, whatever the writer does, and touches only the question that raised the card", () => {
    fc.assert(
      fc.property(thresholds, steps, (start, list) => {
        let t = start;
        for (const [w, o] of list) {
          const next = learn(t, w, o);
          for (const other of WHYS) {
            if (other !== w) expect(next[other]).toBe(t[other]);
          }
          expect(next[w]).toBeGreaterThanOrEqual(LOW);
          expect(next[w]).toBeLessThanOrEqual(HIGH);
          t = next;
        }
      }),
    );
  });

  it("falls when the note is opened or linked, and rises when it is dismissed or ignored, and never the other way", () => {
    fc.assert(
      fc.property(thresholds, why, outcome, (t, w, o) => {
        const after = learn(t, w, o)[w];
        if (TARGET[o] === LOW) expect(after).toBeLessThanOrEqual(t[w]);
        else expect(after).toBeGreaterThanOrEqual(t[w]);
        // It moves, unless it is already at the end it is heading for.
        if (Math.abs(t[w] - TARGET[o]) > 1e-6) expect(after).not.toBe(t[w]);
      }),
    );
  });

  it("counts a link and a dismissal for more than an open and an ignore", () => {
    const t = fresh();
    expect(1 - learn(t, "answers", "linked").answers).toBeGreaterThan(1 - learn(t, "answers", "opened").answers);
    expect(learn(t, "answers", "dismissed").answers - 1).toBeGreaterThan(learn(t, "answers", "ignored").answers - 1);
    expect(RATE.ignored).toBeLessThan(RATE.dismissed);
  });

  it("converges on where the same outcome sends it, closing in without overshooting", () => {
    fc.assert(
      fc.property(thresholds, why, outcome, (start, w, o) => {
        let t = start;
        let gap = Math.abs(TARGET[o] - t[w]);
        for (let i = 0; i < 200; i++) {
          t = learn(t, w, o);
          const now = Math.abs(TARGET[o] - t[w]);
          expect(now).toBeLessThanOrEqual(gap);
          gap = now;
        }
        expect(gap).toBeLessThan(0.05 * (HIGH - LOW));
      }),
    );
  });

  it("settles between the two ends when the writer sometimes opens and sometimes dismisses, nearer the one done more", () => {
    const run = (opens: number, dismissals: number) => {
      let t = fresh();
      for (let i = 0; i < 400; i++) t = learn(t, "topic", i % (opens + dismissals) < opens ? "opened" : "dismissed");
      return t.topic;
    };
    const mostlyOpened = run(4, 1);
    const mostlyDismissed = run(1, 4);
    expect(mostlyOpened).toBeGreaterThan(LOW);
    expect(mostlyDismissed).toBeLessThan(HIGH);
    expect(mostlyOpened).toBeLessThan(mostlyDismissed);
  });
});

describe("the thresholds in the settings", () => {
  it("come back as they were saved, any question missing or any value gone wrong starting again at 1", () => {
    fc.assert(
      fc.property(thresholds, (t) => {
        expect(thresholdsFrom(JSON.parse(JSON.stringify(t)))).toEqual(t);
      }),
    );
    for (const junk of [undefined, null, 3, "x", [], { answers: "high" }, { answers: Number.NaN }, { answers: null }]) {
      expect(thresholdsFrom(junk)).toEqual(fresh());
    }
    expect(thresholdsFrom({ answers: 1.5, topic: "x" })).toEqual({ ...fresh(), answers: 1.5 });
  });

  it("are brought back within the bounds when the saved number is outside them", () => {
    expect(thresholdsFrom({ same: 100, overlaps: -3 })).toEqual({ ...fresh(), same: HIGH, overlaps: LOW });
  });
});

describe("what the thresholds do to the cards", () => {
  it("divide each card's worth by the threshold of the question that raised it, and list the best first", () => {
    const t = { ...fresh(), answers: 2, topic: 0.5 };
    const out = adjust([card(1, 0.6, "answers"), card(2, 0.25, "topic"), card(3, 0.4, "overlaps")], t);
    expect(out.map((c) => c.candidate.handle)).toEqual(["p2#h", "p3#h", "p1#h"]);
    expect(out.map((c) => c.worth)).toEqual([0.5, 0.4, 0.3]);
    expect(adjust([], t)).toEqual([]);
  });

  it("make a card come in exactly when its worth beats the cost times its threshold", () => {
    fc.assert(
      fc.property(why, level, fc.double({ min: 0.05, max: 1, noNaN: true }), fc.double({ min: 0.05, max: 1, noNaN: true }), (w, at, worth, cost) => {
        const t = { ...fresh(), [w]: at };
        const shown = decide(none(), adjust([card(1, worth, w)], t), cost, 1).state.shown;
        // Away from the edge, where rounding could go either way.
        if (worth > cost * at * 1.0001) expect(shown).not.toBeNull();
        if (worth < cost * at * 0.9999) expect(shown).toBeNull();
      }),
    );
  });

  it("let a note that was dismissed raise its question's bar, so the next one of that kind needs more", () => {
    const worth = 0.4;
    const cost = 0.35;
    let t = fresh();
    expect(decide(none(), adjust([card(1, worth, "answers")], t), cost, 1).state.shown).not.toBeNull();
    for (let i = 0; i < 3; i++) t = learn(t, "answers", "dismissed");
    expect(decide(none(), adjust([card(1, worth, "answers")], t), cost, 1).state.shown).toBeNull();
  });
});

describe("the ledger of cards on show", () => {
  const a = card(1, 0.6, "answers");
  const b = card(2, 0.5, "same");

  it("gives a card that goes away untouched one ignored, and a card that was acted on nothing more", () => {
    const l = new Ledger();
    l.raise(a, 1);
    expect(l.settle(a, 1, "ignored")).toEqual({ why: "answers", outcome: "ignored" });
    expect(l.settle(a, 1, "ignored")).toBeNull();

    l.raise(b, 1);
    expect(l.settle(b, 1, "opened")).toEqual({ why: "same", outcome: "opened" });
    expect(l.settle(b, 1, "ignored")).toBeNull();
    expect(l.settle(b, 1, "dismissed")).toBeNull();
  });

  it("lets a note from the right column count as opened or linked after its card went unnoticed, but never twice", () => {
    const l = new Ledger();
    l.raise(a, 1);
    l.settle(a, 1, "ignored");
    expect(l.settle(a, 1, "linked")).toEqual({ why: "answers", outcome: "linked" });
    expect(l.settle(a, 1, "opened")).toBeNull();
  });

  it("teaches nothing as ignored or dismissed about a card it never saw, and counts an open or a link from the column", () => {
    const l = new Ledger();
    expect(l.settle(a, 1, "ignored")).toBeNull();
    expect(l.settle(a, 1, "dismissed")).toBeNull();
    expect(l.settle(a, 1, "opened")).toEqual({ why: "answers", outcome: "opened" });
    expect(l.settle(a, 1, "linked")).toBeNull();
  });

  it("keeps a card of one paragraph apart from the same note raised in another", () => {
    const l = new Ledger();
    l.raise(a, 1);
    l.raise(a, 2);
    expect(l.settle(a, 1, "dismissed")).not.toBeNull();
    expect(l.settle(a, 2, "dismissed")).not.toBeNull();
  });

  it("gives at most one outcome for each card, whatever happens to it", () => {
    fc.assert(
      fc.property(fc.array(outcome, { minLength: 1, maxLength: 12 }), (list) => {
        const l = new Ledger();
        l.raise(a, 1);
        const given = list.map((o: Outcome) => l.settle(a, 1, o)).filter((x) => x !== null);
        // An ignored card may still be opened or linked afterwards: at most two, and only in that order.
        expect(given.length).toBeLessThanOrEqual(2);
        if (given.length === 2) {
          expect(given[0]!.outcome).toBe("ignored");
          expect(["opened", "linked"]).toContain(given[1]!.outcome);
        }
      }),
    );
  });
});
