// A page model for a text, made the way the editor makes it.

import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";

import { pageLanguage, pageModel } from "../../src/renderer/pageModelField";
import type { PageModel, PageNode } from "../../src/shared/pageModel";

export function stateOf(text: string): EditorState {
  return EditorState.create({ doc: text, extensions: [pageLanguage(), pageModel] });
}

/**
 * The model of a state once the parser has reached the end of the page, as it has after a moment in
 * the window. A model made at once is partial when the parser runs out of its short budget, which
 * a slow machine does on any page: a test that compares two models must not depend on the speed.
 */
export function settled(state: EditorState): PageModel {
  const model = state.field(pageModel);
  if (model.complete) return model;
  ensureSyntaxTree(state, state.doc.length, 60_000);
  return state.update({}).state.field(pageModel);
}

export function modelOf(text: string): PageModel {
  return settled(stateOf(text));
}

/** The tree as indented lines: `kind first-last`, for reading a failure. */
export function outline(model: PageModel): string {
  const out: string[] = [];
  const walk = (n: PageNode, depth: number) => {
    out.push(n === model.root ? "page" : `${"  ".repeat(depth)}${n.kind} ${n.startLine}-${n.endLine}`);
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(model.root, 0);
  return out.join("\n");
}
