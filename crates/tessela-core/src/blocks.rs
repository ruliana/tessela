//! Blocks: the unit queries return (spec §3). They are derived from the CommonMark
//! structure of a page body and are never stored in the file.

use std::collections::HashMap;
use std::ops::Range;

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use serde::Serialize;

use crate::refs::extract_refs;

#[derive(Debug, Clone, Serialize)]
pub struct Block {
    /// Page ID plus a hash of the block text; see spec §3, "Block handles".
    pub handle: String,
    /// Index of the enclosing list item's block, if any.
    pub parent: Option<usize>,
    pub heading_path: Vec<String>,
    pub text: String,
    /// 1-based line in the file where the block starts.
    pub line: usize,
    /// Concepts the block itself mentions.
    pub refs: Vec<String>,
    /// Own refs plus those of ancestor list items and headings.
    pub path_refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Heading {
    /// Page ID plus a hash of the heading text, like a block handle (spec §3).
    pub handle: String,
    pub text: String,
    pub level: u8,
    /// 1-based line in the file.
    pub line: usize,
    /// The headings above this one.
    pub heading_path: Vec<String>,
    /// Concepts the heading itself mentions.
    pub refs: Vec<String>,
    /// Own refs plus those of the headings above.
    pub path_refs: Vec<String>,
}

#[derive(Debug, Default)]
pub struct ParsedBody {
    pub blocks: Vec<Block>,
    pub headings: Vec<Heading>,
}

struct OpenItem {
    block: usize,
    range: Range<usize>,
    finalized: bool,
}

struct Parse<'a> {
    body: &'a str,
    base_line: usize,
    page_id: &'a str,
    page_dir: &'a str,
    out: ParsedBody,
    heading_stack: Vec<usize>,
    items: Vec<OpenItem>,
    /// The last top-level paragraph, with the offset where its text ends. A list that
    /// starts on the very next line belongs to it.
    top_paragraph: Option<(usize, usize)>,
    /// The paragraph that owns the top-level list being read.
    attach: Option<usize>,
}

pub fn parse_body(body: &str, base_line: usize, page_id: &str) -> ParsedBody {
    let page_dir = page_id.rsplit_once('/').map_or("", |(dir, _)| dir);
    let mut p = Parse {
        body,
        base_line,
        page_id,
        page_dir,
        out: ParsedBody::default(),
        heading_stack: Vec::new(),
        items: Vec::new(),
        top_paragraph: None,
        attach: None,
    };
    p.run();
    p.finish_handles();
    p.out
}

