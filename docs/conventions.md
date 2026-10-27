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
| Heading                                | No; it is context for the blocks below it |
| Frontmatter                            | No; it belongs to the page                |

Each block in the index carries:

- **page**: the concept ID of its file (OKF: path without `.md`).
- **parent**: the enclosing list item, if any. Nested lists form a tree, as in Logseq.
- **heading path**: the headings above it, for display and search context.
- **refs**: the concepts the block itself mentions (§4).
- **path refs**: its own refs plus the refs of every ancestor list item. Queries
  match on path refs by default, so a child bullet shows up under its parent's tag,
  as in Logseq. An "own refs only" option exists.

### Block handles

Tools need to point at a block ("edit this one") without storing IDs in files. A
handle is the page ID plus a hash of the block's normalized text (trimmed, with
inner whitespace collapsed), plus an ordinal when identical blocks repeat in a
page:

```
journals/2026-10-27#b3:9f2c41d0
journals/2026-10-27#b3:9f2c41d0.2
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
  a heading, not a tag. Tags inside code spans and code fences are ignored.
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

## 5. Aggregation

Logseq's "linked references" are a query, not file content. "Every block that
references `foo`" comes from `tessela query --refs foo`. The editor shows those
results under the page `foo`, or as the whole page when `foo.md` does not exist
yet. Nothing is written back to disk, so aggregation never causes git churn.

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
    note: Use #task instead.
---
```

- `use` marks an alias. Tools suggest the preferred term, and the linter can
  warn.
- `status: deprecated` keeps a term listed but warns when it is used.

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
- `tessela query`: fast retrieval of blocks and pages by refs, text, type, date
  range and page.
- `tessela vocab`: the tags and concepts that exist, with counts and the
  `vocabulary.md` guidance.

## 11. Editor

An Electron editor that uses the same Rust core behind the scenes.

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

| Logseq                              | Tessela                                         |
| ----------------------------------- | ----------------------------------------------- |
| `journals/2026_10_27.md`            | `journals/2026-10-27.md`, `type: journal`       |
| `pages/Foo Bar.md`                  | `foo-bar.md`, `type: concept`, `title: Foo Bar` |
| Top-level bullets                   | Paragraphs                                      |
| Nested bullets                      | Lists under that paragraph                      |
| `[[Foo Bar]]`, `#[[Foo Bar]]`       | `[Foo Bar](/foo-bar.md)`                        |
| `#foo`                              | `#foo`                                          |
| Page properties (first block)       | Frontmatter keys                                |

Because path refs include ancestors (§3), a nested bullet still shows up under
its parent's tag after import.

## Open questions

1. Block properties (`key:: value` on a Logseq bullet): drop them, keep them as
   text, or turn them into tags?
2. Block references (`((uuid))`) and embeds: inline the referenced text once at
   import, or replace with a link to its page?
3. Do top-level paragraphs inherit refs from the heading above them, the way list
   items inherit from their parents?
