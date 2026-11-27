// Property tests for the block structure: whatever a page holds, the page model describes it
// consistently, and the edits that act on blocks neither lose nor invent text.
//
// Moving a block and moving it back, or nesting an item and taking it out, are checked on
// well-formed outlines only. On a page whose indentation is not an outline (a list item indented
// four spaces after a blank line, an empty item next to indented text) Markdown itself reads the
// same lines differently in different places: such lines are code in one spot and a nested item
// in another, so an exact undo is not a thing an edit can promise.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { respond } from "../src/renderer/blockKeys";
import { frontmatterEndOf, indent, mapPos, move, outdent } from "../src/shared/blocks";
import { foldAround, foldables, zoomAt } from "../src/shared/folds";
import { modelOf } from "./support/page";
import { outlineAndCursor, pageAndSelection, lines, runs } from "./support/props";
import { offsetOf, pageState } from "./support/selecting";

const model = (doc: string[]) => modelOf(doc.join("\n"));
const frontEnd = (doc: string[]) => frontmatterEndOf(model(doc));

describe("folding and zooming any page", () => {
  it("never folds a block onto itself or past the page, with a key of its own each", () => {
    fc.assert(
      fc.property(lines, (doc) => {
        const m = model(doc);
        const folds = foldables(m);
        const keys = new Set<string>();
        for (const f of folds) {
          expect(f.last).toBeGreaterThan(f.line);
          expect(f.last).toBeLessThan(doc.length);
          expect(keys.has(f.key)).toBe(false);
          keys.add(f.key);
        }
        for (let line = 0; line < doc.length; line++) {
          const fold = foldAround(folds, line);
          if (fold) expect(line >= fold.line && line <= fold.last).toBe(true);
          const zoom = zoomAt(m, line);
          if (zoom) {
            expect(zoom.start).toBeLessThanOrEqual(line);
            expect(zoom.end).toBeGreaterThanOrEqual(line);
            expect(zoom.end).toBeLessThan(doc.length);
          }
        }
      }),
      runs(200),
    );
  });

  it("folds exactly the sections, items and fences with more than a line, and the paragraphs that own a list", () => {
    fc.assert(
      fc.property(lines, (doc) => {
        const m = model(doc);
        const want = new Set<number>();
        for (const n of m.nodes) {
          if (n.kind === "paragraph" && n.children.length > 0) want.add(n.children[0]!.startLine - 2);
          else if ((n.kind === "section" || n.kind === "item" || (n.kind === "code" && n.fence)) && n.endLine > n.startLine) want.add(n.startLine - 1);
        }
        expect(new Set(foldables(m).map((f) => f.line))).toEqual(want);
      }),
      runs(200),
    );
  });
});

/** The text of a line without its indentation and list marker. */
const core = (s: string): string => {
  const rest = s.replace(/^\s*(?:[-*+]|\d{1,9}[.)])(?:\s+|$)/, "");
  return rest === s ? s.trim() : core(rest);
};

describe("edits on blocks", () => {
  const edits = {
    indent,
    outdent,
    up: (m: ReturnType<typeof model>, sel: Parameters<typeof indent>[1]) => move(m, sel, "up"),
    down: (m: ReturnType<typeof model>, sel: Parameters<typeof indent>[1]) => move(m, sel, "down"),
  };

  for (const [name, edit] of Object.entries(edits)) {
    it(`${name} keeps every line's words and puts the selection on a real position`, () => {
      fc.assert(
        fc.property(pageAndSelection, ({ doc, sel }) => {
          const result = edit(model(doc), sel);
          if (!result) return;
          // An edit never makes front matter out of lines that were not, or the other way round.
          expect(frontEnd(result.rows.map((r) => r.text))).toBe(frontEnd(doc));
          const from = result.rows.filter((r) => r.from >= 0).map((r) => r.from);
          expect(new Set(from).size).toBe(from.length);
          for (const row of result.rows) {
            if (row.from < 0) continue;
            expect(row.from).toBeLessThan(doc.length);
            expect(core(row.text)).toBe(core(doc[row.from]!));
          }
          for (const pos of [sel.anchor, sel.head]) {
            const p = mapPos(result, pos);
            expect(p.line).toBeGreaterThanOrEqual(0);
            expect(p.line).toBeLessThan(result.rows.length);
            expect(p.col).toBeGreaterThanOrEqual(0);
            expect(p.col).toBeLessThanOrEqual(result.rows[p.line]!.text.length);
          }
        }),
        runs(300),
      );
    });
  }

  it("moving never drops or doubles a line", () => {
    for (const dir of ["up", "down"] as const) {
      fc.assert(
        fc.property(pageAndSelection, ({ doc, sel }) => {
          const result = move(model(doc), sel, dir);
          if (!result) return;
          expect(result.rows.map((r) => r.from).sort((a, b) => a - b)).toEqual(doc.map((_, i) => i));
        }),
        runs(300),
      );
    }
  });

  it("never makes front matter out of a page, or breaks it, when it moves a block", () => {
    fc.assert(
      fc.property(outlineAndCursor, fc.constantFrom("up", "down"), ({ doc, sel }, dir) => {
        const result = move(model(doc), sel, dir);
        if (result) expect(frontEnd(result.rows.map((r) => r.text))).toBe(frontEnd(doc));
      }),
      runs(300),
    );
  });

  it("moves a block of an outline down and back up to where it started", () => {
    fc.assert(
      fc.property(outlineAndCursor, ({ doc, sel }) => {
        const down = move(model(doc), sel, "down");
        if (!down) return;
        const moved = down.rows.map((r) => r.text);
        // At the bottom there is nowhere to go: the answer is the same page.
        if (moved.join("\n") === doc.join("\n")) return;
        const back = move(model(moved), { anchor: mapPos(down, sel.head), head: mapPos(down, sel.head) }, "up");
        expect(back?.rows.map((r) => r.text)).toEqual(doc);
      }),
      runs(300),
    );
  });

  it("nests an item of an outline and takes it out again", () => {
    fc.assert(
      fc.property(outlineAndCursor, ({ doc, sel }) => {
        const nested = indent(model(doc), sel);
        if (!nested) return;
        const text = nested.rows.map((r) => r.text);
        if (text.join("\n") === doc.join("\n")) return;
        const at = mapPos(nested, sel.head);
        const back = outdent(model(text), { anchor: at, head: at });
        expect(back?.rows.map((r) => r.text)).toEqual(doc);
      }),
      runs(300),
    );
  });

  it("selects wider and wider until the page is selected, each time holding what was selected", () => {
    fc.assert(
      fc.property(pageAndSelection, ({ doc, sel }) => {
        const text = doc.join("\n");
        const at = (p: { line: number; col: number }) => offsetOf(text, p.line, p.col);
        let state = pageState(text, { at: at(sel.anchor), to: at(sel.head) });
        let held = { from: Math.min(at(sel.anchor), at(sel.head)), to: Math.max(at(sel.anchor), at(sel.head)) };
        for (let step = 0; step <= doc.length * 2 + 2; step++) {
          const reply = respond(state, "Escape");
          if (typeof reply !== "object" || reply === null) return;
          state = state.update(reply).state;
          const { from, to } = state.selection.main;
          expect(from <= held.from && to >= held.to).toBe(true);
          held = { from, to };
        }
        throw new Error("Escape went on selecting for ever");
      }),
      runs(300),
    );
  });
});
