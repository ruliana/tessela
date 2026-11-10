# Tessela conventions

Status: draft v0.1 · Date: 2026-10-27

A Tessela knowledge base is a plain [OKF v0.2](https://okf.md/) bundle. OKF is the
contract: there is no server, and every tool (linter, query, vocabulary, editor)
reads and writes the same Markdown files. This document lists the conventions
Tessela adds on top of OKF. They are all additive, so any OKF consumer can still
read a Tessela bundle, and a plain Markdown viewer still shows something sensible.

Sync is done with git. Tessela is local and single-user.

## 1. Layout

```
my-notes/
├── home.md               # optional: where reading starts, see below
├── vocabulary.md         # optional, see §8
├── journals/
│   └── 2026-10-27.md     # one file per day, see §6
├── machine-learning.md   # concept pages, anywhere in the tree
├── project/
│   └── tessela.md
├── assets/               # attachments: images, PDFs, other files
└── .tessela/             # rebuildable caches and indexes; gitignored
```

- `index.md` and `log.md` are reserved by OKF and are never concept pages.
  Tessela does not generate or keep them: a listing of a folder is a query, so
  `tessela index` computes it on demand (§10). A hand-written `index.md` or
  `log.md` is still fine, and OKF consumers that want one can have it written
  with `tessela index --write`. A root `index.md` is also the one place OKF lets a
  bundle declare its version (`okf_version: "0.2"`); a bundle without one is read
  as the version the tool understands.
- `home.md` is reserved by Tessela, see below.
- `assets/` at the root holds attachments that pages link to. `tessela lint` skips
  everything under it, Markdown files included, because an attachment is a file
  as it arrived (an export, a pasted document), not a note written to these rules.
- Everything under `.tessela/` can be deleted at any time. Tools rebuild it from the
  Markdown files. It is never committed.

### Home pages

Every folder, the root included, can have a `home.md`: the hand-written page
where reading starts. It is the first level of progressive disclosure and says
how to use that part of the notes: house rules, tools, the important pages, and
links to the `home.md` of deeper folders or to other guides such as `AGENTS.md`.
Anyone, human or agent, reaches it on purpose; nothing is merged or inherited
from the home pages above it, and tools never write it.

- It has `type: home`, so it is valid OKF (§2). `tessela lint` warns when a
  `home.md` has another type.
- It is an ordinary page of the graph, not hidden: the links, tags and
  headings in it are references like any other (§4).
- A link from a home page says "this page matters". Backlinks from home pages
  come first, the most specific folder's first, and clients mark them (§5). The
  other backlinks follow, most recently changed first.
- `home` is not a name for a concept. The Logseq importer writes a page called
  "Home" as `home-page.md` (§12).
- A computed index (`tessela index`) lists everything; a home page is the
  curated short list. Use the first to find, the second to start.

## 2. Pages

A page is an OKF concept file: UTF-8 Markdown with YAML frontmatter.

- `type` is required (OKF). Tessela uses `concept` for ordinary pages and `journal`
  for daily pages. Other OKF types (`howto`, `reference`, `decision`, ...) are fine.
- `title`, `tags`, `timestamp` and the other OKF recommended fields are used as
  OKF defines them. Frontmatter `tags` apply to the page, not to each block.
  Tags and concept links written in other frontmatter text (a `description`, for
  example) are references of the page too.
- Unknown frontmatter keys are preserved on every write.
- Line endings are LF. Files end with a single newline.

## 3. Blocks

A block is the unit that queries return. Blocks are derived from the CommonMark
structure of the page body; nothing about them is stored in the file.

| Markdown element                       | Block?                                    |
| -------------------------------------- | ----------------------------------------- |
| Top-level paragraph                    | Yes                                       |
| List item, at any depth                | Yes (its own content, not its children)   |
| Top-level code fence, table, quote     | Yes                                       |
| Code fence, table, quote inside an item | Part of that item's block                |
| Paragraph after a nested list, inside an item | A block of its own, a child of that item |
| List item that starts with `[ ]` or `[x]` | A task: its block has `task: open` or `done`; the box is not part of the text |
| Heading                                | Not a block, but a backlink holder (§5); its refs apply to the blocks below it |
| Frontmatter                            | Not a block; it belongs to the page and can be a backlink (§5) |

Each block in the index carries:

- **page**: the concept ID of its file (OKF: path without `.md`).
- **parent**: the enclosing list item, if any. Nested lists form a tree, as in Logseq.
- **heading path**: the headings above it, for display and search context.
- **refs**: the concepts the block itself mentions (§4).
- **path refs**: its own refs plus the refs of every ancestor list item and of
  every heading in its heading path. Queries match on path refs by default, so a
  child bullet shows up under its parent's tag, as in Logseq, and a paragraph
  shows up under a tag in the heading above it. An "own refs only" option exists.

### Outlines: a paragraph with a list beneath it

A list that starts on the line right after a paragraph, with no blank line
between them, belongs to that paragraph. Its top-level items are children of the
paragraph, so they inherit its refs, just like children of a list item. A blank
line between them keeps them apart. This is the shape of an outline: each
top-level point is a paragraph, and its sub-points are the list beneath it.

```markdown
Idea about #tessela
- detail about indexing #rust
  - and a note on it

Another thought
```

Here both list items match `#tessela`; "Another thought" does not. Only a
paragraph owns a list this way, not a heading or another list.

### Block handles

Tools need to point at a block ("edit this one") without storing IDs in files. A
handle is the page ID plus a hash of the block's normalized text (trimmed, with
inner whitespace collapsed), plus an ordinal when identical blocks repeat in a
page. The hash is the first 8 hex characters of the BLAKE3 hash of that text, and
the `.N` ordinal starts at the second identical block:

