// Live preview and the reveal policy: only the exact construct under the cursor is shown as typed.
// The decorations are made from a state, so this runs without a window.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { blockWidgets, currentLines, inlineDecorations, readTable, runText } from "../src/renderer/livePreview";
import { syntaxTree } from "@codemirror/language";
import { type DecorationSet } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { describe as shown, previewOptions, revealState } from "./support/reveal";

const drawInline = (state: EditorState): DecorationSet => inlineDecorations(state, [{ from: 0, to: state.doc.length }], previewOptions);

/** The characters of the page that live preview hides. */
function hidden(state: EditorState): Set<number> {
  const out = new Set<number>();
  const cursor = drawInline(state).iter();
  for (; cursor.value; cursor.next()) {
    const spec = cursor.value.spec as { widget?: unknown; class?: string };
    if (spec.widget || spec.class) continue;
    for (let i = cursor.from; i < cursor.to; i++) out.add(i);
  }
  return out;
}

// ---- generated paragraphs --------------------------------------------------------

interface Piece {
  /** What is written. */
  text: string;
  /** Offsets, inside `text`, of the characters that are only Markdown marks. */
  marks: number[];
}

const letters = fc.stringMatching(/^[a-z]{1,6}$/);
const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);

const piece: fc.Arbitrary<Piece> = fc.oneof(
  letters.map((w) => ({ text: w, marks: [] })),
  letters.map((w) => ({ text: `**${w}**`, marks: [...range(0, 2), ...range(2 + w.length, 4 + w.length)] })),
  letters.map((w) => ({ text: `*${w}*`, marks: [0, 1 + w.length] })),
  letters.map((w) => ({ text: `~~${w}~~`, marks: [...range(0, 2), ...range(2 + w.length, 4 + w.length)] })),
  letters.map((w) => ({ text: `\`${w}\``, marks: [0, 1 + w.length] })),
  fc.tuple(letters, letters).map(([t, u]) => ({ text: `[${t}](${u})`, marks: [0, ...range(1 + t.length, 4 + t.length + u.length)] })),
);

/** A paragraph of pieces separated by spaces, and for each piece where it is and which characters are marks. */
const paragraph = fc.array(piece, { minLength: 1, maxLength: 6 }).map((pieces) => {
  let doc = "";
  const placed = pieces.map((p) => {
    if (doc !== "") doc += " ";
    const from = doc.length;
    doc += p.text;
    return { from, to: doc.length, marks: p.marks.map((m) => from + m), plain: p.marks.length === 0 };
  });
  return { doc, placed };
});

describe("inline Markdown is typed only where the cursor touches it", () => {
  it("hides the marks of every construct the selection does not touch, and no other character", () => {
    fc.assert(
      fc.property(paragraph, fc.nat(), fc.nat(), ({ doc, placed }, a, b) => {
        const [from, to] = [a % (doc.length + 1), b % (doc.length + 1)].sort((x, y) => x - y) as [number, number];
        const expected = new Set(placed.filter((p) => !(p.from <= to && p.to >= from)).flatMap((p) => p.marks));
        expect(hidden(revealState(doc, { at: from, to }))).toEqual(expected);
      }),
      { numRuns: 300 },
    );
  });

  it("hides every mark when the editor has no focus, in select mode, whatever the selection", () => {
    fc.assert(
      fc.property(paragraph, fc.nat(), ({ doc, placed }, a) => {
        const at = a % (doc.length + 1);
        const all = new Set(placed.flatMap((p) => p.marks));
        expect(hidden(revealState(doc, { at, focused: false }))).toEqual(all);
        expect(hidden(revealState(doc, { at, selecting: true }))).toEqual(all);
      }),
      { numRuns: 100 },
    );
  });

  it("with the cursor on plain text, the bold and the link in the same paragraph stay drawn", () => {
    const doc = "plain words with **bold** and [site](https://example.com) here";
    const hiddenAt = (at: number) => hidden(revealState(doc, { at }));
    const all = hiddenAt(0);
    expect([...all].length).toBe(2 + 2 + 1 + "](https://example.com)".length);
    expect(hiddenAt(doc.indexOf("words") + 2)).toEqual(all);
    expect(hiddenAt(doc.indexOf("here") + 1)).toEqual(all);
  });

  it("with the cursor in the bold span, only that span shows its marks", () => {
    const doc = "plain **bold** and [site](https://example.com) here";
    const bold = doc.indexOf("bold");
    const shownMarks = [...hidden(revealState(doc, { at: 0 }))].filter((i) => !hidden(revealState(doc, { at: bold + 2 })).has(i));
    expect(shownMarks).toEqual([6, 7, 12, 13]);
  });

  it("a cursor right after the closing mark is still in the construct, and one a space later is not", () => {
    const doc = "a **b** c";
    expect(hidden(revealState(doc, { at: 7 })).size).toBe(0);
    expect(hidden(revealState(doc, { at: 8 })).size).toBe(4);
  });

  it("a nested construct is typed with the one around it: the cursor in the link inside bold shows both", () => {
    const doc = "**see [site](u) now**";
    expect(hidden(revealState(doc, { at: doc.indexOf("site") })).size).toBe(0);
    expect(hidden(revealState(doc, { at: doc.length + 0, focused: false })).size).toBeGreaterThan(0);
  });
});

