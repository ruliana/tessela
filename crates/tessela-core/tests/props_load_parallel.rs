//! `Bundle::load` reads on every core; `Bundle::load_sequential` is its reference. The two have
//! to agree on everything: the pages, their order, and the files that could not be read.

mod support;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use proptest::prelude::*;
use support::{bundle_files, config};
use tessela_core::Bundle;

fn scratch() -> PathBuf {
    static N: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "tessela-load-parallel-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

proptest! {
    #![proptest_config(config(40))]

    // `filler` pushes some bundles past the size where `load` starts using several threads.
    #[test]
    fn the_parallel_load_equals_the_sequential_one(
        files in bundle_files(),
        filler in prop_oneof![Just(0usize), 100usize..180],
        broken in proptest::collection::vec(0usize..200, 0..4),
    ) {
        let dir = scratch();
        for (path, text) in &files {
            let file = dir.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, text).unwrap();
        }
        for i in 0..filler {
            let path = dir.join(format!("filler/{}/f{i}.md", i % 7));
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, format!("# Filler {i}\n\n- see [x](../../x.md) #t{}\n", i % 5)).unwrap();
        }
        for i in broken {
            std::fs::write(dir.join(format!("bad-{i}.md")), [0xff, 0xfe, b'\n']).unwrap();
        }
        std::fs::write(dir.join("index.md"), "# index\n").unwrap();
        std::fs::create_dir_all(dir.join(".hidden")).unwrap();
        std::fs::write(dir.join(".hidden/x.md"), "# hidden\n").unwrap();

        let (parallel, sequential) = (Bundle::load(&dir).unwrap(), Bundle::load_sequential(&dir).unwrap());
        let paths: Vec<_> = parallel.pages.iter().map(|p| p.path.clone()).collect();
        let mut sorted = paths.clone();
        sorted.sort();
        prop_assert_eq!(&paths, &sorted, "pages are sorted by path");
        prop_assert_eq!(format!("{parallel:?}"), format!("{sequential:?}"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[test]
fn a_root_that_is_not_a_folder_is_an_error_either_way() {
    let dir = scratch();
    std::fs::write(dir.join("f.md"), "x\n").unwrap();
    assert!(Bundle::load(dir.join("f.md")).is_err());
    assert!(Bundle::load_sequential(dir.join("f.md")).is_err());
}
