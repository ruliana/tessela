//! Unlinked mentions: text that names a concept without being a link or a tag to it.
//!
//! `query --unlinked NAME` finds, in blocks that do not already reach the concept, the
//! places where its title, one of its aliases or a `vocabulary.md` term for it is written
//! as plain words. Each place is a [`Mention`] with the position and the link that would
//! turn it into a reference, so a client can offer "Link" and write it as a patch.
//! Code, existing links, tags and web addresses are not searched.

use std::cell::OnceCell;
use std::path::Path;

use aho_corasick::{AhoCorasick, MatchKind};
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use serde::Serialize;

use crate::blocks::Block;
use crate::bundle::Bundle;
use crate::lint::read_vocabulary;
use crate::page::Page;
use crate::refs::{normalize_concept, tag_spans};

/// Names shorter than this are too common to be worth listing.
const MIN_NAME_CHARS: usize = 2;

/// One place where a concept is named in plain words.
#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct Mention {
    /// The words as written: `machine learning`, `ML`.
    pub text: String,
    /// The line in the file where they are (1-based).
    pub line: usize,
    /// Where they start in that line, in bytes. Absent when the line could not be matched
    /// to the file, which a client should treat as "find `text` on the line yourself".
    pub column: Option<usize>,
    /// What to write in their place: `[machine learning](/machine-learning.md)`.
    pub link: String,
}

/// What a concept is called, and where a link to it goes.
pub struct Spec {
    /// The concept ID.
    pub concept: String,
    /// All the names at once, longest first. Absent when there is no name worth looking for.
    names: Option<AhoCorasick>,
    /// How a page links to it: `/machine-learning.md`.
    target: String,
}

impl Spec {
    pub fn new(bundle: &Bundle, name: &str) -> Spec {
        let concept = normalize_concept(name);
        let mut names: Vec<String> = Vec::new();
        let mut add = |n: &str| {
            let n = n.split_whitespace().collect::<Vec<_>>().join(" ");
            if n.chars().count() >= MIN_NAME_CHARS
                && !names.iter().any(|e| e.eq_ignore_ascii_case(&n))
            {
                names.push(n);
            }
        };
        let spaced = |id: &str| id.replace(['-', '_'], " ");
        if let Some(page) = bundle.page(&concept) {
            if let Some(title) = page.get_str("title") {
                add(title);
            }
            for alias in page.alias_names() {
                add(&alias);
            }
        }
        add(&spaced(concept.rsplit('/').next().unwrap_or(&concept)));
        // `vocabulary.md` terms that stand for this concept (`ml` for `machine-learning`).
        for (term, spec) in read_vocabulary(bundle) {
            if spec.use_instead.as_deref() == Some(&concept) {
                add(&term);
                add(&spaced(&term));
            }
        }
        names.sort_by_key(|n| std::cmp::Reverse(n.chars().count()));
        // Standard matching with overlaps reports every occurrence of every name; which of
        // them to keep is decided in `find_words`, since that needs the words around them.
        let names = (!names.is_empty()).then(|| {
            AhoCorasick::builder()
                .match_kind(MatchKind::Standard)
                .build(names.iter().map(|n| fold(n).0))
                .expect("a few short names always build")
        });
        Spec {
            target: format!("/{concept}.md"),
            concept,
            names,
        }
    }

    /// Whether `page` is the page of the concept: its own text is not an unlinked mention.
    pub fn is_page(&self, page: &Page) -> bool {
        normalize_concept(&page.id) == self.concept
    }

    /// The mentions in a block. `file` is the page's text, to place them in it; it is only
    /// read when there is something to place.
    pub fn mentions(&self, page: &Page, block: &Block, file: &PageFile) -> Vec<Mention> {
        let Some(names) = &self.names else {
            return Vec::new();
        };
        if self.is_page(page) {
            return Vec::new();
        }
        // Most blocks name nothing. Whatever a mention is, its words are in the raw text
        // as they are, so one scan of it tells whether the Markdown is worth reading.
        let (raw, _) = fold(&block.text);
        if !names.is_match(&raw) {
            return Vec::new();
        }
        let mut found: Vec<(usize, usize)> = Vec::new();
        for (start, masked) in plain_text(&block.text) {
            found.extend(
                find_words(names, &masked)
                    .into_iter()
                    .map(|(from, to)| (start + from, start + to)),
            );
        }
        found.sort();
        found
            .into_iter()
            .map(|(from, to)| {
                let text = block.text[from..to].to_string();
                let before = &block.text[..from];
                let row = before.matches('\n').count();
                let in_row = from - before.rfind('\n').map_or(0, |i| i + 1);
                let text_line = block.text.lines().nth(row).unwrap_or("").trim_end();
                // The block's text lost the list marker and indent: the file line ends
                // with the text line, so the difference is how far in it starts.
                let column = file
                    .line(block.line - 1 + row)
                    .filter(|l| l.ends_with(text_line))
                    .map(|l| l.len() - text_line.len() + in_row);
                Mention {
                    link: format!("[{text}]({})", self.target),
                    text,
                    line: block.line + row,
                    column,
                }
            })
            .collect()
    }
}

