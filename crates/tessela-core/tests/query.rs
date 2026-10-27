use std::path::PathBuf;

use tessela_core::{Bundle, Hit, HitKind, Query, vocabulary};

fn bundle() -> Bundle {
    Bundle::load(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/query")).unwrap()
}

fn texts(hits: &[Hit]) -> Vec<&str> {
    hits.iter().map(|h| h.text.as_str()).collect()
}

fn refs(names: &[&str]) -> Query {
    Query {
        refs: names.iter().map(|s| s.to_string()).collect(),
        ..Query::default()
    }
}

#[test]
fn single_ref_matches_own_refs() {
    let hits = refs(&["#Rust"]).run(&bundle());
    assert_eq!(
        texts(&hits),
        [
            "Read about #rust today.",
            "detail about indexing #rust",
            "Wrote the linter in #rust."
        ]
    );
}

#[test]
fn children_and_blocks_under_a_heading_inherit_refs() {
    let hits = refs(&["tessela"]).run(&bundle());
    assert_eq!(
        texts(&hits),
        [
            "Idea #tessela",
            "detail about indexing #rust",
            "Work #tessela",
            "Wrote the linter in #rust.",
            "Ask about #okf"
        ]
    );
    let own = Query {
        own: true,
        ..refs(&["tessela"])
    };
    assert_eq!(
        texts(&own.run(&bundle())),
        ["Idea #tessela", "Work #tessela"]
    );
}

#[test]
fn several_refs_are_all_or_any() {
    let all = refs(&["rust", "tessela"]).run(&bundle());
    assert_eq!(
        texts(&all),
        ["detail about indexing #rust", "Wrote the linter in #rust."]
    );
    let any = Query {
        any: true,
        ..refs(&["rust", "okf"])
    };
    assert_eq!(any.run(&bundle()).len(), 4);
}

#[test]
fn hits_carry_what_an_agent_needs() {
    let hits = refs(&["okf"]).run(&bundle());
    let hit = &hits[0];
    assert_eq!(hit.path, "journals/2026-10-27.md");
    assert_eq!(hit.line, 11);
    assert_eq!(hit.heading_path, ["Work #tessela"]);
    assert_eq!(hit.refs, ["okf"]);
    assert_eq!(hit.path_refs, ["tessela", "okf"]);
    assert!(hit.handle.starts_with("journals/2026-10-27#"));
    assert_eq!(hit.page_type.as_deref(), Some("journal"));
}

#[test]
fn child_hit_points_to_its_parent() {
    let hits = refs(&["rust", "tessela"]).run(&bundle());
    let parent = bundle().page("journals/2026-10-26").unwrap().blocks[1]
        .handle
        .clone();
    assert_eq!(hits[0].parent.as_deref(), Some(parent.as_str()));
    assert_eq!(hits[1].parent, None);
}

#[test]
fn text_type_and_page_filters() {
    let b = bundle();
    let by_text = Query {
        text: Some("LINTER".into()),
        ..Query::default()
    };
    assert_eq!(texts(&by_text.run(&b)), ["Wrote the linter in #rust."]);

    let by_type = Query {
        kind: Some("concept".into()),
        ..Query::default()
    };
    assert_eq!(texts(&by_type.run(&b)), ["A language."]);

    let one_page = Query {
        page: Some("rust".into()),
        ..Query::default()
    };
    assert_eq!(one_page.run(&b).len(), 1);

    let folder = Query {
        page: Some("journals/".into()),
        ..Query::default()
    };
    assert_eq!(folder.run(&b).len(), 6);
}

#[test]
fn date_range_selects_journal_days() {
    let b = bundle();
    let from = Query {
        from: Some("2026-10-27".into()),
        ..Query::default()
    };
    assert!(from.run(&b).iter().all(|h| h.page == "journals/2026-10-27"));
    let to = Query {
        to: Some("2026-10-26".into()),
        ..Query::default()
    };
    assert!(to.run(&b).iter().all(|h| h.page == "journals/2026-10-26"));
    let both = Query {
        from: Some("2026-10-26".into()),
        to: Some("2026-10-27".into()),
        ..Query::default()
    };
    assert_eq!(both.run(&b).len(), 6);
}

#[test]
fn no_match_is_empty() {
    assert!(refs(&["nothing"]).run(&bundle()).is_empty());
}

#[test]
fn vocabulary_counts_and_flags() {
    let entries = vocabulary(&bundle());
    let names: Vec<_> = entries.iter().map(|e| e.concept.as_str()).collect();
    assert_eq!(
        names,
        [
            "rust",
            "tessela",
            "language",
            "okf",
            "journals/2026-10-26",
            "journals/2026-10-27",
            "rs",
            "vocabulary"
        ]
    );

    let rust = &entries[0];
    assert_eq!((rust.mentions, rust.pages, rust.has_page), (3, 2, true));
    let tessela = &entries[1];
    assert_eq!(
        (tessela.mentions, tessela.pages, tessela.has_page),
        (2, 2, false)
    );
    let language = entries.iter().find(|e| e.concept == "language").unwrap();
    assert_eq!((language.mentions, language.has_page), (1, false));
    let rs = entries.iter().find(|e| e.concept == "rs").unwrap();
    assert_eq!((rs.mentions, rs.use_instead.as_deref()), (0, Some("rust")));
}

#[test]
fn a_concept_also_matches_the_ones_nested_under_it() {
    let dir = std::env::temp_dir().join(format!("tessela-nested-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("a.md"),
        "---\ntype: concept\n---\n\nOne #project/tessela\n\nTwo #project\n\nThree #projector\n\nFour #other/project\n",
    )
    .unwrap();
    let b = Bundle::load(&dir).unwrap();
    let hits = refs(&["#project"]).run(&b);
    assert_eq!(texts(&hits), ["One #project/tessela", "Two #project"]);
    let deeper = refs(&["project/tessela"]).run(&b);
    assert_eq!(texts(&deeper), ["One #project/tessela"]);
    std::fs::remove_dir_all(&dir).unwrap();
}

fn temp_bundle(name: &str, files: &[(&str, &str)]) -> (Bundle, PathBuf) {
    let dir = std::env::temp_dir().join(format!("tessela-{name}-{}", std::process::id()));
    for (path, content) in files {
        let file = dir.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, content).unwrap();
    }
    (Bundle::load(&dir).unwrap(), dir)
}

fn range(from: Option<&str>, to: Option<&str>) -> Query {
    Query {
        from: from.map(str::to_string),
        to: to.map(str::to_string),
        ..Query::default()
    }
}

#[test]
fn blocks_that_mention_a_date_in_range_match_on_any_page() {
    let (b, dir) = temp_bundle(
        "dates-in-text",
        &[
            (
                "a.md",
                "---\ntype: concept\n---\n\nMeeting on 2026-10-27 14:30:00-03:00\n\nOld note from 2026-01-01\n\nNo date here\n",
            ),
            (
                "journals/2026-01-05.md",
                "---\ntype: journal\ndate: \"2026-01-05\"\n---\n\nFollow up on 2026-10-28\n\nPlain entry\n",
            ),
            (
                "journals/2026-10-27.md",
                "---\ntype: journal\ndate: \"2026-10-27\"\n---\n\nEntry without dates\n",
            ),
        ],
    );
    let hits = range(Some("2026-10-27"), Some("2026-10-28")).run(&b);
    // A mentioned date matches on any page; a journal day matches all of its blocks.
    assert_eq!(
        texts(&hits),
        [
            "Meeting on 2026-10-27 14:30:00-03:00",
            "Follow up on 2026-10-28",
            "Entry without dates"
        ]
    );
    assert_eq!(hits[0].dates, ["2026-10-27"]);

    let early = range(None, Some("2026-01-31")).run(&b);
    assert_eq!(
        texts(&early),
        [
            "Old note from 2026-01-01",
            "Follow up on 2026-10-28",
            "Plain entry"
        ]
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn date_filters_combine_with_the_other_filters() {
    let (b, dir) = temp_bundle(
        "dates-combined",
        &[(
            "a.md",
            "---\ntype: concept\n---\n\nCall #client on 2026-10-27\n\nEmail #other on 2026-10-27\n\nCall #client on 2026-11-02\n",
        )],
    );
    let q = Query {
        refs: vec!["client".into()],
        ..range(Some("2026-10-27"), Some("2026-10-31"))
    };
    assert_eq!(texts(&q.run(&b)), ["Call #client on 2026-10-27"]);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn only_valid_standalone_dates_count() {
    use tessela_core::query::dates_in;
    assert_eq!(
        dates_in("2026-10-27 and 2026-10-28"),
        ["2026-10-27", "2026-10-28"]
    );
    assert_eq!(dates_in("at 2026-10-27T14:30"), ["2026-10-27"]);
    assert_eq!(
        dates_in("[2026-10-27](/journals/2026-10-27.md)"),
        ["2026-10-27", "2026-10-27"]
    );
    assert!(dates_in("2026-13-01 and 2026-10-32 and 12026-10-27 and 2026-10-271").is_empty());
}

#[test]
fn a_heading_that_mentions_a_concept_is_a_backlink() {
    let hits = refs(&["tessela"]).run(&bundle());
    let heading = hits.iter().find(|h| h.kind == HitKind::Heading).unwrap();
    assert_eq!(heading.text, "Work #tessela");
    assert_eq!(
        (heading.path.as_str(), heading.line),
        ("journals/2026-10-27.md", 7)
    );
    assert_eq!(heading.refs, ["tessela"]);
    assert!(heading.handle.starts_with("journals/2026-10-27#"));
    assert_eq!(
        hits.iter().filter(|h| h.kind == HitKind::Heading).count(),
        1
    );
    // The blocks under it are still there, and are told apart by kind.
    assert_eq!(hits.iter().filter(|h| h.kind == HitKind::Block).count(), 4);
}

#[test]
fn a_page_tagged_with_a_concept_is_a_backlink() {
    let hits = refs(&["language"]).run(&bundle());
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].kind, HitKind::Page);
    assert_eq!(
        (hits[0].handle.as_str(), hits[0].text.as_str()),
        ("rust", "Rust")
    );
    assert_eq!(hits[0].refs, ["language"]);
}

#[test]
fn pages_and_headings_are_only_returned_when_a_concept_is_asked_for() {
    let all = Query::default().run(&bundle());
    assert!(all.iter().all(|h| h.kind == HitKind::Block));
    let by_text = Query {
        text: Some("work".into()),
        ..Query::default()
    };
    assert!(by_text.run(&bundle()).is_empty());
}

#[test]
fn frontmatter_text_with_links_and_tags_counts_as_a_reference() {
    let (b, dir) = temp_bundle(
        "frontmatter-refs",
        &[
            (
                "a.md",
                "---\ntype: reference\ntitle: Paper\ndescription: \"Related to [Rust](/rust.md) and #okf\"\n---\n\nBody\n",
            ),
            ("rust.md", "---\ntype: concept\n---\n"),
        ],
    );
    for concept in ["rust", "okf"] {
        let hits = refs(&[concept]).run(&b);
        assert_eq!(hits.len(), 1, "{concept}: {hits:?}");
        assert_eq!((hits[0].kind, hits[0].page.as_str()), (HitKind::Page, "a"));
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_paragraph_after_a_nested_list_is_still_found() {
    let (b, dir) = temp_bundle(
        "trailing",
        &[(
            "a.md",
            "---\ntype: concept\n---\n\n- parent #topic\n\n  - child\n\n  closing words with #later\n",
        )],
    );
    let hits = refs(&["later"]).run(&b);
    assert_eq!(texts(&hits), ["closing words with #later"]);
    // It belongs to the item, so it also shows up under the item's tag.
    let under_parent = refs(&["topic"]).run(&b);
    assert_eq!(
        texts(&under_parent),
        ["parent #topic", "child", "closing words with #later"]
    );
    assert_eq!(hits[0].parent, Some(under_parent[0].handle.clone()));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn date_filter_applies_to_backlink_hits_too() {
    let hits = Query {
        from: Some("2026-10-27".into()),
        ..refs(&["tessela"])
    }
    .run(&bundle());
    assert!(hits.iter().all(|h| h.page == "journals/2026-10-27"));
    assert!(hits.iter().any(|h| h.kind == HitKind::Heading));
}
