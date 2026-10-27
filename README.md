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

## Development

```
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```
