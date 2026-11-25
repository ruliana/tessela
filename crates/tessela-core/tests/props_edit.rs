//! Property tests for editing a bundle on disk: saving, patching, paths, and moving a page
//! (which rewrites every page that names it), including a run that is interrupted half way.

mod support;

use std::cell::Cell;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use proptest::prelude::*;
use support::{bundle_files, config, markdown, page_path, refs_of};
use tessela_core::edit::{
    EditError, ErrorCode, Expect, FsStore, PageStore, add_page, check_page_path, content_hash,
    move_page, move_target, patch_page, path_from_name, read_page, remove_page, rename_target,
    save_page,
};
use tessela_core::refs::normalize_concept;
use tessela_core::{Bundle, HitKind, Linter, Query, Severity};

/// A folder for one case, removed when it is dropped.
struct Sandbox {
    base: PathBuf,
    root: PathBuf,
}

impl Sandbox {
    fn new() -> Sandbox {
        static N: AtomicUsize = AtomicUsize::new(0);
        let base = std::env::temp_dir().join(format!(
            "tessela-props-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("bundle");
        std::fs::create_dir_all(&root).unwrap();
        Sandbox { base, root }
    }

    fn with(files: &[(String, String)]) -> Sandbox {
        let sandbox = Sandbox::new();
        for (path, text) in files {
            let file = sandbox.root.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, text).unwrap();
        }
        sandbox
    }

    fn store(&self) -> FsStore {
        FsStore::new(&self.root).unwrap()
    }

    fn file(&self, path: &str) -> Option<String> {
        self.snapshot().remove(path)
    }

    /// Every file under the bundle, hidden ones too, with its text.
    fn snapshot(&self) -> BTreeMap<String, String> {
        let mut found = BTreeMap::new();
        walk(&self.root, &self.root, &mut found);
        found
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            walk(root, &path, out);
        } else {
            let rel = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            out.insert(
                rel,
                String::from_utf8_lossy(&std::fs::read(&path).unwrap()).into_owned(),
            );
        }
    }
}

fn texts(files: &[(String, String)]) -> BTreeMap<String, String> {
    files.iter().cloned().collect()
}

/// The pages the linter has something to say about, at warning level or worse.
fn problems(dir: &Path) -> usize {
    let bundle = Bundle::load(dir).unwrap();
    Linter::default()
        .run(&bundle)
        .iter()
        .filter(|d| d.severity >= Severity::Warning)
        .count()
}

