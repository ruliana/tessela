// The properties mod: the title and the row of properties at the top of a page, with each value
// editable where it is drawn. The type offers the types the notes use, a tag the vocabulary, the
// date the date items of the `/` menu, and any other plain value is typed. A change rewrites that
// one key of the front matter (see plan.ts) and is saved through `ctx.cli`: the page is read, the
// edit made on what is on disk and sent back with the hash that was read, so nothing newer is lost.
// Values from the notes go in as text, never as HTML.

import { el } from "../../renderer/dom";
import type { ModContext } from "../../renderer/mods";
import { daysInLine } from "../../shared/dates";
import type { PropertiesArg } from "../../shared/mods";
import { journalDest } from "../../shared/pages";
import { showWhen } from "../../shared/properties";
import { type Edit, applyEdit, dateChoices, knownTypes, tagChoices, validWhen } from "./plan";

type Answer<T> = ({ ok: true } & T) | { ok: false; error: { code: string; message: string } };

interface Choice {
  label: string;
  text: string;
}

/** What a small editor is made of. */
interface Editing {
  /** What the input starts with. */
  value: string;
  placeholder: string;
  /** The options under the input for what is typed; may be asked again when it changes. */
  choices(typed: string): Choice[] | Promise<Choice[]>;
  /** The text to write for what was typed, or null (with a reason) when it will not do. */
  check?(typed: string): { value: string } | { error: string };
  /** What to do with the value; an empty one is for the editor to decide. */
  commit(value: string): void;
  /** A button that takes the value away. */
  remove?: () => void;
}

