use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use tessela_core::logseq::{Report, import};
use tessela_core::{Bundle, HitKind, Linter, Query, Severity};

fn graph() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/logseq-graph")
}

fn out_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tessela-logseq-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

fn imported(name: &str) -> (PathBuf, Report) {
    let out = out_dir(name);
    let report = import(&graph(), &out).unwrap();
    (out, report)
}

fn read(out: &Path, file: &str) -> String {
    std::fs::read_to_string(out.join(file)).unwrap()
}

fn files(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(root: &Path, dir: &Path, into: &mut BTreeMap<String, Vec<u8>>) {
        for entry in dir.read_dir().unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(root, &path, into);
            } else {
                let rel = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                into.insert(rel, std::fs::read(&path).unwrap());
            }
        }
    }
    let mut all = BTreeMap::new();
    walk(dir, dir, &mut all);
    all
}

#[test]
fn report_counts_what_was_converted() {
    let (out, r) = imported("report");
    assert_eq!((r.pages, r.journals), (5, 2));
    assert_eq!(r.properties_converted, 3);
    assert_eq!((r.block_refs_inlined, r.unresolved_block_refs), (2, 0));
    assert_eq!(
        (r.assets_copied, r.empty_pages_skipped, r.macros_left),
        (1, 1, 1)
    );
    assert_eq!(r.skipped.len(), 1);
    assert_eq!(r.skipped[0].path, "pages/old.org");
    assert!(r.renamed.is_empty());
    std::fs::remove_dir_all(out).unwrap();
}

#[test]
fn files_land_where_the_spec_says() {
    let (out, _) = imported("layout");
    let names: Vec<String> = files(&out).into_keys().collect();
    assert_eq!(
        names,
        [
            "assets/diagram.png",
            "index-page.md",
            "index.md",
            "journals/2026-10-26.md",
            "journals/2026-10-27.md",
            "machine-learning.md",
            "project/tessela.md",
            "rust.md",
            "tessela.md",
        ]
    );
    assert!(read(&out, "index.md").contains("okf_version: \"0.2\""));
    std::fs::remove_dir_all(out).unwrap();
}

#[test]
fn outline_becomes_paragraphs_with_lists_beneath() {
    let (out, _) = imported("outline");
    let journal = read(&out, "journals/2026-10-26.md");
    assert!(
        journal
            .starts_with("---\ntype: journal\ntitle: \"2026-10-26\"\ndate: \"2026-10-26\"\n---\n")
    );
    assert!(journal.contains(
        "Started planning [Tessela](/tessela.md) with #agents\n- [ ] write the spec\n  SCHEDULED: 2026-10-28\n- Read about [Machine Learning](/machine-learning.md)\n  #status/reading\n\nLunch with Jane\n[met](/met.md): [Jane Doe](/jane-doe.md)\n"
    ));
    std::fs::remove_dir_all(out).unwrap();
}

#[test]
fn page_properties_become_frontmatter_and_namespaces_become_folders() {
    let (out, _) = imported("frontmatter");
    let page = read(&out, "tessela.md");
    assert!(page.starts_with(
        "---\ntype: concept\ntitle: \"Tessela\"\ntags: [\"project\", \"rust\"]\naliases: [\"tess\"]\n---\n"
    ));
    assert!(read(&out, "project/tessela.md").contains("title: \"Project/Tessela\""));
    std::fs::remove_dir_all(out).unwrap();
}

#[test]
fn block_references_and_embeds_are_inlined_and_logbooks_dropped() {
    let (out, _) = imported("inline");
    let journal = read(&out, "journals/2026-10-27.md");
    assert_eq!(
        journal
            .matches("The core idea is that blocks are paragraphs")
            .count(),
        2
    );
    assert!(
        !journal.contains("id::") && !journal.contains("LOGBOOK") && !journal.contains("CLOCK")
    );
    assert!(journal.contains("[x] ship step 2"));
    assert!(journal.contains("![diagram](/assets/diagram.png)"));
    assert!(journal.contains("[2026-10-26](/journals/2026-10-26.md)"));
    assert!(journal.contains("`[[not a link]]`"));
    assert!(
        read(&out, "tessela.md").contains("Quote: The core idea is that blocks are paragraphs")
    );
    std::fs::remove_dir_all(out).unwrap();
}

#[test]
fn the_imported_bundle_lints_clean() {
    let (out, _) = imported("lint");
    let bundle = Bundle::load(&out).unwrap();
    let serious: Vec<_> = Linter::default()
        .run(&bundle)
        .into_iter()
        .filter(|d| d.severity > Severity::Info)
        .collect();
    assert!(serious.is_empty(), "{serious:?}");
    std::fs::remove_dir_all(out).unwrap();
}

#[test]
fn backlinks_work_on_the_imported_bundle() {
    let (out, _) = imported("backlinks");
    let bundle = Bundle::load(&out).unwrap();
    let ask = |refs: &[&str]| {
        Query {
            refs: refs.iter().map(|r| r.to_string()).collect(),
            ..Query::default()
        }
        .run(&bundle)
    };

    // Through a link, a link to an alias, and a child that inherits from its parent.
    let hits = ask(&["tessela"]);
    let texts: Vec<_> = hits.iter().map(|h| h.text.as_str()).collect();
    assert_eq!(
        texts,
        [
            "Started planning [Tessela](/tessela.md) with #agents",
            "write the spec\nSCHEDULED: 2026-10-28",
            "Read about [Machine Learning](/machine-learning.md)\n#status/reading",
            "ping [tess](/tessela.md) about `[[not a link]]`",
            "Subproject of [Tessela](/tessela.md)",
            "[Tessela](/tessela.md) is written in Rust",
        ]
    );

    // A property became a tag under its key, so the key finds every value.
    assert_eq!(ask(&["status"]).len(), 1);
    assert_eq!(ask(&["status/reading"]).len(), 1);

    // Page tags are backlinks too.
    let tagged = ask(&["rust"]);
    assert!(
        tagged
            .iter()
            .any(|h| h.kind == HitKind::Page && h.page == "tessela")
    );

    // A date written in a block is found by a date range.
    let on_the_28th = Query {
        from: Some("2026-10-28".into()),
        to: Some("2026-10-28".into()),
        ..Query::default()
    }
    .run(&bundle);
    assert_eq!(on_the_28th.len(), 1);
    assert!(on_the_28th[0].text.starts_with("write the spec"));
    std::fs::remove_dir_all(out).unwrap();
}

#[test]
fn importing_twice_gives_identical_files() {
    let (a, _) = imported("same-a");
    let (b, _) = imported("same-b");
    assert_eq!(files(&a), files(&b));
    std::fs::remove_dir_all(a).unwrap();
    std::fs::remove_dir_all(b).unwrap();
}

#[test]
fn an_import_never_writes_into_a_folder_that_has_files() {
    let out = out_dir("busy");
    std::fs::create_dir_all(&out).unwrap();
    std::fs::write(out.join("keep.md"), "mine").unwrap();
    let err = import(&graph(), &out).unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
    assert_eq!(read(&out, "keep.md"), "mine");
    std::fs::remove_dir_all(out).unwrap();
}

#[test]
fn a_folder_that_is_not_a_graph_is_refused() {
    let not_a_graph = out_dir("not-a-graph");
    std::fs::create_dir_all(&not_a_graph).unwrap();
    let out = out_dir("not-a-graph-out");
    let err = import(&not_a_graph, &out).unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
    assert!(!out.exists());
    std::fs::remove_dir_all(not_a_graph).unwrap();
}
