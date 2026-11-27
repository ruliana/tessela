// The reveal policy on its own: what counts as the cursor being in a construct.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { isDrawn, isEditing, isRendered, revealChanged } from "../src/renderer/reveal";
import { revealState } from "./support/reveal";

const doc = "one **two** three";

describe("isEditing", () => {
  it("is true where a selection range touches the span, its ends included", () => {
    const span = { from: 4, to: 11 };
    expect(isEditing(revealState(doc, { at: 4 }), span)).toBe(true);
    expect(isEditing(revealState(doc, { at: 8 }), span)).toBe(true);
    expect(isEditing(revealState(doc, { at: 11 }), span)).toBe(true);
    expect(isEditing(revealState(doc, { at: 3 }), span)).toBe(false);
    expect(isEditing(revealState(doc, { at: 12 }), span)).toBe(false);
    expect(isEditing(revealState(doc, { at: 0, to: 5 }), span)).toBe(true);
  });

  it("is never true without the keyboard focus", () => {
    expect(isEditing(revealState(doc, { at: 8, focused: false }), { from: 4, to: 11 })).toBe(false);
  });

  it("is never true in select mode: blocks are selected, not edited", () => {
    expect(isEditing(revealState(doc, { at: 8, selecting: true }), { from: 4, to: 11 })).toBe(false);
  });

  it("is a property of the selection and the span only", () => {
    fc.assert(
      fc.property(fc.nat(30), fc.nat(30), fc.nat(30), fc.nat(30), (a, b, c, d) => {
        const [from, to] = [Math.min(a, b), Math.max(a, b)];
        const [head, end] = [Math.min(c, d), Math.max(c, d)];
        const text = "x".repeat(40);
        expect(isEditing(revealState(text, { at: head, to: end }), { from, to })).toBe(head <= to && end >= from);
      }),
    );
  });
});

describe("isDrawn", () => {
  it("needs the Markdown to be rendered, and the cursor to be elsewhere", () => {
    const span = { from: 4, to: 11 };
    expect(isDrawn(revealState(doc, { at: 0 }), span)).toBe(true);
    expect(isDrawn(revealState(doc, { at: 8 }), span)).toBe(false);
    expect(isDrawn(revealState(doc, { at: 0, preview: false }), span)).toBe(false);
    expect(isRendered(revealState(doc, { preview: false }))).toBe(false);
  });
});

describe("revealChanged", () => {
  it("is true when the selection, the focus or the mode changes, and not when nothing does", () => {
    const a = revealState(doc, { at: 0 });
    expect(revealChanged(a, revealState(doc, { at: 0 }))).toBe(false);
    expect(revealChanged(a, revealState(doc, { at: 5 }))).toBe(true);
    expect(revealChanged(a, revealState(doc, { at: 0, focused: false }))).toBe(true);
    expect(revealChanged(a, revealState(doc, { at: 0, selecting: true }))).toBe(true);
    expect(revealChanged(a, revealState(doc, { at: 0, preview: false }))).toBe(true);
  });
});
