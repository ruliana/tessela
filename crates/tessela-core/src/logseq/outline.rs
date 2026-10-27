//! Reading one Logseq markdown file: an optional header of page properties, then an
//! outline of `- ` bullets whose children are indented below them.

/// A bullet and the lines that continue it, with the indentation removed.
#[derive(Debug, Clone)]
pub struct Block {
    pub depth: usize,
    pub lines: Vec<String>,
}

#[derive(Debug, Default)]
pub struct Outline {
    /// Page properties (`title:: ...`), from the header or from a first block that has nothing else.
    pub props: Vec<(String, String)>,
    pub blocks: Vec<Block>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Marker {
    Todo,
    Done,
    Canceled,
}

/// What a block says once its properties, task marker and drawers are taken apart.
#[derive(Debug, Default)]
pub struct Analyzed {
    pub marker: Option<Marker>,
    pub heading: bool,
    pub props: Vec<(String, String)>,
    /// The block text, without properties and logbook drawers.
    pub lines: Vec<String>,
}

impl Analyzed {
    pub fn is_empty(&self) -> bool {
        self.lines.iter().all(|l| l.trim().is_empty()) && self.props.is_empty()
    }

    /// The text on one line, as used when another block quotes this one.
    pub fn inline_text(&self) -> String {
        self.lines
            .iter()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    }
}

pub fn parse(text: &str) -> Outline {
    let mut blocks: Vec<Block> = Vec::new();
    let mut header: Vec<String> = Vec::new();
    let mut indents: Vec<usize> = Vec::new();
    let mut content_indent = 0usize;
    let mut in_fence = false;

    for raw in text.lines() {
        let line = raw.replace('\t', "  ");
        if !in_fence && let Some((indent, rest)) = bullet(&line) {
            while indents.last().is_some_and(|&i| i >= indent) {
                indents.pop();
            }
            blocks.push(Block {
                depth: indents.len(),
                lines: vec![rest.to_string()],
            });
            indents.push(indent);
            content_indent = indent + 2;
            if line.matches("```").count() % 2 == 1 {
                in_fence = !in_fence;
            }
            continue;
        }
        if line.matches("```").count() % 2 == 1 {
            in_fence = !in_fence;
        }
        match blocks.last_mut() {
            Some(block) => block.lines.push(strip_indent(&line, content_indent)),
            None => header.push(line),
        }
    }

    let mut outline = Outline::default();
    // Leading `key:: value` lines before the first bullet are page properties.
    let mut rest = header.as_slice();
    while let Some(first) = rest.first() {
        match property(first) {
            Some(p) => outline.props.push(p),
            None if first.trim().is_empty() => {}
            None => break,
        }
        rest = &rest[1..];
    }
    if rest.iter().any(|l| !l.trim().is_empty()) {
        outline.blocks.push(Block {
            depth: 0,
            lines: rest.to_vec(),
        });
    }
    outline.blocks.extend(blocks);

    // A first block that holds nothing but properties is the page's properties too.
    if outline.props.is_empty()
        && let Some(first) = outline.blocks.first()
        && first.depth == 0
    {
        let a = analyze(first);
        let only_props = !a.props.is_empty() && a.lines.iter().all(|l| l.trim().is_empty());
        if only_props {
            outline.props = a.props;
            outline.blocks.remove(0);
        }
    }
    outline
}

/// `- text`, `-` alone, with its indentation width.
fn bullet(line: &str) -> Option<(usize, &str)> {
    let trimmed = line.trim_start();
    let indent = line.len() - trimmed.len();
    if trimmed == "-" {
        return Some((indent, ""));
    }
    trimmed.strip_prefix("- ").map(|rest| (indent, rest))
}

fn strip_indent(line: &str, width: usize) -> String {
    let spaces = line.len() - line.trim_start_matches(' ').len();
    line[spaces.min(width)..].to_string()
}

/// `key:: value`, with the key in Logseq's character set.
pub fn property(line: &str) -> Option<(String, String)> {
    let (key, value) = line.trim().split_once("::")?;
    let valid_key = !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
    if !valid_key || !(value.is_empty() || value.starts_with(' ')) {
        return None;
    }
    Some((key.to_lowercase(), value.trim().to_string()))
}

const MARKERS: [(&str, Marker); 10] = [
    ("TODO ", Marker::Todo),
    ("LATER ", Marker::Todo),
    ("NOW ", Marker::Todo),
    ("DOING ", Marker::Todo),
    ("WAITING ", Marker::Todo),
    ("WAIT ", Marker::Todo),
    ("IN-PROGRESS ", Marker::Todo),
    ("DONE ", Marker::Done),
    ("CANCELED ", Marker::Canceled),
    ("CANCELLED ", Marker::Canceled),
];

pub fn analyze(block: &Block) -> Analyzed {
    let mut out = Analyzed::default();
    let mut in_fence = false;
    let mut in_drawer = false;
    for line in &block.lines {
        let trimmed = line.trim();
        if !in_fence {
            if trimmed.eq_ignore_ascii_case(":LOGBOOK:") {
                in_drawer = true;
                continue;
            }
            if in_drawer {
                in_drawer = !trimmed.eq_ignore_ascii_case(":END:");
                continue;
            }
            if let Some(p) = property(line) {
                out.props.push(p);
                continue;
            }
        }
        if line.matches("```").count() % 2 == 1 {
            in_fence = !in_fence;
        }
        out.lines.push(line.clone());
    }
    if let Some(first) = out.lines.first_mut() {
        if let Some((prefix, marker)) = MARKERS.iter().find(|(p, _)| first.starts_with(p)) {
            out.marker = Some(*marker);
            *first = first[prefix.len()..].to_string();
        }
        let hashes = first.chars().take_while(|&c| c == '#').count();
        if (1..=6).contains(&hashes) && first[hashes..].starts_with(' ') {
            out.heading = true;
            *first = first[hashes + 1..].trim().to_string();
        }
    }
    while out.lines.last().is_some_and(|l| l.trim().is_empty()) {
        out.lines.pop();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nests_by_indentation_and_keeps_continuation_lines() {
        let o = parse("- one\n  continued\n\t- child\n\t\t- grandchild\n- two\n");
        let shape: Vec<_> = o
            .blocks
            .iter()
            .map(|b| (b.depth, b.lines.clone()))
            .collect();
        assert_eq!(
            shape,
            [
                (0, vec!["one".to_string(), "continued".into()]),
                (1, vec!["child".to_string()]),
                (2, vec!["grandchild".to_string()]),
                (0, vec!["two".to_string()]),
            ]
        );
    }

    #[test]
    fn header_properties_are_page_properties() {
        let o = parse("title:: My Page\nalias:: Mine\n\n- first\n");
        assert_eq!(
            o.props,
            [
                ("title".into(), "My Page".into()),
                ("alias".into(), "Mine".into())
            ]
        );
        assert_eq!(o.blocks.len(), 1);
    }

    #[test]
    fn a_first_block_with_only_properties_is_page_properties() {
        let o = parse("- title:: My Page\n  tags:: a, b\n- text\n");
        assert_eq!(o.props.len(), 2);
        assert_eq!(o.blocks.len(), 1);
        assert_eq!(o.blocks[0].lines, ["text"]);
    }

    #[test]
    fn bullets_inside_a_code_fence_are_not_blocks() {
        let o = parse("- code\n  ```\n  - not a bullet\n  ```\n- next\n");
        assert_eq!(o.blocks.len(), 2);
        assert_eq!(o.blocks[0].lines, ["code", "```", "- not a bullet", "```"]);
    }

    #[test]
    fn analyze_takes_blocks_apart() {
        let o = parse(
            "- TODO ## Plan it\n  id:: 6500a0b1-0000-4000-8000-000000000001\n  due:: tomorrow\n  :LOGBOOK:\n  CLOCK: [2026-10-27 Tue 10:00]\n  :END:\n  more text\n",
        );
        let a = analyze(&o.blocks[0]);
        assert_eq!(a.marker, Some(Marker::Todo));
        assert!(a.heading);
        assert_eq!(a.lines, ["Plan it", "more text"]);
        assert_eq!(a.props.len(), 2);
    }

    #[test]
    fn only_real_properties_count() {
        assert!(property("https://example.org").is_none());
        assert!(property("a::b").is_none());
        assert_eq!(
            property("Status:: done"),
            Some(("status".into(), "done".into()))
        );
        assert_eq!(property("empty::"), Some(("empty".into(), String::new())));
    }
}
