// The text editor: Markdown with the Tessela conventions on top (spec §11).

import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  autocompletion,
  startCompletion,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { languages } from "@codemirror/language-data";
import { GFM } from "@lezer/markdown";
import { search, searchKeymap } from "@codemirror/search";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Annotation, EditorState, Prec, Transaction, type Extension } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  drawSelection,
  keymap,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

import type { VocabEntry } from "../shared/api";
import { suggest } from "../shared/complete";
import { conceptAt } from "../shared/links";
import { smartLink } from "../shared/smartLink";
import { blockKeymap } from "./blockKeys";
import { queryableMarks, refreshDecorations } from "./decorations";
import { formatting } from "./formatKeys";
import { slashSource } from "./slash";

export interface EditorOptions {
  vocab: () => VocabEntry[];
  /** Folder of the open page, for resolving relative links. */
  pageDir: () => string;
  /** Concepts that have a page; null when that is not known. */
  written: () => Set<string> | null;
  onChange: (text: string) => void;
  /** The editor got the keyboard focus. */
  onFocus?: () => void;
  /** A tag or concept link was Ctrl/Cmd-clicked. */
  onOpenConcept: (id: string) => void;
}

export interface EditorHandle {
  text(): string;
  /** Replaces the whole text without counting it as an edit by the user. */
  setText(text: string, line?: number): void;
  focus(): void;
  /** Colours again, after the vocabulary changed. */
  refresh(): void;
}

const programmatic = Annotation.define<boolean>();

const highlight = HighlightStyle.define([
  { tag: t.heading1, color: "var(--heading)", fontWeight: "700", fontSize: "1.5em" },
  { tag: t.heading2, color: "var(--heading)", fontWeight: "700", fontSize: "1.3em" },
  { tag: t.heading3, color: "var(--heading)", fontWeight: "700", fontSize: "1.15em" },
  { tag: [t.heading4, t.heading5, t.heading6], color: "var(--heading)", fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--muted)" },
  { tag: t.link, color: "var(--link)" },
  { tag: t.url, color: "var(--muted)" },
  { tag: t.monospace, fontFamily: "var(--mono)", color: "var(--code)" },
  { tag: t.quote, color: "var(--muted)" },
  { tag: t.processingInstruction, color: "var(--muted)" },
  { tag: t.contentSeparator, color: "var(--muted)" },
  { tag: t.atom, color: "var(--accent)", fontWeight: "600" },
  // Code, in fenced blocks and in the front matter.
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier, t.self], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.escape, t.inserted], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null, t.literal], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.variableName)], color: "var(--syn-fn)" },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: "var(--syn-type)" },
  { tag: [t.propertyName, t.attributeName, t.labelName], color: "var(--syn-prop)" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "var(--syn-op)" },
  { tag: t.deleted, color: "var(--warn)" },
  { tag: t.meta, color: "var(--muted)" },
  { tag: t.invalid, color: "var(--warn)", textDecoration: "underline wavy" },
]);

function smartLinkCommand(view: EditorView): boolean {
  const sel = view.state.selection.main;
  const edit = smartLink(view.state.sliceDoc(sel.from, sel.to));
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: edit.text },
    selection: { anchor: sel.from + edit.cursor },
    userEvent: "input",
  });
  if (edit.inTarget) startCompletion(view);
  return true;
}

function options(vocab: VocabEntry[], query: string, apply: (concept: string) => string): Completion[] {
  return suggest(vocab, query).map((s) => ({
    label: s.concept,
    detail: s.detail,
    apply: apply(s.concept),
  }));
}

function completions(vocab: () => VocabEntry[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const link = context.matchBefore(/\]\([^)\s]*/);
    if (link) {
      const typed = link.text.slice(2).replace(/^\//, "").replace(/\.md$/, "");
      return {
        from: link.from + 2,
        filter: false,
        options: options(vocab(), typed, (c) => `/${c}.md`),
      };
    }
    const tag = context.matchBefore(/#[\p{L}\p{N}_/-]*/u);
    if (tag) {
      const before = tag.from > 0 ? context.state.sliceDoc(tag.from - 1, tag.from) : "";
      if (/[\p{L}\p{N}_&/#)]/u.test(before)) return null;
      return {
        from: tag.from + 1,
        filter: false,
        options: options(vocab(), tag.text.slice(1), (c) => c),
      };
    }
    return null;
  };
}

export function createEditor(parent: HTMLElement, opts: EditorOptions): EditorHandle {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "",
      extensions: [
        history(),
        drawSelection(),
        EditorView.lineWrapping,
        // YAML front matter, then Markdown (with tables and task lists) and code in the
        // languages that fenced blocks name.
        yamlFrontmatter({ content: markdown({ codeLanguages: languages, extensions: GFM }) }),
        syntaxHighlighting(highlight),
        autocompletion({ override: [completions(opts.vocab), slashSource], icons: false }),
        queryableMarks({ pageDir: opts.pageDir, written: opts.written }),
        blockKeymap,
        formatting,
        search({ top: true }),
        Prec.highest(keymap.of(searchKeymap)),
        Prec.highest(
          keymap.of([
            { key: "Mod-l", run: smartLinkCommand },
            // The Super key on Linux and Windows.
            { key: "Meta-l", run: smartLinkCommand },
          ]),
        ),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.domEventHandlers({
          focus() {
            opts.onFocus?.();
            return false;
          },
          mousedown(event, v) {
            if (!(event.ctrlKey || event.metaKey)) return false;
            const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos === null) return false;
            const line = v.state.doc.lineAt(pos);
            const hit = conceptAt(line.text, pos - line.from, opts.pageDir());
            if (!hit) return false;
            event.preventDefault();
            opts.onOpenConcept(hit.id);
            return true;
          },
        }),
        EditorView.updateListener.of((update) => {
          const own = update.transactions.some((tr) => tr.annotation(programmatic));
          if (update.docChanged && !own) opts.onChange(update.state.doc.toString());
        }),
      ],
    }),
  });

  return {
    text: () => view.state.doc.toString(),
    setText(text, line) {
      const keep = Math.min(view.state.selection.main.head, text.length);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        // Loading a page is not something to undo: undoing it would blank the page.
        annotations: [programmatic.of(true), Transaction.addToHistory.of(false)],
        selection: { anchor: keep },
      });
      if (line !== undefined) {
        // The line is in the new text, so look it up after the change.
        const target = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
        view.dispatch({
          selection: { anchor: target.from },
          effects: EditorView.scrollIntoView(target.from, { y: "center" }),
          annotations: [programmatic.of(true), Transaction.addToHistory.of(false)],
        });
      }
    },
    focus: () => view.focus(),
    refresh: () => view.dispatch({ effects: refreshDecorations.of(null) }),
  };
}
