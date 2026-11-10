// One page open for editing: its text, its status line and its autosave. The window shows
// one card for a page, or a stack of them for the journals. Each card saves on its own
// and refuses to overwrite a change it has not seen (spec §9).

import type { Api, VocabEntry } from "../shared/api";
import { formatDate } from "../shared/dates";
import type { LinkPage } from "../shared/linkFlows";
import { titleOf } from "../shared/linkFlows";
import { pageId } from "../shared/pages";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import { el } from "./dom";
import { createEditor, type EditorHandle } from "./editor";

const SAVE_DELAY_MS = 700;

export interface CardDeps {
  api: Api;
  vocab: () => VocabEntry[];
  /** The pages a link can point to, with their titles. */
  pages: () => LinkPage[];
  /** Concepts that have a page; null when the vocabulary is not known. */
  written: () => Set<string> | null;
  /** The text reached the disk. */
  onSaved: (path: string) => void;
  /** The save state of a card changed. */
  onStatus: () => void;
  /** The user started working in this card. */
  onActive: (path: string) => void;
  /** The title was clicked. */
  onOpenPage: (path: string) => void;
  onOpenConcept: (id: string) => void;
  onOpenExternal: (url: string) => void;
  /** Whether Markdown is shown rendered outside the block being edited. */
  livePreview: () => boolean;
  onTogglePreview: () => void;
  /** Extensions mods add to the editor. */
  extensions?: (path: string) => Extension[];
  /** The page was loaded into the card. */
  onOpened?: (path: string) => void;
  /** A save changed the page's title. */
  onTitleEdited?: (path: string, from: string, to: string) => void;
  /** What the menu in the head of the card offers; no menu while this is empty or absent. */
  pageMenu?: (path: string) => { label: string; run: () => void }[];
}

