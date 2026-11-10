//! The narrow waist: what a client in any language may rely on when it calls `tessela`.
//! Every `--json` answer carries `api` and `ok`, and a caller written for another API
//! version is refused.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::Value;

const API: u64 = 2;

fn bundle(name: &str, files: &[(&str, &str)]) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tessela-waist-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    for (path, text) in files {
        let file = dir.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text).unwrap();
    }
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn tessela(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_tessela"))
        .args(args)
        .output()
        .unwrap()
}

/// Runs `tessela COMMAND DIR --json --api N` and parses what it printed.
fn call(command: &str, dir: &Path, extra: &[&str]) -> (Option<i32>, Value) {
    let api = API.to_string();
    let mut args = vec![command, dir.to_str().unwrap(), "--json", "--api", &api];
    args.extend_from_slice(extra);
    let out = tessela(&args);
    let json = serde_json::from_slice(&out.stdout)
        .unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&out.stdout)));
    (out.status.code(), json)
}

const NOTES: &[(&str, &str)] = &[
    (
        "ideas.md",
        "---\ntype: concept\n---\n\n# Ideas\n\n- Try #tessela and [[x]]\n- Another #tessela note\n",
    ),
    ("odd.md", "no frontmatter at all\n"),
];

#[test]
fn query_vocab_and_lint_answer_in_an_envelope() {
    let dir = bundle("envelope", NOTES);

    let (code, q) = call("query", &dir, &["--ref", "tessela", "--limit", "1"]);
    assert_eq!(code, Some(0));
    assert_eq!(
        (&q["api"], &q["ok"]),
        (&Value::from(API), &Value::Bool(true))
    );
    assert_eq!(q["hits"].as_array().unwrap().len(), 1);
    // `total` counts the hits before --limit cut them.
    assert!(q["total"].as_u64().unwrap() >= 2);

    let (_, v) = call("vocab", &dir, &[]);
    assert_eq!(
        (&v["api"], &v["ok"]),
        (&Value::from(API), &Value::Bool(true))
    );
    assert!(
        v["concepts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["concept"] == "tessela")
    );

    // Findings are not a failure of the command: `ok` stays true and the exit code says
    // what lint always said.
    let (code, l) = call("lint", &dir, &[]);
    assert_eq!(
        (&l["api"], &l["ok"]),
        (&Value::from(API), &Value::Bool(true))
    );
    let findings = l["diagnostics"].as_array().unwrap();
    assert!(findings.iter().any(|d| d["path"] == "odd.md"));
    let has_error = findings.iter().any(|d| d["severity"] == "error");
    assert_eq!(code, Some(if has_error { 1 } else { 0 }));
}

#[test]
fn index_and_import_report_in_an_envelope_too() {
    let dir = bundle("index", NOTES);
    let (_, listing) = call("index", &dir, &[]);
    assert_eq!(listing["api"], API);
    assert_eq!(listing["ok"], true);
    assert!(listing["pages"].is_array());
}

#[test]
fn a_caller_for_another_api_version_is_refused_with_json() {
    let dir = bundle("mismatch", NOTES);
    for command in ["query", "vocab", "lint", "index"] {
        let out = tessela(&[command, dir.to_str().unwrap(), "--json", "--api", "1"]);
        assert_eq!(out.status.code(), Some(2), "{command}");
        let json: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(json["ok"], false, "{command}");
        assert_eq!(json["api"], API, "{command}");
        assert_eq!(json["error"]["code"], "api-mismatch", "{command}");
    }
}

#[test]
fn a_bundle_that_is_not_there_is_a_json_error() {
    let missing = std::env::temp_dir().join("tessela-waist-missing-folder");
    let out = tessela(&["query", missing.to_str().unwrap(), "--json"]);
    assert_eq!(out.status.code(), Some(2));
    let json: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(
        (json["ok"].clone(), json["api"].clone()),
        (false.into(), API.into())
    );
    assert_eq!(json["error"]["code"], "not-found");
}

#[test]
fn pages_lists_every_concept_page_with_the_title_it_gives_itself() {
    let dir = bundle(
        "pages",
        &[
            (
                "daily-todo.md",
                "---\ntype: concept\ntitle: \"Daily TODO\"\n---\n\n# Other\n",
            ),
            (
                "reading-list.md",
                "---\ntype: concept\n---\n\n# Books to read\n",
            ),
            ("project/bare-page.md", "no heading"),
            ("journals/2026-10-27.md", "---\ntype: journal\n---\n\nhi\n"),
            ("index.md", "reserved"),
            (".git/hidden.md", "hidden"),
        ],
    );
    let (code, json) = call("pages", &dir, &[]);
    assert_eq!(code, Some(0));
    let pages = json["pages"].as_array().unwrap();
    let row = |path: &str| pages.iter().find(|p| p["path"] == path).unwrap().clone();
    assert_eq!(row("daily-todo.md")["title"], "Daily TODO");
    assert_eq!(row("reading-list.md")["title"], "Books to read");
    assert_eq!(row("project/bare-page.md")["title"], "bare page");
    assert_eq!(row("project/bare-page.md")["id"], "project/bare-page");
    assert_eq!(row("journals/2026-10-27.md")["type"], "journal");
    assert!(row("project/bare-page.md")["type"].is_null());
    // Sorted by path; reserved and hidden files are not pages.
    let paths: Vec<_> = pages.iter().map(|p| p["path"].as_str().unwrap()).collect();
    assert_eq!(
        paths,
        [
            "daily-todo.md",
            "journals/2026-10-27.md",
            "project/bare-page.md",
            "reading-list.md"
        ]
    );
}

/// A running `tessela watch --json`: its lines arrive on a channel.
struct Watch {
    child: std::process::Child,
    lines: std::sync::mpsc::Receiver<Value>,
}

impl Watch {
    fn start(dir: &Path) -> Watch {
        Watch::start_with(dir, &[])
    }

    fn start_with(dir: &Path, extra: &[&str]) -> Watch {
        use std::io::{BufRead, BufReader};
        use std::process::Stdio;
        let api = API.to_string();
        let mut child = Command::new(env!("CARGO_BIN_EXE_tessela"))
            .args(["watch", dir.to_str().unwrap(), "--json", "--api", &api])
            .args(extra)
            .stdout(Stdio::piped())
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (send, lines) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = send.send(serde_json::from_str::<Value>(&line).expect(&line));
            }
        });
        Watch { child, lines }
    }

    fn next(&self, within_ms: u64) -> Option<Value> {
        self.lines
            .recv_timeout(std::time::Duration::from_millis(within_ms))
            .ok()
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn watch_streams_the_pages_that_change() {
    let dir = bundle("watch", &[("a.md", "one\n"), ("sub/b.md", "two\n")]);
    let watch = Watch::start(&dir);
    let ready = watch.next(5000).expect("a ready line");
    assert_eq!(ready["event"], "ready");
    assert_eq!(
        (&ready["api"], &ready["ok"]),
        (&Value::from(API), &Value::Bool(true))
    );

    // Hidden folders and other files are not pages: no line for them.
    std::fs::create_dir_all(dir.join(".git")).unwrap();
    std::fs::write(dir.join(".git/x.md"), "x").unwrap();
    std::fs::write(dir.join("notes.txt"), "x").unwrap();
    // Several changes close together arrive as one line, with sorted, unique paths.
    std::fs::write(dir.join("sub/b.md"), "changed\n").unwrap();
    std::fs::write(dir.join("a.md"), "changed\n").unwrap();
    std::fs::write(dir.join("a.md"), "changed again\n").unwrap();
    let changed = watch.next(5000).expect("a changed line");
    assert_eq!(changed["event"], "changed");
    assert_eq!(changed["paths"], serde_json::json!(["a.md", "sub/b.md"]));

    // A deleted page is reported too.
    std::fs::remove_file(dir.join("a.md")).unwrap();
    let gone = watch.next(5000).expect("a changed line for the deletion");
    assert_eq!(gone["paths"], serde_json::json!(["a.md"]));
}

#[test]
fn watch_reports_a_folder_that_never_stops_changing() {
    let dir = bundle("watch-busy", &[("a.md", "one\n")]);
    let watch = Watch::start(&dir);
    assert_eq!(watch.next(5000).unwrap()["event"], "ready");
    // A change every 50 ms never leaves a quiet moment, but it is still reported.
    let writer = {
        let file = dir.join("a.md");
        std::thread::spawn(move || {
            for i in 0..60 {
                std::fs::write(&file, format!("{i}\n")).unwrap();
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        })
    };
    let changed = watch
        .next(2500)
        .expect("a changed line while it is still busy");
    assert_eq!(changed["paths"], serde_json::json!(["a.md"]));
    writer.join().unwrap();
}

#[test]
fn watch_can_look_at_the_files_instead_of_asking_the_system() {
    let dir = bundle("watch-poll", &[("a.md", "one\n")]);
    let watch = Watch::start_with(&dir, &["--poll"]);
    let ready = watch.next(5000).expect("a ready line");
    assert_eq!(ready["mode"], "polling");
    std::fs::write(dir.join("new.md"), "x").unwrap();
    std::fs::write(dir.join("a.md"), "changed\n").unwrap();
    let changed = watch.next(10_000).expect("a changed line");
    assert_eq!(changed["paths"], serde_json::json!(["a.md", "new.md"]));
}

#[test]
fn watch_ends_when_its_caller_goes_away() {
    let dir = bundle("watch-exit", &[("a.md", "one\n")]);
    let mut watch = Watch::start_with(&dir, &["--exit-on-stdin-close"]);
    assert_eq!(watch.next(5000).unwrap()["event"], "ready");
    // The caller (the editor) closes the pipe it keeps open on stdin, or dies and the system does.
    drop(watch.child.stdin.take());
    let start = std::time::Instant::now();
    while watch.child.try_wait().unwrap().is_none() {
        assert!(start.elapsed().as_secs() < 5, "watch kept running");
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

#[test]
fn watch_refuses_a_caller_for_another_api_version() {
    let dir = bundle("watch-api", &[]);
    let out = tessela(&["watch", dir.to_str().unwrap(), "--json", "--api", "1"]);
    assert_eq!(out.status.code(), Some(2));
    let json: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(json["error"]["code"], "api-mismatch");
}

/// What `tessela schema` describes is what the commands print: every answer below is
/// checked against the schema of its command.
#[test]
fn the_schema_describes_what_the_commands_print() {
    let dir = bundle("schema", NOTES);
    let d = dir.to_str().unwrap();
    let doc: Value =
        serde_json::from_slice(&tessela(&["schema"]).stdout).expect("schema prints JSON");
    assert_eq!(doc["api"], API);
    let check = |command: &str, answer: Value| {
        let mut schema = doc.clone();
        schema["$ref"] = format!("#/commands/{command}/answer").into();
        let validator = jsonschema::validator_for(&schema).expect("a valid schema");
        let errors: Vec<_> = validator
            .iter_errors(&answer)
            .map(|e| e.to_string())
            .collect();
        assert!(errors.is_empty(), "{command}: {errors:?}\n{answer}");
    };
    let json = |args: &[&str]| -> Value {
        let out = tessela(args);
        serde_json::from_slice(&out.stdout).unwrap_or_else(|e| panic!("{args:?}: {e}"))
    };
    check("pages", json(&["pages", d, "--json"]));
    check("query", json(&["query", d, "--ref", "tessela", "--json"]));
    check("vocab", json(&["vocab", d, "--json"]));
    check("lint", json(&["lint", d, "--json"]));
    check("index", json(&["index", d, "--json"]));
    check("api", json(&["api", "--json"]));
    check("read", json(&["read", "ideas.md", "-b", d, "--json"]));
    check("add", json(&["add", "fresh", "-b", d, "--json"]));
    check(
        "move",
        json(&["move", "fresh.md", "later/", "-b", d, "--json"]),
    );
    check("related", json(&["related", "tessela", "-b", d, "--json"]));
    check("schema", doc.clone());

    // `changes` needs a git repository with something changed in it.
    let git = |args: &[&str]| {
        let out = Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-C", d])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}");
    };
    git(&["init", "-q"]);
    git(&["add", "-A"]);
    git(&["commit", "-qm", "first"]);
    std::fs::write(
        dir.join("ideas.md"),
        "---\ntype: concept\n---\n\n# Ideas\n\n- New #tessela line\n",
    )
    .unwrap();
    check("changes", json(&["changes", "-b", d, "--json"]));

    // The two that read their input from stdin.
    let with_stdin = |args: &[&str], input: &str| -> Value {
        use std::io::Write;
        let mut child = Command::new(env!("CARGO_BIN_EXE_tessela"))
            .args(args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
        serde_json::from_slice(&child.wait_with_output().unwrap().stdout).unwrap()
    };
    check(
        "fence",
        with_stdin(
            &["fence", "-b", d, "--json"],
            "query --ref tessela | head 1\n",
        ),
    );
    check(
        "attach",
        with_stdin(
            &["attach", "ideas", "--ext", "png", "-b", d, "--json"],
            "not really a png",
        ),
    );

    // A failure has its own shape.
    let failure = json(&["remove", "nope.md", "--expect", "abc", "-b", d, "--json"]);
    assert_eq!(failure["ok"], false);
    let mut schema = doc.clone();
    schema["$ref"] = "#/failure".into();
    assert!(
        jsonschema::validator_for(&schema)
            .unwrap()
            .is_valid(&failure)
    );

    // Streams: the first line of `watch`.
    let watch = Watch::start(&dir);
    check("watch", watch.next(5000).unwrap());
}