describe("block marks", () => {
  it("a heading shows its # only while the cursor is on it", () => {
    const doc = "# Title\n\ntext";
    expect([...hidden(revealState(doc, { at: 2 }))]).toEqual([]);
    expect([...hidden(revealState(doc, { at: doc.length }))]).toEqual([0, 1]);
  });

  it("each line of a quote has its bar, and the > shows on the line the cursor is on", () => {
    const doc = "> one\n> two\n\nafter";
    const marks = (at: number) => shown(drawInline(revealState(doc, { at }))).filter((d) => d.endsWith(" hide"));
    expect(marks(doc.indexOf("two"))).toEqual(["0-2 hide"]);
    expect(marks(doc.indexOf("one"))).toEqual(["6-8 hide"]);
    expect(marks(doc.length)).toEqual(["0-2 hide", "6-8 hide"]);
    const bars = shown(drawInline(revealState(doc, { at: doc.indexOf("two") }))).filter((d) => d.endsWith(".cm-lp-quote"));
    expect(bars).toEqual(["0-0 .cm-lp-quote", "6-6 .cm-lp-quote"]);
  });

  it("a bullet is a bullet until the cursor is at it; the text of the item stays drawn", () => {
    const doc = "- one **two**\n- three";
    const glyphs = (at: number) => shown(drawInline(revealState(doc, { at }))).filter((d) => d.includes("Glyph"));
    expect(glyphs(3)).toEqual(["0-1 Glyph", "14-15 Glyph"]);
    expect(glyphs(1)).toEqual(["14-15 Glyph"]);
    expect(hidden(revealState(doc, { at: 3 })).size).toBe(4);
  });

  it("a task keeps its box and its done style while its text is edited", () => {
    const doc = "- [x] done **thing**\n";
    const decos = (at: number) => shown(drawInline(revealState(doc, { at })));
    expect(decos(12).filter((d) => d.includes("Glyph") || d.includes("cm-lp-done")).length).toBe(3);
  });

  it("nothing is drawn in a fence, and the cursor does not change that", () => {
    const doc = "```\n**x**\n```";
    expect(shown(drawInline(revealState(doc, { at: 6 })))).toEqual([]);
  });
});

// ---- tables ------------------------------------------------------------------------

const table = "intro\n\n| a | b |\n| --- | :-: |\n| 1 | **x** |\n\nafter\n";

describe("a table opens as a whole when the cursor enters it", () => {
  const widgets = (state: EditorState) => shown(blockWidgets(state, previewOptions));
  const first = table.indexOf("| a");
  const last = table.indexOf("**x** |") + 7;

  it("is drawn with the cursor in the text around it", () => {
    expect(widgets(revealState(table, { at: 2 }))).toEqual([`${first}-${last} TableWidget`]);
    expect(widgets(revealState(table, { at: table.length - 2 }))).toEqual([`${first}-${last} TableWidget`]);
  });

  it("is text from its first character to its last, whatever cell the cursor is in", () => {
    for (let at = first; at <= last; at++) expect(widgets(revealState(table, { at }))).toEqual([]);
  });

  it("is drawn when the editor has no focus, and in select mode, even with the cursor in it", () => {
    expect(widgets(revealState(table, { at: first + 3, focused: false }))).toHaveLength(1);
    expect(widgets(revealState(table, { at: first + 3, selecting: true }))).toHaveLength(1);
  });
});

