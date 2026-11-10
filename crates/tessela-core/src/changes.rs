//! What changed in a page between two versions of its text, block by block.
//!
//! `tessela changes` compares the notes on disk with what git has, and this module does
//! the comparing: the properties (front matter), the headings and the blocks of a page are
//! lined up with a text diff, and what is only on one side was added or removed, while a
//! removed and an added unit that take the same place are one that changed. Every change
//! carries the lines it covers and their source text, so a client can keep it or put the
//! old text back with a patch.

use serde::Serialize;

use crate::page::{Page, Split, split_frontmatter};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Added,
    Removed,
    Changed,
}

/// What a change is about: a block of text, a heading, or the page's properties.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Unit {
    Block,
    Heading,
    Properties,
}

#[derive(Debug, Clone, Serialize)]
pub struct Change {
    pub kind: ChangeKind,
    pub unit: Unit,
    /// The handle of the block or heading as it is now, or as it was when it was removed.
    pub handle: Option<String>,
    pub heading_path: Vec<String>,
    /// Added and changed: the first line in the new text. Removed: in the old text.
    pub line: usize,
    /// The text as it is now; for a removed unit, as it was.
    pub text: String,
    /// The source lines of the unit in the new text (the old text when removed).
    pub raw: String,
    /// Changed: the same, as it was.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_raw: Option<String>,
}

/// A piece of a page: what is compared.
struct Part {
    /// Equal keys are the same text. A block's key is its text with the spaces squeezed.
    key: String,
    unit: Unit,
    handle: Option<String>,
    heading_path: Vec<String>,
    line: usize,
    text: String,
    raw: String,
}

