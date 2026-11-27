// The page model as editor state: one `PageModel` for each version of the document, built from the
// syntax tree that the Markdown language keeps (see `shared/pageModel.ts`). It is rebuilt when the
// text changes and when the parser reaches further into the page, and not on a selection change, so
// every reader gets the same object for the same page until it is edited.

import { markdown } from "@codemirror/lang-markdown";
import { type LanguageDescription, ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, StateField } from "@codemirror/state";
import { GFM, type MarkdownExtension } from "@lezer/markdown";

import { noSetext } from "../shared/blocks";
import { type PageModel, buildPageModel } from "../shared/pageModel";
import { frontMatterYaml, tessela } from "../shared/syntax";

/** The Markdown dialect of a page: CommonMark and GFM, `#` headings only, and Tessela's own syntax. */
export const pageSyntax: MarkdownExtension[] = [GFM, noSetext, tessela, frontMatterYaml];

/** The language of the editor, and of whoever reads a page with the same syntax tree. */
export function pageLanguage(codeLanguages?: readonly LanguageDescription[]): Extension {
  return markdown({ codeLanguages: codeLanguages ? [...codeLanguages] : undefined, extensions: pageSyntax });
}

/** How long to wait for the parser to reach the end of the page when the model is made. */
const PARSE_BUDGET_MS = 50;

function modelOf(state: EditorState): PageModel {
  const whole = ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET_MS);
  return buildPageModel(state.doc, whole ?? syntaxTree(state), whole !== null);
}

/** The structure of the page: `state.field(pageModel)`. */
export const pageModel = StateField.define<PageModel>({
  create: modelOf,
  update(model, tr) {
    if (!tr.docChanged && syntaxTree(tr.state) === model.tree) return model;
    return modelOf(tr.state);
  },
});