impl Parse<'_> {
    fn run(&mut self) {
        let opts =
            Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
        // Depth inside an opaque element (heading, quote, table, ...) whose events we skip.
        let mut skip = 0usize;
        for (event, range) in Parser::new_ext(self.body, opts).into_offset_iter() {
            if skip > 0 {
                match event {
                    Event::Start(_) => skip += 1,
                    Event::End(_) => skip -= 1,
                    _ => {}
                }
                continue;
            }
            match event {
                Event::Start(Tag::Heading { level, .. }) => {
                    self.heading(level as u8, range);
                    self.top_paragraph = None;
                    skip = 1;
                }
                Event::Start(Tag::Item) => self.start_item(range),
                Event::Start(Tag::List(_)) => {
                    self.finalize_open_item(range.start);
                    if self.items.is_empty() {
                        self.attach = self.paragraph_above(range.start);
                    }
                }
                Event::End(TagEnd::List(_)) if self.items.is_empty() => {
                    self.attach = None;
                    self.top_paragraph = None;
                }
                Event::End(TagEnd::Item) => {
                    if let Some(item) = self.items.last()
                        && !item.finalized
                    {
                        let end = item.range.end;
                        self.finalize_open_item(end);
                    }
                    self.items.pop();
                }
                Event::Start(
                    tag @ (Tag::Paragraph
                    | Tag::BlockQuote(_)
                    | Tag::Table(_)
                    | Tag::HtmlBlock
                    | Tag::CodeBlock(_)),
                ) => {
                    self.content_block(range, matches!(tag, Tag::Paragraph));
                    skip = 1;
                }
                _ => {}
            }
        }
    }

    fn line_of(&self, offset: usize) -> usize {
        self.base_line + self.body[..offset].matches('\n').count()
    }

    fn heading_path(&self) -> Vec<String> {
        self.heading_stack
            .iter()
            .map(|&i| self.out.headings[i].text.clone())
            .collect()
    }

    fn heading_refs(&self) -> Vec<String> {
        let mut refs = Vec::new();
        for &i in &self.heading_stack {
            extend_unique(&mut refs, &self.out.headings[i].refs);
        }
        refs
    }

    fn heading(&mut self, level: u8, range: Range<usize>) {
        let first_line = self.body[range.clone()].lines().next().unwrap_or("");
        let text = first_line
            .trim()
            .trim_start_matches('#')
            .trim_end_matches('#')
            .trim()
            .to_string();
        let refs = extract_refs(&text, self.page_dir);
        while let Some(&top) = self.heading_stack.last() {
            if self.out.headings[top].level >= level {
                self.heading_stack.pop();
            } else {
                break;
            }
        }
        let heading_path = self.heading_path();
        let mut path_refs = self
            .heading_stack
            .last()
            .map_or_else(Vec::new, |&i| self.out.headings[i].path_refs.clone());
        extend_unique(&mut path_refs, &refs);
        self.out.headings.push(Heading {
            handle: String::new(),
            line: self.line_of(range.start),
            text,
            level,
            heading_path,
            refs,
            path_refs,
        });
        self.heading_stack.push(self.out.headings.len() - 1);
    }

    /// A paragraph, quote, table, code block or HTML block. At the top level it is a
    /// block of its own. Inside a list item it is part of the item's text, unless it
    /// comes after a nested list: then it is a block under that item.
    fn content_block(&mut self, range: Range<usize>, is_paragraph: bool) {
        match self.items.last().map(|i| (i.block, i.finalized)) {
            None => {
                self.top_level_block(range.clone());
                self.top_paragraph = is_paragraph.then(|| {
                    let end = range.start + self.body[range].trim_end().len();
                    (self.out.blocks.len() - 1, end)
                });
            }
            Some((parent, true)) => self.trailing_block(parent, range),
            Some((_, false)) => {}
        }
    }

    fn trailing_block(&mut self, parent: usize, range: Range<usize>) {
        let text = self.body[range.clone()].trim().to_string();
        let refs = extract_refs(&text, self.page_dir);
        let mut path_refs = self.out.blocks[parent].path_refs.clone();
        extend_unique(&mut path_refs, &refs);
        self.push_block(Some(parent), text, self.line_of(range.start), refs);
        self.out.blocks.last_mut().unwrap().path_refs = path_refs;
    }

    fn top_level_block(&mut self, range: Range<usize>) {
        let text = self.body[range.clone()].trim().to_string();
        let refs = extract_refs(&text, self.page_dir);
        self.push_block(None, text, self.line_of(range.start), refs);
    }

    /// The top-level paragraph that a list starting at `list_start` belongs to: the one
    /// whose text ends on the line right above it, with no blank line between.
    fn paragraph_above(&self, list_start: usize) -> Option<usize> {
        let (block, end) = self.top_paragraph?;
        let gap = self.body.get(end..list_start)?;
        (gap.matches('\n').count() == 1 && gap.trim().is_empty()).then_some(block)
    }

    fn start_item(&mut self, range: Range<usize>) {
        let parent = self.items.last().map(|i| i.block).or(self.attach);
        // The block is filled in once the item's own text (before any nested list) is known.
        self.push_block(parent, String::new(), self.line_of(range.start), Vec::new());
        self.items.push(OpenItem {
            block: self.out.blocks.len() - 1,
            range,
            finalized: false,
        });
    }

    /// Fixes the text of the open item: everything before `end`, which is where its
    /// nested list starts or where the item itself ends.
    fn finalize_open_item(&mut self, end: usize) {
        let Some(item) = self.items.last_mut() else {
            return;
        };
        if item.finalized {
            return;
        }
        item.finalized = true;
        let (idx, start) = (item.block, item.range.start);
        let text = item_text(&self.body[start..end.max(start)]);
        let refs = extract_refs(&text, self.page_dir);
        let parent = self.out.blocks[idx].parent;
        let mut path_refs = parent.map_or_else(Vec::new, |p| self.out.blocks[p].path_refs.clone());
        extend_unique(&mut path_refs, &self.heading_refs());
        extend_unique(&mut path_refs, &refs);
        let block = &mut self.out.blocks[idx];
        block.text = text;
        block.refs = refs;
        block.path_refs = path_refs;
    }

    fn push_block(&mut self, parent: Option<usize>, text: String, line: usize, refs: Vec<String>) {
        let mut path_refs = self.heading_refs();
        extend_unique(&mut path_refs, &refs);
        self.out.blocks.push(Block {
            handle: String::new(),
            parent,
            heading_path: self.heading_path(),
            text,
            line,
            refs,
            path_refs,
        });
    }

    /// Handles are the page ID plus a hash of the normalized text, with `.N` added
    /// from the second identical block onwards.
    fn finish_handles(&mut self) {
        let mut seen: HashMap<String, usize> = HashMap::new();
        let mut handle = |page_id: &str, normalized: &str| {
            let hash = blake3::hash(normalized.as_bytes()).to_hex();
            let hash = &hash[..8];
            let n = seen
                .entry(hash.to_string())
                .and_modify(|n| *n += 1)
                .or_insert(1);
            if *n == 1 {
                format!("{page_id}#{hash}")
            } else {
                format!("{page_id}#{hash}.{n}")
            }
        };
        for block in &mut self.out.blocks {
            let normalized = block.text.split_whitespace().collect::<Vec<_>>().join(" ");
            block.handle = handle(self.page_id, &normalized);
        }
        // A heading hashes with its `# ` prefix, so it never collides with a block of the same text.
        for heading in &mut self.out.headings {
            let normalized = heading
                .text
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            heading.handle = handle(self.page_id, &format!("# {normalized}"));
        }
    }
}

