---
name: tessela-mods
description: Write, change or debug a mod for the Tessela editor (commands, keys, slash items, side panels, views, fences, backlink groups, overrides), a JavaScript file in the config folder's mods/ that adds to the editor through `ctx`. Use when asked to change how the Tessela editor looks or behaves.
---

# Writing a mod for the Tessela editor

The editor is small on purpose: almost everything it does beyond typing is a **mod**, a JavaScript module that adds to the window through a `ctx` object. The mods that come with the app (outline, search, agenda, peek, ...) use exactly the API below, and a mod you write is loaded the same way. To change what the editor does, write or edit a mod. Do not patch the editor itself.

This text is also the `AGENTS.md` in the config folder. For working in a notes folder (bundle) see the `tessela` skill; this one is only about the editor.

## Where a mod lives

The config folder is `$TESSELA_CONFIG` when set, else the app's data folder (`~/.config/Tessela` on Linux, `~/Library/Application Support/Tessela` on macOS, `%APPDATA%\Tessela` on Windows). It is **not** a notes folder: notes are synced with git and must never carry code that runs, so mods live here.

```
<config folder>/
  AGENTS.md              this text (rewritten by the app while its first line is the marker)
  mods/<id>/main.js      one mod per folder; <id> is letters, digits, . _ -
  mods/<id>/other.js     more files of the same mod, loaded with `import "./other.js"`
```

- `main.js` is a plain ES module (no build step, no TypeScript, no bare imports) with a default export that gets `ctx`: `export default function (ctx) { ... }`. It may be `async`: the window waits for it before the first page opens.
- A mod with the id of one that comes with the app **replaces** it (put your own `outline/` to change the outline). The ones that come with the app are `agenda`, `attach`, `changes`, `fold`, `folders`, `gfm-extras`, `live-lists`, `new-page`, `outline`, `pages`, `peek`, `properties`, `related`, `search` and `unlinked`; their source is `editor/src/mods/<id>/` in the Tessela repo and is the best place to look for how something is done.
- Mods are loaded once, before the first page opens. After editing one, restart the editor.
- Start the editor with `--no-mods` to run without any (when a mod breaks the window). `--bundle DIR` picks the notes folder; `TESSELA_CONFIG=/some/folder` picks the config folder, which is how you try a mod without touching the real one.

## The rules