```
journals/2026-10-27#9f2c41d0
journals/2026-10-27#9f2c41d0.2
```

Handles appear only in indexes and tool output, never in the Markdown. An edit
that targets a handle whose hash no longer matches fails instead of touching the
wrong text. There is no transclusion: blocks show up elsewhere only through
queries over their tags and links.

## 4. References: tags and links

Tags and links share one concept namespace. `#machine-learning` and
`[Machine learning](/machine-learning.md)` both reference the concept
`machine-learning`.

### Tags

- Syntax: `#` followed by letters, digits, `_`, `-` or `/`, e.g. `#rust`,
  `#project/tessela`. A `/` maps to a folder: `#project/tessela` is the concept at
  `project/tessela.md`.
- A tag ends at whitespace or punctuation. `#` at line start followed by a space is
  a heading, not a tag. Tags inside code spans and code fences are ignored. A tag
  must contain a letter, so `#12` is not a tag, and `#` inside a word or URL
  (`a#b`, `https://x.org/#top`) does not start one.
- Matching is case-insensitive. Tools write tags in lowercase.
- Multi-word concepts use a link (below), or a hyphenated tag.

### Links

- Concept links are standard Markdown links with bundle-relative targets, as OKF
  recommends: `[Machine learning](/machine-learning.md)`. Relative targets
  (`./other.md`) also resolve to a concept.
- The link target need not exist. OKF tolerates broken links, and Tessela uses them
  on purpose: a concept can be mentioned before anyone writes its page. The linter
  reports these as "mentioned, not written yet", never as errors.
- Links to URLs or non-Markdown files are ordinary links, not concept references.
- `[[wikilinks]]` are not part of the format. The Logseq importer converts them.

### Concept names and file names

A concept name becomes a file name by lowercasing it and replacing runs of
whitespace with `-`. Letters outside ASCII are kept. "Machine Learning" becomes
`machine-learning.md`. The page's `title` keeps the original spelling.

## 5. Aggregation and backlinks

Logseq's "linked references" are a query, not file content. "Everything that
references `foo`" comes from `tessela query --ref foo`. The editor shows those
results under the page `foo`, or as the whole page when `foo.md` does not exist
yet. Nothing is written back to disk, so aggregation never causes git churn.

Anything that can hold a reference is found, so the result is a full set of
backlinks. A hit is one of:

- a **block** that mentions the concept, itself or through a parent list item or
  a heading above it (§3);
- a **heading** that mentions it. The blocks under the heading are hits too,
  since they inherit its refs; a client can tell them apart by the hit's kind;
- a **page** that mentions it in its frontmatter: `tags`, or tags and concept
  links in other frontmatter text (§2).

Headings and pages only exist to hold references, so they are returned only when
a concept is asked for.

Backlinks from a home page (§1) come first, the most specific folder's home first,
and each such hit has `home: true`. The rest come most recently changed first,
by the modification time of the page's file (each hit carries it as `modified`,
in milliseconds since the epoch); a page's own hits stay in document order. A link
from a home page is how the notes say a page is important, so a client shows these
first and marks them.

