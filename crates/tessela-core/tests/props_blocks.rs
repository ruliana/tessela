//! Property tests for the shape of a page: where blocks and sections begin and end, and what
//! they hold. The editor's page model is checked against this output, so the shape has to be
//! consistent for any page, not only for the ones in the unit tests.

mod support;

use proptest::prelude::*;
use support::config;
use tessela_core::{BlockKind, Page};

/// One line of a page, built from the constructs that nest: headings, paragraphs, list items,
/// fences, quotes and callouts, at some indent.
fn line() -> impl Strategy<Value = String> {
    let text = prop_oneof![
        Just("text #x"),
        Just("日本語 ໆ é 😀"),
        Just("- item"),
        Just("- [ ] task"),
        Just("1. numbered"),
        Just("-"),
        Just("```"),
        Just("~~~rust"),
        Just("> quote"),
        Just("> [!NOTE]"),
        Just(">"),
        Just("# H1"),
        Just("## H2"),
        Just("### H3"),
        Just("| a | b |"),
        Just("|---|---|"),
        Just("<div>"),
        Just("    indented"),
        Just("---"),
        Just(""),
        Just(""),
    ];
    (0usize..3, text).prop_map(|(indent, t)| format!("{}{t}", "  ".repeat(indent)))
}

fn page() -> impl Strategy<Value = String> {
    prop::collection::vec(line(), 0..24).prop_map(|lines| lines.join("\n") + "\n")
}

proptest! {
    #![proptest_config(config(600))]

    #[test]
    fn a_block_never_ends_before_it_starts_nor_after_the_file(md in page()) {
        let page = Page::parse("x.md", &md);
        let lines = md.lines().count().max(1);
        for b in &page.blocks {
            prop_assert!(b.line <= b.end_line, "{b:?}");
            prop_assert!(b.end_line <= lines, "{b:?} of {lines}");
        }
    }

    #[test]
    fn children_lie_inside_their_parent(md in page()) {
        let page = Page::parse("x.md", &md);
        for (i, b) in page.blocks.iter().enumerate() {
            if let Some(p) = b.parent {
                prop_assert!(p < i, "a parent comes before its child");
                let parent = &page.blocks[p];
                prop_assert!(parent.line <= b.line && b.end_line <= parent.end_line,
                    "{b:?} is not inside {parent:?}");
            }
        }
    }

    #[test]
    fn blocks_come_in_document_order_and_siblings_do_not_overlap(md in page()) {
        let page = Page::parse("x.md", &md);
        for pair in page.blocks.windows(2) {
            prop_assert!(pair[0].line <= pair[1].line);
        }
        for (i, a) in page.blocks.iter().enumerate() {
            for b in &page.blocks[i + 1..] {
                if a.parent == b.parent {
                    prop_assert!(a.end_line < b.line, "{a:?} overlaps {b:?}");
                }
            }
        }
    }

    #[test]
    fn an_items_text_ends_where_its_first_child_begins(md in page()) {
        let page = Page::parse("x.md", &md);
        for (i, item) in page.blocks.iter().enumerate() {
            if item.kind != BlockKind::Item {
                continue;
            }
            if let Some(child) = page.blocks.iter().find(|c| c.parent == Some(i)) {
                let room = child.line.saturating_sub(item.line) + 1;
                prop_assert!(item.text.lines().count() <= room,
                    "{item:?} has more text than the lines above {child:?}");
            }
        }
    }

    #[test]
    fn a_section_holds_the_blocks_under_it(md in page()) {
        let page = Page::parse("x.md", &md);
        for (i, h) in page.headings.iter().enumerate() {
            prop_assert!(h.line <= h.end_line, "{h:?}");
            if let Some(p) = h.parent {
                let parent = &page.headings[p];
                prop_assert!(p < i && parent.level < h.level);
                prop_assert!(parent.line < h.line && h.end_line <= parent.end_line);
            }
        }
        for b in &page.blocks {
            if let Some(s) = b.section {
                let h = &page.headings[s];
                prop_assert!(h.line < b.line && b.end_line <= h.end_line,
                    "{b:?} is not inside the section {h:?}");
            }
        }
    }
}
