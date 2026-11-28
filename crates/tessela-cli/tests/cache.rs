//! The parse cache seen from the command line: a second call parses nothing, a change to one
//! file parses that file, and the cache never changes an answer, whatever happens to it.
//! (`tessela-core/tests/props_cache.rs` checks the cache against random edits; this file
//! checks the tool.)

mod support;

use std::path::Path;
use std::process::Command;

use support::Bundle;

/// Runs `tessela` with stats on: its stdout, and how many pages it parsed.
fn call(root: &Path, args: &[&str], envs: &[(&str, &str)]) -> (String, usize) {
    let out = Command::new(env!("CARGO_BIN_EXE_tessela"))
        .env("TESSELA_STATS", "1")
        .envs(envs.iter().copied())
        .args(args)
        .arg(root)
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&out.stderr);
    // `lint` exits 1 when it finds something; anything above that is a failure.
    assert!(
        out.status.code().is_some_and(|c| c <= 1),
        "{args:?} failed: {stderr}"
    );
    let parsed = stderr
        .lines()
        .find_map(|l| l.strip_prefix("tessela-stats: pages_parsed="))
        .and_then(|n| n.trim().parse().ok())
        .unwrap_or_else(|| panic!("no stats: {stderr}"));
    (String::from_utf8(out.stdout).unwrap(), parsed)
}

const QUERIES: &[&[&str]] = &[
    &["pages", "--json"],
    &["query", "--ref", "#rust", "--json"],
    &["query", "--words", "cache", "--json"],
    &["vocab", "--json"],
    &["lint", "--json"],
];

fn answers(root: &Path, envs: &[(&str, &str)]) -> Vec<String> {
    QUERIES.iter().map(|q| call(root, q, envs).0).collect()
}

fn set_old(path: &Path, secs: u64) {
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs))
        .unwrap();
}

#[test]
fn a_second_call_parses_nothing_and_a_changed_page_parses_once() {
    let bundle = Bundle::generate(60);
    let (first, parsed) = call(&bundle.root, &["pages", "--json"], &[]);
    assert_eq!(parsed, bundle.pages, "cold: every page");
    let (second, parsed) = call(&bundle.root, &["pages", "--json"], &[]);
    assert_eq!((second.as_str(), parsed), (first.as_str(), 0), "warm: none");

    let page = bundle.root.join("topics/topic-1.md");
    let mut text = std::fs::read_to_string(&page).unwrap();
    text.push_str("\nA new #line.\n");
    std::fs::write(&page, text).unwrap();
    set_old(&page, 1_700_000_500);
    assert_eq!(call(&bundle.root, &["pages", "--json"], &[]).1, 1);
    assert_eq!(call(&bundle.root, &["pages", "--json"], &[]).1, 0);

    // Other commands share the cache.
    assert_eq!(call(&bundle.root, &["vocab", "--json"], &[]).1, 0);
}

#[test]
fn deleting_the_cache_changes_no_answer() {
    let bundle = Bundle::generate(60);
    let cold = answers(&bundle.root, &[("TESSELA_NO_CACHE", "1")]);
    let filled = answers(&bundle.root, &[]);
    let warm = answers(&bundle.root, &[]);
    assert_eq!(cold, filled);
    assert_eq!(cold, warm);
    std::fs::remove_dir_all(bundle.root.join(".tessela")).unwrap();
    assert_eq!(cold, answers(&bundle.root, &[]));
}

#[test]
fn a_damaged_cache_is_rebuilt_without_a_word() {
    let bundle = Bundle::generate(60);
    let before = answers(&bundle.root, &[]);
    let dir = bundle.root.join(".tessela/cache");
    let mut damaged = 0;
    for entry in std::fs::read_dir(&dir).unwrap().flatten() {
        if entry.path().extension().is_some_and(|e| e == "bin") {
            let mut bytes = std::fs::read(entry.path()).unwrap();
            let at = bytes.len() / 2;
            bytes[at] ^= 0xa5;
            std::fs::write(entry.path(), bytes).unwrap();
            damaged += 1;
        }
    }
    assert!(damaged > 0);
    assert_eq!(before, answers(&bundle.root, &[]));
    // The call put the entries right: the next one parses nothing.
    assert_eq!(call(&bundle.root, &["pages", "--json"], &[]).1, 0);
}

#[test]
fn the_bypass_reads_and_writes_no_cache() {
    let bundle = Bundle::generate(30);
    let env = [("TESSELA_NO_CACHE", "1")];
    assert_eq!(
        call(&bundle.root, &["pages", "--json"], &env).1,
        bundle.pages
    );
    assert_eq!(
        call(&bundle.root, &["pages", "--json"], &env).1,
        bundle.pages
    );
    assert!(!bundle.root.join(".tessela").exists());
    // And it does not read one that is there.
    call(&bundle.root, &["pages", "--json"], &[]);
    assert_eq!(
        call(&bundle.root, &["pages", "--json"], &env).1,
        bundle.pages
    );
}

#[test]
fn edit_commands_show_in_the_next_read() {
    // A move rewrites the files that link to the page, a moment before the next read: those
    // are too new to cache, the moved page is under a new path, and the answer is right.
    let bundle = Bundle::generate(30);
    answers(&bundle.root, &[]);
    let out = Command::new(env!("CARGO_BIN_EXE_tessela"))
        .args(["move", "topics/topic-1", "moved/topic-1", "-b"])
        .arg(&bundle.root)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let cached = answers(&bundle.root, &[]);
    assert!(cached[0].contains("moved/topic-1") && !cached[0].contains("\"topics/topic-1\""));
    assert_eq!(cached, answers(&bundle.root, &[("TESSELA_NO_CACHE", "1")]));
}
