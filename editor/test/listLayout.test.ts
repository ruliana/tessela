// How a list item is laid out: a wrapped line hangs under the first letter after the marker, and a
// bullet that holds a picture is a figure. The decorations say what the CSS (`style.css`) is given;
// `e2e/acceptance/lists.mjs` measures the result in a window.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { inlineDecorations } from "../src/renderer/livePreview";
import type { EditorState } from "@codemirror/state";
import { previewOptions, revealState } from "./support/reveal";

interface Deco {
  from: number;
  to: number;
  cls?: string;
  style?: string;
  widget?: { constructor: { name: string }; alt?: string; src?: string };
}

const pictures = { ...previewOptions, imageUrl: (dest: string) => (dest.startsWith("/assets/") ? `file:${dest}` : null) };

function decorations(state: EditorState): Deco[] {
  const out: Deco[] = [];
  const set = inlineDecorations(state, [{ from: 0, to: state.doc.length }], pictures);
  for (const c = set.iter(); c.value; c.next()) {
    const spec = c.value.spec as { class?: string; widget?: Deco["widget"]; attributes?: { style?: string } };
    out.push({ from: c.from, to: c.to, cls: spec.class, style: spec.attributes?.style, widget: spec.widget });
  }
  return out;
}

const draw = (doc: string, at = doc.length) => decorations(revealState(doc, { at }));
const withClass = (ds: Deco[], cls: string) => ds.filter((d) => d.cls?.split(" ").includes(cls));
const lineStarts = (doc: string) => doc.split("\n").reduce<number[]>((acc, l) => [...acc, acc[acc.length - 1]! + l.length + 1], [0]);

// ---- a wrapped line hangs ---------------------------------------------------------

describe("an item line hangs under the first letter after its marker", () => {
  // A list of one kind, each item at most one level deeper than the one before it.
  const list = fc
    .tuple(fc.constantFrom("- ", "* ", "+ ", "- [ ] ", "- [x] ", "1. ", "12. "), fc.array(fc.tuple(fc.nat(2), fc.stringMatching(/^[a-z]{1,8}$/)), { minLength: 1, maxLength: 6 }))
    .map(([m, rows]) => {
      const unit = /^\d/.test(m) ? m.length : 2;
      let depth = 0;
      return rows.map(([step, word], n) => {
        depth = n === 0 ? 0 : Math.max(0, depth + step - 1);
        return { indent: " ".repeat(depth * unit), m, word };
      });
    });

  it("every item line has the hang, and the indent in front of its marker is a mark of its own", () => {
    fc.assert(
      fc.property(list, (items) => {
        const doc = items.map((i) => `${i.indent}${i.m}${i.word}`).join("\n");
        const ds = draw(doc, doc.length);
        const starts = lineStarts(doc);
        const lines = withClass(ds, "cm-lp-item");
        expect(lines.map((d) => d.from)).toEqual(starts.slice(0, items.length));
        items.forEach((i, n) => {
          expect(lines[n]!.style).toContain(`--ind:${i.indent.length}`);
          const lead = ds.filter((d) => d.cls === "cm-lp-indent" && d.from === starts[n]);
          expect(lead.map((d) => d.to - d.from)).toEqual(i.indent.length > 0 ? [i.indent.length] : []);
        });
      }),
      { numRuns: 100 },
    );
  });

  it("the space after the marker, and after a task box, is a fixed gap", () => {
    const gaps = (doc: string) => withClass(draw(doc), "cm-lp-gap").map((d) => `${d.from}-${d.to}`);
    expect(gaps("- one")).toEqual(["1-2"]);
    expect(gaps("- [ ] one")).toEqual(["1-2", "5-6"]);
    expect(gaps("1. one")).toEqual(["2-3"]);
  });

  it("is a line of its own kind for a bullet, a task and a numbered item, which differ in what comes first", () => {
    const kinds = (doc: string) => withClass(draw(doc), "cm-lp-item").map((d) => d.cls);
    expect(kinds("- a")).toEqual(["cm-lp-item cm-lp-item-bullet"]);
    expect(kinds("- [ ] a")).toEqual(["cm-lp-item cm-lp-item-task"]);
    expect(kinds("3. a")).toEqual(["cm-lp-item cm-lp-item-num"]);
  });

  it("is only for the line a marker is the first thing on: not a paragraph, not an item in a quote", () => {
    expect(withClass(draw("plain words\n\n- item\nlazy continuation"), "cm-lp-item").map((d) => d.from)).toEqual([13]);
    expect(withClass(draw("> - quoted\n> - items"), "cm-lp-item")).toEqual([]);
  });
});

