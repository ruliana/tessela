//! The parse cache in `.tessela/cache/` must never change an answer: whatever happens to the
//! files and to the cache folder, `Bundle::load` equals `Bundle::load_sequential`, which
//! never looks at the cache. It must also be a cache: a call parses exactly the pages that
//! changed since the last one.
//!
//! This file holds a single test on purpose. It counts parsed pages with a process-wide
//! counter, and a second test running beside it would add to the count.

mod support;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use proptest::prelude::*;
use support::{config, page_path, page_text};
use tessela_core::Bundle;
use tessela_core::page::parsed_pages;

#[derive(Debug, Clone)]
enum Op {
    /// Write a page (new, or replacing the old one).
    Write(String, String),
    Delete(String),
    /// Move a page to another path, keeping its modification time.
    Rename(String, String),
    /// Change the modification time and nothing else.
    Touch(String),
    /// Remove `.tessela/` altogether.
    WipeCache,
    /// Damage every cache file: cut it short, scribble in it, or make it another build's.
    Damage(Damage),
    /// A call that loads the bundle.
    Load,
}

#[derive(Debug, Clone, Copy)]
enum Damage {
    Truncate,
    FlipByte,
    OtherBuild,
    Empty,
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        6 => (page_path(), page_text()).prop_map(|(p, t)| Op::Write(p, t)),
        2 => page_path().prop_map(Op::Delete),
        2 => (page_path(), page_path()).prop_map(|(a, b)| Op::Rename(a, b)),
        2 => page_path().prop_map(Op::Touch),
        1 => Just(Op::WipeCache),
        1 => proptest::sample::select(vec![
            Damage::Truncate,
            Damage::FlipByte,
            Damage::OtherBuild,
            Damage::Empty,
        ])
        .prop_map(Op::Damage),
        8 => Just(Op::Load),
    ]
}

fn scratch() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tessela-cache-props-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Every call gets a new modification time, far enough in the past for the cache to trust it.
fn set_mtime(path: &Path, step: u64) {
    let time: SystemTime = UNIX_EPOCH + Duration::from_secs(1_700_000_000 + step);
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(time)
        .unwrap();
}

fn cache_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir.join(".tessela/cache")) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "bin"))
        .collect()
}

fn damage(file: &Path, how: Damage) {
    let mut bytes = std::fs::read(file).unwrap();
    match how {
        Damage::Truncate => bytes.truncate(bytes.len() / 2),
        Damage::FlipByte => {
            let at = bytes.len() / 2;
            bytes[at] ^= 0x55;
        }
        Damage::OtherBuild => bytes[4] ^= 0xff,
        Damage::Empty => bytes.clear(),
    }
    std::fs::write(file, bytes).unwrap();
}

proptest! {
    #![proptest_config(config(60))]

    #[test]
    fn a_cached_load_equals_a_fresh_one_and_parses_only_what_changed(
        ops in proptest::collection::vec(op(), 1..40),
    ) {
        let dir = scratch();
        let mut step = 0u64;
        // The pages that are in the bundle, and those the cache holds a good entry for.
        let mut live: BTreeSet<String> = BTreeSet::new();
        let mut cached: BTreeSet<String> = BTreeSet::new();
        for op in ops {
            step += 1;
            match op {
                Op::Write(path, text) => {
                    let file = dir.join(&path);
                    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
                    std::fs::write(&file, text).unwrap();
                    set_mtime(&file, step);
                    live.insert(path.clone());
                    cached.remove(&path);
                }
                Op::Delete(path) => {
                    let _ = std::fs::remove_file(dir.join(&path));
                    live.remove(&path);
                    cached.remove(&path);
                }
                Op::Rename(from, to) => {
                    if from != to && live.contains(&from) {
                        let target = dir.join(&to);
                        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
                        std::fs::rename(dir.join(&from), &target).unwrap();
                        live.remove(&from);
                        cached.remove(&from);
                        live.insert(to.clone());
                        cached.remove(&to);
                    }
                }
                Op::Touch(path) => {
                    if live.contains(&path) {
                        set_mtime(&dir.join(&path), step);
                        cached.remove(&path);
                    }
                }
                Op::WipeCache => {
                    let _ = std::fs::remove_dir_all(dir.join(".tessela"));
                    cached.clear();
                }
                Op::Damage(how) => {
                    for file in cache_files(&dir) {
                        damage(&file, how);
                    }
                    cached.clear();
                }
                Op::Load => {
                    let before = parsed_pages();
                    let loaded = Bundle::load(&dir).unwrap();
                    let parsed = parsed_pages() - before;
                    let fresh = Bundle::load_sequential(&dir).unwrap();
                    prop_assert_eq!(format!("{loaded:?}"), format!("{fresh:?}"));
                    prop_assert_eq!(
                        parsed,
                        live.difference(&cached).count(),
                        "a call parses the pages without a good entry, and no others"
                    );
                    cached = live.clone();
                    prop_assert!(
                        cache_files(&dir).len() >= live.len(),
                        "every page has an entry after a call"
                    );
                }
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
