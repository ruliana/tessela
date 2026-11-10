//! `tessela query --unlinked`: text that names a page without linking to it.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

fn bundle(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tessela-unlinked-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("journals")).unwrap();
    let write = |name: &str, text: &str| std::fs::write(dir.join(name), text).unwrap();
    write(
        "machine-learning.md",
        "---\ntype: concept\ntitle: Machine Learning\naliases: [ML, statistical learning]\n---\n\n\
         Machine learning is on its own page, which is not a mention.\n",
    );
    write(
        "vocabulary.md",
        "---\ntype: vocabulary\nterms:\n  mlearn:\n    use: machine-learning\n---\n",
    );
    write(
        "notes.md",
        "---\ntype: concept\ntitle: Notes\n---\n\n\
         Studied machine learning today\n\n\
         - Read about ML and Machine Learning basics\n\n\
         Already [machine learning](/machine-learning.md) linked\n\n\
         Tagged #machine-learning so machine learning is a backlink already\n\n\
         - parent #machine-learning\n  - machine learning under a tagged parent\n\n\
         Code `machine learning`, a [machine learning](https://example.org) label, \
         https://example.org/ml and #ml-ops are not mentions\n",
    );
    write(
        "journals/2026-11-10.md",
        "---\ntype: journal\ntitle: \"2026-11-10\"\ndate: \"2026-11-10\"\n---\n\n\
         Tried a mlearn course and statistical learning\n\nZettelkasten again\n",
    );
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

#[test]
fn plain_mentions_of_a_title_an_alias_or_a_vocabulary_term() {
    let dir = bundle("plain");
    let hits = query(&dir, &["--unlinked", "machine-learning"]);
    let mut found: Vec<(&str, Vec<&str>)> = hits
        .iter()
        .map(|h| {
            (
                h["path"].as_str().unwrap(),
                h["mentions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|m| m["text"].as_str().unwrap())
                    .collect(),
            )
        })
        .collect();
    // Pages come newest first, which depends on when the files were written here.
    found.sort();
    assert_eq!(
        found,
        [
            (
                "journals/2026-11-10.md",
                vec!["mlearn", "statistical learning"]
            ),
            ("notes.md", vec!["ML", "Machine Learning"]),
            ("notes.md", vec!["machine learning"]),
        ]
    );
}

#[test]
fn a_mention_says_where_it_is_and_how_to_link_it() {
    let dir = bundle("where");
    let hits = query(&dir, &["--unlinked", "Machine Learning", "--page", "notes"]);
    let two = hits[1]["mentions"].as_array().unwrap();
    // `- Read about ML and Machine Learning basics` is on line 8 of the file.
    assert_eq!(two[0]["line"], 8);
    assert_eq!(two[0]["column"], 13);
    assert_eq!(two[0]["link"], "[ML](/machine-learning.md)");
    assert_eq!(two[1]["column"], 20);
    let line = std::fs::read_to_string(dir.join("notes.md")).unwrap();
    let line = line.lines().nth(7).unwrap();
    assert_eq!(&line[20..36], "Machine Learning");
}

#[test]
fn a_concept_without_a_page_is_found_by_its_name() {
    let dir = bundle("nopage");
    let hits = query(&dir, &["--unlinked", "zettelkasten"]);
    assert_eq!(hits.len(), 1);
    assert_eq!(
        hits[0]["mentions"][0]["link"],
        "[Zettelkasten](/zettelkasten.md)"
    );
    // The other filters still apply.
    assert!(query(&dir, &["--unlinked", "zettelkasten", "--page", "notes"]).is_empty());
}
