//! `tessela query --task`: the checkboxes of a bundle, for an agenda.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

fn bundle(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tessela-task-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("journals")).unwrap();
    std::fs::write(
        dir.join("journals/2026-11-08.md"),
        "---\ntype: journal\ntitle: \"2026-11-08\"\ndate: \"2026-11-08\"\n---\n\n\
         - [ ] send the invoice #money\n- [x] pay rent #money\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("plans.md"),
        "---\ntype: concept\ntitle: Plans\n---\n\n\
         [ ] a paragraph is not a task\n\n\
         - [ ] call mum on 2026-11-14\n  - [X] buy the ticket\n  - [ ] pack #travel\n- plain item\n\
         - [ ] review 2026-11-20\n",
    )
    .unwrap();
    dir
}

fn query(dir: &Path, args: &[&str]) -> Vec<Value> {
    let out = Command::new(env!("CARGO_BIN_EXE_tessela"))
        .args(["query", dir.to_str().unwrap(), "--json"])
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let answer: Value = serde_json::from_slice(&out.stdout).unwrap();
    answer["hits"].as_array().unwrap().clone()
}

fn texts(hits: &[Value]) -> Vec<&str> {
    hits.iter().map(|h| h["text"].as_str().unwrap()).collect()
}

#[test]
fn open_done_and_any_tasks() {
    let dir = bundle("kinds");
    let open = query(&dir, &["--task", "open"]);
    assert_eq!(
        texts(&open),
        [
            "send the invoice #money",
            "call mum on 2026-11-14",
            "pack #travel",
            "review 2026-11-20",
        ]
    );
    assert!(open.iter().all(|h| h["task"] == "open"));
    assert_eq!(
        texts(&query(&dir, &["--task", "done"])),
        ["pay rent #money", "buy the ticket"]
    );
    assert_eq!(query(&dir, &["--task", "any"]).len(), 6);
    // Without the flag nothing changes, and a block that is not a task says so.
    let all = query(&dir, &["--page", "plans"]);
    assert!(all.iter().any(|h| h["task"].is_null()));
}

#[test]
fn tasks_combine_with_the_other_filters() {
    let dir = bundle("combined");
    assert_eq!(
        texts(&query(&dir, &["--task", "open", "--ref", "money"])),
        ["send the invoice #money"]
    );
    // Overdue by the 15th: on a journal day up to it, or naming a date up to it.
    assert_eq!(
        texts(&query(&dir, &["--task", "open", "--to", "2026-11-15"])),
        ["send the invoice #money", "call mum on 2026-11-14"]
    );
    // Due in a range, which is what a day of the agenda asks for.
    assert_eq!(
        texts(&query(
            &dir,
            &[
                "--task",
                "open",
                "--from",
                "2026-11-10",
                "--to",
                "2026-11-15"
            ]
        )),
        ["call mum on 2026-11-14"]
    );
}
