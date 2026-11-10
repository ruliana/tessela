//! The edit commands as the editor and agents call them: arguments in, JSON out.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use serde_json::Value;

fn bundle(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tessela-cli-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn run(dir: &Path, args: &[&str], stdin: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_tessela"))
        .args(args)
        .args(["--bundle", dir.to_str().unwrap(), "--json", "--api", "2"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(stdin.as_bytes()).ok(); // the tool may refuse before it reads its input
    child.wait_with_output().unwrap()
}

fn json(out: &Output) -> Value {
    serde_json::from_slice(&out.stdout)
        .unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&out.stdout)))
}

#[test]
fn read_save_and_the_conflict_that_follows() {
    let dir = bundle("save");
    let out = run(&dir, &["read", "notes/idea.md"], "");
    let page = json(&out);
    assert_eq!(page["api"], 2);
    assert_eq!(page["exists"], false);
    assert!(page["hash"].is_null());

    let first = json(&run(
        &dir,
        &["save", "notes/idea.md", "--expect", "new"],
        "---\ntype: concept\n---\n\nv1\n",
    ));
    assert_eq!(
        (first["ok"].clone(), first["created"].clone()),
        (true.into(), true.into())
    );
    let hash = first["hash"].as_str().unwrap().to_string();
    assert_eq!(
        json(&run(&dir, &["read", "notes/idea"], ""))["hash"],
        hash.as_str()
    );

    let second = json(&run(
        &dir,
        &["save", "notes/idea.md", "--expect", &hash],
        "v2\n",
    ));
    assert_eq!(second["ok"], true);

    // The first hash is stale now: exit code 3, and the error says what is on disk.
    let out = run(&dir, &["save", "notes/idea.md", "--expect", &hash], "v3\n");
    assert_eq!(out.status.code(), Some(3));
    let err = json(&out);
    assert_eq!(err["ok"], false);
    assert_eq!(err["error"]["code"], "conflict");
    assert_eq!(err["error"]["disk_hash"], second["hash"]);
    assert_eq!(
        std::fs::read_to_string(dir.join("notes/idea.md")).unwrap(),
        "v2\n"
    );

    // A change made behind the CLI's back is seen at once: the disk is the truth.
    std::fs::write(dir.join("notes/idea.md"), "edited by hand\n").unwrap();
    let out = run(
        &dir,
        &[
            "save",
            "notes/idea.md",
            "--expect",
            second["hash"].as_str().unwrap(),
        ],
        "v4\n",
    );
    assert_eq!(out.status.code(), Some(3));
}

#[test]
fn a_caller_for_another_api_version_is_refused() {
    let dir = bundle("api");
    let out = Command::new(env!("CARGO_BIN_EXE_tessela"))
        .args([
            "read",
            "a.md",
            "--json",
            "--api",
            "1",
            "--bundle",
            dir.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(json(&out)["error"]["code"], "api-mismatch");

    let out = Command::new(env!("CARGO_BIN_EXE_tessela"))
        .args(["api", "--json"])
        .output()
        .unwrap();
    assert_eq!(json(&out)["api"], 2);
}

#[test]
fn patch_add_rename_and_remove() {
    let dir = bundle("flow");
    let added = json(&run(&dir, &["add", "Machine Learning"], ""));
    assert_eq!(added["path"], "machine-learning.md");
    assert_eq!(
        run(&dir, &["add", "machine-learning"], "").status.code(),
        Some(2)
    );
    let text = std::fs::read_to_string(dir.join("machine-learning.md")).unwrap();
    assert!(text.contains("title: \"Machine Learning\""));

    let patch = "--- a\n+++ b\n@@ -1,5 +1,6 @@\n ---\n type: concept\n title: \"Machine Learning\"\n ---\n \n+Hello #ai\n";
    let patched = json(&run(
        &dir,
        &[
            "save",
            "machine-learning.md",
            "--patch",
            "--expect",
            added["hash"].as_str().unwrap(),
        ],
        patch,
    ));
    assert_eq!(patched["ok"], true, "{patched}");
    assert!(
        std::fs::read_to_string(dir.join("machine-learning.md"))
            .unwrap()
            .ends_with("Hello #ai\n")
    );

    let other = json(&run(
        &dir,
        &["add", "other", "--stdin"],
        "---\ntype: concept\n---\n\nSee [ml](/machine-learning.md)\n",
    ));
    assert_eq!(other["ok"], true);
    let renamed = json(&run(&dir, &["rename", "machine-learning.md", "ML"], ""));
    assert_eq!(renamed["to"], "ml.md");
    assert!(
        std::fs::read_to_string(dir.join("other.md"))
            .unwrap()
            .contains("[ml](/ml.md)")
    );
    let moved = json(&run(&dir, &["move", "ml.md", "ai/"], ""));
    assert_eq!(moved["to"], "ai/ml.md");

    let hash = json(&run(&dir, &["read", "ai/ml.md"], ""))["hash"]
        .as_str()
        .unwrap()
        .to_string();
    let removed = json(&run(&dir, &["remove", "ai/ml.md", "--expect", &hash], ""));
    assert_eq!(removed["mentioned_by"], serde_json::json!(["other.md"]));
    assert!(!dir.join("ai/ml.md").exists());
}

#[test]
fn paths_outside_the_bundle_are_refused() {
    let dir = bundle("paths");
    for bad in ["../x.md", "/etc/x.md", ".git/x.md"] {
        let out = run(&dir, &["save", bad, "--expect", "new"], "x");
        assert_eq!(out.status.code(), Some(2), "{bad}");
        assert_eq!(json(&out)["error"]["code"], "invalid-path");
    }
}