export default function (ctx: ModContext): void {
  const cli = <T>(argv: string[], input?: string) => ctx.cli(argv, input === undefined ? undefined : { input }) as Promise<Answer<T>>;

  /** The one small editor that is open. */
  let open: { close(): void } | null = null;

  async function change(path: string, edit: Edit): Promise<void> {
    await ctx.pages.flush();
    const page = await cli<{ exists: boolean; text: string; hash: string | null }>(["read", path]);
    if (!page.ok || !page.exists || page.hash === null) return ctx.ui.toast(`Could not read ${path}.`);
    const next = applyEdit(page.text, edit);
    if (next === null) return ctx.ui.toast("That property is written in a way the editor will not guess at. Use Edit properties to change it.");
    if (next === page.text) return;
    const saved = await cli(["save", path, "--expect", page.hash], next);
    if (!saved.ok) ctx.ui.toast(`Could not change ${path}: ${saved.error.message}`);
  }

  /** Opens a small editor under `anchor`, in `wrap`. */
  function edit(wrap: HTMLElement, anchor: HTMLElement, how: Editing): void {
    open?.close();
    const input = el("input", { class: "prop-input", type: "text", value: how.value, placeholder: how.placeholder });
    input.spellcheck = false;
    const list = el("div", { class: "prop-opts" });
    const error = el("div", { class: "prop-error" });
    const pop = el("div", { class: "prop-pop" }, input, list, error);
    if (how.remove) {
      const remove = el("button", { class: "prop-remove", type: "button", title: "Take this away" }, "Remove");
      remove.addEventListener("click", () => {
        close();
        how.remove?.();
      });
      pop.append(remove);
    }
    let shown: HTMLButtonElement[] = [];
    let active = -1;
    let asked = 0;

    function close(): void {
      pop.remove();
      if (open === handle) open = null;
    }
    const handle = { close };

    function mark(index: number): void {
      active = index;
      shown.forEach((b, i) => b.classList.toggle("active", i === index));
    }

    async function offer(): Promise<void> {
      const mine = ++asked;
      const choices = await how.choices(input.value);
      if (mine !== asked) return;
      shown = choices.map((c) => {
        const b = el("button", { class: "prop-opt", type: "button", title: c.text === c.label ? "" : c.text }, c.label);
        b.addEventListener("click", () => done(c.text));
        return b;
      });
      active = -1;
      list.replaceChildren(...shown);
    }

    function done(typed: string): void {
      const checked = how.check?.(typed) ?? { value: typed };
      if ("error" in checked) {
        input.setAttribute("aria-invalid", "true");
        error.textContent = checked.error;
        return;
      }
      close();
      how.commit(checked.value);
    }

    input.addEventListener("input", () => {
      input.removeAttribute("aria-invalid");
      error.textContent = "";
      void offer();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const picked = shown[active];
        if (picked) picked.click();
        else done(input.value);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = shown.length;
        if (n > 0) mark(((active + 1 + (e.key === "ArrowDown" ? 1 : -1) + (n + 1)) % (n + 1)) - 1);
      }
    });
    pop.addEventListener("focusout", (e) => {
      const next = e.relatedTarget;
      if (!(next instanceof Node && pop.contains(next))) window.setTimeout(() => (pop.contains(document.activeElement) ? undefined : close()), 0);
    });

    // Under the anchor, as far left as it is while it still fits.
    wrap.append(pop);
    pop.style.left = `${Math.max(0, Math.min(anchor.offsetLeft, wrap.clientWidth - pop.offsetWidth - 8))}px`;
    pop.style.top = `${anchor.offsetTop + anchor.offsetHeight + 4}px`;
    open = handle;
    input.focus();
    input.select();
    void offer();
  }

  function draw(arg: PropertiesArg): HTMLElement {
    const { props, path } = arg;
    const wrap = el("div", { class: "cm-props" });
    // As without a mod: a click on the title means "write here". What can be edited handles its own.
    wrap.addEventListener("mousedown", (event) => {
      if (event.target instanceof Element && event.target.closest("button, input, .cm-props-chip, .prop-pop")) return;
      event.preventDefault();
      arg.toBody();
    });
    if (arg.title !== null) wrap.append(el("h1", { class: "cm-props-title" }, arg.title));
    const row = el("div", { class: "cm-props-row" });

    const chip = (text: string, cls: string, title: string, how: () => Editing): HTMLElement => {
      const span = el("span", { class: `cm-props-chip ${cls}`, title }, text);
      span.tabIndex = 0;
      const start = () => edit(wrap, span, how());
      span.addEventListener("click", start);
      span.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          start();
        }
      });
      row.append(span);
      return span;
    };
    const send = (e: Edit) => void change(path, e);

    if (props.type) {
      const current = props.type;
      chip(current, "cm-props-type", "Change the type", () => ({
        value: current,
        placeholder: "type",
        choices: async (typed) => {
          const pages = await cli<{ pages: { type?: string | null }[] }>(["pages"]);
          const q = typed.trim().toLowerCase();
          const types = knownTypes(pages.ok ? pages.pages : []).filter((t) => t !== current);
          const fit = typed.trim() === "" || typed === current ? types : [...types.filter((t) => t.startsWith(q)), ...types.filter((t) => !t.startsWith(q) && t.includes(q))];
          return fit.slice(0, 8).map((t) => ({ label: t, text: t }));
        },
        commit: (value) => value.trim() !== "" && value.trim() !== current && send({ op: "set", key: "type", value }),
      }));
    }

    for (const tag of props.tags) {
      chip(`#${tag}`, "cm-props-tag", "Change the tag", () => ({
        value: tag,
        placeholder: "tag",
        choices: (typed) => vocabulary(props.tags, typed === tag ? "" : typed),
        commit: (value) => (value.trim() === "" ? send({ op: "tag", from: tag, to: null }) : send({ op: "tag", from: tag, to: value })),
        remove: () => send({ op: "tag", from: tag, to: null }),
      }));
    }
    const add = el("button", { class: "prop-add-tag", type: "button", title: "Add a tag" }, "+ tag");
    add.addEventListener("click", () =>
      edit(wrap, add, {
        value: "",
        placeholder: "tag",
        choices: (typed) => vocabulary(props.tags, typed),
        commit: (value) => value.trim() !== "" && send({ op: "tag-add", tag: value }),
      }),
    );

    async function vocabulary(has: string[], typed: string): Promise<Choice[]> {
      const answer = await cli<{ concepts: { concept: string; deprecated?: boolean }[] }>(["vocab"]);
      return tagChoices(answer.ok ? answer.concepts : [], has, typed).map((t) => ({ label: t, text: t }));
    }
    // What changes the row's own values waits at its end, so the chips stay where they were drawn.
    const actions = el("span", { class: "prop-actions" }, add);

    if (props.when) {
      const { key, value } = props.when;
      const when = el("span", { class: "cm-props-chip cm-props-when", title: `${key}: ${value}` }, showWhen(value));
      // The date of the page leads to that day's journal; changing it is the pencil beside it.
      const day = daysInLine(value)[0]?.day;
      if (day !== undefined && value.startsWith(day)) {
        when.classList.add("cm-props-day");
        when.addEventListener("mousedown", (event) => {
          event.preventDefault();
          arg.openLink(journalDest(day));
        });
      }
      row.append(when);
      const pencil = el("button", { class: "prop-edit-when", type: "button", title: `Change the ${key}` }, "Change date");
      pencil.addEventListener("click", () =>
        edit(wrap, pencil, {
          value,
          placeholder: "2026-10-27 or 2026-10-27 14:30:00-03:00",
          choices: () => dateChoices(new Date()).map((c) => ({ label: c.label, text: c.text })),
          check: (typed) => {
            const ok = validWhen(typed);
            return ok === null ? { error: "Write a date as 2026-10-27, or with a time and offset: 2026-10-27 14:30:00-03:00." } : { value: ok };
          },
          commit: (next) => next !== value && send({ op: "set", key, value: next }),
        }),
      );
      actions.append(pencil);
    }

    for (const { key, value } of props.others.slice(0, 3)) {
      chip(`${key} ${value}`, "cm-props-other", `Change ${key}`, () => ({
        value,
        placeholder: key,
        choices: () => [],
        commit: (next) => next !== value && send({ op: "set", key, value: next }),
      }));
    }

    const yaml = el("button", { class: "cm-props-edit", type: "button" }, "Edit properties");
    actions.append(yaml);
    yaml.addEventListener("mousedown", (event) => {
      event.preventDefault();
      arg.editYaml();
    });
    row.append(actions);
    wrap.append(row);
    return wrap;
  }

  ctx.override.add("properties", { draw });
  // A popup of the page that was closed must not stay behind.
  ctx.events.on("page-opened", () => open?.close());
  ctx.events.on("bundle-opened", () => open?.close());
}
