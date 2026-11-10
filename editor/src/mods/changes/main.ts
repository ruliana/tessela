// The changes mod: what differs between the notes and an earlier state in git (the last commit by
// default), block by block, from `tessela changes`. Each change is kept (hidden; nothing is written,
// the mark is the window's own) or put back (the page is written again without it, through the CLI).
// A page that is new can be deleted and one that was deleted written again, each page as a whole.
// Everything is read and written through `ctx.cli`; note text goes in as text, never as HTML.

import type { ModContext } from "../../renderer/mods";
import { type Change, type ChangesAnswer, type PageChange, keptKey, putBack, remember, restoredPage, summary } from "./plan";

type Answer<T> = ({ ok: true } & T) | { ok: false; error: { code: string; message: string } };

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] =>
  Object.assign(document.createElement(tag), { className, textContent: text });

const MARKS = { added: "+", removed: "−", changed: "~" } as const;

export default function (ctx: ModContext): void {
  const cli = <T>(argv: string[], input?: string) => ctx.cli(argv, input === undefined ? undefined : { input }) as Promise<Answer<T>>;
  const failure = (a: { ok: false; error: { message: string } }) => a.error.message;

  const keptNow = (): string[] => {
    const saved = ctx.settings.get("kept");
    return Array.isArray(saved) ? saved.filter((k): k is string => typeof k === "string") : [];
  };
  let showKept = false;
  /** Draws the view again where it is (a change was written, kept or the list moved on). */
  let redraw: () => Promise<void> = async () => {};

  const button = (className: string, text: string, run: () => void, title?: string): HTMLButtonElement => {
    const b = node("button", className, text);
    if (title) b.title = title;
    b.addEventListener("click", run);
    return b;
  };

  const keep = (keys: string[]): void => {
    ctx.settings.set("kept", remember(keptNow(), ...keys));
    void redraw();
  };

  /** One block put back: the page is read again, so a page edited since the list was drawn is not overwritten. */
  async function revert(path: string, change: Change): Promise<void> {
    await ctx.pages.flush();
    const page = await cli<{ exists: boolean; text: string; hash: string | null }>(["read", path]);
    if (!page.ok) return ctx.ui.toast(`Could not read ${path}: ${failure(page)}`);
    const next = page.exists && page.hash ? putBack(page.text, change) : null;
    if (next === null || !page.hash) {
      ctx.ui.toast(`${path} has changed since this list was drawn. The list is drawn again.`);
      return redraw();
    }
    const saved = await cli<object>(["save", path, "--expect", page.hash], next);
    if (!saved.ok) ctx.ui.toast(`Could not put the change back: ${failure(saved)}`);
    await redraw();
  }

  /** A deleted page written again from what was removed. */
  async function restore(page: PageChange): Promise<void> {
    const text = restoredPage(page);
    if (text === null) return ctx.ui.toast(`There is nothing to write ${page.path} from.`);
    const saved = await cli<object>(["save", page.path, "--expect", "new"], text);
    if (!saved.ok) ctx.ui.toast(`Could not write ${page.path} again: ${failure(saved)}`);
    await redraw();
  }

  /** A page that is new, deleted after the dialog says what goes. */
  async function discard(page: PageChange): Promise<void> {
    await ctx.pages.flush();
    const read = await cli<{ exists: boolean; hash: string | null }>(["read", page.path]);
    if (!read.ok) return ctx.ui.toast(`Could not read ${page.path}: ${failure(read)}`);
    if (!read.exists || !read.hash) return redraw();
    const dialog = ctx.ui.dialog({
      title: `Delete ${page.path}?`,
      content: node("p", "The page is new since the notes were compared with git, so putting it back means deleting it."),
      actions: [{ id: "ok", label: "Delete", primary: true, danger: true }],
    });
    if ((await dialog.closed) !== "ok") return;
    const removed = await cli<{ path: string }>(["remove", page.path, "--expect", read.hash]);
    if (!removed.ok) return ctx.ui.toast(`Could not delete ${page.path}: ${failure(removed)}`);
    await ctx.pages.moved(page.path, null);
    await redraw();
  }

  function row(page: PageChange, change: Change, kept: boolean): HTMLElement {
    const whole = page.status !== "modified";
    const where = [...change.heading_path, ...(change.unit === "properties" ? ["Properties"] : [])].join(" › ");
    const main = button("change-main", "", () => void ctx.pages.open(page.path, change.line), `${page.path}:${change.line}`);
    if (where) main.append(node("span", "change-where", where));
    if (change.kind === "changed" && change.old_text !== undefined) main.append(node("span", "change-old", change.old_text));
    main.append(node("span", "change-text", change.text));
    const actions = node("div", "change-actions");
    if (!whole) {
      if (!kept) actions.append(button("change-keep", "Keep", () => keep([keptKey(page.path, change)]), "Leave it as it is and hide it"));
      actions.append(button("change-revert", "Put back", () => void revert(page.path, change), "Write the page again without this change"));
    }
    const box = node("div", `change ${change.kind}${kept ? " kept" : ""}`);
    box.append(node("span", "change-mark", MARKS[change.kind]), main, actions);
    return box;
  }

  function section(page: PageChange, shown: { change: Change; kept: boolean }[]): HTMLElement {
    const box = node("section", "changes-page");
    box.dataset.path = page.path;
    const head = node("div", "changes-page-head");
    const title = button("changes-page-title", page.path.replace(/\.md$/, ""), () => void ctx.pages.open(page.path), page.path);
    head.append(title, node("span", `changes-status ${page.status}`, { added: "new", modified: "modified", deleted: "deleted" }[page.status]));
    const actions = node("div", "change-actions");
    const keys = shown.filter((s) => !s.kept).map((s) => keptKey(page.path, s.change));
    if (keys.length > 0) actions.append(button("changes-page-keep", "Keep all", () => keep(keys), "Leave the page as it is and hide its changes"));
    if (page.status === "added") actions.append(button("changes-page-revert", "Put back", () => void discard(page), "Delete the page"));
    if (page.status === "deleted") actions.append(button("changes-page-revert", "Put back", () => void restore(page), "Write the page again"));
    head.append(actions);
    box.append(head, ...shown.map((s) => row(page, s.change, s.kept)));
    return box;
  }

  function header(since: string): HTMLElement {
    const input = Object.assign(node("input", "changes-since"), { value: since, spellcheck: false, placeholder: "HEAD" });
    input.setAttribute("aria-label", "Compare with");
    const apply = (rev: string) => void ctx.views.open("changes", rev.trim() === "" ? "HEAD" : rev.trim());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") apply(input.value);
    });
    const box = node("div", "changes-head");
    box.append(
      node("span", "changes-label", "Compared with"),
      input,
      button("changes-preset", "Last commit", () => apply("HEAD"), "What is not committed yet"),
      button("changes-preset", "Before last pull", () => apply("ORIG_HEAD"), "Since before the last pull or merge"),
    );
    return box;
  }

  let run = 0;
  /** The container the view is drawn in, while it is on screen. */
  let shownIn: HTMLElement | null = null;
  async function draw(container: HTMLElement, { arg }: { arg?: string }): Promise<void> {
    const since = arg && arg.trim() !== "" ? arg.trim() : "HEAD";
    const mine = ++run;
    shownIn = container;
    redraw = () => draw(container, { arg });
    let body = container.querySelector<HTMLElement>(".changes-body");
    // The head is made once, so a redraw while a revision is being typed does not take the input away.
    if (!body || !container.querySelector(".changes-since")) {
      body = node("div", "changes-body");
      container.replaceChildren(header(since), body);
    }
    const answer = await cli<ChangesAnswer>(["changes", "--since", since]);
    if (mine !== run) return;
    if (!answer.ok) return void body.replaceChildren(node("p", "changes-error", failure(answer)));

    const kept = new Set(keptNow());
    const pages = answer.pages
      .map((page) => ({ page, all: page.changes.map((change) => ({ change, kept: kept.has(keptKey(page.path, change)) })) }))
      .filter((p) => p.all.length > 0 || p.page.status !== "modified");
    const open = pages.reduce((n, p) => n + p.all.filter((c) => !c.kept).length, 0);
    const hidden = pages.reduce((n, p) => n + p.all.filter((c) => c.kept).length, 0);
    const visible = pages
      .map((p) => ({ page: p.page, shown: showKept ? p.all : p.all.filter((c) => !c.kept) }))
      .filter((p) => p.shown.length > 0);

    const line = node("p", "changes-summary", summary(visible.length, open, hidden));
    if (hidden > 0) {
      const toggle = button("changes-show-kept", showKept ? "Hide kept" : "Show kept", () => {
        showKept = !showKept;
        void redraw();
      });
      line.append(" ", toggle);
    }
    body.replaceChildren(line, ...visible.map((p) => section(p.page, p.shown)));
  }

  ctx.views.add({
    id: "changes",
    label: "Changes",
    glyph: "±",
    title: "What changed in the notes since the last commit, block by block",
    render: draw,
  });

  // A commit or a pull changes git and not the notes, so nothing tells the window: look again on coming back to it.
  window.addEventListener("focus", () => {
    if (shownIn?.isConnected) void redraw();
  });

  ctx.commands.add({ id: "changes.show", label: "Show changes", run: () => ctx.views.open("changes") });
}
