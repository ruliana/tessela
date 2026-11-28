import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { COUNT_CAP, countLabel, tally } from "../src/shared/find";
import { runs } from "./support/props";

const css = readFileSync(new URL("../src/renderer/style.css", import.meta.url), "utf8");

const ranges = fc
  .array(fc.integer({ min: 0, max: 5000 }), { maxLength: 40 })
  .map((xs) => [...new Set(xs)].sort((a, b) => a - b).map((from) => ({ from, to: from + 2 })));

describe("tally", () => {
  it("finds the selection among the matches, counting from 1", () => {
    const m = [{ from: 0, to: 3 }, { from: 10, to: 13 }, { from: 20, to: 23 }];
    expect(tally(m.values(), { from: 10, to: 13 })).toEqual({ total: 3, capped: false, current: 2 });
    expect(tally(m.values(), { from: 11, to: 13 })).toEqual({ total: 3, capped: false, current: 0 });
  });

  it("is bounded: it reads one match past the cap at most", () => {
    let read = 0;
    function* endless() {
      for (let i = 0; ; i++) {
        read++;
        yield { from: i * 5, to: i * 5 + 2 };
      }
    }
    expect(tally(endless(), { from: 0, to: 2 })).toEqual({ total: COUNT_CAP, capped: true, current: 1 });
    expect(read).toBe(COUNT_CAP + 1);
  });

  it("never puts the current match outside the total", () => {
    fc.assert(
      fc.property(ranges, fc.integer({ min: 0, max: 5000 }), (m, at) => {
        const t = tally(m.values(), { from: at, to: at + 2 }, 20);
        expect(t.total).toBe(Math.min(m.length, 20));
        expect(t.capped).toBe(m.length > 20);
        expect(t.current).toBeGreaterThanOrEqual(0);
        expect(t.current).toBeLessThanOrEqual(t.total);
      }),
      runs(100),
    );
  });
});

describe("countLabel", () => {
  it("says nothing before a search, and says when nothing matches", () => {
    expect(countLabel(null)).toBe("");
    expect(countLabel({ total: 0, capped: false, current: 0 })).toBe("none");
  });

  it("gives the place and the count, or just the count off a match", () => {
    expect(countLabel({ total: 12, capped: false, current: 3 })).toBe("3/12");
    expect(countLabel({ total: 12, capped: false, current: 0 })).toBe("12");
    expect(countLabel({ total: 999, capped: true, current: 4 })).toBe("4/999+");
  });
});

// The find box is drawn over the page. If it took height, opening it would push the text down.
describe("the find box's place", () => {
  const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.[\]]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";

  it("sits in a strip with no height, and the box floats in it", () => {
    expect(rule(".cm-editor .cm-panels")).toMatch(/position:\s*sticky/);
    expect(rule(".cm-editor .cm-panels")).toMatch(/height:\s*0/);
    expect(rule(".cm-editor .cm-panel.cm-search")).toMatch(/position:\s*absolute/);
  });

  it("uses a text size as large as the page's chrome, not CodeMirror's small default", () => {
    const size = Number(rule(".cm-editor .cm-panel.cm-search").match(/font:\s*(?:\d+\s+)?(\d+)px/)?.[1]);
    expect(size).toBeGreaterThanOrEqual(14);
  });
});
