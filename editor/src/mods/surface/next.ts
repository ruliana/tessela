// Read next: the pure parts. At the end of a page, which notes to go on to: what `tessela surface
// --whole` offers for the page, what Jev says about each (is it the natural next read, does this page
// already say it), and the two or three that are worth showing under the page. The wiring is in
// readnext.ts; nothing here touches the editor.

import type { Text } from "@codemirror/state";

import type { JevAnswer, JevQuestion, JevRequest, JevResult } from "../../shared/jev";
import { type Candidate, Memory, hashText } from "./plan";

// ---- when ---------------------------------------------------------------------------------

/** A page with fewer words than this has nothing to be followed. */
export const MIN_WORDS = 40;
/** After the view arrives at the end of the page, how long before asking: scrolling past it asks nothing. */
export const ARRIVE_MS = 700;
/** After an edit at the end of the page: the writer is still writing, so this is a real pause. */
export const EDIT_MS = 4000;

export const delayFor = (edited: boolean): number => (edited ? EDIT_MS : ARRIVE_MS);

/** Where the text of the page ends: after its last character that is not white space. */
export function lastContent(doc: Text): number {
  for (let n = doc.lines; n >= 1; n--) {
    const line = doc.line(n);
    const text = line.text.trimEnd();
    if (text !== "") return line.from + text.length;
  }
  return 0;
}

export const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/** The page is at its end for the reader when the cursor is in its last line or the last line is on screen. */
export function reachedEnd(head: number, last: number, lastOnScreen: boolean): boolean {
  return lastOnScreen || head >= last;
}

// ---- what Jev reads of the page -----------------------------------------------------------

/** What is passed on of the page: all of a short one, the start and the end of a long one. */
export const MAX_CHARS = 6000;
const HEAD_CHARS = 2400;

export function excerptOf(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  return `${text.slice(0, HEAD_CHARS)}\n…\n${text.slice(text.length - (MAX_CHARS - HEAD_CHARS))}`;
}

/** The page as Jev is told of it. */
export interface Reading {
  title: string;
  headings: string[];
  text: string;
}

// ---- the notes ----------------------------------------------------------------------------

/** The most notes Jev is asked about: two questions each. */
export const MAX_NOTES = 10;

/** One note for each page other than this one, in the order `tessela surface` gave them. */
export function notesToAsk(candidates: readonly Candidate[], path: string, max = MAX_NOTES): Candidate[] {
  const seen = new Set<string>([path]);
  const out: Candidate[] = [];
  for (const c of candidates) {
    if (seen.has(c.path)) continue;
    seen.add(c.path);
    out.push(c);
    if (out.length === max) break;
  }
  return out;
}

// ---- the questions ------------------------------------------------------------------------

const LEVELS = ["Not worth reading next", "Related, but not what comes next", "A good note to read next", "The natural note to read next"];

const noul = (instructions: string): JevQuestion => ({ type: "noul", instructions });

/** The two questions about note `n`: is it what to read after this page, and would it say nothing new. */
function noteQuestions(n: number): Record<string, JevQuestion> {
  const note = `Note ${n} of state.notes`;
  return {
    [`next_${n}`]: {
      type: "score",
      instructions: `The reader has just finished state.page. Is ${note} the natural next thing for them to read?`,
      criteria: LEVELS,
    },
    [`covered_${n}`]: noul(`Does state.page already say everything that ${note} says, so that reading it would add nothing?`),
  };
}

export function requestFor(page: Reading, notes: readonly Candidate[]): JevRequest {
  const questions: Record<string, JevQuestion> = {};
  notes.forEach((_, n) => Object.assign(questions, noteQuestions(n)));
  return {
    state: {
      page: { title: page.title, headings: page.headings, text: excerptOf(page.text) },
      notes: notes.map((c) => ({ title: c.title, kind: c.kind, under: c.heading_path, text: c.excerpt, found_because: c.reason })),
    },
    questions,
  };
}

// ---- the answers --------------------------------------------------------------------------

/** What Jev said about one note, each from 0 to 1. */
export interface Next {
  /** How much it is the natural next read: 0 is "not worth it", 1 is "the natural one". */
  next: number;
  /** The probability that this page already says all of it. */
  covered: number;
}

const unit = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** The reading for note `n`, or null when an answer is missing or of another kind. */
export function nextOf(answers: Record<string, JevAnswer>, n: number): Next | null {
  const next = answers[`next_${n}`];
  const covered = answers[`covered_${n}`];
  if (next?.type !== "score" || covered?.type !== "noul") return null;
  return { next: unit(next.score / (LEVELS.length - 1)), covered: unit(covered.noul) };
}

/** What a note is worth as the next read: how natural it is, less the chance that it is nothing new. */
export const rankOf = (n: Next): number => n.next * (1 - n.covered);

/** A note worth showing under the page. */
export interface Pick {
  candidate: Candidate;
  rank: number;
}

/** Below this a note is not shown, however few there are: "a good note to read next" is two thirds. */
export const MIN_RANK = 0.55;
export const SHOWN = 3;

/** The best few, best first. Nothing when none is good enough: the page ends there. */
export function pickNext(notes: readonly Candidate[], readings: readonly (Next | null)[], limit = SHOWN, min = MIN_RANK): Pick[] {
  return notes
    .flatMap((candidate, n) => {
      const r = readings[n];
      return r ? [{ candidate, rank: rankOf(r) }] : [];
    })
    .filter((p) => p.rank >= min)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit);
}

// ---- asking -------------------------------------------------------------------------------

/** What was asked already: the reading of a note after a page, by what the page said and the note's handle. */
export const nextMemory = (): Memory<Next | null> => new Memory(400);

/** What the page says, for keeping answers: the same words under the same title and headings ask nothing again. */
export const readingKey = (page: Reading): string => hashText(JSON.stringify([page.title, page.headings, excerptOf(page.text)]));

/**
 * Asks Jev what it has not been asked about this page and these notes, and returns a reading for
 * each note (null where it said nothing usable), or null when the call fails. Nothing is asked when
 * everything is known.
 */
export async function readNext(
  page: Reading,
  notes: readonly Candidate[],
  memory: Memory<Next | null>,
  ask: (request: JevRequest) => Promise<JevResult>,
): Promise<(Next | null)[] | null> {
  const key = readingKey(page);
  const known = notes.map((c) => memory.get(`${key}|${c.handle}`));
  const missing = notes.filter((_, n) => known[n] === undefined);
  if (missing.length > 0) {
    const result = await ask(requestFor(page, missing));
    if (!result.ok) return null;
    missing.forEach((c, n) => memory.set(`${key}|${c.handle}`, nextOf(result.answers, n)));
  }
  return notes.map((c) => memory.get(`${key}|${c.handle}`) ?? null);
}
