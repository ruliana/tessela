//! `Bundle::load_for` parses only the files a query could find something in. Whatever it
//! skips, `Query::run` has to answer exactly what it answers on a full load: the check on raw
//! bytes may admit too much, never too little. The random bundles are written from a small
//! vocabulary that holds every trap for it: case in other scripts, escapes and numbers in
//! front matter, entities in links, aliases, relative links, folded lines.

mod support;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use proptest::prelude::*;
use proptest::sample::select;
use support::config;
use tessela_core::{Bundle, Query};

fn scratch() -> PathBuf {
    static N: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "tessela-prefilter-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(dir: &std::path::Path, files: &[(String, Vec<u8>)]) {
    for (path, bytes) in files {
        let file = dir.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, bytes).unwrap();
    }
}

/// What a query answers on the bundle in `dir`, loaded whole and loaded for the query.
fn answers(dir: &std::path::Path, query: &Query) -> (String, String) {
    let hits = |bundle: Bundle| format!("{:#?}", query.run(&bundle));
    (
        hits(Bundle::load(dir).unwrap()),
        hits(Bundle::load_for(dir, query).unwrap()),
    )
}

/// Words that a query and a file can share, written in the ways that differ in bytes.
const VOCAB: &[&str] = &[
    "rust", "Rust", "RUST", "foo", "Foo", "bar", "foo-bar", "Foo Bar", "x", "a", "e", "é", "É",
    "café", "ΑΣ", "ας", "Σ", "σ", "ς", "\u{212A}", "k", "K", "İ", "i", "ß", "ss", "16", "e3",
    "1e3", "1.5", "true", "inf", "日本", "Rust2",
];

fn word() -> impl Strategy<Value = &'static str> {
    select(VOCAB)
}

/// A line of Markdown, with the words used as text, tags, link targets and the like.
fn line() -> impl Strategy<Value = String> {
    (word(), word(), 0..16usize).prop_map(|(a, b, shape)| match shape {
        0 => format!("{a} {b}"),
        1 => format!("- {a} #{b}"),
        2 => format!("  - {a} [t]({b}.md)"),
        3 => format!("# {a} #{b}"),
        4 => format!("> {a}\n> {b}"),
        5 => format!("- {a}\n  {b}"),
        6 => format!("[t](../{a}/{b}.md) #{a}/{b}"),
        7 => format!("[t](<{a} {b}.md>)"),
        8 => format!("[t](&#102;oo.md) {a}"),
        9 => format!("[t](&eacute;.md) {b}"),
        10 => format!("[t](\\_{a}.md)"),
        11 => format!("```\n{a} #{b}\n```"),
        12 => format!("| {a} | {b} |\n|---|---|\n| {b} | {a} |"),
        13 => format!("[ref]: /{a}.md\n[t][ref]"),
        14 => format!("- [ ] {a}\n  - {b} #{a}"),
        _ => format!("{a}\n\n{b}"),
    })
}

/// Front matter: plain, aliased, escaped, numeric, folded, quoted, or broken.
fn front() -> impl Strategy<Value = String> {
    (word(), word(), 0..14usize).prop_map(|(a, b, shape)| match shape {
        0 | 1 => String::new(),
        2 => format!("---\ntitle: {a}\ntype: note\ntags: [{b}, \"{a}\"]\n---\n"),
        3 => format!("---\naliases: [{a}]\n---\n"),
        4 => format!("---\naliases: {a}\ntitle: {b}\n---\n"),
        5 => "---\n\"\\u0061liases\": [Foo]\ntitle: \"\\u0072ust \\x42\"\n---\n".to_string(),
        6 => format!("---\ntitle: \"{a} \\u00e9 \\\" \\\n  {b}\"\n---\n"),
        7 => "---\nn: 16\nx: 0x10\nf: 1e3\ng: 1.50\nb: True\nd: .INF\nbig: 1000000000000000000000.0\n---\n"
            .to_string(),
        8 => format!("---\ndescription: >\n  {a}\n  {b}\n---\n"),
        9 => format!("---\ndescription: 'it''s {a}'\nlinks: \"[t](/{b}.md) #{a}\"\n---\n"),
        10 => format!("---\ntitle: {a}\n"),
        11 => format!("---\ntags:\n  - {a}\n  - {b}\n---\n"),
        12 => format!("---\ntype: note\nbase: &base\n  aliases: [{a}]\nmerged:\n  <<: *base\n---\n"),
        _ => format!("---\ntitle: |\n  {a}\n   {b}\n---\n"),
    })
}

