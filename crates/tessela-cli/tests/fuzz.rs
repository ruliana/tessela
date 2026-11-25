//! Fuzzing the command line: every command, called with odd names, hashes, flags and input,
//! must answer the way the contract says (one JSON envelope, an exit code that agrees with it)
//! and must not panic, hang on its input, write outside the bundle or leave files behind.
//!
//! Pull requests run a bounded, fixed-seed pass. The scheduled fuzz job sets
//! `TESSELA_FUZZ_CASES` and `TESSELA_FUZZ_SEED` to look further, and a failure prints the seed.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

use proptest::prelude::*;
use proptest::test_runner::{Config, RngAlgorithm, RngSeed};
use serde_json::Value;

fn config(cases: u32) -> Config {
    let number = |name: &str| std::env::var(name).ok()?.trim().parse::<u64>().ok();
    let seed = number("TESSELA_FUZZ_SEED").unwrap_or(0x7e55e1a);
    eprintln!("fuzz: seed {seed} (TESSELA_FUZZ_SEED)");
    Config {
        cases: number("TESSELA_FUZZ_CASES").map_or(cases, |n| n as u32),
        rng_algorithm: RngAlgorithm::ChaCha,
        rng_seed: RngSeed::Fixed(seed),
        failure_persistence: None,
        max_shrink_iters: 512,
        ..Config::default()
    }
}

const PAGES: &[(&str, &str)] = &[
    (
        "home.md",
        "---\ntype: home\n---\n\nStart with [ideas](/notes/idea.md) and #rust.\n",
    ),
    (
        "notes/idea.md",
        "---\ntype: concept\ntitle: \"Idea\"\ntags: [rust]\n---\n\n# Idea\n\nSee [other](./other.md) and #notes/other. - [ ] task\n\n- [ ] open #rust\n- [x] done\n",
    ),
    (
        "notes/other.md",
        "---\ntype: concept\n---\n\nBack to [idea](idea.md#top) 2026-10-27 `#code`\n",
    ),
    (
        "journals/2026-10-27.md",
        "---\ntype: journal\n---\n\nMet about #rust and [x](/notes/idea.md).\n",
    ),
];

struct Sandbox {
    base: PathBuf,
    root: PathBuf,
}

