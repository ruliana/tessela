//! `tessela changes`: what an agent or a pull did to the notes, block by block.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=t", "-c", "user.email=t@example.org"])
        .args(["-c", "commit.gpgsign=false"])
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn repo(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tessela-changes-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("notes")).unwrap();
    git(&dir, &["init", "-q"]);
    dir
}

fn changes(dir: &Path, args: &[&str]) -> Value {
    let out = Command::new(env!("CARGO_BIN_EXE_tessela"))
        .arg("changes")
        .args(args)
        .args(["--bundle", dir.to_str().unwrap(), "--json", "--api", "2"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}

const BEFORE: &str = "---\ntype: concept\ntitle: Plan\n---\n\nkeep\n\n- change me\n\ngone\n";
const AFTER: &str = "---\ntype: concept\ntitle: Plan\n---\n\nkeep\n\n- changed it\n\nbrand new\n";

fn summary(page: &Value) -> Vec<String> {
    page["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            format!(
                "{} {}",
                c["kind"].as_str().unwrap(),
                c["text"].as_str().unwrap()
            )
        })
        .collect()
}

#[test]
fn edits_added_and_deleted_pages_since_the_last_commit() {
    let dir = repo("head");
    std::fs::write(dir.join("notes/plan.md"), BEFORE).unwrap();
    std::fs::write(dir.join("notes/old.md"), "---\ntype: concept\n---\n\nbye\n").unwrap();
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "-m", "first"]);

    assert!(changes(&dir, &[])["pages"].as_array().unwrap().is_empty());

    std::fs::write(dir.join("notes/plan.md"), AFTER).unwrap();
    std::fs::remove_file(dir.join("notes/old.md")).unwrap();
    std::fs::write(dir.join("fresh.md"), "---\ntype: concept\n---\n\nhello\n").unwrap();
    std::fs::write(dir.join("notes/data.csv"), "not a page").unwrap();

    let answer = changes(&dir, &[]);
    assert_eq!(
        (answer["api"].clone(), answer["since"].clone()),
        (2.into(), "HEAD".into())
    );
    let pages: Vec<(&str, &str)> = answer["pages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p["path"].as_str().unwrap(), p["status"].as_str().unwrap()))
        .collect();
    assert_eq!(
        pages,
        [
            ("fresh.md", "added"),
            ("notes/old.md", "deleted"),
            ("notes/plan.md", "modified")
        ]
    );
    let plan = &answer["pages"][2];
    assert_eq!(summary(plan), ["changed changed it", "changed brand new"]);
    // Enough to keep it or put it back: where, and the source text on both sides.
    let first = &plan["changes"][0];
    assert_eq!(
        (first["line"].clone(), first["old_line"].clone()),
        (8.into(), 8.into())
    );
    assert_eq!(first["raw"], "- changed it");
    assert_eq!(first["old_raw"], "- change me");
    assert!(first["handle"].as_str().unwrap().starts_with("notes/plan#"));
    assert_eq!(
        summary(&answer["pages"][0]),
        ["added type: concept", "added hello"]
    );
    assert_eq!(
        summary(&answer["pages"][1]),
        ["removed type: concept", "removed bye"]
    );
}

#[test]
fn since_names_any_revision_and_a_repository_without_commits_is_all_new() {
    let dir = repo("since");
    std::fs::write(dir.join("a.md"), "---\ntype: concept\n---\n\none\n").unwrap();
    let fresh = changes(&dir, &[]);
    assert_eq!(fresh["commit"], Value::Null);
    assert_eq!(fresh["pages"][0]["status"], "added");

    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "-m", "one"]);
    std::fs::write(dir.join("a.md"), "---\ntype: concept\n---\n\none\n\ntwo\n").unwrap();
    git(&dir, &["commit", "-q", "-am", "two"]);
    std::fs::write(dir.join("a.md"), "---\ntype: concept\n---\n\nuno\n\ntwo\n").unwrap();

    assert_eq!(
        summary(&changes(&dir, &["--since", "HEAD~1"])["pages"][0]),
        ["changed uno", "added two"]
    );
    assert_eq!(summary(&changes(&dir, &[])["pages"][0]), ["changed uno"]);

    // A bundle that is a folder of a larger repository only sees its own pages.
    let inner = dir.join("bundle");
    std::fs::create_dir_all(&inner).unwrap();
    std::fs::write(inner.join("b.md"), "---\ntype: concept\n---\n\nb\n").unwrap();
    let pages = &changes(&inner, &[])["pages"];
    assert_eq!(pages.as_array().unwrap().len(), 1);
    assert_eq!(pages[0]["path"], "b.md");

    for args in [&["--since", "nope"][..], &["--since", "--output=x"]] {
        let out = Command::new(env!("CARGO_BIN_EXE_tessela"))
            .arg("changes")
            .args(args)
            .args(["--bundle", dir.to_str().unwrap(), "--json"])
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(2), "{args:?}");
    }
}

#[test]
fn outside_git_it_says_so() {
    let dir = std::env::temp_dir().join(format!("tessela-changes-nogit-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_tessela"))
        .arg("changes")
        .args(["--bundle", dir.to_str().unwrap(), "--json"])
        .env("GIT_CEILING_DIRECTORIES", std::env::temp_dir())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    let err: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(err["error"]["code"], "invalid-input");
}
