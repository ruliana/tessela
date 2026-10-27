use std::path::PathBuf;

use tessela_core::{Bundle, Diagnostic, Linter, Severity};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn lint(name: &str) -> Vec<Diagnostic> {
    Linter::default().run(&Bundle::load(fixture(name)).unwrap())
}

fn find<'a>(ds: &'a [Diagnostic], rule: &str, path: &str) -> Vec<&'a Diagnostic> {
    ds.iter()
        .filter(|d| d.rule == rule && d.path == path)
        .collect()
}

#[test]
fn good_bundle_has_no_errors_or_warnings() {
    let ds = lint("good");
    let serious: Vec<_> = ds.iter().filter(|d| d.severity > Severity::Info).collect();
    assert!(serious.is_empty(), "{serious:?}");
    // `agents` is mentioned but has no page: informational only.
    assert_eq!(
        find(&ds, "tessela/unwritten-concept", "journals/2026-10-27.md").len(),
        1
    );
}

#[test]
fn reserved_files_are_not_pages() {
    let bundle = Bundle::load(fixture("good")).unwrap();
    assert!(bundle.pages.iter().all(|p| p.path != "index.md"));
    assert_eq!(bundle.pages.len(), 3);
}

#[test]
fn okf_conformance_errors() {
    let ds = lint("bad");
    assert_eq!(find(&ds, "okf/frontmatter", "no-frontmatter.md").len(), 1);
    assert_eq!(find(&ds, "okf/type", "no-type.md").len(), 1);
    assert_eq!(find(&ds, "okf/frontmatter", "broken.md").len(), 1);
    assert!(find(&ds, "okf/type", "no-type.md")[0].severity == Severity::Error);
}

#[test]
fn date_problems() {
    let ds = lint("bad");
    let dates = find(&ds, "tessela/dates", "dates.md");
    let messages: Vec<_> = dates.iter().map(|d| d.message.as_str()).collect();
    assert!(
        messages
            .iter()
            .any(|m| m.contains("`timestamp`") && m.contains("space")),
        "{messages:?}"
    );
    assert!(
        messages
            .iter()
            .any(|m| m.contains("`verified`") && m.contains("UTC offset")),
        "{messages:?}"
    );
    assert!(
        dates.iter().any(|d| d.line == Some(7)),
        "inline `T` datetime on line 7: {messages:?}"
    );
}

#[test]
fn journal_must_match_file_name() {
    let ds = lint("bad");
    assert_eq!(
        find(&ds, "tessela/journal", "journals/wrong-name.md").len(),
        1
    );
}

#[test]
fn vocabulary_aliases_and_deprecations() {
    let ds = lint("bad");
    let v = find(&ds, "tessela/vocabulary", "uses-vocab.md");
    assert_eq!(v.len(), 2, "{v:?}");
    assert!(
        v.iter()
            .any(|d| d.message.contains("use `machine-learning`"))
    );
    assert!(
        v.iter()
            .any(|d| d.message.contains("deprecated") && d.message.contains("Use #task instead."))
    );
    assert!(
        ds.iter()
            .any(|d| d.rule == "tessela/unwritten-concept" && d.message.contains("`brand-new`"))
    );
}
