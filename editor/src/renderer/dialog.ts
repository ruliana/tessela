// The dialog mods share (ctx.ui.dialog): a title, what the mod puts in it, and buttons. One at a
// time; Escape or a click outside closes it, Enter in a text box presses the main button.

import { el } from "./dom";

export interface DialogAction {
  /** What `closed` resolves to when this button is pressed. */
  id: string;
  label: string;
  /** The button Enter presses. */
  primary?: boolean;
  /** Marks a button that destroys something. */
  danger?: boolean;
  disabled?: boolean;
}

export interface DialogOptions {
  title: string;
  /** What goes in the dialog: a mod builds it (an input, a preview) and keeps hold of it. */
  content: Node | string;
  /** The buttons; a Cancel is added when none has the id "cancel". */
  actions: DialogAction[];
}

export interface Dialog {
  /** The id of the button pressed, or null when the dialog was dismissed. */
  readonly closed: Promise<string | null>;
  setDisabled(id: string, disabled: boolean): void;
  close(id?: string | null): void;
}

let current: Dialog | null = null;

export function openDialog(options: DialogOptions): Dialog {
  current?.close(null);
  const actions = options.actions.some((a) => a.id === "cancel") ? options.actions : [{ id: "cancel", label: "Cancel" }, ...options.actions];
  let finish: (id: string | null) => void = () => {};
  const closed = new Promise<string | null>((resolve) => (finish = resolve));
  const buttons = new Map<string, HTMLButtonElement>();
  const bar = el("div", { class: "dialog-actions" });
  for (const a of actions) {
    const button = el("button", { class: a.primary ? (a.danger ? "primary danger" : "primary") : "secondary", disabled: a.disabled ?? false }, a.label);
    button.setAttribute("data-action", a.id === "cancel" ? "cancel" : a.id);
    button.addEventListener("click", () => dialog.close(a.id));
    buttons.set(a.id, button);
    bar.append(button);
  }
  const box = el("div", { class: "dialog-box", role: "dialog" }, el("h2", { class: "dialog-title" }, options.title), el("div", { class: "dialog-body" }, options.content), bar);
  box.setAttribute("aria-modal", "true");
  const overlay = el("div", { class: "dialog", id: "dialog" }, box);

  const primary = actions.find((a) => a.primary);
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dialog.close(null);
    } else if (e.key === "Enter" && primary && e.target instanceof HTMLInputElement) {
      e.preventDefault();
      if (!buttons.get(primary.id)?.disabled) dialog.close(primary.id);
    }
  });
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) dialog.close(null);
  });

  const dialog: Dialog = {
    closed,
    setDisabled: (id, disabled) => {
      const button = buttons.get(id);
      if (button) button.disabled = disabled;
    },
    close(id = null) {
      if (current !== dialog) return;
      current = null;
      overlay.remove();
      finish(id);
    },
  };
  current = dialog;
  document.body.append(overlay);
  (box.querySelector("input, textarea") as HTMLElement | null)?.focus();
  if (!box.querySelector("input, textarea")) (primary ? buttons.get(primary.id) : buttons.get("cancel"))?.focus();
  return dialog;
}
