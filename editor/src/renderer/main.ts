// The window: sidebar, editor(s) and backlinks. All file access goes through `window.tessela`.

import "@fontsource-variable/newsreader/index.css";
import "@fontsource-variable/newsreader/wght-italic.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./style.css";

import type { Diagnostic, Hit, PageEntry, VocabEntry } from "../shared/api";
import { isHomeHit, orderBacklinks } from "../shared/backlinks";
import { linkPages } from "../shared/linkFlows";
import {
  canGoBack,
  canGoForward,
  emptyHistory,
  recentCount,
  relocate,
  relocateRecent,
  step,
  touch,
  visit,
  type History,
  type Place,
} from "../shared/nav";
import { conceptPath, isJournalPath, journalDays, journalPath, newestFirst, newPagePath, pageId } from "../shared/pages";
import { summary, visibleProblems } from "../shared/problems";
import { excerpt, searchable, textHits } from "../shared/search";
import { createCard, type Card } from "./card";
import { el } from "./dom";
import { renderInlineText } from "./inline";
import { logo } from "./logo";
import { describeMods } from "../shared/mods";
import { host, modExtensions, modsInfo, loadMods, registry, sidebarSlot } from "./mods";
import { type Command, paletteOpen, togglePalette } from "./palette";

const api = window.tessela;
const JOURNAL_STEP = 7;
/** How many journal days the sidebar lists (All opens the stack). */
const JOURNAL_LIST = 7;
const SEARCH_DELAY_MS = 250;

let pages: PageEntry[] = [];
let vocab: VocabEntry[] = [];
let problems: Diagnostic[] = [];
/** Concepts that have a page; null while the vocabulary is unknown, so nothing is called unwritten. */
let written: Set<string> | null = null;
let filter = "";
const PREVIEW_KEY = "tessela.livePreview";
/** Markdown shown rendered outside the block being edited; on unless it was turned off. */
let livePreview = readPreview();

function readPreview(): boolean {
  try {
    return localStorage.getItem(PREVIEW_KEY) !== "0";
  } catch {
    return true;
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

const THEME_KEY = "tessela.theme";
const TEXT_KEY = "tessela.text";
type Theme = "system" | "light" | "dark";
type TextFace = "serif" | "sans";
const THEMES: Theme[] = ["system", "light", "dark"];
let theme: Theme = readChoice(THEME_KEY, THEMES, "system");
let textFace: TextFace = readChoice(TEXT_KEY, ["serif", "sans"], "serif");

function readChoice<T extends string>(key: string, allowed: T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return allowed.find((a) => a === value) ?? fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The choice just is not remembered.
  }
}

/** Light or dark follows the system unless a choice was made; the text is serif or sans. */
function applyLook(): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  if (textFace === "serif") root.removeAttribute("data-text");
  else root.setAttribute("data-text", textFace);
}
applyLook();

const PANELS_KEY = "tessela.panels";
/** Which side panels are shown; remembered. Focus mode hides both for a while and is not. */
let panels = readPanels();
let focusMode = false;
let shellEl: HTMLElement | undefined;
let focusButton: HTMLElement | undefined;

function readPanels(): { sidebar: boolean; backlinks: boolean } {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(PANELS_KEY) ?? "{}");
    const p = (saved && typeof saved === "object" ? saved : {}) as Record<string, unknown>;
    return { sidebar: p.sidebar !== false, backlinks: p.backlinks !== false };
  } catch {
    return { sidebar: true, backlinks: true };
  }
}

function applyLayout(): void {
  if (!shellEl) return;
  shellEl.dataset.sidebar = panels.sidebar ? "1" : "0";
  shellEl.dataset.backlinks = panels.backlinks ? "1" : "0";
  shellEl.dataset.focus = focusMode ? "1" : "0";
  focusButton?.setAttribute("aria-pressed", String(focusMode));
}

function togglePanel(which: "sidebar" | "backlinks"): void {
  panels[which] = !panels[which];
  store(PANELS_KEY, JSON.stringify(panels));
  applyLayout();
}

