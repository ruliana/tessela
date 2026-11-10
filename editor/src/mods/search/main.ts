// The search mod: takes over the search under the sidebar's search box (the `search` override).
// What is typed is read as words in any order, "quoted phrases" and filters (#tag, type:, in:,
// dates), turned into one `tessela query`, and the command is shown, so what the window finds is
// what an agent finds with the same words. "Keep as live list" puts the command in the open page as
// a ```tessela fence. Titles and headings are searched with the text; a page hit opens the page.

import type { ModContext } from "../../renderer/mods";
import { el } from "../../renderer/dom";
import type { Hit } from "../../shared/api";
import { pageId } from "../../shared/pages";
import { excerpt } from "../../shared/search";
import { commandLine, focusOf, nameFilter, parseSearch, queryArgs, searchable } from "./plan";

const LIMIT = 40;

type Answer = { ok: true; hits: Hit[] } | { ok: false; error: { message: string } };

export default function (ctx: ModContext): void {
  async function run({ input, results, stale }: { input: string; results: HTMLElement; stale: () => boolean }): Promise<boolean> {
    const plan = parseSearch(input);
    if (!searchable(plan)) return false;
    const args = queryArgs(plan);
    let answer: Answer;
    try {
      answer = (await ctx.cli(["query", ...args, "--limit", String(LIMIT)])) as Answer;
    } catch (e) {
      answer = { ok: false, error: { message: e instanceof Error ? e.message : String(e) } };
    }
    if (stale()) return true;
    const hits = answer.ok ? answer.hits : [];
    const text = plan.phrases.length + plan.words.length > 0;
    const point = focusOf(plan);
    const keep = el(
      "button",
      {
        class: "link",
        id: "search-keep",
        title: "Put this search in the page as a list that stays up to date",
        onclick: () => {
          if (!ctx.pages.insert(`\`\`\`tessela\n${commandLine(args)}\n\`\`\`\n`, { block: true })) ctx.ui.toast("Open a page to keep the search in.");
        },
      },
      "Keep as live list",
    );
    results.dataset.for = input;
    results.replaceChildren(
      el("h2", {}, hits.length === 0 ? (text ? "Not in any text" : "Nothing found") : text ? "In the text" : "Found"),
      ...(answer.ok ? [] : [el("p", { class: "error" }, answer.error.message)]),
      el("div", { class: "search-command", id: "search-command-row" }, el("code", { id: "search-command" }, `tessela ${commandLine(args)}`), keep),
      ...hits.map((hit) =>
        el(
          "button",
          { class: "hit", onclick: () => void ctx.pages.open(hit.path, hit.kind === "page" ? undefined : hit.line) },
          el("span", { class: "kind" }, pageId(hit.path)),
          excerpt(hit.text, point),
        ),
      ),
    );
    return true;
  }

  ctx.override.add("search", { run, names: nameFilter });
}
