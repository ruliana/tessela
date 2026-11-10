// The ways of adding a link that are measured, each as what the editor would do for the keys.

import type { VocabEntry } from "../../src/shared/api";
import { slugFirst, suggest } from "../../src/shared/complete";
import { type LinkChoice, type LinkPage, choicesFor, markdownLink, pasteLink, splitAlias } from "../../src/shared/linkFlows";
import { type Doc, type Flow, type Option } from "./typing";

function replace(doc: Doc, from: number, to: number, insert: string, cursor = from + insert.length): Doc {
  return { ...doc, text: doc.text.slice(0, from) + insert + doc.text.slice(to), cursor, sel: null };
}

function option(label: string, apply: (doc: Doc) => Doc): Option {
  return { label, apply };
}

/** Typing the whole Markdown link: the way it is done today without any help. */
export const typeItAll: Flow = { name: "Type it all", popup: () => null };

/** `[text](` + the position of `[` and the text between, when the cursor is in a link target. */
function inTarget(doc: Doc): { open: number; label: string; typed: string; from: number } | null {
  const before = doc.text.slice(0, doc.cursor);
  const m = /\]\(([^)]*)$/.exec(before);
  if (!m) return null;
  const open = before.lastIndexOf("[", m.index);
  if (open < 0 || before.slice(open, m.index).includes("\n")) return null;
  return { open, label: before.slice(open + 1, m.index), typed: m[1] ?? "", from: m.index + 2 };
}

/** The `)` that closeBrackets put after the cursor is part of the link being replaced. */
function closing(doc: Doc): number {
  return doc.text[doc.cursor] === ")" ? 1 : 0;
}

/** What the editor offers today after `](`: concepts from `tessela vocab`, the slug of the text first. */
export function currentEditor(pages: LinkPage[]): Flow {
  const vocab: VocabEntry[] = pages.map((p) => ({
    concept: p.path.replace(/\.md$/, ""),
    has_page: true,
    mentions: 1,
    pages: 1,
    deprecated: false,
    use_instead: null,
    note: null,
  }));
  return {
    name: "Today's `](` list",
    popup(doc) {
      const t = inTarget(doc);
      if (!t || /\s/.test(t.typed)) return null;
      const typed = t.typed.replace(/^\//, "").replace(/\.md$/, "");
      return slugFirst(suggest(vocab, typed), t.label, typed).map((s) =>
        // Like the editor: only the target is filled in, and the cursor stays before the `)`.
        option(s.concept, (d) => replace(d, t.from, d.cursor, `/${s.concept}.md`)),
      );
    },
  };
}

function choiceOptions(choices: LinkChoice[], take: (c: LinkChoice) => Doc): Option[] {
  return choices.map((c) => option(c.fresh ? `new: ${c.text}` : c.text, () => take(c)));
}

/** `[[` opens a picker over the page titles; the choice becomes a normal Markdown link. */
export function wikilink(pages: LinkPage[]): Flow {
  return {
    name: "`[[` picker",
    popup(doc) {
      const before = doc.text.slice(0, doc.cursor);
      const m = /\[\[([^\][\n]*)$/.exec(before);
      if (!m || !doc.text.startsWith("]]", doc.cursor)) return null;
      const { search, alias } = splitAlias(m[1] ?? "");
      return choiceOptions(choicesFor(pages, search), (c) =>
        replace(doc, m.index, doc.cursor + 2, markdownLink(alias ?? c.text, c.dest)),
      );
    },
  };
}

/** Ctrl+L opens `[]()` with the cursor in the target; searching fills the target and the empty text. */
export function ctrlL(pages: LinkPage[]): Flow {
  return {
    name: "Ctrl+L search",
    key(doc, key) {
      if (key !== "Ctrl+L") return null;
      const [from, to] = doc.sel ?? [doc.cursor, doc.cursor];
      const selected = doc.text.slice(from, to);
      return selected === ""
        ? replace(doc, from, to, "[]()", from + 3)
        : replace(doc, from, to, `[${selected}]()`, from + selected.length + 3);
    },
    popup(doc) {
      const t = inTarget(doc);
      if (!t) return null;
      return choiceOptions(choicesFor(pages, t.typed), (c) =>
        replace(doc, t.open, doc.cursor + closing(doc), markdownLink(t.label || c.text, c.dest)),
      );
    },
  };
}

/** Text that is a task box or a lone mark is not a link title. */
const NOT_A_TITLE = /^\s*[xX]?\s*$/;

/** Typing `[Title]` offers the page of that title, or a new one, for the target. */
export function titleFirst(pages: LinkPage[]): Flow {
  return {
    name: "`[Title]` then Enter",
    popup(doc) {
      const before = doc.text.slice(0, doc.cursor);
      const t = inTarget(doc);
      if (t) {
        // Typing `(` goes on from the same list; with nothing typed yet it is searched by the link text.
        return choiceOptions(choicesFor(pages, t.typed || t.label), (c) =>
          replace(doc, t.from, doc.cursor + closing(doc), `${c.dest})`),
        );
      }
      const m = /\[([^\][\n]*)\]$/.exec(before);
      if (!m || NOT_A_TITLE.test(m[1] ?? "") || doc.text[doc.cursor] === "(") return null;
      return choiceOptions(choicesFor(pages, m[1] ?? ""), (c) => replace(doc, doc.cursor, doc.cursor, `(${c.dest})`, doc.cursor + c.dest.length + 2));
    },
  };
}

/** Pasting an address over selected text makes the text the link. */
export const pasteToLink: Flow = {
  name: "Paste over selection",
  popup: () => null,
  key(doc, key) {
    if (key !== "Ctrl+V" || doc.sel === null) return null;
    const [from, to] = doc.sel;
    const link = pasteLink(doc.text.slice(from, to), doc.clipboard);
    return link === null ? null : replace(doc, from, to, link);
  },
};
