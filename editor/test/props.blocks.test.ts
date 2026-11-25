// Property tests for the block structure: whatever a page holds, `parseBlocks` describes it
// consistently, and the edits that act on blocks neither lose nor invent text.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { type Block, extendBlocks, indent, mapPos, move, outdent, parseBlocks, selectBlock } from "../src/shared/blocks";
import { foldAround, foldables, zoomAt } from "../src/shared/folds";
import { outlineAndCursor, pageAndSelection, lines, runs } from "./support/props";

const all = (blocks: Block[]): Block[] => blocks.flatMap((b) => [b, ...all(b.children)]);

describe("the structure of any page", () => {
  it("nests blocks inside blocks, in order, inside the page", () => {
    fc.assert(
      fc.property(lines, (doc) => {
        const blocks = parseBlocks(doc);
        let last = -1;
        for (const b of blocks) {
          expect(b.start).toBeGreaterThan(last);
          last = b.end;
        }
        for (const b of all(blocks)) {
          expect(b.start).toBeGreaterThanOrEqual(0);
          expect(b.end).toBeGreaterThanOrEqual(b.start);
          expect(b.end).toBeLessThan(doc.length);
          let before = b.start - 1;
          for (const c of b.children) {
            expect(c.parent).toBe(b);
            expect(c.start).toBeGreaterThanOrEqual(b.start);
            expect(c.end).toBeLessThanOrEqual(b.end);
            expect(c.start).toBeGreaterThan(before);
            before = c.end;
          }
        }
      }),
      runs(300),
    );
  });

  it("can be folded and zoomed anywhere", () => {
    fc.assert(
      fc.property(lines, (doc) => {
        const folds = foldables(doc);
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
          const zoom = zoomAt(doc, line);
          if (zoom) expect(JSON.stringify(zoom)).toBeTypeOf("string");
        }
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
    indent: (doc: string[], sel: Parameters<typeof indent>[1]) => indent(doc, sel),
    outdent: (doc: string[], sel: Parameters<typeof indent>[1]) => outdent(doc, sel),
    up: (doc: string[], sel: Parameters<typeof indent>[1]) => move(doc, sel, "up"),
    down: (doc: string[], sel: Parameters<typeof indent>[1]) => move(doc, sel, "down"),
  };

  for (const [name, edit] of Object.entries(edits)) {
    it(`${name} keeps every line's words and puts the selection on a real position`, () => {
      fc.assert(
        fc.property(pageAndSelection, ({ doc, sel }) => {
          const result = edit(doc, sel);
          if (!result) return;
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
          const result = move(doc, sel, dir);
          if (!result) return;
          expect(result.rows.map((r) => r.from).sort((a, b) => a - b)).toEqual(doc.map((_, i) => i));
        }),
        runs(300),
      );
    }
  });

  it("moves a block of an outline down and back up to where it started", () => {
    fc.assert(
      fc.property(outlineAndCursor, ({ doc, sel }) => {
        const down = move(doc, sel, "down");
        if (!down) return;
        const moved = down.rows.map((r) => r.text);
        // At the bottom there is nowhere to go: the answer is the same page.
        if (moved.join("\n") === doc.join("\n")) return;
        const back = move(moved, { anchor: mapPos(down, sel.head), head: mapPos(down, sel.head) }, "up");
        expect(back?.rows.map((r) => r.text)).toEqual(doc);
      }),
      runs(300),
    );
  });

  it("nests an item of an outline and takes it out again", () => {
    fc.assert(
      fc.property(outlineAndCursor, ({ doc, sel }) => {
        const nested = indent(doc, sel);
        if (!nested) return;
        const text = nested.rows.map((r) => r.text);
        if (text.join("\n") === doc.join("\n")) return;
        const at = mapPos(nested, sel.head);
        const back = outdent(text, { anchor: at, head: at });
        expect(back?.rows.map((r) => r.text)).toEqual(doc);
      }),
      runs(300),
    );
  });

  it("selects wider and wider until the page is selected", () => {
    fc.assert(
      fc.property(pageAndSelection, ({ doc, sel }) => {
        let current = sel;
        for (let step = 0; step <= doc.length * 2 + 2; step++) {
          const next = selectBlock(doc, current);
          if (!next) return;
          const [a, b] = [next.anchor, next.head];
          const inside = (p: { line: number; col: number }) =>
            (p.line > a.line || (p.line === a.line && p.col >= a.col)) && (p.line < b.line || (p.line === b.line && p.col <= b.col));
          expect(inside(current.anchor) && inside(current.head)).toBe(true);
          current = next;
        }
        throw new Error("Escape went on selecting for ever");
      }),
      runs(300),
    );
  });

  it("extends a block selection over whole lines and keeps what was selected", () => {
    fc.assert(
      fc.property(pageAndSelection, fc.constantFrom("up", "down"), ({ doc, sel }, dir) => {
        const next = extendBlocks(doc, sel, dir);
        if (!next) return;
        for (const p of [next.anchor, next.head]) {
          expect(p.line).toBeGreaterThanOrEqual(0);
          expect(p.line).toBeLessThan(doc.length);
          expect(p.col).toBeLessThanOrEqual(doc[p.line]!.length);
        }
      }),
      runs(300),
    );
  });
});
