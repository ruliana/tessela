// The page model as editor state: one `PageModel` for each version of the document, built from the
// syntax tree that the Markdown language keeps (see `shared/pageModel.ts`). It is rebuilt when the
// text changes and when the parser reaches further into the page, and not on a selection change, so
// every reader gets the same object for the same page until it is edited.

import { markdown } from "@codemirror/lang-markdown";
import { type LanguageDescription, syntaxTree } from "@codemirror/language";
import { type Extension, StateField } from "@codemirror/state";
import { GFM, type MarkdownExtension } from "@lezer/markdown";

import { type PageModel, pageModelOf } from "../shared/pageModel";
import { frontMatterYaml, noSetext, tessela } from "../shared/syntax";

/** The Markdown dialect of a page: CommonMark and GFM, `#` headings only, and Tessela's own syntax. */
export const pageSyntax: MarkdownExtension[] = [GFM, noSetext, tessela, frontMatterYaml];

/** The language of the editor, and of whoever reads a page with the same syntax tree. */
export function pageLanguage(codeLanguages?: readonly LanguageDescription[]): Extension {
  return markdown({ codeLanguages: codeLanguages ? [...codeLanguages] : undefined, extensions: pageSyntax });
}

/** The structure of the page: `state.field(pageModel)`. */
export const pageModel = StateField.define<PageModel>({
  create: pageModelOf,
  update(model, tr) {
    if (!tr.docChanged && syntaxTree(tr.state) === model.tree) return model;
    return pageModelOf(tr.state);
  },
});
