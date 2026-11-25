// Drawers: the groups of the sidebar. A head with a button folds the drawer to that head; which
// drawers are folded is the window's (it survives a restart), never the notes'.

import { el } from "./dom";

const KEY = "tessela.drawers";

function folded(): Record<string, boolean> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return saved && typeof saved === "object" ? (saved as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function remember(id: string, value: boolean): void {
  try {
    const all = folded();
    if (value) all[id] = true;
    else delete all[id];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // The choice just is not remembered.
  }
}

/**
 * Makes `section` a drawer: the button in front of `title` (the `h2` of `head`) folds everything in
 * `section` but `head`. `id` names it in what is remembered; the section's other children are its body.
 */
export function foldable(section: HTMLElement, head: HTMLElement, title: HTMLElement, id: string): void {
  section.classList.add("drawer");
  head.classList.add("drawer-head");
  const name = title.textContent ?? id;
  const button = el("button", { class: "drawer-toggle", type: "button" }, name);
  title.replaceChildren(button);
  const set = (value: boolean, keep = true): void => {
    section.dataset.folded = value ? "1" : "0";
    button.setAttribute("aria-expanded", String(!value));
    button.title = value ? `Open ${name}` : `Fold ${name}`;
    if (keep) remember(id, value);
  };
  button.onclick = () => set(section.dataset.folded !== "1");
  set(folded()[id] === true, false);
}

/** A new drawer with its own head (`title`, and `aside` after it) and a body to fill. */
export function drawer(id: string, title: string, aside?: Node): { root: HTMLElement; body: HTMLElement } {
  const h2 = el("h2", {}, title);
  const head = el("div", { class: "group-head" }, h2, ...(aside ? [aside] : []));
  const body = el("div", { class: "drawer-body" });
  const root = el("section", { class: "group" }, head, body);
  foldable(root, head, h2, id);
  return { root, body };
}
