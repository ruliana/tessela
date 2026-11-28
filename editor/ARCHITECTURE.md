# Editor architecture

Status: the rules below are the target. The editor is being rebuilt to match them
(see [Rebuild order](#rebuild-order)); [Where we stand](#where-we-stand) says which
parts already hold. When code and this note disagree, the code is the thing to fix,
unless the note is wrong, in which case change the note in the same PR.

The editor is an Electron app around CodeMirror 6. Markdown files in the bundle are
the only source of truth, and every save goes through the `tessela` CLI (see
`docs/conventions.md`). Nothing below changes that.

## Why this note exists

The selection and select-mode bugs came back again and again because each part of
the editor answered the same question for itself: what blocks does this page have,
what is selected, what is shown raw, what does Escape do. Each fix landed in a
different layer than the one that was wrong (CSS for a model problem, a mod for a
mode problem, a flag for a selection problem). The root-cause report is at
<https://claude.ai/artifact/SRcKBAhdtfY33XCU7jc8Vo>; it traces PRs #26 to #106 to
five causes, A to E, which the principles below answer.

**The rule that follows from it:** a fix that adds a flag, a second reader of the
page, a CSS class that another layer reads, or a DOM query to find out state is a
design question first. Find which principle is missing and fix that, then fix the
bug as a one-line change on top.

## The seven principles

### 1. One page model, parsed once per document version

There is one `pageModel`: a CodeMirror state field built from the Lezer syntax tree
(Lezer reparses incrementally). It is a read-only tree: page, front matter,
sections, blocks, child blocks. Each node has a kind, a range, a parent and
children. Everything that needs to know the structure of the page reads it:
selection units, folds, zoom, live preview, tables, commands and mods.

- Tessela syntax (front matter, callouts, footnote definitions, `$$` math) is added
  as Lezer extensions, next to the existing `noSetext`. A new syntax is an
  extension plus a node kind, never a new regex scanner.
- No feature parses the page on its own: no `doc.toString().split("\n")`, no line
  regexes for structure, no private inline parser.
- Clipboard HTML is not a page. `shared/htmlToMarkdown.ts` turns it into Markdown text before it
  is inserted, and the page model then reads that text like anything typed; it never reads the page.
- Across edits a node is found again by mapping its position through the change.
  Across sessions its identity is the content hash used for block handles
  (conventions §3).
- `tessela-core` (Rust) is not used at runtime in the editor. It is the **test
  oracle**: a property test generates pages and checks that the model and the Rust
  parser agree on block spans, kinds and parents. Known differences are listed in
  the test.

### 2. Selection is typed state

CodeMirror selections are text ranges only, so block selection is its own state
field: the anchor and head nodes of the page model and the sibling run they make.
Select mode means "this field is set". The CodeMirror selection is a projection of
it, kept in step by the same transaction.

- A block selection is a contiguous run of siblings under one parent; a selected
  block includes its children. Anything else is normalised to the smallest sibling
  run that holds the anchor and the head.
- Never infer "these blocks are selected" from columns, line numbers or a boolean.
- Drawing a selection is one code path (a line decoration and a class for widgets,
  derived from the field), not a per-widget flag.

### 3. Every change is a transaction that maps positions

A command produces a CodeMirror transaction: changes, selection and effects
together. Extensions never recompute positions by hand. A block edit (Tab, Shift+Tab,
Alt+Up/Down, and the outline mod's section move) works out a `BlockEdit`
(`shared/blockEdit.ts`) from the page model: a `ChangeSet` over the text it was worked
out on, and, when text moves, the ranges that went somewhere else. It does not build a
new array of lines and diff it. What the editor keeps about the text follows from that
edit, not from line numbers the edit counted for itself:

- the cursor and the selected blocks are carried by `follow(edit, pos)` (mapping through
  the changes, or along with the range that moved);
- folds travel with the blocks that move (`renderer/blockMoves.ts` reads the `blockMoves`
  annotation of the transaction, and leaves the history what it needs to put them back on
  undo and redo);
- one edit is one transaction, so one undo.

Work that finishes later (a pasted address upgraded to a link with its page title) tracks its
range in a state field (`renderer/pasteTitle.ts`), mapped through every change, and lands as one
transaction of its own, or not at all when the text it was to change is gone.

Code that has just made new text and must read it (the front matter guard after a move,
the blocks to select after a change) reads it with `parsePage`, the same builder.

### 4. Views are pure functions of state, with one reveal policy

Decorations are derived from state. The rule for "raw or rendered?" is written once, in
`renderer/reveal.ts`, and every provider asks it:

- Only the **exact construct under the cursor** shows raw: a bold span, a link, a
  footnote reference, a callout title, the marks of a heading or a list item.
- A **block widget** (table, math block, front matter) opens as a whole when the
  cursor is inside it.
- Everything else stays rendered, including the rest of the block being edited.
- In select mode nothing is raw. An editor without the keyboard focus draws everything.

"Under the cursor" means a selection range touches the construct's own range in the syntax
tree, its ends included, so a cursor right after `**bold**` is still in it. A construct inside
another is raw with it (the cursor in a link inside bold shows both). A line of a quote and a
bullet or checkbox are constructs of their own: the `>` shows on the line the cursor is on, the
bullet while the cursor is at it.

**Revealing does not move the text.** A mark is hidden or raw over the same characters, and
`livePreview.ts` gives both from the same `isEditing` answer, so the set of marks never depends on the
cursor and only the construct that is revealed changes. The raw mark takes no room that the hidden one did
not: a mark at the start of a line (heading `#`, quote `>`) hangs in the margin, a bullet or a checkbox is
raw in the slot of its glyph, and inline code keeps its styling and padding. A link's `[` hangs, and its
address `](target)`, which can be long, is held out of the line (`cm-mk-addr`, positioned under the row of the
link) so that the text after the link neither moves nor wraps anew. Marks inside a line that are short (`**`,
the backticks) are characters of the line and push the rest of that line, and nothing else; a picture or a table that opens as text changes height, as it must. The CSS for this is the
`cm-mk` rules in `style.css`, which nothing reads; `test/revealShift.test.ts` holds the decorations to it and
`e2e/acceptance/reveal.mjs` measures a window. Typewriter scrolling follows the same rule (2026-11-28):
when typing makes the line wrap, the cursor drops a row and the page follows by gliding, not by a jump
(`alongLine`, `typewriter.ts`); the status strip keeps a fixed width for the save state, so the words and
problems next to it do not move when it changes.

The facts the rule reads are kept in one place each: the focus in `editorFocus` (`reveal.ts`),
the mode in `selectMode`, whether the Markdown is drawn at all in the `rendered` facet that live
preview provides. Providers call `isEditing(state, range)` and `isDrawn(state, range)`, and rebuild
when `revealChanged(before, after)` says the selection, the focus, the mode or the preview moved.
A provider does not keep its own copy of any of it, and does not read a CSS class.

Mods ask the editor the same way: `ctx.editor.isEditing(state, range)`,
`ctx.editor.rendered(state)` and `ctx.editor.revealChanged(before, after)`, and read the page
with `ctx.page(state)`. They do not read CSS classes.

### 5. Commands are functions that return a transaction or nothing

A command is `(state) => Transaction | null`, and the wiring runs it. Commands do
not read the DOM, and do not check mode flags in the middle of the handler: the
mode decides which commands a key maps to (principle 6).

### 6. Modes are explicit and transitions are listed

Editing, Selecting and the other modes are values in state. Each key's meaning in
each mode is in one table, and select mode is a pure function
`(state, key) → (state, transaction)`. Escape is resolved in one place, in this
order: an open menu or popup, then widening the block selection (block, parent,
section, page), then leaving focus mode only when there is nothing left to widen.
Select mode exits only through named transitions: Enter, Space, Left, Right, a
typed character, Backspace or Delete when no block is left to select, Escape with
nothing left to widen (and focus mode off), a click, and any edit or selection that
select mode did not make. A menu or popup that is open takes Escape before all that:
it binds the key above the editor's own keys.

### 7. Invariants are tested as properties of the model

Prefer a property test (`fast-check`) to a hand-picked case, and prefer a test on
the model or the state machine to a test that drives a window. The properties that
matter most:

- the page model and `tessela-core` agree on where each block starts and ends;
- every selection unit round-trips through the typed selection;
- from any state and any key, the result is Editing or a valid sibling run;
- the CodeMirror selection covers exactly the selected blocks and never hidden
  lines.

An end-to-end test (`e2e/acceptance/`) is still the right proof that a feature works
in the real window, and not a substitute for the property.

## Decisions log

Decided by Ronie on 2026-11-27.

| Topic | Decision |
| --- | --- |
| Page model | One `pageModel` state field derived from CodeMirror's syntax tree, with Tessela syntax as Lezer extensions. `tessela-core` is the test oracle, not a runtime dependency. |
| Headings | Section nodes that hold the blocks under them. `docs/conventions.md` §3 changes so the index and the editor use the same words (today it says a heading is not a block). |
| Nested blocks | Fences, quotes and callouts inside a list item are child blocks of the item, in the editor and in the Rust index. |
| Oracle data | Rust blocks gain an end line and a kind in the CLI's JSON output (additive), and the property test compares both parsers on them. |
| Reveal policy | Only the exact construct under the cursor is raw; block widgets open whole; nothing is raw in select mode. This replaces today's whole-block reveal. |
| Select mode | Block selection in its own state field, as a run of sibling blocks. Backspace and Delete remove the blocks and stay in select mode (the next block is selected, or the previous at the end of the page). Shift+Down from a last child selects its parent. Escape with the whole page selected leaves focus mode. |
| Select-mode actions | Tab, Shift+Tab and Alt+Up/Down act on the selection and stay. Ctrl+D duplicates and selects the copy. Ctrl+C/X copy or cut the whole blocks as Markdown. Ctrl+Enter toggles the task on every selected item. Ctrl+Up/Down folds the selected blocks. |
| Navigation | Up/Down and Shift+Up/Down step through the next or previous **visible** block in reading order: folded content and anything outside a zoom are skipped. |
| Mouse | A drag across blocks stays a text selection. Shift+click on another block while in select mode extends the selection to it. |
| Mod API | Green field: breaking changes are allowed, with no deprecation shims. Built-in mods are updated in the same PR. Mods get `ctx.editor.selectedBlocks()` and events for entering and leaving select mode, in place of the `cm-select-mode` class. |
| Process | PRs merge when checks pass, without review. Every bug found gets a test that fails before the fix and passes after it. |
| Known bugs | Escape and Up/Down ignoring zoom and folds, Backspace unhandled in select mode, and focus mode taking Escape first are fixed by the rebuild, each with a proving test. |
| Page model details | A list is not a node: its items are children of what holds the list (an item, the paragraph that owns it, a section or the page). Items in a quote, callout or footnote definition are children of it, so they can be stepped to; the index has those as part of the quote. The model also has `frontmatter`, `math`, `footnote`, `rule` and `other` nodes that the index does not list. A node's `key` is the hash of a block handle, computed in the editor with BLAKE3 (`@noble/hashes`). The differences from the index are listed in `test/pageModel.oracle.test.ts`. |
| Sections in commands | A heading is a section for Alt+Up/Down (it takes what is under it) and for Shift+Down from a paragraph; Escape takes the heading line, then the section. The first block under a heading moves up past the heading line (out of the section) and the last moves down past the next heading (into that section), so a move is undone by the opposite move. A run of items at the top of a page or section is what a list was for Escape and Shift+Up/Down; nested items are children of their item. |
| Fold keys | A fold is remembered by the node's `key` (the hash of its text, as in a block handle), not by its first line; editing the text of a folded block opens it, as before. |
| Select mode, as built | A heading selected by Escape or by stepping is its own line (`heading` on the selection), and its section once Escape or Shift+Down takes it in. The page, for Escape and Backspace, is its blocks: the front matter is drawn as a title and is never selected, cut or typed over. Shift+Up/Down move the head from a fixed anchor, so they also give a block back, and a run of items at the top of a page or a section is taken in or given back whole when it is entered from outside. After Backspace or Delete the next block in reading order is selected, or the previous one at the end of what is shown; of the two gaps around the removed blocks the larger stays, and at an end of the page none. Tab, Shift+Tab and Alt+Up/Down in select mode find the same blocks again by the lines they started on (an edit that changes nothing leaves the selection alone). Ctrl+Enter ticks the selected items themselves, not the ones nested in them. The folds are CodeMirror's; anything else that hides lines (the fold mod's zoom) says so through `ctx.editor.hidden`, and a block that starts on a hidden line is neither stepped to nor widened to. The fold keys act on `ctx.editor.selectedBlocks` when there are some. |
| ChangeSets | Done (2026-11-28). A block edit is a `BlockEdit`: a `ChangeSet` over the page and the ranges that moved. A swap of two blocks is two replacements plus the moves that say where each went; the cursor, the selected blocks and the folds follow through `follow` and the `blockMoves` annotation, and undo restores the folds. Positions in and out of the edits are offsets, with no line and column pairs. The outline mod's section move uses the same edit. |
| Jev | The window never holds the key: the main process reads `jev` in the config folder's `settings.json` and makes the call (`main/jev.ts`), mods use `ctx.jev.ask`. No key means `ctx.jev.on` is false and a mod that needs Jev does nothing, with no fallback. A mod that surfaces notes keeps its decisions in a pure `plan.ts` (what to ask, what an answer is worth, when to show) and draws only through the editor's own view (a card beside the text, never a change to it). |
| Typing speed | Done (2026-11-28): a key costs about 5 to 7 ms at 5,000 lines (it was about 18). The page model is still built over the whole page for each version of the text, but cheaply: a node is only numbers, and its key text, task state and fence are worked out when read (a rebuild was about 5 ms, now about 2). Several things that draw blocks (tables, fences, `$$` blocks) share one walk of the tree for each tree, `blockNodes`, which skips the inline nodes. Footnotes are found by searching the text for `[^` and asking the tree what each hit is. Callouts, footnotes and inline math are drawn from the viewport, like the other view plugins, and chevrons are made only for the lines on the screen. A state field that has to draw something for the whole page (a block widget) should read `blockNodes` and make what it draws as late as it can (a table is read when its widget is drawn). |

## Rebuild order

1. This note and the root `CLAUDE.md`.
2. `pageModel` (principle 1), with the Rust block spans and the Lezer syntax
   extensions it depends on.
3. Typed block selection and the select-mode state machine (principles 2 and 6).
4. One reveal policy exposed to mods (principle 4).
5. Block edits as ChangeSets (principle 3). Done.

Each step is its own PR, and parts that do not touch the same files run in parallel.

## Where we stand

Written 2026-11-27, at the start of the rebuild. Update this table in the PR that
changes a row.

| Principle | Today |
| --- | --- |
| 1. One page model | Met for the editor. `shared/pageModel.ts` builds the model from the syntax tree as the `pageModel` state field (`renderer/pageModelField.ts`), and the Rust index is its oracle. Block commands, selection stepping, folds and zoom (`shared/blocks.ts`, `shared/folds.ts`, `renderer/blockKeys.ts`), the live preview and the mods (`ctx.page`) read it; `parseBlocks` and `editedBlockLines` are gone. Text-only code with no editor (the properties edits) still finds the front matter with `frontmatterEnd(lines)` in `shared/syntax.ts`, and commands that have just made new text read it with `parsePage` (`shared/pageText.ts`), the same builder. |
| 2. Typed selection | Met. `blockSelection` (`renderer/selectMode.ts`) holds a `BlockSelection` (`shared/blockSelection.ts`): anchor and head nodes of the page model, normalised to a run of siblings. The text selection is its projection, set in the same transaction (`selectionSpec`), and one filter clears the field on any other selection or edit. It is drawn from the field: a line decoration, and the class a table widget wears (`coversRange`). |
| 3. Transactions | Met. Block edits (`shared/blocks.ts`, the outline mod) are a `BlockEdit` (`shared/blockEdit.ts`): a `ChangeSet` and the ranges that moved, in offsets. `renderer/blockKeys.ts` turns one into a transaction (`editSpec`) and follows the cursor and the selected blocks through it (`follow`); selecting and removing blocks maps positions through the change, and the folds go with a moved block (`renderer/blockMoves.ts`). |
| 4. Views from state | Met. One reveal policy (`reveal.ts`) serves live preview, tables and the front matter header, gfm-extras and the link clicks; tables are drawn from the syntax tree; mods ask `ctx.editor.isEditing` and `ctx.editor.selectedBlocks`. Revealing a mark does not move the text around it (`cm-mk` in `style.css`). The `cm-select-mode` class is left on the editor for CSS alone (it hides the caret and the selection layer); no code reads it. |
| 5. Commands | Met: every action is `(state) => Reply` (`renderer/blockKeys.ts`) and the keymap only runs it. |
| 6. Explicit modes | Met. The mode is whether `blockSelection` is set; each key's meaning in each mode is the table in `blockKeys.ts`, and `respond(state, key)` is the machine. Escape is resolved there (popup, widen, focus mode); the window's capture handler is gone, and only an Escape that no editor, field or dialog took leaves focus mode from the window. |
| 7. Property tests | Met for the model, the reveal policy and select mode. `test/props.blocks.test.ts` covers edits; `test/livePreview.test.ts` checks the reveal policy on generated paragraphs and tables; `test/props.selectMode.test.ts` runs any keys on any page, with folds and a zoom, and checks that the result is editing or a valid run, that the text selection is exactly its lines, that only shown blocks are selected, and that the mode is entered and left only by the listed keys. |

## Working on the editor

- Before touching selection, select mode, folds, zoom, or anything drawn by live
  preview, read the principle that covers it and check whether the change fits. If
  it does not, say so in the PR and change the model, not the symptom.
- Put new structure in the page model; put new keys in the mode table; put new
  reveal rules in the one policy.
- Keep the node and unit names aligned with `docs/conventions.md` §3. If a word
  means two things, fix the doc.
- Typing speed is a test (`test/keystroke.test.ts`): a key typed in a generated page of 5,000 lines,
  with every extension and mod that decorates, must stay within the work budgets at the top of that file
  (steps through the syntax tree and lookups in the page, counted by `test/support/work.ts`: time would flake
  on a busy runner and is only printed; the goal is 8 ms in all; a PR that makes typing do less lowers the numbers). A view plugin that
  draws should take the viewport (`inlineDecorations`, `markDecorations`, `chevronDecorations`,
  `textDecorations`) and be listed in `test/support/editorState.ts` with its scope; the test then checks that it draws only there.
  Print the table with `TESSELA_STATS=1 npm test -- keystroke`.
- Commands: `npm run typecheck`, `npm test`, and `npm run e2e:acceptance` (needs a
  built `tessela` binary and `xvfb-run` on a headless machine). CI runs all three
  plus the packaged smoke test.
