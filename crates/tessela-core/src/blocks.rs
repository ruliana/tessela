//! Blocks: the unit queries return (spec §3). They are derived from the CommonMark
//! structure of a page body and are never stored in the file.

use std::collections::HashMap;
use std::ops::Range;

use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use serde::Serialize;

use crate::refs::{markdown_options, ref_spans};

/// Whether a list item is a checkbox, and ticked: `- [ ]` is open, `- [x]` is done.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum TaskState {
    Open,
    Done,
}

/// What a block is made of. The same words are used by the editor's page model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum BlockKind {
    /// A paragraph.
    Paragraph,
    /// A list item: its own text, with the items and blocks it owns as children.
    Item,
    /// A fenced or indented code block.
    Code,
    /// A block quote that is not a callout.
    Quote,
    /// A block quote whose first line is `> [!NOTE]` (or TIP, IMPORTANT, WARNING, CAUTION).
    Callout,
    Table,
    /// A block of raw HTML.
    Html,
}

#[derive(Debug, Clone, Serialize)]
pub struct Block {
    /// Page ID plus a hash of the block text; see spec §3, "Block handles".
    pub handle: String,
    /// Index of the enclosing list item's block, if any.
    pub parent: Option<usize>,
    pub heading_path: Vec<String>,
    pub text: String,
    pub kind: BlockKind,
    /// 1-based line in the file where the block starts.
    pub line: usize,
    /// 1-based line where the block ends, inclusive: the last line of the block and of
    /// everything it owns (its list items, its code, quote and callout children, and the
    /// list under a paragraph). Never before `line`; a child ends no later than its parent.
    pub end_line: usize,
    /// Index of the heading whose section the block is in: the nearest one above it.
    pub section: Option<usize>,
    /// Concepts the block itself mentions.
    pub refs: Vec<String>,
    /// Own refs plus those of ancestor list items and headings.
    pub path_refs: Vec<String>,
    /// Set for a list item that starts with a checkbox. The text does not hold the box.
    pub task: Option<TaskState>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Heading {
    /// Page ID plus a hash of the heading text, like a block handle (spec §3).
    pub handle: String,
    pub text: String,
    pub level: u8,
    /// 1-based line in the file.
    pub line: usize,
    /// 1-based last line of the heading's section: everything up to the next heading of the
    /// same or a higher level, or to the end of the page. A heading with nothing under it
    /// ends on its own line.
    pub end_line: usize,
    /// Index of the heading this one sits under, if any.
    pub parent: Option<usize>,
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

/// One block of a page as `tessela blocks` prints it.
#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct BlockRow {
    pub handle: String,
    pub kind: BlockKind,
    /// 1-based first line.
    pub line: usize,
    /// 1-based last line, inclusive, with everything the block owns.
    pub end_line: usize,
    /// Handle of the block this one is a child of: the item it is in, or the paragraph that
    /// owns the list it starts.
    pub parent: Option<String>,
    /// Handle of the heading whose section the block is in.
    pub section: Option<String>,
    /// The text of the block itself: an item's does not include its children.
    pub text: String,
    pub task: Option<TaskState>,
}

/// One heading of a page as `tessela blocks` prints it.
#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct HeadingRow {
    pub handle: String,
    pub level: u8,
    /// 1-based line of the heading.
    pub line: usize,
    /// 1-based last line of its section, inclusive.
    pub end_line: usize,
    /// Handle of the heading this one sits under.
    pub parent: Option<String>,
    pub text: String,
}

/// The shape of a page: its headings, each with the section it owns, and its blocks, each
/// with the span it covers, in document order. This is how the conventions read the page, and
/// what the editor's page model is checked against.
#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct Structure {
    pub page: String,
    pub headings: Vec<HeadingRow>,
    pub blocks: Vec<BlockRow>,
}

impl Structure {
    pub fn of(page: &crate::page::Page) -> Structure {
        let heading_handle = |i: usize| page.headings[i].handle.clone();
        Structure {
            page: page.id.clone(),
            headings: page
                .headings
                .iter()
                .map(|h| HeadingRow {
                    handle: h.handle.clone(),
                    level: h.level,
                    line: h.line,
                    end_line: h.end_line,
                    parent: h.parent.map(heading_handle),
                    text: h.text.clone(),
                })
                .collect(),
            blocks: page
                .blocks
                .iter()
                .map(|b| BlockRow {
                    handle: b.handle.clone(),
                    kind: b.kind,
                    line: b.line,
                    end_line: b.end_line,
                    parent: b.parent.map(|p| page.blocks[p].handle.clone()),
                    section: b.section.map(heading_handle),
                    text: b.text.clone(),
                    task: b.task,
                })
                .collect(),
        }
    }
}

