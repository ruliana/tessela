//! Shared by the property tests: how many cases to run, with which seed, and generators for
//! the kind of Markdown a notes bundle holds (plus the nasty bits).
//!
//! Pull requests run a bounded, fixed-seed pass, so a red check is the same every time. The
//! scheduled fuzz job sets `TESSELA_FUZZ_CASES` and `TESSELA_FUZZ_SEED` to look further; a
//! failure prints the seed, and `TESSELA_FUZZ_SEED=<seed> cargo test` replays it.
#![allow(dead_code)]

use std::collections::BTreeSet;

use proptest::prelude::*;
use proptest::test_runner::{Config, RngAlgorithm, RngSeed};
use tessela_core::Page;

const DEFAULT_SEED: u64 = 0x7e55e1a;

fn env_number(name: &str) -> Option<u64> {
    std::env::var(name).ok()?.trim().parse().ok()
}

/// A config running `cases` cases, or `TESSELA_FUZZ_CASES` when that is set.
pub fn config(cases: u32) -> Config {
    let seed = env_number("TESSELA_FUZZ_SEED").unwrap_or(DEFAULT_SEED);
    eprintln!("property tests: seed {seed} (TESSELA_FUZZ_SEED)");
    Config {
        cases: env_number("TESSELA_FUZZ_CASES").map_or(cases, |n| n as u32),
        rng_algorithm: RngAlgorithm::ChaCha,
        rng_seed: RngSeed::Fixed(seed),
        failure_persistence: None,
        max_shrink_iters: 4096,
        ..Config::default()
    }
}

/// Bits of Markdown that matter to Tessela: tags, links of every form, code that must be
/// left alone, headings, tasks, frontmatter, and characters that trip up byte offsets.
const PIECES: &[&str] = &[
    "#x",
    "#y",
    "#a/x",
    "#a/c/y",
    "#X",
    "#w-z",
    "#x.",
    "#x/",
    "a#x",
    "#12",
    "x#y",
    "[t](/x.md)",
    "[t](x.md)",
    "[t](./x.md)",
    "[t](../x.md)",
    "[t](/a/x.md#h)",
    "[t](y.md?q=1)",
    "[t](<a/x.md>)",
    "[t](https://e.org/x.md)",
    "![i](/x.md)",
    "[r][ref]",
    "[ref]: /x.md",
    "[ref]: ./y.md \"title\"",
    "[t](/X.MD)",
    "[t](/a/../x.md)",
    "[t](/x%20y.md)",
    "`#x`",
    "`[t](/x.md)`",
    "```\n#x [t](/x.md)\n```\n",
    "~~~\n#y\n~~~\n",
    "\\#x",
    "\\[t](/x.md)",
    "&#35;x",
    "*#x*",
    "**[t](x.md)**",
    "> #x\n",
    "> [t](/x.md)\n",
    "# H #x\n",
    "## [t](/x.md)\n",
    "- a #x\n",
    "- [ ] t #y\n",
    "- [x] d\n",
    "  - nested #a/x\n",
    "1. one\n",
    "| a | b |\n|---|---|\n| #x | y |\n",
    "<b>#x</b>",
    "---\n",
    "---\ntype: concept\n---\n",
    "---\ntags: [x, \"y\"]\n---\n",
    "tags:\n  - x\n  - y\n",
    "title: \"T #x\"\n",
    "é",
    "日本語",
    "😀",
    "\u{feff}",
    "\r\n",
    "\n",
    "\n\n",
    " ",
    "  ",
    "\t",
    "word",
    "words words",
    "[",
    "]",
    "(",
    ")",
    "`",
    "\\",
    "<",
    "&",
];

fn piece(tame: bool) -> BoxedStrategy<String> {
    let known = proptest::sample::select(PIECES).prop_map(String::from);
    if tame {
        // Pieces that make a page mean different things to the block reader and to the whole
        // page parse (see the known gaps in `props_parse.rs`) are left out.
        known
            .prop_filter("tame", |p| {
                !(p == "`" || p == "\t" || p == "&" || p.contains("&#") || p.starts_with("\\"))
            })
            .boxed()
    } else {
        prop_oneof![8 => known, 1 => any::<String>(), 1 => "[ -~\n]{0,12}"].boxed()
    }
}

/// Markdown made of the pieces above, any text mixed in.
pub fn markdown() -> impl Strategy<Value = String> {
    proptest::collection::vec(piece(false), 0..24).prop_map(|p| p.join(""))
}

/// Markdown made of the pieces above only, without the ones with known gaps.
pub fn tame_markdown() -> impl Strategy<Value = String> {
    proptest::collection::vec(piece(true), 0..24).prop_map(|p| no_indented_code(&p.join("")))
}

/// Indents of 4 spaces start a code block, which the block reader treats differently.
fn no_indented_code(text: &str) -> String {
    text.split_inclusive('\n')
        .map(|line| {
            let rest = line.trim_start_matches(' ');
            if line.len() - rest.len() >= 4 {
                format!(" {rest}")
            } else {
                line.to_string()
            }
        })
        .collect()
}

/// A page: sometimes with frontmatter, mostly well formed, always ending in a newline.
pub fn page_text() -> impl Strategy<Value = String> {
    page_with(markdown())
}

/// Like [`page_text`], from the tame Markdown.
pub fn tame_page_text() -> impl Strategy<Value = String> {
    page_with(tame_markdown())
}

fn page_with(body: impl Strategy<Value = String>) -> impl Strategy<Value = String> {
    let front = prop_oneof![
        3 => Just(String::new()),
        3 => Just("---\ntype: concept\n---\n".to_string()),
        1 => Just("---\ntype: concept\ntags: [x, y]\ndescription: \"see #x and [t](/x.md)\"\n---\n".to_string()),
        1 => Just("---\ntype: concept\ntags:\n  - x\n  - \"A/X\"\n---\n".to_string()),
        1 => Just("---\ntype: concept\n".to_string()),
    ];
    (front, body).prop_map(|(f, b)| format!("{f}{b}\n"))
}

/// Page paths from a small alphabet, so pages often share a folder or a name.
pub fn page_path() -> impl Strategy<Value = String> {
    (
        proptest::sample::select(&["", "a/", "b/", "a/c/"][..]),
        proptest::sample::select(&["x", "y", "z", "w"][..]),
    )
        .prop_map(|(dir, name)| format!("{dir}{name}.md"))
}

/// A few pages with distinct paths.
pub fn bundle_files() -> impl Strategy<Value = Vec<(String, String)>> {
    proptest::collection::btree_map(page_path(), tame_page_text(), 1..6)
        .prop_map(|m| m.into_iter().collect())
}

/// Every concept a page mentions, anywhere in it.
pub fn refs_of(path: &str, text: &str) -> BTreeSet<String> {
    let page = Page::parse(path, text);
    let mut all: BTreeSet<String> = page.refs.iter().cloned().collect();
    all.extend(page.blocks.iter().flat_map(|b| b.refs.iter().cloned()));
    all.extend(page.headings.iter().flat_map(|h| h.refs.iter().cloned()));
    all
}
