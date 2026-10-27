//! Pages: OKF concept files with YAML frontmatter and a Markdown body.

use serde_yaml_ng::{Mapping, Value};

use crate::blocks::{Block, Heading, parse_body};
use crate::refs::{extract_refs, normalize_concept};

#[derive(Debug)]
pub struct Page {
    /// Path inside the bundle without `.md`, e.g. `journals/2026-10-27`.
    pub id: String,
    /// Path inside the bundle with `/` separators, e.g. `journals/2026-10-27.md`.
    pub path: String,
    pub has_frontmatter: bool,
    pub frontmatter: Mapping,
    pub frontmatter_error: Option<String>,
    /// Concepts the page itself mentions: frontmatter `tags`, plus the tags and
    /// concept links written in other frontmatter text.
    pub refs: Vec<String>,
    pub blocks: Vec<Block>,
    pub headings: Vec<Heading>,
}

impl Page {
    pub fn parse(path: &str, text: &str) -> Page {
        let id = path.strip_suffix(".md").unwrap_or(path).to_string();
        let mut page = Page {
            id,
            path: path.to_string(),
            has_frontmatter: false,
            frontmatter: Mapping::new(),
            frontmatter_error: None,
            refs: Vec::new(),
            blocks: Vec::new(),
            headings: Vec::new(),
        };
        let (body, body_offset) = match split_frontmatter(text) {
            Split::None => (text, 0),
            Split::Unterminated => {
                page.has_frontmatter = true;
                page.frontmatter_error = Some("frontmatter is not closed by a `---` line".into());
                return page;
            }
            Split::Found { yaml, body_offset } => {
                page.has_frontmatter = true;
                match serde_yaml_ng::from_str::<Value>(yaml) {
                    Ok(Value::Mapping(m)) => page.frontmatter = m,
                    Ok(Value::Null) => {}
                    Ok(_) => {
                        page.frontmatter_error = Some("frontmatter must be a YAML mapping".into())
                    }
                    Err(e) => page.frontmatter_error = Some(format!("invalid YAML: {e}")),
                }
                (&text[body_offset..], body_offset)
            }
        };
        page.refs = page.frontmatter_refs();
        let base_line = 1 + text[..body_offset].matches('\n').count();
        let parsed = parse_body(body, base_line, &page.id);
        page.blocks = parsed.blocks;
        page.headings = parsed.headings;
        page
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.frontmatter.get(key)
    }

    pub fn get_str(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Value::as_str)
    }

    /// The page's `type`, if it is a non-empty string.
    pub fn kind(&self) -> Option<&str> {
        self.get_str("type").filter(|t| !t.trim().is_empty())
    }

    fn frontmatter_refs(&self) -> Vec<String> {
        let page_dir = self.id.rsplit_once('/').map_or("", |(dir, _)| dir);
        let mut refs = self.frontmatter_tags();
        let mut strings = Vec::new();
        for (key, value) in &self.frontmatter {
            if key.as_str() != Some("tags") {
                collect_strings(value, &mut strings);
            }
        }
        for text in strings {
            for r in extract_refs(&text, page_dir) {
                if !refs.contains(&r) {
                    refs.push(r);
                }
            }
        }
        refs
    }

    /// Frontmatter `tags`, normalized to concept IDs.
    pub fn frontmatter_tags(&self) -> Vec<String> {
        let Some(Value::Sequence(tags)) = self.get("tags") else {
            return Vec::new();
        };
        tags.iter()
            .filter_map(Value::as_str)
            .map(normalize_concept)
            .filter(|t| !t.is_empty())
            .collect()
    }
}

fn collect_strings(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(s) => out.push(s.clone()),
        Value::Sequence(items) => items.iter().for_each(|v| collect_strings(v, out)),
        Value::Mapping(m) => m.values().for_each(|v| collect_strings(v, out)),
        _ => {}
    }
}

enum Split<'a> {
    None,
    Unterminated,
    Found { yaml: &'a str, body_offset: usize },
}

fn split_frontmatter(text: &str) -> Split<'_> {
    let Some(first) = text.lines().next() else {
        return Split::None;
    };
    if first.trim_end() != "---" {
        return Split::None;
    }
    let mut offset = text.find('\n').map_or(text.len(), |i| i + 1);
    let yaml_start = offset;
    for line in text[offset..].split_inclusive('\n') {
        if line.trim_end() == "---" {
            return Split::Found {
                yaml: &text[yaml_start..offset],
                body_offset: offset + line.len(),
            };
        }
        offset += line.len();
    }
    Split::Unterminated
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter_and_body() {
        let p = Page::parse(
            "a/b.md",
            "---\ntype: concept\ntags: [Foo Bar, x]\n---\n\nHello #y\n",
        );
        assert_eq!(p.id, "a/b");
        assert_eq!(p.kind(), Some("concept"));
        assert_eq!(p.frontmatter_tags(), ["foo-bar", "x"]);
        assert_eq!(p.blocks.len(), 1);
        assert_eq!(p.blocks[0].line, 6);
    }

    #[test]
    fn missing_and_broken_frontmatter() {
        assert!(!Page::parse("a.md", "just text\n").has_frontmatter);
        assert!(
            Page::parse("a.md", "---\ntype: x\n")
                .frontmatter_error
                .is_some()
        );
        assert!(
            Page::parse("a.md", "---\n: : :\n  - [\n---\n")
                .frontmatter_error
                .is_some()
        );
        assert!(
            Page::parse("a.md", "---\n- a\n---\n")
                .frontmatter_error
                .is_some()
        );
    }

    #[test]
    fn empty_type_is_not_a_type() {
        assert_eq!(Page::parse("a.md", "---\ntype: \"\"\n---\n").kind(), None);
    }

    #[test]
    fn page_refs_come_from_tags_and_frontmatter_text() {
        let p = Page::parse(
            "a/b.md",
            "---\ntype: concept\ntags: [Foo]\ndescription: \"About #bar and [baz](/baz.md), see https://x.org/#top\"\nsources: [\"https://x.org/a.md\"]\n---\n",
        );
        assert_eq!(p.refs, ["foo", "bar", "baz"]);
    }

    #[test]
    fn dates_stay_strings() {
        let p = Page::parse("a.md", "---\ntype: journal\ndate: 2026-10-27\n---\n");
        assert_eq!(p.get_str("date"), Some("2026-10-27"));
    }
}
