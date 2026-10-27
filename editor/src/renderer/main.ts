// The window: sidebar, editor and backlinks. All file access goes through `window.tessela`.

import "./style.css";

import type { Hit, PageEntry, VocabEntry } from "../shared/api";
import { conceptPath, isJournalPath, pageId } from "../shared/pages";
import { createEditor, type EditorHandle } from "./editor";

const api = window.tessela;
const SAVE_DELAY_MS = 700;

interface Current {
  path: string;
  /** Hash of the file on disk when we last read or wrote it; null if it has no file yet. */
  hash: string | null;
  /** The text we last read from or wrote to disk. */
  saved: string;
  conflict: boolean;
}

let current: Current | null = null;
let pages: PageEntry[] = [];
let vocab: VocabEntry[] = [];
let filter = "";
let editor: EditorHandle | null = null;
let saveTimer: number | undefined;
let saving: Promise<void> = Promise.resolve();

const app = document.getElementById("app") as HTMLElement;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const { class: cls, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (cls) node.className = cls;
  node.append(...children);
  return node;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

// ---- start -----------------------------------------------------------------

async function start(): Promise<void> {
  const bundle = await api.bundle();
  if (!bundle) return welcome();
  buildShell(bundle);
  api.onChanged((paths) => void onChanged(paths));
  await refreshIndex();
  await open(await api.todayPath());
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
let backlinksEl: HTMLElement;
let pathEl: HTMLElement;
let statusEl: HTMLElement;
let bannerEl: HTMLElement;

function buildShell(bundle: string): void {
  const search = el("input", {
    class: "search",
    id: "search",
    placeholder: "Find or create a page…",
    oninput: () => {
      filter = search.value;
      renderLists();
    },
    onkeydown: (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !filter.trim()) return;
      const path = conceptPath(filter.trim());
      search.value = filter = "";
      void open(path);
    },
  });
  journalsEl = el("ul", { class: "list", id: "journals" });
  listEl = el("ul", { class: "list", id: "pages" });
  const sidebar = el(
    "aside",
    { class: "sidebar" },
    el("div", { class: "brand" }, "Tessela", el("small", { title: bundle }, bundle.split("/").pop() ?? bundle)),
    el(
      "button",
      { class: "primary", id: "today", onclick: async () => open(await api.todayPath()) },
      "Today",
    ),
    search,
    journalsEl,
    listEl,
  );

  pathEl = el("span", { class: "path" });
  statusEl = el("span", { class: "status" });
  bannerEl = el("div", { class: "banner", hidden: true });
  const host = el("div", { class: "editor", id: "editor" });
  const pane = el(
    "main",
    { class: "pane" },
    el("div", { class: "pane-head" }, pathEl, statusEl),
    bannerEl,
    host,
  );

  backlinksEl = el("aside", { class: "backlinks", id: "backlinks" });
  app.replaceChildren(el("div", { class: "shell" }, sidebar, pane, backlinksEl));

  editor = createEditor(host, {
    vocab: () => vocab,
    pageDir: () => dirOf(current?.path ?? ""),
    onChange: onEdit,
    onOpenConcept: (id) => void open(conceptPath(id)),
  });
}

function renderLists(): void {
  const q = filter.trim().toLowerCase();
  const item = (label: string, path: string, count?: number, unwritten = false) => {
    const button = el(
      "button",
      { onclick: () => void open(path) },
      el("span", { class: "name" }, label),
      count === undefined ? "" : el("span", { class: "count" }, String(count)),
    );
    if (current?.path === path) button.setAttribute("aria-current", "page");
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

function setStatus(state: "saved" | "dirty" | "conflict" | "error", text: string): void {
  statusEl.dataset.state = state;
  statusEl.textContent = text;
}

async function refreshIndex(): Promise<void> {
  [pages, vocab] = await Promise.all([api.listPages(), api.vocab().catch(() => [])]);
  renderLists();
}

// ---- opening and saving ----------------------------------------------------

async function open(path: string): Promise<void> {
  await flush();
  const file = await api.readPage(path);
  current = { path, hash: file.hash, saved: file.text, conflict: false };
  pathEl.textContent = path;
  bannerEl.hidden = true;
  editor?.setText(file.text);
  editor?.focus();
  setStatus("saved", file.exists ? "Saved" : "New page");
  renderLists();
  await renderBacklinks();
}

function onEdit(text: string): void {
  if (!current) return;
  if (current.conflict) return setStatus("conflict", "Not saved: file changed on disk");
  setStatus("dirty", "Editing…");
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void flush(), SAVE_DELAY_MS);
}

/** Writes pending changes now. Waits for a save already in flight. */
function flush(): Promise<void> {
  window.clearTimeout(saveTimer);
  saving = saving.then(saveNow);
  return saving;
}

async function saveNow(): Promise<void> {
  const page = current;
  if (!page || page.conflict || !editor) return;
  const text = editor.text();
  if (text === page.saved) return;
  // A brand-new page that was never typed in is not worth a file.
  if (page.hash === null && text.trim() === "") return;
  const result = await api.writePage(page.path, text, page.hash);
  if (current !== page) return;
  if (result.ok) {
    page.hash = result.hash;
    page.saved = text;
    setStatus(editor.text() === text ? "saved" : "dirty", editor.text() === text ? "Saved" : "Editing…");
    void refreshIndex();
    void renderBacklinks();
  } else {
    showConflict(page);
  }
}

function showConflict(page: Current): void {
  page.conflict = true;
  setStatus("conflict", "Not saved: file changed on disk");
  bannerEl.hidden = false;
  bannerEl.replaceChildren(
    "This page changed on disk while you were editing it.",
    el("button", { id: "load-disk", onclick: () => void reloadFromDisk() }, "Load disk version"),
    el("button", { id: "keep-mine", onclick: () => void keepMine() }, "Keep mine and overwrite"),
  );
}

async function reloadFromDisk(): Promise<void> {
  if (!current) return;
  const file = await api.readPage(current.path);
  current = { path: current.path, hash: file.hash, saved: file.text, conflict: false };
  bannerEl.hidden = true;
  editor?.setText(file.text);
  setStatus("saved", "Saved");
  await renderBacklinks();
}

async function keepMine(): Promise<void> {
  if (!current || !editor) return;
  const file = await api.readPage(current.path);
  current.hash = file.hash;
  current.conflict = false;
  bannerEl.hidden = true;
  await flush();
}

async function onChanged(paths: string[]): Promise<void> {
  void refreshIndex();
  if (!current) return;
  if (paths.includes(current.path)) {
    const file = await api.readPage(current.path);
    if (file.hash !== current.hash && current && !current.conflict) {
      const dirty = editor !== null && editor.text() !== current.saved;
      if (dirty) {
        showConflict(current);
      } else {
        current.hash = file.hash;
        current.saved = file.text;
        editor?.setText(file.text);
        setStatus("saved", "Saved");
      }
    }
  }
  await renderBacklinks();
}

// ---- backlinks -------------------------------------------------------------

let backlinkRun = 0;

async function renderBacklinks(): Promise<void> {
  if (!current) return;
  const run = ++backlinkRun;
  const path = current.path;
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
      el("h3", {}, el("button", { onclick: () => void open(p) }, pageId(p))),
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

async function openAt(hit: Hit): Promise<void> {
  await open(hit.path);
  editor?.setText(editor.text(), hit.line);
}

start().catch((e) => welcome(String(e)));
