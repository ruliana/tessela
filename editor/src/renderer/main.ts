// The window: sidebar, editor(s) and backlinks. All file access goes through `window.tessela`.

import "./style.css";

import type { Diagnostic, Hit, PageEntry, VocabEntry } from "../shared/api";
import {
  canGoBack,
  canGoForward,
  emptyHistory,
  recentCount,
  step,
  touch,
  visit,
  type History,
  type Place,
} from "../shared/nav";
import { conceptPath, isJournalPath, journalDays, newestFirst, newPagePath, newPageText, pageId } from "../shared/pages";
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
/** Concepts that have a page; null while the vocabulary is unknown, so nothing is called unwritten. */
let written: Set<string> | null = null;
let filter = "";
const PREVIEW_KEY = "tessela.livePreview";
/** Markdown shown rendered outside the block being edited; remembered between runs. */
let livePreview = readPreview();

function readPreview(): boolean {
  try {
    return localStorage.getItem(PREVIEW_KEY) === "1";
  } catch {
    return false;
  }
}

function togglePreview(): void {
  livePreview = !livePreview;
  try {
    localStorage.setItem(PREVIEW_KEY, livePreview ? "1" : "0");
  } catch {
    // The choice just is not remembered.
  }
  for (const c of cards) c.setLivePreview(livePreview);
  previewButton?.setAttribute("aria-pressed", String(livePreview));
}

const RECENT_COUNT_KEY = "tessela.recentCount";
const RECENT_KEY = "tessela.recent";
/** The notes folder, which the Recent list belongs to. */
let root = "";
/** Pages used lately, most recent first. */
let recent: string[] = [];
/** How many of them the sidebar shows. */
let recentShown = readRecentCount();
/** The places shown so far, for Go back and Go forward. */
let places: History = emptyHistory();

function readRecentCount(): number {
  try {
    return recentCount(localStorage.getItem(RECENT_COUNT_KEY));
  } catch {
    return recentCount(undefined);
  }
}

function readRecent(): string[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(`${RECENT_KEY}:${root}`) ?? "[]");
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function remember(path: string): void {
  recent = touch(recent, path);
  try {
    localStorage.setItem(`${RECENT_KEY}:${root}`, JSON.stringify(recent));
  } catch {
    // The list just is not remembered between runs.
  }
}

function setRecentShown(value: string): void {
  recentShown = recentCount(value);
  recentSize.value = String(recentShown);
  try {
    localStorage.setItem(RECENT_COUNT_KEY, String(recentShown));
  } catch {
    // The choice just is not remembered.
  }
  renderLists();
}

/** What the middle of the window shows: one page, or the latest journal days stacked. */
type View = { kind: "page"; path: string } | { kind: "journals"; count: number };
let view: View | null = null;
let cards: Card[] = [];
/** The card the user is working in; backlinks follow it. */
let active: Card | null = null;

const app = document.getElementById("app") as HTMLElement;

// ---- start -----------------------------------------------------------------

let stopListening: (() => void) | undefined;