## 6. Journals

- One file per day at `journals/YYYY-MM-DD.md`.
- Frontmatter: `type: journal`, `title` and `date` both set to the day.
- The day is a concept like any other: link to it with
  `[2026-10-27](/journals/2026-10-27.md)`.

```markdown
---
type: journal
title: "2026-10-27"
date: "2026-10-27"
---

Planned the Tessela tools with #agents in mind.

- Read the [OKF spec](https://okf.md/spec/) #okf
  - Concepts are files; blocks are ours to define
```

## 7. Dates and times

- Date: `YYYY-MM-DD`, e.g. `2026-10-27`.
- Datetime: ISO 8601 with a space instead of `T`, and a required UTC offset:
  `2026-10-27 14:30:00-03:00` (or `Z` for UTC). This is valid RFC 3339. Seconds
  may be omitted when written by hand; tools always write them.
- Tools read either separator but always write the space form.
- In frontmatter, tools write dates and datetimes as quoted strings, so YAML
  libraries that auto-convert timestamps don't reformat them on round-trip.

## 8. Vocabulary

The vocabulary is whatever exists: every concept with a page, plus every concept
referenced by a tag or link. `tessela vocab` lists them with counts, so humans and
agents can pick an existing term instead of inventing a new one.

An optional `vocabulary.md` adds guidance. It is a convention, not a schema:
tools respect it when present, and nothing is rejected because of it.

```markdown
---
type: vocabulary
title: Vocabulary
terms:
  ml:
    use: machine-learning
  todo:
    status: deprecated
    note: "Use #task instead."
---
```

- `use` marks an alias. Tools suggest the preferred term, and the linter can
  warn.
- `status: deprecated` keeps a term listed but warns when it is used.
- Quote any value that contains `#`, since an unquoted `#` starts a YAML comment.

## 9. Writing files

Several writers can touch the bundle at once (the editor, agents, people with a text
editor or git). The files are the source of truth, so nothing is cached: every
operation reads the disk.

Edits go through one door, the `tessela` edit commands (§10), which the editor and
agents share. Its rules:

- A write names the content hash of the page it was based on (`--expect HASH`, or
  `new` for a page that must not exist). If the file on disk has another hash, the
  write fails with a `conflict` error that carries the hash now on disk, and nothing
  is written. A caller starts from `tessela read` and, after a conflict, reads again
  and redoes its change.
- Writes are atomic: write a temporary file in the same folder, then rename it. A
  new page is created with a hard link, so two writers cannot both create it. (An
  existing page is checked and then replaced; a writer that slips in between those
  two steps in the same instant is not detected.)
- An edit changes only what it targets. `save --patch` applies a unified diff that
  must match exactly; the rest of the file is preserved byte for byte, including
  frontmatter keys the tool does not know.
- `rename` and `move` change the page's concept, so they rewrite the tags and links
  (inline and reference-style) that name it, in the frontmatter `tags` and text and
  in every block of every page, never in code. The moved page's own relative links
  are rebased so they still reach the same files. Folders and nested concepts are
  separate pages and do not move. What cannot be rewritten (a link written with
  escapes) is left alone and reported as a warning.
- `remove` needs the hash too, and reports the pages that still mention the page
  (a link to a missing page is allowed, §4).
- Anyone may still edit the Markdown directly. That is safe because the tool checks
  the disk on every call; the hash only protects writers that go through the tool.
- The editor watches the bundle for changes and reloads open pages.

## 10. Tools

All tools are Rust binaries built on one shared core library. Each has a
human-readable output and a `--json` output, which the editor and agents use. Every
`--json` answer, from every command, is an object with `"api": N` and `"ok": true`; lists
sit under a name (`hits` and `total` for `query`, `concepts` for `vocab`, `diagnostics`
for `lint`). A failure is `{"api": N, "ok": false, "error": {"code", "message"}}` with
exit code 2 (3 for a `conflict`; `lint` keeps 1 for findings, and `ok` stays true then).
Every command takes `--api N` for the version the caller was written for.

- `tessela lint`: OKF conformance plus Tessela rules (dates, tags, vocabulary, home pages).
  Rules are pluggable, so semantic rules can be added later.
