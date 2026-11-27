//! `tessela blocks` and the span fields of `query`: the shape of a page, as the conventions
//! (§3) read it. The editor's page model is checked against this output.

use std::process::Command;

use serde_json::Value;

const PAGE: &str = "---\ntype: concept\n---\n\n# Top #area\n\nIntro\n- item\n  ```\n  code\n  ```\n  > [!NOTE]\n  > careful\n\n## Sub\n\nText\n\n# Next\n";

fn bundle(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("tessela-blocks-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("page.md"), PAGE).unwrap();
    dir
}

fn run(args: &[&str]) -> (Option<i32>, Value) {
    let out = Command::new(env!("CARGO_BIN_EXE_tessela"))
        .args(args)
        .output()
        .unwrap();
    let json = serde_json::from_slice(&out.stdout)
        .unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&out.stdout)));
    (out.status.code(), json)
}

#[test]
fn blocks_gives_kinds_spans_parents_and_sections() {
    let dir = bundle("shape");
    let (code, json) = run(&["blocks", "page", "-b", dir.to_str().unwrap(), "--json"]);
    assert_eq!(code, Some(0));
    assert_eq!(json["page"], "page");

    let blocks = json["blocks"].as_array().unwrap();
    let rows: Vec<_> = blocks
        .iter()
        .map(|b| {
            (
                b["kind"].as_str().unwrap(),
                b["line"].as_u64().unwrap(),
                b["end_line"].as_u64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        [
            ("paragraph", 7, 13),
            ("item", 8, 13),
            ("code", 9, 11),
            ("callout", 12, 13),
            ("paragraph", 17, 17),
        ]
    );
    // The item is a child of the paragraph above it, the code and the callout of the item.
    assert!(blocks[0]["parent"].is_null());
    assert_eq!(blocks[1]["parent"], blocks[0]["handle"]);
    assert_eq!(blocks[2]["parent"], blocks[1]["handle"]);
    assert_eq!(blocks[3]["parent"], blocks[1]["handle"]);

    let headings = json["headings"].as_array().unwrap();
    let rows: Vec<_> = headings
        .iter()
        .map(|h| {
            (
                h["text"].as_str().unwrap(),
                h["line"].as_u64().unwrap(),
                h["end_line"].as_u64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        [("Top #area", 5, 17), ("Sub", 15, 17), ("Next", 19, 19)]
    );
    assert_eq!(headings[1]["parent"], headings[0]["handle"]);
    // A block names the heading whose section it is in.
    assert_eq!(blocks[0]["section"], headings[0]["handle"]);
    assert_eq!(blocks[4]["section"], headings[1]["handle"]);
}

#[test]
fn query_hits_carry_the_span_and_the_kind() {
    let dir = bundle("hits");
    let (_, json) = run(&[
        "query",
        dir.to_str().unwrap(),
        "--page",
        "page",
        "--ref",
        "area",
        "--json",
    ]);
    let hits = json["hits"].as_array().unwrap();
    let find = |kind: &str, line: u64| {
        hits.iter()
            .find(|h| h["kind"] == kind && h["line"] == line)
            .unwrap_or_else(|| panic!("no {kind} hit at line {line}: {json}"))
    };
    let heading = find("heading", 5);
    assert_eq!(heading["end_line"], 17);
    assert!(heading["block_kind"].is_null());
    let callout = find("block", 12);
    assert_eq!(callout["end_line"], 13);
    assert_eq!(callout["block_kind"], "callout");
    // A fence in an item inherits the item's and the heading's references.
    assert_eq!(find("block", 9)["block_kind"], "code");
}

#[test]
fn an_unknown_page_is_a_not_found_error() {
    let dir = bundle("missing");
    let (code, json) = run(&["blocks", "nope", "-b", dir.to_str().unwrap(), "--json"]);
    assert_eq!(code, Some(2));
    assert_eq!(json["error"]["code"], "not-found");
}
