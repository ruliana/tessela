// The text editor: Markdown with the Tessela conventions on top (spec §11).

import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  autocompletion,
  startCompletion,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { languages } from "@codemirror/language-data";
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
import type { SyntaxNode } from "@lezer/common";
import { tags as t } from "@lezer/highlight";

import type { VocabEntry } from "../shared/api";
import { suggest } from "../shared/complete";
import { type LinkChoice, type LinkPage, bracketSearch, choicesFor, markdownLink } from "../shared/linkFlows";
import { conceptAt, findAnchor, headingText, linkTargetId, localTarget } from "../shared/links";
import { dayAt } from "../shared/dates";
import type { PropertiesOverride } from "../shared/mods";
import { journalDest } from "../shared/pages";
import { smartLink } from "../shared/smartLink";
import { blockKeymap, leaveFocus } from "./blockKeys";
import { isSelecting } from "./selectMode";
import { inCode, queryableMarks, refreshDecorations } from "./decorations";
import { findBox } from "./findPanel";
import { formatting } from "./formatKeys";
import { pasting } from "./paste";
import { focusMarks, livePreview } from "./livePreview";
import { isDrawn, revealPolicy } from "./reveal";
import { sentenceMarks } from "./sentenceFocus";
import { slashSource } from "./slash";
import { typewriter } from "./typewriter";
import { stickyHeadings } from "./headingPath";
import { pageLanguage, pageModel } from "./pageModelField";
import { bodyStart } from "../shared/properties";

export interface EditorOptions {
  vocab: () => VocabEntry[];
  /** The pages (and unwritten concepts) a link can point to, with their titles. */
  pages: () => LinkPage[];
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
  /** The name of the open page, for a title when the front matter has none. */
  pageName?: () => string;
  /** Starts with Markdown rendered outside the block being edited. */
  livePreview?: boolean;
  /** The key for switching the rendering on or off was pressed. */
  onTogglePreview?: () => void;
  /** Extensions mods add to every editor. */
  extensions?: () => Extension[];
  /** What a mod draws in place of the front matter, when one does. */
  properties?: () => PropertiesOverride | undefined;
  /** The path of the page the editor shows. */
  pagePath?: () => string;
  /** Escape has nothing left to widen: leave focus mode if it is on, and say whether it was. */
  onLeaveFocus?: () => boolean;
  /** Blocks were selected (select mode began) or the selection ended. */
  onSelectMode?: (on: boolean) => void;
  /** Whether focus mode dims all but the current sentence (asked at every change; `refresh()` asks again). Off when absent. */
  sentenceFocus?: () => boolean;
  /** Whether typewriter scrolling is on (asked at every keystroke); on when absent. */
  typewriter?: () => boolean;
}

