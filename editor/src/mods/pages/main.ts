// The pages mod: rename, move and delete the page being worked on. Each shows what would happen
// first (the CLI's own dry run for rename and move, a query for the mentions of a deleted page),
// and only changes anything once the dialog is confirmed. All the changes go through `ctx.cli`.

import type { ModContext } from "../../renderer/mods";
import { changedPages, describeChange, failureText, folderOf, mentioning, nameForTitle, stemOf, type MoveAnswer } from "./plan";

type Answer<T> = ({ ok: true } & T) | { ok: false; error: { code: string; message: string } };

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] =>
  Object.assign(document.createElement(tag), { textContent: text }, props);

/** A list of pages, shortened to `limit`. Note text goes in as text, never as HTML. */
function pageList(paths: string[], limit = 8): HTMLElement {
  const list = node("ul");
  for (const p of paths.slice(0, limit)) list.append(node("li", p));
  if (paths.length > limit) list.append(node("li", `and ${paths.length - limit} more`));
  return list;
}

export default function (ctx: ModContext): void {
  const cli = <T>(argv: string[], input?: string) => ctx.cli(argv, input === undefined ? undefined : { input }) as Promise<Answer<T>>;

  /** Rename (a new name in the same folder) or move (a folder ending in `/`, or a new path). */
  async function relocate(mode: "rename" | "move", path: string, initial: string): Promise<void> {
    await ctx.pages.flush();
    const input = node("input", "", { id: "pages-name", className: "search", value: initial, spellcheck: false });
    const preview = node("div", "", { id: "pages-preview" });
    const rename = mode === "rename";
    const dialog = ctx.ui.dialog({
      title: rename ? `Rename ${path}` : `Move ${path}`,
      content: node("div", "", {}),
      actions: [{ id: "ok", label: rename ? "Rename" : "Move", primary: true, disabled: true }],
    });
    const body = document.querySelector("#dialog .dialog-body");
    body?.replaceChildren(
      node("p", rename ? "New name, in the same folder:" : "A folder ending in /, or the new path:"),
      input,
      preview,
    );
    input.focus();
    input.select();

    let run = 0;
    let timer: number | undefined;
    const check = async (): Promise<void> => {
      const mine = ++run;
      const name = input.value.trim();
      if (name === "") return void preview.replaceChildren(node("p", "Type a name."));
      preview.replaceChildren(node("p", "Looking at what would change…"));
      const answer = await cli<MoveAnswer>([mode, path, name, "--dry-run"]);
      if (mine !== run) return;
      if (!answer.ok) return void preview.replaceChildren(node("p", failureText(answer), { className: "error" }));
      preview.replaceChildren(
        node("p", `${answer.from} → ${answer.to}`),
        node("p", describeChange(answer)),
        pageList(changedPages(answer)),
        ...answer.warnings.map((w) => node("p", `Check by hand: ${w}`, { className: "error" })),
      );
      dialog.setDisabled("ok", false);
    };
    input.addEventListener("input", () => {
      run++;
      dialog.setDisabled("ok", true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void check(), 150);
    });
    void check();

    if ((await dialog.closed) !== "ok") return;
    const answer = await cli<MoveAnswer>([mode, path, input.value.trim()]);
    if (!answer.ok) return ctx.ui.toast(`Could not ${mode} the page: ${failureText(answer)}`);
    await ctx.pages.moved(answer.from, answer.to);
    ctx.ui.toast(`${rename ? "Renamed" : "Moved"} to ${answer.to}. ${describeChange(answer)}`);
  }

  async function remove(path: string): Promise<void> {
    await ctx.pages.flush();
    const id = path.replace(/\.md$/, "").toLowerCase();
    const [page, refs] = await Promise.all([
      cli<{ exists: boolean; hash: string | null }>(["read", path]),
      cli<{ hits: { path: string }[] }>(["query", "--ref", id, "--limit", "300"]),
    ]);
    if (!page.ok) return ctx.ui.toast(`Could not read the page: ${failureText(page)}`);
    if (!page.exists || !page.hash) return ctx.ui.toast(`${path} has no file yet, so there is nothing to delete.`);
    const hash = page.hash;
    const { pages, mentions } = refs.ok ? mentioning(refs.hits, path) : { pages: [], mentions: 0 };
    const preview = node("div", "", { id: "pages-preview" });
    preview.append(
      node(
        "p",
        pages.length === 0
          ? "No other page mentions it."
          : `${mentions} ${mentions === 1 ? "mention" : "mentions"} in ${pages.length} ${pages.length === 1 ? "page" : "pages"} will point to a page that is gone:`,
      ),
      pageList(pages),
    );
    const dialog = ctx.ui.dialog({
      title: `Delete ${path}?`,
      content: preview,
      actions: [{ id: "ok", label: "Delete", primary: true, danger: true }],
    });
    if ((await dialog.closed) !== "ok") return;
    const answer = await cli<{ path: string; mentioned_by: string[] }>(["remove", path, "--expect", hash]);
    if (!answer.ok) return ctx.ui.toast(`Could not delete the page: ${failureText(answer)}`);
    await ctx.pages.moved(path, null);
    ctx.ui.toast(`Deleted ${path}.`);
  }

  const withPage = (act: (path: string) => unknown) => () => {
    const path = ctx.pages.current();
    if (path) return act(path);
    ctx.ui.toast("Open a page first.");
  };
  const actions: { id: string; label: string; run: (path: string) => unknown }[] = [
    { id: "pages.rename", label: "Rename page…", run: (p) => relocate("rename", p, stemOf(p)) },
    { id: "pages.move", label: "Move page…", run: (p) => relocate("move", p, folderOf(p)) },
    { id: "pages.delete", label: "Delete page…", run: remove },
  ];
  for (const a of actions) {
    ctx.commands.add({ id: a.id, label: a.label, run: withPage(a.run) });
    ctx.slots.add("page-menu", { label: a.label, run: ({ path }) => a.run(path) });
  }

  // A page whose title was edited may want its file named after it.
  ctx.events.on("title-edited", ({ path, to }) => {
    if (path.startsWith("journals/")) return;
    const name = nameForTitle(to);
    if (!name || name === stemOf(path)) return;
    ctx.ui.toast(`Rename the file to ${name}?`, { label: "Rename…", run: () => void relocate("rename", path, name) });
  });
}
