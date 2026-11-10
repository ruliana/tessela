// The peek mod: shows what a link, a #tag or a date points to at the top of the right column,
// without leaving the page being written. One peek at a time. A written page (or a day) is the
// same card the window uses, so it can be edited and saves on its own; a concept with no page
// shows what mentions it. Esc closes it, Enter goes there. Everything is read through `ctx.cli`.

import type { EditorView } from "@codemirror/view";

import type { ModContext, PageCard } from "../../renderer/mods";
import { countMentions, mentionsOf, peekAt, type PeekTarget } from "./plan";

interface Hit {
  handle: string;
  path: string;
  line: number;
  text: string;
}

type Answer<T> = ({ ok: true } & T) | { ok: false; error: { code: string; message: string } };

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] =>
  Object.assign(document.createElement(tag), { textContent: text }, props);

const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

export default function (ctx: ModContext): void {
  const slot = ctx.slots.mount("side-top");
  const cli = <T>(argv: string[]) => ctx.cli(argv) as Promise<Answer<T>>;

  /** True while the peek's own card is loading, whose `page-opened` is not the window moving to another page. */
  let loading = false;
  /** The peek on show: where it is, the card in it (a written page or a day) and the editor it came from. */
  let shown: { target: PeekTarget; root: HTMLElement; card: PageCard | null; origin: EditorView | undefined } | null = null;

  function close(refocus = false): void {
    if (!shown) return;
    const { root, card, origin } = shown;
    shown = null;
    card?.destroy();
    root.remove();
    if (refocus) origin?.focus();
  }

  async function goThere(): Promise<void> {
    if (!shown) return;
    const { path } = shown.target;
    close();
    await ctx.pages.open(path);
  }

  const query = async (args: string[]): Promise<Hit[]> => {
    const answer = await cli<{ hits: Hit[] }>(["query", ...args, "--limit", "50"]);
    return answer.ok ? answer.hits : [];
  };

  /** What mentions the target: a concept by reference, a day also by the dates written in other pages. */
  async function mentions(target: PeekTarget): Promise<Hit[]> {
    const lists = [await query(["--ref", target.id])];
    if (target.kind === "day") lists.push(await query(["--from", target.day, "--to", target.day]));
    return mentionsOf(lists.flat(), target.path);
  }

  /** The list of mentions. Note text goes in as text, never as HTML. */
  function mentionList(hits: Hit[]): HTMLElement {
    const box = node("div", "", { className: "peek-mentions" });
    box.append(node("h3", countMentions(hits.length)));
    for (const hit of hits) {
      const button = node("button", "", { className: "hit", title: `${hit.path}:${hit.line}` });
      button.append(node("span", hit.path.replace(/\.md$/, ""), { className: "where" }), node("span", hit.text.trim(), { className: "text" }));
      button.addEventListener("click", () => {
        close();
        void ctx.pages.open(hit.path, hit.line);
      });
      box.append(button);
    }
    return box;
  }

  async function show(target: PeekTarget, origin: EditorView | undefined, focus: boolean): Promise<void> {
    close();
    await ctx.pages.flush();
    const exists = await cli<{ exists: boolean }>(["read", target.path]);
    const written = exists.ok && exists.exists;
    const withCard = written || target.kind === "day";

    const open = node("button", "Open ↵", { className: "peek-open", title: "Go to the page (Enter)" });
    const closeButton = node("button", "×", { className: "peek-close", title: "Close (Esc)", ariaLabel: "Close the peek" });
    const head = node("div", "", { className: "peek-head" });
    head.append(node("span", "Peek", { className: "peek-label" }), open, closeButton);
    const root = node("div", "", { id: "peek", tabIndex: -1 });
    root.append(head);
    open.addEventListener("click", () => void goThere());
    closeButton.addEventListener("click", () => close(true));
    root.addEventListener("keydown", (e) => {
      if (document.querySelector(".cm-tooltip-autocomplete")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
      } else if (e.key === "Enter" && e.target === root) {
        e.preventDefault();
        void goThere();
      }
    });

    const card = withCard ? ctx.pages.card(target.path, { menu: false }) : null;
    shown = { target, root, card, origin };
    slot.root.append(root);
    slot.reveal();
    // At once, so Esc and Enter work while the page is still loading.
    if (focus) root.focus();
    if (card) {
      root.append(card.root);
      loading = true;
      await card.load().finally(() => (loading = false));
    } else {
      root.append(node("p", `${target.id} is not written yet.`, { className: "peek-note" }));
    }
    // A day shows what mentions it beside its page; a concept shows them only in place of the page it lacks.
    const listed = target.kind === "day" || !written;
    const hits = listed ? await mentions(target) : [];
    if (shown?.root !== root) return;
    if (listed) root.append(mentionList(hits));
  }

  /** Peeks at what the cursor is in; `view` is the editor in use. */
  function peek(view: EditorView | undefined): void {
    if (!view) return void ctx.ui.toast("Put the cursor in a link, a #tag or a date to peek at it.");
    // A link inside the peek itself resolves from the peeked page's folder.
    const inPeek = shown?.card?.view() === view;
    const page = inPeek ? shown?.target.path : ctx.pages.current();
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    const target = peekAt(line.text, head - line.from, dirOf(page ?? ""));
    if (!target) return void ctx.ui.toast("Put the cursor in a link, a #tag or a date to peek at it.");
    if (target.path === ctx.pages.current()) return void ctx.ui.toast("That is the page you are on.");
    void show(target, view, true);
  }

  ctx.commands.add({ id: "peek.open", label: "Peek at the link under the cursor", keys: "Mod-Alt-p", run: ({ view }) => peek(view) });

  // Esc closes the peek from the page being written too, unless it is closing a menu of the editor.
  ctx.editor.extend(
    ctx.cm.state.Prec.high(
      ctx.cm.view.keymap.of([
        {
          key: "Escape",
          run: () => {
            if (!shown || document.querySelector(".cm-tooltip-autocomplete")) return false;
            close(true);
            return true;
          },
        },
      ]),
    ),
  );

  ctx.events.on("bundle-opened", () => close());
  // The peek belongs to the page it was opened from: another page in the window ends it.
  ctx.events.on("page-opened", () => {
    if (!loading) close();
  });
}