proptest! {
    #![proptest_config(config(200))]

    // --- saving -----------------------------------------------------------------------

    #[test]
    fn what_is_saved_is_what_is_read(first in any::<String>(), second in any::<String>()) {
        let sandbox = Sandbox::new();
        let store = sandbox.store();
        let saved = save_page(&store, "n/p.md", &first, &Expect::Absent).unwrap();
        prop_assert!(saved.created);
        let page = read_page(&store, "n/p.md").unwrap();
        prop_assert_eq!(&page.text, &first);
        prop_assert_eq!(page.hash.as_deref(), Some(saved.hash.as_str()));
        prop_assert_eq!(&saved.hash, &content_hash(&first));

        // The hash is the guard: a stale one is refused and nothing changes.
        let stale = save_page(&store, "n/p.md", &second, &Expect::Hash("0".repeat(64)));
        prop_assert_eq!(stale.unwrap_err().code, ErrorCode::Conflict);
        let again = save_page(&store, "n/p.md", &second, &Expect::Absent);
        prop_assert_eq!(again.unwrap_err().code, ErrorCode::Conflict);
        prop_assert_eq!(sandbox.file("n/p.md"), Some(first.clone()));

        let next = save_page(&store, "n/p.md", &second, &Expect::Hash(saved.hash)).unwrap();
        prop_assert!(!next.created);
        prop_assert_eq!(sandbox.file("n/p.md"), Some(second.clone()));
        // Saving the same text again is a no-op, and no temporary file stays behind.
        save_page(&store, "n/p.md", &second, &Expect::Hash(next.hash)).unwrap();
        prop_assert_eq!(sandbox.snapshot().into_keys().collect::<Vec<_>>(), vec!["n/p.md".to_string()]);
    }

    #[test]
    fn a_diff_applies_to_exactly_the_text_it_was_made_for(
        old in markdown(),
        new in markdown(),
        end_old in prop::bool::ANY,
        end_new in prop::bool::ANY,
    ) {
        let old = if end_old { format!("{old}\n") } else { old };
        let new = if end_new { format!("{new}\n") } else { new };
        let sandbox = Sandbox::with(&[("p.md".into(), old.clone())]);
        let store = sandbox.store();
        let patch = diffy::create_patch(&old, &new).to_string();
        let saved = patch_page(&store, "p.md", &patch, &Expect::Hash(content_hash(&old))).unwrap();
        prop_assert_eq!(sandbox.file("p.md"), Some(new.clone()));
        prop_assert_eq!(saved.hash, content_hash(&new));
    }

    #[test]
    fn a_bad_patch_changes_nothing(old in markdown(), patch in "[ -~\n@+-]{0,200}") {
        let sandbox = Sandbox::with(&[("p.md".into(), old.clone())]);
        let result = patch_page(&sandbox.store(), "p.md", &patch, &Expect::Hash(content_hash(&old)));
        if result.is_err() {
            prop_assert_eq!(sandbox.file("p.md"), Some(old.clone()));
        }
        prop_assert_eq!(sandbox.snapshot().len(), 1);
    }

    // --- paths ------------------------------------------------------------------------

    #[test]
    fn no_path_writes_outside_the_bundle(path in prop_oneof![
        any::<String>(),
        "[a-c./\\\\ ~%\u{0}-]{0,14}",
        proptest::collection::vec(proptest::sample::select(&["..", ".", "a", ".hid", "b.md", "", "x.md"][..]), 1..5)
            .prop_map(|p| p.join("/")),
    ]) {
        let sandbox = Sandbox::new();
        let store = sandbox.store();
        let result = save_page(&store, &path, "text\n", &Expect::Absent);
        let outside: Vec<_> = std::fs::read_dir(&sandbox.base).unwrap().map(|e| e.unwrap().file_name()).collect();
        prop_assert_eq!(outside.len(), 1, "something was created beside the bundle: {:?}", outside);
        match result {
            Ok(_) => {
                prop_assert!(check_page_path(&path).is_ok());
                prop_assert_eq!(sandbox.file(&path), Some("text\n".to_string()));
                prop_assert!(!path.split('/').any(|p| p.starts_with('.') || p.is_empty()));
            }
            Err(e) => {
                prop_assert!(sandbox.snapshot().is_empty(), "{e}");
            }
        }
    }

    #[test]
    fn names_become_stable_paths(name in prop_oneof![any::<String>(), "[A-Za-z /#.()-]{0,16}"]) {
        if let Ok(path) = path_from_name(&name) {
            prop_assert!(check_page_path(&path).is_ok(), "{path}");
            prop_assert_eq!(path_from_name(&path).unwrap(), path.clone());
            prop_assert_eq!(normalize_concept(path.trim_end_matches(".md")), path.trim_end_matches(".md"));
            // A rename or a move to that name lands on a valid path too.
            if let Ok(target) = rename_target("a/b/old.md", &name) {
                prop_assert!(check_page_path(&target).is_ok() && target.starts_with("a/b/"));
            }
            if let Ok(target) = move_target("a/old.md", &name) {
                prop_assert!(check_page_path(&target).is_ok());
            }
        }
    }

    // --- adding and removing ----------------------------------------------------------

    #[test]
    fn a_page_is_added_once_and_removal_names_who_mentions_it(files in bundle_files(), path in page_path()) {
        let sandbox = Sandbox::with(&files);
        let store = sandbox.store();
        let exists = texts(&files).contains_key(&path);
        let added = add_page(&store, &path, None, None, None);
        prop_assert_eq!(added.is_err(), exists);
        let hash = content_hash(sandbox.snapshot().get(&path).unwrap());
        let wrong = remove_page(&store, &path, "not-the-hash").unwrap_err();
        prop_assert_eq!(wrong.code, ErrorCode::Conflict);
        prop_assert!(sandbox.snapshot().contains_key(&path));

        let concept = normalize_concept(path.trim_end_matches(".md"));
        let removed = remove_page(&store, &path, &hash).unwrap();
        prop_assert!(!sandbox.snapshot().contains_key(&path));
        let mut expected: Vec<String> = sandbox
            .snapshot()
            .iter()
            .filter(|(p, t)| **p != path && refs_of(p, t).contains(&concept))
            .map(|(p, _)| p.clone())
            .collect();
        let mut got = removed.mentioned_by;
        expected.sort();
        got.sort();
        prop_assert_eq!(got, expected);
    }

    // --- backlinks --------------------------------------------------------------------

    #[test]
    fn a_query_for_a_concept_finds_every_block_that_has_it(files in bundle_files()) {
        let sandbox = Sandbox::with(&files);
        let bundle = Bundle::load(&sandbox.root).unwrap();
        for concept in ["x", "y", "a/x", "w-z"] {
            let hits = Query { refs: vec![concept.into()], ..Query::default() }.run(&bundle);
            // A concept also matches the ones below it: `x` finds `x/word`.
            let named = |r: &String| r == concept || r.starts_with(&format!("{concept}/"));
            let expected: usize = bundle
                .pages
                .iter()
                .filter(|p| !p.is_template())
                .map(|p| p.blocks.iter().filter(|b| b.path_refs.iter().any(named)).count())
                .sum();
            let blocks = hits.iter().filter(|h| h.kind == HitKind::Block).count();
            prop_assert_eq!(blocks, expected, "{}", concept);
            for hit in hits.iter().filter(|h| h.kind != HitKind::Page) {
                prop_assert!(hit.path_refs.iter().any(named), "{:?}", hit);
            }
        }
        // The same bundle always lints the same, and lint never panics on it.
        let ds = Linter::default().run(&bundle);
        prop_assert_eq!(ds.len(), Linter::default().run(&bundle).len());
    }
}