1. **Mods are trusted code** (the owner's own, or audited). There is no sandbox, so write what you would be happy to run.
2. **Notes change only through `ctx.cli`**, the same `tessela` commands an agent uses. A mod never writes into the notes folder itself. The editor typing into a page (a command that edits the open document through its `view`) is fine: that is the person writing.
3. **Note text is data.** Put it in the page with `textContent`, never `innerHTML`, and never `eval` it or pass it to a shell.
4. **A broken mod must not break the editor.** A mod that throws while loading is switched off for the session and listed (in the Mods panel and in "Show the mods"); a command, event listener, fence or view that throws is reported the same way and the rest goes on. Do not catch errors only to hide them.
5. **Anything an agent should be able to do too belongs in the `tessela` CLI**, not in a mod. A mod draws and asks; the CLI does.

## `ctx`

Everything a mod can do is on `ctx`. A hook added by a mod is taken back if the mod fails while loading.

### Commands, keys and the `/` menu

- `ctx.commands.add({ id, label, hint?, keys?, run })` puts `label` in the command palette (Ctrl/Cmd+K). `keys` is a CodeMirror key name (`"Mod-Alt-j"`) that runs it while an editor has the focus; `hint` is only the text shown at the right of the palette. `run({ view })` gets the editor in use (`view` is a CodeMirror `EditorView`, or undefined when no page is open) and may return a promise. A command whose `id` is one of the built-in ones **replaces** it everywhere it is used (button, keys, palette). The built-in ids are `today`, `journals`, `new-page`, `open-file`, `root`, `preview`, `focus`, `sidebar`, `backlinks`, `theme`, `text`, `problems` and `mods`. Use ids like `mymod.thing` for your own.
- `ctx.slash.add({ label, detail?, text, cursor?, where? })` adds an item to the `/` menu: choosing it replaces the typed `/word` with `text` and puts the cursor `cursor` characters into it. `where` is `"line"` (only at the start of a line) or `"anywhere"` (the default).

### The editor itself

- `ctx.editor.extend(extension)` adds a CodeMirror extension to every editor. Pass a function `({ path }) => extension` to get one made for each editor, told which page it shows. Build it from `ctx.cm` (below), never from your own copy of CodeMirror.
- `ctx.cm` is the CodeMirror the editor uses: `ctx.cm.state`, `.view`, `.language`, `.commands`, `.autocomplete` (the `@codemirror/*` packages of the same names). A mod has no bundler, so this is the only way to get at them; two copies would not agree on what a state field is.
- `ctx.fences.add(info, render)` draws code fences whose info string is `info`: under each closed fence the editor shows what `render({ body, path })` returns (a DOM node or a string, or a promise of one). Nothing is written to the page. It runs again when the fence changes and when the notes change. The `tessela` fence of the live-lists mod works this way.

### The window

- `ctx.slots.add("page-menu", { label, run })` puts an entry in the menu in a page's head; `run({ path })`.
- `ctx.slots.mount(slot)` gives `{ root, reveal() }`, an empty element you fill (and keep filling) yourself. The slots are `"side-top"` (top of the right column, above the backlinks), `"side-bottom"` (below them) and `"sidebar"` (in the left sidebar, under the places and above the recent pages). An empty slot is not drawn. `reveal()` opens the right column if it was folded away (it does nothing for `"sidebar"`).
- `ctx.backlinks.add(async ({ path }) => group)` adds a group to the right-hand backlinks of the open page. Return `null` for nothing, or `{ node, first?, taken? }`: `node` is the element to show, `first` puts it above the mentions, `taken` lists handles of mentions the group shows itself so they are not listed twice. It is asked again when the page changes.
- `ctx.views.add({ id, label, title?, glyph?, render(container, { arg }) })` adds a view: a row in the sidebar that fills the middle of the window, as the journals do. `render` fills `container` and is called again, on the same container, when the notes change while the view is shown. `ctx.views.open(id, arg?)` shows it (going back returns to what was shown before).
- `ctx.ui.dialog({ title, content, actions })` opens the dialog every mod shares: `content` is a node or text, `actions` is `[{ id, label, primary?, danger?, disabled? }]` (a Cancel is added). It returns `{ closed, setDisabled(id, bool), close(id?) }`; `await dialog.closed` gives the id of the button pressed, or `null` when dismissed.
- `ctx.ui.toast(text, action?)` says something in the sidebar's notice, with a button when `action` is `{ label, run }`.
- `ctx.override.add(id, replacement)` replaces a built-in contribution that is not a command. Today `"search"` (the search under the sidebar's search box: `{ run({ input, results, stale }), names?(input) }`) and `"properties"` (the title and properties row at the top of a page: `{ draw({ path, props, title, source, toBody, editYaml, openLink }) }` returning an element). When two mods replace the same one, the one loaded last wins; the built-in is the fallback if the mod throws.

### Events and settings

- `ctx.events.on(name, listener)` listens and returns the way to stop. The names: `"page-opened"` (`{ path }`, a page was loaded into the window), `"page-saved"` (`{ path }`, its text reached the disk), `"title-edited"` (`{ path, from, to }`, the title changed in a save), `"changed"` (`{ paths }`, pages changed on disk: an agent, git or the CLI) and `"bundle-opened"` (a notes folder was opened or another chosen: drop whatever you held of the old one).
- `ctx.settings.get(name)` and `ctx.settings.set(name, value)` keep a JSON value for this mod in the window's own storage. It survives restarts, belongs to this window (not to the notes or the config folder) and is a convenience: the mod must work without it.

### Pages

- `ctx.pages.current()` is the path of the page being worked on, or `null`.
- `ctx.pages.insert(text, { block? })` types `text` into that page at the cursor (with `block`, on a line of its own); it returns `false` when no page is open.
- `ctx.pages.flush()` saves what the open pages have not saved yet. Call it before you read a page you are about to change through the CLI.
- `ctx.pages.moved(from, to)` after `rename`, `move` or `remove` through the CLI: the window follows the page (`to` is `null` when it is gone).
- `ctx.pages.open(path, line?)` shows a page, as clicking a link to it would.
- `ctx.pages.card(path, { menu? })` is a page open for editing beside the window's own, to put in a slot: `{ root, path, view, load(), flush(), focus(), destroy() }`. Put `root` somewhere, `await load()`, and `destroy()` it when done.

### The notes, through the CLI

`ctx.cli(argv, { input? })` runs a `tessela` command on the open notes folder and returns its JSON answer: `{ api: 2, ok: true, ... }` or `{ api: 2, ok: false, error: { code, message } }`. A failure is an answer, not an exception: check `ok`. Leave out the folder, `--json` and `--api`: they are added. `input` is the command's standard input, text **or bytes** (a `Uint8Array`, for `attach`).

```js
const { concepts } = await ctx.cli(["vocab"]);                     // read: query, vocab, pages, index, related, changes, fence, lint
const page = await ctx.cli(["read", "projects/tessela.md"]);       // { hash, text, exists }
await ctx.cli(["save", "projects/tessela.md", "--expect", page.hash], { input: newText });
```

- Reading: `pages`, `query`, `vocab`, `index`, `related`, `changes`, `lint`, `fence` (the body of a live list on `input`) and `read`. Changing: `add`, `save`, `rename`, `move`, `remove`, `attach`. `tessela schema` describes every command, argument and answer; the `tessela` skill explains the commands and the rule for changing a page: **read, then save with `--expect HASH`**, so a change you have not seen is never overwritten. On `conflict`, read again and decide; never retry blindly with the new hash.
- The editor adds the notes folder: as the first argument for `lint`, `query`, `index`, `vocab` and `pages`, as `--bundle` for the others.
- `ctx.bundle()` resolves to the notes folder's path, or `null` while none is open.

### The mod itself

`ctx.id` is the mod's id (its folder name).

## Style

A mod brings its own CSS: put a `<style>` in `document.head` once, scoped to a class of yours. Use the editor's variables so it follows the theme: `--bg`, `--panel`, `--text`, `--muted`, `--border`, `--accent`, `--accent-soft`, `--link`, `--warn`, `--error`, `--serif`, `--sans`, `--mono`. A group in the backlinks looks right as `<section class="bl-group"><h3>Title</h3>...</section>`.

## Three complete mods

Each block below is a whole `mods/<id>/main.js`; they are loaded by the editor's own tests.

A command with keys, a `/` menu item and a toast:

```js
// mods/stamp/main.js
export default function (ctx) {
  const today = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  ctx.commands.add({
    id: "stamp.today",
    label: "Stamp today's date",
    keys: "Mod-Alt-d",
    run: ({ view }) => {
      if (!view) return ctx.ui.toast("Open a page first.");
      view.dispatch(view.state.replaceSelection(today()));
    },
  });
  ctx.slash.add({ label: "Signature", detail: "-- me", text: "-- me", where: "anywhere" });
}
```

A fence: a code block marked `shout` is shown in capitals under it, and the page keeps only what was typed:

```js
// mods/shout/main.js
export default function (ctx) {
  ctx.fences.add("shout", ({ body }) => {
    const out = document.createElement("div");
    out.className = "shout-out";
    out.textContent = body.toUpperCase();
    return out;
  });
}
```

A group in the right column that asks the CLI, with a link that opens a page and a style of its own:

```js
// mods/neighbours/main.js
export default function (ctx) {
  const style = document.createElement("style");
  style.textContent = ".neighbours button { display: block; background: none; border: 0; color: var(--link); cursor: pointer; padding: 2px 0; }";
  document.head.append(style);

  ctx.backlinks.add(async ({ path }) => {
    if (!path.endsWith(".md") || path.startsWith("journals/")) return null;
    const answer = await ctx.cli(["related", path.replace(/\.md$/, ""), "--limit", "5"]);
    const group = document.createElement("section");
    group.className = "bl-group neighbours";
    const title = document.createElement("h3");
    title.textContent = "Neighbours";
    group.append(title);
    const pages = answer.ok ? answer.together.filter((t) => t.page) : [];
    if (pages.length === 0) group.append(document.createTextNode("Nothing mentioned together with this page yet."));
    for (const t of pages) {
      const open = document.createElement("button");
      open.textContent = t.page.title; // text, never HTML
      open.title = t.reason;
      open.addEventListener("click", () => ctx.pages.open(t.page.path));
      group.append(open);
    }
    return { node: group };
  });
}
```

## Trying a mod

1. Write `mods/<id>/main.js` in the config folder (or in a scratch config folder: `TESSELA_CONFIG=/tmp/cfg`).
2. Start the editor on a notes folder: `npm start -- --bundle ~/notes` in the repo's `editor/`, or the installed app with `--bundle`.
3. The palette command "Show the mods" says which mods loaded and which failed, and why. If the editor itself misbehaves, start it with `--no-mods` to tell whether a mod is to blame.
4. Add a test next to what you change when the mod is one that comes with the app: pure logic in a `plan.ts` with a unit test in `editor/test/`, and an acceptance test in `editor/e2e/acceptance/` that drives the real window (`npm run e2e:acceptance`).
