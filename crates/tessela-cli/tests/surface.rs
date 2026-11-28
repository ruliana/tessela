//! `tessela surface PAGE --at LINE`: what the notes have to say about the block being written.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Duration, UNIX_EPOCH};

use serde_json::Value;

/// A page with the line it is written on: `draft.md` line 5 is the thought, and the other pages
/// each hold something a source finds. The filler pages make a word that two pages share rare.
fn bundle(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tessela-surface-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("filler")).unwrap();
    for i in 0..60 {
        write(
            &dir,
            &format!("filler/f{i}.md"),
            &format!("- filler{i} text\n"),
        );
    }
    write(
        &dir,
        "alpha.md",
        "---\ntitle: Alpha Beta\n---\n\n# Alpha Beta\n\n- [ ] review the plan 2026-12-01\n",
    );
    write(
        &dir,
        "notes.md",
        "- Remember to look at [Draft](/draft.md)\n\
         - cache tuning goes in #cache\n\
         - [ ] file taxes 2026-12-02\n\
         - zebrafish plumage taxonomy research\n",
    );
    write(
        &dir,
        "draft.md",
        "# Draft\n\n## Ideas #cache\n\n\
         - Alpha Beta is due 2026-12-01, like the zebrafish plumage taxonomy\n",
    );
    dir
}

/// Writes a page with a modification time long ago, which the cache trusts.
fn write(dir: &Path, path: &str, text: &str) {
    let file = dir.join(path);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, text).unwrap();
    std::fs::File::options()
        .write(true)
        .open(&file)
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_secs(1_700_000_000))
        .unwrap();
}

fn run(dir: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_tessela"))
        .env("TESSELA_STATS", "1")
        .arg("surface")
        .args(args)
        .args(["-b", dir.to_str().unwrap(), "--json", "--api", "2"])
        .output()
        .unwrap()
}

fn surface(dir: &Path, args: &[&str]) -> Value {
    let out = run(dir, args);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}

fn parsed(out: &Output) -> usize {
    String::from_utf8_lossy(&out.stderr)
        .lines()
        .find_map(|l| l.strip_prefix("tessela-stats: pages_parsed="))
        .and_then(|n| n.trim().parse().ok())
        .expect("stats")
}

