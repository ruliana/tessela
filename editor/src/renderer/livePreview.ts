// Live preview: Markdown shown rendered, and raw only where the cursor is. Like the
// editing mode of Logseq, the block being edited (a paragraph, a heading, a list item)
// shows its marks and everything else hides them. The text itself never changes, so
// saving, searching and the tools see the same Markdown as always.

import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";

class Glyph extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly cls: string,
  ) {
    super();
  }
  override eq(other: Glyph): boolean {
    return other.text === this.text && other.cls === this.cls;
  }
  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = this.cls;
    span.textContent = this.text;
    return span;
  }
}

const hide = Decoration.replace({});
const bullet = Decoration.replace({ widget: new Glyph("•", "cm-lp-bullet") });
const unchecked = Decoration.replace({ widget: new Glyph("☐", "cm-lp-check") });
const checked = Decoration.replace({ widget: new Glyph("☑", "cm-lp-check cm-lp-checked") });
const rule = Decoration.replace({ widget: new Glyph("", "cm-lp-rule") });
const quoteLine = Decoration.line({ class: "cm-lp-quote" });
const inlineCode = Decoration.mark({ class: "cm-lp-code" });
const doneTask = Decoration.mark({ class: "cm-lp-done" });
const linkText = Decoration.mark({ class: "cm-lp-link" });

const HEADING = /^ATXHeading[1-6]$/;

/** The lines (1-based) of the blocks that hold the selection: these are shown raw. */
function editedLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  const tree = syntaxTree(state);
  const addBlock = (pos: number) => {
    for (let node = tree.resolveInner(pos, 0) as { name: string; from: number; to: number; parent: unknown } | null; node; ) {
      // A paragraph that spans several lines is one block.
      if (node.name === "Paragraph") {
        for (let n = state.doc.lineAt(node.from).number; n <= state.doc.lineAt(node.to).number; n++) lines.add(n);
        return;
      }
      node = node.parent as typeof node;
    }
  };
  for (const { from, to } of state.selection.ranges) {
    for (let n = state.doc.lineAt(from).number; n <= state.doc.lineAt(to).number; n++) lines.add(n);
    addBlock(from);
    addBlock(to);
  }
  return lines;
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const raw = view.hasFocus ? editedLines(state) : new Set<number>();
  const ranges: Range<Decoration>[] = [];
  const lineOf = (pos: number) => state.doc.lineAt(pos).number;
  /** Hides `from` to `to`, and the space after it when `space` is set. */
  const hideMark = (from: number, to: number, space = false, deco: Decoration = hide) => {
    if (space && state.sliceDoc(to, to + 1) === " ") to++;
    if (to > from) ranges.push(deco.range(from, to));
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (ref) => {
        const name = ref.name;
        const line = lineOf(ref.from);
        if (name === "FencedCode" || name === "CodeBlock" || name === "Table") return false;
        if (raw.has(line)) return;
        if (name === "HorizontalRule") {
          ranges.push(rule.range(ref.from, ref.to));
        } else if (name === "InlineCode") {
          if (raw.has(lineOf(ref.to))) return;
          ranges.push(inlineCode.range(ref.from, ref.to));
        } else if (name === "CodeMark") {
          if (ref.node.parent?.name === "InlineCode") hideMark(ref.from, ref.to);
        } else if (name === "QuoteMark") {
          ranges.push(quoteLine.range(state.doc.line(line).from));
          hideMark(ref.from, ref.to, true);
        } else if (name === "ListMark") {
          // Ordered lists keep their numbers.
          if (ref.node.parent?.parent?.name === "BulletList") {
            ranges.push(bullet.range(ref.from, ref.to));
          }
        } else if (name === "TaskMarker") {
          const done = /\[[xX]\]/.test(state.sliceDoc(ref.from, ref.to));
          ranges.push((done ? checked : unchecked).range(ref.from, ref.to));
          const task = ref.node.parent;
          if (done && task && task.to > ref.to) ranges.push(doneTask.range(ref.to, task.to));
        } else if (name === "HeaderMark") {
          if (HEADING.test(ref.node.parent?.name ?? "")) hideMark(ref.from, ref.to, true);
        } else if (name === "EmphasisMark" || name === "StrikethroughMark") {
          hideMark(ref.from, ref.to);
        } else if (name === "Link" || name === "Image") {
          const open = ref.node.getChild("URL") ? ref.node.getChild("LinkMark") : null;
          const close = open?.nextSibling;
          if (open && close && close.to > open.to) ranges.push(linkText.range(open.to, close.from));
        } else if (name === "LinkMark" || name === "URL" || name === "LinkTitle") {
          // Only links written inline, [text](target): a reference [text][ref] stays as typed.
          const parent = ref.node.parent;
          if ((parent?.name === "Link" || parent?.name === "Image") && parent.getChild("URL")) hideMark(ref.from, ref.to);
        }
      },
    });
  }
  return Decoration.set(ranges, true);
}

export function livePreview(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(update: ViewUpdate) {
        const tree = syntaxTree(update.startState) !== syntaxTree(update.state);
        if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged || tree) {
          this.decorations = build(update.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}
