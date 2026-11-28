// Where the sentence under the cursor starts and ends, for the sentence level of focus mode.
// It reads the own text of one block (the lines of a paragraph or list item, joined with
// newlines), not the page: what is a block is the page model's to say.

/** Words that end in a period without ending the sentence. */
const ABBREVIATIONS = new Set(["dr", "mr", "mrs", "ms", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e", "cf", "fig", "approx"]);

const TERMINATORS = /[.!?…]/;
const CLOSERS = /["'”’)\]*_~`]/;

/** The offsets just after each sentence end: a run of `.!?…`, closing marks, then a space or the end of the text. */
function sentenceEnds(text: string): number[] {
  const ends: number[] = [];
  let i = 0;
  while (i < text.length) {
    if (!TERMINATORS.test(text[i] as string)) {
      i++;
      continue;
    }
    const first = i;
    while (i < text.length && TERMINATORS.test(text[i] as string)) i++;
    const dotsOnly = text.slice(first, i) === ".";
    while (i < text.length && CLOSERS.test(text[i] as string)) i++;
    if (i < text.length && !/\s/.test(text[i] as string)) continue; // 3.14, a.b/c, "e.g.,": inside a word
    if (dotsOnly) {
      const word = /([\p{L}.]+)$/u.exec(text.slice(0, first))?.[1]?.toLowerCase();
      if (word !== undefined && ABBREVIATIONS.has(word)) continue;
      // A period followed by a lowercase letter ("e.g. the") does not end a sentence either.
      const next = /^\s*(\S)/.exec(text.slice(i))?.[1];
      if (next !== undefined && next !== next.toUpperCase()) continue;
    }
    ends.push(i);
  }
  return ends;
}

/**
 * The sentence the cursor is in: `from <= offset <= to`, both inside the text. A cursor right after
 * the end mark is still in that sentence; after the space that follows, it is in the next one, which
 * is empty until something is typed (`from === to === offset`).
 */
export function sentenceAt(text: string, offset: number): { from: number; to: number } {
  const at = Math.max(0, Math.min(offset, text.length));
  const ends = sentenceEnds(text);
  const last = text.trimEnd().length;
  if (last > (ends[ends.length - 1] ?? 0)) ends.push(last);
  let start = 0;
  for (const end of ends) {
    while (start < end && /\s/.test(text[start] as string)) start++;
    if (at <= end) return { from: Math.min(start, at), to: end };
    start = end;
  }
  return { from: at, to: at };
}
