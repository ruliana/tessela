// The unlinked mod: under the backlinks, the places in other pages that name the page in plain
// words (its title, an alias or a vocabulary term), each with a Link button. Linking reads the
// page, puts the link where the words are and saves it, all through `ctx.cli`, so a changed page
// is never overwritten: the save names the hash it read, and a conflict only refreshes the list.

import type { ModContext } from "../../renderer/mods";
import { cliOf } from "../kit";
import { conceptFor, countUnlinked, entriesOf, linked, type Entry, type UnlinkedHit } from "./plan";

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] =>
  Object.assign(document.createElement(tag), { textContent: text }, props);

/** How long after a save or a change on disk before the list is asked for again. */
const PAUSE = 400;

export default function (ctx: ModContext): void {
  const slot = ctx.slots.mount("side-bottom");
  const cli = cliOf(ctx);

  let run = 0;
  let timer: number | undefined;

  function clear(): void {
    slot.root.querySelector("#unlinked")?.remove();
  }

  async function link(entry: Entry): Promise<void> {
    await ctx.pages.flush();
    const page = await cli<{ exists: boolean; text: string; hash: string | null }>(["read", entry.path]);
    const next = page.ok && page.exists ? linked(page.text, entry.mention) : null;
    if (next === null || !page.ok || page.hash === null) {
      ctx.ui.toast(`${entry.path} changed, so those words are not where they were. The list is up to date again.`);
    } else {
      const saved = await cli(["save", entry.path, "--expect", page.hash], next);
      if (!saved.ok) ctx.ui.toast(`Could not link in ${entry.path}: ${saved.error.message}`);
    }
    await refresh();
  }

  function draw(entries: Entry[]): HTMLElement {
    const root = node("div", "", { id: "unlinked" });
    root.append(node("h3", countUnlinked(entries.length), { className: "unlinked-title" }));
    let page = "";
    for (const entry of entries) {
      if (entry.path !== page) {
        page = entry.path;
        const open = node("button", entry.path.replace(/\.md$/, ""));
        open.addEventListener("click", () => void ctx.pages.open(entry.path));
        root.append(node("p", "", { className: "unlinked-page" }));
        root.lastElementChild?.append(open);
      }
      const text = node("button", "", { className: "unlinked-text", title: `${entry.path}:${entry.mention.line}` });
      // The note's words go in as text, never as HTML.
      if (entry.parts) text.append(entry.parts[0], node("mark", entry.parts[1]), entry.parts[2]);
      else text.append(entry.hit.text);
      text.addEventListener("click", () => void ctx.pages.open(entry.path, entry.mention.line));
      const button = node("button", "Link", { className: "unlinked-link", title: `Write it as ${entry.mention.link}` });
      button.addEventListener("click", () => void link(entry));
      const row = node("div", "", { className: "unlinked-hit" });
      row.append(text, button);
      root.append(row);
    }
    return root;
  }

  async function refresh(): Promise<void> {
    const mine = ++run;
    const concept = conceptFor(ctx.pages.current());
    if (concept === null) return clear();
    const answer = await cli<{ hits: UnlinkedHit[] }>(["query", "--unlinked", concept, "--limit", "100"]);
    if (mine !== run) return;
    const entries = answer.ok ? entriesOf(answer.hits) : [];
    clear();
    if (entries.length > 0) slot.root.append(draw(entries));
  }

  const soon = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void refresh(), PAUSE);
  };

  ctx.events.on("page-opened", () => void refresh());
  ctx.events.on("bundle-opened", clear);
  ctx.events.on("page-saved", soon);
  ctx.events.on("changed", soon);
}
