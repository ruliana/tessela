// The live-lists mod: a code fence with the info string `tessela` holds a read-only `tessela`
// command (and filters); the editor draws the rows under it and never writes them into the page.
// `tessela fence` runs the body, the same way an agent would run it.

import type { ModContext } from "../../renderer/mods";
import { type ListView, listOf } from "./list";

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] =>
  Object.assign(document.createElement(tag), { className, textContent: text });

export default function (ctx: ModContext): void {
  const draw = (view: ListView): HTMLElement => {
    if (view.kind === "error") return node("div", "tessela-error", view.message);
    if (view.kind === "empty") return node("div", "tessela-empty", "No rows.");
    const list = node("div", "tessela-rows");
    for (const row of view.rows) {
      const el = node("div", row.open ? "tessela-row tessela-link" : "tessela-row", row.text);
      const { open } = row;
      if (open) el.addEventListener("click", () => void ctx.pages.open(open.path, open.line));
      list.append(el);
    }
    if (view.more > 0) list.append(node("div", "tessela-empty", `and ${view.more} more`));
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