/// The candidates of one source, as (path, line).
fn of<'a>(answer: &'a Value, source: &str) -> Vec<(&'a str, u64)> {
    answer["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["source"] == source)
        .map(|c| (c["path"].as_str().unwrap(), c["line"].as_u64().unwrap()))
        .collect()
}

#[test]
fn every_source_has_something_to_say() {
    let dir = bundle("sources");
    let answer = surface(&dir, &["draft.md", "--at", "5"]);
    assert_eq!(answer["ok"], true);
    assert_eq!(answer["at"]["kind"], "block");
    assert_eq!(answer["at"]["refs"], serde_json::json!(["cache"]));
    assert_eq!(
        answer["at"]["heading_path"],
        serde_json::json!(["Draft", "Ideas #cache"])
    );

    assert_eq!(of(&answer, "backlink"), [("notes.md", 1)]);
    assert_eq!(of(&answer, "related"), [("notes.md", 2)]);
    // The words of the thought are in the title of `alpha.md` as well as in the note.
    assert_eq!(of(&answer, "words"), [("notes.md", 4), ("alpha.md", 5)]);
    // The task due the day after the one written, and the one due that day.
    assert_eq!(of(&answer, "agenda"), [("alpha.md", 7), ("notes.md", 3)]);
    let unlinked = of(&answer, "unlinked");
    assert_eq!(unlinked, [("alpha.md", 1)]);

    let candidates = answer["candidates"].as_array().unwrap();
    let alpha = candidates
        .iter()
        .find(|c| c["source"] == "unlinked")
        .unwrap();
    assert_eq!(alpha["kind"], "page");
    assert_eq!(alpha["title"], "Alpha Beta");
    assert_eq!(alpha["link"], "[Alpha Beta](/alpha.md)");
    assert_eq!(alpha["mention"]["text"], "Alpha Beta");
    let at = answer["at"]["text"].as_str().unwrap();
    assert_eq!(
        &at[alpha["mention"]["from"].as_u64().unwrap() as usize..][..10],
        "Alpha Beta"
    );
    let words = candidates.iter().find(|c| c["source"] == "words").unwrap();
    assert!(
        words["reason"].as_str().unwrap().contains("zebrafish"),
        "{words}"
    );
    assert_eq!(words["kind"], "block");
    assert_eq!(words["excerpt"], "zebrafish plumage taxonomy research");
    // Best first, and `limit` cuts the list but not what `total` counts.
    let scores: Vec<f64> = candidates
        .iter()
        .map(|c| c["score"].as_f64().unwrap())
        .collect();
    assert!(scores.windows(2).all(|w| w[0] >= w[1]), "{scores:?}");
    let cut = surface(&dir, &["draft.md", "--at", "5", "--limit", "2"]);
    assert_eq!(cut["candidates"].as_array().unwrap().len(), 2);
    assert_eq!(cut["total"], answer["total"]);
}

#[test]
fn the_line_may_be_between_blocks_and_the_text_may_be_ahead_of_the_file() {
    let dir = bundle("lines");
    // On the heading's own blank line below it: the heading.
    let heading = surface(&dir, &["draft.md", "--at", "4"]);
    assert_eq!(heading["at"]["kind"], "heading");
    assert_eq!(heading["at"]["text"], "Ideas #cache");
    // Past the end of the file: the last block.
    let past = surface(&dir, &["draft.md", "--at", "9"]);
    assert_eq!(past["at"]["kind"], "block");
    assert_eq!(past["at"]["line"], 5);
    // The writer has changed the block: their text is the thought, in the block's place.
    let text = "Talking to Ana about #rust and zebrafish";
    let ahead = surface(&dir, &["draft.md", "--at", "5", "--text", text]);
    assert_eq!(ahead["at"]["text"], text);
    assert_eq!(ahead["at"]["refs"], serde_json::json!(["cache", "rust"]));
    assert!(of(&ahead, "unlinked").is_empty());
}

#[test]
fn a_page_that_is_not_there_yet_needs_the_text() {
    let dir = bundle("new");
    let out = run(&dir, &["new.md", "--at", "1"]);
    assert_eq!(out.status.code(), Some(2));
    let failure: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(failure["error"]["code"], "not-found");

    let answer = surface(&dir, &["new.md", "--at", "1", "--text", "About Alpha Beta"]);
    assert_eq!(answer["at"]["kind"], "block");
    assert_eq!(of(&answer, "unlinked"), [("alpha.md", 1)]);
}

#[test]
fn a_second_call_parses_nothing_and_a_changed_page_is_read_again() {
    let dir = bundle("warm");
    let args = ["draft.md", "--at", "5"];
    let cold = run(&dir, &args);
    assert_eq!(parsed(&cold), 63);
    let warm = run(&dir, &args);
    assert_eq!(
        parsed(&warm),
        0,
        "everything is in the cache and the summary"
    );
    assert_eq!(cold.stdout, warm.stdout);

    // One page changes: it is read again (and that is all), and the answer follows it.
    let before = surface(&dir, &args);
    assert!(of(&before, "words").contains(&("notes.md", 4)));
    write(
        &dir,
        "notes.md",
        "- Remember to look at [Draft](/draft.md)\n- nothing about fish\n",
    );
    std::fs::File::options()
        .write(true)
        .open(dir.join("notes.md"))
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_secs(1_700_000_100))
        .unwrap();
    let changed = run(&dir, &args);
    assert_eq!(parsed(&changed), 1);
    let answer: Value = serde_json::from_slice(&changed.stdout).unwrap();
    assert!(!of(&answer, "words").iter().any(|c| c.0 == "notes.md"));
    assert_eq!(of(&answer, "backlink"), [("notes.md", 1)]);

    // The summary can go, or be damaged, and the answer stays the same.
    let summary = dir.join(".tessela/cache/summary.dat");
    let mut bytes = std::fs::read(&summary).unwrap();
    let middle = bytes.len() / 2;
    bytes[middle] ^= 0xff;
    std::fs::write(&summary, bytes).unwrap();
    assert_eq!(run(&dir, &args).stdout, changed.stdout);
    std::fs::remove_dir_all(dir.join(".tessela")).unwrap();
    assert_eq!(run(&dir, &args).stdout, changed.stdout);
}
