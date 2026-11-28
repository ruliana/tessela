// Moving the cursor must not move the text (PR10). A mark that turns raw under the cursor does so in
// the place it was hidden in: the decoration of a mark is a hide or a raw mark over the same range, so
// nothing but the construct that is revealed changes, and a mark at the start of a line is raw in room
// that was already reserved for it (see `style.css` and `e2e/acceptance/reveal.mjs`, which measure it
// in a window). This is the model side of that: the decorations, from a state, without a window.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { inlineDecorations } from "../src/renderer/livePreview";
import type { DecorationSet } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { previewOptions, revealState } from "./support/reveal";

/** The parts of the page that stand in a mark's place, by range: how each is drawn. */
function slots(state: EditorState): Map<string, string> {
  const out = new Map<string, string>();
  const set: DecorationSet = inlineDecorations(state, [{ from: 0, to: state.doc.length }], previewOptions);
  for (const cursor = set.iter(); cursor.value; cursor.next()) {
    const spec = cursor.value.spec as { widget?: { cls?: string }; class?: string };
    const key = `${cursor.from}-${cursor.to}`;
    if (spec.widget) {
      if (/cm-lp-(bullet|check)/.test(spec.widget.cls ?? "")) out.set(key, `drawn ${spec.widget.cls}`);
    } else if (spec.class === undefined) {
      out.set(key, "hidden");
    } else if (spec.class.startsWith("cm-mk")) {
      out.set(key, `raw ${spec.class}`);
    }
  }
  return out;
}

/** The ranges of the inline code that is styled as code. */
function codeRanges(state: EditorState): string[] {
  const out: string[] = [];
  const set = inlineDecorations(state, [{ from: 0, to: state.doc.length }], previewOptions);
  for (const cursor = set.iter(); cursor.value; cursor.next()) {
    if ((cursor.value.spec as { class?: string }).class === "cm-lp-code") out.push(`${cursor.from}-${cursor.to}`);
  }
  return out;
}

const keys = (m: Map<string, string>) => [...m.keys()].sort().join(",");
const differing = (a: Map<string, string>, b: Map<string, string>) => [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k));
const within = (range: string, spans: { from: number; to: number }[]) => {
  const [from, to] = range.split("-").map(Number) as [number, number];
  return spans.some((s) => s.from <= from && to <= s.to);
};

// ---- inline constructs ----------------------------------------------------------

const letters = fc.stringMatching(/^[a-z]{1,6}$/);
const inline = fc.oneof(
  letters,
  letters.map((w) => `**${w}**`),
  letters.map((w) => `*${w}*`),
  letters.map((w) => `~~${w}~~`),
  letters.map((w) => `\`${w}\``),
  fc.tuple(letters, letters).map(([t, u]) => `[${t}](${u})`),
);

/** A paragraph of constructs separated by spaces, with where each one is. */
const paragraph = fc.array(inline, { minLength: 1, maxLength: 6 }).map((parts) => {
  let doc = "";
  const spans = parts.map((p) => {
    if (doc !== "") doc += " ";
    const from = doc.length;
    doc += p;
    return { from, to: doc.length };
  });
  return { doc, spans };
});

