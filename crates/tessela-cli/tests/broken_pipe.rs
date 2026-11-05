use std::process::{Command, Stdio};

/// A bundle whose query output is far bigger than a pipe's buffer, so the program is
/// still writing when the reader goes away.
fn big_bundle(name: &str) -> std::path::PathBuf {
    let dir =
        std::env::temp_dir().join(format!("tessela-broken-pipe-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut page = String::from("---\ntype: concept\n---\n\n");
    for i in 0..5000 {
        page.push_str(&format!("- line {i} about tessela\n"));
    }
    std::fs::write(dir.join("big.md"), page).unwrap();
    dir
}

fn run_into_closed_pipe(name: &str, args: &[&str]) {
    let dir = big_bundle(name);
    let mut child = Command::new(env!("CARGO_BIN_EXE_tessela"))
        .args(args)
        .arg(&dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    drop(child.stdout.take());
    let out = child.wait_with_output().unwrap();
    std::fs::remove_dir_all(dir).unwrap();
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "{args:?}: {:?} {stderr}", out.status);
    assert_eq!(stderr, "", "{args:?} wrote to stderr");
}

#[test]
fn a_query_into_a_closed_pipe_ends_quietly() {
    run_into_closed_pipe("text", &["query", "--text", "tessela"]);
}

#[test]
fn json_output_into_a_closed_pipe_ends_quietly() {
    run_into_closed_pipe("json", &["query", "--text", "tessela", "--json"]);
}
