//! Speed budgets for the commands that read a bundle, on a generated bundle of 3,000 topics
//! (see `tests/support`). Each command runs cold, with no parse cache, and then warm. What a
//! budget limits is work, so that it holds on any machine and never flakes:
//!
//! - pages parsed per call: exact; a command that needs one page must parse one page, and a
//!   warm call that loads the bundle parses none;
//! - instructions a warm call executes, counted by Cachegrind (`valgrind` must be installed;
//!   CI does). The count is the same on every run of the same binary, so the budget is a few
//!   percent over what the code needs today, and a change that makes a command do more shows
//!   up as a number, not as a slow day on a shared runner.
//!
//! Wall-clock time is printed and checked against nothing: `TESSELA_STATS=1 cargo test -p
//! tessela-cli --test budgets -- --nocapture` prints a table of both, which is where the
//! budgets in `support::COMMANDS` come from. A speed PR lowers them.

mod support;

use support::{COMMANDS, SIZES, measure};

#[test]
fn every_command_stays_within_its_budget_at_3000_topics() {
    let bundle = support::Bundle::generate(SIZES[2]);
    let valgrind = support::have_valgrind();
    assert!(
        valgrind || std::env::var_os("CI").is_none(),
        "valgrind is not installed: CI needs it to count instructions"
    );
    if !valgrind {
        eprintln!("valgrind is not installed: only pages parsed are checked");
    }
    let stats = std::env::var_os("TESSELA_STATS").is_some();
    let mut over = Vec::new();
    for case in COMMANDS {
        let m = measure(case, &bundle.root, 1);
        // A command that has to look at everything parses everything cold, no more.
        let cold_max = case.cold_parsed.unwrap_or(bundle.pages);
        assert!(
            m.cold.parsed <= cold_max,
            "{} parsed {} pages cold, at most {cold_max} allowed",
            case.name,
            m.cold.parsed
        );
        assert!(
            m.warm.parsed <= case.warm_parsed,
            "{} parsed {} pages warm, at most {} allowed",
            case.name,
            m.warm.parsed,
            case.warm_parsed
        );
        if !valgrind {
            continue;
        }
        // The warm call, again, under Cachegrind: the cache is the one this case's cold call
        // wrote, so the count does not depend on which commands ran before.
        let minstr = support::instructions(case, &bundle.root) / 1_000_000;
        if stats {
            println!(
                "{:<20} {minstr:>6} Minstr (budget {:>6}), {:>6.1} ms",
                case.name, case.warm_minstr, m.warm.ms
            );
        }
        if minstr > case.warm_minstr {
            over.push(format!(
                "{} warm: {minstr} M instructions, budget {} M",
                case.name, case.warm_minstr
            ));
        }
    }
    assert!(over.is_empty(), "over budget:\n{}", over.join("\n"));
}

#[test]
fn the_parse_counter_counts_every_page_a_cold_call_reads() {
    // With no cache a call that lists pages parses all of them; the next call parses none.
    let bundle = support::Bundle::generate(40);
    let pages = &COMMANDS[0];
    assert_eq!(pages.name, "pages");
    let m = measure(pages, &bundle.root, 1);
    assert_eq!(m.cold.parsed, bundle.pages);
    assert_eq!(m.warm.parsed, 0);
}

#[test]
fn a_query_for_a_rare_word_or_tag_parses_only_the_pages_that_have_it() {
    let bundle = support::Bundle::generate(500);
    let rare = support::rare_topics(500);
    assert!(rare > 0);
    for name in ["query --words rare", "query --ref rare"] {
        let case = COMMANDS.iter().find(|c| c.name == name).unwrap();
        let _ = std::fs::remove_dir_all(bundle.root.join(".tessela"));
        assert_eq!(support::run(case, &bundle.root).parsed, rare, "{name}");
        // The pages it parsed are cached now: the same call parses none.
        assert_eq!(support::run(case, &bundle.root).parsed, 0, "{name}");
    }
}

#[test]
fn the_generated_bundle_is_the_same_every_time_and_its_links_resolve() {
    let (a, b) = (support::Bundle::generate(40), support::Bundle::generate(40));
    let files = |root: &std::path::Path| {
        let mut all: Vec<(String, String)> = walk(root, root)
            .into_iter()
            .map(|p| (p.clone(), std::fs::read_to_string(root.join(&p)).unwrap()))
            .collect();
        all.sort();
        all
    };
    let (fa, fb) = (files(&a.root), files(&b.root));
    assert_eq!(fa, fb);
    assert_eq!(fa.len(), a.pages);

    // Every link points at a page that exists, so `related` and backlinks have work to do.
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_tessela"))
        .args(["lint", "--json"])
        .arg(&a.root)
        .output()
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    let broken: Vec<_> = json["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|d| d["rule"].as_str().is_some_and(|r| r.contains("link")))
        .collect();
    assert!(broken.is_empty(), "broken links: {broken:?}");
}

fn walk(root: &std::path::Path, dir: &std::path::Path) -> Vec<String> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            out.extend(walk(root, &path));
        } else {
            out.push(
                path.strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
            );
        }
    }
    out
}
