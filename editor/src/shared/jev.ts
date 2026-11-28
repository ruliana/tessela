// Jev, the decision model of TypeSafe AI, as the editor asks it: typed questions about one state,
// typed answers with probabilities (https://docs.typesafe.ai/api/system-one). The window never holds the
// key: it asks the main process (`Api.jev`), which reads the config folder's settings.json and calls
// the service. These are the shapes that cross.

/** A yes or no question. The answer's `noul` is the probability of yes. */
export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

/** One option out of several: `criteria` says what each option is. */
export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

/** A position on an ordered scale: the answer's `score` is a number from 0 to `criteria.length - 1`. */
export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** Everything Jev is told: the `state` the questions are about (any JSON value) and the questions, by name. */
export interface JevRequest {
  state: unknown;
  questions: Record<string, JevQuestion>;
}

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number };

/** An answer is the answers by question name, or why there are none: no key, no network, a refusal, a cancel. */
export type JevResult = { ok: true; answers: Record<string, JevAnswer> } | { ok: false; error: string };

const MAX_QUESTIONS = 400;
const MAX_BYTES = 512 * 1024;

/** Whether `value` is a request the window may send: named questions of the three kinds, a state, a modest size. */
export function isJevRequest(value: unknown): value is JevRequest {
  if (typeof value !== "object" || value === null) return false;
  const { state, questions } = value as { state?: unknown; questions?: unknown };
  if (state === undefined || typeof questions !== "object" || questions === null || Array.isArray(questions)) return false;
  const entries = Object.values(questions as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_QUESTIONS) return false;
  for (const q of entries) {
    if (typeof q !== "object" || q === null) return false;
    const { type, instructions, criteria } = q as { type?: unknown; instructions?: unknown; criteria?: unknown };
    if (typeof instructions !== "string") return false;
    if (type === "noul") continue;
    if (type === "choice" && typeof criteria === "object" && criteria !== null && !Array.isArray(criteria)) continue;
    if (type === "score" && Array.isArray(criteria) && criteria.length >= 2) continue;
    return false;
  }
  try {
    return JSON.stringify(value).length <= MAX_BYTES;
  } catch {
    return false;
  }
}

/** An answer of the shape asked for, from whatever the service sent. Anything else is dropped. */
export function cleanAnswers(raw: unknown): Record<string, JevAnswer> {
  const out: Record<string, JevAnswer> = {};
  if (typeof raw !== "object" || raw === null) return out;
  const unit = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  const table = (t: unknown): Record<string, number> => {
    const probabilities: Record<string, number> = {};
    if (typeof t === "object" && t !== null) for (const [k, v] of Object.entries(t)) if (unit(v)) probabilities[k] = v;
    return probabilities;
  };
  for (const [name, a] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof a !== "object" || a === null) continue;
    const r = a as Record<string, unknown>;
    if (r.type === "noul" && unit(r.noul)) out[name] = { type: "noul", noul: r.noul };
    else if (r.type === "choice" && typeof r.choice === "string") out[name] = { type: "choice", choice: r.choice, probabilities: table(r.probabilities), confidence: unit(r.confidence) ? r.confidence : 0 };
    else if (r.type === "score" && unit(r.score)) out[name] = { type: "score", score: r.score, probabilities: table(r.probabilities), confidence: unit(r.confidence) ? r.confidence : 0 };
  }
  return out;
}
