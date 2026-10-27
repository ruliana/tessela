// Colours what the tools can find (tags, concept links, dates) and gives code blocks a
// background. Code inside blocks and inline code is left alone: `#include` is not a tag.

import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, StateEffect } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

import { frontmatterEnd } from "../shared/blocks";
import { type Token, frontmatterTags, inlineTokens } from "../shared/tokens";

/** Dispatch this when what the decorations depend on (the vocabulary) has changed. */
export const refreshDecorations = StateEffect.define<null>();

const CODE = new Set(["FencedCode", "CodeBlock", "InlineCode", "CodeText", "CodeInfo", "CodeMark"]);

function inCode(state: EditorState, pos: number): boolean {
  for (let node = syntaxTree(state).resolveInner(pos, 1) as { name: string; parent: unknown } | null; node; ) {
    if (CODE.has(node.name)) return true;
    node = node.parent as typeof node;
  }
  return false;
}

export interface DecorationOptions {
  /** Folder of the open page, for resolving relative links. */
  pageDir: () => string;
  /** Concepts that have a page. Null when that is not known, so nothing is called unwritten. */
  written: () => Set<string> | null;
}

const marks = {
  tag: Decoration.mark({ class: "cm-tag" }),
  tagNew: Decoration.mark({ class: "cm-tag cm-unwritten" }),
  concept: Decoration.mark({ class: "cm-concept" }),
  conceptNew: Decoration.mark({ class: "cm-concept cm-unwritten" }),
  file: Decoration.mark({ class: "cm-file" }),
  date: Decoration.mark({ class: "cm-date" }),
  datetime: Decoration.mark({ class: "cm-date cm-datetime" }),
};

const blockLine = Decoration.line({ class: "cm-codeblock" });

export function queryableMarks(opts: DecorationOptions): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(update: ViewUpdate) {
        const tree = syntaxTree(update.startState) !== syntaxTree(update.state);
        const refresh = update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshDecorations)));
        if (update.docChanged || update.viewportChanged || tree || refresh) {
          this.decorations = this.build(update.view);
        }
      }
      build(view: EditorView): DecorationSet {
        const { state } = view;
        const written = opts.written();
        const ranges = [];
        // The tags of the front matter tag the page itself.
        const head = Array.from({ length: Math.min(state.doc.lines, 200) }, (_, i) => state.doc.line(i + 1).text);
        const fmEnd = frontmatterEnd(head);
        const pageTags = fmEnd > 0 ? frontmatterTags(head, fmEnd) : new Map<number, Token[]>();
        for (const { from, to } of view.visibleRanges) {
          for (let pos = from; pos <= to; ) {
            const line = state.doc.lineAt(pos);
            const own = pageTags.get(line.number - 1) ?? [];
            for (const t of [...own, ...inlineTokens(line.text, opts.pageDir())]) {
              if (own.length === 0 && inCode(state, line.from + t.from)) continue;
              const missing = written !== null && t.id !== undefined && !written.has(t.id);
              const mark =
                t.kind === "tag" ? (missing ? marks.tagNew : marks.tag)
                : t.kind === "concept" ? (missing ? marks.conceptNew : marks.concept)
                : t.kind === "file" ? marks.file
                : t.kind === "datetime" ? marks.datetime
                : marks.date;
              ranges.push(mark.range(line.from + t.from, line.from + t.to));
            }
            pos = line.to + 1;
          }
          syntaxTree(state).iterate({
            from,
            to,
            enter: (node) => {
              if (node.name !== "FencedCode" && node.name !== "CodeBlock") return;
              for (let n = state.doc.lineAt(node.from).number; n <= state.doc.lineAt(node.to).number; n++) {
                ranges.push(blockLine.range(state.doc.line(n).from));
              }
              return false;
            },
          });
        }
        return Decoration.set(ranges, true);
      }
    },
    { decorations: (v) => v.decorations },
  );
}
