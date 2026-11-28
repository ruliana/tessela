// Property tests for the block structure: whatever a page holds, the page model describes it
// consistently, and the edits that act on blocks neither lose nor invent text.
//
// Moving a block and moving it back, or nesting an item and taking it out, are checked on
// well-formed outlines only. On a page whose indentation is not an outline (a list item indented
// four spaces after a blank line, an empty item next to indented text) Markdown itself reads the
// same lines differently in different places: such lines are code in one spot and a nested item
// in another, so an exact undo is not a thing an edit can promise.

import { foldEffect, foldedRanges } from "@codemirror/language";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { editSpec, respond } from "../src/renderer/blockKeys";
import { follow } from "../src/shared/blockEdit";
import { frontmatterEndOf, indent, move, outdent } from "../src/shared/blocks";
import { foldAround, foldables, zoomAt } from "../src/shared/folds";
import { at, textOf, toSel, whereIs } from "./support/edits";
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

  /** The words of a page, line by line: without indentation and list markers, and without the lines that have none. */
  const words = (doc: string[]): string[] => doc.map(core).filter((w) => w !== "");

  for (const [name, edit] of Object.entries(edits)) {
    it(`${name} is a change of the page that keeps every line's words, and the selection on a real position`, () => {
      fc.assert(
        fc.property(pageAndSelection, ({ doc, sel }) => {
          const result = edit(model(doc), toSel(doc, sel));
          if (!result) return;
          const out = textOf(doc, result);
          // The changes are over the page they were worked out on, and the edit never makes front matter out of lines that were not, or the other way round.
          expect(result.changes.length).toBe(doc.join("\n").length);
          expect(frontEnd(out)).toBe(frontEnd(doc));
          // Tab and Shift+Tab keep the order of the lines; a move only changes it.
          if (result.moves.length === 0) expect(words(out)).toEqual(words(doc));
          else expect(words(out).sort()).toEqual(words(doc).sort());
          for (const pos of [sel.anchor, sel.head]) {
            const p = whereIs(doc, result, at(doc, pos));
            expect(p.line).toBeGreaterThanOrEqual(0);
            expect(p.line).toBeLessThan(out.length);
            expect(p.col).toBeGreaterThanOrEqual(0);
            expect(p.col).toBeLessThanOrEqual(out[p.line]!.length);
          }
        }),
        runs(300),
      );
    });
  }

  it("moving never drops or doubles a line, and what moved is where the moves say", () => {
    for (const dir of ["up", "down"] as const) {
      fc.assert(
        fc.property(pageAndSelection, ({ doc, sel }) => {
          const result = move(model(doc), toSel(doc, sel), dir);
          if (!result) return;
          const out = textOf(doc, result);
          expect(out.slice().sort()).toEqual(doc.slice().sort());
          // The text of each moved range is whole in the new page, at the new place.
          const before = doc.join("\n");
          const after = out.join("\n");
          for (const m of result.moves) expect(after.slice(m.from + m.by, m.to + m.by)).toBe(before.slice(m.from, m.to));
        }),
        runs(300),
      );
    }
  });

  it("keeps every fold on the text it covered, wherever a move takes the text", () => {
    fc.assert(
      fc.property(pageAndSelection, fc.constantFrom("up", "down"), fc.array(fc.boolean(), { minLength: 20, maxLength: 20 }), ({ doc, sel }, dir, coin) => {
        const text = doc.join("\n");
        const edit = move(model(doc), toSel(doc, sel), dir);
        if (!edit || edit.changes.empty) return;
        // Fold some of the blocks that can fold: what they hide runs from the end of their first line to the end of their last.
        let state = pageState(text);
        const ranges = foldables(model(doc))
          .filter((_, i) => coin[i % coin.length])
          .map((f) => ({ from: state.doc.line(f.line + 1).to, to: state.doc.line(f.last + 1).to }));
        state = state.update({ effects: ranges.map((r) => foldEffect.of(r)) }).state;
        const folds = (s: typeof state): string[] => {
          const out: string[] = [];
          foldedRanges(s).between(0, s.doc.length, (from, to) => void out.push(`${from}-${to}`));
          return out;
        };
        const after = folds(state.update(editSpec(edit)).state);
        for (const r of ranges) {
          const m = edit.moves.find((x) => r.from >= x.from && r.to <= x.to);
          // Inside what moved, the fold went with it; elsewhere it is where the changes put it, or gone with text that they replaced.
          if (m) expect(after).toContain(`${r.from + m.by}-${r.to + m.by}`);
        }
      }),
      runs(300),
    );
  });

  it("never makes front matter out of a page, or breaks it, when it moves a block", () => {
    fc.assert(
      fc.property(outlineAndCursor, fc.constantFrom("up", "down"), ({ doc, sel }, dir) => {
        const result = move(model(doc), toSel(doc, sel), dir);
        if (result) expect(frontEnd(textOf(doc, result))).toBe(frontEnd(doc));
      }),
      runs(300),
    );
  });

  it("moves a block of an outline down and back up to where it started", () => {
    fc.assert(
      fc.property(outlineAndCursor, ({ doc, sel }) => {
        const down = move(model(doc), toSel(doc, sel), "down");
        if (!down) return;
        const moved = textOf(doc, down);
        // At the bottom there is nowhere to go: the answer is the same page.
        if (moved.join("\n") === doc.join("\n")) return;
        const head = follow(down, at(doc, sel.head));
        const back = move(model(moved), { anchor: head, head }, "up");
        expect(back && textOf(moved, back)).toEqual(doc);
      }),
      runs(300),
    );
  });

  it("nests an item of an outline and takes it out again", () => {
    fc.assert(
      fc.property(outlineAndCursor, ({ doc, sel }) => {
        const nested = indent(model(doc), toSel(doc, sel));
        if (!nested) return;
        const text = textOf(doc, nested);
        if (text.join("\n") === doc.join("\n")) return;
        const head = follow(nested, at(doc, sel.head));
        const back = outdent(model(text), { anchor: head, head });
        expect(back && textOf(text, back)).toEqual(doc);
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
