# Tessela

A personal knowledge manager for humans and agents. Plain Markdown bundles are the
source of truth; the `tessela` CLI (Rust, `crates/`) is the one way to read and
write them; the editor (`editor/`, Electron + CodeMirror 6) is a client of that CLI.
Conventions for the notes themselves are in `docs/conventions.md`.

## Before changing the editor

Read [`editor/ARCHITECTURE.md`](editor/ARCHITECTURE.md). It has the seven
principles, the decisions log and the rebuild order. The short version: one page
model, selection as typed state, changes as transactions, one reveal policy,
explicit modes. A fix that adds a flag, a second parser of the page, or a CSS class
that another layer reads is a design question first. If your change contradicts the
note, change the note in the same PR and say why.

## Standing rules (from Ronie, 2026-11-27)

- **Green field.** Only Ronie and Claude develop and use Tessela. Break APIs freely
  (CLI JSON, the mod API, internal modules) with no compatibility shims or
  deprecation layers. Update the built-in mods in `editor/src/mods/` and the docs
  in the same PR.
- **Merge on green.** Auto-merge is set up (`.github/workflows/auto-merge.yml`): a
  PR merges when its checks pass, and nobody reviews it. The `no-auto-merge` label
  holds one back. So the tests are the only gate: do not rely on review to catch
  anything.
- **Every bug gets a failing-first test.** When you find a bug, including one you
  only notice by reading code, write a test that fails on the current code, then
  fix it, and keep the test in the same PR.
- **Prefer property tests** (`fast-check` in the editor, `proptest` style tests in
  Rust, see `test/props.*` and `crates/**/tests/props_*`) over hand-picked
  examples, and tests on the model or state machine over tests that drive a window.
  Keep tests lean.
- **No generated files in bundles.** Tools do not write `index.md`, `log.md` or
  similar into a user's notes; dynamic content comes from CLI commands and mods.

## Checks

- Rust: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo test --workspace`.
- Speed: speed tests count work, never time (a shared CI runner's clock flakes). `tests/budgets.rs`
  holds, per command at 3,000 topics, the pages parsed and the instructions a warm call executes
  (Cachegrind, so `valgrind` must be installed; CI installs it). The editor's keystroke test counts
  steps through the syntax tree and lookups in the page (`editor/test/support/work.ts`). Wall time
  is only for setting a budget: `cargo bench -p tessela-cli` prints each command's time and pages
  parsed at 500, 1,500 and 3,000 topics; `TESSELA_STATS=1` makes `budgets` and `keystroke` print
  work and time side by side. A speed PR lowers the numbers (`tests/support/mod.rs`, top of
  `keystroke.test.ts`).
- Editor (from `editor/`): `npm ci`, `npm run typecheck`, `npm test`, `npm run build`,
  then `xvfb-run -a node e2e/smoke.mjs` and `node e2e/acceptance.mjs`. The editor
  needs a built `tessela` binary (`cargo build -p tessela-cli`) to save.

CI runs all of these. Run the failing ones again after a fix rather than the whole
suite.