fn files() -> impl Strategy<Value = Vec<(String, Vec<u8>)>> {
    let path = (
        select(&["", "a/", "rust/", "Rust/", "foo/", "ΑΣ/", "é/", "a/foo/"][..]),
        select(&["x", "rust", "foo", "y", "Bar"][..]),
    )
        .prop_map(|(dir, name)| format!("{dir}{name}.md"));
    let page = (front(), proptest::collection::vec(line(), 0..6))
        .prop_map(|(f, body)| format!("{f}{}\n", body.join("\n")).into_bytes());
    // Some files are not text at all, and some are not Markdown.
    let junk = prop_oneof![
        8 => page,
        1 => Just(vec![0xff, 0xfe, b'x', b'\n']),
    ];
    proptest::collection::btree_map(path, junk, 1..9).prop_map(|m| m.into_iter().collect())
}

/// A name to ask for: a word, as a tag or alone.
fn asked() -> impl Strategy<Value = String> {
    (word(), any::<bool>()).prop_map(|(w, hash)| if hash { format!("#{w}") } else { w.to_string() })
}

fn query() -> impl Strategy<Value = Query> {
    (
        proptest::collection::vec(asked(), 0..3),
        proptest::collection::vec(
            prop_oneof![
                3 => word().prop_map(str::to_string),
                1 => (word(), word()).prop_map(|(a, b)| format!("{a} {b}")),
                1 => (word(), word()).prop_map(|(a, b)| format!("{a}\n{b}")),
            ],
            0..3,
        ),
        (any::<bool>(), any::<bool>(), any::<bool>()),
        prop_oneof![
            4 => Just(None),
            1 => select(&["x", "rust/foo", "a/", "Rust/", "foo/x.md"][..]).prop_map(|p| Some(p.to_string())),
        ],
    )
        .prop_map(|(refs, text, (any, own, meta), page)| Query {
            refs,
            any,
            own,
            text,
            meta,
            page,
            ..Query::default()
        })
}

proptest! {
    #![proptest_config(config(400))]

    #[test]
    fn a_load_for_the_query_answers_like_a_full_load(files in files(), query in query()) {
        let dir = scratch();
        write(&dir, &files);
        let (full, filtered) = answers(&dir, &query);
        let _ = std::fs::remove_dir_all(&dir);
        prop_assert_eq!(filtered, full);
    }
}

