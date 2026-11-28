//! Speed budgets for the commands that read a bundle, on a generated bundle of 3,000 topics
//! (see `tests/support`). Each command runs cold, with no parse cache, and then warm. Two
//! kinds of check:
//!
//! - pages parsed per call: exact, so it never flakes; a command that needs one page must
//!   parse one page, and a warm call that loads the bundle parses none;
//! - wall-clock time: generous, because CI runners are noisy. The budget is the limit for a
//!   release build; the test binary is built without optimisations, so debug builds get a
//!   multiplier. `TESSELA_BUDGET_SCALE` scales it further (a slow machine, a profiler).
//!
//! Each speed PR lowers the numbers in `support::COMMANDS` for what it speeds up.

mod support;

use support::{COMMANDS, SIZES, measure};

fn scale() -> f64 {
    let debug = if cfg!(debug_assertions) { 3.0 } else { 1.0 };
    let extra = std::env::var("TESSELA_BUDGET_SCALE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1.0);
    debug * extra
}

#[test]
fn every_command_stays_within_its_budget_at_3000_topics() {
    let bundle = support::Bundle::generate(SIZES[2]);
    let mut over = Vec::new();
    for case in COMMANDS {
        let m = measure(case, &bundle.root, 2);
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
        // Only the warm time has a budget. A cold call writes a file for every page, and how
        // long that takes is up to the file system (a few hundred ms to over a second on one
        // that is busy deleting): the parse counts above are what holds a cold call to account.
        let budget = case.warm_ms * scale();
        if m.warm.ms > budget {
            over.push(format!(
                "{} warm: {:.0} ms, budget {budget:.0} ms",
                case.name, m.warm.ms
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
