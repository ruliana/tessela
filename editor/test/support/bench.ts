// The measurement: for each way of adding a link and each thing to link to, the keys a person
// would press, how many of them are letters that must match something exactly, and what a
// single slip of the finger does to the result.

import type { LinkPage } from "../../src/shared/linkFlows";
import { newPagePath } from "../../src/shared/pages";
import { bracket, ctrlL, currentEditor, pasteToLink, typeItAll } from "./flows";
import { type Flow, run } from "./typing";

/** The pages of a small notes folder. */
export const PAGES: LinkPage[] = [
  { path: "people/ana.md", title: "Ana Souza" },
  { path: "meeting-notes.md", title: "Meeting notes" },
  { path: "daily-todo.md", title: "Daily TODO" },
  { path: "project/tessela.md", title: "Tessela" },
  { path: "project/tessela-editor.md", title: "Tessela editor" },
  { path: "reading-list.md", title: "Books to read" },
  { path: "weekly-review.md", title: "Weekly review" },
];

export interface Scenario {
  id: "existing" | "titleDiffers" | "customText" | "newPage" | "webAddress";
  /** What the person wants to do, in words. */
  wants: string;
  /** The link text that ends up in the file. */
  text: string;
  dest: string;
  /** Words the person would try to find the page with, most natural first. */
  words: string[];
  /** The address on the clipboard, for a web link. */
  clipboard?: string;
}

export const SCENARIOS: Scenario[] = [
  { id: "existing", wants: "link to a page, using its title", text: "Daily TODO", dest: "/daily-todo.md", words: ["daily"] },
  {
    id: "titleDiffers",
    wants: "link to a page whose file name is not its title",
    text: "Books to read",
    dest: "/reading-list.md",
    words: ["books", "reading"],
  },
  { id: "customText", wants: "link to a page, with other words as the text", text: "my todo list", dest: "/daily-todo.md", words: ["daily"] },
  { id: "newPage", wants: "link to a page that does not exist yet", text: "Sprint retro", dest: "/sprint-retro.md", words: [] },
  {
    id: "webAddress",
    wants: "link a word to an address that is on the clipboard",
    text: "Anthropic",
    dest: "https://www.anthropic.com",
    words: [],
    clipboard: "https://www.anthropic.com",
  },
];

type Role = "label" | "target" | "search" | "syntax" | "control";
export interface Step {
  key: string;
  role: Role;
}

const chars = (s: string, role: Role): Step[] => [...s].map((key) => ({ key, role }));
const press = (...keys: string[]): Step[] => keys.map((key) => ({ key, role: "control" as const }));
const syntax = (s: string): Step[] => chars(s, "syntax");

/** How one way of adding a link is done for one thing to link to. `null`: it does not help there, so the long way is used. */
interface Script {
  /** The keys, for what was typed to find the page (empty when nothing is searched for). */
  steps: (found: string) => Step[];
  /** Whether a word has to be found, and from how many letters the person starts. */
  search: { minLetters: number } | null;
}

export interface Way {
  id: string;
  flow: (pages: LinkPage[]) => Flow;
  script: (sc: Scenario) => Script | null;
}

const long = (sc: Scenario): Script => ({
  steps: () => [
    ...syntax("["),
    ...chars(sc.text, "label"),
    ...syntax("]("),
    ...(sc.clipboard === undefined ? chars(sc.dest, "target") : press("Ctrl+V")),
    ...syntax(")"),
  ],
  search: null,
});

export const WAYS: Way[] = [
  { id: "typeItAll", flow: () => typeItAll, script: long },
  {
    id: "current",
    flow: currentEditor,
    script: (sc) =>
      sc.clipboard !== undefined
        ? null
        : {
            steps: (q) => [...syntax("["), ...chars(sc.text, "label"), ...syntax("]("), ...chars(q, "search"), ...press("Enter", "Right")],
            search: sc.id === "newPage" ? null : { minLetters: 0 },
          },
  },
  {
    id: "bracket",
    flow: bracket,
    script: (sc) => {
      if (sc.clipboard !== undefined) return null;
      if (sc.id === "newPage") return { steps: () => [...syntax("["), ...chars(sc.text, "label"), ...press("Enter")], search: null };
      if (sc.id === "customText") {
        return { steps: (q) => [...syntax("["), ...chars(sc.text, "label"), ...syntax("]("), ...chars(q, "search"), ...press("Enter")], search: { minLetters: 1 } };
      }
      return { steps: (q) => [...syntax("["), ...chars(q, "search"), ...press("Enter")], search: { minLetters: 1 } };
    },
  },
  {
    id: "ctrlL",
    flow: ctrlL,
    script: (sc) => {
      if (sc.clipboard !== undefined) return null;
      if (sc.id === "newPage") return { steps: () => [...press("Ctrl+L"), ...chars(sc.text, "label"), ...press("Enter")], search: null };
      if (sc.id === "customText") {
        return {
          steps: (q) => [...chars(sc.text, "label"), ...press("Shift+Home", "Ctrl+L"), ...chars(q, "search"), ...press("Enter")],
          search: { minLetters: 1 },
        };
      }
      return { steps: (q) => [...press("Ctrl+L"), ...chars(q, "search"), ...press("Enter")], search: { minLetters: 1 } };
    },
  },
  {
    id: "paste",
    flow: () => pasteToLink,
    script: (sc) =>
      sc.clipboard === undefined ? null : { steps: () => [...chars(sc.text, "label"), ...press("Shift+Home", "Ctrl+V")], search: null },
  },
];