fn extend_unique(into: &mut Vec<String>, from: &[String]) {
    for r in from {
        if !into.contains(r) {
            into.push(r.clone());
        }
    }
}

/// The text of a list item without its marker, task checkbox and continuation indent.
fn item_text(raw: &str) -> String {
    let mut lines = raw.trim_end().lines();
    let first = lines.next().unwrap_or("").trim_start();
    let first = strip_list_marker(first);
    let first = ["[ ] ", "[x] ", "[X] "]
        .iter()
        .find_map(|c| first.strip_prefix(c))
        .unwrap_or(first);
    let mut out = first.to_string();
    for line in lines {
        out.push('\n');
        out.push_str(line.trim_start());
    }
    out.trim().to_string()
}

fn strip_list_marker(line: &str) -> &str {
    if let Some(rest) = line.strip_prefix(['-', '*', '+'])
        && let Some(rest) = rest.strip_prefix(' ')
    {
        return rest.trim_start();
    }
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if digits > 0
        && let Some(rest) = line[digits..].strip_prefix(['.', ')'])
        && let Some(rest) = rest.strip_prefix(' ')
    {
        return rest.trim_start();
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(body: &str) -> ParsedBody {
        parse_body(body, 1, "notes/page")
    }

    #[test]
    fn paragraphs_and_items_are_blocks() {
        let p = parse("First #a\n\nSecond\n\n- item #b\n  - child #c\n- other\n");
        let texts: Vec<_> = p.blocks.iter().map(|b| b.text.as_str()).collect();
        assert_eq!(
            texts,
            ["First #a", "Second", "item #b", "child #c", "other"]
        );
        assert_eq!(p.blocks[3].parent, Some(2));
        assert_eq!(p.blocks[4].parent, None);
    }

    #[test]
    fn children_inherit_parent_refs() {
        let p = parse("- item #b\n  - child #c\n");
        assert_eq!(p.blocks[1].refs, ["c"]);
        assert_eq!(p.blocks[1].path_refs, ["b", "c"]);
    }

    #[test]
    fn blocks_inherit_heading_refs() {
        let p = parse("# Top #area\n\n## Sub\n\ntext #x\n\n# Next\n\nmore\n");
        assert_eq!(p.blocks[0].path_refs, ["area", "x"]);
        assert_eq!(p.blocks[0].heading_path, ["Top #area", "Sub"]);
        assert!(p.blocks[1].path_refs.is_empty());
    }

    #[test]
    fn code_fence_is_one_block_without_refs() {
        let p = parse("```\n#not-a-tag\n```\n");
        assert_eq!(p.blocks.len(), 1);
        assert!(p.blocks[0].refs.is_empty());
    }

    #[test]
    fn lines_are_one_based_and_offset() {
        let p = parse_body("a\n\nb\n", 5, "x");
        assert_eq!(p.blocks[0].line, 5);
        assert_eq!(p.blocks[1].line, 7);
    }

    #[test]
    fn handles_are_stable_and_disambiguated() {
        let a = parse("same\n\nsame\n\nother\n");
        assert_ne!(a.blocks[0].handle, a.blocks[1].handle);
        assert!(a.blocks[1].handle.ends_with(".2"));
        let b = parse("other\n");
        assert_eq!(a.blocks[2].handle, b.blocks[0].handle);
    }

    #[test]
    fn task_items_and_numbered_items_lose_their_markers() {
        let p = parse("- [ ] todo #t\n1. first\n");
        assert_eq!(p.blocks[0].text, "todo #t");
        assert_eq!(p.blocks[1].text, "first");
    }

    #[test]
    fn headings_have_handles_paths_and_inherited_refs() {
        let p = parse("# Top #a\n\n## Sub #b\n\n### Deep\n\ntext\n");
        let sub = &p.headings[1];
        assert_eq!(sub.heading_path, ["Top #a"]);
        assert_eq!(sub.refs, ["b"]);
        assert_eq!(sub.path_refs, ["a", "b"]);
        assert_eq!(p.headings[2].path_refs, ["a", "b"]);
        assert!(p.headings[0].handle.starts_with("notes/page#"));
    }

    #[test]
    fn heading_and_paragraph_with_the_same_text_get_different_handles() {
        let p = parse("# Same\n\nSame\n");
        assert_ne!(p.headings[0].handle, p.blocks[0].handle);
    }

    #[test]
    fn a_paragraph_after_a_nested_list_is_a_block_under_the_item() {
        let p = parse("- parent #a\n\n  - child #b\n\n  closing #c\n\n- next\n");
        let texts: Vec<_> = p.blocks.iter().map(|b| b.text.as_str()).collect();
        assert_eq!(texts, ["parent #a", "child #b", "closing #c", "next"]);
        assert_eq!(p.blocks[2].parent, Some(0));
        assert_eq!(p.blocks[2].path_refs, ["a", "c"]);
        assert_eq!(p.blocks[3].parent, None);
    }

    #[test]
    fn a_list_right_under_a_paragraph_belongs_to_it() {
        let p = parse("Idea #a\n- child #b\n  - grandchild\n- sibling\n\nOther\n");
        let parents: Vec<_> = p.blocks.iter().map(|b| b.parent).collect();
        assert_eq!(parents, [None, Some(0), Some(1), Some(0), None]);
        assert_eq!(p.blocks[1].path_refs, ["a", "b"]);
        assert_eq!(p.blocks[2].path_refs, ["a", "b"]);
        assert_eq!(p.blocks[3].path_refs, ["a"]);
        assert!(p.blocks[4].path_refs.is_empty());
    }

    #[test]
    fn a_blank_line_keeps_the_list_apart_from_the_paragraph() {
        let p = parse("Idea #a\n\n- item\n");
        assert_eq!(p.blocks[1].parent, None);
        assert!(p.blocks[1].path_refs.is_empty());
    }

    #[test]
    fn only_a_paragraph_owns_a_list_not_a_heading_or_another_list() {
        let p = parse("## Head #a\n- item\n");
        assert_eq!(p.blocks[0].parent, None);
        let p = parse("- one #a\n\nText\n\n- two\n");
        assert_eq!(p.blocks[2].parent, None);
        assert!(p.blocks[2].path_refs.is_empty());
    }

    #[test]
    fn a_paragraph_owns_only_the_list_that_follows_it() {
        let p = parse("First #a\n- under first\n\nSecond\n- under second\n");
        assert_eq!(p.blocks[1].parent, Some(0));
        assert_eq!(p.blocks[3].parent, Some(2));
        assert_eq!(p.blocks[3].path_refs, Vec::<String>::new());
    }
}