describe("a mark that turns raw stays where it was", () => {
  it("has the same marks, hidden or raw, wherever the cursor is", () => {
    fc.assert(
      fc.property(paragraph, fc.nat(), fc.nat(), ({ doc }, a, b) => {
        const [p, q] = [a % (doc.length + 1), b % (doc.length + 1)];
        expect(keys(slots(revealState(doc, { at: p })))).toBe(keys(slots(revealState(doc, { at: q }))));
      }),
      { numRuns: 300 },
    );
  });

  it("changes nothing outside the constructs the cursor leaves and the one it enters", () => {
    fc.assert(
      fc.property(paragraph, fc.nat(), fc.nat(), ({ doc, spans }, a, b) => {
        const [p, q] = [a % (doc.length + 1), b % (doc.length + 1)];
        const touched = spans.filter((s) => [p, q].some((r) => s.from <= r && r <= s.to));
        for (const range of differing(slots(revealState(doc, { at: p })), slots(revealState(doc, { at: q })))) {
          expect(within(range, touched), `${range} changed between ${p} and ${q} in ${doc}`).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("keeps inline code styled as code, with its padding, raw or not", () => {
    fc.assert(
      fc.property(paragraph, fc.nat(), fc.nat(), ({ doc }, a, b) => {
        const [p, q] = [a % (doc.length + 1), b % (doc.length + 1)];
        expect(codeRanges(revealState(doc, { at: p }))).toEqual(codeRanges(revealState(doc, { at: q })));
      }),
      { numRuns: 300 },
    );
  });
});

// ---- links -------------------------------------------------------------------------

describe("a link that turns raw", () => {
  const link = fc.tuple(letters, letters, letters).map(([before, text, target]) => ({ doc: `${before} [${text}](https://x.test/${target}) end`, open: before.length + 1, text: text.length, target: target.length }));

  it("hangs its bracket and holds its address out of the line, so the text after it stays put", () => {
    fc.assert(
      fc.property(link, ({ doc, open, text }) => {
        const state = revealState(doc, { at: open + 1 });
        const how = slots(state);
        expect(how.get(`${open}-${open + 1}`), doc).toMatch(/^raw cm-mk cm-mk-hang\b/);
        const close = open + 1 + text;
        const end = doc.indexOf(")") + 1;
        expect(how.get(`${close}-${end}`), doc).toMatch(/^raw cm-mk cm-mk-addr\b/);
        // Away from the link, the same ranges are hidden.
        const away = slots(revealState(doc, { at: doc.length }));
        expect(away.get(`${open}-${open + 1}`)).toBe("hidden");
        expect(away.get(`${close}-${end}`)).toBe("hidden");
      }),
      { numRuns: 100 },
    );
  });
});

// ---- marks at the start of a line ------------------------------------------------

interface Row {
  text: string;
  /** The range of the mark, inside the line. */
  mark: [number, number] | null;
}

const row: fc.Arbitrary<Row> = fc.oneof(
  letters.map((w) => ({ text: `# ${w}`, mark: [0, 2] as [number, number] })),
  letters.map((w) => ({ text: `### ${w}`, mark: [0, 4] as [number, number] })),
  letters.map((w) => ({ text: `> ${w}`, mark: [0, 2] as [number, number] })),
  letters.map((w) => ({ text: `- ${w}`, mark: [0, 1] as [number, number] })),
  letters.map((w) => ({ text: `- [ ] ${w}`, mark: [2, 5] as [number, number] })),
  letters.map((w) => ({ text: `- [x] ${w}`, mark: [2, 5] as [number, number] })),
  letters.map((w) => ({ text: w, mark: null })),
);

/** Lines apart from each other, with the line numbers and where each one starts. */
const page = fc.array(row, { minLength: 1, maxLength: 6 }).map((rows) => {
  let doc = "";
  const lines = rows.map((r) => {
    if (doc !== "") doc += "\n\n";
    const from = doc.length;
    doc += r.text;
    return { from, to: doc.length, mark: r.mark === null ? null : { from: from + r.mark[0], to: from + r.mark[1] } };
  });
  return { doc, lines };
});

describe("a mark at the start of a line", () => {
  it("is the same mark, hidden or raw, wherever the cursor is, and only the lines of the cursor change", () => {
    fc.assert(
      fc.property(page, fc.nat(), fc.nat(), ({ doc, lines }, a, b) => {
        const [p, q] = [a % (doc.length + 1), b % (doc.length + 1)];
        const [sp, sq] = [slots(revealState(doc, { at: p })), slots(revealState(doc, { at: q }))];
        expect(keys(sp)).toBe(keys(sq));
        const own = lines.filter((l) => [p, q].some((r) => l.from <= r && r <= l.to));
        for (const range of differing(sp, sq)) expect(within(range, own), `${range} changed between ${p} and ${q} in ${JSON.stringify(doc)}`).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("is raw in room that was reserved for it: it hangs in the margin or fills the slot of its glyph", () => {
    fc.assert(
      fc.property(page, ({ doc, lines }) => {
        for (const line of lines) {
          if (!line.mark) continue;
          const state = revealState(doc, { at: line.mark.from });
          const how = slots(state).get(`${line.mark.from}-${line.mark.to}`);
          expect(how, `${JSON.stringify(doc)} at ${line.mark.from}`).toMatch(/^raw cm-mk cm-mk-(hang|slot)\b/);
        }
      }),
      { numRuns: 100 },
    );
  });
});