- `tessela query`: the backlinks engine. Asking for a concept returns everything
  that mentions it, as hits of three kinds: `block`, `heading` (a heading that
  mentions it; the blocks under it match too) and `page` (frontmatter `tags`, or
  tags and links in other frontmatter text). Headings and pages are returned only
  when a concept is asked for. Other filters: text, page type, page or folder, and
  date range. Refs match path refs unless `--own` is given (§3). A date range
  keeps what is on journal days in the range and anything, on any page, whose
  text contains a date in the range (§7). A concept also matches the ones nested
  under it: `#project` matches `#project/tessela`, but not `#projector`. A name
  that a page lists in its frontmatter `aliases` also matches that page's ID, so
  `--ref <alias>` finds the page's backlinks, plus the blocks that use the alias
  itself. It does not work the other way: `--ref <page>` does not find blocks that
  use one of its aliases.
  `--task open|done|any` keeps only checkbox items (§3), so a task is a plain `- [ ]` and its
  due date is a date written in it: `--task open --to 2026-11-15` lists what is open on
  journal days up to the 15th or names a date up to it. Hits carry `task`.
- `tessela index`: what a folder holds, as an OKF `index.md` (§6 of OKF):
  sub-folders, then the folder's own pages (its `home.md` first) with their
  `description` or first line, then its journal days, newest first. It prints to
  stdout (`--json` gives the same as data; `--dir` picks a folder; `--recursive`
  lists every page below the folder, sub-folders included, as one flat list) and
  writes nothing. `--write` writes an `index.md` into the root and every folder for
  bundles read by tools that do not compute listings. Generated files carry a
  marker line; one that does not (a hand-written `index.md`) is kept unless
  `--force` is given.
- `tessela read | add | save | rename | move | remove`: the edit commands (§9), with
  `attach` below. They
  take the bundle with `--bundle DIR` (default `.`) and the page as a path relative to
  it, with or without `.md`. `add` and the targets of `rename` and `move` take a name
  the way a person writes it (`Machine Learning` becomes `machine-learning.md`, §4);
  `index.md` and `log.md` are refused as names (§1). `save` reads the new text, or with
  `--patch` a unified diff, from stdin (or `--file`). `rename` keeps the folder; `move`
  takes a folder ending in `/` or a path. `rename` and `move` accept `--dry-run`.
  With `--json` the answer is `{"api": N, "ok": true, ...}`, and a failure is
  `{"api": N, "ok": false, "error": {"code", "message"}}` with the exit code 3 for a
  `conflict` and 2 for any other error. Error codes: `conflict`, `not-found`, `exists`,
  `invalid-path`, `invalid-patch`, `invalid-input`, `api-mismatch`, `io`. The `api`
  number is the version of this contract (command names, arguments and JSON); callers
  pass `--api N` for the version they were written for, and the tool refuses on a
  mismatch. `tessela api` prints it. Any change to command names, arguments or JSON bumps it
  (2: every answer got the `api`/`ok` envelope). The operations are written against a `PageStore`
  in `tessela-core`, so a bundle kept elsewhere (remote, database) needs a new store,
  not new callers.
- `tessela pages`: every concept page, sorted by path, with its `id`, `path`, `title` and
  `type`. The title is what the page calls itself: its frontmatter `title`, else its
  first `#` heading, else its file name with the dashes turned into spaces. Reserved
  files (`index.md`, `log.md`) and hidden folders are not pages.
- `tessela fence`: runs a live list. A page may hold a code fence with the info string
  `tessela` whose body is one read-only command (`query`, `index`, `vocab` or `lint`, with
  the bundle left out), optionally followed by filters:

  ````markdown
  ```tessela
  query --ref project/tessela --type journal | rg -v draft | sort -r | head 5
  ```
  ````

  The editor draws the rows under the fence and never writes them into the page, so a
  page stays plain Markdown that shows a command anyone can read. `tessela fence` reads the
  body on stdin (or `--file`) and prints one line per row, `path:line:text` as `rg` prints it;
  with `--json` the answer is `{"api": N, "ok": true, "command": "query", "rows": [{"text",
  "source"}]}`, where `source` is the hit, page, concept or finding the line came from, and
  `null` once a filter has rewritten the line so that its `path:line:` start is gone. A page
  can arrive by `git pull` or from an agent, so the line never reaches a shell or a real
  program. The filters are built into tessela: `rg [-i -v -F -w -e PATTERN]`,
  `sed 's/re/new/[gi]'` and `sed '/re/d'` (`\1` and `&` in the replacement), `sort [-r -n -u]`,
  `uniq [-c]`, `head [-n] N` and `wc [-l|-w|-c]`. Patterns are Rust regular expressions;
  words are split like a shell's (`'...'`, `"..."`, `\`) but nothing is expanded, and a pipe
  may be broken over lines after a `|`. Anything else (`awk`, `sed -i`, `index --write`, a
  folder in the command) is refused with the `invalid-input` error.
