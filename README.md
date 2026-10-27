# Tessela

A personal knowledge manager for humans and agents.

Notes are plain Markdown in an [Open Knowledge Format](https://okf.md/) bundle,
synced with git. Rust tools lint, query and list the vocabulary of that bundle,
and an Electron editor uses the same tools behind the scenes.

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

A block matches a concept when it, one of its parent list items, or a heading
above it mentions it (spec §3); `--own` turns that off. A concept also matches
the ones nested under it, so `--ref project` finds `#project/tessela`. A date range
(`--from`, `--to`) keeps the blocks on journal days in the range and any block,
on any page, whose text contains a date in the range. Every hit has a `handle` that stays the same until the block's text
changes, plus its page, line, heading path, refs and parent handle. Text output
is for people; `--json` is for agents and the editor.

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

## Development

```
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```