fn squeeze(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn parts(path: &str, text: &str) -> Vec<Part> {
    let page = Page::parse(path, text);
    let lines: Vec<&str> = text.lines().collect();
    let raw = |line: usize, count: usize| {
        lines
            .iter()
            .skip(line - 1)
            .take(count.max(1))
            .copied()
            .collect::<Vec<_>>()
            .join("\n")
    };
    let mut out = Vec::new();
    if let Split::Found { yaml, .. } = split_frontmatter(text) {
        let count = yaml.lines().count() + 2;
        out.push(Part {
            key: format!("--- {}", squeeze(yaml)),
            unit: Unit::Properties,
            handle: None,
            heading_path: Vec::new(),
            line: 1,
            text: yaml.trim_end().to_string(),
            raw: raw(1, count),
        });
    }
    for h in &page.headings {
        out.push(Part {
            key: format!("# {}", squeeze(&h.text)),
            unit: Unit::Heading,
            handle: Some(h.handle.clone()),
            heading_path: h.heading_path.clone(),
            line: h.line,
            text: h.text.clone(),
            raw: raw(h.line, 1),
        });
    }
    for b in &page.blocks {
        out.push(Part {
            key: squeeze(&b.text),
            unit: Unit::Block,
            handle: Some(b.handle.clone()),
            heading_path: b.heading_path.clone(),
            line: b.line,
            text: b.text.clone(),
            raw: raw(b.line, b.text.lines().count()),
        });
    }
    // Document order; a heading comes before the blocks under it.
    out.sort_by_key(|p| (p.line, p.unit == Unit::Block));
    out
}

/// The changes that turn `old` into `new`. A missing side is a page that was added or deleted.
pub fn diff(path: &str, old: Option<&str>, new: Option<&str>) -> Vec<Change> {
    let before = old.map_or_else(Vec::new, |t| parts(path, t));
    let after = new.map_or_else(Vec::new, |t| parts(path, t));
    let join = |parts: &[Part]| {
        parts
            .iter()
            .map(|p| format!("{}\n", p.key))
            .collect::<String>()
    };
    let (old_keys, new_keys) = (join(&before), join(&after));
    let patch = diffy::DiffOptions::new()
        .set_context_len(usize::MAX)
        .create_patch(&old_keys, &new_keys);
    let (mut i, mut j) = (0, 0);
    let mut changes = Vec::new();
    let (mut gone, mut came): (Vec<usize>, Vec<usize>) = (Vec::new(), Vec::new());
    let flush = |gone: &mut Vec<usize>, came: &mut Vec<usize>, changes: &mut Vec<Change>| {
        // A removed and an added unit of the same kind that take the same place are one
        // that changed; whatever is left over was removed or added.
        let mut came_iter = came.drain(..).peekable();
        for g in gone.drain(..) {
            match came_iter.peek() {
                Some(&c) if after[c].unit == before[g].unit => {
                    came_iter.next();
                    changes.push(changed(&before[g], &after[c]));
                }
                _ => changes.push(single(ChangeKind::Removed, &before[g])),
            }
        }
        changes.extend(came_iter.map(|c| single(ChangeKind::Added, &after[c])));
    };
    for hunk in patch.hunks() {
        for line in hunk.lines() {
            match line {
                diffy::Line::Context(_) => {
                    flush(&mut gone, &mut came, &mut changes);
                    i += 1;
                    j += 1;
                }
                diffy::Line::Delete(_) => {
                    gone.push(i);
                    i += 1;
                }
                diffy::Line::Insert(_) => {
                    came.push(j);
                    j += 1;
                }
            }
        }
    }
    flush(&mut gone, &mut came, &mut changes);
    changes
}

fn single(kind: ChangeKind, part: &Part) -> Change {
    Change {
        kind,
        unit: part.unit,
        handle: part.handle.clone(),
        heading_path: part.heading_path.clone(),
        line: part.line,
        text: part.text.clone(),
        raw: part.raw.clone(),
        old_text: None,
        old_line: None,
        old_raw: None,
    }
}

fn changed(old: &Part, new: &Part) -> Change {
    Change {
        old_text: Some(old.text.clone()),
        old_line: Some(old.line),
        old_raw: Some(old.raw.clone()),
        ..single(ChangeKind::Changed, new)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(old: &str, new: &str) -> Vec<(ChangeKind, Unit, String)> {
        diff("a.md", Some(old), Some(new))
            .into_iter()
            .map(|c| (c.kind, c.unit, c.text))
            .collect()
    }

    #[test]
    fn blocks_are_added_removed_and_changed() {
        let old = "---\ntype: concept\n---\n\nkeep\n\nchange me\n\ngone\n";
        let new = "---\ntype: concept\n---\n\nkeep\n\nchanged!\n\nnew one\n\n- and a list item\n";
        use ChangeKind::*;
        assert_eq!(
            summary(old, new),
            [
                (Changed, Unit::Block, "changed!".into()),
                (Changed, Unit::Block, "new one".into()),
                (Added, Unit::Block, "and a list item".into()),
            ]
        );
    }

    #[test]
    fn properties_and_headings_are_units_too() {
        let old = "---\ntype: concept\ntitle: A\n---\n\n# Top\n\ntext\n";
        let new = "---\ntype: concept\ntitle: B\n---\n\n# Top #x\n\ntext\n";
        let changes = diff("a.md", Some(old), Some(new));
        let kinds: Vec<_> = changes.iter().map(|c| (c.kind, c.unit)).collect();
        assert_eq!(
            kinds,
            [
                (ChangeKind::Changed, Unit::Properties),
                (ChangeKind::Changed, Unit::Heading)
            ]
        );
        assert_eq!(changes[1].old_text.as_deref(), Some("Top"));
        assert_eq!(changes[1].raw, "# Top #x");
        assert_eq!(changes[1].old_raw.as_deref(), Some("# Top"));
    }

    #[test]
    fn a_new_or_deleted_page_is_all_added_or_removed() {
        let text = "---\ntype: concept\n---\n\none\n\ntwo\n";
        let added = diff("a.md", None, Some(text));
        assert!(added.iter().all(|c| c.kind == ChangeKind::Added));
        assert_eq!(added.len(), 3);
        let removed = diff("a.md", Some(text), None);
        assert!(removed.iter().all(|c| c.kind == ChangeKind::Removed));
    }

    #[test]
    fn moving_a_block_is_an_addition_and_a_removal_with_lines_and_source() {
        let old = "first\n\nsecond\n";
        let new = "second\n\nfirst\n";
        let changes = diff("a.md", Some(old), Some(new));
        assert!(
            changes
                .iter()
                .any(|c| c.kind == ChangeKind::Added && c.line == 1 && c.raw == "second")
        );
        assert!(
            changes
                .iter()
                .any(|c| c.kind == ChangeKind::Removed && c.line == 3 && c.raw == "second")
        );
    }
}
