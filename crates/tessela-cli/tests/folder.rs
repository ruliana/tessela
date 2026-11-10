//! `tessela index --dir`: what a folder page shows under its `home.md`.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

fn bundle(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tessela-folder-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    for sub in ["project/deep", "journals"] {
        std::fs::create_dir_all(dir.join(sub)).unwrap();
    }
    let write = |name: &str, text: &str| std::fs::write(dir.join(name), text).unwrap();
    write(
        "home.md",
        "---\ntype: home\ntitle: Home\n---\n\nStart with [Rust](/rust.md) and #project/tessela, then \
         [Gone](/gone.md), [Rust again](/rust.md) and [me](/home.md).\n\n- [Project](/project/home.md)\n",
    );
    write(
        "rust.md",
        "---\ntype: concept\ntitle: Rust\ndescription: A language\n---\n",
    );
    write(
        "project/home.md",
        "---\ntype: home\ntitle: Project\n---\n\nSee [the plan](/project/plan.md).\n",
    );
    write(
        "project/plan.md",
        "---\ntype: concept\ntitle: Plan\n---\n\nThe plan.\n",
    );
    write(
        "project/tessela.md",
        "---\ntype: concept\ntitle: Tessela\n---\n",
    );
    write(
        "project/deep/note.md",
        "---\ntype: concept\ntitle: Note\n---\n",
    );
    write(
        "journals/2026-11-10.md",
        "---\ntype: journal\ntitle: \"2026-11-10\"\ndate: \"2026-11-10\"\n---\n\nToday\n",
    );
    dir
}

fn listing(dir: &Path, folder: &str) -> Value {
    let out = Command::new(env!("CARGO_BIN_EXE_tessela"))
        .args(["index", dir.to_str().unwrap(), "--json", "--dir", folder])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}

fn paths(list: &Value) -> Vec<&str> {
    list.as_array()
        .unwrap()
        .iter()
        .map(|e| e["path"].as_str().unwrap())
        .collect()
}

#[test]
fn a_folder_lists_its_home_page_and_where_it_points() {
    let dir = bundle("root");
    let root = listing(&dir, "");
    assert_eq!(root["api"], 2);
    assert_eq!(root["home"], "home.md");
    // In the order the home page first mentions them; no missing page, no duplicate, not itself.
    assert_eq!(
        paths(&root["links"]),
        ["rust.md", "project/tessela.md", "project/home.md"]
    );
    assert_eq!(root["links"][0]["description"], "A language");
    // Sub-folders say whether they have a home page of their own.
    let folders: Vec<(&str, bool)> = root["folders"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            (
                f["path"].as_str().unwrap(),
                f["has_home"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(folders, [("journals", false), ("project", true)]);
}

#[test]
fn a_sub_folder_has_its_own_listing() {
    let dir = bundle("sub");
    let project = listing(&dir, "project");
    assert_eq!(project["home"], "project/home.md");
    assert_eq!(paths(&project["links"]), ["project/plan.md"]);
    // Its own pages, the home page first, then by title; the deeper folder is a folder.
    assert_eq!(
        paths(&project["pages"]),
        ["project/home.md", "project/plan.md", "project/tessela.md"]
    );
    assert_eq!(project["folders"][0]["path"], "project/deep");
    // A folder without a home page says so.
    let deep = listing(&dir, "project/deep");
    assert!(deep["home"].is_null());
    assert!(deep["links"].as_array().unwrap().is_empty());
    // Journal days sit apart, newest first.
    assert_eq!(
        paths(&listing(&dir, "journals")["journal"]),
        ["journals/2026-11-10.md"]
    );
}
