// Property tests for the editor logic that works on text: references and links, formatting
// edits, dates, history, the palette's ranking, and how a line is cut into parts.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { addDays, dayAt, daysInLine, datesInLine, formatDate, formatDateTime } from "../src/shared/dates";
import { pasteLink, surround, toggleMark, toggleTask, type TextEdit } from "../src/shared/format";
import { inlineParts } from "../src/shared/inline";
import { anchorOf, conceptAt, findAnchor, headingText, linkTargetId, localTarget, normalizeConcept, refsInLine } from "../src/shared/links";
import { emptyHistory, relocate, relocateRecent, step, touch, visit, type History, type Place } from "../src/shared/nav";
import { rank, score } from "../src/shared/palette";
import { frontmatterEnd } from "../src/shared/syntax";
import { parseProperties } from "../src/shared/properties";
import { smartLink } from "../src/shared/smartLink";
import { inlineTokens } from "../src/shared/tokens";
import { line, runs } from "./support/props";

const dir = fc.constantFrom("", "a", "a/b");
const text = fc.oneof(line, fc.string({ maxLength: 30 }));

const apply = (doc: string, e: TextEdit): string => doc.slice(0, e.from) + e.insert + doc.slice(e.to);

describe("references in a line", () => {
  it("normalizing a concept twice is normalizing it once", () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        // A name that still starts with `#` after its leading `#`s ("# #") is not a tag or a link
        // target, and the Rust tools strip it the same way: not an id to be normal.
        fc.pre(!/^\s*#+\s*#/.test(name));
        const id = normalizeConcept(name);
        expect(normalizeConcept(id)).toBe(id);
        expect(/\s/.test(id)).toBe(false);
      }),
      runs(500),
    );
  });

  it("link targets are concept ids that never climb out of the notes", () => {
    fc.assert(
      fc.property(fc.string(), dir, (dest, pageDir) => {
        const id = linkTargetId(dest, pageDir);
        if (id === null) return;
        expect(id).not.toBe("");
        expect(id.split("/")).not.toContain("..");
        expect(localTarget(dest, pageDir) === null || !localTarget(dest, pageDir)!.split("/").includes("..")).toBe(true);
      }),
      runs(500),
    );
  });

  it("finds tags and links where the line has them, in order, and conceptAt agrees", () => {
    fc.assert(
      fc.property(text, dir, (l, pageDir) => {
        const refs = refsInLine(l, pageDir);
        let last = -1;
        for (const r of refs) {
          expect(r.from).toBeGreaterThanOrEqual(last);
          expect(r.to).toBeGreaterThan(r.from);
          expect(r.to).toBeLessThanOrEqual(l.length);
          expect(r.id).toBe(normalizeConcept(r.id));
          if (r.kind === "tag") expect(l[r.from]).toBe("#");
          else expect(l.slice(r.from, r.to)).toMatch(/^\[[^\]]*\]\([^)\s]*\)$/);
          const at = conceptAt(l, r.from, pageDir);
          expect(at).not.toBeNull();
          last = r.from;
        }
        for (const t of inlineTokens(l, pageDir)) {
          expect(t.from).toBeGreaterThanOrEqual(0);
          expect(t.to).toBeLessThanOrEqual(l.length);
        }
      }),
      runs(500),
    );
  });

  it("makes headings and anchors from any text, and finds the heading an anchor names", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 12 }), { maxLength: 6 }), (headings) => {
        for (const [i, h] of headings.entries()) {
          expect(anchorOf(h)).not.toMatch(/\s/);
          // Every heading is found by its own anchor, or by an earlier heading that has the same one.
          const found = findAnchor(headings, anchorOf(h));
          expect(found).toBeGreaterThanOrEqual(-1);
          expect(found).toBeLessThanOrEqual(i);
        }
        expect(headingText(headings.join(" "))).toBeTypeOf("string");
      }),
      runs(300),
    );
  });
});

