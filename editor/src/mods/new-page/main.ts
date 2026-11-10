// The new-page mod: "New page" asks for a name and a type. The types are the bundle's templates
// (`templates/NAME.md`, `type: template`); the page is made by `tessela add NAME --type TYPE`, which
// copies the template. It takes the place of the window's own name box under the id `new-page`, so
// the sidebar button, Ctrl+N and the palette all come here. Nothing is remembered between times.

import { el } from "../../renderer/dom";
import type { ModContext } from "../../renderer/mods";
import { newPagePath, newPageTitle } from "../../shared/pages";
import { cliOf } from "../kit";
import { type PageKind, type TemplateEntry, PLAIN, kindsFrom, moveChoice } from "./plan";

export default function (ctx: ModContext): void {
  /** The types to choose from, read when the dialog opens so a template written since is there. */
  async function kinds(): Promise<PageKind[]> {
    const answer = await cliOf(ctx)<{ pages: TemplateEntry[] }>(["index", "--dir", "templates"]);
    return kindsFrom(answer.ok ? answer.pages : []);
  }

  async function create(name: string, type: string): Promise<void> {
    const path = newPagePath(name);
    if (!path) return;
    const title = newPageTitle(name);
    const argv = ["add", name.trim(), "--type", type, ...(title ? [`--title=${title}`] : [])];
    const answer = await cliOf(ctx)<{ path: string }>(argv);
    // A page that already exists is simply opened.
    if (!answer.ok && answer.error.code !== "exists") return ctx.ui.toast(`Could not create the page: ${answer.error.message}`);
    await ctx.pages.open(answer.ok ? answer.path : path);
  }

  async function ask(): Promise<void> {
    const list = await kinds();
    let chosen = PLAIN;

    const input = el("input", { class: "search" });
    input.id = "newpage-input";
    input.placeholder = "Name, e.g. project/idea";
    input.spellcheck = false;
    const error = el("p", { class: "error" });
    error.id = "newpage-error";
    error.hidden = true;
    const picker = el("div", { class: "newpage-types" });
    picker.setAttribute("role", "radiogroup");

    const rows = new Map<string, HTMLButtonElement>();
    const mark = () => {
      for (const [type, row] of rows) row.setAttribute("aria-checked", String(type === chosen));
    };
    const choose = (type: string) => {
      chosen = type;
      mark();
    };
    if (list.length > 1) {
      for (const k of list) {
        const row = el("button", { class: "newpage-type" });
        row.type = "button";
        row.setAttribute("role", "radio");
        row.append(el("span", { class: "newpage-name" }, k.label));
        if (k.description) row.append(el("span", { class: "newpage-description" }, k.description));
        row.addEventListener("click", () => {
          choose(k.type);
          input.focus();
        });
        rows.set(k.type, row);
        picker.append(row);
      }
      mark();
    }

    const body = el("div", { class: "newpage-body" });
    body.append(
      input,
      el("small", {}, "Use / for folders. Enter creates the page, Esc cancels."),
      error,
      ...(list.length > 1 ? [el("p", { class: "newpage-label" }, "Type"), picker] : []),
    );
    const dialog = ctx.ui.dialog({ title: "New page", content: body, actions: [{ id: "ok", label: "Create", primary: true, disabled: true }] });

    input.addEventListener("input", () => {
      const ok = newPagePath(input.value) !== null;
      error.hidden = ok;
      error.textContent = ok ? "" : "Give the page a name that is not empty and does not start with a dot.";
      dialog.setDisabled("ok", !ok);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      choose(moveChoice(list, chosen, e.key === "ArrowDown" ? 1 : -1));
    });

    if ((await dialog.closed) === "ok") await create(input.value, chosen);
  }

  ctx.commands.add({ id: "new-page", label: "New page", hint: /Mac/.test(navigator.userAgent) ? "⌘ N" : "Ctrl N", run: ask });
}
