// Property tests for select mode as a state machine: from any page, any folds and zoom, and any keys in
// any order, the editor is editing or has a valid run of sibling blocks selected, the text selection is
// exactly those blocks, and the mode is left and entered only through the transitions the key table lists.

import { foldedRanges } from "@codemirror/language";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { KEYS, type Key, LEAVE, STAY, respond, typed } from "../src/renderer/blockKeys";
import { pageModel } from "../src/renderer/pageModelField";
import { blockSelection, visibleIn } from "../src/renderer/selectMode";
import { membersOf, selectable, selectedLines } from "../src/shared/blockSelection";
import { foldables, zoomAt } from "../src/shared/folds";
import { lines, outline, runs } from "./support/props";
import { type Setup, pageState } from "./support/selecting";
import type { EditorState } from "@codemirror/state";

type Step = Key | "type";

/** Mostly keys that select and step, now and then one that edits, so that runs spend their time in select mode. */
const steps = fc.array(
  fc.oneof(
    { weight: 6, arbitrary: fc.constantFrom<Step>("Escape", "ArrowUp", "ArrowDown", "Shift-ArrowUp", "Shift-ArrowDown") },
    { weight: 3, arbitrary: fc.constantFrom<Step>("Tab", "Shift-Tab", "Alt-ArrowUp", "Alt-ArrowDown", "Mod-d", "Mod-Enter", "Backspace", "Delete") },
    { weight: 1, arbitrary: fc.constantFrom<Step>(...KEYS, "type") },
  ),
  { maxLength: 16 },
);

/** A page with a cursor, some folds and sometimes a zoom, all of them picked from what the page has. */
const scene = fc
  .oneof(lines, outline)
  .chain((doc) =>
    fc.tuple(
      fc.constant(doc.join("\n")),
      fc.nat(doc.join("\n").length),
      fc.array(fc.nat(), { maxLength: 3 }),
      fc.option(fc.nat(), { nil: undefined }),
    ),
  )
  .map(([text, at, foldPicks, zoomPick]): { text: string; setup: Setup } => {
    const probe = pageState(text);
    const model = probe.field(pageModel);
    const found = foldables(model);
    const folds = found.length > 0 ? [...new Set(foldPicks.map((n) => n % found.length))].map((i) => ({ first: found[i]!.line, last: found[i]!.last })) : [];
    let zoom: Setup["zoom"];
    if (zoomPick !== undefined) {
      const z = zoomAt(model, zoomPick % probe.doc.lines);
      if (z) zoom = { first: z.start, last: z.end };
    }
    return { text, setup: { at, ...(folds.length > 0 ? { folds } : {}), ...(zoom ? { zoom } : {}) } };
  });

/** What a step does to a state, and whether the machine took the key. */
function apply(state: EditorState, step: Step): { state: EditorState; taken: boolean } {
  if (step === "type") {
    const spec = typed(state, "x");
    return spec ? { state: state.update(spec).state, taken: true } : { state, taken: false };
  }
  const reply = respond(state, step);
  if (reply === null) return { state, taken: false };
  if (reply === STAY || reply === LEAVE) return { state, taken: true };
  return { state: state.update(reply).state, taken: true };
}

/** The ways out of select mode that the table lists. */
const EXITS: Step[] = ["Enter", " ", "ArrowLeft", "ArrowRight", "type", "Backspace", "Delete", "Mod-Enter", "Mod-d", "Tab", "Shift-Tab", "Alt-ArrowUp", "Alt-ArrowDown"];

function check(state: EditorState): void {
  const sel = state.field(blockSelection);
  if (!sel) return;
  const model = state.field(pageModel);
  // A valid run: siblings of one parent, all of them blocks of this version of the page.
  expect(sel.anchor.parent).toBe(sel.head.parent);
  expect(sel.anchor.model).toBe(model);
  expect(sel.head.model).toBe(model);
  const members = membersOf(sel);
  expect(members.length).toBeGreaterThan(0);
  for (const n of members) expect(selectable(n)).toBe(true);
  expect(sel.heading && (members.length !== 1 || members[0]!.kind !== "section")).toBe(false);
  // The text selection is exactly the lines of those blocks.
  const [first, last] = selectedLines(sel);
  const { from, to } = state.selection.main;
  expect([Math.min(from, to), Math.max(from, to)]).toEqual([state.doc.line(first + 1).from, state.doc.line(last + 1).to]);
  expect(state.selection.ranges).toHaveLength(1);
}

describe("select mode on any page, with any keys", () => {
  it("is always editing, or a valid run of blocks that the text selection covers exactly", () => {
    fc.assert(
      fc.property(scene, steps, ({ text, setup }, keys) => {
        let state = pageState(text, setup);
        for (const key of ["Escape" as Step, ...keys]) {
          state = apply(state, key).state;
          check(state);
        }
      }),
      runs(400),
    );
  });

  it("enters only with Escape and leaves only through the listed keys", () => {
    fc.assert(
      fc.property(scene, steps, ({ text, setup }, keys) => {
        let state = pageState(text, setup);
        for (const key of ["Escape" as Step, ...keys]) {
          const before = state.field(blockSelection) !== null;
          const { state: next, taken } = apply(state, key);
          const after = next.field(blockSelection) !== null;
          if (!before && after) expect(key).toBe("Escape");
          if (before && !after) expect(EXITS).toContain(key);
          // A key that is not taken changes nothing.
          if (!taken) expect(next).toBe(state);
          state = next;
        }
      }),
      runs(400),
    );
  });

  it("selects only blocks that are shown, when the text has not changed: not in a fold, not outside a zoom", () => {
    fc.assert(
      fc.property(scene, steps, ({ text, setup }, keys) => {
        let state = pageState(text, setup);
        const original = state.doc;
        for (const key of ["Escape" as Step, ...keys]) {
          const { state: next } = apply(state, key);
          const sel = next.field(blockSelection);
          // (A zoom here is fixed lines, where the fold mod's moves with the text: past an edit it says nothing.)
          if (sel && next.doc === state.doc && (!setup.zoom || next.doc === original) && sel !== state.field(blockSelection)) {
            const visible = visibleIn(next);
            for (const n of membersOf(sel)) expect(visible(n), `${n} in\n${text}`).toBe(true);
          }
          state = next;
        }
      }),
      runs(400),
    );
  });

  it("does not touch the text while only selecting, and opens no fold that the selected blocks do not run into", () => {
    fc.assert(
      fc.property(scene, fc.array(fc.constantFrom<Step>("Escape", "ArrowUp", "ArrowDown", "Shift-ArrowUp", "Shift-ArrowDown"), { maxLength: 10 }), ({ text, setup }, keys) => {
        let state = pageState(text, setup);
        for (const key of ["Escape" as Step, ...keys]) {
          const { state: next } = apply(state, key);
          expect(next.doc.toString()).toBe(text);
          // CodeMirror opens a fold when the selection ends inside it. A block never ends there, except in text that
          // the parser reads against its own shape (a quote inside an item, cut short by a lazy line), so only
          // the blocks that end at a fold's end are asked not to.
          const head = next.selection.main.head;
          let inside = false;
          foldedRanges(state).between(head, head, (a, b) => {
            if (a < head && b > head) inside = true;
          });
          if (!inside) expect(foldedRanges(next).size).toBe(foldedRanges(state).size);
          state = next;
        }
      }),
      runs(200),
    );
  });
});