- `tessela attach PAGE`: stores a file in `assets/` for a page to link to. The bytes come
  from stdin or `--file`, the kind from `--ext`, the file's name or the first bytes (png,
  jpg, gif, webp, pdf, svg); `.md` is refused, since that would be a page. The file is named
  after the page plus a short hash of its content (`assets/project-tessela-9f2c41d0a1b2.png`
  for `project/tessela.md`), so the same file attached twice for the same page is one file.
  The answer has `path`, `link` (what a page writes: `![description](/assets/...)`), `hash`,
  `size` and `created`. It takes `--bundle`, `--json` and `--api` like the edit commands. The
  page need not exist yet. `tessela lint` reports attachments no page mentions as
  `tessela/unused-attachment` (informational).
- `tessela watch`: a read-only stream of the pages that change on disk, for clients that
  keep a view of the bundle (the editor). With `--json` it prints one JSON line per
  event: `ready` (with the `mode`, `native` or `polling`), `changed` (the `paths` of the
  pages that were created, changed or removed, sorted, a moment after the last change, so
  a burst is one line), and `mode` when it switches between the system's watcher and looking
  at the files every few seconds (the system can run out of watchers; it is tried again
  every minute). `--poll` always looks at the files, for folders the system cannot watch.
  Hidden folders and files that are not Markdown are not reported. `--exit-on-stdin-close`
  ends it when its caller goes away. It is not a server: saves stay one call each.
- `tessela vocab`: the tags and concepts that exist (pages, tags, links and
  `vocabulary.md` terms), with mention counts, page counts and the
  `vocabulary.md` guidance.

## 11. Editor

An Electron editor (in `editor/`, TypeScript, CodeMirror 6) that uses the same
tools as everyone else: it runs `tessela query --json` and `tessela vocab --json`
and `tessela lint --json` with `--api` (the binary comes from `$TESSELA_BIN`, then the one
packaged with the app, then `target/{release,debug}`, then `PATH`). It reads and
saves pages with `tessela read` and `tessela save` (§9, §10), one call per read and per
save, so it follows the same rules as agents; it lists the pages with `tessela pages` and
follows changes with `tessela watch`, so it reads nothing from the folder itself.

- The root is the folder it opens: `--bundle PATH`, or the last one used, or the one
  chosen in the window (the folder button at the top of the sidebar, Ctrl+Shift+O, or
  the welcome screen when there is none yet). Everything is relative to that folder:
  page paths, links, tags and what `tessela` is run on. Files outside it are not seen.
  The sidebar always shows its name and full path.
- It opens a bundle on the journals: today
  and the latest earlier days stacked, each one editable, with "Older days" for more.
  A journal file is only created on the first edit.
- Edits are saved after a short pause with `tessela save --expect HASH`, where HASH
  is the hash the editor last read (§9). The save is refused when the file on disk is
  another one; the editor then offers to load the disk version or to overwrite it.
  A tool too old to have these commands, or one with another `api` number, makes
  saving fail with a message that says so.
- It watches the bundle: pages changed by other programs are reloaded, unless
  there are unsaved edits, which count as a conflict.
- The right panel shows the backlinks of the open page (`query --ref PAGE`; for a
  journal, also anything that mentions its date), grouped by page. Groups from a
  home page (§1) come first, the most specific folder's first, with a "Home" tag
  and a tinted background. The other groups follow, the most recently changed page first.
- "New page" (Ctrl+N) asks for a name, where `/` makes folders, and creates the file
  at once from the page template (typing the name in the search box and pressing Enter
  also opens the page, but its file only appears on the first edit). "Open file…"
  (Ctrl+O) picks a Markdown file; one inside the root opens as a page (reserved files
  like `index.md` too), and one outside it offers its folder as the new root instead.
- The search box filters page names and also searches the text of the notes
  (`query --text`); Enter creates the page named by what was typed.
