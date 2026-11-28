// Typing stays fast as features pile up. A page of 5,000 lines gets every extension of the editor and
// of the built-in mods, and typing goes through it a key at a time: the transaction (the state fields:
// parser, page model, block widgets, folds) and what the view plugins then draw. The target is 8 ms for
// all of it, so that a key is on the screen within a frame (TARGET_MS): a key costs about 5 to 7 ms on a laptop.
//
// What fails here is work, not time: a runner that is busy for a moment must not fail a build, and a laptop
// must not pass what a slower machine would feel. The tests count the steps through the syntax tree and the
// lookups in the text of the page (see `support/work.ts`), which are the same on every machine, and hold
// each part of a key to a budget of them. A PR that makes typing do less lowers the budgets. Time is
// measured too, and printed, to set a budget for a new part: `TESSELA_STATS=1 npm test -- keystroke`
// prints the table (milliseconds per key, median, and the work per key, mean).

import fc from "fast-check";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { bigPage } from "./support/bigPage";
import { type Provider, type Viewport, typingEditor } from "./support/editorState";
import { type Work, measure, none, sum } from "./support/work";

const LINES = 5000;
/** What typing should cost, in milliseconds, for a key: the transaction and the decorations together. Not checked: see the top. */
const TARGET_MS = 8;
/**
 * What each part of a key may do, in steps through the syntax tree and lookups in the page (the two added up),
 * on average per key, at 5,000 lines. About 15% over what each does now. The characters read are held too:
 * the parser and the page model read the text of the page in pieces, and reading it all would show here.
 */
const BUDGET = {
  /** The state fields: parser, page model, block widgets, folds, fences. */
  transaction: { steps: 59_000, chars: 21_500 },
  /** View plugins that draw only the viewport. These should stay within the target on their own. (The characters are the page once over, for now: footnotes are found by searching its text.) */
  viewport: { steps: 4_400, chars: 315_000 },
  /** View plugins that still read the whole page. There should be none: one is a reason to make it read the viewport. */
  page: { steps: 0, chars: 0 },
};
/** Lines drawn around the cursor, about a screen and a half. */
const SCREEN = 60;

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

const { state: start, providers } = typingEditor(bigPage(LINES));

function viewportAt(state: EditorState, pos: number, lines = SCREEN): Viewport {
  const line = state.doc.lineAt(pos).number;
  return { from: state.doc.line(Math.max(1, line - lines / 2)).from, to: state.doc.line(Math.min(state.doc.lines, line + lines / 2)).to };
}

/** The text that is typed: words, marks of Markdown, a new line and a new list item. */
const TYPED = "the **quick** [fox](/a.md) #tag\n- over\n  - `lazy` dog ";

type Part = keyof typeof BUDGET;

const steps = (w: Work) => w.tree + w.text;

/** The part of a key that a provider's decorations belong to. */
const partOf = (p: Provider): Part => (p.scope === "page" ? "page" : "viewport");

/** Types `TYPED` at `pos`, a key at a time, and gives the work that a key costs on average. */
function workAt(pos: number): Record<Part, Work> {
  let state = start.update({ selection: { anchor: pos } }).state;
  const total: Record<Part, Work> = { transaction: none(), viewport: none(), page: none() };
  for (const key of TYPED) {
    const at = state.selection.main.head;
    const typed = measure(state, () => state.update({ changes: { from: at, insert: key }, selection: { anchor: at + 1 }, userEvent: "input.type" }).state);
    state = typed.result;
    total.transaction = sum(total.transaction, typed.work);
    for (const p of providers) total[partOf(p)] = sum(total[partOf(p)], measure(state, () => p.draw(state, viewportAt(state, at + 1))).work);
  }
  const keys = [...TYPED].length;
  const mean = (w: Work): Work => ({ tree: Math.round(w.tree / keys), text: Math.round(w.text / keys), chars: Math.round(w.chars / keys) });
  return { transaction: mean(total.transaction), viewport: mean(total.viewport), page: mean(total.page) };
}

/** The same, timed: the median of what a key costs in milliseconds, for the table and for nothing else. The first keys warm the engine up and do not count. */
function msAt(pos: number): Record<Part, number> {
  let state = start.update({ selection: { anchor: pos } }).state;
  const costs: Record<Part, number[]> = { transaction: [], viewport: [], page: [] };
  for (const [i, key] of [...TYPED].entries()) {
    const at = state.selection.main.head;
    const before = performance.now();
    state = state.update({ changes: { from: at, insert: key }, selection: { anchor: at + 1 }, userEvent: "input.type" }).state;
    const spent: Record<Part, number> = { transaction: performance.now() - before, viewport: 0, page: 0 };
    for (const p of providers) {
      const t = performance.now();
      p.draw(state, viewportAt(state, at + 1));
      spent[partOf(p)] += performance.now() - t;
    }
    if (i < 6) continue;
    for (const part of Object.keys(costs) as Part[]) costs[part].push(spent[part]);
  }
  return { transaction: median(costs.transaction), viewport: median(costs.viewport), page: median(costs.page) };
}

