// One page open for editing: its text, its status line and its autosave. The window shows
// one card for a page, or a stack of them for the journals. Each card saves on its own
// and refuses to overwrite a change it has not seen (spec §9).

import type { Api, VocabEntry } from "../shared/api";
import { pageId } from "../shared/pages";
import { el } from "./dom";
import { createEditor, type EditorHandle } from "./editor";

const SAVE_DELAY_MS = 700;

export interface CardDeps {
  api: Api;
  vocab: () => VocabEntry[];
  /** Concepts that have a page; null when the vocabulary is not known. */
  written: () => Set<string> | null;
  /** The text reached the disk. */
  onSaved: (path: string) => void;
  /** The user started working in this card. */
  onActive: (path: string) => void;
  /** The title was clicked. */
  onOpenPage: (path: string) => void;
  onOpenConcept: (id: string) => void;
  /** Whether Markdown is shown rendered outside the block being edited. */
  livePreview: () => boolean;
  onTogglePreview: () => void;
}

export interface Card {
  readonly root: HTMLElement;
  readonly path: string;
  load(): Promise<void>;
  flush(): Promise<void>;
  /** Tells the card that these pages changed on disk. */
  diskChanged(paths: string[]): Promise<void>;
  focus(line?: number): void;
  /** Colours again, after the vocabulary changed. */
  refresh(): void;
  setLivePreview(on: boolean): void;
  destroy(): void;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
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

  const title = el(
    "button",
    { class: "card-title", title: path, onclick: () => deps.onOpenPage(path) },
    pageId(path).replace(/^journals\//, ""),
  );
  const status = el("span", { class: "status" });
  const banner = el("div", { class: "banner", hidden: true });
  const host = el("div", { class: "editor" });
  const root = el(
    "section",
    { class: `card${opts.compact ? " compact" : ""}` },
    el("div", { class: "pane-head" }, title, status),
    banner,
    host,
  );

  const editor: EditorHandle = createEditor(host, {
    vocab: deps.vocab,
    pageDir: () => dirOf(path),
    written: deps.written,
    onChange: onEdit,
    onFocus: () => deps.onActive(path),
    onOpenConcept: deps.onOpenConcept,
    livePreview: deps.livePreview(),
    onTogglePreview: deps.onTogglePreview,
  });

  function setStatus(state: "saved" | "dirty" | "conflict", text: string): void {
    status.dataset.state = state;
    status.textContent = text;
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
      const now = editor.text() === text;
      setStatus(now ? "saved" : "dirty", now ? "Saved" : "Editing…");
      deps.onSaved(path);
    } else {
      showConflict();
    }
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
      editor.setText(file.text);
      setStatus("saved", file.exists ? "Saved" : "New page");
    },
    flush,
    async diskChanged(paths) {
      if (!paths.includes(path) || conflict) return;
      const file = await api.readPage(path);
      if (file.hash === hash) return;
      if (editor.text() !== saved) return showConflict();
      hash = file.hash;
      saved = file.text;
      editor.setText(file.text);
      setStatus("saved", "Saved");
    },
    focus(line) {
      if (line !== undefined) editor.setText(editor.text(), line);
      editor.focus();
    },
    refresh: () => editor.refresh(),
    setLivePreview: (on) => editor.setLivePreview(on),
    destroy() {
      gone = true;
      window.clearTimeout(saveTimer);
      root.remove();
    },
  };
}

