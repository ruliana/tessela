//! The narrow waist: what a client in any language may rely on when it calls `tessela`.
//! Every `--json` answer carries `api` and `ok`, and a caller written for another API
//! version is refused.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::Value;

const API: u64 = 2;

fn bundle(name: &str, files: &[(&str, &str)]) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tessela-waist-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    for (path, text) in files {
        let file = dir.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text).unwrap();
    }
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn tessela(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_tessela"))
        .args(args)
        .output()
        .unwrap()
}

/// Runs `tessela COMMAND DIR --json --api N` and parses what it printed.
fn call(command: &str, dir: &Path, extra: &[&str]) -> (Option<i32>, Value) {
    let api = API.to_string();
    let mut args = vec![command, dir.to_str().unwrap(), "--json", "--api", &api];
    args.extend_from_slice(extra);
    let out = tessela(&args);
    let json = serde_json::from_slice(&out.stdout)
        .unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&out.stdout)));
    (out.status.code(), json)
}

const NOTES: &[(&str, &str)] = &[
    (
        "ideas.md",
        "---\ntype: concept\n---\n\n# Ideas\n\n- Try #tessela and [[x]]\n- Another #tessela note\n",
    ),
    ("odd.md", "no frontmatter at all\n"),
];

#[test]
fn query_vocab_and_lint_answer_in_an_envelope() {
    let dir = bundle("envelope", NOTES);

    let (code, q) = call("query", &dir, &["--ref", "tessela", "--limit", "1"]);
    assert_eq!(code, Some(0));
    assert_eq!(
        (&q["api"], &q["ok"]),
        (&Value::from(API), &Value::Bool(true))
    );
    assert_eq!(q["hits"].as_array().unwrap().len(), 1);
    // `total` counts the hits before --limit cut them.
    assert!(q["total"].as_u64().unwrap() >= 2);

    let (_, v) = call("vocab", &dir, &[]);
    assert_eq!(
        (&v["api"], &v["ok"]),
        (&Value::from(API), &Value::Bool(true))
    );
    assert!(
        v["concepts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["concept"] == "tessela")
    );

    // Findings are not a failure of the command: `ok` stays true and the exit code says
    // what lint always said.
    let (code, l) = call("lint", &dir, &[]);
    assert_eq!(
        (&l["api"], &l["ok"]),
        (&Value::from(API), &Value::Bool(true))
    );
    let findings = l["diagnostics"].as_array().unwrap();
    assert!(findings.iter().any(|d| d["path"] == "odd.md"));
    let has_error = findings.iter().any(|d| d["severity"] == "error");
    assert_eq!(code, Some(if has_error { 1 } else { 0 }));
}

#[test]
fn index_and_import_report_in_an_envelope_too() {
    let dir = bundle("index", NOTES);
    let (_, listing) = call("index", &dir, &[]);
    assert_eq!(listing["api"], API);
    assert_eq!(listing["ok"], true);
    assert!(listing["pages"].is_array());
}

#[test]
fn a_caller_for_another_api_version_is_refused_with_json() {
    let dir = bundle("mismatch", NOTES);
    for command in ["query", "vocab", "lint", "index"] {
        let out = tessela(&[command, dir.to_str().unwrap(), "--json", "--api", "1"]);
        assert_eq!(out.status.code(), Some(2), "{command}");
        let json: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(json["ok"], false, "{command}");
        assert_eq!(json["api"], API, "{command}");
        assert_eq!(json["error"]["code"], "api-mismatch", "{command}");
    }
}

#[test]
fn a_bundle_that_is_not_there_is_a_json_error() {
    let missing = std::env::temp_dir().join("tessela-waist-missing-folder");
    let out = tessela(&["query", missing.to_str().unwrap(), "--json"]);
    assert_eq!(out.status.code(), Some(2));
    let json: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(
        (json["ok"].clone(), json["api"].clone()),
        (false.into(), API.into())
    );
    assert_eq!(json["error"]["code"], "not-found");
}

#[test]
fn pages_lists_every_concept_page_with_the_title_it_gives_itself() {
    let dir = bundle(
        "pages",
        &[
            (
                "daily-todo.md",
                "---\ntype: concept\ntitle: \"Daily TODO\"\n---\n\n# Other\n",
            ),
            (
                "reading-list.md",
                "---\ntype: concept\n---\n\n# Books to read\n",
            ),
            ("project/bare-page.md", "no heading"),
            ("journals/2026-10-27.md", "---\ntype: journal\n---\n\nhi\n"),
            ("index.md", "reserved"),
            (".git/hidden.md", "hidden"),
        ],
    );
    let (code, json) = call("pages", &dir, &[]);
    assert_eq!(code, Some(0));
    let pages = json["pages"].as_array().unwrap();
    let row = |path: &str| pages.iter().find(|p| p["path"] == path).unwrap().clone();
    assert_eq!(row("daily-todo.md")["title"], "Daily TODO");
    assert_eq!(row("reading-list.md")["title"], "Books to read");
    assert_eq!(row("project/bare-page.md")["title"], "bare page");
    assert_eq!(row("project/bare-page.md")["id"], "project/bare-page");
    assert_eq!(row("journals/2026-10-27.md")["type"], "journal");
    assert!(row("project/bare-page.md")["type"].is_null());
    // Sorted by path; reserved and hidden files are not pages.
    let paths: Vec<_> = pages.iter().map(|p| p["path"].as_str().unwrap()).collect();
    assert_eq!(
        paths,
        [
            "daily-todo.md",
            "journals/2026-10-27.md",
            "project/bare-page.md",
            "reading-list.md"
        ]
    );
}
