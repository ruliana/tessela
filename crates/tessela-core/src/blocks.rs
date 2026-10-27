//! Blocks: the unit queries return (spec §3). They are derived from the CommonMark
//! structure of a page body and are never stored in the file.

use std::collections::HashMap;
use std::ops::Range;

use pulldown_cmark::{Event, Options, Parser, Tag};
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
    pub text: String,
    pub level: u8,
    pub line: usize,
    pub refs: Vec<String>,
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
                    skip = 1;
                }
                Event::Start(Tag::Item) => self.start_item(range),
                Event::Start(Tag::List(_)) => self.finalize_open_item(range.start),
                Event::End(pulldown_cmark::TagEnd::Item) => {
                    if let Some(item) = self.items.last()
                        && !item.finalized
                    {
                        let end = item.range.end;
                        self.finalize_open_item(end);
                    }
                    self.items.pop();
                }
                Event::Start(
                    Tag::BlockQuote(_) | Tag::Table(_) | Tag::HtmlBlock | Tag::CodeBlock(_),
                ) => {
                    if self.items.is_empty() {
                        self.top_level_block(range);
                    }
                    skip = 1;
                }
                Event::Start(Tag::Paragraph) if self.items.is_empty() => {
                    self.top_level_block(range);
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
        self.out.headings.push(Heading {
            line: self.line_of(range.start),
            text,
            level,
            refs,
        });
        self.heading_stack.push(self.out.headings.len() - 1);
    }

    fn top_level_block(&mut self, range: Range<usize>) {
        let text = self.body[range.clone()].trim().to_string();
        let refs = extract_refs(&text, self.page_dir);
        self.push_block(None, text, self.line_of(range.start), refs);
    }

    fn start_item(&mut self, range: Range<usize>) {
        let parent = self.items.last().map(|i| i.block);
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
        for block in &mut self.out.blocks {
            let normalized = block.text.split_whitespace().collect::<Vec<_>>().join(" ");
            let hash = blake3::hash(normalized.as_bytes()).to_hex();
            let hash = &hash[..8];
            let n = seen
                .entry(hash.to_string())
                .and_modify(|n| *n += 1)
                .or_insert(1);
            block.handle = if *n == 1 {
                format!("{}#{hash}", self.page_id)
            } else {
                format!("{}#{hash}.{n}", self.page_id)
            };
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
}
