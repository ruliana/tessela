//! `tessela attach`: how the editor stores a pasted or dropped picture.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use serde_json::Value;

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n pretend this is a picture";

fn bundle(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tessela-attach-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn tessela(dir: &Path, args: &[&str], stdin: &[u8]) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_tessela"))
        .args(args)
        .args(["--bundle", dir.to_str().unwrap(), "--json", "--api", "2"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(stdin).unwrap();
    child.wait_with_output().unwrap()
}

fn json(out: &Output) -> Value {
    serde_json::from_slice(&out.stdout)
        .unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&out.stdout)))
}

#[test]
fn the_same_picture_for_the_same_page_is_one_file() {
    let dir = bundle("same");
    let first = json(&tessela(&dir, &["attach", "project/tessela.md"], PNG));
    assert_eq!(
        (first["api"].clone(), first["ok"].clone()),
        (2.into(), true.into())
    );
    let path = first["path"].as_str().unwrap();
    assert!(
        path.starts_with("assets/project-tessela-") && path.ends_with(".png"),
        "{path}"
    );
    assert_eq!(first["link"], format!("/{path}"));
    assert_eq!(first["created"], true);
    assert_eq!(std::fs::read(dir.join(path)).unwrap(), PNG);

    let again = json(&tessela(&dir, &["attach", "project/tessela"], PNG));
    assert_eq!(
        (again["path"].clone(), again["created"].clone()),
        (first["path"].clone(), false.into())
    );

    let other_page = json(&tessela(&dir, &["attach", "notes/idea"], PNG));
    assert_ne!(other_page["path"], first["path"]);
    let other_bytes = json(&tessela(
        &dir,
        &["attach", "project/tessela"],
        b"\x89PNG\r\n\x1a\n other",
    ));
    assert_ne!(other_bytes["path"], first["path"]);
    assert_eq!(std::fs::read_dir(dir.join("assets")).unwrap().count(), 3);
}

#[test]
fn the_kind_comes_from_the_flag_the_file_name_or_the_bytes() {
    let dir = bundle("ext");
    let from_flag = json(&tessela(
        &dir,
        &["attach", "a", "--ext", "JPEG"],
        b"not recognised",
    ));
    assert!(from_flag["path"].as_str().unwrap().ends_with(".jpeg"));

    let source = dir.join("photo.webp");
    std::fs::write(&source, b"x").unwrap();
    let from_name = json(&tessela(
        &dir,
        &["attach", "a", "--file", source.to_str().unwrap()],
        b"",
    ));
    assert!(from_name["path"].as_str().unwrap().ends_with(".webp"));

    let sniffed = json(&tessela(&dir, &["attach", "a"], b"%PDF-1.7 ..."));
    assert!(sniffed["path"].as_str().unwrap().ends_with(".pdf"));

    // Nothing says what it is, and a .md file would be a page, not an attachment.
    for args in [
        &["attach", "a"][..],
        &["attach", "a", "--ext", "md"],
        &["attach", "a", "--ext", "../x"],
    ] {
        let out = tessela(&dir, args, b"unknown bytes");
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        assert_eq!(json(&out)["error"]["code"], "invalid-input", "{args:?}");
    }
    let out = tessela(&dir, &["attach", "../outside", "--ext", "png"], PNG);
    assert_eq!(json(&out)["error"]["code"], "invalid-path");
    assert!(!dir.parent().unwrap().join("outside.md").exists());
}

#[test]
fn lint_lists_attachments_that_no_page_links_to() {
    let dir = bundle("lint");
    let attached = json(&tessela(&dir, &["attach", "idea"], PNG));
    let path = attached["path"].as_str().unwrap().to_string();
    let unused = |dir: &Path| -> Vec<String> {
        let out = Command::new(env!("CARGO_BIN_EXE_tessela"))
            .args(["lint", dir.to_str().unwrap(), "--json"])
            .output()
            .unwrap();
        json(&out)["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|d| d["rule"] == "tessela/unused-attachment")
            .map(|d| d["path"].as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(unused(&dir), std::slice::from_ref(&path));

    let page = format!("---\ntype: concept\ntitle: Idea\n---\n\n![A sketch](/{path})\n");
    std::fs::write(dir.join("idea.md"), page).unwrap();
    assert!(unused(&dir).is_empty());
}
