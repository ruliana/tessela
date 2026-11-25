//! Property tests for reading text: whatever a page holds, parsing must not panic and must
//! describe the text consistently. Nothing here touches the disk.
//!
//! Known gaps these tests found, kept out of the "tame" generator until they are fixed:
//! - a tag written as an HTML entity (`&#35;x`) names the concept, but the text on disk is not
//!   the tag, so a move neither rewrites it nor reports it;
//! - the block reader parses the text of each block on its own, so it can disagree with the
//!   parse of the whole page: tags in an indented code block (a tab or 4 spaces) count as
//!   references although `extract_refs` calls it code; a backtick that opens a code span
//!   across a table or a setext heading changes what is a tag. After a move, these stay.

mod support;

use proptest::prelude::*;
use support::{config, markdown, page_text, refs_of, tame_page_text};
use tessela_core::Page;
use tessela_core::fence::{Pipeline, split_stages};
use tessela_core::refs::{extract_refs, link_target_id, normalize_concept, tag_spans};
use tessela_core::rewrite::{Rewrite, Where};

proptest! {
    #![proptest_config(config(400))]

    #[test]
    fn parsing_any_text_is_consistent(text in prop_oneof![page_text(), any::<String>()]) {
        let page = Page::parse("a/x.md", &text);
        let lines = text.lines().count().max(1) + 1;
        let mut handles = std::collections::HashSet::new();
        for block in &page.blocks {
            prop_assert!(block.line >= 1 && block.line <= lines, "line {} of {lines}", block.line);
            prop_assert!(handles.insert(block.handle.clone()), "handle twice: {}", block.handle);
            if let Some(parent) = block.parent {
                prop_assert!(parent < page.blocks.len());
            }
        }
        for heading in &page.headings {
            prop_assert!((1..=6).contains(&heading.level));
            prop_assert!(heading.line >= 1 && heading.line <= lines);
        }
        // Reading is deterministic, and the title is never empty.
        let again = Page::parse("a/x.md", &text);
        prop_assert_eq!(page.blocks.len(), again.blocks.len());
        prop_assert!(!page.title().is_empty());
    }

    #[test]
    fn concept_ids_are_normal_forms(name in any::<String>()) {
        let id = normalize_concept(&name);
        prop_assert_eq!(normalize_concept(&id), id.clone());
        prop_assert!(!id.contains(char::is_whitespace));
        prop_assert!(!id.starts_with('#'));
    }

    #[test]
    fn references_are_normalized_and_unique(md in markdown(), dir in "(a|a/c|)") {
        let refs = extract_refs(&md, &dir);
        let mut seen = std::collections::HashSet::new();
        for r in &refs {
            prop_assert_eq!(&normalize_concept(r), r);
            prop_assert!(!r.is_empty());
            prop_assert!(seen.insert(r.clone()), "{r} twice");
        }
    }

    #[test]
    fn tag_ranges_point_at_the_tag_names(text in any::<String>()) {
        for (range, id) in tag_spans(&text) {
            // Slicing panics unless both ends are character boundaries.
            let name = &text[range.clone()];
            prop_assert!(text[..range.start].ends_with('#'));
            prop_assert_eq!(normalize_concept(name), id);
        }
    }

    #[test]
    fn link_targets_never_escape(dest in any::<String>(), dir in "(a|a/c|)") {
        if let Some(id) = link_target_id(&dest, &dir) {
            prop_assert!(!id.is_empty() && !id.split('/').any(|p| p == ".." || p.is_empty()), "{id}");
        }
    }

    #[test]
    fn rewriting_a_name_nobody_uses_changes_nothing(md in markdown()) {
        let rewrite = Rewrite::new("nobody/uses-this", "elsewhere/nobody-here.md");
        let at = Where { dir_before: "a", dir_after: "a", is_moved: false };
        let out = rewrite.page(&md, &at);
        prop_assert!(!out.changed());
        prop_assert_eq!(out.text, md);
    }

    #[test]
    fn a_rewritten_page_no_longer_names_the_old_concept(text in tame_page_text()) {
        let rewrite = Rewrite::new("x", "q/new.md");
        let at = Where { dir_before: "", dir_after: "", is_moved: false };
        let out = rewrite.page(&text, &at);
        prop_assert_eq!(out.text.lines().count(), text.lines().count());
        // What the rewrite reports it could not do is allowed to stay; the rest must go.
        if out.skipped_lines.is_empty() && Page::parse("p.md", &text).frontmatter_error.is_none() {
            let after = refs_of("p.md", &out.text);
            prop_assert!(!after.contains("x"), "still mentions x: {:?}", out.text);
        }
    }

    #[test]
    fn fence_bodies_are_read_or_refused(body in prop_oneof![
        any::<String>(),
        "[a-z |'\"\\\\-]{0,40}",
        proptest::collection::vec(
            proptest::sample::select(&["query", "--ref", "x", "|", "rg", "sed", "s/a/b/", "head", "-n", "3", "sort", "uniq", "-c", "wc", "-l", "'", "\"", "\\"][..]),
            0..14,
        ).prop_map(|w| w.join(" ")),
    ]) {
        let _ = split_stages(&body);
        if let Ok(pipeline) = Pipeline::parse(&body) {
            let lines = vec![
                tessela_core::fence::Line::new("alpha x", Some(0)),
                tessela_core::fence::Line::new("", Some(1)),
                tessela_core::fence::Line::new("日本 #x", None),
            ];
            let _ = pipeline.filter(lines);
        }
    }
}