proptest! {
    #![proptest_config(config(150))]

    // --- moving a page ----------------------------------------------------------------

    #[test]
    fn a_move_keeps_every_reference_pointing_at_the_same_pages(
        files in bundle_files(),
        pick in any::<prop::sample::Index>(),
        to in page_path(),
    ) {
        let from = files[pick.index(files.len())].0.clone();
        let sandbox = Sandbox::with(&files);
        let before = sandbox.snapshot();
        let problems_before = problems(&sandbox.root);
        let store = sandbox.store();
        let dry = move_page(&store, &from, &to, None, true);
        prop_assert_eq!(&sandbox.snapshot(), &before, "a dry run wrote something");

        let result = move_page(&store, &from, &to, None, false);
        if from == to || before.contains_key(&to) {
            prop_assert!(result.is_err());
            prop_assert_eq!(&sandbox.snapshot(), &before, "a refused move changed something");
            return Ok(());
        }
        let moved = result.unwrap();
        let dry = dry.unwrap();
        prop_assert_eq!(
            dry.updated.iter().map(|u| (u.path.clone(), u.links, u.tags)).collect::<Vec<_>>(),
            moved.updated.iter().map(|u| (u.path.clone(), u.links, u.tags)).collect::<Vec<_>>(),
            "the dry run said something else"
        );
        let after = sandbox.snapshot();
        prop_assert!(!after.contains_key(&from));
        prop_assert!(after.contains_key(&to));
        prop_assert_eq!(after.len(), before.len(), "pages were lost or made");
        prop_assert_eq!(moved.hash, content_hash(&after[&to]));

        let old = normalize_concept(from.trim_end_matches(".md"));
        let new = normalize_concept(to.trim_end_matches(".md"));
        let rename = |refs: std::collections::BTreeSet<String>| -> std::collections::BTreeSet<String> {
            refs.into_iter().map(|r| if r == old { new.clone() } else { r }).collect()
        };
        for (path, text) in &before {
            let now_path = if *path == from { &to } else { path };
            let now = &after[now_path];
            let expected = rename(refs_of(path, text));
            let got = refs_of(now_path, now);
            if moved.warnings.is_empty() {
                prop_assert_eq!(&got, &expected, "{} changed what it points at:\n{:?}\nbecame\n{:?}", path, text, now);
            }
            // Pages the move had nothing to do with stay as they were, byte for byte.
            let touched = moved.updated.iter().any(|u| u.path == *now_path);
            if !touched {
                prop_assert_eq!(now, text, "{} was rewritten without being reported", path);
            }
        }
        if moved.warnings.is_empty() {
            prop_assert_eq!(problems(&sandbox.root), problems_before, "the move changed what lint finds");
        }
    }

    #[test]
    fn a_move_and_the_move_back_restore_every_reference(
        files in bundle_files(),
        pick in any::<prop::sample::Index>(),
        to in proptest::sample::select(&["q.md", "a/q.md", "b/q.md", "a/c/q.md"][..]),
    ) {
        // The new name is one no page or tag uses: moving onto a concept that is already
        // mentioned merges the mentions, and moving back cannot tell them apart.
        let from = files[pick.index(files.len())].0.clone();
        let sandbox = Sandbox::with(&files);
        let store = sandbox.store();
        let first = move_page(&store, &from, to, None, false).unwrap();
        let back = move_page(&store, to, &from, None, false).unwrap();
        if first.warnings.is_empty() && back.warnings.is_empty() {
            let after = sandbox.snapshot();
            for (path, text) in texts(&files) {
                prop_assert_eq!(refs_of(&path, &after[&path]), refs_of(&path, &text), "{}", path);
            }
        }
    }
}