- The sidebar lists what `tessela lint` reports as errors or warnings (not the
  informational "unwritten concept" findings), each one a jump to its file and line.
- What the tools can find is coloured, so it is clear what is queryable: tags
  (also the `tags` of the front matter), links to concepts, links to other files,
  and dates and datetimes (only real ones, as in §7). A tag or concept link whose
  concept has no page yet is shown dashed and italic. Tags and dates inside code are
  not coloured, since `#include` is not a tag. Front matter is highlighted as YAML,
  and fenced code blocks in the language they name.
- `#` and `](` suggest existing concepts from the vocabulary. Ctrl/Cmd-click on a tag
  or a concept link opens its page, which is created from a template when new.
- A date (or datetime) leads to that day's journal the same way: Ctrl/Cmd-click where
  the text is typed, a plain click where it is drawn (rendered text, table cells, the
  date in a page's properties, the backlink tiles). A day without a file opens empty
  and gets its file on the first edit. Dates in code or in web addresses are left alone.

### Editing keys

| Keys                          | What it does                                                          |
| ----------------------------- | --------------------------------------------------------------------- |
| Tab                           | Paragraph becomes a list item; an item nests under the one before it   |
| Shift+Tab                     | Nested item moves out; a top-level item becomes a paragraph again      |
| Alt+Up / Alt+Down             | Move the block, with what it owns, past its neighbour                  |
| Esc, then Shift+Up / Shift+Down | Select the block at the cursor (Esc again: its parent), then more blocks |
| Ctrl+B, Ctrl+I, Ctrl+E        | Bold, italic, code (the word at the cursor when nothing is selected)   |
| Ctrl+Shift+X                  | Strikethrough                                                         |
| `*` `_` `~` `(` `[` `{` `"` `` ` `` | Typed over a selection, surround it; brackets close themselves   |
| Paste a URL over a selection  | Makes a link of the selection                                         |
| Ctrl+Enter                    | Tick or untick a task; makes a task of an item or a paragraph         |
| `/`                           | Menu: headings, lists, tasks, quote, code, table, dates, link, tag     |
| Ctrl+F                        | Find in the page                                                      |

On macOS, Ctrl above is Cmd. Tab, Shift+Tab and Alt+Up/Down keep their usual
behaviour inside front matter and fenced code. Blocks are the ones of §3: a
paragraph owns the list directly under it, and an item owns the items nested in it.
Where a block begins and ends is decided once, by the CommonMark reading of the page, so a
paragraph after a blank line is never part of the list item above it unless it is indented to
the item's text. The one departure from CommonMark: there are no setext headings (a line of
`---` or `===` under text), only `#` headings, so text typed on the first line of a page, in
front of the front matter, cannot turn the YAML into a heading. The caret also stays out of
the front matter drawn as a title: a click on it goes to the text, an arrow key up into it
goes to the first property.

### Smart link: Ctrl+L (Super+L on macOS)

| Selection                                   | Result                  | Cursor            |
| ------------------------------------------- | ----------------------- | ----------------- |
| A URL (`https://...`)                       | `[](https://...)`       | in the text part  |
| A file path (`/x.md`, `./x.md`, `~/x.pdf`)  | `[](/x.md)`             | in the text part  |
| Any other text                              | `[Some text]()`         | in the target     |
| Nothing                                     | `[]()`                  | in the target     |

When the cursor lands in the target, the editor searches the pages by title and by path,
and offers a link to a new page named after what was typed (its path is made as in §4).
Choosing one fills in the target, and the text too when it is empty. With nothing typed
yet, the pages are searched by the link text, so `[Daily TODO](` offers that page first.

Titles come from the `title:` of the front matter, else the first `#` heading, else the
file name. The same search opens after typing `](` by hand, and after a single `[` and a
few letters: `[dai` offers "Daily TODO", and choosing it writes `[Daily TODO](/daily-todo.md)`.
A `[` that is a task box (`[ ]`, `[x]`), an image (`![`) or the text of a link that already
exists does not search.

An address (`https://...`, `mailto:...`) pasted over selected text makes the text its link,
so a title and an address are not typed twice. With nothing selected, or inside code, a
paste is a plain paste.

## 12. Importing from Logseq

`tessela import-logseq GRAPH OUT` reads a Logseq graph (the folder with `pages`
and `journals`) and writes a new bundle in `OUT`. It never writes into a folder
that already has files, and it never changes the graph.

| Logseq                                | Tessela                                              |
| ------------------------------------- | ---------------------------------------------------- |
| `journals/2026_10_27.md`              | `journals/2026-10-27.md`, `type: journal`            |
| `pages/Foo Bar.md`                    | `foo-bar.md`, `type: concept`, `title: "Foo Bar"`    |
| `pages/A___B.md`, `A%2FB.md`          | `a/b.md` (a namespace is a folder)                   |
| Top-level bullet                      | A paragraph                                          |
| Nested bullets                        | A list right under that paragraph (§3)               |
| `[[Foo Bar]]`, `#[[Foo Bar]]`         | `[Foo Bar](/foo-bar.md)`                             |
| `[label]([[Foo]])`                    | `[label](/foo.md)`                                   |
| `[[Oct 27th, 2026]]`                  | `[2026-10-27](/journals/2026-10-27.md)`              |
| `[[alias]]` of a page with `alias::`  | A link to the page that declares the alias           |
| `#foo`                                | `#foo`                                               |
| Page properties (header or first bullet) | Frontmatter: `title`, `tags`, `aliases`, other keys |
| `tags:: #a #b`, `tags:: a, [[B c]]`      | `tags: ["a", "b"]`, `tags: ["a", "b-c"]`          |
| Page property `created:: [[2026-10-27]]` | `created: "2026-10-27"`, a date (§7)               |
| Block property `status:: done`        | `#status/done` on the last line of the block         |
| Block property `author:: [[Jane]]`    | `[author](/author.md): [Jane](/jane.md)`             |
| Block property `tags:: a, b`          | `#a #b`                                              |
| `((uuid))` reference, `{{embed ((uuid))}}` | The referenced block's text, inlined once       |
| `{{embed [[Page]]}}`                  | A link to the page                                   |
| `id::`, `collapsed::`, `heading::`, `logseq.*`, `:LOGBOOK:` drawers | Dropped            |
| `TODO`, `LATER`, `NOW`, `DOING`, `WAITING` | `[ ]` before the text                           |
| `DONE`; `CANCELED`                    | `[x]` before the text; `[x] ~~text~~`                |
| `[#A]` priority                       | `#priority/a`                                        |
| `SCHEDULED: <2026-10-28 Wed>`         | `SCHEDULED: 2026-10-28` (a date a range query finds) |
| `- ## Heading` bullet                 | `**Heading**` (see below)                            |
| `![x](../assets/x.png)`               | `![x](/assets/x.png)`, with `assets/` copied         |

Block properties become references, so the key itself is a concept: a page such
as `status.md` or `author.md` can describe what the property means, and
`#status/done` lives under it, so a query for `status` finds every value. A value
is written as a tag only when it is a single word; anything else, such as a URL or
a sentence, is written as `[key](/key.md): value`. Values that are already links
keep their target. Frontmatter keys that would clash with Tessela's own (`type`,
`title`, `date`, `tags`, `aliases`) are kept as `logseq-<key>`.

