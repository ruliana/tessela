//! References: the `#tags` and concept links that name a concept (spec §4).

use pulldown_cmark::{Event, Parser, Tag, TagEnd};

/// Turns a concept name into its ID: lowercase, whitespace runs become `-`.
pub fn normalize_concept(name: &str) -> String {
    name.trim()
        .trim_start_matches('#')
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
}

/// Resolves a link target to a concept ID, or `None` for URLs and non-Markdown files.
pub fn link_target_id(dest: &str, page_dir: &str) -> Option<String> {
    let dest = dest.split(['#', '?']).next().unwrap_or("");
    if dest.is_empty() || has_scheme(dest) {
        return None;
    }
    let stem = dest
        .strip_suffix(".md")
        .or_else(|| dest.strip_suffix(".MD"))?;
    let mut parts: Vec<&str> = Vec::new();
    if !stem.starts_with('/') {
        parts.extend(page_dir.split('/').filter(|p| !p.is_empty()));
    }
    for part in stem.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            p => parts.push(p),
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(normalize_concept(&parts.join("/")))
}

fn has_scheme(dest: &str) -> bool {
    let Some((scheme, _)) = dest.split_once(':') else {
        return false;
    };
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

/// Finds `#tags` in plain text. Tags are not found inside words, paths or URLs.
fn scan_tags(text: &str, out: &mut Vec<String>) {
    let mut prev: Option<char> = None;
    for (i, c) in text.char_indices() {
        if c == '#'
            && prev
                .is_none_or(|p| !(p.is_alphanumeric() || matches!(p, '_' | '&' | '/' | '#' | ')')))
        {
            let rest = &text[i + 1..];
            let end = rest
                .char_indices()
                .find(|(_, ch)| !(ch.is_alphanumeric() || matches!(ch, '_' | '-' | '/')))
                .map_or(rest.len(), |(j, _)| j);
            let tag = rest[..end].trim_end_matches(['-', '/']);
            if tag.chars().any(char::is_alphabetic) {
                push_unique(out, normalize_concept(tag));
            }
        }
        prev = Some(c);
    }
}

fn push_unique(out: &mut Vec<String>, id: String) {
    if !out.contains(&id) {
        out.push(id);
    }
}

/// Every concept a piece of Markdown mentions through a tag or a concept link.
/// Code spans and code blocks are ignored.
pub fn extract_refs(markdown: &str, page_dir: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut text = String::new();
    let mut in_code_block = false;
    for event in Parser::new(markdown) {
        if let Event::Text(t) = &event
            && !in_code_block
        {
            text.push_str(t);
            continue;
        }
        scan_tags(&text, &mut out);
        text.clear();
        match event {
            Event::Start(Tag::CodeBlock(_)) => in_code_block = true,
            Event::End(TagEnd::CodeBlock) => in_code_block = false,
            Event::Start(Tag::Link { dest_url, .. }) => {
                if let Some(id) = link_target_id(&dest_url, page_dir) {
                    push_unique(&mut out, id);
                }
            }
            _ => {}
        }
    }
    scan_tags(&text, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_tags_and_links() {
        let refs = extract_refs(
            "Talked about #Machine-Learning and [x](/ai/llm.md) today.",
            "",
        );
        assert_eq!(refs, ["machine-learning", "ai/llm"]);
    }

    #[test]
    fn nested_tag_is_a_path() {
        assert_eq!(
            extract_refs("see #project/tessela.", ""),
            ["project/tessela"]
        );
    }

    #[test]
    fn ignores_code_urls_numbers_and_headings() {
        let md = "`#nope` and https://a.com/#frag and issue #12 and a#b\n\n```\n#code\n```\n";
        assert!(extract_refs(md, "").is_empty());
        assert!(extract_refs("# Heading", "").is_empty());
    }

    #[test]
    fn tag_with_underscore_stays_whole() {
        assert_eq!(extract_refs("#snake_case here", ""), ["snake_case"]);
    }

    #[test]
    fn resolves_relative_links() {
        assert_eq!(link_target_id("./b.md", "notes"), Some("notes/b".into()));
        assert_eq!(link_target_id("../c.md", "notes"), Some("c".into()));
        assert_eq!(
            link_target_id("/Foo%20Bar.md", "x"),
            Some("foo%20bar".into())
        );
        assert_eq!(link_target_id("https://x.org/a.md", ""), None);
        assert_eq!(link_target_id("/pic.png", ""), None);
        assert_eq!(link_target_id("/a.md#section", ""), Some("a".into()));
    }

    #[test]
    fn normalizes_names() {
        assert_eq!(normalize_concept("Machine  Learning"), "machine-learning");
        assert_eq!(normalize_concept("#Rust"), "rust");
    }
}