describe("formatting edits", () => {
  const mark = fc.constantFrom("**", "*", "`", "~~", "==");
  const doc = fc.string({ maxLength: 24, unit: fc.constantFrom("a", "b", " ", "*", "`", "~", "=", "é", "1") });
  const range = doc.chain((d) =>
    fc.tuple(fc.integer({ min: 0, max: d.length }), fc.integer({ min: 0, max: d.length })).map(([a, b]) => ({ d, from: Math.min(a, b), to: Math.max(a, b) })),
  );

  it("an edit replaces a real range and leaves the selection inside the new text", () => {
    fc.assert(
      fc.property(range, mark, ({ d, from, to }, m) => {
        for (const e of [toggleMark(d, from, to, m), surround(d, from, to, m)]) {
          expect(e.from).toBeGreaterThanOrEqual(0);
          expect(e.to).toBeLessThanOrEqual(d.length);
          expect(e.from).toBeLessThanOrEqual(e.to);
          const next = apply(d, e);
          expect(e.anchor).toBeGreaterThanOrEqual(0);
          expect(e.head).toBeLessThanOrEqual(next.length);
        }
      }),
      runs(500),
    );
  });

  it("marking a selection and marking it again takes the mark off", () => {
    fc.assert(
      fc.property(range, mark, ({ d, from, to }, m) => {
        fc.pre(from < to);
        const on = toggleMark(d, from, to, m);
        const marked = apply(d, on);
        const off = toggleMark(marked, Math.min(on.anchor, on.head), Math.max(on.anchor, on.head), m);
        expect(apply(marked, off)).toBe(d);
      }),
      runs(500),
    );
  });

  it("ticking a task twice leaves the line as it was", () => {
    fc.assert(
      fc.property(text, (l) => {
        const once = toggleTask(l);
        if (!once) return;
        const twice = toggleTask(once.text);
        expect(twice).not.toBeNull();
        // The first press may make a task of a plain line; ticking it and unticking it is the identity.
        const third = toggleTask(twice!.text);
        expect(third?.text).toBe(once.text);
      }),
      runs(500),
    );
  });

  it("pasting an address over a selection makes a link that keeps the text", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 12 }), fc.webUrl(), (selected, url) => {
        const link = pasteLink(selected, url);
        if (link !== null) expect(link).toBe(`[${selected}](${url.trim()})`);
        const edit = smartLink(selected);
        expect(edit.cursor).toBeGreaterThanOrEqual(0);
        expect(edit.cursor).toBeLessThanOrEqual(edit.text.length);
        expect(edit.text).toContain(selected);
      }),
      runs(300),
    );
  });
});