// ---- a picture in a bullet is a figure --------------------------------------------

describe("a bullet that holds a picture is a figure", () => {
  const widgets = (ds: Deco[]) => ds.filter((d) => d.widget?.constructor.name === "ImageWidget");
  const bullets = (ds: Deco[]) => ds.filter((d) => d.widget?.constructor.name === "Glyph");

  it("has no bullet, and the line wears the figure class, wherever the cursor is", () => {
    for (const doc of ["- ![](/assets/a.png) after the picture", "- before the picture ![](/assets/a.png)", "  - ![](/assets/a.png)"]) {
      for (const at of [0, 4, doc.length]) {
        const ds = draw(doc, at);
        expect(bullets(ds), `${doc} at ${at}`).toEqual([]);
        expect(withClass(ds, "cm-lp-figure-line"), `${doc} at ${at}`).toHaveLength(1);
        expect(withClass(ds, "cm-lp-item"), `${doc} at ${at}`).toEqual([]);
      }
    }
  });

  it("the text before the picture is its alt text, and with none the text after it; the alt in the brackets comes first", () => {
    const alt = (doc: string) => widgets(draw(doc, 0))[0]?.widget?.alt;
    expect(alt("- Sticky mixing ![](/assets/a.png)")).toBe("Sticky mixing");
    expect(alt("- ![](/assets/a.png) Sticky mixing")).toBe("Sticky mixing");
    expect(alt("- before ![](/assets/a.png) after")).toBe("before");
    expect(alt("- before ![written](/assets/a.png) after")).toBe("written");
    expect(alt("- ![](/assets/a.png)")).toBe("");
  });

  it("the text around the picture is a caption: drawn small, with the blanks between it and the picture hidden", () => {
    const doc = "- before ![](/assets/a.png)  after";
    const ds = draw(doc);
    expect(withClass(ds, "cm-lp-caption").map((d) => doc.slice(d.from, d.to))).toEqual(["before", "after"]);
    const picture = widgets(ds)[0]!;
    const hidden = ds.filter((d) => !d.cls && !d.widget).map((d) => `${d.from}-${d.to}`);
    // The marker with its space and the blanks on both sides of the picture (the blank before it is a
    // single space, after it two).
    expect(hidden).toEqual(expect.arrayContaining(["0-2", `${picture.from - 1}-${picture.from}`, `${picture.to}-${picture.to + 2}`]));
  });

  it("opens as text when the cursor is in the picture, and keeps its caption and its place", () => {
    const doc = "- ![](/assets/a.png) after";
    const ds = draw(doc, 5);
    expect(widgets(ds)).toEqual([]);
    expect(withClass(ds, "cm-lp-figure-line")).toHaveLength(1);
    expect(withClass(ds, "cm-lp-caption").map((d) => doc.slice(d.from, d.to))).toEqual(["after"]);
  });

  it("shows its marker as typed, in the margin, only with the cursor at it", () => {
    const doc = "- ![](/assets/a.png) after";
    expect(withClass(draw(doc, 1), "cm-mk-hang")).toHaveLength(1);
    expect(withClass(draw(doc, 12), "cm-mk-hang")).toHaveLength(0);
  });

  it("is a bullet of a list only: a paragraph, a numbered item, a task and a picture that does not load stay as they were", () => {
    expect(widgets(draw("![](/assets/a.png) text"))).toHaveLength(1);
    expect(withClass(draw("![](/assets/a.png) text", 0), "cm-lp-figure-line")).toEqual([]);
    expect(withClass(draw("1. ![](/assets/a.png) text", 0), "cm-lp-figure-line")).toEqual([]);
    expect(withClass(draw("- [ ] ![](/assets/a.png) text", 0), "cm-lp-figure-line")).toEqual([]);
    const gone = draw("- ![](assets/gone.png) text");
    expect(withClass(gone, "cm-lp-figure-line")).toEqual([]);
    expect(bullets(gone)).toHaveLength(1);
  });

  it("is the picture on the marker's line: a picture on a later line of the item does not make the item one", () => {
    expect(withClass(draw("- first line\n  ![](/assets/a.png)", 0), "cm-lp-figure-line")).toEqual([]);
  });
});
