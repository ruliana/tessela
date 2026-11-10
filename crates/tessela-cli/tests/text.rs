//! `tessela query --text`, `--words` and `--meta`: finding things by their words.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

fn bundle(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tessela-text-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let write = |name: &str, text: &str| std::fs::write(dir.join(name), text).unwrap();
    write(
        "people.md",
        "---\ntype: concept\ntitle: Ada Lovelace\nrole: Mathematician\nteam: [analytical, engines]\n---\n\n\
         # Early years\n\nBorn in London.\n",
    );
    write(
        "notes.md",
        "---\ntype: concept\ntitle: Notes\n---\n\nThe linter was written in Rust\n\n\
         Rust is fast, and the linter is quick\n\nOnly rust here\n",
    );
    dir
}

fn query(dir: &Path, args: &[&str]) -> Vec<(String, String)> {
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
    answer["hits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| {
            (
                h["kind"].as_str().unwrap().into(),
                h["text"].as_str().unwrap().into(),
            )
        })
        .collect()
}

fn block(text: &str) -> (String, String) {
    ("block".into(), text.into())
}

#[test]
fn several_phrases_and_words_in_any_order() {
    let dir = bundle("phrases");
    // One phrase is still a literal phrase, as before.
    assert_eq!(
        query(&dir, &["--text", "linter was"]),
        [block("The linter was written in Rust")]
    );
    assert!(query(&dir, &["--text", "rust linter"]).is_empty());
    // Every phrase has to be there, in any place of the block.
    assert_eq!(
        query(&dir, &["--text", "rust", "--text", "LINTER"]),
        [
            block("The linter was written in Rust"),
            block("Rust is fast, and the linter is quick"),
        ]
    );
    // Words are separate phrases, so their order does not matter.
    assert_eq!(
        query(&dir, &["--words", "rust linter quick"]),
        [block("Rust is fast, and the linter is quick")]
    );
}

#[test]
fn meta_searches_titles_front_matter_and_headings() {
    let dir = bundle("meta");
    // Without --meta the front matter is not searched, as before.
    assert!(query(&dir, &["--words", "mathematician"]).is_empty());
    assert_eq!(
        query(&dir, &["--words", "mathematician", "--meta"]),
        [("page".into(), "Ada Lovelace".into())]
    );
    // A title, a list value and a heading; the page and its blocks are separate hits.
    assert_eq!(
        query(&dir, &["--text", "lovelace", "--meta"]),
        [("page".into(), "Ada Lovelace".into())]
    );
    assert_eq!(
        query(&dir, &["--text", "engines", "--meta"]),
        [("page".into(), "Ada Lovelace".into())]
    );
    assert_eq!(
        query(&dir, &["--text", "early", "--meta"]),
        [("heading".into(), "Early years".into())]
    );
    // It narrows like the other filters.
    assert!(
        query(
            &dir,
            &["--text", "mathematician", "--meta", "--page", "notes"]
        )
        .is_empty()
    );
}
