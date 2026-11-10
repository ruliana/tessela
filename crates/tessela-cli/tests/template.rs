//! Page types with a template: `templates/NAME.md`, copied by `add`, checked by lint.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

const DECISION: &str = "---\ntype: template\ntitle: The decision\nstatus: proposed\n\
                        deciders: []\n---\n\n## Context\n\nSee #decision-log\n\n## Decision\n";
const JOURNAL: &str =
    "---\ntype: template\ntitle: Day\ndate: Day\nmood: \"\"\n---\n\n- [ ] plan the day\n";

fn bundle(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tessela-template-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("templates")).unwrap();
    std::fs::write(dir.join("templates/decision.md"), DECISION).unwrap();
    std::fs::write(dir.join("templates/journal.md"), JOURNAL).unwrap();
    dir
}

fn tessela(dir: &Path, args: &[&str]) -> Value {
    let out = Command::new(env!("CARGO_BIN_EXE_tessela"))
        .args(args)
        .args(["--bundle", dir.to_str().unwrap(), "--json", "--api", "2"])
        .output()
        .unwrap();
    serde_json::from_slice(&out.stdout)
        .unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&out.stdout)))
}

fn on_path(dir: &Path, command: &str, args: &[&str]) -> Value {
    let out = Command::new(env!("CARGO_BIN_EXE_tessela"))
        .arg(command)
        .arg(dir)
        .args(args)
        .arg("--json")
        .output()
        .unwrap();
    serde_json::from_slice(&out.stdout).unwrap()
}

#[test]
fn add_copies_the_template_of_the_type_and_swaps_type_and_title() {
    let dir = bundle("add");
    let read = tessela(&dir, &["read", "use-rust.md"]);
    assert_eq!(read["exists"], false);

    tessela(&dir, &["add", "Use Rust", "--type", "decision"]);
    assert_eq!(
        std::fs::read_to_string(dir.join("use-rust.md")).unwrap(),
        "---\ntype: decision\ntitle: \"Use Rust\"\nstatus: proposed\ndeciders: []\n---\n\n\
         ## Context\n\nSee #decision-log\n\n## Decision\n"
    );

    // A journal day takes its shape from templates/journal.md, with the day set.
    tessela(&dir, &["add", "journals/2026-11-10"]);
    assert_eq!(
        std::fs::read_to_string(dir.join("journals/2026-11-10.md")).unwrap(),
        "---\ntype: journal\ntitle: \"2026-11-10\"\ndate: \"2026-11-10\"\nmood: \"\"\n---\n\n- [ ] plan the day\n"
    );

    // A type without a template, and a file that is not marked as one, start as before.
    tessela(&dir, &["add", "Notes", "--type", "howto"]);
    assert!(
        std::fs::read_to_string(dir.join("notes.md"))
            .unwrap()
            .starts_with("---\ntype: howto\ntitle: \"Notes\"\n---\n")
    );
    std::fs::write(
        dir.join("templates/reference.md"),
        "---\ntype: concept\n---\nnot a template\n",
    )
    .unwrap();
    tessela(&dir, &["add", "Ref", "--type", "reference"]);
    assert!(
        std::fs::read_to_string(dir.join("ref.md"))
            .unwrap()
            .starts_with("---\ntype: reference\n")
    );

    // `read` shows what `add` would write.
    let read = tessela(&dir, &["read", "other-decision.md"]);
    assert!(
        read["text"]
            .as_str()
            .unwrap()
            .starts_with("---\ntype: concept")
    );
}

#[test]
fn templates_are_not_notes_to_the_other_tools() {
    let dir = bundle("skip");
    // The tag in the template is not a mention, and the template is not a hit.
    let hits = on_path(&dir, "query", &["--ref", "decision-log"]);
    assert!(hits["hits"].as_array().unwrap().is_empty());
    let concepts = on_path(&dir, "vocab", &[]);
    assert!(
        concepts["concepts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c["concept"] != "decision-log")
    );
    let lint = on_path(&dir, "lint", &[]);
    assert!(lint["diagnostics"].as_array().unwrap().is_empty(), "{lint}");
    // Asking for the type finds them.
    let by_type = on_path(
        &dir,
        "query",
        &["--type", "template", "--text", "decision-log"],
    );
    assert_eq!(by_type["hits"][0]["path"], "templates/decision.md");
}

#[test]
fn lint_says_which_keys_of_the_template_a_page_lacks() {
    let dir = bundle("lint");
    std::fs::write(
        dir.join("choice.md"),
        "---\ntype: decision\ntitle: Choice\n---\n\nText\n",
    )
    .unwrap();
    let keys = |dir: &Path| -> Vec<String> {
        on_path(dir, "lint", &[])["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|d| d["rule"] == "tessela/template-keys")
            .map(|d| {
                format!(
                    "{}: {}",
                    d["path"].as_str().unwrap(),
                    d["severity"].as_str().unwrap()
                )
            })
            .collect()
    };
    assert_eq!(keys(&dir), ["choice.md: warning"]);
    let message = on_path(&dir, "lint", &[])["diagnostics"][0]["message"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        message.contains("`status`, `deciders`") && message.contains("templates/decision.md"),
        "{message}"
    );
    std::fs::write(
        dir.join("choice.md"),
        "---\ntype: decision\ntitle: Choice\nstatus: accepted\ndeciders: [ann]\n---\n\nText\n",
    )
    .unwrap();
    assert!(keys(&dir).is_empty());
}
