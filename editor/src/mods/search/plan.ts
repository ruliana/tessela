// The pure parts of the search mod: what the search box says as `tessela query` arguments.
//
//   words in any order     gamma alpha
//   "a phrase as written"  "alpha, beta"   (as many as you like)
//   #tag                   pages and blocks that mention it
//   type:person  in:folder/  from:2020-01-01  to:2020-02-01  2020-01-01 (that one day)

import { MIN_SEARCH_CHARS } from "../../shared/search";

export interface SearchPlan {
  refs: string[];
  type?: string;
  page?: string;
  from?: string;
  to?: string;
  phrases: string[];
  words: string[];
}

const DAY = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Splits on spaces, keeping what is between double quotes together (a quote left open runs to the end). */
function tokens(input: string): { text: string; quoted: boolean }[] {
  const out: { text: string; quoted: boolean }[] = [];
  const pattern = /"([^"]*)(?:"|$)|(\S+)/g;
  for (let m = pattern.exec(input); m; m = pattern.exec(input)) {
    if (m[1] !== undefined) out.push({ text: m[1].trim(), quoted: true });
    else if (m[2] !== undefined) out.push({ text: m[2], quoted: false });
  }
  return out.filter((t) => t.text);
}

export function parseSearch(input: string): SearchPlan {
  const plan: SearchPlan = { refs: [], phrases: [], words: [] };
  for (const { text, quoted } of tokens(input)) {
    if (quoted) {
      plan.phrases.push(text);
      continue;
    }
    const filter = /^(type|in|from|to):(.*)$/i.exec(text);
    if (filter) {
      const [, key = "", value = ""] = filter;
      const name = key.toLowerCase();
      // Until a value follows the colon the filter is still being typed, and says nothing.
      if (!value) continue;
      if (name === "type") plan.type = value;
      else if (name === "in") plan.page = value;
      else if (DAY.test(value)) plan[name as "from" | "to"] = value;
      else plan.words.push(text);
    } else if (text.startsWith("#") && text.length > 1) plan.refs.push(text.slice(1));
    else if (DAY.test(text)) plan.from = plan.to = text;
    else plan.words.push(text);
  }
  return plan;
}

/** Whether there is something to look for: a filter, or enough text (a letter or two matches too much). */
export function searchable(plan: SearchPlan): boolean {
  if (plan.refs.length > 0 || plan.type || plan.page || plan.from || plan.to) return true;
  return [...plan.phrases, plan.words.join(" ")].join("").length >= MIN_SEARCH_CHARS;
}

/** The arguments of `tessela query` for the plan; page titles and headings are searched with the text. */
export function queryArgs(plan: SearchPlan): string[] {
  const args: string[] = [];
  for (const r of plan.refs) args.push("--ref", r);
  if (plan.type) args.push("--type", plan.type);
  if (plan.page) args.push("--page", plan.page);
  if (plan.from) args.push("--from", plan.from);
  if (plan.to) args.push("--to", plan.to);
  for (const p of plan.phrases) args.push("--text", p);
  if (plan.words.length > 0) args.push("--words", plan.words.join(" "));
  if (plan.phrases.length > 0 || plan.words.length > 0) args.push("--meta");
  return args;
}

/** One argument as a person (and the body of a `tessela` fence) writes it: quoted when it has more than plain characters. */
export function quoted(arg: string): string {
  return /^[\w./:#@%+=,-]+$/.test(arg) ? arg : `"${arg.replace(/["\\]/g, "\\$&")}"`;
}

/** The command as shown, and as written in a live list (the same without the program's name). */
export function commandLine(args: string[]): string {
  return ["query", ...args].map(quoted).join(" ");
}

/** What of the text typed is meant for the names of pages: the plain words. */
export function nameFilter(input: string): string {
  const plan = parseSearch(input);
  return [...plan.phrases, ...plan.words].join(" ");
}

/** The text to point at in a hit: the first phrase or word. */
export function focusOf(plan: SearchPlan): string {
  return plan.phrases[0] ?? plan.words[0] ?? "";
}