/** Opens the window on the current notes folder; also used again after the folder changed. */
async function start(): Promise<void> {
  stopListening?.();
  stopListening = undefined;
  if (cards.length > 0) await closeCards();
  pages = [];
  vocab = [];
  problems = [];
  written = null;
  filter = "";
  view = null;
  places = emptyHistory();
  problemsOpen = false;
  const bundle = await api.bundle();
  if (!bundle) return welcome();
  root = bundle;
  recent = readRecent();
  buildShell(bundle);
  stopListening = api.onChanged((paths) => void onChanged(paths));
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
        el(
          "p",
          {},
          "Choose the folder that holds your notes. It is the root of your knowledge base: " +
            "every page, link and tag is found from there, and nothing outside it is seen.",
        ),
        message ? el("p", { class: "error" }, message) : "",
        el(
          "button",
          {
            class: "primary",
            id: "open-bundle",
            onclick: async () => {
              if (await api.chooseBundle()) await start();
            },
          },
          "Choose notes folder…",
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
let previewButton: HTMLElement | undefined;
let recentEl: HTMLElement;
let recentList: HTMLElement;
let recentSize: HTMLInputElement;
let backButton: HTMLButtonElement;
let forwardButton: HTMLButtonElement;
let noticeEl: HTMLElement;
let newPageEl: HTMLElement;
let newPageInput: HTMLInputElement;
let newPageError: HTMLElement;

function buildShell(bundle: string): void {
  let searchTimer: number | undefined;
  newPageError = el("p", { class: "error", id: "new-page-error", hidden: true });
  newPageInput = el("input", {
    class: "search",
    id: "new-page-name",
    placeholder: "Name, e.g. project/idea",
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === "Escape") hideNewPage();
      else if (e.key === "Enter") void createPage();
    },
  });
  newPageEl = el(
    "div",
    { class: "new-page", id: "new-page-form", hidden: true },
    newPageInput,
    el("small", {}, "Use / for folders. Enter creates the page, Esc cancels."),
    newPageError,
  );
  noticeEl = el("div", { class: "notice", id: "notice", hidden: true });
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
  previewButton = el(
    "button",
    {
      class: "secondary",
      id: "preview-toggle",
      title: "Show Markdown rendered, raw only where you are typing (Ctrl/Cmd+Alt+M)",
      onclick: togglePreview,
    },
    "Rendered",
  );
  previewButton.setAttribute("aria-pressed", String(livePreview));
  const mod = navigator.userAgent.includes("Mac") ? "Cmd" : "Super";
  backButton = el("button", { class: "nav", id: "go-back", title: `Go back (${mod}+[)`, ariaLabel: "Go back", onclick: () => void go(-1) }, "‹");
  forwardButton = el("button", { class: "nav", id: "go-forward", title: `Go forward (${mod}+])`, ariaLabel: "Go forward", onclick: () => void go(1) }, "›");
  recentList = el("ul", { class: "list", id: "recent-list" });
  recentSize = el("input", {
    id: "recent-size",
    type: "number",
    min: "1",
    max: "30",
    value: String(recentShown),
    title: "How many recent pages to show",
    onchange: () => setRecentShown(recentSize.value),
  });
  recentEl = el(
    "div",
    { class: "recent", id: "recent" },
    el("div", { class: "recent-head" }, el("h2", {}, "Recent"), recentSize),
    recentList,
  );
  const sidebar = el(
    "aside",
    { class: "sidebar" },
    el("div", { class: "brand" }, "Tessela", el("span", { class: "navs" }, backButton, forwardButton)),
    el(
      "button",
      { class: "root", id: "root", title: `${bundle}\nThe root of your notes. Click to choose another folder.`, onclick: () => void changeRoot() },
      el("span", { class: "root-name" }, bundle.split(/[\\/]/).filter(Boolean).pop() ?? bundle),
      el("span", { class: "root-path" }, bundle),
    ),
    el(
      "div",
      { class: "buttons" },
      el("button", { class: "primary", id: "today", onclick: () => void showJournals(true) }, "Today"),
      el("button", { class: "secondary", id: "journals-view", onclick: () => void showJournals() }, "Journals"),
      previewButton,
    ),
    recentEl,
    el(
      "div",
      { class: "buttons" },
      el("button", { class: "secondary", id: "new-page", title: "New page (Ctrl+N)", onclick: () => showNewPage() }, "New page"),
      el("button", { class: "secondary", id: "open-file", title: "Open a file (Ctrl+O)", onclick: () => void openFile() }, "Open file…"),
    ),
    newPageEl,
    noticeEl,
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
  renderNav();
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
    .sort((a, b) => newestFirst(a.id, b.id))
    .filter((p) => !q || p.id.includes(q))
    .slice(0, q ? 50 : 14);
  journalsEl.replaceChildren(...journals.map((p) => item(p.id.replace("journals/", ""), p.path)));

  recentEl.hidden = recent.length === 0;
  recentList.replaceChildren(
    ...recent.slice(0, recentShown).map((path) => item(pageId(path).replace(/^journals\//, ""), path)),
  );

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
  written = vocab.length === 0 ? null : new Set(vocab.filter((v) => v.has_page).map((v) => v.concept));
  renderLists();
  renderProblems();
  for (const c of cards) c.refresh();
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

// ---- root, new page, open file ---------------------------------------------

async function changeRoot(): Promise<void> {
  const before = await api.bundle();
  const chosen = await api.chooseBundle();
  if (chosen && chosen !== before) await start();
}

function showNotice(text: string, action?: { label: string; run: () => void }): void {
  noticeEl.hidden = false;
  noticeEl.replaceChildren(
    el("p", {}, text),
    ...(action ? [el("button", { class: "secondary", id: "notice-action", onclick: action.run }, action.label)] : []),
    el("button", { class: "secondary", id: "notice-close", onclick: hideNotice }, "Dismiss"),
  );
}

function hideNotice(): void {
  noticeEl.hidden = true;
  noticeEl.replaceChildren();
}

function showNewPage(): void {
  hideNotice();
  newPageEl.hidden = false;
  newPageError.hidden = true;
  newPageInput.value = "";
  newPageInput.focus();
}

function hideNewPage(): void {
  newPageEl.hidden = true;
  newPageInput.value = "";
}

/** Creates the page typed in the "New page" box (its file at once) and opens it. */
async function createPage(): Promise<void> {
  const name = newPageInput.value;
  const path = newPagePath(name);
  if (!path) {
    newPageError.hidden = false;
    newPageError.textContent = "Give the page a name that is not empty and does not start with a dot.";
    return;
  }
  const title = name.trim().replace(/\.md$/i, "").split("/").pop()?.trim();
  try {
    // A page that already exists is a conflict: the existing one is simply opened.
    await api.writePage(path, newPageText(path, title), null);
  } catch (e) {
    newPageError.hidden = false;
    newPageError.textContent = `Could not create the page: ${e instanceof Error ? e.message : String(e)}`;
    return;
  }
  hideNewPage();
  await refreshIndex();
  await showPage(path);
}

/** Asks for a Markdown file; one inside the root opens as a page. */
async function openFile(): Promise<void> {
  const result = await api.openFile();
  if (result.kind === "page") {
    hideNotice();
    await showPage(result.path);
  } else if (result.kind === "outside") {
    showNotice(`That file is outside the notes folder, so its links and backlinks would not work. Use ${result.folder} as the root instead?`, {
      label: "Use that folder",
      run: () => void api.useFolder(result.folder).then(start),
    });
  } else if (result.kind === "unsupported") {
    showNotice(result.reason);
  }
}

// Super (Cmd on macOS, the Windows/Super key elsewhere) with [ and ]. Captured before the editor
// sees the key, because Cmd+[ and Cmd+] would otherwise indent in the editor on macOS.
window.addEventListener(
  "keydown",
  (e) => {
    if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || !document.getElementById("go-back")) return;
    if (e.key !== "[" && e.key !== "]") return;
    e.preventDefault();
    e.stopPropagation();
    void go(e.key === "[" ? -1 : 1);
  },
  true,
);

window.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || !document.getElementById("new-page")) return;
  const key = e.key.toLowerCase();
  if (key === "n" && !e.shiftKey) showNewPage();
  else if (key === "o" && e.shiftKey) void changeRoot();
  else if (key === "o") void openFile();
  else return;
  e.preventDefault();
});

// ---- views -----------------------------------------------------------------

function cardDeps() {
  return {
    api,
    vocab: () => vocab,
    written: () => written,
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
    onOpenExternal: (url: string) => void api.openExternal(url),
    livePreview: () => livePreview,
    onTogglePreview: togglePreview,
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
  arrive({ kind: "page", path });
  remember(path);
  const card = createCard(path, cardDeps());
  cards = [card];
  active = card;
  stackEl.replaceChildren(card.root);
  await card.load();
  card.focus(line);
  renderLists();
  await renderBacklinks();
}

/** Records the place now shown, unless Go back or Go forward just moved to it. */
function arrive(place: Place): void {
  places = visit(places, place);
  renderNav();
}

function renderNav(): void {
  backButton.disabled = !canGoBack(places);
  forwardButton.disabled = !canGoForward(places);
}

/** Go back (`by` -1) or Go forward (1) to the place shown before or after this one. */
async function go(by: -1 | 1): Promise<void> {
  const next = step(places, by);
  if (next === places) return;
  // The history moves first, so showing the place does not add it again.
  places = next;
  const place = places.places[places.at];
  if (place?.kind === "page") await showPage(place.path);
  else await showJournals();
}

async function showJournals(focusToday = false): Promise<void> {
  const today = pageId(await api.todayPath()).replace("journals/", "");
  const count = view?.kind === "journals" ? view.count : JOURNAL_STEP;
  await closeCards();
  view = { kind: "journals", count };
  arrive({ kind: "journals" });
  const days = journalDays(pages.map((p) => p.path), today, count);
  const deps = cardDeps();
  cards = days.map((day) => createCard(`journals/${day}.md`, deps, { compact: true }));
  const more = el(
    "button",
    { class: "more", id: "more-days", onclick: () => void showMoreJournals() },
    "Older days…",
  );
  more.hidden = journalDays(pages.map((p) => p.path), today, count + 1).length <= count;
  stackEl.replaceChildren(...cards.map((c) => c.root), more);
  stackEl.scrollTop = 0;
  await Promise.all(cards.map((c) => c.load()));
  // Today is the first day unless some days are dated after it.
  const todayCard = cards[days.indexOf(today)] ?? null;
  active = focusToday ? todayCard : (cards[0] ?? null);
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