struct OpenItem {
    block: usize,
    range: Range<usize>,
    finalized: bool,
}

struct Parse<'a> {
    body: &'a str,
    /// Every reference of the body and where it is written, from one parse of the whole body.
    spans: Vec<(usize, String)>,
    base_line: usize,
    page_id: &'a str,
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
        spans: ref_spans(body, page_dir),
        base_line,
        page_id,
        out: ParsedBody::default(),
        heading_stack: Vec::new(),
        items: Vec::new(),
        top_paragraph: None,
        attach: None,
    };
    p.run();
    p.finish_spans();
    p.finish_handles();
    p.out
}

impl Parse<'_> {
    fn run(&mut self) {
        // Depth inside an opaque element (heading, quote, table, ...) whose events we skip.
        let mut skip = 0usize;
        for (event, range) in Parser::new_ext(self.body, markdown_options()).into_offset_iter() {
            if skip > 0 {
                match event {
                    Event::Start(_) => skip += 1,
                    Event::End(_) => skip -= 1,
                    _ => {}
                }
                continue;
            }
            match event {
                // A `#` line inside a list item is part of the item's text, not a section.
                Event::Start(Tag::Heading { .. }) if !self.items.is_empty() => {}
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
                    let kind = match tag {
                        Tag::Paragraph => BlockKind::Paragraph,
                        Tag::BlockQuote(_) if self.is_callout(range.clone()) => BlockKind::Callout,
                        Tag::BlockQuote(_) => BlockKind::Quote,
                        Tag::Table(_) => BlockKind::Table,
                        Tag::HtmlBlock => BlockKind::Html,
                        _ => BlockKind::Code,
                    };
                    self.content_block(range, kind);
                    skip = 1;
                }
                _ => {}
            }
        }
    }

    /// The concepts referenced in a byte range of the body, each once, in order. The whole body
    /// was read at once, so a code span, an indented code block or a table is what the page says
    /// it is, not what its own text would be on its own.
    fn refs_in(&self, range: Range<usize>) -> Vec<String> {
        let mut refs = Vec::new();
        for (at, id) in &self.spans {
            if range.contains(at) {
                extend_unique(&mut refs, std::slice::from_ref(id));
            }
        }
        refs
    }

    fn line_of(&self, offset: usize) -> usize {
        self.base_line + self.body[..offset].matches('\n').count()
    }

    /// The line a range ends on, inclusive: the line of its last character that is not
    /// white space (a range of the parser takes in the line break after the block).
    fn end_line_of(&self, range: &Range<usize>) -> usize {
        let text = self.body[range.clone()].trim_end();
        self.line_of(range.start) + text.matches('\n').count()
    }

    /// A quote whose first line is `> [!NOTE]`, alone on the line, with one of the five
    /// names GitHub knows.
    fn is_callout(&self, range: Range<usize>) -> bool {
        let first = self.body[range].lines().next().unwrap_or("");
        let Some(rest) = first.trim_start().strip_prefix('>') else {
            return false;
        };
        let Some(name) = rest
            .trim()
            .strip_prefix("[!")
            .and_then(|r| r.strip_suffix(']'))
        else {
            return false;
        };
        ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]
            .iter()
            .any(|k| name.eq_ignore_ascii_case(k))
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
        let refs = self.refs_in(range.clone());
        while let Some(&top) = self.heading_stack.last() {
            if self.out.headings[top].level >= level {
                self.heading_stack.pop();
            } else {
                break;
            }
        }
        let heading_path = self.heading_path();
        let parent = self.heading_stack.last().copied();
        let mut path_refs = self
            .heading_stack
            .last()
            .map_or_else(Vec::new, |&i| self.out.headings[i].path_refs.clone());
        extend_unique(&mut path_refs, &refs);
        self.out.headings.push(Heading {
            handle: String::new(),
            line: self.line_of(range.start),
            end_line: self.line_of(range.start),
            parent,
            text,
            level,
            heading_path,
            refs,
            path_refs,
        });
        self.heading_stack.push(self.out.headings.len() - 1);
    }

    /// A paragraph, quote, table, code block or HTML block. At the top level it is a
    /// block of its own. Inside a list item, a code block, quote or callout is a child
    /// block of the item, and ends the item's own text. A paragraph, table or HTML block
    /// is part of the item's text, unless it comes after a nested list or a child
    /// block: then it is a block under that item too.
    fn content_block(&mut self, range: Range<usize>, kind: BlockKind) {
        match self.items.last().map(|i| (i.block, i.finalized)) {
            None => {
                self.block_under(None, range.clone(), kind);
                self.top_paragraph = (kind == BlockKind::Paragraph).then(|| {
                    let end = range.start + self.body[range].trim_end().len();
                    (self.out.blocks.len() - 1, end)
                });
            }
            Some((parent, true)) => self.block_under(Some(parent), range, kind),
            Some((parent, false)) => {
                if matches!(
                    kind,
                    BlockKind::Code | BlockKind::Quote | BlockKind::Callout
                ) {
                    self.finalize_open_item(range.start);
                    self.block_under(Some(parent), range, kind);
                }
            }
        }
    }

    fn block_under(&mut self, parent: Option<usize>, range: Range<usize>, kind: BlockKind) {
        let text = self.body[range.clone()].trim().to_string();
        let refs = self.refs_in(range.clone());
        let mut path_refs = parent.map_or_else(Vec::new, |p| self.out.blocks[p].path_refs.clone());
        extend_unique(&mut path_refs, &self.heading_refs());
        extend_unique(&mut path_refs, &refs);
        let (line, end_line) = (self.line_of(range.start), self.end_line_of(&range));
        self.push_block(parent, kind, text, line, end_line, refs);
        self.out.blocks.last_mut().unwrap().path_refs = path_refs;
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
        let (line, end_line) = (self.line_of(range.start), self.end_line_of(&range));
        self.push_block(
            parent,
            BlockKind::Item,
            String::new(),
            line,
            end_line,
            Vec::new(),
        );
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
        let raw = &self.body[start..end.max(start)];
        let task = task_state(raw);
        let text = item_text(raw);
        let refs = self.refs_in(start..end.max(start));
        let parent = self.out.blocks[idx].parent;
        let mut path_refs = parent.map_or_else(Vec::new, |p| self.out.blocks[p].path_refs.clone());
        extend_unique(&mut path_refs, &self.heading_refs());
        extend_unique(&mut path_refs, &refs);
        let block = &mut self.out.blocks[idx];
        block.text = text;
        block.refs = refs;
        block.path_refs = path_refs;
        block.task = task;
    }

    fn push_block(
        &mut self,
        parent: Option<usize>,
        kind: BlockKind,
        text: String,
        line: usize,
        end_line: usize,
        refs: Vec<String>,
    ) {
        let mut path_refs = self.heading_refs();
        extend_unique(&mut path_refs, &refs);
        self.out.blocks.push(Block {
            handle: String::new(),
            parent,
            heading_path: self.heading_path(),
            kind,
            text,
            line,
            end_line,
            section: self.heading_stack.last().copied(),
            refs,
            path_refs,
            task: None,
        });
    }

    /// A block ends with what it owns, and a heading ends with its section.
    fn finish_spans(&mut self) {
        // Children come after their parent, so one pass from the end reaches every ancestor.
        for i in (0..self.out.blocks.len()).rev() {
            if let Some(parent) = self.out.blocks[i].parent {
                let end = self.out.blocks[i].end_line;
                let p = &mut self.out.blocks[parent];
                p.end_line = p.end_line.max(end);
            }
        }
        let lines: Vec<&str> = self.body.lines().collect();
        let last = self.base_line + lines.len().saturating_sub(1);
        for i in 0..self.out.headings.len() {
            let (line, level) = (self.out.headings[i].line, self.out.headings[i].level);
            let boundary = self.out.headings[i + 1..]
                .iter()
                .find(|h| h.level <= level)
                .map_or(last, |h| h.line - 1);
            // The section ends on its last line with something on it.
            let mut end = boundary.max(line);
            while end > line
                && lines
                    .get(end - self.base_line)
                    .is_none_or(|l| l.trim().is_empty())
            {
                end -= 1;
            }
            self.out.headings[i].end_line = end;
        }
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

const CHECKBOXES: [(&str, TaskState); 3] = [
    ("[ ] ", TaskState::Open),
    ("[x] ", TaskState::Done),
    ("[X] ", TaskState::Done),
];

/// Whether a list item starts with a checkbox, and which one.
fn task_state(raw: &str) -> Option<TaskState> {
    let first = strip_list_marker(raw.trim_end().lines().next()?.trim_start());
    CHECKBOXES
        .iter()
        .find_map(|(c, state)| first.starts_with(c).then_some(*state))
}

/// The text of a list item without its marker, task checkbox and continuation indent.
fn item_text(raw: &str) -> String {
    let mut lines = raw.trim_end().lines();
    let first = lines.next().unwrap_or("").trim_start();
    let first = strip_list_marker(first);
    let first = CHECKBOXES
        .iter()
        .find_map(|(c, _)| first.strip_prefix(c))
        .unwrap_or(first);
    let mut out = first.to_string();
    for line in lines {
        out.push('\n');
        out.push_str(line.trim_start());
    }
    out.trim().to_string()
}

fn strip_list_marker(line: &str) -> &str {
    // A marker alone on its line is an item with no text.
    let line = line.trim_end();
    if let Some(rest) = line.strip_prefix(['-', '*', '+'])
        && (rest.is_empty() || rest.starts_with(' '))
    {
        return rest.trim_start();
    }
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if digits > 0
        && let Some(rest) = line[digits..].strip_prefix(['.', ')'])
        && (rest.is_empty() || rest.starts_with(' '))
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
    fn kinds(p: &ParsedBody) -> Vec<BlockKind> {
        p.blocks.iter().map(|b| b.kind).collect()
    }

    fn spans(p: &ParsedBody) -> Vec<(usize, usize)> {
        p.blocks.iter().map(|b| (b.line, b.end_line)).collect()
    }

    #[test]
    fn each_kind_of_block_has_a_kind_and_a_span() {
        use BlockKind::*;
        let p = parse(
            "para\nline two\n\n- item\n\n```\ncode\n```\n\n    indented\n\n> quote\n> more\n\n> [!NOTE]\n> text\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<div>\nhtml\n</div>\n",
        );
        assert_eq!(
            kinds(&p),
            [Paragraph, Item, Code, Code, Quote, Callout, Table, Html]
        );
        assert_eq!(
            spans(&p),
            [
                (1, 2),
                (4, 4),
                (6, 8),
                (10, 10),
                (12, 13),
                (15, 16),
                (18, 20),
                (22, 24)
            ]
        );
    }

    #[test]
    fn a_callout_is_a_quote_whose_first_line_names_a_kind_alone() {
        use BlockKind::*;
        let p = parse(
            "> [!tip]\n> a\n\n>[!CAUTION]\n\n> [!NOTE] and text\n\n> [!DANGER]\n\n> text\n> [!NOTE]\n",
        );
        assert_eq!(kinds(&p), [Callout, Callout, Quote, Quote, Quote]);
    }

    #[test]
    fn a_block_ends_with_what_it_owns() {
        let p =
            parse("- parent\n  - child\n    - grandchild\n- next\n\nIdea\n- under idea\n\nAfter\n");
        // parent, child, grandchild, next, Idea, under idea, After
        assert_eq!(
            spans(&p),
            [(1, 3), (2, 3), (3, 3), (4, 4), (6, 7), (7, 7), (9, 9)]
        );
    }

    #[test]
    fn spans_of_text_with_wide_characters_end_on_the_right_line() {
        let p = parse("日本語 ໆ\n日本語\n\n- é\n  - 😀\n");
        assert_eq!(spans(&p), [(1, 2), (4, 5), (5, 5)]);
    }

    #[test]
    fn spans_do_not_take_in_blank_lines_and_follow_the_base_line() {
        let p = parse_body("a\n\n\n- b\n\n\n", 10, "x");
        assert_eq!(spans(&p), [(10, 10), (13, 13)]);
    }

    #[test]
    fn code_and_quote_inside_an_item_are_children_of_the_item() {
        use BlockKind::*;
        let p = parse("- item #a\n  ```\n  code #no\n  ```\n  > quote #b\n  > more\n- next\n");
        assert_eq!(kinds(&p), [Item, Code, Quote, Item]);
        assert_eq!(p.blocks[0].text, "item #a");
        assert_eq!(p.blocks[1].parent, Some(0));
        assert_eq!(p.blocks[2].parent, Some(0));
        assert_eq!(p.blocks[3].parent, None);
        assert!(p.blocks[1].refs.is_empty());
        assert_eq!(p.blocks[1].path_refs, ["a"]);
        assert_eq!(p.blocks[2].path_refs, ["a", "b"]);
        assert_eq!(spans(&p), [(1, 6), (2, 4), (5, 6), (7, 7)]);
    }

    #[test]
    fn an_item_with_no_text_has_no_text() {
        let p = parse("-\n- \n1.\n- [ ]\n- x\n");
        let texts: Vec<_> = p.blocks.iter().map(|b| b.text.as_str()).collect();
        assert_eq!(texts, ["", "", "", "[ ]", "x"]);
    }

    #[test]
    fn a_callout_inside_an_item_is_a_callout_child() {
        use BlockKind::*;
        let p = parse("- item\n  > [!WARNING]\n  > careful #w\n  - nested\n");
        assert_eq!(kinds(&p), [Item, Callout, Item]);
        assert_eq!(p.blocks[1].parent, Some(0));
        assert_eq!(p.blocks[2].parent, Some(0));
        assert_eq!(p.blocks[0].text, "item");
        assert_eq!(spans(&p), [(1, 4), (2, 3), (4, 4)]);
    }

    #[test]
    fn a_fence_on_the_marker_line_gives_an_item_with_no_text() {
        use BlockKind::*;
        let p = parse("- ```\n  code\n  ```\n");
        assert_eq!(kinds(&p), [Item, Code]);
        assert_eq!(p.blocks[0].text, "");
        assert_eq!(p.blocks[1].parent, Some(0));
        assert_eq!(spans(&p), [(1, 3), (1, 3)]);
    }

    #[test]
    fn a_paragraph_after_a_child_block_is_a_child_block_too() {
        use BlockKind::*;
        let p = parse("- item\n\n  ```\n  code\n  ```\n\n  after #c\n- next\n");
        assert_eq!(kinds(&p), [Item, Code, Paragraph, Item]);
        assert_eq!(p.blocks[2].parent, Some(0));
        assert_eq!(p.blocks[2].path_refs, ["c"]);
    }

    #[test]
    fn a_fence_in_a_nested_item_belongs_to_that_item() {
        let p = parse("- a\n  - b\n    ```\n    x\n    ```\n  - c\n");
        assert_eq!(p.blocks[2].kind, BlockKind::Code);
        assert_eq!(p.blocks[2].parent, Some(1));
        assert_eq!(spans(&p), [(1, 6), (2, 5), (3, 5), (6, 6)]);
    }

    #[test]
    fn a_heading_ends_with_its_section() {
        let p = parse(
            "# One\n\ntext\n\n## Sub\n\nmore\n\n```\n# not a heading\n```\n\n# Two\n\n## Empty\n\n# Three\n",
        );
        let spans: Vec<_> = p
            .headings
            .iter()
            .map(|h| (h.text.as_str(), h.line, h.end_line))
            .collect();
        assert_eq!(
            spans,
            [
                ("One", 1, 11),
                ("Sub", 5, 11),
                ("Two", 13, 15),
                ("Empty", 15, 15),
                ("Three", 17, 17)
            ]
        );
        let parents: Vec<_> = p.headings.iter().map(|h| h.parent).collect();
        assert_eq!(parents, [None, Some(0), None, Some(2), None]);
    }

    #[test]
    fn a_heading_line_inside_an_item_is_text_of_the_item_not_a_section() {
        let p = parse("# Top\n\n- item\n  ## inside #a\n- next\n\n## Real\n");
        let headings: Vec<_> = p.headings.iter().map(|h| h.text.as_str()).collect();
        assert_eq!(headings, ["Top", "Real"]);
        assert_eq!(p.blocks[0].text, "item\n## inside #a");
        assert_eq!(p.blocks[0].refs, ["a"]);
        assert_eq!(p.blocks[1].section, Some(0));
        assert_eq!(p.headings[0].end_line, 7);
    }

    #[test]
    fn a_block_knows_the_heading_it_is_under() {
        let p = parse("above\n\n# One\n\na\n\n## Sub\n\nb\n\n# Two\n\nc\n");
        let sections: Vec<_> = p.blocks.iter().map(|b| b.section).collect();
        assert_eq!(sections, [None, Some(0), Some(1), Some(2)]);
    }

    #[test]
    fn a_section_ends_where_the_page_does() {
        let p = parse_body("# H\n\ntext\n\n\n", 3, "x");
        assert_eq!((p.headings[0].line, p.headings[0].end_line), (3, 5));
    }
}
