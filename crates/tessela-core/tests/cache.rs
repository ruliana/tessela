//! The parse cache (`.tessela/cache/`) on the cases the property test does not reach: unusual
//! frontmatter, a file changed the moment after it was cached, and where the cache goes.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, UNIX_EPOCH};

use tessela_core::Bundle;

fn scratch() -> PathBuf {
    static N: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "tessela-cache-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_old(dir: &Path, path: &str, text: &str, secs: u64) {
    let file = dir.join(path);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, text).unwrap();
    std::fs::File::options()
        .write(true)
        .open(file)
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_secs(secs))
        .unwrap();
}

fn entries(dir: &Path) -> usize {
    std::fs::read_dir(dir.join(".tessela/cache"))
        .map(|d| {
            d.flatten()
                .filter(|e| e.path().extension().is_some_and(|x| x == "bin"))
                .count()
        })
        .unwrap_or(0)
}

/// Loads twice, so the second answer comes from the cache, and checks both against a load that
/// has no cache.
fn same_from_cache(dir: &Path) -> Bundle {
    let fresh = format!("{:?}", Bundle::load_sequential(dir).unwrap());
    let first = Bundle::load(dir).unwrap();
    assert_eq!(format!("{first:?}"), fresh);
    let second = Bundle::load(dir).unwrap();
    assert_eq!(format!("{second:?}"), fresh);
    second
}

#[test]
fn every_kind_of_yaml_value_comes_back_from_the_cache_as_it_went_in() {
    let dir = scratch();
    let front = "\
---
type: concept
title: \"Quoted: #x\"
count: 42
negative: -7
huge: 18446744073709551615
ratio: 0.25
exp: 1.5e300
inf: .inf
nan: .nan
yes: true
nothing: ~
empty:
date: 2026-11-28
tags: [x, y/z]
nested:
  list: [1, two, 3.5, null, [a, b]]
  map: {k: v, 1: one, true: yes}
? [complex, key]
: value
tagged: !Thing value
tagged_map: !Other {a: 1}
anchor: &a [1, 2]
alias: *a
multi: |
  line one
  line two
unicode: \"日本語 😀 é\"
---

# Body #x
";
    write_old(&dir, "a.md", front, 1_700_000_000);
    write_old(
        &dir,
        "b.md",
        "---\nnot: [closed\n---\n\n# Broken\n",
        1_700_000_000,
    );
    write_old(&dir, "c.md", "---\n- a\n- list\n---\n", 1_700_000_000);
    write_old(&dir, "d.md", "---\nunterminated: yes\n", 1_700_000_000);
    write_old(&dir, "e.md", "no frontmatter\n", 1_700_000_000);
    let bundle = same_from_cache(&dir);
    assert_eq!(bundle.pages.len(), 5);
    let a = &bundle.pages[0];
    assert_eq!(
        a.frontmatter_error, None,
        "the values below were read, not rejected"
    );
    assert!(a.frontmatter.len() >= 18, "{:?}", a.frontmatter);
    assert!(format!("{:?}", a.frontmatter).contains("!Thing"));
    assert_eq!(entries(&dir), 5);
}

#[test]
fn a_file_changed_right_after_it_was_cached_is_read_again() {
    // The clock ticks in steps of a few milliseconds, so a second write can have the same
    // modification time as the first, and the same size. A file that new is not cached.
    let dir = scratch();
    let file = dir.join("a.md");
    std::fs::write(&file, "# One\n").unwrap();
    let stamp = std::fs::metadata(&file).unwrap().modified().unwrap();
    assert_eq!(Bundle::load(&dir).unwrap().pages[0].title(), "One");
    assert_eq!(entries(&dir), 0, "a file this new is not cached");

    std::fs::write(&file, "# Two\n").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&file)
        .unwrap()
        .set_modified(stamp)
        .unwrap();
    assert_eq!(Bundle::load(&dir).unwrap().pages[0].title(), "Two");
}

#[test]
fn an_old_file_is_cached_and_a_change_to_it_shows() {
    let dir = scratch();
    write_old(&dir, "a.md", "# One\n", 1_700_000_000);
    assert_eq!(Bundle::load(&dir).unwrap().pages[0].title(), "One");
    assert_eq!(entries(&dir), 1);
    write_old(&dir, "a.md", "# Two\n", 1_700_000_100);
    assert_eq!(Bundle::load(&dir).unwrap().pages[0].title(), "Two");
    // Same size, new time: still seen.
    write_old(&dir, "a.md", "# Tre\n", 1_700_000_200);
    assert_eq!(Bundle::load(&dir).unwrap().pages[0].title(), "Tre");
}

#[test]
fn the_cache_folder_ignores_itself_and_is_not_part_of_the_bundle() {
    let dir = scratch();
    write_old(&dir, "a.md", "# One\n", 1_700_000_000);
    Bundle::load(&dir).unwrap();
    let ignore = std::fs::read_to_string(dir.join(".tessela/cache/.gitignore")).unwrap();
    assert_eq!(ignore.trim(), "*");
    // Markdown inside `.tessela/` is not a page, even if a cache file were named like one.
    std::fs::write(dir.join(".tessela/cache/x.md"), "# not a page\n").unwrap();
    assert_eq!(Bundle::load(&dir).unwrap().pages.len(), 1);
}

#[test]
fn entries_of_pages_that_are_gone_are_swept_at_the_next_change() {
    let dir = scratch();
    for i in 0..5 {
        write_old(
            &dir,
            &format!("p{i}.md"),
            &format!("# P{i}\n"),
            1_700_000_000,
        );
    }
    Bundle::load(&dir).unwrap();
    assert_eq!(entries(&dir), 5);
    std::fs::remove_file(dir.join("p0.md")).unwrap();
    std::fs::remove_file(dir.join("p1.md")).unwrap();
    Bundle::load(&dir).unwrap();
    assert_eq!(
        entries(&dir),
        5,
        "a call that changes nothing leaves the folder alone"
    );
    write_old(&dir, "p2.md", "# Changed\n", 1_700_000_500);
    Bundle::load(&dir).unwrap();
    assert_eq!(entries(&dir), 3, "the next change sweeps");
}

#[test]
fn a_bundle_that_cannot_be_written_to_still_loads() {
    let dir = scratch();
    write_old(&dir, "a.md", "# One\n", 1_700_000_000);
    // A file where the folder should be: the cache cannot be made, and nothing complains.
    std::fs::write(dir.join(".tessela"), "in the way").unwrap();
    assert_eq!(Bundle::load(&dir).unwrap().pages[0].title(), "One");
    assert_eq!(Bundle::load(&dir).unwrap().pages[0].title(), "One");
}

#[test]
fn every_page_of_a_first_parallel_load_is_cached() {
    // The first writes all find no cache folder at once; each one must still end up on disk.
    for round in 0..600 {
        let dir = scratch();
        for i in 0..80 {
            write_old(
                &dir,
                &format!("p{i}.md"),
                &format!("# Page {i}\n"),
                1_700_000_000,
            );
        }
        Bundle::load(&dir).unwrap();
        assert_eq!(entries(&dir), 80, "round {round}");
    }
}
