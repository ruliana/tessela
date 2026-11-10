//! `tessela fence`: the live lists of a page, as the editor and agents run them.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use serde_json::Value;

fn bundle(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tessela-fence-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("journals")).unwrap();
    std::fs::write(
        dir.join("rust.md"),
        "---\ntype: concept\ntitle: Rust\ndescription: A language\n---\n\nFirst note\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("journals/2026-11-10.md"),
        "---\ntype: journal\ntitle: \"2026-11-10\"\ndate: \"2026-11-10\"\n---\n\n\
         - Learned #rust ownership\n- Wrote a #rust linter\n- Drafted #rust notes, draft only\n",
    )
    .unwrap();
    dir
}

fn fence(dir: &Path, args: &[&str], body: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_tessela"))
        .arg("fence")
        .args(args)
        .args(["--bundle", dir.to_str().unwrap()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(body.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

fn json(out: &Output) -> Value {
    serde_json::from_slice(&out.stdout)
        .unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&out.stdout)))
}

fn texts(answer: &Value) -> Vec<&str> {
    answer["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["text"].as_str().unwrap())
        .collect()
}

#[test]
fn a_pipe_of_filters_over_a_query() {
    let dir = bundle("pipe");
    let out = fence(
        &dir,
        &["--json", "--api", "2"],
        "query --ref rust --type journal | rg -v draft | sort -r | head 2\n",
    );
    let answer = json(&out);
    assert_eq!(
        (answer["api"].clone(), answer["ok"].clone()),
        (2.into(), true.into())
    );
    assert_eq!(answer["command"], "query");
    assert_eq!(
        texts(&answer),
        [
            "journals/2026-11-10.md:8:Wrote a #rust linter",
            "journals/2026-11-10.md:7:Learned #rust ownership",
        ]
    );
    // A row that still starts with `path:line:` is the hit it came from.
    let hit = &answer["rows"][0]["source"];
    assert_eq!(hit["path"], "journals/2026-11-10.md");
    assert_eq!(hit["line"], 8);
    assert!(
        hit["handle"]
            .as_str()
            .unwrap()
            .starts_with("journals/2026-11-10#")
    );
}

#[test]
fn a_row_stops_being_a_hit_when_a_filter_removes_its_path() {
    let dir = bundle("prefix");
    let answer = json(&fence(
        &dir,
        &["--json"],
        "query --ref rust --type journal | sed 's/^[^:]*:[0-9]*://'",
    ));
    assert_eq!(texts(&answer)[0], "Learned #rust ownership");
    assert!(answer["rows"][0]["source"].is_null());

    let answer = json(&fence(&dir, &["--json"], "query --ref rust | wc -l"));
    assert_eq!(texts(&answer), ["3"]);
    assert!(answer["rows"][0]["source"].is_null());
}

#[test]
fn text_output_is_the_lines_and_the_whole_fence_is_accepted() {
    let dir = bundle("text");
    let out = fence(&dir, &[], "```tessela\ntessela vocab |\n  rg rust\n```\n");
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(String::from_utf8_lossy(&out.stdout), "   3  rust  1 page\n");
}

#[test]
fn index_and_lint_can_start_a_fence() {
    let dir = bundle("others");
    let answer = json(&fence(
        &dir,
        &["--json"],
        "index --recursive | rg -i language",
    ));
    assert_eq!(texts(&answer), ["rust.md:1:Rust - A language"]);
    assert_eq!(answer["rows"][0]["source"]["title"], "Rust");
    let answer = json(&fence(&dir, &["--json"], "lint --min-severity warning"));
    assert_eq!(answer["command"], "lint");
}

#[test]
fn a_fence_never_reaches_a_shell_a_program_or_another_folder() {
    let dir = bundle("safe");
    let outside = std::env::temp_dir().join(format!("tessela-fence-out-{}", std::process::id()));
    let _ = std::fs::remove_file(&outside);
    let attempts = [
        "query --ref rust | awk 'BEGIN{system(\"touch /tmp/x\")}'",
        "query --ref rust | sh -c id",
        "query --ref rust | sed 'e id'",
        &format!("query --ref rust | sed 'w {}'", outside.display()),
        "query --ref rust | sed -i s/a/b/",
        "query --ref rust | rg --pre cat rust",
        "query --ref rust > /tmp/x",
        "index --write",
        "add evil",
        "read rust.md",
        "query /etc --ref rust",
        "",
        "query --ref rust |",
    ];
    for body in attempts {
        let out = fence(&dir, &["--json"], body);
        assert_eq!(out.status.code(), Some(2), "{body}");
        let err = json(&out);
        assert_eq!(err["ok"], false, "{body}");
        assert_eq!(err["error"]["code"], "invalid-input", "{body}");
    }
    assert!(!outside.exists());
    assert!(!dir.join("index.md").exists());
    assert!(!dir.join("evil.md").exists());
}
