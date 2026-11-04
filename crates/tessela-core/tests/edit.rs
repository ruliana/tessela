use std::path::{Path, PathBuf};

use tessela_core::edit::{
    ErrorCode, Expect, FsStore, add_page, content_hash, move_page, patch_page, read_page,
    remove_page, save_page,
};
use tessela_core::{Bundle, Linter, Severity};

fn bundle(name: &str, files: &[(&str, &str)]) -> (PathBuf, FsStore) {
    let dir = std::env::temp_dir().join(format!("tessela-edit-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    for (path, text) in files {
        let file = dir.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text).unwrap();
    }
    std::fs::create_dir_all(&dir).unwrap();
    let store = FsStore::new(&dir).unwrap();
    (dir, store)
}

fn text(dir: &Path, path: &str) -> String {
    std::fs::read_to_string(dir.join(path)).unwrap()
}

fn problems(dir: &Path) -> Vec<String> {
    let bundle = Bundle::load(dir).unwrap();
    Linter::default()
        .run(&bundle)
        .into_iter()
        .filter(|d| d.severity >= Severity::Warning)
        .map(|d| format!("{}: {}", d.path, d.message))
        .collect()
}

const NOTE: &str = "---\ntype: concept\ntitle: \"Note\"\n---\n\nOne\n\nTwo\n";

#[test]
fn read_gives_the_hash_and_a_template_for_a_missing_page() {
    let (_, store) = bundle("read", &[("note.md", NOTE)]);
    let page = read_page(&store, "note.md").unwrap();
    assert_eq!(page.hash.as_deref(), Some(content_hash(NOTE).as_str()));
    assert!(page.exists && page.text == NOTE);
    let missing = read_page(&store, "new/page.md").unwrap();
    assert!(!missing.exists && missing.hash.is_none());
    assert!(missing.text.contains("type: concept"));
    assert!(read_page(&store, "../x.md").is_err());
}

#[test]
fn save_replaces_only_when_the_hash_still_matches() {
    let (dir, store) = bundle("save", &[("note.md", NOTE)]);
    let hash = content_hash(NOTE);
    let saved = save_page(&store, "note.md", "mine\n", &Expect::Hash(hash.clone())).unwrap();
    assert_eq!(saved.hash, content_hash("mine\n"));
    assert!(!saved.created);
    assert_eq!(text(&dir, "note.md"), "mine\n");

    // The same hash again is stale now.
    let err = save_page(&store, "note.md", "late\n", &Expect::Hash(hash)).unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    assert_eq!(err.disk_hash, Some(Some(content_hash("mine\n"))));
    assert_eq!(text(&dir, "note.md"), "mine\n");

    // A page that appeared meanwhile is a conflict for a caller that thought it was new.
    let err = save_page(&store, "note.md", "x", &Expect::Absent).unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    // And a page that vanished is one for a caller that had a hash.
    let err = save_page(&store, "gone.md", "x", &Expect::Hash("abc".into())).unwrap_err();
    assert_eq!((err.code, err.disk_hash), (ErrorCode::Conflict, Some(None)));
}

#[test]
fn save_creates_folders_and_leaves_no_temporary_files() {
    let (dir, store) = bundle("create", &[]);
    let saved = save_page(&store, "a/b/c.md", "hi\n", &Expect::Absent).unwrap();
    assert!(saved.created);
    assert_eq!(text(&dir, "a/b/c.md"), "hi\n");
    let leftovers: Vec<_> = walk(&dir)
        .into_iter()
        .filter(|p| p.ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

fn walk(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            out.extend(walk(&path));
        } else {
            out.push(path.to_string_lossy().into_owned());
        }
    }
    out
}

#[test]
fn saving_what_is_already_there_writes_nothing() {
    let (dir, store) = bundle("same", &[("note.md", NOTE)]);
    let before = std::fs::metadata(dir.join("note.md"))
        .unwrap()
        .modified()
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    save_page(&store, "note.md", NOTE, &Expect::Hash(content_hash(NOTE))).unwrap();
    assert_eq!(
        std::fs::metadata(dir.join("note.md"))
            .unwrap()
            .modified()
            .unwrap(),
        before
    );
}

