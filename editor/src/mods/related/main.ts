// The related mod: in place of a graph, a group in the right column that explains how the open page
// sits among the others. It lists the concepts mentioned together with it, most often first, each
// with the reason `tessela related` gives, and the home pages that lead to it, the root's first.
// Everything comes from the tool when asked and nothing is written; note text goes in as text.

import { el } from "../../renderer/dom";
import type { ModContext } from "../../renderer/mods";
import { cliOf } from "../kit";
import { type Related, conceptFor, homeLabel, isEmpty, togetherRows, trailOf } from "./plan";

export default function (ctx: ModContext): void {
  ctx.backlinks.add(async ({ path }) => {
    const concept = conceptFor(path);
    if (concept === null) return null;
    const answer = await cliOf(ctx)<Related>(["related", concept, "--limit", "8"]);
    if (!answer.ok || isEmpty(answer)) return null;

    const rows = togetherRows(answer).map((t) => {
      const name = t.page
        ? el("button", { class: "related-name", type: "button", title: `Open ${t.page.path}`, onclick: () => void ctx.pages.open(t.page!.path) }, t.page.title)
        : el("span", { class: "related-name" }, t.concept);
      return el("div", { class: `related-item${t.page ? "" : " nopage"}` }, name, el("span", { class: "related-reason" }, t.reason));
    });
    const trail = trailOf(answer).map((h) =>
      el("button", { class: "related-home", type: "button", title: `Open ${h.path}`, onclick: () => void ctx.pages.open(h.path) }, homeLabel(h.path)),
    );
    const group = el(
      "section",
      { class: "bl-group related" },
      el("h3", {}, "Related", ...(rows.length > 0 ? [el("span", { class: "n" }, String(rows.length))] : [])),
      ...(trail.length > 0 ? [el("div", { class: "related-chain" }, ...trail)] : []),
      ...rows,
    );
    return { node: group };
  });
}
