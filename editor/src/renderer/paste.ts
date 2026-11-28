// The one paste handler. `shared/paste.ts` decides what a paste becomes; this applies it as one
// transaction and, for a bare web address, asks the main process for the page's title and
// upgrades the address to a link when it comes (renderer/pasteTitle.ts).

import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import { Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { planPaste } from "../shared/paste";
import { inCode } from "./decorations";
import { dropAddress, pendingAddresses, trackAddress, upgradeAddress } from "./pasteTitle";

const LINKS = new Set(["Link", "Image", "URL", "Autolink", "LinkLabel"]);

function inLink(state: EditorState, pos: number): boolean {
  for (let node = syntaxTree(state).resolveInner(pos, 0) as { name: string; parent: unknown } | null; node; node = node.parent as typeof node) {
    if (LINKS.has(node.name)) return true;
  }
  return false;
}

export function pasting(fetchTitle: (url: string) => Promise<string | null> = (url) => window.tessela.pageTitle(url)): Extension {
  let next = 1;
  return [
    pendingAddresses,
    // Before the Markdown language's own paste handler, which would link several lines, and before the mods'.
    Prec.highest(
      EditorView.domEventHandlers({
        paste(event, view) {
          const { state } = view;
          const data = event.clipboardData;
          if (state.selection.ranges.length !== 1 || data === null) return false;
          const { from, to } = state.selection.main;
          const plan = planPaste({
            plain: data.getData("text/plain"),
            html: data.getData("text/html"),
            types: [...data.types],
            hasFiles: data.files.length > 0,
            selected: state.sliceDoc(from, to),
            before: state.sliceDoc(state.doc.lineAt(from).from, from),
            inCode: inCode(state, from),
            inLink: inLink(state, from),
          });
          if (plan === null) return false;
          event.preventDefault();
          const start = from - plan.back;
          const id = next++;
          view.dispatch({
            changes: { from: start, to, insert: plan.insert },
            selection: { anchor: start + plan.insert.length },
            effects: plan.title === null ? [] : [trackAddress.of({ id, from: start, to: start + plan.insert.length, url: plan.title })],
            scrollIntoView: true,
            userEvent: "input.paste",
          });
          if (plan.title !== null) {
            const done = (title: string | null) => {
              try {
                const spec = title === null ? { effects: dropAddress.of(id) } : upgradeAddress(view.state, id, title);
                if (spec !== null) view.dispatch(spec);
              } catch {
                // The view went away while the page answered.
              }
            };
            fetchTitle(plan.title).then(done, () => done(null));
          }
          return true;
        },
      }),
    ),
  ];
}