/// Each way the bytes of a file differ from what a query sees, with a query that finds the
/// file only because of it. The answers must not be empty, or the case proves nothing.
#[test]
fn the_places_where_bytes_and_text_differ_are_all_covered() {
    let words = |t: &str| Query {
        text: vec![t.to_string()],
        meta: true,
        ..Query::default()
    };
    let concept = |c: &str| Query {
        refs: vec![c.to_string()],
        ..Query::default()
    };
    #[allow(clippy::type_complexity)]
    let cases: Vec<(&str, Vec<(&str, &str)>, Query)> = vec![
        (
            "case in another script",
            vec![("a.md", "ÉCOLE here\n")],
            words("école"),
        ),
        ("final sigma", vec![("a.md", "ΑΣ here\n")], words("ας")),
        (
            "kelvin sign lowercases to k",
            vec![("a.md", "\u{212A}ilo\n")],
            words("kilo"),
        ),
        (
            "yaml escape",
            vec![("a.md", "---\ntitle: \"caf\\u00e9\"\n---\n")],
            words("café"),
        ),
        (
            "yaml number written as hex",
            vec![("a.md", "---\nn: 0x10\n---\n")],
            words("16"),
        ),
        (
            "yaml float",
            vec![("a.md", "---\nn: 1e3\n---\n")],
            words("1000"),
        ),
        (
            "yaml folded line",
            vec![("a.md", "---\nt: >\n  foo\n  bar\n---\n")],
            words("foo bar"),
        ),
        (
            "item continuation",
            vec![("a.md", "- foo\n    bar\n")],
            words("bar"),
        ),
        (
            "tag in another case",
            vec![("a.md", "x #Rust/Async\n")],
            concept("rust"),
        ),
        (
            "link made of an entity",
            vec![("a.md", "[t](&#102;oo.md)\n")],
            concept("foo"),
        ),
        (
            "link made of a name",
            vec![("a.md", "[t](&eacute;cole.md)\n")],
            concept("école"),
        ),
        (
            "link with a space",
            vec![("a.md", "[t](<Foo   Bar.md>)\n")],
            concept("foo-bar"),
        ),
        (
            "relative link, folder in the path",
            vec![("rust/a.md", "[t](async.md)\n")],
            concept("rust"),
        ),
        (
            "frontmatter tag with a space",
            vec![("a.md", "---\ntags: [Foo Bar]\n---\n")],
            concept("foo-bar"),
        ),
        (
            "page hit named by its path",
            vec![("ΑΣ/x.md", "---\ntags: [rust]\n---\n")],
            Query {
                refs: vec!["rust".into()],
                text: vec!["ας".into()],
                ..Query::default()
            },
        ),
        (
            "alias of a page",
            vec![("p.md", "---\naliases: [Zed]\n---\n"), ("a.md", "see #p\n")],
            concept("zed"),
        ),
        (
            "escaped key",
            vec![
                ("p.md", "---\n\"\\u0061liases\": [Zed]\n---\n"),
                ("a.md", "see #p\n"),
            ],
            concept("zed"),
        ),
    ];
    for (name, files, query) in cases {
        let dir = scratch();
        let files: Vec<_> = files
            .into_iter()
            .map(|(p, t)| (p.to_string(), t.as_bytes().to_vec()))
            .collect();
        write(&dir, &files);
        let (full, filtered) = answers(&dir, &query);
        let _ = std::fs::remove_dir_all(&dir);
        assert_ne!(
            full, "[]",
            "{name}: the full answer is empty, so the case proves nothing"
        );
        assert_eq!(filtered, full, "{name}");
    }
}

/// A file the query rules out is not parsed, and one the `page` filter rules out is not read.
#[test]
fn what_the_query_rules_out_is_left_out_of_the_load() {
    let dir = scratch();
    write(
        &dir,
        &[
            ("a/x.md".into(), b"#zed\n".to_vec()),
            ("a/y.md".into(), b"plain text\n".to_vec()),
            ("b/z.md".into(), b"more text\n".to_vec()),
            // Not text: only a file that is read can be found out.
            ("c/bad.md".into(), vec![0xff, 0xfe]),
        ],
    );
    let paths = |q: &Query| -> Vec<String> {
        let bundle = Bundle::load_for(&dir, q).unwrap();
        bundle.pages.iter().map(|p| p.path.clone()).collect()
    };
    let concept = Query {
        refs: vec!["zed".into()],
        ..Query::default()
    };
    assert_eq!(paths(&concept), ["a/x.md"]);
    let words = Query {
        text: vec!["MORE".into()],
        ..Query::default()
    };
    assert_eq!(paths(&words), ["b/z.md"]);
    let page = Query {
        page: Some("a/".into()),
        ..Query::default()
    };
    assert_eq!(paths(&page), ["a/x.md", "a/y.md"]);
    assert!(Bundle::load_for(&dir, &page).unwrap().unreadable.is_empty());
    // Nothing to rule out: everything is loaded, as `load` does.
    assert_eq!(paths(&Query::default()).len(), 3);
    let _ = std::fs::remove_dir_all(&dir);
}
