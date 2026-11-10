// The agenda mod: tasks are plain `- [ ]` items and a due date is a date written in the item.
//  - A journal day gets a "Due" group at the top of its backlinks with the open tasks that name
//    the day (today also gets the overdue ones). Ticking a task on its tile is written through the
//    CLI as a one-line patch, based on the hash the page was read at.
//  - A month strip in the sidebar marks the days that have a file and the days that are only
//    mentioned, so a future day is an agenda before it has a page.
// Everything is read and written through `ctx.cli`; note text goes in as text, never as HTML.

import type { ModContext } from "../../renderer/mods";
import { el } from "../../renderer/dom";
import { renderInlineText } from "../../renderer/inline";
import { formatDate } from "../../shared/dates";
import { journalPath, pageId } from "../../shared/pages";
import { dayBefore, dayOfJournal, dueOn, monthView, shiftMonth, tickPatch, type Due, type TaskHit } from "./plan";

type Answer<T> = ({ ok: true } & T) | { ok: false; error: { code: string; message: string } };

const failure = (a: { ok: false; error: { message: string } }) => a.error.message;

export default function (ctx: ModContext): void {
  const cli = <T>(argv: string[], input?: string) => ctx.cli(argv, input === undefined ? undefined : { input }) as Promise<Answer<T>>;
  const query = async (args: string[]): Promise<TaskHit[]> => {
    const answer = await cli<{ hits: TaskHit[] }>(["query", ...args]);
    return answer.ok ? answer.hits : [];
  };

  /** Ticks the task of a tile: the page is read, the one line is changed by a patch, and nothing else is touched. */
  async function tick(hit: TaskHit): Promise<boolean> {
    await ctx.pages.flush();
    const page = await cli<{ exists: boolean; text: string; hash: string | null }>(["read", hit.path]);
    const stop = (message: string): false => {
      ctx.ui.toast(message);
      return false;
    };
    if (!page.ok) return stop(`Could not read ${hit.path}: ${failure(page)}`);
    const patch = page.exists && page.hash ? tickPatch(hit.path, page.text, hit.line, hit.text) : null;
    if (!patch || !page.hash) return stop(`That task has changed in ${hit.path}. Open the page to tick it.`);
    const saved = await cli<object>(["save", hit.path, "--expect", page.hash, "--patch"], patch);
    return saved.ok || stop(`Could not tick the task: ${failure(saved)}`);
  }

  function tile(item: Due): HTMLElement {
    const { hit } = item;
    const where = [pageId(hit.path), ...(item.overdue ? [`overdue since ${item.date}`] : [])].join(" · ");
    const box = el("input", { type: "checkbox", class: "task-box", title: "Tick the task", ariaLabel: "Tick the task" });
    const row = el(
      "div",
      { class: item.overdue ? "task overdue" : "task" },
      box,
      el(
        "button",
        { class: "hit", onclick: () => void ctx.pages.open(hit.path, hit.line) },
        el("span", { class: "where" }, where),
        el("span", { class: "text" }, ...renderInlineText(hit.text, (day) => void ctx.pages.open(journalPath(day)))),
      ),
    );
    box.addEventListener("change", () => {
      box.disabled = true;
      void tick(hit).then((ok) => {
        box.disabled = false;
        if (ok) row.classList.add("done");
        else box.checked = false;
      });
    });
    return row;
  }

  ctx.backlinks.add(async ({ path }) => {
    const day = dayOfJournal(path);
    if (!day) return null;
    const today = formatDate(new Date());
    const lists = await Promise.all([
      query(["--task", "open", "--from", day, "--to", day, "--limit", "300"]),
      // Overdue tasks are found among all that end before today; most of what comes back is not dated.
      day === today ? query(["--task", "open", "--to", dayBefore(today), "--limit", "2000"]) : [],
    ]);
    const due = dueOn(lists.flat(), day, today, path);
    if (due.length === 0) return null;
    const group = el(
      "section",
      { class: "bl-group due" },
      el("h3", {}, "Due", el("span", { class: "n" }, String(due.length))),
      ...due.map(tile),
    );
    return { node: group, first: true, taken: due.map((d) => d.hit.handle) };
  });

  // ---- the month strip ------------------------------------------------------

  const slot = ctx.slots.mount("sidebar");
  const strip = el("section", { class: "group", id: "month-strip" });
  slot.root.append(strip);
  const now = new Date();
  let month: [number, number] = [now.getFullYear(), now.getMonth() + 1];
  let run = 0;

  async function draw(): Promise<void> {
    const mine = ++run;
    const today = formatDate(new Date());
    const [year, m] = month;
    const bounds = monthView(year, m, new Set(), new Set(), today);
    const [pages, mentions] = await Promise.all([
      cli<{ pages: { path: string }[] }>(["pages"]),
      query(["--from", bounds.from, "--to", bounds.to, "--limit", "2000"]),
    ]);
    if (mine !== run) return;
    const files = new Set((pages.ok ? pages.pages : []).map((p) => dayOfJournal(p.path)).filter((d): d is string => d !== null));
    const mentioned = new Set(mentions.flatMap((h) => h.dates));
    const view = monthView(year, m, files, mentioned, today);

    const step = (by: number) => () => {
      month = shiftMonth(month, by);
      void draw();
    };
    const head = el(
      "div",
      { class: "month-head" },
      el("button", { class: "month-prev link", title: "The month before", ariaLabel: "The month before", onclick: step(-1) }, "‹"),
      el("span", { class: "month-title" }, view.title),
      el(
        "button",
        {
          class: "month-today link",
          title: "Back to this month",
          onclick: () => {
            month = [now.getFullYear(), now.getMonth() + 1];
            void draw();
          },
        },
        "Today",
      ),
      el("button", { class: "month-next link", title: "The month after", ariaLabel: "The month after", onclick: step(1) }, "›"),
    );
    const grid = el("div", { class: "month-grid" });
    for (const letter of ["M", "T", "W", "T", "F", "S", "S"]) grid.append(el("span", { class: "dow" }, letter));
    for (let i = 0; i < view.pad; i++) grid.append(el("span", { class: "pad" }));
    for (const c of view.cells) {
      const state = [c.file ? "file" : "", c.mention ? "mention" : "", c.today ? "is-today" : ""].filter(Boolean).join(" ");
      const what = c.file ? "has a page" : c.mention ? "is mentioned" : "";
      grid.append(
        el(
          "button",
          { class: `day ${state}`.trim(), title: `${c.day}${what ? ` (${what})` : ""}`, onclick: () => void ctx.pages.open(journalPath(c.day)) },
          String(c.n),
        ),
      );
      (grid.lastElementChild as HTMLElement).dataset.day = c.day;
    }
    strip.replaceChildren(head, grid);
  }

  // The strip shows the month of the journal day that is open, and follows the notes.
  ctx.events.on("page-opened", ({ path }) => {
    const day = dayOfJournal(path);
    if (day) month = [Number(day.slice(0, 4)), Number(day.slice(5, 7))];
    void draw();
  });
  ctx.events.on("changed", () => void draw());
  ctx.events.on("page-saved", () => void draw());
}
