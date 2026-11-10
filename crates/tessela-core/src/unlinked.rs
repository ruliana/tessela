//! Unlinked mentions: text that names a concept without being a link or a tag to it.
//!
//! `query --unlinked NAME` finds, in blocks that do not already reach the concept, the
//! places where its title, one of its aliases or a `vocabulary.md` term for it is written
//! as plain words. Each place is a [`Mention`] with the position and the link that would
//! turn it into a reference, so a client can offer "Link" and write it as a patch.
//! Code, existing links, tags and web addresses are not searched.

use std::path::Path;

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use regex::RegexBuilder;
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
    /// The names to look for, longest first.
    names: Vec<String>,
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

    /// The mentions in a block. `file` is the page's text, to place them in it.
    pub fn mentions(&self, page: &Page, block: &Block, file: Option<&str>) -> Vec<Mention> {
        if self.is_page(page) || self.names.is_empty() {
            return Vec::new();
        }
        let mut found: Vec<(usize, usize)> = Vec::new();
        for (start, masked) in plain_text(&block.text) {
            for name in &self.names {
                for (from, to) in find_words(&masked, name) {
                    let (from, to) = (start + from, start + to);
                    // Longer names come first and win where they overlap.
                    if !found.iter().any(|&(a, b)| from < b && a < to) {
                        found.push((from, to));
                    }
                }
            }
        }
        found.sort();
        let lines: Vec<&str> = file.map(|f| f.lines().collect()).unwrap_or_default();
        found
            .into_iter()
            .map(|(from, to)| {
                let text = block.text[from..to].to_string();
                let before = &block.text[..from];
                let row = before.matches('\n').count();
                let in_row = from - before.rfind('\n').map_or(0, |i| i + 1);
                let text_line = block.text.lines().nth(row).unwrap_or("");
                // The block's text lost the list marker and indent: the file line ends
                // with the text line, so the difference is how far in it starts.
                let column = lines
                    .get(block.line - 1 + row)
                    .map(|l| l.trim_end())
                    .filter(|l| l.ends_with(text_line.trim_end()))
                    .map(|l| l.len() - text_line.trim_end().len() + in_row);
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

/// Where `name` is written in `text` as whole words, ignoring case.
fn find_words(text: &str, name: &str) -> Vec<(usize, usize)> {
    let Ok(re) = RegexBuilder::new(&regex::escape(name))
        .case_insensitive(true)
        .build()
    else {
        return Vec::new();
    };
    let word = |c: char| c.is_alphanumeric() || c == '_';
    re.find_iter(text)
        .filter(|m| {
            !text[..m.start()].chars().next_back().is_some_and(word)
                && !text[m.end()..].chars().next().is_some_and(word)
        })
        .map(|m| (m.start(), m.end()))
        .collect()
}

/// A page's text as it is on disk, for placing mentions in it.
pub fn read_file(root: &Path, page: &Page) -> Option<String> {
    std::fs::read_to_string(root.join(&page.path)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_are_found_whole_and_without_case() {
        assert_eq!(
            find_words("Rust and rusty, RUST!", "rust"),
            [(0, 4), (16, 20)]
        );
        assert_eq!(find_words("c++ and c", "c++"), [(0, 3)]);
    }

    #[test]
    fn code_links_tags_and_addresses_are_not_mentions() {
        let parts =
            plain_text("see `rust`, [rust](/x.md), #rust and https://rust-lang.org but rust");
        let all: String = parts.iter().map(|(_, t)| t.as_str()).collect();
        assert_eq!(find_words(&all, "rust").len(), 1, "{all:?}");
    }
}
