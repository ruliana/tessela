// The pure parts of the surface mod: what the writer is thinking about, what to ask Jev about the
// notes that `tessela surface` offers, how the answers weigh against the cost of interrupting, and
// which single note, if any, is shown. The mod (main.ts) only wires these to the editor.

import type { JevAnswer, JevQuestion, JevRequest, JevResult } from "../../shared/jev";
import { headingCrumbs } from "../../shared/headingPath";
import type { PageModel, PageNode } from "../../shared/pageModel";

// ---- timing -----------------------------------------------------------------------------

/** Nothing is asked while keys are still coming: the loop waits this long after the last edit. */
export const IDLE_MS = 600;
/** After Enter or the end of a sentence the thought is complete, so the wait is short. */
export const BOUNDARY_MS = 150;
/** With no edit for this long the results go to the right column instead of the margin. */
export const PANEL_MS = 6000;

const SENTENCE_END = /[.!?…]["'”’)\]*_~`]*[ \t]$/;
const NEW_LINE = /\n[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?$/;

/** How long to wait after an edit, given the text just before the cursor: the end of a sentence, or Enter, is a pause of its own. */
export function settleMs(before: string): number {
  return NEW_LINE.test(before) || SENTENCE_END.test(before) ? BOUNDARY_MS : IDLE_MS;
}

// ---- typing -----------------------------------------------------------------------------

/** One edit: when, how many characters went in and how many came out. */
export interface Burst {
  at: number;
  added: number;
  removed: number;
}

/** How fast and how much of the recent typing was erasing. */
export interface Typing {
  /** Characters typed per second over the last few seconds. */
  speed: number;
  /** From 0 to 1: the share of what changed that was removed. */
  erasing: number;
}

export const TYPING_WINDOW_MS = 5000;
/** At this many characters a second (about 70 words a minute) the writer is as busy as it gets. */
export const FAST_CPS = 6;

/** The log with `burst` added and what is older than the window gone. */
export function recordEdit(log: readonly Burst[], burst: Burst): Burst[] {
  return [...log, burst].filter((b) => burst.at - b.at <= TYPING_WINDOW_MS);
}

export function typingOf(log: readonly Burst[], now: number): Typing {
  const recent = log.filter((b) => now - b.at <= TYPING_WINDOW_MS && now >= b.at);
  const added = recent.reduce((n, b) => n + b.added, 0);
  const removed = recent.reduce((n, b) => n + b.removed, 0);
  return { speed: added / (TYPING_WINDOW_MS / 1000), erasing: added + removed === 0 ? 0 : removed / (added + removed) };
}

/** From 0 (not typing) to 1 (typing flat out): how hard an interruption would land. */
export const pressure = (typing: Typing): number => Math.min(1, Math.max(0, typing.speed / FAST_CPS));

// ---- the thought ------------------------------------------------------------------------

/** What the writer is on: the block under the cursor, with what holds it. */
export interface Thought {
  /** The line the block starts on (1-based): what `tessela surface --at` takes. */
  line: number;
  /** Where the block starts. */
  from: number;
  /** Where its own text ends (what its children do not own): a cursor here is at the end of the paragraph. */
  end: number;
  /** The text as written, without list marker or quote marks. */
  text: string;
  /** The first lines of the items and quotes that hold it, outermost first. */
  parents: string[];
  /** The headings above it, outermost first. */
  headingPath: string[];
}

const TEXT_KINDS: ReadonlySet<string> = new Set(["paragraph", "item", "quote", "callout"]);
/** What the writer can be in without it being prose: nothing is surfaced for it. */
const NOT_PROSE: ReadonlySet<string> = new Set(["code", "table", "html", "math", "frontmatter", "footnote", "rule", "other"]);

/** Where the own text of a block is: from its start to where its first child starts (or where it ends), without trailing space. */
function ownRange(node: PageNode, model: PageModel): { from: number; end: number } {
  const stop = node.children[0]?.from ?? node.to;
  return { from: node.from, end: node.from + model.doc.sliceString(node.from, stop).trimEnd().length };
}

function ownText(node: PageNode, model: PageModel): string {
  const { from, end } = ownRange(node, model);
  const raw = model.doc.sliceString(from, end);
  const text = node.kind === "item" ? raw.replace(/^(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/, "") : raw;
  return node.kind === "quote" || node.kind === "callout" ? text.replace(/^[ \t]*>[ \t]?/gm, "") : text;
}

/** Where the nearest heading at or before `pos` starts (-1 when there is none). */
function lastHeadingStart(model: PageModel, pos: number): number {
  let start = -1;
  for (const n of model.nodes) if (n.kind === "section" && n.from <= pos) start = Math.max(start, n.from);
  return start;
}

/**
 * The thought at a position: the paragraph, item, quote or callout the cursor is in. Between blocks
 * (a new line after Enter, a blank line) it is the block just above, the one just finished, as long as
 * no heading comes between. In code, a table, a formula or the front matter there is none.
 */
export function thoughtAt(model: PageModel, pos: number): Thought | null {
  const at = model.nodeAt(pos);
  if (NOT_PROSE.has(at.kind)) return null;
  let node: PageNode | null = null;
  for (let n: PageNode | null = at; n?.parent; n = n.parent) {
    if (TEXT_KINDS.has(n.kind)) {
      node = n;
      break;
    }
  }
  if (node && ownText(node, model).trim() === "") node = null;
  if (!node) {
    const floor = lastHeadingStart(model, pos);
    for (let i = model.nodes.length - 1; i >= 0 && !node; i--) {
      const n = model.nodes[i]!;
      if (TEXT_KINDS.has(n.kind) && n.to <= pos && n.from > floor && ownText(n, model).trim() !== "") node = n;
    }
  }
  if (!node) return null;
  const parents: string[] = [];
  for (const a of node.ancestors()) if (TEXT_KINDS.has(a.kind)) parents.unshift(a.label);
  return {
    line: node.startLine,
    from: node.from,
    end: ownRange(node, model).end,
    text: ownText(node, model).trim(),
    parents,
    headingPath: headingCrumbs(model, node.from).map((c) => c.text),
  };
}

// ---- what `tessela surface` says --------------------------------------------------------

export type Source = "backlink" | "related" | "unlinked" | "words" | "agenda";

/** A note that may be worth showing, as `tessela surface` lists it (the fields the mod uses). */
export interface Candidate {
  source: Source;
  reason: string;
  score: number;
  kind: "block" | "heading" | "page";
  page: string;
  path: string;
  title: string;
  line: number;
  handle: string;
  heading_path: string[];
  excerpt: string;
  /** What to write to link to its page: `[Title](/path/to/page.md)`. */
  link: string;
  task: "open" | "done" | null;
}

export interface Surfaced {
  total: number;
  candidates: Candidate[];
}

/** The most notes Jev is asked about in one call: four questions each, so this bounds the request. */
export const MAX_ASKED = 12;

/** The candidates worth a question: the best of the list, each note once. */
export function toAsk(candidates: readonly Candidate[], max = MAX_ASKED): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of candidates) {
    if (seen.has(c.handle)) continue;
    seen.add(c.handle);
    out.push(c);
    if (out.length === max) break;
  }
  return out;
}

// ---- the questions ----------------------------------------------------------------------

/** What Jev learns from the writer's last seconds, for the question of what they are doing. */
export interface Writing {
  characters_added_per_second: number;
  share_of_changes_that_were_deletions: number;
}

export type Activity = "drafting" | "editing" | "reading" | "idle";
export const ACTIVITIES: readonly Activity[] = ["drafting", "editing", "reading", "idle"];

const LEVELS = ["Unrelated", "Loosely related", "About a close topic", "About the same thing"];

const noul = (instructions: string): JevQuestion => ({ type: "noul", instructions });

/** The four questions about note `n` (its place in `state.notes`). */
function noteQuestions(n: number): Record<string, JevQuestion> {
  const note = `Note ${n} of state.notes`;
  return {
    [`answers_${n}`]: noul(`Does ${note} answer a question that state.thought raises, or fill in something it leaves open?`),
    [`contradicts_${n}`]: noul(`Does ${note} say something that contradicts state.thought?`),
    [`written_${n}`]: {
      type: "choice",
      instructions: `How much of state.thought does ${note} already say?`,
      criteria: {
        same: "The note already says what the thought says.",
        overlaps: "The note says part of what the thought says.",
        different: "The note says something else.",
      },
    },
    [`topic_${n}`]: { type: "score", instructions: `How close is the topic of ${note} to state.thought?`, criteria: LEVELS },
  };
}

/** The two questions about the paragraph itself. */
const PARAGRAPH_QUESTIONS: Record<string, JevQuestion> = {
  holds: {
    type: "choice",
    instructions: "Does state.thought hold a task or a date?",
    criteria: {
      task: "It is something to do, a commitment or a to-do item.",
      date: "It names a date, a deadline or a time, and is not a task.",
      neither: "It is neither.",
    },
  },
  activity: {
    type: "choice",
    instructions: "What is the writer doing with state.thought, judging by the text and by state.writing?",
    criteria: {
      drafting: "Producing new text in a steady run.",
      editing: "Revising what is there, deleting and retyping.",
      reading: "Looking at the text more than changing it.",
      idle: "Not doing anything with it.",
    },
  },
};

/** One call for everything: the thought, how it is being written, and the notes, with the questions about each. */
export function requestFor(thought: Thought, writing: Writing, notes: readonly Candidate[], withParagraph: boolean): JevRequest {
  const questions: Record<string, JevQuestion> = withParagraph ? { ...PARAGRAPH_QUESTIONS } : {};
  notes.forEach((_, n) => Object.assign(questions, noteQuestions(n)));
  return {
    state: {
      thought: { text: thought.text, under: thought.parents, headings: thought.headingPath },
      writing,
      notes: notes.map((c) => ({ title: c.title, kind: c.kind, under: c.heading_path, text: c.excerpt, found_because: c.reason })),
    },
    questions,
  };
}

// ---- reading the answers ----------------------------------------------------------------

/** What Jev said about one note, each from 0 to 1. */
export interface Verdict {
  answers: number;
  contradicts: number;
  same: number;
  overlaps: number;
  /** How close the topic is, from 0 (unrelated) to 1 (the same thing). */
  topic: number;
}

/** What Jev said about the paragraph. */
export interface Paragraph {
  task: number;
  date: number;
  activity: Record<Activity, number>;
}

const unit = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

function noulOf(a: JevAnswer | undefined): number | null {
  return a?.type === "noul" ? unit(a.noul) : null;
}

function optionOf(a: JevAnswer | undefined, name: string): number | null {
  return a?.type === "choice" ? unit(a.probabilities[name] ?? 0) : null;
}

/** The verdict for note `n`, or null when an answer is missing or of another kind. */
export function verdictOf(answers: Record<string, JevAnswer>, n: number): Verdict | null {
  const topic = answers[`topic_${n}`];
  const parts = [noulOf(answers[`answers_${n}`]), noulOf(answers[`contradicts_${n}`]), optionOf(answers[`written_${n}`], "same"), optionOf(answers[`written_${n}`], "overlaps")];
  if (topic?.type !== "score" || parts.some((p) => p === null)) return null;
  const [a, c, s, o] = parts as number[];
  return { answers: a!, contradicts: c!, same: s!, overlaps: o!, topic: unit(topic.score / (LEVELS.length - 1)) };
}

export function paragraphOf(answers: Record<string, JevAnswer>): Paragraph | null {
  const task = optionOf(answers.holds, "task");
  const date = optionOf(answers.holds, "date");
  const activity = ACTIVITIES.map((a) => optionOf(answers.activity, a));
  if (task === null || date === null || activity.some((a) => a === null)) return null;
  return { task, date, activity: Object.fromEntries(ACTIVITIES.map((a, i) => [a, activity[i]!])) as Record<Activity, number> };
}

/** Assumed when Jev has not said: the writer is drafting, and the paragraph holds nothing. */
export const NO_PARAGRAPH: Paragraph = { task: 0, date: 0, activity: { drafting: 1, editing: 0, reading: 0, idle: 0 } };

// ---- what a note is worth ---------------------------------------------------------------

export type Why = "contradicts" | "answers" | "same" | "overlaps" | "topic" | "date";

/** What each reason is worth when it is certain, from 0 to 1: a contradiction is worth more than a neighbour. */
export const VALUE: Record<Why, number> = { contradicts: 1, answers: 0.9, same: 0.8, date: 0.7, overlaps: 0.5, topic: 0.25 };

export const WHY_LABEL: Record<Why, string> = {
  contradicts: "Says otherwise",
  answers: "Answers this",
  same: "Already written",
  overlaps: "Overlaps with this",
  topic: "Same topic",
  date: "Near this date",
};

/** A note with its worth: the probability that it is useful, times what it is worth when it is. */
export interface Card {
  candidate: Candidate;
  worth: number;
  why: Why;
}

/** The most a note is worth, and for which reason. Only what lies on the topic counts, except a date, which is the paragraph's. */
export function worthOf(candidate: Candidate, verdict: Verdict, paragraph: Paragraph): Card {
  const options: [Why, number][] = [
    ["contradicts", verdict.contradicts * verdict.topic],
    ["answers", verdict.answers * verdict.topic],
    ["same", verdict.same * verdict.topic],
    ["overlaps", verdict.overlaps * verdict.topic],
    ["topic", verdict.topic],
  ];
  if (candidate.source === "agenda") options.push(["date", Math.max(paragraph.task, paragraph.date)]);
  let best: Card = { candidate, worth: 0, why: "topic" };
  for (const [why, p] of options) {
    const worth = unit(p) * VALUE[why];
    if (worth > best.worth) best = { candidate, worth, why };
  }
  return best;
}

/** The cards for the notes Jev judged, best first. Notes it said nothing usable about are left out. */
export function cardsOf(candidates: readonly Candidate[], verdicts: readonly (Verdict | null)[], paragraph: Paragraph): Card[] {
  return candidates
    .flatMap((c, n) => {
      const v = verdicts[n];
      return v ? [worthOf(c, v, paragraph)] : [];
    })
    .sort((a, b) => b.worth - a.worth);
}

// ---- the cost of interrupting -----------------------------------------------------------

export const BASE_COST = 0.3;
/** Typing flat out adds this much to the cost. */
export const BUSY_COST = 0.4;

/**
 * What an interruption costs now: more the faster the writer types, half as much at the end of a
 * paragraph, more while drafting and less while reading or idle.
 */
export function costOf(typing: Typing, paragraphEnd: boolean, activity: Paragraph["activity"]): number {
  const busy = BASE_COST + BUSY_COST * pressure(typing);
  const mood = 1 + 0.3 * activity.drafting + 0.15 * activity.editing - 0.3 * (activity.reading + activity.idle);
  return busy * (paragraphEnd ? 0.5 : 1) * mood;
}

// ---- what to show -----------------------------------------------------------------------

/** A card stays until its worth falls below this share of the cost it had to beat to come in. */
export const EXIT = 0.7;
/** A card whose note stops being offered loses this share of its worth each time, so a note that comes and goes does not flicker. */
export const MISSED = 0.6;

export interface Surfacing {
  /** Which paragraph the state is about: a number the mod changes when the cursor moves to another one. */
  paragraph: number;
  shown: Card | null;
  /** Whether this paragraph has had its card: at most one new card for each. */
  used: boolean;
  /** Handles the writer dismissed: never offered again. */
  dismissed: ReadonlySet<string>;
}

export const none = (): Surfacing => ({ paragraph: 0, shown: null, used: false, dismissed: new Set() });

export type Change = "show" | "keep" | "hide" | "none";

export interface Decision {
  state: Surfacing;
  change: Change;
}

/**
 * One round: given the cards of the latest answers, the cost now and the paragraph the writer is in,
 * what is shown next. A card comes in when its worth beats the cost, and goes only when it falls
 * well below it; a paragraph gets one new card; a dismissed note is never shown again.
 */
export function decide(state: Surfacing, cards: readonly Card[], cost: number, paragraph: number): Decision {
  let now = state;
  let change: Change = "none";
  if (paragraph !== state.paragraph) {
    now = { ...state, paragraph, shown: null, used: false };
    if (state.shown) change = "hide";
  }
  const live = cards.filter((c) => !now.dismissed.has(c.candidate.handle));
  if (now.shown) {
    const shown = now.shown;
    const again = live.find((c) => c.candidate.handle === shown.candidate.handle);
    const worth = again ? again.worth : shown.worth * MISSED;
    if (worth >= cost * EXIT) return { state: { ...now, shown: again ?? { ...shown, worth } }, change: "keep" };
    return { state: { ...now, shown: null }, change: "hide" };
  }
  if (!now.used) {
    const best = live[0];
    if (best && best.worth > cost) return { state: { ...now, shown: best, used: true }, change: "show" };
  }
  return { state: now, change };
}

/** The writer dismissed the card: it goes, and its note stays away. */
export function dismiss(state: Surfacing): Surfacing {
  if (!state.shown) return state;
  return { ...state, shown: null, dismissed: new Set([...state.dismissed, state.shown.candidate.handle]) };
}

/** What the right column lists when nobody is typing: the best few that are worth anything. */
export function panelCards(cards: readonly Card[], dismissed: ReadonlySet<string>, limit = 5, min = 0.15): Card[] {
  return cards.filter((c) => c.worth >= min && !dismissed.has(c.candidate.handle)).slice(0, limit);
}

// ---- runs, answers kept ------------------------------------------------------------------

export interface Run {
  /** Aborts when the run is cancelled or another one starts. */
  signal: AbortSignal;
  /** True once the run is cancelled, replaced, or the text has moved on from `version`. */
  stale(version: number): boolean;
}

/** One run at a time: a new one, and a key typed, cancel the one before. */
export class Runs {
  #current: AbortController | null = null;

  start(version: number): Run {
    this.cancel();
    const controller = new AbortController();
    this.#current = controller;
    return { signal: controller.signal, stale: (v) => controller.signal.aborted || v !== version };
  }

  cancel(): void {
    this.#current?.abort();
    this.#current = null;
  }
}

/** A small memory that forgets the least recently used entry. */
export class Memory<T> {
  readonly #entries = new Map<string, T>();
  constructor(private readonly limit = 400) {}

  get(key: string): T | undefined {
    const value = this.#entries.get(key);
    if (value !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: T): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    if (this.#entries.size > this.limit) this.#entries.delete(this.#entries.keys().next().value as string);
  }

  get size(): number {
    return this.#entries.size;
  }
}

/** A short hash of a text (cyrb53), to key answers by what the thought says. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/** What Jev's answers depend on: the thought with what holds it, so that the same words under another heading ask again. */
export const thoughtKey = (t: Thought): string => hashText(JSON.stringify([t.text, t.parents, t.headingPath]));

/** What was judged: the notes of a thought, by handle, and the paragraph. */
export interface Judged {
  verdicts: (Verdict | null)[];
  paragraph: Paragraph;
}

export interface Memories {
  verdicts: Memory<Verdict | null>;
  paragraphs: Memory<Paragraph | null>;
}

export const memories = (): Memories => ({ verdicts: new Memory(600), paragraphs: new Memory(100) });

/**
 * Asks Jev what it has not been asked yet about this thought (answers are kept by the thought's text
 * and the note's handle) and returns the judgment, or null when the call fails or was cancelled.
 * Nothing is asked when everything is known.
 */
export async function judge(
  thought: Thought,
  writing: Writing,
  notes: readonly Candidate[],
  memory: Memories,
  ask: (request: JevRequest) => Promise<JevResult>,
): Promise<Judged | null> {
  const key = thoughtKey(thought);
  const known = notes.map((c) => memory.verdicts.get(`${key}|${c.handle}`));
  const missing = notes.filter((_, n) => known[n] === undefined);
  const knownParagraph = memory.paragraphs.get(key);
  if (missing.length > 0 || knownParagraph === undefined) {
    const result = await ask(requestFor(thought, writing, missing, knownParagraph === undefined));
    if (!result.ok) return null;
    missing.forEach((c, n) => memory.verdicts.set(`${key}|${c.handle}`, verdictOf(result.answers, n)));
    if (knownParagraph === undefined) memory.paragraphs.set(key, paragraphOf(result.answers));
  }
  return {
    verdicts: notes.map((c) => memory.verdicts.get(`${key}|${c.handle}`) ?? null),
    paragraph: memory.paragraphs.get(key) ?? NO_PARAGRAPH,
  };
}
