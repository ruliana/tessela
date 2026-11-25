// Settings and generators for the property tests (`props.*.test.ts`).
//
// Pull requests run a bounded pass with a fixed seed, so a red check is the same every time.
// The scheduled fuzz job sets TESSELA_FUZZ_CASES and TESSELA_FUZZ_SEED to look further; a
// failure prints the seed and the counterexample, and the same two variables replay it.

import fc from "fast-check";

const DEFAULT_SEED = 0x7e55e1a;

function number(name: string): number | undefined {
  const n = Number(process.env[name]);
  return process.env[name] && Number.isFinite(n) ? n : undefined;
}

/** `fc.assert` parameters: `cases` runs unless TESSELA_FUZZ_CASES says otherwise. */
export function runs(cases: number): fc.Parameters<unknown> {
  return { numRuns: number("TESSELA_FUZZ_CASES") ?? cases, seed: number("TESSELA_FUZZ_SEED") ?? DEFAULT_SEED };
}

/** Pieces of Markdown that matter to the editor: tags, links, list markers, headings, fences, odd characters. */
const PIECES = [
  "#x", "#a/b", "#Tag", "#x.", "a#x", "[t](/x.md)", "[t](./y.md)", "[t](../z.md#h)", "[t](https://e.org)", "![i](p.png)",
  "[ ]", "[x]", "- ", "* ", "+ ", "1. ", "2) ", "  ", "    ", "\t", "> ", "# ", "## ", "###### ", "####### ",
  "```", "~~~", "---", "***", "| a | b |", "|---|---|", "<b>", "<!--", "-->", "`code`", "**b**", "*i*", "~~s~~",
  "2026-10-27", "2026-13-45", "2026-10-27 14:30:00-03:00", "https://e.org/a/2026-10-27/b", "é", "日本語", "😀", "́",
  "word", "two words", "x", "y", "-", "_", "*", "`", "\\", "[", "]", "(", ")",
];

export const piece = fc.constantFrom(...PIECES);

/** One line of notes: pieces glued together, now and then anything at all. */
export const line: fc.Arbitrary<string> = fc
  .array(fc.oneof({ weight: 9, arbitrary: piece }, { weight: 1, arbitrary: fc.string({ maxLength: 6 }) }), { maxLength: 6 })
  .map((parts) => parts.join("").replace(/[\r\n]/g, ""));

/** A page as lines, sometimes with front matter on top, often list-shaped. */
export const lines: fc.Arbitrary<string[]> = fc
  .tuple(
    fc.boolean(),
    fc.array(
      fc.oneof(
        { weight: 3, arbitrary: line },
        { weight: 3, arbitrary: fc.tuple(fc.constantFrom("", "  ", "    "), fc.constantFrom("- ", "* ", "1. "), line).map((t) => t.join("")) },
        { weight: 1, arbitrary: fc.constant("") },
      ),
      { maxLength: 14 },
    ),
  )
  .map(([front, body]) => (front ? ["---", "type: concept", "---", ...body] : body.length > 0 ? body : [""]));

/** A cursor or selection somewhere in `doc`. */
export function selection(doc: string[]): fc.Arbitrary<{ anchor: { line: number; col: number }; head: { line: number; col: number } }> {
  const last = Math.max(0, doc.length - 1);
  const pos = fc.integer({ min: 0, max: last }).chain((l) => fc.integer({ min: 0, max: (doc[l] ?? "").length }).map((col) => ({ line: l, col })));
  return fc.tuple(pos, fc.boolean(), pos).map(([anchor, collapsed, head]) => ({ anchor, head: collapsed ? anchor : head }));
}

/** A page together with a selection in it. */
export const pageAndSelection = lines.chain((doc) => selection(doc).map((sel) => ({ doc, sel })));

const WORDS = fc.constantFrom("alpha", "beta #x", "gamma [t](/x.md)", "delta", "epsilon 2026-10-27", "zeta `code`");

/**
 * A well-formed outline: paragraphs and headings with the lists they own, items nested
 * one level at a time, blank lines between blocks. Edits on such pages must be undoable.
 */
export const outline: fc.Arbitrary<string[]> = fc
  .array(
    fc.oneof(
      { weight: 2, arbitrary: WORDS.map((w) => [w]) },
      { weight: 1, arbitrary: WORDS.map((w) => [`# ${w}`]) },
      {
        weight: 3,
        arbitrary: fc.tuple(WORDS, fc.array(fc.tuple(fc.constantFrom(0, 1, 2), WORDS), { maxLength: 4 })).map(([head, items]) => {
          const out: string[] = [head];
          let depth = 0;
          for (const [i, [d, text]] of items.entries()) {
            depth = i === 0 ? 0 : Math.min(d, depth + 1);
            out.push(`${"  ".repeat(depth)}- ${text}`);
          }
          return out;
        }),
      },
    ),
    { minLength: 1, maxLength: 5 },
  )
  .map((blocks) => blocks.flatMap((b, i) => (i === 0 ? b : ["", ...b])));

/** An outline and a cursor on one of its lines that has text (Tab on an empty line starts a list, by design). */
export const outlineAndCursor = outline.chain((doc) =>
  fc
    .integer({ min: 0, max: doc.length - 1 })
    .map((n) => doc.flatMap((l, i) => (l.trim() ? [i] : []))[n % doc.filter((l) => l.trim()).length]!)
    .chain((l) => fc.integer({ min: 0, max: doc[l]!.length }).map((col) => ({ doc, sel: { anchor: { line: l, col }, head: { line: l, col } } }))),
);
