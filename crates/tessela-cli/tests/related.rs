//! `tessela related`: what is mentioned together with a page, and the homes that lead to it.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

fn bundle(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tessela-related-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    for sub in ["project", "journals", "area/deep"] {
        std::fs::create_dir_all(dir.join(sub)).unwrap();
    }
    let write = |name: &str, text: &str| std::fs::write(dir.join(name), text).unwrap();
    let page =
        |title: &str, extra: &str| format!("---\ntype: concept\ntitle: {title}\n{extra}---\n");
    write("rust.md", &page("Rust", ""));
    write("tessela.md", &page("Tessela", "tags: [rust]\n"));
    write("linter.md", &page("Linter", ""));
    write(
        "journals/2026-11-09.md",
        "---\ntype: journal\ntitle: \"2026-11-09\"\ndate: \"2026-11-09\"\n---\n\n\
         Wrote the [linter](/linter.md) in #rust\n\n\
         - Read about #rust and #tessela\n\n\
         # Day #rust\n\nunder a heading #tessela\n\nplain\n",
    );
    write(
        "journals/2026-11-10.md",
        "---\ntype: journal\ntitle: \"2026-11-10\"\ndate: \"2026-11-10\"\n---\n\n\
         #rust and #tessela again, with #unwritten\n\n#rust/async is nested in rust\n",
    );
    write(
        "home.md",
        "---\ntype: home\ntitle: Home\n---\n\nStart at [Project](/project/home.md) and [Area](/area/home.md).\n",
    );
    write(
        "project/home.md",
        "---\ntype: home\ntitle: Project\n---\n\nSee [the plan](/project/plan.md).\n",
    );
    write("project/plan.md", &page("Plan", ""));
    write("area/home.md", "---\ntype: home\ntitle: Area\n---\n");
    write("area/deep/lonely.md", &page("Lonely", ""));
    dir
}

fn related(dir: &Path, name: &str) -> Value {
    let out = Command::new(env!("CARGO_BIN_EXE_tessela"))
        .args([
            "related",
            name,
            "--bundle",
            dir.to_str().unwrap(),
            "--json",
            "--api",
            "2",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}

#[test]
fn pages_mentioned_together_with_their_reasons() {
    let dir = bundle("together");
    let answer = related(&dir, "rust");
    assert_eq!(answer["page"]["title"], "Rust");
    let together: Vec<(&str, u64, &str)> = answer["together"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| {
            (
                t["concept"].as_str().unwrap(),
                t["blocks"].as_u64().unwrap(),
                t["reason"].as_str().unwrap(),
            )
        })
        .collect();
    // Tessela: the bullet, the block under the `#rust` heading and the journal line of the
    // 10th (two pages), and its own page is tagged `rust`. `rust/async` is nested in rust,
    // so it is not another page; an unwritten concept is listed without a page.
    assert_eq!(
        together,
        [
            (
                "tessela",
                3,
                "together in 3 blocks on 2 pages and in the properties of 1 page"
            ),
            ("linter", 1, "together in 1 block"),
            ("unwritten", 1, "together in 1 block"),
        ]
    );
    assert_eq!(answer["together"][0]["page"]["path"], "tessela.md");
    assert!(answer["together"][2]["page"].is_null());
    // `--limit` is applied after the ranking.
    let one = Command::new(env!("CARGO_BIN_EXE_tessela"))
        .args([
            "related",
            "rust",
            "--limit",
            "1",
            "--bundle",
            dir.to_str().unwrap(),
            "--json",
        ])
        .output()
        .unwrap();
    let one: Value = serde_json::from_slice(&one.stdout).unwrap();
    assert_eq!(one["together"].as_array().unwrap().len(), 1);
}

#[test]
fn the_chain_of_home_pages_that_leads_to_a_page() {
    let dir = bundle("chain");
    let by_links = related(&dir, "project/plan");
    assert_eq!(by_links["chain_by"], "links");
    let titles = |v: &Value| -> Vec<String> {
        v["chain"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["title"].as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(titles(&by_links), ["Home", "Project"]);
    // Nothing links to it, so the homes of its folders stand in.
    let by_folders = related(&dir, "area/deep/lonely");
    assert_eq!(by_folders["chain_by"], "folders");
    assert_eq!(titles(&by_folders), ["Home", "Area"]);
    // The root home page itself has no chain.
    assert!(
        related(&dir, "home")["chain"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