describe("a table is read from the syntax tree", () => {
  const read = (text: string) => {
    const state = revealState(text);
    let found: ReturnType<typeof readTable> = null;
    syntaxTree(state).iterate({
      enter: (n) => {
        if (n.name === "Table") found = readTable(state, n.node);
      },
    });
    return found as ReturnType<typeof readTable>;
  };
  const texts = (cells: Parameters<typeof runText>[0][]) => cells.map((c) => runText(c));

  it("has the header, the alignment of each column and the rows, with their cell formatting", () => {
    const t = read("| Name | Count | Note |\n| :--- | ---: | :---: |\n| alpha | 1 | **big** and `code` |\n| beta | 22 | [site](https://e.com/t) |\n");
    expect(texts(t!.head)).toEqual(["Name", "Count", "Note"]);
    expect(t!.aligns).toEqual(["left", "right", "center"]);
    expect(t!.rows.map((r) => texts(r.cells))).toEqual([["alpha", "1", "big and code"], ["beta", "22", "site"]]);
    expect(t!.rows.map((r) => r.line)).toEqual([2, 3]);
    expect(t!.rows[0]!.cells[2]).toEqual([{ tag: "strong", children: ["big"] }, " and ", { tag: "code", children: ["code"] }]);
    expect(t!.rows[1]!.cells[2]).toEqual([{ tag: "a", href: "https://e.com/t", children: ["site"] }]);
  });

  it("puts an empty cell in its column, with or without the outer pipes, and pads short rows", () => {
    const t = read("a | b | c\n--|:-:|--:\n1 |  | 3\n|x||z|\n4\n");
    expect(t!.rows.map((r) => texts(r.cells))).toEqual([["1", "", "3"], ["x", "", "z"], ["4", "", ""]]);
    expect(t!.aligns).toEqual([null, "center", "right"]);
  });

  it("reads an escaped pipe as a pipe, and *, _ and ~~ as the formatting they are", () => {
    const t = read("| a |\n| - |\n| x \\| y |\n| *i* _j_ ~~k~~ |\n");
    expect(texts(t!.rows[0]!.cells)).toEqual(["x | y"]);
    expect(t!.rows[1]!.cells[0]!.filter((r) => typeof r !== "string").map((r) => (r as { tag: string }).tag)).toEqual(["em", "em", "del"]);
  });

  it("agrees with the text that was written, cell by cell, for any table", () => {
    const cell = fc.stringMatching(/^[a-z][a-z ]{0,6}[a-z]$|^[a-z]$/);
    const table = fc
      .record({ cols: fc.integer({ min: 1, max: 4 }), rows: fc.integer({ min: 0, max: 4 }), lead: fc.boolean(), trail: fc.boolean() })
      .chain(({ cols, rows, lead, trail }) =>
        fc.record({
          head: fc.array(cell, { minLength: cols, maxLength: cols }),
          rows: fc.array(fc.array(cell, { minLength: cols, maxLength: cols }), { minLength: rows, maxLength: rows }),
          // A single column is a table only with both outer pipes.
          lead: fc.constant(lead || cols === 1),
          trail: fc.constant(trail || cols === 1),
        }),
      );
    fc.assert(
      fc.property(table, ({ head, rows, lead, trail }) => {
        const line = (cells: string[]) => (lead ? "| " : "") + cells.join(" | ") + (trail ? " |" : "");
        const t = read([line(head), line(head.map(() => "---")), ...rows.map(line)].join("\n") + "\n");
        expect(t && texts(t.head)).toEqual(head);
        expect(t?.rows.map((r) => texts(r.cells))).toEqual(rows);
      }),
      { numRuns: 200 },
    );
  });
});

// ---- front matter ------------------------------------------------------------------

describe("the front matter opens as a whole when the cursor enters it", () => {
  const doc = "---\ntype: concept\n---\n\nBody text.\n";
  const widgets = (at: number, where = {}) => shown(blockWidgets(revealState(doc, { at, ...where }), previewOptions));

  it("is drawn as properties while the cursor is in the body", () => {
    expect(widgets(doc.indexOf("Body"))).toHaveLength(1);
  });

  it("is text, YAML and fences, wherever the cursor is in it, and in the blank line that goes with it", () => {
    for (const at of [0, 5, doc.indexOf("---\n\n"), doc.indexOf("\n\nBody") + 1]) expect(widgets(at)).toEqual([]);
  });

  it("is drawn when the editor has no focus", () => {
    expect(widgets(5, { focused: false })).toHaveLength(1);
  });
});

// ---- focus mode ----------------------------------------------------------------------

describe("the current block of focus mode", () => {
  const lines = (text: string, line: number) => {
    const state = revealState(text, { at: text.split("\n").slice(0, line - 1).join("\n").length + (line > 1 ? 1 : 0) });
    return [...currentLines(state)].sort((a, b) => a - b);
  };

  it("is the own text of a list item, without the items nested in it", () => {
    expect(lines("- one\n  more\n  - nested\n- two\n", 1)).toEqual([1, 2]);
    expect(lines("- one\n  more\n  - nested\n- two\n", 3)).toEqual([3]);
  });

  it("is a paragraph without the list it owns, and a heading alone", () => {
    expect(lines("Intro\ntext\n- item\n\n# Head\n\nbody\n", 1)).toEqual([1, 2]);
    expect(lines("Intro\ntext\n- item\n\n# Head\n\nbody\n", 5)).toEqual([5]);
  });

  it("is one line of a fence, and nothing for a blank line", () => {
    expect(lines("```\na\nb\n```\n", 2)).toEqual([2]);
    expect(lines("a\n\nb\n", 2)).toEqual([2]);
  });
});