// --- a move that is interrupted -----------------------------------------------------------

/// A store that stops working at its n-th change, like a process killed at that point: that
/// change and every later one fail and do nothing.
struct Dying {
    inner: FsStore,
    survive: Cell<usize>,
}

impl Dying {
    fn step(&self) -> Result<(), EditError> {
        match self.survive.get() {
            0 => Err(EditError::new(ErrorCode::Io, "the process died here")),
            n => {
                self.survive.set(n - 1);
                Ok(())
            }
        }
    }
}

impl PageStore for Dying {
    fn list(&self) -> Result<Vec<String>, EditError> {
        self.inner.list()
    }
    fn read(&self, path: &str) -> Result<Option<String>, EditError> {
        self.inner.read(path)
    }
    fn write(&self, path: &str, text: &str, expect: &Expect) -> Result<(), EditError> {
        self.step()?;
        self.inner.write(path, text, expect)
    }
    fn delete(&self, path: &str, expect_hash: &str) -> Result<(), EditError> {
        self.step()?;
        self.inner.delete(path, expect_hash)
    }
    fn write_asset(&self, path: &str, bytes: &[u8]) -> Result<bool, EditError> {
        self.step()?;
        self.inner.write_asset(path, bytes)
    }
}

proptest! {
    #![proptest_config(config(60))]

    /// Kill the move after each of its changes. No page may be lost or half written, and
    /// running the same move again must end where an uninterrupted one does.
    #[test]
    fn a_move_that_dies_half_way_loses_nothing_and_can_be_repeated(
        files in bundle_files(),
        pick in any::<prop::sample::Index>(),
        to in page_path(),
    ) {
        let from = files[pick.index(files.len())].0.clone();
        prop_assume!(from != to && !texts(&files).contains_key(&to));

        let clean = Sandbox::with(&files);
        move_page(&clean.store(), &from, &to, None, false).unwrap();
        let wanted = clean.snapshot();

        for survive in 0..=files.len() + 1 {
            let sandbox = Sandbox::with(&files);
            let dying = Dying { inner: sandbox.store(), survive: Cell::new(survive) };
            let died = move_page(&dying, &from, &to, None, false).is_err();
            let mid = sandbox.snapshot();
            // Nothing lost: the moved page is at one of its two paths, whole, and every other
            // page is either as it was or as the move leaves it.
            prop_assert!(mid.contains_key(&from) || mid.contains_key(&to), "the page is gone");
            for (path, text) in &mid {
                let original = texts(&files).get(path).cloned();
                let finished = wanted.get(path);
                prop_assert!(
                    original.as_ref() == Some(text) || finished == Some(text),
                    "{} is neither as it was nor as it should end:\n{:?}", path, text
                );
            }
            prop_assert!(mid.keys().all(|p| !p.contains(".tmp")), "a temporary file stayed: {:?}", mid.keys());
            if died {
                let again = move_page(&sandbox.store(), &from, &to, None, false);
                prop_assert!(again.is_ok(), "running the move again failed after dying at step {}: {:?}", survive, again.err());
                prop_assert_eq!(sandbox.snapshot(), wanted.clone(), "dying at step {}", survive);
            }
        }
    }
}
