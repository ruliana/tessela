// The favorites mod: pages marked as favorites are listed in the sidebar, above the recent pages.
// A page is marked from the palette, with Ctrl/Cmd+Alt+F or from its menu, and unmarked by the star
// beside it in the list. A mark is the window's, not the page's: it is kept in this mod's settings by
// notes folder, so nothing is written to the notes. It follows a page that was renamed or moved
// through the editor and goes when the page is deleted there; a page removed by someone else is hidden.

import { el } from "../../renderer/dom";
import type { ModContext } from "../../renderer/mods";
import { pageId } from "../../shared/pages";
import { cliOf } from "../kit";
import { followed, present, readList, toggled } from "./plan";

export default function (ctx: ModContext): void {
  const cli = cliOf(ctx);
  const slot = ctx.slots.mount("sidebar");
  const section = el("section", { class: "group", id: "favorites" });
  slot.root.append(section);
  let run = 0;

  /** The folder's list lives under its own name, so two notes folders do not share marks. */
  async function listOf(): Promise<{ bundle: string; list: string[] } | null> {
    const bundle = await ctx.bundle();
    if (bundle === null) return null;
    const all = ctx.settings.get("favorites");
    const saved = all && typeof all === "object" && !Array.isArray(all) ? (all as Record<string, unknown>)[bundle] : undefined;
    return { bundle, list: readList(saved) };
  }

  function keep(bundle: string, list: string[]): void {
    const all = ctx.settings.get("favorites");
    const others = all && typeof all === "object" && !Array.isArray(all) ? (all as Record<string, unknown>) : {};
    ctx.settings.set("favorites", { ...others, [bundle]: list });
  }

  async function change(update: (list: string[]) => string[]): Promise<void> {
    const here = await listOf();
    if (!here) return;
    keep(here.bundle, update(here.list));
    await draw();
  }

  async function draw(): Promise<void> {
    const mine = ++run;
    const here = await listOf();
    const pages = await cli<{ pages: { path: string }[] }>(["pages"]);
    if (mine !== run) return;
    const shown = here && pages.ok ? present(here.list, pages.pages.map((p) => p.path)) : [];
    const current = ctx.pages.current();
    const rows = shown.map((path) => {
      const open = el(
        "button",
        { class: "fav-open", title: path, onclick: () => void ctx.pages.open(path) },
        el("span", { class: "name" }, pageId(path)),
      );
      if (path === current) open.setAttribute("aria-current", "page");
      const off = el("button", { class: "fav-off", title: "Remove from favorites", ariaLabel: `Remove ${pageId(path)} from favorites`, onclick: () => void change((l) => toggled(l, path)) }, "★");
      return el("li", {}, open, off);
    });
    section.hidden = rows.length === 0;
    section.replaceChildren(...(rows.length === 0 ? [] : [el("div", { class: "group-head" }, el("h2", {}, "Favorites")), el("ul", { class: "list" }, ...rows)]));
  }

  async function toggle(): Promise<void> {
    const path = ctx.pages.current();
    if (!path) return ctx.ui.toast("Open a page first.");
    const here = await listOf();
    if (!here) return;
    const marked = here.list.includes(path);
    await change((list) => toggled(list, path));
    ctx.ui.toast(marked ? `Removed ${pageId(path)} from favorites.` : `Added ${pageId(path)} to favorites.`);
  }

  ctx.commands.add({ id: "favorites.toggle", label: "Toggle favorite", hint: navigator.userAgent.includes("Mac") ? "⌘ Alt F" : "Ctrl Alt F", keys: "Mod-Alt-f", run: () => toggle() });
  ctx.slots.add("page-menu", { label: "Toggle favorite", run: () => toggle() });

  ctx.events.on("page-moved", ({ from, to }) => change((list) => followed(list, from, to)));
  for (const name of ["page-opened", "changed", "bundle-opened"] as const) ctx.events.on(name, () => void draw());
  void draw();
}