/// A page's file, read when the first mention in it needs placing.
pub struct PageFile<'a> {
    root: &'a Path,
    page: &'a Page,
    /// The text and where each of its lines starts.
    text: OnceCell<Option<(String, Vec<usize>)>>,
}

impl<'a> PageFile<'a> {
    pub fn new(root: &'a Path, page: &'a Page) -> PageFile<'a> {
        PageFile {
            root,
            page,
            text: OnceCell::new(),
        }
    }

    /// The line with this index (0-based) without its end, if the file could be read.
    fn line(&self, index: usize) -> Option<&str> {
        let (text, starts) = self
            .text
            .get_or_init(|| {
                let text = read_file(self.root, self.page)?;
                let mut starts = vec![0];
                starts.extend(text.match_indices('\n').map(|(i, _)| i + 1));
                Some((text, starts))
            })
            .as_ref()?;
        let from = *starts.get(index)?;
        let to = starts.get(index + 1).copied().unwrap_or(text.len());
        Some(text[from..to].trim_end())
    }
}

/// The parts of a block's text that are plain words, as (offset in the text, the part with
/// tags and web addresses blanked out). Code, links and images are left out.
fn plain_text(text: &str) -> Vec<(usize, String)> {
    let mut parts = Vec::new();
    let mut skip = 0usize;
    for (event, range) in Parser::new_ext(text, Options::ENABLE_STRIKETHROUGH).into_offset_iter() {
        match event {
            Event::Start(
                Tag::Link { .. } | Tag::Image { .. } | Tag::CodeBlock(_) | Tag::HtmlBlock,
            ) => {
                skip += 1;
            }
            Event::End(TagEnd::Link | TagEnd::Image | TagEnd::CodeBlock | TagEnd::HtmlBlock) => {
                skip = skip.saturating_sub(1);
            }
            Event::Text(t) if skip == 0 && text.get(range.clone()) == Some(&*t) => {
                parts.push((range.start, blank_out(&t)));
            }
            _ => {}
        }
    }
    parts
}

/// The text with every tag and web address replaced by spaces of the same length.
fn blank_out(text: &str) -> String {
    let mut bytes = text.as_bytes().to_vec();
    let mut blank = |from: usize, to: usize| bytes[from..to].iter_mut().for_each(|b| *b = b' ');
    for (span, _) in tag_spans(text) {
        blank(span.start - 1, span.end);
    }
    let mut at = 0;
    for word in text.split_inclusive(char::is_whitespace) {
        let w = word.trim_end();
        if w.contains("://") || w.starts_with("www.") {
            blank(at, at + w.len());
        }
        at += word.len();
    }
    String::from_utf8(bytes).expect("blanking keeps UTF-8")
}

/// Where any of the names is written in `text` as whole words, ignoring case, in one scan.
/// Where two overlap, the longer name wins (the earlier one among equals), and the words
/// of a name rejected for the letters around it do not hide one that overlaps it.
fn find_words(names: &AhoCorasick, text: &str) -> Vec<(usize, usize)> {
    let (folded, offsets) = fold(text);
    let at = |i: usize| offsets.as_ref().map_or(i, |o| o[i]);
    let word = |c: char| c.is_alphanumeric() || c == '_';
    // Pattern numbers run from the longest name to the shortest.
    let mut candidates: Vec<(usize, usize, usize)> = names
        .find_overlapping_iter(&folded)
        .map(|m| (m.pattern().as_usize(), at(m.start()), at(m.end())))
        .filter(|&(_, from, to)| {
            !text[..from].chars().next_back().is_some_and(word)
                && !text[to..].chars().next().is_some_and(word)
        })
        .collect();
    candidates.sort_unstable();
    let mut found: Vec<(usize, usize)> = Vec::new();
    for (_, from, to) in candidates {
        if !found.iter().any(|&(a, b)| from < b && a < to) {
            found.push((from, to));
        }
    }
    found.sort_unstable();
    found
}

