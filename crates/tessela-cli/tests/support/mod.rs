//! A benchmark harness for the `tessela` tool: generated bundles, a table of the commands
//! that matter for speed, and a runner that reports time and how many pages each call parsed.
//!
//! Used by `tests/budgets.rs` (checks budgets in CI) and `benches/cli.rs` (prints a table for
//! humans). Every speed change shows its effect here, and tightens the budgets in [`COMMANDS`].
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

/// The sizes the harness is run at: a small bundle, Ronie's, and the planned maximum.
pub const SIZES: [usize; 3] = [500, 1_500, 3_000];

/// Words the generated pages are written from. Each is also a tag, and has a page of its own
/// under `concepts/`, so `query --unlinked WORD` and `related WORD` find real work.
const WORDS: [&str; 24] = [
    "rust", "editor", "note", "link", "page", "agent", "model", "speed", "typing", "reading",
    "search", "indexer", "cache", "block", "parser", "tree", "garden", "memory", "focus",
    "decision", "value", "flow", "design", "mouse",
];

/// One topic in [`RARE_EVERY`] mentions this word, and tags it, so a text or tag query for it
/// has a few real answers among thousands of pages that cannot match.
pub const RARE: &str = "zebrafish";
pub const RARE_EVERY: usize = 100;
const RARE_AT: usize = 7;

/// How many of `topics` topics mention [`RARE`].
pub fn rare_topics(topics: usize) -> usize {
    (0..topics).filter(|i| i % RARE_EVERY == RARE_AT).count()
}

/// A small deterministic generator (xorshift64*): the same seed gives the same bundle on
/// every machine, with no dependency.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() >> 11) as usize % n
    }

    fn between(&mut self, lo: usize, hi: usize) -> usize {
        lo + self.below(hi - lo + 1)
    }

    fn word(&mut self) -> &'static str {
        WORDS[self.below(WORDS.len())]
    }

    fn paragraph(&mut self) -> String {
        let n = self.between(12, 30);
        (0..n).map(|_| self.word()).collect::<Vec<_>>().join(" ")
    }
}

/// Where page `i` lives: every tenth topic is at the root, the rest under `topics/`.
fn topic_path(i: usize) -> String {
    if i.is_multiple_of(10) {
        format!("topic-{i}.md")
    } else {
        format!("topics/topic-{i}.md")
    }
}

/// A link to topic `to` as written from the page at `from_dir` (`""` or `"topics"`).
fn link_to(to: usize, from_dir: &str) -> String {
    let target = topic_path(to);
    match (from_dir, target.strip_prefix("topics/")) {
        ("topics", Some(rest)) => rest.to_string(),
        ("topics", None) => format!("../{target}"),
        _ => target,
    }
}

/// Writes a bundle of `topics` pages of about 7 KB each (three sections of linked, tagged,
/// nested bullets), one journal day for every five topics, and a page for each of [`WORDS`].
/// Links and tags are real, so `related`, backlinks and unlinked mentions have work to do.
/// The same `topics` always gives the same files. Returns the number of pages written.
pub fn generate(root: &Path, topics: usize) -> usize {
    let mut rng = Rng(0x7e55_e1a5_eed0_0001);
    let write = |path: &str, text: String| {
        let full = root.join(path);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, text).unwrap();
    };
    for i in 0..topics {
        let path = topic_path(i);
        let dir = if path.starts_with("topics/") {
            "topics"
        } else {
            ""
        };
        let mut text = format!("---\ntitle: Topic {i}\ntype: note\n---\n\n# Topic {i}\n\n");
        for s in 0..3 {
            text += &format!("## Section {s}\n\n");
            for _ in 0..4 {
                let (to, tag) = (rng.below(topics), rng.word());
                text += &format!(
                    "- {} [Topic]({}) #{tag}\n  - {}\n",
                    rng.paragraph(),
                    link_to(to, dir),
                    rng.paragraph()
                );
            }
            text += &format!("\n{}\n\n", rng.paragraph());
        }
        if i % RARE_EVERY == RARE_AT {
            text += &format!("- A note on {RARE}, tagged #{RARE}\n");
        }
        write(&path, text);
    }
    let days = topics / 5;
    for d in 0..days {
        let (y, m, day) = civil_from_days(19_723 + d as i64); // 2024-01-01 is day 19723
        let to = link_to(rng.below(topics), "topics");
        write(
            &format!("journals/{y:04}-{m:02}-{day:02}.md"),
            format!(
                "- {} [x](../topics/{to})\n- [ ] {}\n",
                rng.paragraph(),
                rng.paragraph()
            ),
        );
    }
    for word in WORDS {
        write(
            &format!("concepts/{word}.md"),
            format!("---\ntitle: {word}\ntype: concept\n---\n\n# {word}\n\nAbout {word}.\n"),
        );
    }
    topics + days + WORDS.len()
}

