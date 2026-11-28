//! `surface` reads the notes through a summary kept in `.tessela/cache/`, plus the pages that
//! differ from it. Whatever happens to the files and to the summary, the answer must be the one
//! a call with no cache gives, and every candidate must be something that is really in the notes.

mod support;

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use proptest::prelude::*;
use support::{config, page_path, page_text};
use tessela_core::surface::{Request, Surface, surface, surface_uncached};
use tessela_core::{Bundle, HitKind};

#[derive(Debug, Clone)]
enum Op {
    /// Write a page; `recent` leaves its modification time as it is now, so the cache does not
    /// trust it yet.
    Write(String, String, bool),
    Delete(String),
    WipeCache,
    /// Scribble in the summary file, or cut it short.
    Damage(bool),
    Ask(String, usize, Option<String>),
}

/// Pages that give the sources something to find: titles, aliases, tags, dates, open tasks,
/// words that several pages share, and names written without a link.
fn body() -> impl Strategy<Value = String> {
    const LINES: &[&str] = &[
        "- Alpha Beta is written here\n",
        "- ab was said about #x\n",
        "- [ ] call 2026-12-02 about #y\n",
        "- [ ] pay 2026-12-04 and 2026-12-20\n",
        "- zebrafish plumage taxonomy research\n  - zebrafish taxonomy again\n",
        "## Plumage #x\n\n- taxonomy of plumage and zebrafish\n",
        "- meet on 2026-12-03 to talk about plumage\n",
        "- see [x](/x.md) and #y\n  - nested #x/c\n",
        "- Gamma Delta and gamma delta\n",
        "unmarked paragraph about Alpha\n",
    ];
    let line = proptest::sample::select(LINES).prop_map(String::from);
    (
        prop_oneof![
            2 => Just(String::new()),
            1 => Just("---\ntitle: Alpha Beta\naliases: [ab]\n---\n".to_string()),
            1 => Just("---\ntitle: Gamma Delta\ntags: [x]\n---\n".to_string()),
        ],
        page_text(),
        proptest::collection::vec(line, 0..6),
    )
        .prop_map(|(front, text, lines)| {
            // The generated text may have its own front matter; ours goes first only if it has none.
            let text = if front.is_empty() || text.starts_with("---") {
                text
            } else {
                format!("{front}{text}")
            };
            format!("{text}\n{}", lines.concat())
        })
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        6 => (page_path(), body(), any::<bool>()).prop_map(|(p, t, r)| Op::Write(p, t, r)),
        2 => page_path().prop_map(Op::Delete),
        1 => Just(Op::WipeCache),
        1 => any::<bool>().prop_map(Op::Damage),
        8 => (
            page_path(),
            1usize..30,
            proptest::option::of("[a-zA-Z0-9 #]{0,40}|Alpha Beta zebrafish plumage 2026-12-03"),
        )
            .prop_map(|(p, l, t)| Op::Ask(p, l, t)),
    ]
}

fn scratch() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tessela-surface-props-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("filler")).unwrap();
    // Enough pages that a word only a few of them use says something.
    for i in 0..60 {
        let file = dir.join(format!("filler/f{i}.md"));
        std::fs::write(&file, format!("- filler{i} text about nothing\n")).unwrap();
        set_mtime(&file, UNIX_EPOCH + Duration::from_secs(1_600_000_000));
    }
    dir
}

fn set_mtime(path: &Path, time: SystemTime) {
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(time)
        .unwrap();
}

/// Every candidate is in the notes, as it says, and not the thought itself.
fn check(dir: &Path, req: &Request, answer: &Surface) -> Result<(), TestCaseError> {
    let bundle = Bundle::load_sequential(dir).unwrap();
    prop_assert!(answer.candidates.len() <= req.limit);
    for pair in answer.candidates.windows(2) {
        prop_assert!(pair[0].score >= pair[1].score, "sorted by score");
    }
    for c in &answer.candidates {
        let page = bundle.pages.iter().find(|p| p.path == c.path);
        let page = page.ok_or_else(|| TestCaseError::fail(format!("no page {}", c.path)))?;
        prop_assert!(!c.reason.is_empty());
        let same_page = c.path == req.page;
        match c.kind {
            HitKind::Page => {
                prop_assert!(!same_page, "the page is not a candidate for itself");
                prop_assert_eq!(&c.handle, &page.id);
            }
            HitKind::Block => {
                let block = page
                    .blocks
                    .iter()
                    .find(|b| b.handle == c.handle && b.line == c.line);
                prop_assert!(block.is_some(), "no block {} at {}", c.handle, c.line);
            }
            HitKind::Heading => {
                let heading = page
                    .headings
                    .iter()
                    .find(|h| h.handle == c.handle && h.line == c.line);
                prop_assert!(heading.is_some(), "no heading {} at {}", c.handle, c.line);
            }
        }
        if same_page {
            prop_assert!(
                c.end_line < answer.at.line || answer.at.end_line < c.line,
                "{}-{} overlaps the thought at {}-{}",
                c.line,
                c.end_line,
                answer.at.line,
                answer.at.end_line
            );
        }
    }
    Ok(())
}

proptest! {
    #![proptest_config(config(40))]

    #[test]
    fn surfacing_through_the_summary_equals_surfacing_from_the_files(
        ops in proptest::collection::vec(op(), 1..30),
    ) {
        let dir = scratch();
        let mut step = 0u64;
        for op in ops {
            step += 1;
            match op {
                Op::Write(path, text, recent) => {
                    let file = dir.join(&path);
                    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
                    std::fs::write(&file, text).unwrap();
                    if !recent {
                        set_mtime(&file, UNIX_EPOCH + Duration::from_secs(1_700_000_000 + step));
                    }
                }
                Op::Delete(path) => {
                    let _ = std::fs::remove_file(dir.join(&path));
                }
                Op::WipeCache => {
                    let _ = std::fs::remove_dir_all(dir.join(".tessela"));
                }
                Op::Damage(cut) => {
                    let file = dir.join(".tessela/cache/summary.dat");
                    if let Ok(mut bytes) = std::fs::read(&file) {
                        if cut {
                            bytes.truncate(bytes.len() / 2);
                        } else if !bytes.is_empty() {
                            let at = bytes.len() / 2;
                            bytes[at] ^= 0x55;
                        }
                        std::fs::write(&file, bytes).unwrap();
                    }
                }
                Op::Ask(page, line, text) => {
                    let req = Request { page: &page, line, text: text.as_deref(), limit: 20 };
                    let cached = surface(&dir, &req);
                    let fresh = surface_uncached(&dir, &req);
                    match (&cached, &fresh) {
                        (Ok(a), Ok(b)) => {
                            prop_assert_eq!(format!("{a:?}"), format!("{b:?}"));
                            check(&dir, &req, a)?;
                        }
                        (Err(a), Err(b)) => prop_assert_eq!(a.to_string(), b.to_string()),
                        _ => prop_assert!(false, "{cached:?} against {fresh:?}"),
                    }
                }
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
