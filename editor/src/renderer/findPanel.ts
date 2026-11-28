// The find box. It is drawn over the page, in the top right corner, so opening it moves no text
// (see `.cm-panels` in style.css); replace is one key (Ctrl+H) or one click away rather than always there.

import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  searchKeymap,
  setSearchQuery,
} from "@codemirror/search";
import { type Extension, Prec } from "@codemirror/state";
import { type EditorView, type Panel, type ViewUpdate, keymap, runScopeHandlers } from "@codemirror/view";

import { type Tally, countLabel, tally } from "../shared/find";
import { el } from "./dom";

const panels = new WeakMap<EditorView, FindPanel>();

class FindPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;
  private query: SearchQuery;
  private readonly searchField: HTMLInputElement;
  private readonly replaceField: HTMLInputElement;
  private readonly count: HTMLElement;
  private readonly toggles: Record<"case" | "re" | "word", HTMLButtonElement>;
  private readonly replaceToggle?: HTMLButtonElement;

  constructor(private readonly view: EditorView) {
    this.query = getSearchQuery(view.state);
    const button = (name: string, label: string, title: string, onclick: () => void, cls = "") =>
      el("button", { type: "button", name, textContent: label, title, className: `find-button ${cls}`.trim(), onclick });
    const toggle = (name: "case" | "re" | "word", label: string, title: string) => {
      const b = button(name, label, title, () => {
        b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
        this.commit();
      }, `find-toggle find-${name}`);
      b.setAttribute("aria-pressed", "false");
      return b;
    };
    this.searchField = el("input", { name: "search", placeholder: "Find", className: "cm-textfield", oninput: () => this.commit() });
    this.searchField.setAttribute("aria-label", "Find");
    this.searchField.setAttribute("main-field", "true");
    this.replaceField = el("input", { name: "replace", placeholder: "Replace with", className: "cm-textfield", oninput: () => this.commit() });
    this.replaceField.setAttribute("aria-label", "Replace with");
    this.count = el("span", { className: "find-count" });
    this.count.setAttribute("aria-live", "polite");
    this.toggles = {
      case: toggle("case", "Aa", "Match case"),
      word: toggle("word", "ab", "Whole word"),
      re: toggle("re", ".*", "Regular expression"),
    };
    const readOnly = view.state.readOnly;
    if (!readOnly) this.replaceToggle = button("replaceToggle", "", "Replace (Ctrl+H)", () => this.showReplace(!this.dom.classList.contains("with-replace")), "find-replace-toggle");
    const row = el(
      "div",
      { className: "find-row" },
      this.searchField,
      this.count,
      button("prev", "↑", "Previous match (Shift+Enter)", () => findPrevious(view)),
      button("next", "↓", "Next match (Enter)", () => findNext(view)),
      this.toggles.case,
      this.toggles.word,
      this.toggles.re,
      ...(this.replaceToggle ? [this.replaceToggle] : []),
      button("close", "×", "Close (Esc)", () => closeSearchPanel(view)),
    );
    const replaceRow = el(
      "div",
      { className: "find-row find-replace-row" },
      this.replaceField,
      button("replace", "Replace", "Replace this match (Enter)", () => replaceNext(view), "find-text"),
      button("replaceAll", "All", "Replace every match", () => replaceAll(view), "find-text"),
    );
    this.dom = el("div", { className: "cm-search", onkeydown: (e: KeyboardEvent) => this.keydown(e) }, row, ...(readOnly ? [] : [replaceRow]));
    this.setQuery(this.query);
    this.showCount();
    panels.set(view, this);
  }

  showReplace(on: boolean): void {
    this.dom.classList.toggle("with-replace", on);
    this.replaceToggle?.setAttribute("aria-expanded", String(on));
    (on ? this.replaceField : this.searchField).focus();
  }

  private commit(): void {
    const query = new SearchQuery({
      search: this.searchField.value,
      caseSensitive: this.toggles.case.getAttribute("aria-pressed") === "true",
      regexp: this.toggles.re.getAttribute("aria-pressed") === "true",
      wholeWord: this.toggles.word.getAttribute("aria-pressed") === "true",
      replace: this.replaceField.value,
    });
    if (!query.eq(this.query)) {
      this.query = query;
      this.view.dispatch({ effects: setSearchQuery.of(query) });
    }
  }

  private keydown(e: KeyboardEvent): void {
    if (runScopeHandlers(this.view, e, "search-panel")) e.preventDefault();
    else if (e.key === "Enter" && e.target === this.searchField) {
      e.preventDefault();
      (e.shiftKey ? findPrevious : findNext)(this.view);
    } else if (e.key === "Enter" && e.target === this.replaceField) {
      e.preventDefault();
      replaceNext(this.view);
    }
  }

  private setQuery(query: SearchQuery): void {
    this.query = query;
    this.searchField.value = query.search;
    this.replaceField.value = query.replace;
    this.toggles.case.setAttribute("aria-pressed", String(query.caseSensitive));
    this.toggles.re.setAttribute("aria-pressed", String(query.regexp));
    this.toggles.word.setAttribute("aria-pressed", String(query.wholeWord));
  }

  update(update: ViewUpdate): void {
    const set = update.transactions.flatMap((tr) => tr.effects.filter((e) => e.is(setSearchQuery)));
    // A query the box itself committed is already in its fields; one from elsewhere (a new selection) is not.
    if (set.some((e) => !e.value.eq(this.query))) this.setQuery(getSearchQuery(update.state));
    if (set.length || update.docChanged || update.selectionSet) this.showCount();
  }

  private showCount(): void {
    const { state } = this.view;
    const q = this.query;
    let t: Tally | null = null;
    if (q.search && q.valid) {
      const sel = state.selection.main;
      t = tally(q.getCursor(state), { from: sel.from, to: sel.to });
    }
    this.searchField.classList.toggle("invalid", !!q.search && !q.valid);
    this.count.textContent = countLabel(t);
    this.count.classList.toggle("none", t?.total === 0);
  }

  mount(): void {
    this.searchField.select();
  }

  destroy(): void {
    panels.delete(this.view);
  }
}

/** Ctrl+H: the find box with the replace row open. */
function openReplace(view: EditorView): boolean {
  if (view.state.readOnly) return false;
  openSearchPanel(view);
  panels.get(view)?.showReplace(true);
  return true;
}

/** Find, with its keys. */
export function findBox(): Extension {
  return [
    search({ top: true, createPanel: (view) => new FindPanel(view) }),
    Prec.highest(keymap.of([...searchKeymap, { key: "Mod-h", run: openReplace, scope: "editor search-panel" }, { key: "Mod-Alt-f", run: openReplace, scope: "editor search-panel" }])),
  ];
}
