// The live-lists mod: a code fence with the info string `tessela` holds a read-only `tessela`
// command (and filters); the editor draws the rows under it and never writes them into the page.
// `tessela fence` runs the body, the same way an agent would run it.

import { el } from "../../renderer/dom";
import type { ModContext } from "../../renderer/mods";
import { type ListView, listOf } from "./list";

export default function (ctx: ModContext): void {
  const draw = (view: ListView): HTMLElement => {
    if (view.kind === "error") return el("div", { class: "tessela-error" }, view.message);
    if (view.kind === "empty") return el("div", { class: "tessela-empty" }, "No rows.");
    const list = el("div", { class: "tessela-rows" });
    for (const row of view.rows) {
      const item = el("div", { class: row.open ? "tessela-row tessela-link" : "tessela-row" }, row.text);
      const { open } = row;
      if (open) item.addEventListener("click", () => void ctx.pages.open(open.path, open.line));
      list.append(item);
    }
    if (view.more > 0) list.append(el("div", { class: "tessela-empty" }, `and ${view.more} more`));
    return list;
  };

  ctx.fences.add("tessela", async ({ body }) => draw(listOf(await ctx.cli(["fence"], { input: body }))));

  ctx.slash.add({
    label: "Live list",
    detail: "a ```tessela fence",
    text: "```tessela\nquery --ref \n```",
    cursor: "```tessela\nquery --ref ".length,
    where: "line",
  });
}
