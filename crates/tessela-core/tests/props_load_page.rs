//! `Bundle::load_page` is the one-page path of the commands about a single page. It has to
//! give the page the whole-bundle load gives, and nothing where that load lists nothing.

mod support;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use proptest::prelude::*;
use support::{bundle_files, config};
use tessela_core::{Bundle, Page, Structure};

fn scratch() -> PathBuf {
    static N: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "tessela-load-page-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// What a command could tell from a page, in a form that can be compared.
fn seen(page: &Page) -> String {
    format!(
        "{} {:?} {:?} {:?} {:?} {:?}",
        page.path,
        page.modified,
        page.title(),
        page.kind(),
        page.refs,
        Structure::of(page)
    )
}

proptest! {
    #![proptest_config(config(120))]

    #[test]
    fn one_page_equals_the_page_of_the_whole_load(files in bundle_files()) {
        let dir = scratch();
        for (path, text) in &files {
            let file = dir.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, text).unwrap();
        }
        // Files the bundle does not list, and one it cannot read.
        std::fs::write(dir.join("index.md"), "# index\n").unwrap();
        std::fs::write(dir.join("a/log.md"), "# log\n").ok();
        std::fs::create_dir_all(dir.join(".hidden")).unwrap();
        std::fs::write(dir.join(".hidden/x.md"), "# hidden\n").unwrap();
        std::fs::write(dir.join("bad.md"), [0xff, 0xfe, b'\n']).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("x.md"), dir.join("link.md")).unwrap();

        let whole = Bundle::load(&dir).unwrap();
        let mut asked: Vec<String> = files.iter().map(|(p, _)| p.clone()).collect();
        asked.extend(
            ["index.md", "a/log.md", ".hidden/x.md", "bad.md", "link.md", "q.md", "a/q.md", "X.md", "a//x.md", "a/", "x"]
                .map(String::from),
        );
        for path in asked {
            let one = Bundle::load_page(&dir, &path).unwrap();
            let expected = whole.pages.iter().find(|p| p.path == path);
            prop_assert_eq!(
                one.as_ref().map(seen),
                expected.map(seen),
                "page {}", path
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[test]
fn a_root_that_is_not_a_folder_is_an_error() {
    let dir = scratch();
    std::fs::write(dir.join("f.md"), "x\n").unwrap();
    assert!(Bundle::load_page(dir.join("f.md"), "f.md").is_err());
    assert!(Bundle::load_page(dir.join("missing"), "f.md").is_err());
}

#[test]
fn a_folder_named_like_a_page_is_not_a_page() {
    let dir = scratch();
    std::fs::create_dir_all(dir.join("a.md")).unwrap();
    std::fs::write(dir.join("a.md/a.md"), "# inner\n").unwrap();
    assert!(Bundle::load_page(&dir, "a.md").unwrap().is_none());
    assert!(Bundle::load_page(&dir, "a.md/a.md").unwrap().is_some());
}