Block references and embeds are inlined at import time with the text the
referenced block had then. After import there is no live link between the copies.
A reference to a block that cannot be found is replaced by
`(unresolved block reference)` and counted in the report.

Headings are the one place where Logseq and Tessela differ in meaning: in Tessela a
heading scopes everything below it (§3), while a Logseq heading bullet is only
formatting. Importing it as a heading would hand its refs to every later paragraph,
so it is written as bold text instead.

Because path refs include ancestors (§3), a nested bullet still shows up under
its parent's tag after import.

Names. A page is written at the slug of its title: lowercase, words joined by `-`,
other punctuation dropped. `index` and `log` are reserved by OKF, so pages with
those names get `-page` added, and so does `home`, which Tessela reserves (§1).
Two pages with the same slug get `-2`, `-3`, and the report lists them. Links
are written with the same slugs, so they stay connected.

The importer writes only what the graph contains. It does not generate `index.md`
or `log.md`: listings are computed on demand with `tessela index` (§10), not kept
as files that go stale.

Not imported, and listed in the report: `.org` pages, whiteboards, and files that
are not valid UTF-8. Logseq macros such as `{{query ...}}` are copied as they are
and counted. Journal links are recognised in Logseq's default title format
(`Oct 27th, 2026`) and in ISO form, with or without a weekday (`2026-10-27`,
`2026-10-27 Tuesday`).
