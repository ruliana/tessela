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
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { Annotation, Compartment, EditorState, Prec, Transaction, type Extension } from "@codemirror/state";
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
import { slugFirst, suggest } from "../shared/complete";
import { conceptAt, findAnchor, headingText, linkTargetId, localTarget } from "../shared/links";
import { smartLink } from "../shared/smartLink";
import { blockKeymap } from "./blockKeys";
import { queryableMarks, refreshDecorations } from "./decorations";
import { formatting } from "./formatKeys";
import { livePreview, renderedLine } from "./livePreview";
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
  /** A link to the web or to an e-mail address was clicked. */
  onOpenExternal: (url: string) => void;
  /** Starts with Markdown rendered outside the block being edited. */
  livePreview?: boolean;
  /** The key for switching the rendering on or off was pressed. */
  onTogglePreview?: () => void;
}

export interface EditorHandle {
  text(): string;
  /** Replaces the whole text without counting it as an edit by the user. */
  setText(text: string, line?: number): void;
  focus(): void;
  /** Colours again, after the vocabulary changed. */
  refresh(): void;
  /** Shows Markdown rendered, raw only where the cursor is (or raw everywhere when off). */
  setLivePreview(on: boolean): void;
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

/** Where the link under `pos` points: `[text](target)` or a bare address. */
function linkDestAt(state: EditorState, pos: number): string | null {
  for (let node = syntaxTree(state).resolveInner(pos, 0) as { name: string; from: number; to: number; parent: unknown } | null; node; ) {
    if (node.name === "Link") {
      const url = (node as unknown as { getChild(name: string): { from: number; to: number } | null }).getChild("URL");
      return url ? state.sliceDoc(url.from, url.to) : null;
    }
    if (node.name === "URL" || node.name === "Autolink") return state.sliceDoc(node.from, node.to).replace(/^<|>$/g, "");
    node = node.parent as typeof node;
  }
  return null;
}

function options(
  vocab: VocabEntry[],
  query: string,
  apply: (concept: string) => string,
  linkText?: string,
): Completion[] {
  const found = suggest(vocab, query);
  return (linkText === undefined ? found : slugFirst(found, linkText, query)).map((s) => ({
    label: s.concept,
    detail: s.detail,
    apply: apply(s.concept),
  }));
}

/** The text of the link whose target starts at `at` (the `]` before it), if the `[` is on the line. */
function linkTextBefore(state: EditorState, at: number): string | undefined {
  const line = state.doc.lineAt(at);
  const before = line.text.slice(0, at - line.from);
  const open = before.lastIndexOf("[");
  return open < 0 ? undefined : before.slice(open + 1);
}

function completions(vocab: () => VocabEntry[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const link = context.matchBefore(/\]\([^)\s]*/);
    if (link) {
      const typed = link.text.slice(2).replace(/^\//, "").replace(/\.md$/, "");
      return {
        from: link.from + 2,
        filter: false,
        options: options(vocab(), typed, (c) => `/${c}.md`, linkTextBefore(context.state, link.from)),
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
  const preview = new Compartment();
  let previewOn = opts.livePreview === true;

  /** Scrolls to the heading that `#anchor` points to, and puts the cursor there. */
  const goToAnchor = (anchor: string): void => {
    const lines: number[] = [];
    syntaxTree(view.state).iterate({
      enter: (node) => {
        if (/^(ATX|Setext)Heading\d$/.test(node.name)) lines.push(view.state.doc.lineAt(node.from).number);
      },
    });
    const texts = lines.map((n) => headingText(view.state.doc.line(n).text));
    const found = findAnchor(texts, anchor);
    const line = found < 0 ? undefined : lines[found];
    if (line === undefined) return;
    const at = view.state.doc.line(line).from;
    view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "start", yMargin: 16 }) });
  };

  /** Pictures in the notes folder load through the app; pictures on the web load from there. */
  const imageUrl = (dest: string): string | null => {
    if (/^https:\/\//i.test(dest)) return dest;
    const local = localTarget(dest, opts.pageDir());
    if (local === null) return null;
    return `tessela-file://notes/${local.split("/").map(encodeURIComponent).join("/")}`;
  };

  /** A concept page opens in the editor, a web or mail address in the system's own program. */
  const openDest = (dest: string): void => {
    if (dest.startsWith("#")) return goToAnchor(dest.slice(1));
    const id = linkTargetId(dest, opts.pageDir());
    if (id) opts.onOpenConcept(id);
    else if (/^(https?:|mailto:)/i.test(dest)) opts.onOpenExternal(dest);
  };
  const previewExtension = () => livePreview({ openLink: openDest, imageUrl });
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
        preview.of(previewOn ? previewExtension() : []),
        blockKeymap,
        formatting,
        search({ top: true }),
        Prec.highest(keymap.of(searchKeymap)),
        Prec.highest(
          keymap.of([
            { key: "Mod-l", run: smartLinkCommand },
            // The Super key on Linux and Windows.
            { key: "Meta-l", run: smartLinkCommand },
            {
              key: "Mod-Alt-m",
              run: () => (opts.onTogglePreview?.(), true),
            },
          ]),
        ),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.domEventHandlers({
          focus() {
            opts.onFocus?.();
            return false;
          },
          mousedown(event, v) {
            const modifier = event.ctrlKey || event.metaKey;
            if (!modifier && !previewOn) return false;
            const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos === null) return false;
            const line = v.state.doc.lineAt(pos);
            // A link drawn as text opens with a plain click; one shown as Markdown is being edited.
            const dest = modifier || renderedLine(v, line.number) ? linkDestAt(v.state, pos) : null;
            if (dest !== null) {
              event.preventDefault();
              openDest(dest);
              return true;
            }
            if (!modifier) return false;
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
    setLivePreview(on) {
      previewOn = on;
      view.dispatch({ effects: preview.reconfigure(on ? previewExtension() : []) });
    },
  };
}
