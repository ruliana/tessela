// Code fences that a mod draws (ctx.fences.add): under every closed fence whose info string a mod
// has a renderer for, the editor shows what the renderer gives for the fence's body. It is a block
// widget, so nothing is written to the page. The widget asks again when the body changes (after a
// short pause, so typing does not start a run per key) and when the notes change on disk.

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";

import type { FenceRender } from "../shared/mods";

/** A closed code fence with an info string: where the drawing goes, and what to draw it from. */
export interface FenceAt {
  info: string;
  body: string;
  /** The end of the closing line. */
  end: number;
}

export function fencesIn(state: EditorState): FenceAt[] {
  const found: FenceAt[] = [];
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  tree.iterate({
    enter: (node) => {
      if (node.name !== "FencedCode") return;
      const marks = node.node.getChildren("CodeMark");
      const infoNode = node.node.getChild("CodeInfo");
      if (marks.length >= 2 && infoNode) {
        const info = state.sliceDoc(infoNode.from, infoNode.to).trim().split(/\s+/)[0] ?? "";
        const body = node.node.getChildren("CodeText").map((t) => state.sliceDoc(t.from, t.to)).join("\n");
        found.push({ info, body, end: state.doc.lineAt(marks[marks.length - 1]!.to).to });
      }
      return false;
    },
  });
  return found;
}

/** Waits this long (ms) after a change of the fence's body before asking again. */
const PAUSE = 200;

interface Pending {
  timer?: ReturnType<typeof setTimeout>;
  run: number;
}
const pending = new WeakMap<HTMLElement, Pending>();

function asNode(result: unknown): Node {
  return result instanceof Node ? result : document.createTextNode(String(result ?? ""));
}

class FenceWidget extends WidgetType {
  constructor(
    readonly info: string,
    readonly body: string,
    readonly path: string,
    readonly render: FenceRender,
    readonly generation: number,
  ) {
    super();
  }

  override eq(other: FenceWidget): boolean {
    return other.info === this.info && other.body === this.body && other.path === this.path && other.generation === this.generation;
  }

  override toDOM(): HTMLElement {
    const dom = document.createElement("div");
    dom.className = "tessela-live";
    dom.dataset.fence = this.info;
    this.fill(dom, 0);
    return dom;
  }

  /** The same kind of widget with something new to show: keep what is there until the answer comes. */
  override updateDOM(dom: HTMLElement): boolean {
    this.fill(dom, PAUSE);
    return true;
  }

  override destroy(dom: HTMLElement): void {
    const p = pending.get(dom);
    if (p) {
      clearTimeout(p.timer);
      p.run++;
    }
  }

  private fill(dom: HTMLElement, delay: number): void {
    const p = pending.get(dom) ?? { run: 0 };
    pending.set(dom, p);
    clearTimeout(p.timer);
    const run = ++p.run;
    p.timer = setTimeout(async () => {
      let content: Node;
      try {
        content = asNode(await this.render({ body: this.body, path: this.path }));
      } catch (e) {
        content = Object.assign(document.createElement("div"), { className: "tessela-error", textContent: e instanceof Error ? e.message : String(e) });
      }
      if (p.run === run) dom.replaceChildren(content);
    }, delay);
  }

  override get estimatedHeight(): number {
    return 24;
  }
}

const refresh = StateEffect.define<number>();
const views = new Set<EditorView>();
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Draws every fence again (the notes changed): the editors ask their renderers once more, soon. */
export function refreshFences(delay = 300): void {
  clearTimeout(timer);
  timer = setTimeout(() => {
    generation++;
    for (const v of views) v.dispatch({ effects: refresh.of(generation) });
  }, delay);
}

/** The extension that draws the fences of one editor, for the page at `path`. */
export function fenceExtension(path: string, lookup: (info: string) => FenceRender | undefined): Extension {
  interface Drawn {
    generation: number;
    decorations: DecorationSet;
  }
  const draw = (state: EditorState, gen: number): Drawn => {
    const ranges = [];
    for (const f of fencesIn(state)) {
      const render = lookup(f.info);
      if (render) ranges.push(Decoration.widget({ widget: new FenceWidget(f.info, f.body, path, render, gen), block: true, side: 1 }).range(f.end));
    }
    return { generation: gen, decorations: Decoration.set(ranges, true) };
  };
  const field = StateField.define<Drawn>({
    create: (state) => draw(state, generation),
    update(value, tr) {
      const gen = tr.effects.reduce((g, e) => (e.is(refresh) ? e.value : g), value.generation);
      if (!tr.docChanged && gen === value.generation && syntaxTree(tr.state) === syntaxTree(tr.startState)) return value;
      return draw(tr.state, gen);
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
  });
  const known = ViewPlugin.fromClass(
    class {
      constructor(readonly view: EditorView) {
        views.add(view);
      }
      destroy(): void {
        views.delete(this.view);
      }
    },
  );
  return [field, known];
}
