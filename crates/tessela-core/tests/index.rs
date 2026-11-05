use std::path::{Path, PathBuf};

use tessela_core::Bundle;
use tessela_core::index::{MARKER, listing, listings, recursive_listing, write_indexes};

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/home")
}

/// A copy of the fixture to write into.
fn copy(name: &str) -> PathBuf {
    fn walk(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in from.read_dir().unwrap() {
            let entry = entry.unwrap();
            let target = to.join(entry.file_name());
            if entry.path().is_dir() {
                walk(&entry.path(), &target);
            } else {
                std::fs::copy(entry.path(), target).unwrap();
            }
        }
    }
    let dir = std::env::temp_dir().join(format!("tessela-index-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    walk(&fixture(), &dir);
    dir
}

#[test]
fn a_listing_has_folders_then_pages_with_home_first() {
    let bundle = Bundle::load(fixture()).unwrap();
    let root = listing(&bundle, "");
    let folders: Vec<(&str, usize)> = root
        .folders
        .iter()
        .map(|f| (f.path.as_str(), f.pages))
        .collect();
    assert_eq!(folders, [("notes", 2), ("wrong", 1)]);
    let pages: Vec<&str> = root.pages.iter().map(|p| p.path.as_str()).collect();
    assert_eq!(pages, ["home.md", "aardvark.md", "rust.md"]);
    assert_eq!(
        root.pages[0].description.as_deref(),
        Some("Start here. The important pages are listed below.")
    );
    let notes = listing(&bundle, "notes");
    let pages: Vec<&str> = notes.pages.iter().map(|p| p.path.as_str()).collect();
    assert_eq!(pages, ["notes/home.md", "notes/learning.md"]);
}

#[test]
fn a_recursive_listing_has_every_page_below_the_folder() {
    let bundle = Bundle::load(fixture()).unwrap();
    let all = recursive_listing(&bundle, "");
    assert!(all.folders.is_empty());
    let pages: Vec<&str> = all.pages.iter().map(|p| p.path.as_str()).collect();
    assert_eq!(
        pages,
        [
            "home.md",
            "aardvark.md",
            "rust.md",
            "notes/home.md",
            "notes/learning.md",
            "wrong/home.md"
        ]
    );
    assert_eq!(pages.len(), bundle.pages.len());

    let notes = recursive_listing(&bundle, "notes/");
    assert_eq!(notes.dir, "notes");
    let pages: Vec<&str> = notes.pages.iter().map(|p| p.path.as_str()).collect();
    assert_eq!(pages, ["notes/home.md", "notes/learning.md"]);

    // Links in the Markdown are relative to the listed folder.
    let root = all.to_markdown("My notes");
    assert!(root.contains("* [Learning](notes/learning.md)"));
    assert!(!root.contains("## Folders"));
}

#[test]
fn markdown_follows_okf_section_6() {
    let bundle = Bundle::load(fixture()).unwrap();
    let root = listing(&bundle, "").to_markdown("My notes");
    assert!(root.starts_with(&format!(
        "---\nokf_version: \"0.2\"\n---\n\n{MARKER}\n\n# My notes\n\n## Folders\n\n* [notes](notes/index.md) - 2 pages\n"
    )));
    assert!(root.contains("\n## Pages\n\n* [Home](home.md) - Start here."));
    assert!(root.contains("* [Aardvark](aardvark.md) - Compared #rust and C.\n"));
    // Only the root has frontmatter.
    let notes = listing(&bundle, "notes").to_markdown("My notes");
    assert!(notes.starts_with(&format!("{MARKER}\n\n# notes\n\n## Pages\n\n")));
}

#[test]
fn listings_cover_the_root_and_every_folder_with_pages() {
    let bundle = Bundle::load(fixture()).unwrap();
    let dirs: Vec<String> = listings(&bundle).into_iter().map(|l| l.dir).collect();
    assert_eq!(dirs, ["", "notes", "wrong"]);
}

#[test]
fn writing_keeps_hand_written_indexes_unless_forced() {
    let dir = copy("write");
    std::fs::write(dir.join("notes/index.md"), "# Mine\n").unwrap();
    let bundle = Bundle::load(&dir).unwrap();

    let report = write_indexes(&bundle, false).unwrap();
    assert_eq!(report.written, ["index.md", "wrong/index.md"]);
    assert_eq!(report.kept, ["notes/index.md"]);
    assert_eq!(
        std::fs::read_to_string(dir.join("notes/index.md")).unwrap(),
        "# Mine\n"
    );
    assert!(
        std::fs::read_to_string(dir.join("index.md"))
            .unwrap()
            .contains("# ")
    );

    // A generated file is replaced on the next run; the hand-written one is still kept.
    let again = write_indexes(&bundle, false).unwrap();
    assert_eq!(again.written, ["index.md", "wrong/index.md"]);

    let forced = write_indexes(&bundle, true).unwrap();
    assert_eq!(forced.kept, Vec::<String>::new());
    assert!(
        std::fs::read_to_string(dir.join("notes/index.md"))
            .unwrap()
            .starts_with(MARKER)
    );

    // Index files are reserved, so they never become pages.
    let reloaded = Bundle::load(&dir).unwrap();
    assert_eq!(reloaded.pages.len(), bundle.pages.len());
    std::fs::remove_dir_all(dir).unwrap();
}
