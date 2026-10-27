// The window: sidebar, editor(s) and backlinks. All file access goes through `window.tessela`.

import "./style.css";

import type { Diagnostic, Hit, PageEntry, VocabEntry } from "../shared/api";
import { conceptPath, isJournalPath, pageId } from "../shared/pages";
import { summary, visibleProblems } from "../shared/problems";
import { excerpt, searchable, textHits } from "../shared/search";
import { createCard, type Card } from "./card";
import { el } from "./dom";

const api = window.tessela;
const JOURNAL_STEP = 7;
const SEARCH_DELAY_MS = 250;

let pages: PageEntry[] = [];
let vocab: VocabEntry[] = [];
let problems: Diagnostic[] = [];
let filter = "";

/** What the middle of the window shows: one page, or the latest journal days stacked. */
type View = { kind: "page"; path: string } | { kind: "journals"; count: number };
let view: View | null = null;
let cards: Card[] = [];
/** The card the user is working in; backlinks follow it. */
let active: Card | null = null;

const app = document.getElementById("app") as HTMLElement;

// ---- start -----------------------------------------------------------------

async function start(): Promise<void> {
  const bundle = await api.bundle();
  if (!bundle) return welcome();
  buildShell(bundle);
  api.onChanged((paths) => void onChanged(paths));
  await refreshIndex();
  await showJournals();
}

function welcome(message?: string): void {
  app.replaceChildren(
    el(
      "div",
      { class: "welcome" },
      el(
        "div",
        {},
        el("h1", {}, "Tessela"),
        el("p", {}, "Open a folder of Markdown notes (an OKF bundle) to start."),
        message ? el("p", { class: "error" }, message) : "",
        el(
          "button",
          {
            class: "primary",
            id: "open-bundle",
            onclick: async () => {
              if (await api.chooseBundle()) location.reload();
            },
          },
          "Open a bundle…",
        ),
      ),
    ),
  );
}

// ---- layout ----------------------------------------------------------------

let listEl: HTMLElement;
let journalsEl: HTMLElement;
let resultsEl: HTMLElement;
let problemsEl: HTMLElement;
let problemsToggle: HTMLButtonElement;
let problemsOpen = false;
let stackEl: HTMLElement;
let backlinksEl: HTMLElement;

function buildShell(bundle: string): void {
  let searchTimer: number | undefined;
  const search = el("input", {
    class: "search",
    id: "search",
    placeholder: "Search, or create a page…",
    oninput: () => {
      filter = search.value;
      renderLists();
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => void runSearch(), SEARCH_DELAY_MS);
    },
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        search.value = filter = "";
        renderLists();
        void runSearch();
        return;
      }
      if (e.key !== "Enter" || !filter.trim()) return;
      const path = conceptPath(filter.trim());
      search.value = filter = "";
      renderLists();
      void runSearch();
      void showPage(path);
    },
  });
  journalsEl = el("ul", { class: "list", id: "journals" });
  listEl = el("ul", { class: "list", id: "pages" });
  resultsEl = el("div", { class: "results", id: "results", hidden: true });
  problemsEl = el("ul", { class: "problems", id: "problems", hidden: true });
  problemsToggle = el("button", { class: "problems-toggle", id: "problems-toggle", onclick: toggleProblems });
  const sidebar = el(
    "aside",
    { class: "sidebar" },
    el("div", { class: "brand" }, "Tessela", el("small", { title: bundle }, bundle.split("/").pop() ?? bundle)),
    el(
      "div",
      { class: "buttons" },
      el("button", { class: "primary", id: "today", onclick: () => void showJournals(true) }, "Today"),
      el("button", { class: "secondary", id: "journals-view", onclick: () => void showJournals() }, "Journals"),
    ),
    search,
    resultsEl,
    el("div", { class: "lists" }, journalsEl, listEl),
    problemsEl,
    problemsToggle,
  );

  stackEl = el("div", { class: "stack", id: "stack" });
  backlinksEl = el("aside", { class: "backlinks", id: "backlinks" });
  app.replaceChildren(el("div", { class: "shell" }, sidebar, el("main", { class: "pane" }, stackEl), backlinksEl));
  renderProblems();
}