function toggleFocus(): void {
  focusMode = !focusMode;
  applyLayout();
  active?.focus();
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
  saveRecent();
}

function saveRecent(): void {
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
        logo(72),
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
let themeButton: HTMLElement;
let textButton: HTMLElement;
let rootCount: HTMLElement;
let journalsSection: HTMLElement;
let conceptsSection: HTMLElement;
let statusEl: HTMLElement;
let wordsEl: HTMLElement;

const label = (s: string) => s[0]?.toUpperCase() + s.slice(1);

function renderPrefs(): void {
  themeButton.textContent = `Theme: ${label(theme)}`;
  themeButton.title = "Light, dark, or follow the system";
  textButton.textContent = `Text: ${label(textFace)}`;
  textButton.title = "Write in a serif or a sans-serif typeface";
}

function cycleTheme(): void {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] ?? "system";
  store(THEME_KEY, theme);
  applyLook();
  renderPrefs();
}

function toggleText(): void {
  textFace = textFace === "serif" ? "sans" : "serif";
  store(TEXT_KEY, textFace);
  applyLook();
  renderPrefs();
}

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
  problemsEl = el("ul", { class: "problems pop", id: "problems", hidden: true });
  problemsToggle = el("button", { class: "problems-toggle", id: "problems-toggle", onclick: toggleProblems });
  previewButton = el(
    "button",
    {
      class: "seg-toggle",
      id: "preview-toggle",
      title: "Show Markdown rendered, raw only where you are typing (Ctrl/Cmd+Alt+M)",
      onclick: togglePreview,
    },
    el("span", { class: "on" }, "Rendered"),
    el("span", { class: "off" }, "Source"),
  );
  previewButton.setAttribute("aria-pressed", String(livePreview));
  themeButton = el("button", { class: "pref", id: "theme-toggle", onclick: cycleTheme });
  textButton = el("button", { class: "pref", id: "text-toggle", onclick: toggleText });
  renderPrefs();
  const isMac = navigator.userAgent.includes("Mac");
  const key = isMac ? "⌘" : "Ctrl";
  const mod = isMac ? "Cmd" : "Super";
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
  const row = (id: string, glyph: string, text: string, title: string, run: () => void, hint?: string) =>
    el(
      "button",
      { class: "row", id, title, onclick: run },
      el("span", { class: "g" }, glyph),
      el("span", { class: "t" }, text),
      hint ? el("kbd", {}, hint) : "",
    );
  const now = new Date();
  const todayDay = `${now.toLocaleDateString("en-US", { weekday: "short" })} ${now.getDate()}`;
  rootCount = el("span", { class: "root-count" });
  journalsSection = el(
    "section",
    { class: "group", id: "journals-section" },
    el(
      "div",
      { class: "group-head" },
      el("h2", {}, "Journals"),
      el("button", { class: "link", id: "journals-all", title: "Show the days stacked", onclick: () => void showJournals() }, "All ›"),
    ),
    journalsEl,
  );
  conceptsSection = el(
    "section",
    { class: "group", id: "concepts-section" },
    el("div", { class: "group-head" }, el("h2", {}, "Concepts"), el("span", { class: "hint" }, "by mentions")),
    listEl,
  );
  const sidebar = el(
    "aside",
    { class: "sidebar" },
    el(
      "div",
      { class: "brand" },
      el("span", { class: "brand-name" }, logo(20), "Tessela"),
      el("span", { class: "navs" }, backButton, forwardButton),
    ),
    el(
      "button",
      { class: "root", id: "root", title: `${bundle}\nThe root of your notes. Click to choose another folder.`, onclick: () => void changeRoot() },
      el("span", { class: "g", ariaHidden: "true" }, "⌂"),
      el("span", { class: "root-name" }, bundle.split(/[\\/]/).filter(Boolean).pop() ?? bundle),
      rootCount,
      el("span", { class: "root-path" }, bundle),
    ),
    search,
    resultsEl,
    el(
      "nav",
      { class: "places" },
      el(
        "button",
        { class: "today", id: "today", title: "Today's journal", onclick: () => void showJournals(true) },
        el("span", { class: "dot" }),
        el("span", { class: "t" }, "Today"),
        el("span", { class: "d" }, todayDay),
      ),
      row("journals-view", "◷", "Journals", "The latest journal days, stacked", () => void showJournals()),
    ),
    sidebarSlot,
    recentEl,
    el(
      "nav",
      { class: "places" },
      row("new-page", "+", "New page", `New page (${key}+N)`, () => showNewPage(), `${key} N`),
      row("open-file", "↗", "Open file…", `Open a file (${key}+O)`, () => void openFile(), `${key} O`),
    ),
    newPageEl,
    noticeEl,
    el("div", { class: "lists" }, journalsSection, conceptsSection),
  );

  focusButton = el("button", { class: "pref", id: "focus-toggle", title: `Hide the panels and dim all but the block you are in (${key}+.)`, onclick: toggleFocus }, "Focus");
  focusButton.setAttribute("aria-pressed", String(focusMode));
  statusEl = el("span", { class: "strip-status", id: "strip-status" });
  wordsEl = el("span", { class: "strip-words", id: "strip-words" });
  const strip = el(
    "footer",
    { class: "strip", id: "strip" },
    statusEl,
    wordsEl,
    problemsToggle,
    el("span", { class: "sp" }),
    previewButton,
    focusButton,
    themeButton,
    textButton,
  );

  stackEl = el("div", { class: "stack", id: "stack" });
  backlinksEl = el("aside", { class: "backlinks", id: "backlinks" });
  shellEl = el("div", { class: "shell" }, sidebar, el("main", { class: "pane" }, stackEl), backlinksEl, strip, problemsEl);
  app.replaceChildren(shellEl);
  applyLayout();
  renderStrip();
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
    .slice(0, q ? 50 : JOURNAL_LIST);
  journalsEl.replaceChildren(...journals.map((p) => item(p.id.replace("journals/", ""), p.path)));

  recentEl.hidden = recent.length === 0;
  recentList.replaceChildren(
    ...recent.slice(0, recentShown).map((path) => item(pageId(path).replace(/^journals\//, ""), path)),
  );

  journalsSection.hidden = journals.length === 0;
  rootCount.textContent = pages.length === 0 ? "" : `· ${pages.length} ${pages.length === 1 ? "page" : "pages"}`;
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
  conceptsSection.hidden = listEl.childElementCount === 0;
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

// ---- status strip ----------------------------------------------------------

/** Shows the save state of the cards (the worst one wins) and the words of the page being worked on. */
function renderStrip(): void {
  if (!statusEl) return;
  const infos = cards.map((c) => c.statusInfo());
  const shown = infos.find((i) => i.state === "conflict") ?? infos.find((i) => i.state === "dirty") ?? active?.statusInfo() ?? infos[0];
  statusEl.dataset.state = shown?.state ?? "saved";
  statusEl.replaceChildren(el("span", { class: "dot" }), shown?.text ?? "");
  const words = active?.words() ?? 0;
  wordsEl.textContent = words === 0 ? "" : `${words.toLocaleString("en-US")} ${words === 1 ? "word" : "words"}`;
}

// ---- problems --------------------------------------------------------------

function toggleProblems(): void {
  problemsOpen = !problemsOpen;
  renderProblems();
}

function renderProblems(): void {
  problemsToggle.textContent = problems.length === 0 ? summary(problems) : `▲ ${summary(problems)}`;
  problemsToggle.setAttribute("aria-expanded", String(problemsOpen && problems.length > 0));
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
    // A page that already exists is simply opened.
    await api.addPage(path, title);
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

const IS_MAC = navigator.userAgent.includes("Mac");

/** The commands of the palette: the built-in ones, then the mods'. Each built-in one also has its own button or keys. */
function commandList(): Command[] {
  return registry.commands(builtinCommands(), (c) => ({
    id: c.id,
    label: c.label,
    ...(c.hint ? { hint: c.hint } : {}),
    run: () => registry.run(c, { view: active?.view() }),
  }));
}

function showMods(): void {
  const info = modsInfo;
  showNotice(describeMods(registry.loaded, registry.failures, info?.folder ?? "the config folder", info?.disabled ?? false));
}

function builtinCommands(): Command[] {
  const key = IS_MAC ? "⌘" : "Ctrl";
  return [
    { id: "today", label: "Go to today", run: () => void showJournals(true) },
    { id: "journals", label: "Show the journals", run: () => void showJournals() },
    { id: "new-page", label: "New page", hint: `${key} N`, run: () => showNewPage() },
    { id: "open-file", label: "Open file…", hint: `${key} O`, run: () => void openFile() },
    { id: "root", label: "Change the notes folder…", hint: `${key} Shift O`, run: () => void changeRoot() },
    { id: "preview", label: livePreview ? "Show the Markdown as written" : "Show the Markdown rendered", hint: `${key} Alt M`, run: togglePreview },
    { id: "focus", label: focusMode ? "Leave focus mode" : "Focus on the current block", hint: `${key} .`, run: toggleFocus },
    { id: "sidebar", label: panels.sidebar ? "Hide the sidebar" : "Show the sidebar", hint: `${key} \\`, run: () => togglePanel("sidebar") },
    { id: "backlinks", label: panels.backlinks ? "Hide the backlinks" : "Show the backlinks", hint: `${key} Shift \\`, run: () => togglePanel("backlinks") },
    { id: "theme", label: `Theme: ${label(theme)}, change`, run: cycleTheme },
    { id: "text", label: `Text: ${label(textFace)}, change`, run: toggleText },
    { id: "problems", label: problemsOpen ? "Hide the problems" : "Show the problems", run: toggleProblems },
    { id: "mods", label: "Show the mods", run: showMods },
  ];
}

function openPalette(): void {
  togglePalette({
    pages: () => pages,
    vocab: () => vocab,
    recent: () => recent,
    commands: commandList,
    open: (path) => void showPage(path),
  });
}

// Captured, so the editor never sees these keys: the palette, and the panels and focus.
window.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Escape" && focusMode && !paletteOpen() && !document.querySelector(".cm-tooltip-autocomplete")) {
      toggleFocus();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!document.getElementById("new-page") || e.altKey) return;
    const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (!mod) return;
    if (e.code === "KeyK" && !e.shiftKey) openPalette();
    else if (paletteOpen()) return;
    else if (e.code === "Backslash") togglePanel(e.shiftKey ? "backlinks" : "sidebar");
    else if (e.code === "Period" && !e.shiftKey) toggleFocus();
    else return;
    e.preventDefault();
    e.stopPropagation();
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
    pages: () => linkPages(pages, vocab),
    written: () => written,
    onSaved: (path: string) => {
      void refreshIndex();
      void renderBacklinks();
      registry.emit("page-saved", { path });
    },
    onOpened: (path: string) => registry.emit("page-opened", { path }),
    onTitleEdited: (path: string, from: string, to: string) => registry.emit("title-edited", { path, from, to }),
    pageMenu: (path: string) =>
      registry.pageMenuItems().map((item) => ({ label: item.label, run: () => registry.call(item.mod, item.label, () => item.run({ path })) })),
    onActive: (path: string) => {
      const card = cards.find((c) => c.path === path);
      if (card && card !== active) {
        active = card;
        renderStrip();
        void renderBacklinks();
      }
    },
    onStatus: renderStrip,
    onOpenPage: (path: string) => void showPage(path),
    onOpenConcept: (id: string) => void showPage(conceptPath(id)),
    onOpenExternal: (url: string) => void api.openExternal(url),
    livePreview: () => livePreview,
    onTogglePreview: togglePreview,
    extensions: modExtensions,
  };
}

async function closeCards(): Promise<void> {
  await Promise.all(cards.map((c) => c.flush()));
  for (const c of cards) c.destroy();
  cards = [];
  active = null;
  stackEl.replaceChildren();
  renderStrip();
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
  renderStrip();
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
  renderStrip();
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
  registry.emit("changed", { paths });
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
  const [found, contents] = await Promise.all([
    Promise.all(queries).catch(() => [] as Hit[][]), // The tool may be missing; the editor still works without backlinks.
    registry.backlinkContent(path),
  ]);
  const hits = found.flat();
  if (run !== backlinkRun) return;

  // Mentions that a mod shows in a group of its own are not listed a second time.
  const taken = new Set(contents.flatMap((c) => c.taken ?? []));
  const seen = new Set<string>();
  const byPage = new Map<string, Hit[]>();
  let claimed = 0;
  for (const hit of orderBacklinks(hits)) {
    if (hit.path === path || seen.has(hit.handle)) continue;
    seen.add(hit.handle);
    if (taken.has(hit.handle)) {
      claimed++;
      continue;
    }
    byPage.set(hit.path, [...(byPage.get(hit.path) ?? []), hit]);
  }

  const total = [...byPage.values()].reduce((n, h) => n + h.length, 0);
  const head = el("h2", { class: "title" }, `Backlinks (${total + claimed})`);
  const nodes = (first: boolean) => contents.filter((c) => !!c.first === first).map((c) => c.node as Node);
  if (total + claimed === 0 && contents.length === 0) {
    backlinksEl.replaceChildren(head, el("p", { class: "empty" }, "Nothing mentions this page yet."));
    return;
  }
  const pages = byPage.size;
  const sub =
    total === 0
      ? ""
      : el("p", { class: "sub" }, `${total === 1 ? "1 mention" : `${total} mentions`} in ${pages === 1 ? "1 page" : `${pages} pages`}`);
  const groups = [...byPage.entries()].map(([p, list]) => {
    const fromHome = list.some(isHomeHit);
    return el(
      "section",
      { class: fromHome ? "bl-group home" : "bl-group" },
      el(
        "h3",
        {},
        el("button", { onclick: () => void showPage(p) }, pageId(p)),
        fromHome ? el("span", { class: "bl-home" }, "Home") : "",
        el("span", { class: "n" }, String(list.length)),
      ),
      ...list.map((hit) => {
        const where = hitPlace(hit);
        return el(
          "button",
          { class: "hit", onclick: () => void openAt(hit) },
          where ? el("span", { class: "where" }, where) : "",
          el("span", { class: "text" }, ...renderInlineText(hit.text, (day) => void showPage(journalPath(day)))),
        );
      }),
    );
  });
  backlinksEl.replaceChildren(head, ...nodes(true), sub, ...groups, ...nodes(false));
}

/** Where in its page a hit sits: the headings above it, or what the hit is when it is not a paragraph. */
function hitPlace(hit: Hit): string {
  const trail = hit.heading_path.map((h) => h.replace(/^#+\s*/, "").trim()).filter(Boolean);
  if (hit.kind === "page") return "Page properties";
  if (hit.kind === "heading") return trail.length > 0 ? `Heading › ${trail.join(" › ")}` : "Heading";
  return trail.join(" › ");
}

/** The page a card shows or, in the journals, the card being worked in. */
function currentPath(): string | null {
  return active?.path ?? (view?.kind === "page" ? view.path : null);
}

/** A page changed place (`to`) or was deleted (`to` null): the lists and the history follow, and so does the view. */
async function pageMoved(from: string, to: string | null): Promise<void> {
  recent = relocateRecent(recent, from, to);
  saveRecent();
  places = relocate(places, from, to);
  const shown = view?.kind === "page" && view.path === from;
  await refreshIndex();
  if (shown) await (to ? showPage(to) : showJournals());
  renderNav();
  renderLists();
}

Object.assign(host, {
  toast: showNotice,
  current: currentPath,
  flush: async () => void (await Promise.all(cards.map((c) => c.flush()))),
  moved: pageMoved,
  open: showPage,
});

// A command of a mod that fails is said so; the rest of the window goes on.
registry.onFailure = (f) => {
  if (document.getElementById("notice")) showNotice(`The mod ${f.mod} failed: ${f.message}`);
};

loadMods()
  .then(start)
  .catch((e) => welcome(String(e)));
