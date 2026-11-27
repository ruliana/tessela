// What the gfm-extras mod draws, and when it shows the Markdown instead: the same reveal policy as
// the rest of live preview (see `livePreview.test.ts`).

import { describe, expect, it } from "vitest";

import { mathDecorations, textDecorations } from "../src/mods/gfm-extras/main";
import { isEditing, isRendered } from "../src/renderer/reveal";
import { coversRange } from "../src/renderer/selectMode";
import { describe as shown, revealState } from "./support/reveal";

const reveal = { rendered: isRendered, isEditing };
const text = (doc: string, where = {}) => shown(textDecorations(revealState(doc, where), reveal));
const math = (doc: string, where = {}) => shown(mathDecorations(revealState(doc, where), reveal));
const widgets = (list: string[], name: string) => list.filter((d) => d.endsWith(` ${name}`));

describe("a footnote reference is shown as typed only while the cursor is on it", () => {
  const doc = "Plain **bold** words[^1] and more.\n\n[^1]: The note.\n";
  const ref = doc.indexOf("[^1]");

  it("with the cursor on plain text in the paragraph, the reference stays drawn, and so does the bold", () => {
    expect(widgets(text(doc, { at: 2 }), "Number_")).toEqual([`${ref}-${ref + 4} Number_`, `${doc.indexOf("[^1]:")}-${doc.indexOf("[^1]:") + 5} Number_`].sort());
    expect(text(doc, { at: 2 }).filter((d) => d.includes("tessela-fn-raw"))).toEqual([]);
  });

  it("with the cursor in it, the reference shows as written, and the definition's label stays drawn", () => {
    const d = text(doc, { at: ref + 2 });
    expect(d.filter((x) => x.includes("tessela-fn-raw"))).toEqual([`${ref}-${ref + 4} .tessela-fn-raw`]);
    expect(widgets(d, "Number_")).toHaveLength(1);
  });

  it("with the cursor in the definition's label, only the label shows as written", () => {
    const label = doc.indexOf("[^1]:");
    expect(widgets(text(doc, { at: label + 1 }), "Number_")).toEqual([`${ref}-${ref + 4} Number_`]);
  });

  it("is drawn when the editor has no focus, and in select mode; nothing is drawn when the Markdown is not rendered", () => {
    expect(widgets(text(doc, { at: ref + 2, focused: false }), "Number_")).toHaveLength(2);
    expect(widgets(text(doc, { at: ref + 2, selecting: true }), "Number_")).toHaveLength(2);
    expect(widgets(text(doc, { at: 2, preview: false }), "Number_")).toHaveLength(0);
  });
});

describe("a callout's title is typed while the cursor is on its first line", () => {
  const doc = "> [!TIP]\n> Try this.\n\nEnd.\n";
  it("is drawn from anywhere else, in the callout too", () => {
    expect(widgets(text(doc, { at: doc.indexOf("Try") }), "Title")).toEqual(["2-8 Title"]);
    expect(widgets(text(doc, { at: doc.length }), "Title")).toEqual(["2-8 Title"]);
  });
  it("is the marker as written with the cursor on the first line; the callout is still a callout", () => {
    const d = text(doc, { at: 4 });
    expect(widgets(d, "Title")).toEqual([]);
    expect(d.filter((x) => x.includes("tessela-callout-tip"))).toHaveLength(2);
  });
  it("is only for a marker alone on its line, of the five kinds", () => {
    expect(widgets(text("> [!DANGER]\n> x\n"), "Title")).toEqual([]);
    expect(widgets(text("> [!NOTE] and text\n"), "Title")).toEqual([]);
    expect(widgets(text("```\n> [!NOTE]\n```\n"), "Title")).toEqual([]);
  });
});

describe("inline math", () => {
  const doc = "Cost $5 and $6, then $a+b$ here.";
  it("is typeset, the price is not, and the formula under the cursor shows its TeX", () => {
    expect(widgets(text(doc, { at: 1 }), "Formula")).toEqual(["21-26 Formula"]);
    expect(widgets(text(doc, { at: 23 }), "Formula")).toEqual([]);
    expect(widgets(text("code `$x$` is not math", { at: 0 }), "Formula")).toEqual([]);
  });
});

describe("a $$ block opens as a whole when the cursor enters it", () => {
  const doc = "Before.\n\n$$\n\\frac{1}{2}\n\nx\n$$\n\nAfter.\n";
  const from = doc.indexOf("$$");
  const to = doc.indexOf("$$\n\nAfter") + 2;

  it("takes the place of its source, blank line inside and all, while the cursor is elsewhere", () => {
    expect(math(doc, { at: 2 })).toEqual([`${from}-${to} Formula`]);
  });

  it("is the source, typeset under it, from its first character to its last", () => {
    for (let at = from; at <= to; at++) expect(math(doc, { at })).toEqual([`${to}-${to} Formula`]);
  });

  it("is drawn in place without focus and in select mode; under its source when the Markdown is not rendered", () => {
    expect(math(doc, { at: from + 4, focused: false })).toEqual([`${from}-${to} Formula`]);
    expect(math(doc, { at: from + 4, selecting: true })).toEqual([`${from}-${to} Formula`]);
    expect(math(doc, { at: 2, preview: false })).toEqual([`${to}-${to} Formula`]);
  });

  it("wears the selected class when select mode has it selected, and not otherwise", () => {
    const selected = (where = {}) => {
      const set = mathDecorations(revealState(doc, where), { ...reveal, isSelected: (state, r) => coversRange(state, r.from, r.to) });
      const spec = set.iter().value?.spec as { widget: { selected: boolean } } | undefined;
      return spec?.widget.selected;
    };
    expect(selected({ at: from + 4, selecting: true })).toBe(true);
    expect(selected({ at: from + 4, focused: false })).toBe(false);
  });

  it("is not drawn at all when it never closes", () => {
    expect(math("$$\nx^2\n\nmore text\n", { at: 0 })).toEqual([]);
  });

  it("in a list item stays under its source: there is no line of its own to replace", () => {
    const item = "- item\n  $$\n  x\n  $$\n";
    expect(math(item, { at: 0 })).toEqual([`${item.trimEnd().length}-${item.trimEnd().length} Formula`]);
  });
});
