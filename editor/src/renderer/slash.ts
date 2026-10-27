// The `/` menu: a completion source that offers things to insert (shared/slash.ts).

import { type Completion, type CompletionContext, type CompletionResult, startCompletion } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";

import { matchSlash, slashItems } from "../shared/slash";

export function slashSource(context: CompletionContext): CompletionResult | null {
  const typed = context.matchBefore(/(?:^|\s)\/[\p{L} -]*/u);
  if (!typed) return null;
  const slash = typed.from + typed.text.indexOf("/");
  const line = context.state.doc.lineAt(slash);
  const atLineStart = /^\s*(?:[-*+]\s+|\d+[.)]\s+)*$/.test(line.text.slice(0, slash - line.from));
  const items = matchSlash(slashItems(new Date()), typed.text.slice(typed.text.indexOf("/") + 1), atLineStart);
  if (items.length === 0) return null;
  const options: Completion[] = items.map((item) => ({
    label: item.label,
    detail: item.detail,
    apply: (view: EditorView, _c: Completion, from: number, to: number) => {
      view.dispatch({
        changes: { from, to, insert: item.text },
        selection: { anchor: from + item.cursor },
        userEvent: "input.complete",
      });
      if (item.suggest) startCompletion(view);
    },
  }));
  return { from: slash, filter: false, options };
}