function renderLists(): void {
  const q = filter.trim().toLowerCase();
  const item = (label: string, path: string, count?: number, unwritten = false) => {
    const button = el(
      "button",
      { onclick: () => void showPage(path) },
      el("span", { class: "name" }, label),
      count === undefined ? "" : el("span", { class: "count" }, String(count)),
    );
    if (view?.kind === "page" && view.path === path) button.setAttribute("aria-current", "page");
    return el("li", { class: unwritten ? "unwritten" : "" }, button);
  };

  const journals = pages
    .filter((p) => isJournalPath(p.path))
    .sort((a, b) => b.id.localeCompare(a.id))
    .filter((p) => !q || p.id.includes(q))
    .slice(0, q ? 50 : 14);
  journalsEl.replaceChildren(...journals.map((p) => item(p.id.replace("journals/", ""), p.path)));

  const written = new Set(pages.map((p) => p.id.toLowerCase()));
  const concepts = vocab
    .filter((v) => !v.deprecated && !v.use_instead)
    .filter((v) => !v.concept.startsWith("journals/"))
    .filter((v) => !q || v.concept.includes(q))
    .sort((a, b) => b.mentions - a.mentions || a.concept.localeCompare(b.concept))
    .slice(0, 200);
  const shown = new Set(concepts.map((v) => v.concept));
  const rest = pages
    .filter((p) => !isJournalPath(p.path) && !shown.has(p.id.toLowerCase()))
    .filter((p) => !q || p.id.toLowerCase().includes(q));
  listEl.replaceChildren(
    ...concepts.map((v) =>
      item(v.concept, conceptPath(v.concept), v.mentions, !written.has(v.concept)),
    ),
    ...rest.map((p) => item(p.id, p.path)),
  );
}

async function refreshIndex(): Promise<void> {
  [pages, vocab, problems] = await Promise.all([
    api.listPages(),
    api.vocab().catch(() => []),
    api.lint().then(visibleProblems, () => []),
  ]);
  renderLists();
  renderProblems();
}

// ---- search ------------------------------------------------------------------

let searchRun = 0;

/** Looks for the typed text inside the notes, next to the filter on page names. */
async function runSearch(): Promise<void> {
  const run = ++searchRun;
  const text = searchable(filter);
  if (!text) {
    resultsEl.hidden = true;
    resultsEl.replaceChildren();
    return;
  }
  let hits: Hit[] = [];
  try {
    hits = textHits(await api.query({ text, limit: 40 }));
  } catch {
    // Searching needs the tessela tool; the page list still works without it.
  }
  if (run !== searchRun) return;
  resultsEl.hidden = false;
  resultsEl.replaceChildren(
    el("h2", {}, hits.length === 0 ? "Not in any text" : "In the text"),
    ...hits.map((hit) =>
      el(
        "button",
        { class: "hit", onclick: () => void openAt(hit) },
        el("span", { class: "kind" }, pageId(hit.path)),
        excerpt(hit.text, text),
      ),
    ),
  );
}

// ---- problems --------------------------------------------------------------

function toggleProblems(): void {
  problemsOpen = !problemsOpen;
  renderProblems();
}

function renderProblems(): void {
  problemsToggle.textContent = `${problemsOpen ? "▾" : "▸"} ${summary(problems)}`;
  problemsToggle.dataset.clean = String(problems.length === 0);
  problemsEl.hidden = !problemsOpen || problems.length === 0;
  problemsEl.replaceChildren(
    ...problems.map((d) =>
      el(
        "li",
        {},
        el(
          "button",
          { class: `problem ${d.severity}`, title: d.rule, onclick: () => void showPage(d.path, d.line ?? undefined) },
          el("span", { class: "where" }, `${d.path}${d.line ? `:${d.line}` : ""}`),
          d.message,
        ),
      ),
    ),
  );
}

// ---- views -----------------------------------------------------------------

function cardDeps() {
  return {
    api,
    vocab: () => vocab,
    onSaved: () => {
      void refreshIndex();
      void renderBacklinks();
    },
    onActive: (path: string) => {
      const card = cards.find((c) => c.path === path);
      if (card && card !== active) {
        active = card;
        void renderBacklinks();
      }
    },
    onOpenPage: (path: string) => void showPage(path),
    onOpenConcept: (id: string) => void showPage(conceptPath(id)),
  };
}