/// Days since 1970-01-01 to (year, month, day), proleptic Gregorian.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// Gives every file an old modification time, like notes that were written some time ago.
/// The parse cache does not trust a file changed in the last two seconds, and a generated
/// bundle is written just before it is read.
pub fn backdate(root: &Path) {
    let old = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
    let mut dirs = vec![root.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                dirs.push(path);
            } else {
                std::fs::File::options()
                    .write(true)
                    .open(path)
                    .unwrap()
                    .set_modified(old)
                    .unwrap();
            }
        }
    }
}

/// A generated bundle in a scratch folder, removed when dropped.
pub struct Bundle {
    pub root: PathBuf,
    /// How many pages the bundle holds.
    pub pages: usize,
}

impl Bundle {
    pub fn generate(topics: usize) -> Bundle {
        // One folder per bundle: tests in a process run in parallel.
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!(
            "bench-{topics}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&root);
        let pages = generate(&root, topics);
        backdate(&root);
        Bundle { root, pages }
    }
}

impl Drop for Bundle {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// One command of the table. Budgets are for a bundle of [`SIZES`]`[2]` topics on a release
/// build; `{bundle}` stays out of `args`, the runner adds `-b`/`--bundle`.
///
/// A command runs twice over a fresh bundle: cold, with no parse cache yet (the first call
/// after a bundle is opened, or after `.tessela/` was deleted), and warm, with the cache the
/// cold call wrote. Warm is what a person and the editor see.
pub struct Case {
    pub name: &'static str,
    pub args: &'static [&'static str],
    /// How the bundle is named: the command takes a positional folder, or `--bundle`.
    pub positional: bool,
    /// Wall-clock budget in ms of a warm call, on a release build, at 3,000 topics. A speed
    /// PR that makes the command faster lowers this number in the same PR.
    pub warm_ms: f64,
    /// Pages the cold call may parse. `None` means all of them. A PR that makes a command
    /// parse fewer pages sets the exact limit here.
    pub cold_parsed: Option<usize>,
    /// Pages a warm call may parse: none for a command that loads the bundle, since every
    /// page is in the cache.
    pub warm_parsed: usize,
}

pub const COMMANDS: &[Case] = &[
    Case {
        name: "pages",
        args: &["pages", "--json"],
        positional: true,
        warm_ms: 80.0,
        cold_parsed: None,
        warm_parsed: 0,
    },
    Case {
        name: "query --words",
        args: &["query", "--words", "rust cache", "--limit", "20", "--json"],
        positional: true,
        warm_ms: 220.0,
        cold_parsed: None,
        warm_parsed: 0,
    },
    Case {
        name: "query --ref",
        args: &["query", "--ref", "#rust", "--limit", "20", "--json"],
        positional: true,
        warm_ms: 220.0,
        cold_parsed: None,
        warm_parsed: 0,
    },
    Case {
        name: "query --words rare",
        args: &["query", "--words", "zebrafish", "--limit", "20", "--json"],
        positional: true,
        warm_ms: 45.0,
        cold_parsed: Some(30),
        warm_parsed: 0,
    },
    Case {
        name: "query --ref rare",
        args: &["query", "--ref", "#zebrafish", "--limit", "20", "--json"],
        positional: true,
        warm_ms: 45.0,
        cold_parsed: Some(30),
        warm_parsed: 0,
    },
    Case {
        name: "query --page",
        args: &["query", "--page", "topics/topic-1", "--json"],
        positional: true,
        warm_ms: 25.0,
        cold_parsed: Some(1),
        warm_parsed: 0,
    },
    Case {
        name: "query --unlinked",
        args: &["query", "--unlinked", "cache", "--limit", "20", "--json"],
        positional: true,
        warm_ms: 500.0,
        cold_parsed: None,
        warm_parsed: 0,
    },
    Case {
        name: "related",
        args: &["related", "topics/topic-1", "--json"],
        positional: false,
        warm_ms: 80.0,
        cold_parsed: None,
        warm_parsed: 0,
    },
    Case {
        name: "blocks",
        args: &["blocks", "topics/topic-1", "--json"],
        positional: false,
        warm_ms: 20.0,
        cold_parsed: Some(1),
        warm_parsed: 1,
    },
    Case {
        name: "read",
        args: &["read", "topics/topic-1", "--json"],
        positional: false,
        warm_ms: 20.0,
        cold_parsed: Some(1),
        warm_parsed: 0,
    },
    Case {
        name: "vocab",
        args: &["vocab", "--json"],
        positional: true,
        warm_ms: 140.0,
        cold_parsed: None,
        warm_parsed: 0,
    },
];

/// What one call of a command cost.
pub struct Run {
    pub ms: f64,
    /// Pages the call parsed, read from `TESSELA_STATS`.
    pub parsed: usize,
}

/// Runs `tessela` on the bundle once, with stats on, and checks that it succeeded.
pub fn run(case: &Case, bundle: &Path) -> Run {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_tessela"));
    cmd.env("TESSELA_STATS", "1").args(case.args);
    if case.positional {
        cmd.arg(bundle);
    } else {
        cmd.arg("-b").arg(bundle);
    }
    let start = Instant::now();
    let out = cmd.output().expect("tessela runs");
    let ms = start.elapsed().as_secs_f64() * 1_000.0;
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        out.status.success(),
        "{} failed: {stderr}{}",
        case.name,
        String::from_utf8_lossy(&out.stdout)
    );
    let parsed = stderr
        .lines()
        .find_map(|l| l.strip_prefix("tessela-stats: pages_parsed="))
        .and_then(|n| n.trim().parse().ok())
        .unwrap_or_else(|| panic!("{} printed no stats: {stderr}", case.name));
    Run { ms, parsed }
}

/// A command measured cold and then warm.
pub struct Measured {
    pub cold: Run,
    pub warm: Run,
}

/// Runs the command cold (the parse cache removed first), then warm, and keeps the fastest
/// of up to `times` of each, which is the least disturbed by a noisy machine. A call that
/// takes over two seconds is not repeated: its budget is far above what noise can add, and
/// repeating it only slows the suite.
pub fn measure(case: &Case, bundle: &Path, times: usize) -> Measured {
    let cold_run = || {
        let _ = std::fs::remove_dir_all(bundle.join(".tessela"));
        run(case, bundle)
    };
    let mut cold = cold_run();
    for _ in 1..times.min(2) {
        if cold.ms > 2_000.0 {
            break;
        }
        let again = cold_run();
        cold.ms = cold.ms.min(again.ms);
    }
    // The last cold call left the cache the warm ones use.
    let mut warm = run(case, bundle);
    for _ in 1..times {
        if warm.ms > 2_000.0 {
            break;
        }
        warm.ms = warm.ms.min(run(case, bundle).ms);
    }
    Measured { cold, warm }
}
