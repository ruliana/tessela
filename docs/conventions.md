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
├── index.md              # OKF root index (okf_version: 0.2)
├── vocabulary.md         # optional, see §8
├── journals/
│   └── 2026-10-27.md     # one file per day, see §6
├── machine-learning.md   # concept pages, anywhere in the tree
├── project/
│   └── tessela.md
└── .tessela/             # rebuildable caches and indexes; gitignored
```

- `index.md` and `log.md` are reserved by OKF and are never concept pages.
- Everything under `.tessela/` can be deleted at any time. Tools rebuild it from the
  Markdown files. It is never committed.

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

Several writers can touch the bundle at once (the editor, agents, CLI tools).

- Writes are atomic: write a temporary file in the same folder, then rename it.
- An edit changes only the targeted block or frontmatter key. Everything else in
  the file is preserved byte for byte.
- Edits that target a block handle fail on a hash mismatch (§3).
- The editor watches the bundle for changes and reloads open pages.

## 10. Tools

All tools are Rust binaries built on one shared core library. Each has a
human-readable output and a `--json` output, which the editor and agents use.

- `tessela lint`: OKF conformance plus Tessela rules (dates, tags, vocabulary).
  Rules are pluggable, so semantic rules can be added later.
- `tessela query`: the backlinks engine. Asking for a concept returns everything
  that mentions it, as hits of three kinds: `block`, `heading` (a heading that
  mentions it; the blocks under it match too) and `page` (frontmatter `tags`, or
  tags and links in other frontmatter text). Headings and pages are returned only
  when a concept is asked for. Other filters: text, page type, page or folder, and
  date range. Refs match path refs unless `--own` is given (§3). A date range
  keeps what is on journal days in the range and anything, on any page, whose
  text contains a date in the range (§7). A concept also matches the ones nested
  under it: `#project` matches `#project/tessela`, but not `#projector`.
- `tessela vocab`: the tags and concepts that exist (pages, tags, links and
  `vocabulary.md` terms), with mention counts, page counts and the
  `vocabulary.md` guidance.

## 11. Editor

An Electron editor (in `editor/`, TypeScript, CodeMirror 6) that uses the same
tools as everyone else: it runs `tessela query --json` and `tessela vocab --json`
and `tessela lint --json` (the binary comes from `$TESSELA_BIN`, then the one
packaged with the app, then `target/{release,debug}`, then `PATH`), and reads and
writes the Markdown files itself.

- It opens a bundle (`--bundle PATH`, or the last one used) on the journals: today
  and the latest earlier days stacked, each one editable, with "Older days" for more.
  A journal file is only created on the first edit.
- Edits are saved after a short pause. A write is atomic (temporary file, then
  rename) and refused when the file on disk is not the one the editor last read;
  the editor then offers to load the disk version or to overwrite it.
- It watches the bundle: pages changed by other programs are reloaded, unless
  there are unsaved edits, which count as a conflict.
- The right panel shows the backlinks of the open page (`query --ref PAGE`; for a
  journal, also anything that mentions its date), grouped by page.
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

### Smart link: Ctrl+L (Super+L on macOS)

| Selection                                   | Result                  | Cursor            |
| ------------------------------------------- | ----------------------- | ----------------- |
| A URL (`https://...`)                       | `[](https://...)`       | in the text part  |
| A file path (`/x.md`, `./x.md`, `~/x.pdf`)  | `[](/x.md)`             | in the text part  |
| Any other text                              | `[Some text]()`         | in the target     |
| Nothing                                     | `[]()`                  | in the text part  |

When the cursor lands in the target, the editor offers existing concepts from
`tessela vocab`, with the slug of the selected text (§4) as the first suggestion.

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
those names get `-page` added. Two pages with the same slug get `-2`, `-3`, and
the report lists them. Links are written with the same slugs, so they stay
connected.

Not imported, and listed in the report: `.org` pages, whiteboards, and files that
are not valid UTF-8. Logseq macros such as `{{query ...}}` are copied as they are
and counted. Journal links are recognised in Logseq's default title format
(`Oct 27th, 2026`) and in ISO form.
