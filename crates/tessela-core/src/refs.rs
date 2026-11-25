//! References: the `#tags` and concept links that name a concept (spec §4).

use std::ops::Range;

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

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

pub(crate) fn has_scheme(dest: &str) -> bool {
    let Some((scheme, _)) = dest.split_once(':') else {
        return false;
    };
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

/// Finds `#tags` in plain text: the byte range of each tag's name (just after the `#`)
/// and the concept ID it names. Tags are not found inside words, paths or URLs.
pub fn tag_spans(text: &str) -> Vec<(Range<usize>, String)> {
    let mut found = Vec::new();
    let mut prev: Option<char> = None;
    for (i, c) in text.char_indices() {
        if c == '#'
            && prev.is_none_or(|p| {
                !(p.is_alphanumeric() || matches!(p, '_' | '&' | '/' | '#' | ')' | '\\'))
            })
        {
            let rest = &text[i + 1..];
            let end = rest
                .char_indices()
                .find(|(_, ch)| !(ch.is_alphanumeric() || matches!(ch, '_' | '-' | '/')))
                .map_or(rest.len(), |(j, _)| j);
            let tag = rest[..end].trim_end_matches(['-', '/']);
            if tag.chars().any(char::is_alphabetic) {
                found.push((i + 1..i + 1 + tag.len(), normalize_concept(tag)));
            }
        }
        prev = Some(c);
    }
    found
}

fn push_unique(out: &mut Vec<String>, id: String) {
    if !out.contains(&id) {
        out.push(id);
    }
}

/// How Tessela reads Markdown everywhere: finding references, rewriting them and cutting a
/// page into blocks. One setting, so they cannot disagree about where a code span ends.
pub(crate) fn markdown_options() -> Options {
    Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS
}

/// Every reference in a piece of Markdown with the byte offset where it is written: a tag
/// where its `#` is, a link where it starts. Code spans and code blocks (indented ones too) are
/// ignored. Text that is not written as it reads (an escape such as `\#x`, or an entity such as
/// `&#35;x`) is not a tag: it has no position in the file that a rewrite could change.
pub fn ref_spans(markdown: &str, page_dir: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    // The current run of text that is written as it reads: where it starts, and what it says.
    let mut run: Option<(usize, String)> = None;
    let flush = |run: &mut Option<(usize, String)>, out: &mut Vec<(usize, String)>| {
        if let Some((start, text)) = run.take() {
            for (range, id) in tag_spans(&text) {
                out.push((start + range.start - 1, id));
            }
        }
    };
    let mut in_code_block = false;
    for (event, range) in Parser::new_ext(markdown, markdown_options()).into_offset_iter() {
        if let Event::Text(t) = &event
            && !in_code_block
        {
            if markdown[range.clone()] != **t {
                flush(&mut run, &mut out);
                continue;
            }
            match &mut run {
                Some((start, text)) if *start + text.len() == range.start => text.push_str(t),
                _ => {
                    flush(&mut run, &mut out);
                    // The parser drops the backslash of `\#x` and gives `#x`: keep it, so that
                    // the `#` is seen as escaped.
                    let escaped = markdown[..range.start].ends_with('\\');
                    let start = range.start - usize::from(escaped);
                    run = Some((start, markdown[start..range.end].to_string()));
                }
            }
            continue;
        }
        flush(&mut run, &mut out);
        match event {
            Event::Start(Tag::CodeBlock(_)) => in_code_block = true,
            Event::End(TagEnd::CodeBlock) => in_code_block = false,
            Event::Start(Tag::Link { dest_url, .. }) => {
                if let Some(id) = link_target_id(&dest_url, page_dir) {
                    out.push((range.start, id));
                }
            }
            _ => {}
        }
    }
    flush(&mut run, &mut out);
    out
}

/// Every concept a piece of Markdown mentions through a tag or a concept link, in order,
/// each once.
pub fn extract_refs(markdown: &str, page_dir: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (_, id) in ref_spans(markdown, page_dir) {
        push_unique(&mut out, id);
    }
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
    fn only_tags_written_as_they_read_count() {
        // An escape or an entity says "this is not a tag": there is nothing to rewrite there.
        assert!(extract_refs("\\#x and &#35;y", "").is_empty());
        // Indented code is code, with its tags and links.
        assert!(extract_refs("para\n\n    #x [t](/y.md)\n\n\t#z\n", "").is_empty());
        // A backtick that does not close in its own block opens nothing.
        let table = "`> #x\n| a | b |\n|---|---|\n| #y | z |\n";
        assert_eq!(extract_refs(table, ""), ["x", "y"]);
    }

    #[test]
    fn spans_say_where_each_reference_is_written() {
        let md = "a #x and [t](/y.md) #x\n";
        let spans = ref_spans(md, "");
        assert_eq!(spans, [(2, "x".into()), (9, "y".into()), (20, "x".into())]);
        assert!(md[2..].starts_with("#x") && md[9..].starts_with("[t]"));
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