#[test]
fn patches_apply_exactly_and_are_guarded_by_the_hash() {
    let (dir, store) = bundle("patch", &[("note.md", NOTE)]);
    let hash = Expect::Hash(content_hash(NOTE));
    let changed = NOTE.replace("Two", "Two, changed");
    let patch = diffy::create_patch(NOTE, &changed).to_string();
    let saved = patch_page(&store, "note.md", &patch, &hash).unwrap();
    assert_eq!(text(&dir, "note.md"), changed);
    assert_eq!(saved.hash, content_hash(&changed));

    // The same patch on a page that moved on is refused without touching it.
    let err = patch_page(&store, "note.md", &patch, &hash).unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);

    // A patch that does not fit the text is refused too.
    let err = patch_page(
        &store,
        "note.md",
        "--- a\n+++ b\n@@ -1,2 +1,2 @@\n-nothing like it\n+x\n context\n",
        &Expect::Hash(content_hash(&changed)),
    )
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidPatch);
    assert_eq!(text(&dir, "note.md"), changed);
}

#[test]
fn patches_in_the_shape_git_prints_them_apply() {
    let (dir, store) = bundle("gitpatch", &[("note.md", NOTE)]);
    let changed = NOTE.replace("One", "Uno");
    let diff = diffy::create_patch(NOTE, &changed).to_string();
    let git = format!("diff --git a/note.md b/note.md\nindex 123..456 100644\n{diff}");
    patch_page(&store, "note.md", &git, &Expect::Hash(content_hash(NOTE))).unwrap();
    assert_eq!(text(&dir, "note.md"), changed);
}

#[test]
fn a_patch_can_create_a_page() {
    let (dir, store) = bundle("patchnew", &[]);
    let patch = diffy::create_patch("", "---\ntype: concept\n---\n\nHi\n").to_string();
    patch_page(&store, "x.md", &patch, &Expect::Absent).unwrap();
    assert!(text(&dir, "x.md").ends_with("Hi\n"));
}

#[test]
fn add_creates_from_the_template_and_refuses_to_overwrite() {
    let (dir, store) = bundle("add", &[("note.md", NOTE)]);
    let saved = add_page(&store, "project/new-idea.md", Some("New Idea"), None, None).unwrap();
    assert!(saved.created);
    assert_eq!(
        text(&dir, "project/new-idea.md"),
        "---\ntype: concept\ntitle: \"New Idea\"\n---\n\n"
    );
    assert_eq!(
        add_page(&store, "note.md", None, None, None)
            .unwrap_err()
            .code,
        ErrorCode::Exists
    );
    assert!(add_page(&store, "index.md", None, None, None).is_err());
    add_page(&store, "journals/2026-11-04.md", None, None, None).unwrap();
    assert!(problems(&dir).is_empty(), "{:?}", problems(&dir));
}

#[test]
fn remove_checks_the_hash_and_reports_who_still_mentions_it() {
    let (dir, store) = bundle(
        "remove",
        &[
            ("note.md", NOTE),
            (
                "other.md",
                "---\ntype: concept\n---\n\nSee [note](/note.md) and #note\n",
            ),
        ],
    );
    let err = remove_page(&store, "note.md", "0000").unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    assert!(dir.join("note.md").exists());
    let removed = remove_page(&store, "note.md", &content_hash(NOTE)).unwrap();
    assert_eq!(removed.mentioned_by, ["other.md"]);
    assert!(!dir.join("note.md").exists());
    assert_eq!(
        remove_page(&store, "note.md", "x").unwrap_err().code,
        ErrorCode::NotFound
    );
}