export interface Card {
  readonly root: HTMLElement;
  readonly path: string;
  /** The CodeMirror view of the page. */
  view(): EditorView;
  load(): Promise<void>;
  flush(): Promise<void>;
  /** Tells the card that these pages changed on disk. */
  diskChanged(paths: string[]): Promise<void>;
  focus(line?: number): void;
  /** Colours again, after the vocabulary changed. */
  refresh(): void;
  /** Whether the card is saved, being edited or in conflict, and the words that say so. */
  statusInfo(): { state: "saved" | "dirty" | "conflict"; text: string };
  /** The number of words in the page, front matter excluded. */
  words(): number;
  setLivePreview(on: boolean): void;
  destroy(): void;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** The opening of a journal day: its number large, the weekday in small capitals, its date, and a tag for today. */
function dateline(path: string, title: HTMLElement, status: HTMLElement): HTMLElement {
  const day = pageId(path).replace(/^journals\//, "");
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return el("div", { class: "pane-head" }, title, status);
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = formatDate(new Date()) === day;
  return el(
    "div",
    { class: "dateline" },
    el("span", { class: "n" }, m[3] ?? ""),
    el("span", { class: "w" }, date.toLocaleDateString("en-US", { weekday: "long" })),
    title,
    today ? el("span", { class: "today-tag" }, "Today") : "",
    status,
  );
}

/** The "⋯" button in a card's head and the menu it opens. */
function pageMenu(items: { label: string; run: () => void }[]): HTMLElement {
  const list = el("div", { class: "page-menu", hidden: true });
  const button = el("button", { class: "page-menu-button", title: "Page actions", ariaLabel: "Page actions" }, "⋯");
  const close = () => {
    list.hidden = true;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", away, true);
  };
  const away = (e: MouseEvent) => {
    if (!(e.target instanceof Node) || (!list.contains(e.target) && !button.contains(e.target))) close();
  };
  list.append(
    ...items.map((item) =>
      el("button", { class: "menu-item", onclick: () => { close(); item.run(); } }, item.label),
    ),
  );
  button.addEventListener("click", () => {
    if (!list.hidden) return close();
    list.hidden = false;
    button.setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", away, true);
  });
  return el("span", { class: "page-menu-wrap" }, button, list);
}

export function createCard(path: string, deps: CardDeps, opts: { compact?: boolean } = {}): Card {
  const { api } = deps;
  /** Hash of the file on disk when we last read or wrote it; null if it has no file yet. */
  let hash: string | null = null;
  /** The text we last read from or wrote to disk. */
  let saved = "";
  let conflict = false;
  let saveTimer: number | undefined;
  let saving: Promise<void> = Promise.resolve();
  let gone = false;
  /** The page's title as of the last time its text was read or saved. */
  let knownTitle = "";

  const title = el(
    "button",
    { class: "card-title", title: path, onclick: () => deps.onOpenPage(path) },
    pageId(path).replace(/^journals\//, ""),
  );
  const status = el("span", { class: "status" });
  const menuItems = opts.compact ? [] : (deps.pageMenu?.(path) ?? []);
  const head = menuItems.length > 0 ? el("span", { class: "head-end" }, status, pageMenu(menuItems)) : status;
  const banner = el("div", { class: "banner", hidden: true });
  const host = el("div", { class: "editor" });
  const root = el(
    "section",
    { class: `card${opts.compact ? " compact" : ""}` },
    opts.compact ? dateline(path, title, status) : el("div", { class: "pane-head" }, title, head),
    banner,
    host,
  );

  const editor: EditorHandle = createEditor(host, {
    vocab: deps.vocab,
    pages: deps.pages,
    pageDir: () => dirOf(path),
    written: deps.written,
    onChange: onEdit,
    onFocus: () => deps.onActive(path),
    onOpenConcept: deps.onOpenConcept,
    onOpenExternal: deps.onOpenExternal,
    pageName: () => pageId(path).split("/").pop() ?? "",
    livePreview: deps.livePreview(),
    onTogglePreview: deps.onTogglePreview,
    ...(deps.extensions ? { extensions: () => deps.extensions?.(path) ?? [] } : {}),
  });

  function setStatus(state: "saved" | "dirty" | "conflict", text: string): void {
    status.dataset.state = state;
    status.textContent = text;
    deps.onStatus();
  }

  function onEdit(): void {
    if (conflict) return setStatus("conflict", "Not saved: file changed on disk");
    setStatus("dirty", "Editing…");
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void flush(), SAVE_DELAY_MS);
  }

  function flush(): Promise<void> {
    window.clearTimeout(saveTimer);
    saving = saving.then(saveNow);
    return saving;
  }

  async function saveNow(): Promise<void> {
    if (conflict || gone) return;
    const text = editor.text();
    if (text === saved) return;
    // A brand-new page that was never typed in is not worth a file.
    if (hash === null && text.trim() === "") return;
    const result = await api.writePage(path, text, hash);
    if (result.ok) {
      hash = result.hash;
      saved = text;
      noteTitle(text, true);
      const now = editor.text() === text;
      setStatus(now ? "saved" : "dirty", now ? "Saved" : "Editing…");
      deps.onSaved(path);
    } else {
      showConflict();
    }
  }

  /** Remembers the title `text` gives; a change made by saving is told to the mods. */
  function noteTitle(text: string, edited: boolean): void {
    const next = titleOf(text, path);
    const from = knownTitle;
    knownTitle = next;
    if (edited && from !== "" && from !== next) deps.onTitleEdited?.(path, from, next);
  }

  function showConflict(): void {
    conflict = true;
    setStatus("conflict", "Not saved: file changed on disk");
    banner.hidden = false;
    banner.replaceChildren(
      "This page changed on disk while you were editing it.",
      el("button", { class: "load-disk", onclick: () => void reloadFromDisk() }, "Load disk version"),
      el("button", { class: "keep-mine", onclick: () => void keepMine() }, "Keep mine and overwrite"),
    );
  }

  async function reloadFromDisk(): Promise<void> {
    const file = await api.readPage(path);
    hash = file.hash;
    saved = file.text;
    noteTitle(file.text, false);
    conflict = false;
    banner.hidden = true;
    editor.setText(file.text);
    setStatus("saved", "Saved");
    deps.onSaved(path);
  }

  async function keepMine(): Promise<void> {
    const file = await api.readPage(path);
    hash = file.hash;
    conflict = false;
    banner.hidden = true;
    await flush();
  }

  return {
    root,
    path,
    async load() {
      const file = await api.readPage(path);
      hash = file.hash;
      saved = file.text;
      noteTitle(file.text, false);
      editor.setText(file.text);
      setStatus("saved", file.exists ? "Saved" : "New page");
      deps.onOpened?.(path);
    },
    flush,
    async diskChanged(paths) {
      if (!paths.includes(path) || conflict) return;
      const file = await api.readPage(path);
      if (file.hash === hash) return;
      if (editor.text() !== saved) return showConflict();
      hash = file.hash;
      saved = file.text;
      noteTitle(file.text, false);
      editor.setText(file.text);
      setStatus("saved", "Saved");
    },
    focus(line) {
      if (line !== undefined) editor.setText(editor.text(), line);
      editor.focus();
    },
    view: () => editor.view,
    refresh: () => editor.refresh(),
    statusInfo: () => ({ state: (status.dataset.state as "saved" | "dirty" | "conflict") ?? "saved", text: status.textContent ?? "" }),
    words: () => {
      const body = editor.text().replace(/^---\n[\s\S]*?\n(---|\.\.\.)[ \t]*(\n|$)/, "");
      return (body.match(/\S+/g) ?? []).length;
    },
    setLivePreview: (on) => editor.setLivePreview(on),
    destroy() {
      gone = true;
      window.clearTimeout(saveTimer);
      root.remove();
    },
  };
}