export interface EditorHandle {
  /** The CodeMirror view, for commands that mods run. */
  readonly view: EditorView;
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
  { tag: t.heading1, color: "var(--heading)", fontFamily: "var(--serif)", fontWeight: "600", fontSize: "1.85em", letterSpacing: "-0.01em" },
  { tag: t.heading2, color: "var(--heading)", fontFamily: "var(--serif)", fontWeight: "600", fontSize: "1.45em", letterSpacing: "-0.01em" },
  { tag: t.heading3, color: "var(--heading)", fontFamily: "var(--serif)", fontWeight: "600", fontSize: "1.2em" },
  { tag: [t.heading4, t.heading5, t.heading6], color: "var(--heading)", fontFamily: "var(--serif)", fontWeight: "600" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--muted)" },
  { tag: t.link, color: "var(--text)", textDecoration: "underline", textDecorationColor: "var(--accent)", textDecorationThickness: "1.5px", textUnderlineOffset: "3px" },
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

/** The link under `pos`: where it points, and the text that is the link: `[text](target)` or a bare address. */
function linkAt(state: EditorState, pos: number): { dest: string; from: number; to: number } | null {
  for (let node = syntaxTree(state).resolveInner(pos, 0) as SyntaxNode | null; node; node = node.parent) {
    if (node.name === "Link") {
      const url = node.getChild("URL");
      return url ? { dest: state.sliceDoc(url.from, url.to), from: node.from, to: node.to } : null;
    }
    if (node.name === "URL" || node.name === "Autolink") return { dest: state.sliceDoc(node.from, node.to).replace(/^<|>$/g, ""), from: node.from, to: node.to };
  }
  return null;
}

function options(vocab: VocabEntry[], query: string, apply: (concept: string) => string): Completion[] {
  return suggest(vocab, query).map((s) => ({ label: s.concept, detail: s.detail, apply: apply(s.concept) }));
}

/** The text of the link whose target starts at `at` (the `]` before it), if the `[` is on the line. */
function linkTextBefore(state: EditorState, at: number): string | undefined {
  const line = state.doc.lineAt(at);
  const before = line.text.slice(0, at - line.from);
  const open = before.lastIndexOf("[");
  return open < 0 ? undefined : before.slice(open + 1);
}

function choiceOptions(choices: LinkChoice[], take: (view: EditorView, choice: LinkChoice) => void): Completion[] {
  return choices.map((c) => ({
    label: c.text,
    detail: c.fresh ? "new page" : c.dest.slice(1),
    apply: (view: EditorView) => take(view, c),
  }));
}

/** Addresses and anchors typed after `](` are not pages to look for. */
const NOT_A_PAGE = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|#|\.{1,2}\/|~)/;

function completions(vocab: () => VocabEntry[], pages: () => LinkPage[]) {
  return (context: CompletionContext): CompletionResult | null => {
    // Spaces are allowed while searching: a title is typed as it is written, and a target never has one.
    const link = context.matchBefore(/\]\([^)\n]*/);
    if (link) {
      const raw = link.text.slice(2);
      if (NOT_A_PAGE.test(raw)) return null;
      const label = linkTextBefore(context.state, link.from);
      const typed = raw.replace(/^\//, "").replace(/\.md$/, "");
      // Nothing typed yet: look for the page by the link text, so `[Daily TODO](` offers it first.
      const query = typed !== "" ? typed : (label ?? "");
      return {
        from: link.from + 2,
        filter: false,
        options: choiceOptions(choicesFor(pages(), query, 12), (view, c) => {
          // The rest of the target (and the `)` closeBrackets added) is replaced with it.
          const after = view.state.sliceDoc(context.pos, view.state.doc.lineAt(context.pos).to);
          const close = after.indexOf(")");
          const tail = close >= 0 && !/\s/.test(after.slice(0, close)) ? close + 1 : 0;
          // A link with no text takes the title of the page.
          const fill = label === "" ? c.text : "";
          const dest = `${c.dest})`;
          view.dispatch({
            changes: [...(fill ? [{ from: link.from, insert: fill }] : []), { from: link.from + 2, to: context.pos + tail, insert: dest }],
            selection: { anchor: link.from + 2 + fill.length + dest.length },
            userEvent: "input.complete",
          });
        }),
      };
    }
    // A single `[` and a few letters: the page is picked, and the link written with its title.
    const line = context.state.doc.lineAt(context.pos);
    const bracket = bracketSearch(line.text.slice(0, context.pos - line.from), line.text.slice(context.pos - line.from));
    if (bracket && !inCode(context.state, context.pos)) {
      const open = line.from + bracket.start;
      return {
        from: open + 1,
        filter: false,
        options: choiceOptions(choicesFor(pages(), bracket.query, 12), (view, c) => {
          const text = markdownLink(c.text, c.dest);
          view.dispatch({
            changes: { from: open, to: context.pos + bracket.closing, insert: text },
            selection: { anchor: open + text.length },
            userEvent: "input.complete",
          });
        }),
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
        if (/^ATXHeading\d$/.test(node.name)) lines.push(view.state.doc.lineAt(node.from).number);
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
  const previewExtension = () =>
    livePreview({
      openLink: openDest,
      imageUrl,
      pageName: opts.pageName ?? (() => ""),
      pagePath: opts.pagePath ?? (() => ""),
      properties: opts.properties ?? (() => undefined),
      view: () => view,
    });
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "",
      extensions: [
        history(),
        drawSelection(),
        EditorView.lineWrapping,
        // Markdown (with tables and task lists) and Tessela's own syntax (front matter, callouts,
        // footnotes, math) in one parser, and code in the languages that fenced blocks name.
        pageLanguage(languages),
        pageModel,
        stickyHeadings,
        revealPolicy(),
        syntaxHighlighting(highlight),
        autocompletion({ override: [completions(opts.vocab, opts.pages), slashSource], icons: false }),
        queryableMarks({ pageDir: opts.pageDir, written: opts.written }),
        focusMarks(),
        sentenceMarks(opts.sentenceFocus ?? (() => false)),
        typewriter(opts.typewriter ?? (() => true)),
        preview.of(previewOn ? previewExtension() : []),
        blockKeymap,
        opts.onLeaveFocus ? leaveFocus.of(opts.onLeaveFocus) : [],
        formatting,
        pasting(),
        // What mods add comes before the defaults below, so their keys win over them.
        ...(opts.extensions?.() ?? []),
        findBox(),
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
            // A link drawn as text opens with a plain click; one shown as Markdown is being edited,
            // and a click there places the cursor. (A click on selected blocks edits them, like any
            // click: it does not follow a link. The reveal policy says what is drawn.)
            const selecting = isSelecting(v.state);
            const link = linkAt(v.state, pos);
            const dest = link && (modifier || (!selecting && isDrawn(v.state, link))) ? link.dest : null;
            if (dest !== null) {
              event.preventDefault();
              openDest(dest);
              return true;
            }
            // A date leads to its journal day: with a plain click where it is drawn, with Ctrl/Cmd
            // where it is being edited. Dates in code are only text.
            const day = dayAt(line.text, pos - line.from);
            const dayDrawn = day !== null && !selecting && isDrawn(v.state, { from: line.from + day.from, to: line.from + day.to });
            if (day !== null && (modifier || dayDrawn) && !inCode(v.state, line.from + day.from)) {
              event.preventDefault();
              openDest(journalDest(day.day));
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
          const was = isSelecting(update.startState);
          if (was !== isSelecting(update.state)) opts.onSelectMode?.(!was);
        }),
      ],
    }),
  });

  return {
    view,
    text: () => view.state.doc.toString(),
    setText(text, line) {
      // A page opens with the cursor in its text, not in the front matter.
      const keep = view.state.doc.length === 0 ? bodyStart(text) : Math.min(view.state.selection.main.head, text.length);
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