const places = {
  "the top of the page": start.doc.line(8).to,
  "the middle": start.doc.lineAt(Math.floor(start.doc.length / 2)).to,
  "the end": start.doc.line(start.doc.lines - 1).to,
};

describe(`typing in a page of ${LINES} lines`, () => {
  it("is a page with everything that is drawn: tables, code, callouts, footnotes, math, links, tasks and front matter", () => {
    const names = new Set<string>();
    syntaxTree(start).iterate({ enter: (n) => void names.add(n.name) });
    for (const name of ["FrontMatter", "Table", "FencedCode", "Callout", "FootnoteReference", "FootnoteDefinition", "MathBlock", "InlineMath", "Link", "Task", "ATXHeading2"]) {
      expect([...names]).toContain(name);
    }
    expect(start.doc.lines).toBeGreaterThanOrEqual(LINES);
  });

  it("costs a key no more work than the budgets, wherever it is typed", () => {
    const rows = Object.entries(places).map(([where, pos]) => ({ where, work: workAt(pos) }));
    if (process.env.TESSELA_STATS) {
      const cell = (w: Work, ms: number) => `${String(steps(w)).padStart(7)} steps ${String(w.chars).padStart(7)} chars ${ms.toFixed(1).padStart(5)} ms`;
      console.log(`\nper key, ${LINES} lines (target ${TARGET_MS} ms in all). Work: mean of steps through the tree and lookups in the page, and characters read. Time: median, checked against nothing.`);
      console.log(`budgets: transaction ${BUDGET.transaction.steps} steps ${BUDGET.transaction.chars} chars | viewport ${BUDGET.viewport.steps} / ${BUDGET.viewport.chars} | whole-page ${BUDGET.page.steps} / ${BUDGET.page.chars}`);
      console.log("where                | transaction                       | viewport plugins                  | whole-page plugins");
      for (const r of rows) {
        const ms = msAt(places[r.where as keyof typeof places]);
        console.log(`${r.where.padEnd(20)} | ${cell(r.work.transaction, ms.transaction)} | ${cell(r.work.viewport, ms.viewport)} | ${cell(r.work.page, ms.page)}`);
      }
    }
    for (const r of rows) {
      for (const part of Object.keys(BUDGET) as Part[]) {
        const work = r.work[part];
        expect(steps(work), `${r.where}: ${part}, steps`).toBeLessThanOrEqual(BUDGET[part].steps);
        expect(work.chars, `${r.where}: ${part}, characters read`).toBeLessThanOrEqual(BUDGET[part].chars);
      }
    }
  }, 60_000);
});

describe("the work that is counted", () => {
  it("is the same on every run, and is what the code does with the tree and the text", () => {
    const pos = start.doc.line(8).to;
    expect(workAt(pos)).toEqual(workAt(pos));
    const walk = measure(start, () => {
      let nodes = 0;
      syntaxTree(start).iterate({ enter: () => void nodes++ });
      return nodes;
    });
    expect(walk.work.tree).toBeGreaterThanOrEqual(walk.result);
    const text = measure(start, () => start.doc.sliceString(0, 100));
    expect(text.work).toEqual({ tree: 0, text: 1, chars: 100 });
  });
});

describe("what is drawn per viewport is drawn only there", () => {
  const draws = providers.filter((p: Provider) => p.scope === "viewport");

  /** The viewport, widened over the code blocks it touches: a block is marked whole, line by line. */
  function allowed(state: EditorState, vp: Viewport): Viewport {
    const out = { ...vp };
    syntaxTree(state).iterate({
      from: vp.from,
      to: vp.to,
      enter: (n) => {
        if (n.name !== "FencedCode" && n.name !== "CodeBlock") return;
        out.from = Math.min(out.from, n.from);
        out.to = Math.max(out.to, n.to);
        return false;
      },
    });
    return out;
  }

  it("makes no decoration outside the viewport, for any cursor and any size of viewport", () => {
    expect(draws.length).toBeGreaterThan(0);
    fc.assert(
      fc.property(fc.nat(start.doc.length), fc.integer({ min: 1, max: 200 }), (pos, lines) => {
        const state = start.update({ selection: { anchor: pos } }).state;
        const vp = viewportAt(state, pos, lines);
        const ok = allowed(state, vp);
        for (const p of draws) {
          for (const cursor = p.draw(state, vp).iter(); cursor.value; cursor.next()) {
            expect(cursor.to >= ok.from && cursor.from <= ok.to, `${p.name}: ${cursor.from}-${cursor.to} is outside ${ok.from}-${ok.to}`).toBe(true);
          }
        }
      }),
      { numRuns: 40 },
    );
  });
});