fn project() -> Vec<(&'static str, &'static str)> {
    vec![
        (
            "ai/llm.md",
            "---\ntype: concept\ntitle: \"LLM\"\ntags: [ai/llm]\n---\n\nAbout #ai/llm. See [other](./other.md), ![pic](pic.png) and [up](../top.md).\n",
        ),
        (
            "ai/other.md",
            "---\ntype: concept\n---\n\nBack to [LLMs](/ai/llm.md#x) and #ai/llm and [llm](llm.md).\n",
        ),
        (
            "top.md",
            "---\ntype: concept\n---\n\n- [a](ai/llm.md)\n  - nested #ai/llm\n",
        ),
        (
            "journals/2026-11-04.md",
            "---\ntype: journal\ntitle: \"2026-11-04\"\ndate: \"2026-11-04\"\n---\n\n- [llm](../ai/llm.md) with `#ai/llm` kept\n",
        ),
    ]
}

#[test]
fn rename_rewrites_tags_and_links_everywhere_and_the_bundle_still_lints() {
    let (dir, store) = bundle("rename", &project());
    assert!(problems(&dir).is_empty(), "{:?}", problems(&dir));
    let moved = move_page(&store, "ai/llm.md", "ai/models.md", None, false).unwrap();
    assert!(moved.warnings.is_empty(), "{:?}", moved.warnings);
    assert!(!dir.join("ai/llm.md").exists());
    assert_eq!(
        text(&dir, "ai/models.md"),
        "---\ntype: concept\ntitle: \"LLM\"\ntags: [ai/models]\n---\n\nAbout #ai/models. See [other](./other.md), ![pic](pic.png) and [up](../top.md).\n"
    );
    assert_eq!(
        text(&dir, "ai/other.md"),
        "---\ntype: concept\n---\n\nBack to [LLMs](/ai/models.md#x) and #ai/models and [llm](models.md).\n"
    );
    assert_eq!(
        text(&dir, "top.md"),
        "---\ntype: concept\n---\n\n- [a](ai/models.md)\n  - nested #ai/models\n"
    );
    assert!(
        text(&dir, "journals/2026-11-04.md").contains("[llm](../ai/models.md) with `#ai/llm` kept")
    );
    assert!(problems(&dir).is_empty(), "{:?}", problems(&dir));
    // Nothing mentions the old name any more, except the code span that was left alone.
    assert!(
        tessela_core::edit::pages_mentioning(&store, "ai/llm.md")
            .unwrap()
            .is_empty()
    );
}

#[test]
fn moving_to_another_folder_keeps_the_page_reaching_what_it_linked_to() {
    let (dir, store) = bundle("move", &project());
    move_page(&store, "ai/llm.md", "archive/llm.md", None, false).unwrap();
    assert_eq!(
        text(&dir, "archive/llm.md"),
        "---\ntype: concept\ntitle: \"LLM\"\ntags: [archive/llm]\n---\n\nAbout #archive/llm. See [other](../ai/other.md), ![pic](../ai/pic.png) and [up](../top.md).\n"
    );
    assert!(text(&dir, "ai/other.md").contains("[llm](../archive/llm.md)"));
    assert!(text(&dir, "ai/other.md").contains("[LLMs](/archive/llm.md#x)"));
    assert!(problems(&dir).is_empty(), "{:?}", problems(&dir));
}

#[test]
fn a_dry_run_changes_nothing_and_a_clash_is_refused() {
    let (dir, store) = bundle("dry", &project());
    let before = text(&dir, "ai/other.md");
    let plan = move_page(&store, "ai/llm.md", "ai/models.md", None, true).unwrap();
    assert!(plan.dry_run);
    assert_eq!(plan.updated.len(), 4);
    assert_eq!(text(&dir, "ai/other.md"), before);
    assert!(dir.join("ai/llm.md").exists() && !dir.join("ai/models.md").exists());

    let err = move_page(&store, "ai/llm.md", "ai/other.md", None, false).unwrap_err();
    assert_eq!(err.code, ErrorCode::Exists);
    // Case and spacing do not make a different page (spec §4).
    let err = move_page(&store, "ai/llm.md", "AI/Other.md", None, false).unwrap_err();
    assert_eq!(err.code, ErrorCode::Exists);
    let err = move_page(&store, "ai/llm.md", "ai/x.md", Some("stale"), false).unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    assert_eq!(
        move_page(&store, "nope.md", "x.md", None, false)
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    assert!(dir.join("ai/llm.md").exists());
}
