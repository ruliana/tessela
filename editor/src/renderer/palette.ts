// The command palette: one box to go to a page, make a page, or run a command.

import type { PageEntry, VocabEntry } from "../shared/api";
import { candidates, rank, score } from "../shared/palette";
import { conceptPath, pageId } from "../shared/pages";
import { el } from "./dom";

export interface Command {
  id: string;
  label: string;
  /** The keys that do the same, shown at the right. */
  hint?: string;
  run: () => void;
}

export interface PaletteDeps {
  pages: () => PageEntry[];
  vocab: () => VocabEntry[];
  /** Pages used lately, most recent first. */
  recent: () => string[];
  commands: () => Command[];
  /** A page was picked or created by name. */
  open: (path: string) => void;
}

interface Item {
  group: "Pages" | "Commands";
  glyph: string;
  label: string;
  note?: string;
  hint?: string;
  run: () => void;
}

const PAGE_LIMIT = 8;
const COMMAND_LIMIT = 7;

let current: { close: () => void } | null = null;

export function paletteOpen(): boolean {
  return current !== null;
}

function closePalette(): void {
  current?.close();
}

/** Shows the palette over the window. Asking again closes it. */
export function togglePalette(deps: PaletteDeps): void {
  if (current) return closePalette();
  const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let items: Item[] = [];
  let at = 0;

  const input = el("input", {
    id: "palette-input",
    type: "text",
    placeholder: "Go to a page, create one, or run a command…",
    autocomplete: "off",
    spellcheck: false,
  });
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-controls", "palette-list");
  input.setAttribute("aria-expanded", "true");
  const list = el("ul", { id: "palette-list", class: "palette-list" });
  list.setAttribute("role", "listbox");
  const box = el("div", { class: "palette-box" }, el("div", { class: "palette-in" }, input), list);
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", "Command palette");
  const overlay = el("div", { class: "palette", id: "palette" }, box);

  function close(): void {
    overlay.remove();
    current = null;
    window.removeEventListener("keydown", onKey, true);
    returnTo?.focus();
  }

  function build(): Item[] {
    const query = input.value;
    const q = query.trim();
    const all = candidates(deps.pages(), deps.vocab());
    const pageItem = (c: { label: string; path: string; unwritten: boolean }): Item => ({
      group: "Pages",
      glyph: c.unwritten ? "#" : c.path.startsWith("journals/") ? "◷" : "¶",
      label: c.label,
      note: c.unwritten ? "not written yet" : undefined,
      run: () => deps.open(c.path),
    });
    let pages: Item[];
    if (q === "") {
      const byPath = new Map(all.map((c) => [c.path, c]));
      pages = deps
        .recent()
        .slice(0, PAGE_LIMIT)
        .map((p) => byPath.get(p) ?? { label: pageId(p), path: p, unwritten: false })
        .map(pageItem);
    } else {
      pages = rank(all, q, PAGE_LIMIT).map(pageItem);
      const path = conceptPath(q);
      if (path !== ".md" && !all.some((c) => c.path === path)) {
        pages.push({ group: "Pages", glyph: "+", label: `Create “${q}”`, hint: "Enter creates", run: () => deps.open(path) });
      }
    }
    const commands: Item[] = rank(deps.commands(), q, COMMAND_LIMIT).map((c) => ({
      group: "Commands",
      glyph: "›",
      label: c.label,
      hint: c.hint,
      run: c.run,
    }));
    // A command that matches the typed words better than any page comes first, so that
    // "hide the sidebar" and Enter does that, not "Create a page with that name".
    const bestPage = Math.max(0, ...pages.filter((p) => !p.label.startsWith("Create")).map((p) => score(p.label, q) ?? 0));
    const bestCommand = commands[0] ? (score(commands[0].label, q) ?? 0) : 0;
    if (q !== "" && bestCommand >= 40 && bestCommand > bestPage) return [...commands, ...pages];
    return [...pages, ...commands];
  }

  function draw(): void {
    items = build();
    at = Math.min(at, Math.max(0, items.length - 1));
    const rows: HTMLElement[] = [];
    let group = "";
    items.forEach((item, i) => {
      if (item.group !== group) {
        group = item.group;
        rows.push(el("li", { class: "palette-group", role: "presentation" }, group));
      }
      const row = el(
        "li",
        { class: "palette-item", id: `palette-item-${i}` },
        el("span", { class: "g" }, item.glyph),
        el("span", { class: "t" }, item.label),
        item.note ? el("span", { class: "note" }, item.note) : "",
        item.hint ? el("span", { class: "k" }, item.hint) : "",
      );
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(i === at));
      row.addEventListener("mousemove", () => select(i));
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        choose(i);
      });
      rows.push(row);
    });
    if (items.length === 0) rows.push(el("li", { class: "palette-empty" }, "Nothing matches."));
    list.replaceChildren(...rows);
    input.setAttribute("aria-activedescendant", items.length ? `palette-item-${at}` : "");
  }

  function select(i: number): void {
    if (i === at || i < 0 || i >= items.length) return;
    at = i;
    for (const [n, row] of [...list.querySelectorAll(".palette-item")].entries()) {
      row.setAttribute("aria-selected", String(n === at));
      if (n === at) row.scrollIntoView({ block: "nearest" });
    }
    input.setAttribute("aria-activedescendant", `palette-item-${at}`);
  }

  function choose(i: number): void {
    const item = items[i];
    if (!item) return;
    close();
    item.run();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      select((at + 1) % Math.max(items.length, 1));
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      select((at - 1 + items.length) % Math.max(items.length, 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      choose(at);
    } else if (e.key === "Tab") {
      e.preventDefault();
    }
  }

  input.addEventListener("input", () => {
    at = 0;
    draw();
  });
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  // Captured, so the editor behind never sees the keys.
  window.addEventListener("keydown", onKey, true);
  document.body.append(overlay);
  current = { close };
  draw();
  input.focus();
}
