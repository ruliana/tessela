// A page model for a text, made the way the editor makes it.

import { EditorState } from "@codemirror/state";

import { pageLanguage, pageModel } from "../../src/renderer/pageModelField";
import type { PageModel, PageNode } from "../../src/shared/pageModel";

export function stateOf(text: string): EditorState {
  return EditorState.create({ doc: text, extensions: [pageLanguage(), pageModel] });
}

export function modelOf(text: string): PageModel {
  return stateOf(text).field(pageModel);
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
