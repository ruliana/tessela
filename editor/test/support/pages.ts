// Generators of whole pages, shaped like notes: front matter, headings, paragraphs, nested lists
// with fences, quotes and callouts in their items, tables, HTML, rules. They are for the tests
// that check the page model (`pageModel*.test.ts`), and they write only what the index and the
// model are meant to read the same way: constructs the index does not know (math, footnotes) are in
// `withExtras`.

import fc from "fast-check";

const word = fc.constantFrom("alpha", "beta", "gamma", "delta #tag", "[link](/x.md)", "**bold**", "`code`", "x", "same");
const text = fc.array(word, { minLength: 1, maxLength: 4 }).map((w) => w.join(" "));

const lines = (min: number, max: number, make: fc.Arbitrary<string> = text) => fc.array(make, { minLength: min, maxLength: max });

const heading = fc.tuple(fc.integer({ min: 1, max: 4 }), text).map(([level, t]) => ["#".repeat(level) + " " + t]);
const paragraph = lines(1, 3).map((ls) => ls);
const fenceBody = fc.constantFrom("code", "", "# not a heading", "- not an item", "> not a quote", "   ", "```x");
const fence = fc
  .tuple(fc.constantFrom("```", "~~~"), fc.constantFrom("", "js", "tessela"), lines(0, 3, fenceBody))
  .map(([mark, info, body]) => [mark + info, ...body.filter((l) => !(mark === "```" && l.startsWith("```"))), mark]);
const quote = lines(1, 3).map((ls) => ls.map((l) => "> " + l));
const callout = fc
  .tuple(fc.constantFrom("NOTE", "TIP", "WARNING", "note"), lines(1, 2))
  .map(([kind, ls]) => [`> [!${kind}]`, ...ls.map((l) => "> " + l)]);
const table = fc.constantFrom(["| a | b |", "| --- | --- |", "| 1 | 2 |"], ["| a |", "|---|", "| x |", "| y |"]);
const html = fc.constantFrom(["<div>", "x", "</div>"], ["<!-- note -->"], ["<details>", "", "text", "", "</details>"]);
const rule = fc.constantFrom(["---"], ["***"], ["___"]);

/** The lines of a nested list, indented by `indent`: items with continuation lines, tasks, and children. */
function list(indent: number, depth: number): fc.Arbitrary<string[]> {
  const item = fc
    .record({
      marker: fc.constantFrom("- ", "* ", "+ ", "1. ", "1) "),
      task: fc.constantFrom("", "", "", "[ ] ", "[x] ", "[X] "),
      text,
      cont: fc.boolean(),
      parts: fc.array(fc.nat({ max: 5 }), { maxLength: 3 }),
      seeds: fc.array(fc.nat(), { minLength: 3, maxLength: 3 }),
    })
    .chain(({ marker, task, text: t, cont, parts, seeds }) => {
      const pad = " ".repeat(indent + marker.length);
      const own = [" ".repeat(indent) + marker + task + t, ...(cont ? [pad + "more"] : [])];
      // What may follow the text of an item: a nested list, a fence, a quote, a callout, a paragraph after a blank line.
      const part = (kind: number, seed: number): fc.Arbitrary<string[]> => {
        switch (kind) {
          case 0:
          case 1:
            return depth < 2 ? list(indent + marker.length, depth + 1) : fc.constant([]);
          case 2:
            return fence.map((f) => f.map((l) => pad + l));
          case 3:
            return quote.map((q) => q.map((l) => pad + l));
          case 4:
            return callout.map((q) => q.map((l) => pad + l));
          default:
            return text.map((p) => ["", pad + p + (seed % 2 ? " end" : "")]);
        }
      };
      return fc.tuple(...parts.map((k, i) => part(k, seeds[i]!))).map((chunks) => [...own, ...chunks.flat()]);
    });
  return fc.array(item, { minLength: 1, maxLength: 3 }).map((items) => items.flat());
}

const topList = list(0, 0);

/** Top-level pieces other than lists, with what to put after them. */
const block = fc.oneof(
  { weight: 3, arbitrary: heading },
  { weight: 3, arbitrary: paragraph },
  { weight: 2, arbitrary: fence },
  { weight: 1, arbitrary: quote },
  { weight: 1, arbitrary: callout },
  { weight: 1, arbitrary: table },
  { weight: 1, arbitrary: html },
  { weight: 1, arbitrary: rule },
);

const math = fc.constantFrom(["$$", "x^2", "", "y", "$$"], ["$$x$$"], ["$$", "a", "$$"]);
const footnote = fc.constantFrom(["[^1]: note"], ["[^1]: note", "    continued"], ["[^2]: note", "", "    second paragraph"]);
/** Constructs the index does not read: math blocks and footnote definitions. */
const extra = fc.oneof(math, footnote);

function pageOf(piece: fc.Arbitrary<readonly string[]>): fc.Arbitrary<string> {
  const chunk = fc.oneof({ weight: 3, arbitrary: block }, { weight: 3, arbitrary: topList }, { weight: 1, arbitrary: piece });
  return fc
    .tuple(
      fc.boolean(),
      fc.array(fc.tuple(chunk, fc.boolean()), { minLength: 1, maxLength: 7 }),
    )
    .map(([front, chunks]) => {
      const out: string[] = front ? ["---", "type: concept", "---", ""] : [];
      let previous: readonly string[] | null = null;
      for (const [lines, tight] of chunks) {
        // A list may start on the line right beneath a paragraph: then the paragraph owns it.
        const glue = previous && tight && lines.length > 0 && /^(?:[-*+] |\d+[.)] )/.test(lines[0]!);
        if (out.length > 0 && !glue) out.push("");
        out.push(...lines);
        previous = lines;
      }
      // A `---` on the first line opens front matter: the index then takes the page for malformed when nothing closes it.
      if (out[0] === "---" && !front) out[0] = "***";
      return out.join("\n") + "\n";
    });
}

/** A page the index and the model are meant to read the same way. */
export const page: fc.Arbitrary<string> = pageOf(fc.constant([]));

/** A page that may also hold math blocks and footnote definitions. */
export const pageWithExtras: fc.Arbitrary<string> = pageOf(extra);
