# Tessela

A personal knowledge manager for humans and agents.

Notes are plain Markdown in an [Open Knowledge Format](https://okf.md/) bundle,
synced with git. Rust tools lint, query and list the vocabulary of that bundle,
and import a Logseq graph. An Electron editor uses the same tools behind the
scenes.

- [Conventions](docs/conventions.md): what Tessela adds on top of OKF.

## Tools

```
cargo run -- lint path/to/bundle            # text output
cargo run -- lint path/to/bundle --json     # for editors and agents
cargo run -- lint path/to/bundle --strict   # warnings fail too
```

`tessela lint` exits with 1 on errors (and on warnings with `--strict`), and 2
when the folder cannot be read. Rules are in
[`crates/tessela-core/src/lint.rs`](crates/tessela-core/src/lint.rs); each one
implements the `Rule` trait, so more can be added without touching the others.

| Rule                        | Severity | Checks                                                   |
| --------------------------- | -------- | -------------------------------------------------------- |
| `okf/frontmatter`, `okf/type` | error  | Every concept file has valid frontmatter and a `type`    |
| `okf/readable`              | error    | Files are valid UTF-8                                    |
| `tessela/dates`             | warning  | Datetimes use a space instead of `T` and have an offset  |
| `tessela/journal`           | warning  | Journals are at `journals/YYYY-MM-DD.md` with that `date` |
| `tessela/vocabulary`        | warning  | Deprecated terms and aliases from `vocabulary.md`        |
| `tessela/unwritten-concept` | info     | Concepts mentioned but without a page yet                |

### Query

```
tessela query . --ref rust                       # blocks that mention #rust
tessela query . -r rust -r tessela               # ... both (use --any for either)
tessela query . -r tessela --own                 # only the block's own refs
tessela query . --text linter --type journal     # text and page type
tessela query . --from 2026-10-01 --to 2026-10-31 --json  # journal days and mentioned dates
tessela query . --page project/ --limit 20       # one page, or a folder with `/`
```

`tessela query` is the backlinks engine: ask for a concept and get everything
that mentions it. A hit has a `kind`:

- `block`: a paragraph or list item. It matches when it, one of its parent list
  items, or a heading above it mentions the concept (spec §3); `--own` turns that
  inheritance off.
- `heading`: a heading that mentions the concept. The blocks under it match as
  well, since they inherit its refs.
- `page`: a page that mentions the concept in its frontmatter, through `tags` or
  through links and `#tags` written in other frontmatter text.

Headings and pages only exist to hold references, so they are returned only when
the query names a concept with `--ref`.

A concept also matches the ones nested under it, so `--ref project` finds
`#project/tessela`. A date range (`--from`, `--to`) keeps what is on journal days
in the range and anything, on any page, whose text contains a date in the range.
Every hit has a `handle` that stays the same until the text changes, plus its
page, line, heading path, refs and parent handle. Text output is for people;
`--json` is for agents and the editor.

### Vocabulary

```
tessela vocab .                    # concepts by number of mentions
tessela vocab . --unwritten        # mentioned, but no page yet
tessela vocab . --prefix project/  # one namespace
tessela vocab . --min-count 3 --json
```

Lists every concept that has a page, is mentioned by a tag or link, or is
declared in `vocabulary.md`, with its mention count, how many pages mention it,
whether it has a page, and any alias or deprecation from `vocabulary.md`. Use it
to pick an existing term instead of inventing a new one.

### Import from Logseq

```
tessela import-logseq ~/logseq-graph ~/notes    # writes a new bundle in ~/notes
tessela lint ~/notes                            # then check it
```

Reads a Logseq graph and writes a Tessela bundle: pages and namespaces become
files, journals become `journals/YYYY-MM-DD.md`, top-level bullets become
paragraphs with their sub-bullets as a list beneath, `[[links]]` and properties
become tags and links, and block references are inlined. It prints a report of
what it converted and what it skipped, and never writes into a folder that has
files or changes the graph. The full mapping is in spec §12.

## Editor

```
cargo build                       # the editor calls the `tessela` binary
cd editor && npm install && npm run build
npm start -- --bundle ~/notes     # or open one from the welcome screen
```

Opens on the latest journal days, saves as you type, shows backlinks, searches the
text of your notes, lists what `tessela lint` finds, suggests existing tags, and
turns a selection into a link with Ctrl+L (Super+L on macOS). Details are in spec
§11. `npm test` runs the unit tests and `npm run e2e` drives a real window.

To build an app that carries its own `tessela` binary:

```
cd editor
npm run package        # installer for this OS in editor/release/
npm run package:dir    # just the unpacked app, for trying it
```

That gives an AppImage and a deb on Linux and a dmg on macOS. The
[Release workflow](.github/workflows/release-editor.yml) builds all of them (Linux, and macOS
for Apple silicon and Intel): run it from the Actions tab, or push a tag such as
`v0.1.0` (matching `editor/package.json`) to attach them to a GitHub release. The
macOS app is not signed with an Apple certificate, so the first time, open it with
right-click, Open, or run `xattr -dr com.apple.quarantine /Applications/Tessela.app`.

## Releases

Pushing a tag like `v0.1.0` builds the `tessela` command line tool for Linux
(x86-64, static) and macOS (Apple silicon and Intel) and attaches
`tessela-<tag>-<target>.tar.gz` files, with checksums, to the GitHub release.
The workflow can also be run by hand from the Actions tab for an existing tag.

## Development

```
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```
