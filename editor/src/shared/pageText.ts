// The page model of a text that is not in an editor: the lines a command has just produced, a note
// read from disk. It is the same Markdown dialect the editor reads a page with (`pageSyntax` in
// renderer/pageModelField.ts, minus the YAML in the front matter, which changes no structure) and the
// same `buildPageModel`, so there is still one reading of a page.

import { Text } from "@codemirror/state";
import { GFM, parser } from "@lezer/markdown";

import { type PageModel, buildPageModel } from "./pageModel";
import { noSetext, tessela } from "./syntax";

const markdown = parser.configure([GFM, noSetext, tessela]);

/** The model of `text`. */
export function parsePage(text: string): PageModel {
  const doc = Text.of(text.split(/\r\n?|\n/));
  return buildPageModel(doc, markdown.parse(doc.sliceString(0)));
}