impl Sandbox {
    fn new() -> Sandbox {
        static N: AtomicUsize = AtomicUsize::new(0);
        let base = std::env::temp_dir().join(format!(
            "tessela-fuzz-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("bundle");
        for (path, text) in PAGES {
            let file = root.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, text).unwrap();
        }
        Sandbox { base, root }
    }

    /// Every file under the bundle (hidden ones too) with its bytes.
    fn snapshot(&self) -> BTreeMap<String, Vec<u8>> {
        fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
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
                    out.insert(rel, std::fs::read(&path).unwrap());
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(&self.root, &self.root, &mut out);
        out
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

/// A name, path, hash or phrase: ordinary ones, hostile ones, and anything.
fn word() -> impl Strategy<Value = String> {
    prop_oneof![
        6 => proptest::sample::select(&[
            "notes/idea.md", "notes/idea", "idea", "Idea", "notes/other.md", "home.md", "home",
            "journals/2026-10-27.md", "rust", "#rust", "notes/", "archive/", "archive/idea.md",
            "new page", "A/B/C", "x.md", "index.md", "log.md", "notes/index.md", "assets/a.png",
            "../x.md", "/etc/passwd", "a/../../x.md", ".hidden.md", "a//b.md", "a\\b.md", "",
            " ", ".", "..", "-", "--", "-x", "new", "0", "abc", "é/日本.md", "x\ny.md", "x\ty.md",
            "2026-10-27", "2026-13-45", "open", "done", "any", "https://e.org/a.md",
        ][..]).prop_map(String::from),
        2 => "[ -~]{0,12}",
        1 => any::<String>().prop_map(|s| s.replace('\0', "")),
    ]
}

/// A page the bundle has, mostly; sometimes anything.
fn page() -> impl Strategy<Value = String> {
    prop_oneof![
        5 => proptest::sample::select(&["notes/idea.md", "notes/other.md", "notes/idea", "home.md", "journals/2026-10-27.md"][..]).prop_map(String::from),
        1 => word(),
    ]
}

/// Where a page could go, mostly somewhere that works.
fn place() -> impl Strategy<Value = String> {
    prop_oneof![
        4 => proptest::sample::select(&["archive/", "renamed", "New Name", "a/b/c.md", "journals/", "notes/other-name.md", "x/y z"][..]).prop_map(String::from),
        1 => word(),
    ]
}

fn own(s: &str) -> String {
    s.to_string()
}

/// One call: the subcommand with its arguments, and what goes to its standard input.
fn call() -> impl Strategy<Value = (Vec<String>, String)> {
    let stdin = prop_oneof![
        3 => Just(String::new()),
        3 => proptest::sample::select(&[
            "---\ntype: concept\n---\n\nbody #rust\n", "query --ref rust", "query --ref rust | head -n 1",
            "tessela lint | rg idea", "pages | sort | uniq -c | wc -l", "--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b\n",
            "\u{feff}", "---\n", "| |", "query --text '", "vocab | sed 's/a/b/'",
        ][..]).prop_map(String::from),
        2 => any::<String>(),
    ];
    // `@hash` stands for the hash of the page the call names, so calls can get past the guard.
    let expect = prop_oneof![2 => Just(own("new")), 4 => Just(own("@hash")), 2 => word()];
    let args = prop_oneof![
        page().prop_map(|p| vec![own("read"), own("--"), p]),
        (
            word(),
            proptest::option::of(word()),
            proptest::option::of(word()),
            prop::bool::ANY
        )
            .prop_map(|(name, title, kind, stdin)| {
                let mut a = vec![own("add")];
                a.extend(title.map(|t| format!("--title={t}")));
                a.extend(kind.map(|k| format!("--type={k}")));
                a.extend(stdin.then(|| own("--stdin")));
                a.extend([own("--"), name]);
                a
            }),
        (page(), expect.clone(), prop::bool::ANY).prop_map(|(p, e, patch)| {
            let mut a = vec![own("save"), format!("--expect={e}")];
            a.extend(patch.then(|| own("--patch")));
            a.extend([own("--"), p]);
            a
        }),
        (
            page(),
            place(),
            proptest::option::of(expect.clone()),
            prop::bool::ANY
        )
            .prop_map(|(p, n, e, dry)| {
                let mut a = vec![own("rename")];
                a.extend(e.map(|e| format!("--expect={e}")));
                a.extend(dry.then(|| own("--dry-run")));
                a.extend([own("--"), p, n]);
                a
            }),
        (
            page(),
            place(),
            proptest::option::of(expect.clone()),
            prop::bool::ANY
        )
            .prop_map(|(p, d, e, dry)| {
                let mut a = vec![own("move")];
                a.extend(e.map(|e| format!("--expect={e}")));
                a.extend(dry.then(|| own("--dry-run")));
                a.extend([own("--"), p, d]);
                a
            }),
        (page(), expect.clone()).prop_map(|(p, e)| vec![
            own("remove"),
            format!("--expect={e}"),
            own("--"),
            p
        ]),
        (
            word(),
            word(),
            word(),
            word(),
            proptest::sample::select(&["", "--any", "--own", "--meta"][..])
        )
            .prop_map(|(r, t, ty, page, flag)| {
                let mut a = vec![
                    own("query"),
                    format!("--ref={r}"),
                    format!("--text={t}"),
                    format!("--type={ty}"),
                    format!("--page={page}"),
                ];
                a.extend((!flag.is_empty()).then(|| own(flag)));
                a
            }),
        (word(), word(), word()).prop_map(|(from, to, c)| vec![
            own("query"),
            format!("--from={from}"),
            format!("--to={to}"),
            format!("--unlinked={c}")
        ]),
        (
            proptest::sample::select(&["open", "done", "any", "bogus"][..]),
            word()
        )
            .prop_map(|(t, w)| vec![
                own("query"),
                format!("--task={t}"),
                format!("--words={w}")
            ]),
        proptest::sample::select(
            &[
                "--strict",
                "--min-severity=warning",
                "--min-severity=error",
                ""
            ][..]
        )
        .prop_map(|f| {
            let mut a = vec![own("lint")];
            a.extend((!f.is_empty()).then(|| own(f)));
            a
        }),
        (word(), prop::bool::ANY).prop_map(|(d, r)| {
            let mut a = vec![own("index"), format!("--dir={d}")];
            a.extend(r.then(|| own("--recursive")));
            a
        }),
        (word(), word()).prop_map(|(p, n)| vec![
            own("vocab"),
            format!("--prefix={p}"),
            format!("--min-count={n}")
        ]),
        Just(vec![own("pages")]),
        (word(), word()).prop_map(|(n, l)| vec![
            own("related"),
            format!("--limit={l}"),
            own("--"),
            n
        ]),
        Just(vec![own("fence")]),
        (
            page(),
            proptest::sample::select(&["png", "pdf", "md", "exe", "", "PNG", "tar.gz"][..])
        )
            .prop_map(|(p, e)| vec![own("attach"), format!("--ext={e}"), own("--"), p]),
    ];
    (args, stdin)
}

/// Puts the hash of the page a call names where it says `@hash`.
fn with_hashes(sandbox: &Sandbox, args: Vec<String>) -> Vec<String> {
    let page = args
        .iter()
        .skip_while(|a| *a != "--")
        .nth(1)
        .cloned()
        .unwrap_or_default();
    let text = [page.clone(), format!("{page}.md")]
        .iter()
        .find_map(|p| std::fs::read_to_string(sandbox.root.join(p)).ok())
        .unwrap_or_default();
    let hash = tessela_core::edit::content_hash(&text);
    args.into_iter()
        .map(|a| a.replace("@hash", &hash))
        .collect()
}

/// Commands that give the bundle as the last, positional argument.
const POSITIONAL: &[&str] = &["query", "lint", "index", "vocab", "pages"];
/// Commands that must not change a single file.
const READ_ONLY: &[&str] = &[
    "read", "query", "lint", "index", "vocab", "pages", "related", "fence",
];

proptest! {
    #![proptest_config(config(60))]

    /// A few calls one after the other on the same bundle, so later ones meet what earlier
    /// ones left: moved pages, new pages, hashes that went stale.
    #[test]
    fn every_command_keeps_the_contract(calls in proptest::collection::vec(call(), 1..4)) {
        let sandbox = Sandbox::new();
        for (args, stdin) in calls {
            check(&sandbox, args, &stdin)?;
        }
    }
}

fn check(sandbox: &Sandbox, args: Vec<String>, stdin: &str) -> Result<(), TestCaseError> {
    {
        let before = sandbox.snapshot();
        let name = args[0].clone();
        let args = with_hashes(sandbox, args);
        let mut command = Command::new(env!("CARGO_BIN_EXE_tessela"));
        let root = sandbox.root.to_str().unwrap();
        if POSITIONAL.contains(&name.as_str()) {
            command.args(&args).args(["--json", "--api=2", "--", root]);
        } else {
            // Options go before the `--` that some calls already carry.
            let at = args.iter().position(|a| a == "--").unwrap_or(args.len());
            command
                .args(&args[..at])
                .args([&format!("--bundle={root}"), "--json", "--api=2"])
                .args(&args[at..]);
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(stdin.as_bytes()).ok(); // it may refuse before reading
        let out = child.wait_with_output().unwrap();
        let stderr = String::from_utf8_lossy(&out.stderr);

        let code = out.status.code();
        prop_assert!(matches!(code, Some(0..=3)), "exit {:?}: {}", code, stderr);
        prop_assert!(!stderr.contains("panicked"), "{}", stderr);

        if out.stdout.is_empty() {
            // Only a usage error (unknown value, missing argument) may print nothing.
            prop_assert_eq!(code, Some(2), "silent success");
            prop_assert!(!stderr.trim().is_empty());
        } else {
            let answer: Value = serde_json::from_slice(&out.stdout).map_err(|e| {
                TestCaseError::fail(format!("{e}: {}", String::from_utf8_lossy(&out.stdout)))
            })?;
            prop_assert_eq!(&answer["api"], 2);
            let ok = answer["ok"].as_bool().expect("ok is a boolean");
            if ok {
                prop_assert!(matches!(code, Some(0 | 1)), "ok with exit {:?}", code);
            } else {
                prop_assert!(matches!(code, Some(2 | 3)), "failure with exit {:?}", code);
                prop_assert!(
                    answer["error"]["code"].is_string() && answer["error"]["message"].is_string()
                );
            }
        }

        let after = sandbox.snapshot();
        if READ_ONLY.contains(&name.as_str()) {
            prop_assert_eq!(&after, &before, "{} changed the bundle", name);
        }
        prop_assert!(
            after.keys().all(|p| !p.ends_with(".tmp")),
            "a temporary file stayed: {:?}",
            after.keys()
        );
        for (path, bytes) in &after {
            if path.ends_with(".md") {
                prop_assert!(
                    std::str::from_utf8(bytes).is_ok(),
                    "{} is not UTF-8 any more",
                    path
                );
            }
        }
        let beside: Vec<_> = std::fs::read_dir(&sandbox.base).unwrap().collect();
        prop_assert_eq!(beside.len(), 1, "something was written beside the bundle");
    }
    Ok(())
}
