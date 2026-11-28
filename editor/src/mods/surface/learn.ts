// What the surface mod learns from what the writer does with its cards. Each question that can raise a
// card (it contradicts, it answers, it is already written, it overlaps, it is on the topic, a date) has
// one threshold: a number that scales the bar a card of that question must clear. Opening or linking a
// note lowers it, dismissing a note raises it, and a card that goes away unnoticed raises it a little.
// The numbers are kept in the window's settings (like the folds), never in the notes.

import type { Card, Why } from "./plan";
import { VALUE } from "./plan";

/** What the writer did with a card. */
export type Outcome = "opened" | "linked" | "dismissed" | "ignored";
export const OUTCOMES: readonly Outcome[] = ["opened", "linked", "dismissed", "ignored"];

/** One number for each question: a card comes in when its worth beats the cost of interrupting times this. */
export type Thresholds = Record<Why, number>;

/** The lowest threshold (half the bar) and the highest (twice the bar). */
export const LOW = 0.5;
export const HIGH = 2;

/** Where each outcome sends the threshold of its question. */
export const TARGET: Record<Outcome, number> = { opened: LOW, linked: LOW, dismissed: HIGH, ignored: HIGH };

/** How far one outcome moves it towards that end: a link or a dismissal is a decision, an ignored card is hardly one. */
export const RATE: Record<Outcome, number> = { opened: 0.15, linked: 0.25, dismissed: 0.25, ignored: 0.03 };

const WHYS = Object.keys(VALUE) as Why[];

const within = (n: number): number => Math.min(HIGH, Math.max(LOW, n));

/** Every question starts at 1: the bar the plan sets. */
export const fresh = (): Thresholds => Object.fromEntries(WHYS.map((w) => [w, 1])) as Thresholds;

/**
 * The thresholds after `outcome` for a card raised by `why`: a step towards that outcome's end, so they
 * stay between the bounds, move only the way the outcome points, and settle where the writer's habits do.
 */
export function learn(t: Thresholds, why: Why, outcome: Outcome): Thresholds {
  const now = t[why];
  return { ...t, [why]: within(now + RATE[outcome] * (TARGET[outcome] - now)) };
}

/** The thresholds as the settings hold them; anything missing or gone wrong starts again at 1. */
export function thresholdsFrom(saved: unknown): Thresholds {
  const out = fresh();
  if (!saved || typeof saved !== "object") return out;
  for (const w of WHYS) {
    const n = (saved as Record<string, unknown>)[w];
    if (typeof n === "number" && Number.isFinite(n)) out[w] = within(n);
  }
  return out;
}

/** The cards with the bar each must clear folded into its worth (worth over threshold), best first. */
export function adjust(cards: readonly Card[], t: Thresholds): Card[] {
  return cards.map((c) => ({ ...c, worth: c.worth / t[c.why] })).sort((a, b) => b.worth - a.worth);
}

/**
 * Which cards have been on show and what became of each, so that every card teaches once: acted on, it
 * counts for what the writer did; gone unnoticed, it counts as ignored, and a later open or link from the
 * right column still counts. A card is told apart by its paragraph and its note.
 */
export class Ledger {
  readonly #state = new Map<string, "raised" | "ignored" | "done">();

  #key = (card: Card, paragraph: number): string => `${paragraph}|${card.candidate.handle}`;

  /** A card went on show. */
  raise(card: Card, paragraph: number): void {
    const key = this.#key(card, paragraph);
    this.#state.delete(key);
    this.#state.set(key, "raised");
    if (this.#state.size > 200) this.#state.delete(this.#state.keys().next().value as string);
  }

  /** The outcome to learn from, or null when this card has already taught what it can. */
  settle(card: Card, paragraph: number, outcome: Outcome): { why: Why; outcome: Outcome } | null {
    const key = this.#key(card, paragraph);
    const was = this.#state.get(key);
    const positive = outcome === "opened" || outcome === "linked";
    let next: "ignored" | "done";
    if (outcome === "ignored") {
      if (was !== "raised") return null;
      next = "ignored";
    } else if (was === "raised" || (positive && (was === "ignored" || was === undefined))) next = "done";
    else return null;
    this.#state.set(key, next);
    return { why: card.why, outcome };
  }
}