export interface Outcome {
  /** The file ends up as exactly the link that was wanted, with the cursor after it. */
  ok: boolean;
  doc: string;
}

function attempt(way: Way, sc: Scenario, steps: Step[], pages = PAGES): Outcome {
  const doc = run(way.flow(pages), steps.map((s) => s.key), sc.clipboard ?? "");
  const want = `[${sc.text}](${sc.dest})`;
  return { ok: doc.text === want && doc.cursor === want.length, doc: doc.text };
}

export interface Measure {
  way: string;
  scenario: Scenario["id"];
  /** False when this way does nothing for the scenario and the long way is measured. */
  helps: boolean;
  /** The link comes out right. */
  works: boolean;
  keys: number;
  /** Letters typed that end up in the path and have to match a file exactly. */
  pathLetters: number;
  /** Letters typed to find a page, which a near miss still finds. */
  searchLetters: number;
  /** The page was found only by the first letters of its file name, not of its title. */
  neededFileName: boolean;
  steps: Step[];
}

/** The fewest keys that work: the person types as few letters as it takes to put the page first. */
export function measure(way: Way, sc: Scenario, pages = PAGES): Measure {
  const own = way.script(sc);
  const script = own ?? long(sc);
  const helps = own !== null;
  let best: { steps: Step[]; wordIndex: number } | null = null;
  if (script.search === null) {
    best = { steps: script.steps(""), wordIndex: 0 };
  } else {
    for (const [wordIndex, word] of sc.words.entries()) {
      for (let n = script.search.minLetters; n <= word.length && best === null; n++) {
        const steps = script.steps(word.slice(0, n));
        if (attempt(way, sc, steps, pages).ok) best = { steps, wordIndex };
      }
      if (best !== null) break;
    }
  }
  const steps = best?.steps ?? script.steps(sc.words[0] ?? "");
  const count = (role: Role) => steps.filter((s) => s.role === role).length;
  return {
    way: way.id,
    scenario: sc.id,
    helps,
    works: best !== null && attempt(way, sc, steps, pages).ok,
    keys: steps.length,
    pathLetters: count("target"),
    searchLetters: count("search"),
    neededFileName: (best?.wordIndex ?? 0) > 0,
    steps,
  };
}

const NEXT_TO: Record<string, string> = Object.fromEntries(
  ["qwertyuiop", "asdfghjkl", "zxcvbnm"].flatMap((row) => [...row].map((c, i) => [c, row[i + 1] ?? row[i - 1]!])),
);

export interface Slips {
  tried: number;
  /** A well-formed link to the wrong place: nothing on screen says so. */
  silent: number;
  /** Not a link at all, e.g. a stray `[d`: it shows, so it gets fixed. */
  unfinished: number;
}

/** Every typed character dropped, and every letter replaced by its neighbour on the keyboard, one at a time. */
export function slips(way: Way, sc: Scenario, m: Measure, pages = PAGES): Slips {
  const result: Slips = { tried: 0, silent: 0, unfinished: 0 };
  const variants: Step[][] = [];
  for (const [i, s] of m.steps.entries()) {
    if (s.key.length !== 1) continue;
    variants.push(m.steps.filter((_, j) => j !== i));
    const near = NEXT_TO[s.key.toLowerCase()];
    if (near !== undefined) variants.push(m.steps.map((t, j) => (j === i ? { ...t, key: near } : t)));
  }
  for (const steps of variants) {
    result.tried++;
    const link = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(attempt(way, sc, steps, pages).doc);
    if (link === null) {
      result.unfinished++;
      continue;
    }
    // A slip in the link text leaves the link where it was meant to go. For a page that is being made,
    // a slip in its name that the path follows is a misspelled name, not a link that goes astray.
    const meant = link[2] === sc.dest || (sc.id === "newPage" && link[2] === `/${newPagePath(link[1] ?? "")}`);
    if (!meant) result.silent++;
  }
  return result;
}

/** The comparison as a table, one block per thing to link to. */
export function table(pages = PAGES): string {
  const lines: string[] = [];
  for (const sc of SCENARIOS) {
    lines.push(`\n${sc.wants}: [${sc.text}](${sc.dest})`);
    lines.push("| way | keys | path letters typed | search letters | slips: silently wrong link | slips: not a link | works |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const way of WAYS) {
      const m = measure(way, sc, pages);
      const s = slips(way, sc, m, pages);
      const note = (m.helps ? "" : " (long way)") + (m.neededFileName ? " (had to recall the file name)" : "");
      lines.push(`| ${way.id}${note} | ${m.keys} | ${m.pathLetters} | ${m.searchLetters} | ${s.silent} of ${s.tried} | ${s.unfinished} of ${s.tried} | ${m.works ? "yes" : "NO"} |`);
    }
  }
  return lines.join("\n");
}