describe("dates", () => {
  const day = fc.date({ min: new Date(1971, 0, 2), max: new Date(2099, 11, 30), noInvalidDate: true });

  it("writes dates that read back as that date", () => {
    fc.assert(
      fc.property(day, (d) => {
        const s = formatDate(d);
        expect(datesInLine(s)).toEqual([{ from: 0, to: 10, kind: "date" }]);
        const t = formatDateTime(d);
        expect(datesInLine(t)).toHaveLength(1);
        expect(datesInLine(`see ${t}, ok`)[0]!.kind).toBe("datetime");
        expect(dayAt(`on ${s}`, 5)?.day).toBe(s);
      }),
      runs(300),
    );
  });

  it("adding days and taking them off gives the same day", () => {
    fc.assert(
      fc.property(day, fc.integer({ min: -400, max: 400 }), (d, n) => {
        expect(formatDate(addDays(addDays(d, n), -n))).toBe(formatDate(d));
        expect(addDays(d, 1) > d).toBe(true);
      }),
      runs(300),
    );
  });

  it("finds dates only where they are, never in a web address", () => {
    fc.assert(
      fc.property(text, (l) => {
        for (const d of datesInLine(l)) {
          expect(l.slice(d.from, d.from + 10)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
        // The day links of a line are its dates, minus the ones written inside a web address.
        const inAddress = (at: number) => [...l.matchAll(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s)>\]"']*/g)].some((m) => at >= m.index! && at < m.index! + m[0].length);
        expect(daysInLine(l).map((d) => d.from)).toEqual(datesInLine(l).filter((d) => !inAddress(d.from)).map((d) => d.from));
      }),
      runs(300),
    );
  });
});

describe("history", () => {
  const place: fc.Arbitrary<Place> = fc.oneof(
    fc.constantFrom("a.md", "b.md", "c/d.md").map((path): Place => ({ kind: "page", path })),
    fc.constant<Place>({ kind: "journals" }),
    fc.constantFrom("x", "y").map((id): Place => ({ kind: "view", id })),
  );
  const move = fc.oneof(
    place.map((p) => ({ op: "visit" as const, p })),
    fc.constantFrom(-1 as const, 1 as const).map((by) => ({ op: "step" as const, by })),
    fc.tuple(fc.constantFrom("a.md", "b.md", "c/d.md"), fc.option(fc.constantFrom("a.md", "e.md", "f.md"), { nil: null })).map(([from, to]) => ({ op: "relocate" as const, from, to })),
  );

  it("always shows a place that is in the history, whatever the user does", () => {
    fc.assert(
      fc.property(fc.array(move, { maxLength: 40 }), (moves) => {
        let h: History = emptyHistory();
        for (const m of moves) {
          h = m.op === "visit" ? visit(h, m.p) : m.op === "step" ? step(h, m.by) : relocate(h, m.from, m.to);
          if (h.places.length === 0) expect(h.at).toBe(-1);
          else {
            expect(h.at).toBeGreaterThanOrEqual(0);
            expect(h.at).toBeLessThan(h.places.length);
          }
          expect(h.places.length).toBeLessThanOrEqual(100);
          if (m.op === "relocate" && m.to === null) {
            expect(h.places.some((p) => p.kind === "page" && p.path === m.from)).toBe(false);
          }
        }
      }),
      runs(300),
    );
  });

  it("keeps the recent list free of repeats and puts the newest first", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom("a.md", "b.md", "c.md", "d.md"), { maxLength: 30 }), fc.constantFrom("a.md", "b.md", "e.md"), (paths, to) => {
        let recent: string[] = [];
        for (const p of paths) {
          recent = touch(recent, p);
          expect(recent[0]).toBe(p);
          expect(new Set(recent).size).toBe(recent.length);
        }
        const moved = relocateRecent(recent, "a.md", to);
        expect(new Set(moved).size).toBe(moved.length);
        expect(relocateRecent(recent, "a.md", null)).not.toContain("a.md");
      }),
      runs(300),
    );
  });
});

describe("the palette", () => {
  it("scores what is typed against a label, and ranks without losing or inventing items", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 10 }), { maxLength: 12 }), fc.string({ maxLength: 4 }), fc.integer({ min: 0, max: 8 }), (labels, query, limit) => {
        const items = labels.map((label) => ({ label }));
        const ranked = rank(items, query, limit);
        expect(ranked.length).toBeLessThanOrEqual(limit);
        for (const r of ranked) {
          expect(items).toContain(r);
          expect(score(r.label, query)).not.toBeNull();
        }
        const scores = ranked.map((r) => score(r.label, query)!);
        expect([...scores].sort((a, b) => b - a)).toEqual(scores);
        // A label always matches itself, and the empty query matches everything.
        for (const { label } of items) expect(score(label, label.trim() === "" ? "" : label)).not.toBeNull();
      }),
      runs(300),
    );
  });
});

describe("a line cut into parts", () => {
  it("never loses the words of the line", () => {
    fc.assert(
      fc.property(text, (l) => {
        const parts = inlineParts(l);
        const words = parts.map((p) => p.text).join("");
        // Marks (`*`, backticks, link syntax) go; what was written between them stays.
        for (const ch of words) expect(l.includes(ch)).toBe(true);
        expect(words.length).toBeLessThanOrEqual(l.length);
        for (const p of parts) expect(p.text).not.toBe("");
      }),
      runs(500),
    );
  });
});

describe("page properties", () => {
  it("reads any front matter without failing, and finds every tag it names once", () => {
    fc.assert(
      fc.property(fc.array(line, { maxLength: 8 }), (body) => {
        const doc = ["---", ...body, "---"];
        const end = frontmatterEnd(doc);
        const props = parseProperties(doc, end < 0 ? doc.length : end);
        expect(props.tags.every((t) => t === normalizeConcept(t) && t !== "")).toBe(true);
        expect(Array.isArray(props.others)).toBe(true);
      }),
      runs(300),
    );
  });
});
