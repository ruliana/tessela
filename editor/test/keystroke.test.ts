// Typing stays fast as features pile up. A page of 5,000 lines gets every extension of the editor and
// of the built-in mods, and typing goes through it a key at a time: the transaction (the state fields:
// parser, page model, block widgets, folds) and what the view plugins then draw. The target is 8 ms for
// all of it, so that a key is on the screen within a frame (TARGET_MS). It is met: a key costs about 5 to 7 ms
// on a laptop. The budgets below are what CI holds the editor to, about 3x that for a noisy runner; a PR that
// makes typing faster lowers them. `TESSELA_STATS=1 npm test -- keystroke` prints the table.

import fc from "fast-check";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { bigPage } from "./support/bigPage";
import { type Provider, type Viewport, typingEditor } from "./support/editorState";

const LINES = 5000;
/** What typing should cost, in milliseconds, for a key: the transaction and the decorations together. */
const TARGET_MS = 8;
/** What CI holds each part to, in milliseconds per key (median), at 5,000 lines. About 3x what a laptop measures. */
const BUDGET_MS = {
  /** The state fields: parser, page model, block widgets, folds, fences. */
  transaction: 16,
  /** View plugins that draw only the viewport. These should stay within the target on their own. */
  viewport: 4,
  /** View plugins that still read the whole page. There should be none: one is a reason to make it read the viewport. */
  page: 4,
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

interface Cost {
  transaction: number;
  viewport: number;
  page: number;
}

/** Types `TYPED` at `pos`, a key at a time, and gives the median cost of a key. The first keys warm things up and do not count. */
function typeAt(pos: number): Cost {
  let state = start.update({ selection: { anchor: pos } }).state;
  const costs: Record<keyof Cost, number[]> = { transaction: [], viewport: [], page: [] };
  for (const [i, key] of [...TYPED].entries()) {
    const at = state.selection.main.head;
    const before = performance.now();
    state = state.update({ changes: { from: at, insert: key }, selection: { anchor: at + 1 }, userEvent: "input.type" }).state;
    const afterTransaction = performance.now();
    const spent = { viewport: 0, page: 0 };
    for (const p of providers) {
      const t = performance.now();
      p.draw(state, viewportAt(state, at + 1));
      spent[p.scope] += performance.now() - t;
    }
    if (i < 6) continue;
    costs.transaction.push(afterTransaction - before);
    costs.viewport.push(spent.viewport);
    costs.page.push(spent.page);
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

  it("costs a key no more than the budgets, wherever it is typed", () => {
    const rows = Object.entries(places).map(([where, pos]) => ({ where, ...typeAt(pos) }));
    if (process.env.TESSELA_STATS) {
      const f = (n: number) => n.toFixed(1).padStart(6);
      console.log(`\nper key, median ms, ${LINES} lines (target ${TARGET_MS} in all; budgets ${BUDGET_MS.transaction} / ${BUDGET_MS.viewport} / ${BUDGET_MS.page})`);
      console.log("where                | transaction | viewport plugins | whole-page plugins | total");
      for (const r of rows) console.log(`${r.where.padEnd(20)} | ${f(r.transaction)}      | ${f(r.viewport)}           | ${f(r.page)}             | ${f(r.transaction + r.viewport + r.page)}`);
    }
    for (const r of rows) {
      expect(r.transaction, `${r.where}: transaction`).toBeLessThan(BUDGET_MS.transaction);
      expect(r.viewport, `${r.where}: viewport plugins`).toBeLessThan(BUDGET_MS.viewport);
      expect(r.page, `${r.where}: whole-page plugins`).toBeLessThan(BUDGET_MS.page);
    }
  }, 60_000);
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