async function closeCards(): Promise<void> {
  await Promise.all(cards.map((c) => c.flush()));
  for (const c of cards) c.destroy();
  cards = [];
  active = null;
  stackEl.replaceChildren();
}

async function showPage(path: string, line?: number): Promise<void> {
  await closeCards();
  view = { kind: "page", path };
  const card = createCard(path, cardDeps());
  cards = [card];
  active = card;
  stackEl.replaceChildren(card.root);
  await card.load();
  card.focus(line);
  renderLists();
  await renderBacklinks();
}

/** The days to stack: today first (it may have no file yet), then the latest earlier days. */
function journalDays(count: number, today: string): string[] {
  const earlier = pages
    .filter((p) => isJournalPath(p.path))
    .map((p) => pageId(p.path).replace("journals/", ""))
    .filter((day) => day !== today)
    .sort((a, b) => b.localeCompare(a));
  return [today, ...earlier].slice(0, count);
}

async function showJournals(focusToday = false): Promise<void> {
  const today = pageId(await api.todayPath()).replace("journals/", "");
  const count = view?.kind === "journals" ? view.count : JOURNAL_STEP;
  await closeCards();
  view = { kind: "journals", count };
  const days = journalDays(count, today);
  const deps = cardDeps();
  cards = days.map((day) => createCard(`journals/${day}.md`, deps, { compact: true }));
  const more = el(
    "button",
    { class: "more", id: "more-days", onclick: () => void showMoreJournals() },
    "Older days…",
  );
  more.hidden = journalDays(count + 1, today).length <= count;
  stackEl.replaceChildren(...cards.map((c) => c.root), more);
  stackEl.scrollTop = 0;
  await Promise.all(cards.map((c) => c.load()));
  active = cards[0] ?? null;
  if (focusToday) active?.focus();
  renderLists();
  await renderBacklinks();
}

async function showMoreJournals(): Promise<void> {
  if (view?.kind !== "journals") return;
  view.count += JOURNAL_STEP;
  await showJournals();
}

async function openAt(hit: Hit): Promise<void> {
  await showPage(hit.path, hit.line);
}

async function onChanged(paths: string[]): Promise<void> {
  void refreshIndex();
  await Promise.all(cards.map((c) => c.diskChanged(paths)));
  await renderBacklinks();
}

// ---- backlinks -------------------------------------------------------------

let backlinkRun = 0;

async function renderBacklinks(): Promise<void> {
  if (!active) return;
  const run = ++backlinkRun;
  const path = active.path;
  const id = pageId(path).toLowerCase();
  const queries = [api.query({ refs: [id], limit: 300 })];
  if (isJournalPath(path)) {
    const day = id.replace("journals/", "");
    queries.push(api.query({ from: day, to: day, limit: 300 }));
  }
  let hits: Hit[] = [];
  try {
    hits = (await Promise.all(queries)).flat();
  } catch {
    // The tool may be missing; the editor still works without backlinks.
  }
  if (run !== backlinkRun) return;

  const seen = new Set<string>();
  const byPage = new Map<string, Hit[]>();
  for (const hit of hits) {
    if (hit.path === path || seen.has(hit.handle)) continue;
    seen.add(hit.handle);
    byPage.set(hit.path, [...(byPage.get(hit.path) ?? []), hit]);
  }

  const total = [...byPage.values()].reduce((n, h) => n + h.length, 0);
  const head = el("h2", { class: "title" }, `Backlinks (${total})`);
  if (total === 0) {
    backlinksEl.replaceChildren(head, el("p", { class: "empty" }, "Nothing mentions this page yet."));
    return;
  }
  const groups = [...byPage.entries()].map(([p, list]) =>
    el(
      "section",
      {},
      el("h3", {}, el("button", { onclick: () => void showPage(p) }, pageId(p))),
      ...list.map((hit) =>
        el(
          "button",
          { class: "hit", onclick: () => void openAt(hit) },
          el("span", { class: "kind" }, hit.kind),
          hit.text,
        ),
      ),
    ),
  );
  backlinksEl.replaceChildren(head, ...groups);
}

start().catch((e) => welcome(String(e)));