/// The text with every letter in lower case, and where each byte of the result was in the
/// text (absent when the two are the same length, which is every ASCII text).
fn fold(text: &str) -> (String, Option<Vec<usize>>) {
    if text.is_ascii() {
        return (text.to_ascii_lowercase(), None);
    }
    let mut folded = String::with_capacity(text.len());
    let mut offsets = Vec::with_capacity(text.len() + 1);
    for (i, c) in text.char_indices() {
        // A letter that lowers to several (`İ`) is left alone, so that no name needs them.
        let mut lower = c.to_lowercase();
        let c = match (lower.next(), lower.next()) {
            (Some(l), None) => l,
            _ => c,
        };
        offsets.extend(std::iter::repeat_n(i, c.len_utf8()));
        folded.push(c);
    }
    offsets.push(text.len());
    (folded, Some(offsets))
}

/// A page's text as it is on disk, for placing mentions in it.
fn read_file(root: &Path, page: &Page) -> Option<String> {
    std::fs::read_to_string(root.join(&page.path)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use regex::RegexBuilder;

    fn automaton(names: &[&str]) -> AhoCorasick {
        let mut names: Vec<&str> = names.to_vec();
        names.sort_by_key(|n| std::cmp::Reverse(n.chars().count()));
        AhoCorasick::builder()
            .match_kind(MatchKind::Standard)
            .build(names.iter().map(|n| fold(n).0))
            .unwrap()
    }

    fn words(text: &str, names: &[&str]) -> Vec<(usize, usize)> {
        find_words(&automaton(names), text)
    }

    #[test]
    fn words_are_found_whole_and_without_case() {
        assert_eq!(
            words("Rust and rusty, RUST!", &["rust"]),
            [(0, 4), (16, 20)]
        );
        assert_eq!(words("c++ and c", &["c++"]), [(0, 3)]);
        // Case is folded for every script, and offsets are in the text as it is.
        assert_eq!(
            words("ZÜRICH \u{212A}ilo", &["zürich", "kilo"]),
            [(0, 7), (8, 14)]
        );
    }

    #[test]
    fn longer_names_win_where_they_overlap() {
        assert_eq!(
            words("machine learning", &["machine", "machine learning"]),
            [(0, 16)]
        );
    }

    #[test]
    fn a_rejected_occurrence_does_not_hide_one_that_overlaps_it() {
        // `a-a` at 1 is inside the word `xa`; the one at 3 is a whole word.
        assert_eq!(words("xa-a-a", &["a-a"]), [(3, 6)]);
    }

    #[test]
    fn code_links_tags_and_addresses_are_not_mentions() {
        let parts =
            plain_text("see `rust`, [rust](/x.md), #rust and https://rust-lang.org but rust");
        let all: String = parts.iter().map(|(_, t)| t.as_str()).collect();
        assert_eq!(words(&all, &["rust"]).len(), 1, "{all:?}");
    }

    /// The obvious way: one regex per name, every occurrence tried, longest names first.
    fn oracle(text: &str, names: &[String]) -> Vec<(usize, usize)> {
        let word = |c: char| c.is_alphanumeric() || c == '_';
        let mut names: Vec<&String> = names.iter().collect();
        names.sort_by_key(|n| std::cmp::Reverse(n.chars().count()));
        let mut found: Vec<(usize, usize)> = Vec::new();
        for name in names {
            let re = RegexBuilder::new(&regex::escape(name))
                .case_insensitive(true)
                .build()
                .unwrap();
            let mut from = 0;
            while let Some(m) = re.find_at(text, from) {
                from = m.start() + text[m.start()..].chars().next().unwrap().len_utf8();
                let (a, b) = (m.start(), m.end());
                if !text[..a].chars().next_back().is_some_and(word)
                    && !text[b..].chars().next().is_some_and(word)
                    && !found.iter().any(|&(x, y)| a < y && x < b)
                {
                    found.push((a, b));
                }
            }
        }
        found.sort();
        found
    }

    proptest! {
        /// One scan finds what a search per name finds, on texts built from a few letters,
        /// separators and letters that change size when lowered, so that names overlap.
        #[test]
        fn one_scan_finds_what_a_search_per_name_finds(
            text in "[abAB\u{e9}\u{c9}\u{212A}k_ +-]{0,40}",
            names in prop::collection::vec("[abAB\u{e9}\u{c9}k+-][abAB\u{e9}k +-]{0,3}", 1..4),
        ) {
            let names: Vec<String> = names
                .into_iter()
                .map(|n| n.split_whitespace().collect::<Vec<_>>().join(" "))
                .filter(|n| n.chars().count() >= MIN_NAME_CHARS)
                .collect();
            prop_assume!(!names.is_empty());
            let refs: Vec<&str> = names.iter().map(String::as_str).collect();
            prop_assert_eq!(words(&text, &refs), oracle(&text, &names));
        }
    }
}
