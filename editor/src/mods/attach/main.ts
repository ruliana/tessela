// The attach mod: a file pasted or dropped into a page is stored with `tessela attach` and linked
// at the cursor. The bytes go to the tool as they are (ctx.cli takes them as input); the page
// changes only by the link being typed into the editor, like anything else the person writes.

import type { ModContext } from "../../renderer/mods";
import { extensionOf, linkFor } from "./plan";

type Attached = { ok: true; link: string } | { ok: false; error: { message: string } };

export default function (ctx: ModContext): void {
  /** Stores each file for `page` and returns the Markdown to insert, one link per line, or null when nothing could be stored. */
  async function store(page: string, files: File[]): Promise<{ text: string; cursor: number } | null> {
    const links: { text: string; cursor: number }[] = [];
    for (const file of files) {
      const ext = extensionOf(file.name, file.type);
      const argv = ["attach", page, ...(ext ? ["--ext", ext] : [])];
      const answer = (await ctx.cli(argv, { input: new Uint8Array(await file.arrayBuffer()) })) as Attached;
      if (!answer.ok) {
        ctx.ui.toast(`Could not attach ${file.name || "the file"}: ${answer.error.message}`);
        continue;
      }
      links.push(linkFor(file.name, file.type, answer.link));
    }
    const [first] = links;
    return first ? { text: links.map((l) => l.text).join("\n"), cursor: first.cursor } : null;
  }

  function attach(event: ClipboardEvent | DragEvent, view: import("@codemirror/view").EditorView, at: () => number): boolean {
    const data = event instanceof ClipboardEvent ? event.clipboardData : event.dataTransfer;
    const files = [...(data?.files ?? [])];
    const page = ctx.pages.current();
    if (files.length === 0 || page === null) return false;
    // Copying cells or a page of text can bring a picture along with the words; the words win.
    const text = (data?.getData("text/plain") ?? "").trim();
    if (text !== "" && !files.some((f) => f.name === text)) return false;
    event.preventDefault();
    const from = at();
    void store(page, files).then((made) => {
      if (!made) return;
      const doc = view.state.doc.length;
      const [start, end] = event instanceof ClipboardEvent ? [view.state.selection.main.from, view.state.selection.main.to] : [Math.min(from, doc), Math.min(from, doc)];
      view.dispatch({
        changes: { from: start, to: end, insert: made.text },
        selection: { anchor: start + made.cursor },
        userEvent: "input.paste",
      });
      view.focus();
    });
    return true;
  }

  ctx.editor.extend(
    ctx.cm.view.EditorView.domEventHandlers({
      paste: (event, view) => attach(event, view, () => view.state.selection.main.from),
      drop: (event, view) => attach(event, view, () => view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.from),
    }),
  );
}
