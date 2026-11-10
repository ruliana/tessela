// The outline mod: the headings of the open page.
//  - A group at the top of the right column lists them, indented by level; a click puts the cursor
//    on the heading. It is drawn from the saved page, so it follows what is written once it is saved.
//  - "Go to heading" in the palette picks a heading by typing part of it.
//  - Alt+Up and Alt+Down on a heading line move its section (what is under it, down to the next
//    heading of its level) past the neighbour of the same level. Elsewhere the keys do what they did.
// Everything on disk is read through `ctx.cli`; note text goes in as text, never as HTML.

import type { EditorView } from "@codemirror/view";

import { el } from "../../renderer/dom";
import type { ModContext } from "../../renderer/mods";
import { type Heading, headingAt, headings, matching, moveSection } from "./plan";

type Answer<T> = ({ ok: true } & T) | { ok: false; error: { code: string; message: string } };

const linesOf = (view: EditorView) => view.state.doc.toString().split("\n");

export default function (ctx: ModContext): void {
  const { Prec } = ctx.cm.state;
  const { keymap, ViewPlugin } = ctx.cm.view;

  // The editors made, by page, so a click in the outline can move the cursor without reloading the page.
  // A card that is closed leaves its editor behind, so only those still in the window count.
  const open = new Set<{ path: string; view: EditorView }>();
  ctx.editor.extend(({ path }) => [
    ViewPlugin.fromClass(
      class {
        entry: { path: string; view: EditorView };
        constructor(view: EditorView) {
          this.entry = { path, view };
          for (const e of open) if (!e.view.dom.isConnected) open.delete(e);
          open.add(this.entry);
        }
        destroy() {
          open.delete(this.entry);
        }
      },
    ),
    Prec.highest(
      keymap.of([
        { key: "Alt-ArrowUp", run: (v: EditorView) => moveFromHeadingLine(v, "up") },
        { key: "Alt-ArrowDown", run: (v: EditorView) => moveFromHeadingLine(v, "down") },
      ]),
    ),
  ]);

  /** Puts the cursor at the start of `line` (0 is the first), scrolled into view. */
  function goTo(view: EditorView, line: number): void {
    const pos = view.state.doc.line(Math.min(Math.max(line + 1, 1), view.state.doc.lines)).from;
    view.dispatch({ selection: { anchor: pos }, effects: ctx.cm.view.EditorView.scrollIntoView(pos, { y: "start", yMargin: 24 }) });
    view.focus();
  }

  /** Moves the section whose heading is on `heading` (a line number); false when nothing moves. */
  function move(view: EditorView, heading: number, dir: "up" | "down"): boolean {
    const doc = view.state.doc;
    const moved = moveSection(linesOf(view), heading, dir);
    if (!moved) return false;
    const from = doc.line(moved.from + 1).from;
    const to = doc.line(moved.to + 1).to;
    const insert = moved.lines.slice(moved.from, moved.to + 1).join("\n");
    // The cursor is in the section that moved (the key needs the heading line, the palette any line of it) and goes with it.
    const { head } = view.state.selection.main;
    const at = doc.lineAt(head);
    const line = Math.min(Math.max(at.number - 1 + moved.shift, moved.from), moved.to);
    const start = moved.lines.slice(moved.from, line).reduce((sum, l) => sum + l.length + 1, from);
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: start + Math.min(head - at.from, moved.lines[line]!.length) },
      scrollIntoView: true,
      userEvent: "move.section",
    });
    return true;
  }

  /** The key: only on a heading line, and then the keys are ours even when the section cannot move. */
  function moveFromHeadingLine(view: EditorView, dir: "up" | "down"): boolean {
    const line = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
    if (!headings(linesOf(view)).some((h) => h.line === line)) return false;
    move(view, line, dir);
    return true;
  }

  /** The palette's version: the section the cursor is in, whichever line of it. */
  function moveFromPalette(view: EditorView | undefined, dir: "up" | "down"): void {
    if (!view) return void ctx.ui.toast("Put the cursor in a section to move it.");
    const line = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
    const heading = headingAt(headings(linesOf(view)), line);
    if (!heading) return void ctx.ui.toast("Put the cursor in a section to move it.");
    if (!move(view, heading.line, dir)) ctx.ui.toast(`That section is already the ${dir === "up" ? "first" : "last"} of its level.`);
  }

  ctx.commands.add({ id: "outline.move-up", label: "Move the section up", hint: "Alt ↑ on a heading", run: ({ view }) => moveFromPalette(view, "up") });
  ctx.commands.add({ id: "outline.move-down", label: "Move the section down", hint: "Alt ↓ on a heading", run: ({ view }) => moveFromPalette(view, "down") });

  // ---- go to heading ------------------------------------------------------------------

  function pick(view: EditorView): void {
    const all = headings(linesOf(view));
    if (all.length === 0) return void ctx.ui.toast("This page has no headings.");
    const input = el("input", { type: "text", class: "heading-filter", placeholder: "Part of a heading", ariaLabel: "Heading" });
    const list = el("div", { class: "heading-picks" });
    let shown: Heading[] = [];
    let chosen = 0;
    const select = (to: number) => {
      chosen = Math.min(Math.max(to, 0), Math.max(shown.length - 1, 0));
      [...list.children].forEach((c, i) => c.classList.toggle("on", i === chosen));
    };
    const draw = () => {
      shown = matching(all, input.value);
      list.replaceChildren(
        ...shown.map((h, i) => {
          const row = el("button", { class: "heading-pick", type: "button", onclick: () => finish(i) }, h.text);
          row.dataset.level = String(h.level);
          return row;
        }),
      );
      select(0);
    };
    const dialog = ctx.ui.dialog({ title: "Go to heading", content: el("div", { class: "heading-dialog" }, input, list), actions: [{ id: "go", label: "Go", primary: true }] });
    const finish = (i: number) => {
      const target = shown[i];
      dialog.close(null);
      if (target) goTo(view, target.line);
    };
    input.addEventListener("input", draw);
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        select(chosen + (e.key === "ArrowDown" ? 1 : -1));
      }
    });
    void dialog.closed.then((id) => {
      if (id === "go") {
        const target = shown[chosen];
        if (target) goTo(view, target.line);
      }
    });
    draw();
  }

  ctx.commands.add({
    id: "outline.go",
    label: "Go to heading",
    run: ({ view }) => (view ? pick(view) : ctx.ui.toast("Open a page to go to one of its headings.")),
  });

  // ---- the group in the right column --------------------------------------------------

  ctx.backlinks.add(async ({ path }) => {
    const page = (await ctx.cli(["read", path])) as Answer<{ exists: boolean; text: string }>;
    if (!page.ok || !page.exists) return null;
    const list = headings(page.text.split("\n"));
    if (list.length < 2) return null;
    const top = Math.min(...list.map((h) => h.level));
    const items = list.map((h) => {
      const button = el("button", { class: "outline-item", title: `Go to “${h.text}”`, onclick: () => jump(path, h.line) }, h.text);
      button.dataset.level = String(h.level);
      button.style.paddingLeft = `${8 + (h.level - top) * 14}px`;
      return button;
    });
    const group = el("section", { class: "bl-group outline" }, el("h3", {}, "Outline", el("span", { class: "n" }, String(list.length))), ...items);
    return { node: group, first: true };
  });

  function jump(path: string, line: number): void {
    const shown = [...open].reverse().find((e) => e.path === path && e.view.dom.isConnected);
    if (shown) goTo(shown.view, line);
    else void ctx.pages.open(path, line + 1);
  }
}
