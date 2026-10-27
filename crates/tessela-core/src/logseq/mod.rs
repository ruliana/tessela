//! Import a Logseq graph into a Tessela bundle (spec §12).

mod outline;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::{Captures, Regex};
use serde::Serialize;

use outline::{Analyzed, Marker, Outline, analyze, parse};

#[derive(Debug, Default, Clone, Serialize)]
pub struct Report {
    pub pages: usize,
    pub journals: usize,
    pub blocks: usize,
    pub properties_converted: usize,
    pub block_refs_inlined: usize,
    pub unresolved_block_refs: usize,
    /// Logseq macros such as `{{query ...}}` that were copied as they are.
    pub macros_left: usize,
    pub assets_copied: usize,
    pub empty_pages_skipped: usize,
    pub skipped: Vec<Skipped>,
    /// Pages that had to be written under another name, as `(page, file)`.
    pub renamed: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Skipped {
    pub path: String,
    pub reason: String,
}

enum Kind {
    Page,
    /// A journal, with its day as `YYYY-MM-DD`.
    Journal(String),
}

struct Source {
    kind: Kind,
    title: String,
    outline: Outline,
}

static EMBED_BLOCK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{\{embed \(\(([0-9a-fA-F-]{36})\)\)\}\}").unwrap());
static BLOCK_REF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\(\(([0-9a-fA-F-]{36})\)\)").unwrap());
static EMBED_PAGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{\{embed \[\[(.+?)\]\]\}\}").unwrap());
static LABELED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[([^\]]*)\]\(\[\[(.+?)\]\]\)").unwrap());
static TAG_LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"#\[\[(.+?)\]\]").unwrap());
static PAGE_LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[\[(.+?)\]\]").unwrap());
static PRIORITY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[#([A-Ca-c])\]").unwrap());
static TIMESTAMP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"<(\d{4}-\d{2}-\d{2})(?: [A-Za-z]{3})?(?: (\d{2}:\d{2}))?[^>]*>").unwrap()
});
static MACRO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{\{[^}]*\}\}").unwrap());
static JOURNAL_TITLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$").unwrap()
});
static ISO_DAY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap());
static SIMPLE_VALUE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\p{L}\p{N}_-]+$").unwrap());

/// Imports the Logseq graph in `graph` into a new bundle in `out`. `out` must not
/// exist or must be an empty folder, so an import never overwrites anything.
pub fn import(graph: &Path, out: &Path) -> io::Result<Report> {
    if !graph.join("pages").is_dir() && !graph.join("journals").is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "{} does not look like a Logseq graph: it has no `pages` or `journals` folder",
                graph.display()
            ),
        ));
    }
    if out.exists() && (!out.is_dir() || out.read_dir()?.next().is_some()) {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("{} already exists and is not empty", out.display()),
        ));
    }
    let mut report = Report::default();
    let sources = read_sources(graph, &mut report)?;
    let importer = Importer::new(sources, report);
    importer.write(graph, out)
}

fn read_sources(graph: &Path, report: &mut Report) -> io::Result<Vec<Source>> {
    let mut sources = Vec::new();
    for dir in ["pages", "journals"] {
        let folder = graph.join(dir);
        if !folder.is_dir() {
            continue;
        }
        let mut files: Vec<PathBuf> = folder
            .read_dir()?
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.is_file())
            .collect();
        files.sort();
        for path in files {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            let rel = format!("{dir}/{name}");
            if name.starts_with('.') {
                continue;
            }
            let Some(stem) = name.strip_suffix(".md") else {
                let reason = if name.ends_with(".org") {
                    "org-mode files are not supported"
                } else {
                    "not a markdown file"
                };
                report.skipped.push(Skipped {
                    path: rel,
                    reason: reason.into(),
                });
                continue;
            };
            let Ok(text) = std::fs::read_to_string(&path) else {
                report.skipped.push(Skipped {
                    path: rel,
                    reason: "not valid UTF-8".into(),
                });
                continue;
            };
            let outline = parse(&text);
            let journal_day = (dir == "journals")
                .then(|| journal_file_day(stem))
                .flatten();
            let named = outline
                .props
                .iter()
                .find(|(k, _)| k == "title")
                .map(|(_, v)| v.clone());
            let (kind, title) = match journal_day {
                Some(day) => (Kind::Journal(day.clone()), day),
                None => (Kind::Page, named.unwrap_or_else(|| title_from_file(stem))),
            };
            sources.push(Source {
                kind,
                title,
                outline,
            });
        }
    }
    let whiteboards = graph.join("whiteboards");
    if whiteboards.is_dir() && whiteboards.read_dir()?.next().is_some() {
        report.skipped.push(Skipped {
            path: "whiteboards".into(),
            reason: "whiteboards are not supported".into(),
        });
    }
    Ok(sources)
}

/// `2026_10_27` becomes `2026-10-27`.
fn journal_file_day(stem: &str) -> Option<String> {
    let day = stem.replace('_', "-");
    ISO_DAY.is_match(&day).then_some(day)
}

/// Logseq writes a namespace `a/b` as `a___b` (or `a%2Fb`) and percent-encodes odd characters.
fn title_from_file(stem: &str) -> String {
    percent_decode(&stem.replace("___", "/"))
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(hex) = s.get(i + 1..i + 3)
            && let Ok(byte) = u8::from_str_radix(hex, 16)
        {
            out.push(byte);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

/// A page name as a bundle path without `.md`: lowercase, words joined by `-`, `/` kept.
fn base_slug(name: &str) -> String {
    let parts: Vec<String> = name
        .split('/')
        .map(|part| {
            let mut out = String::new();
            let mut dash = false;
            for c in part.trim().chars().flat_map(char::to_lowercase) {
                if c.is_alphanumeric() || c == '_' {
                    out.push(c);
                    dash = false;
                } else if !dash && !out.is_empty() {
                    out.push('-');
                    dash = true;
                }
            }
            out.trim_end_matches('-').to_string()
        })
        .filter(|p| !p.is_empty())
        .collect();
    let slug = parts.join("/");
    if slug.is_empty() {
        return "untitled".into();
    }
    // `index.md` and `log.md` are reserved by OKF.
    match slug.rsplit('/').next() {
        Some("index" | "log") => format!("{slug}-page"),
        _ => slug,
    }
}

fn split_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(|v| {
            v.trim()
                .trim_start_matches('#')
                .trim_start_matches("[[")
                .trim_end_matches("]]")
                .trim()
                .to_string()
        })
        .filter(|v| !v.is_empty())
        .collect()
}

fn internal_key(key: &str) -> bool {
    matches!(
        key,
        "id" | "collapsed" | "heading" | "background-color" | "ls-type" | "filters"
    ) || key.starts_with("logseq.")
        || key.starts_with("hl-")
        || key.starts_with("card-")
}

fn yaml_str(s: &str) -> String {
    let escaped = s
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n");
    format!("\"{escaped}\"")
}

fn yaml_key(key: &str) -> String {
    let key: String = key
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    match key.as_str() {
        "type" | "title" | "date" | "tags" | "aliases" => format!("logseq-{key}"),
        _ => key,
    }
}

struct Importer {
    sources: Vec<Source>,
    /// Block `id::` to the text of that block.
    blocks_by_id: HashMap<String, String>,
    /// Alias (lowercase) to the title of the page that declares it.
    aliases: HashMap<String, String>,
    /// Page title (lowercase) to its path in the bundle, without `.md`.
    slugs: HashMap<String, String>,
    report: RefCell<Report>,
}

impl Importer {
    fn new(sources: Vec<Source>, mut report: Report) -> Importer {
        let mut blocks_by_id = HashMap::new();
        let mut aliases = HashMap::new();
        for source in &sources {
            for block in &source.outline.blocks {
                let a = analyze(block);
                if let Some((_, id)) = a.props.iter().find(|(k, _)| k == "id") {
                    blocks_by_id.insert(id.to_lowercase(), a.inline_text());
                }
            }
            for (key, value) in &source.outline.props {
                if key == "alias" || key == "aliases" {
                    for alias in split_list(value) {
                        aliases.insert(alias.to_lowercase(), source.title.clone());
                    }
                }
            }
        }

        let mut slugs = HashMap::new();
        let mut used: HashSet<String> = HashSet::new();
        for source in &sources {
            let slug = match &source.kind {
                Kind::Journal(day) => format!("journals/{day}"),
                Kind::Page => {
                    let base = base_slug(&source.title);
                    let mut slug = base.clone();
                    let mut n = 2;
                    while used.contains(&slug) {
                        slug = format!("{base}-{n}");
                        n += 1;
                    }
                    if slug != base {
                        report
                            .renamed
                            .push((source.title.clone(), format!("{slug}.md")));
                    }
                    slug
                }
            };
            used.insert(slug.clone());
            slugs.insert(source.title.to_lowercase(), slug);
        }
        Importer {
            sources,
            blocks_by_id,
            aliases,
            slugs,
            report: RefCell::new(report),
        }
    }

    /// The bundle path (without `.md`) that a link to the page `name` points to.
    fn target_of(&self, name: &str) -> String {
        let name = name.trim();
        if let Some(day) = journal_title_day(name) {
            return format!("journals/{day}");
        }
        let key = name.to_lowercase();
        let key = self
            .aliases
            .get(&key)
            .map_or(key, |main| main.to_lowercase());
        self.slugs
            .get(&key)
            .cloned()
            .unwrap_or_else(|| base_slug(&key))
    }

    fn link(&self, name: &str) -> String {
        let name = name.trim();
        let target = self.target_of(name);
        let label = journal_title_day(name).unwrap_or_else(|| name.to_string());
        format!("[{label}](/{target}.md)")
    }

    /// Converts the inline syntax of one line of text, leaving `code spans` alone.
    fn inline(&self, text: &str, depth: usize) -> String {
        let mut out = String::new();
        let mut rest = text;
        while let Some(start) = rest.find('`') {
            let Some(len) = rest[start + 1..].find('`') else {
                break;
            };
            out.push_str(&self.plain(&rest[..start], depth));
            out.push_str(&rest[start..start + len + 2]);
            rest = &rest[start + len + 2..];
        }
        out.push_str(&self.plain(rest, depth));
        out
    }

    fn quoted_block(&self, id: &str, depth: usize) -> String {
        let found = (depth < 6)
            .then(|| self.blocks_by_id.get(&id.to_lowercase()))
            .flatten();
        match found {
            Some(text) => {
                self.report.borrow_mut().block_refs_inlined += 1;
                self.inline(text, depth + 1)
            }
            None => {
                self.report.borrow_mut().unresolved_block_refs += 1;
                "(unresolved block reference)".into()
            }
        }
    }

    fn plain(&self, text: &str, depth: usize) -> String {
        let text = EMBED_BLOCK.replace_all(text, |c: &Captures| self.quoted_block(&c[1], depth));
        let text = BLOCK_REF.replace_all(&text, |c: &Captures| self.quoted_block(&c[1], depth));
        let text = EMBED_PAGE.replace_all(&text, "[[$1]]");
        let text = LABELED.replace_all(&text, |c: &Captures| {
            let target = self.target_of(&c[2]);
            format!("[{}](/{target}.md)", &c[1])
        });
        let text = TAG_LINK.replace_all(&text, |c: &Captures| self.link(&c[1]));
        let text = PAGE_LINK.replace_all(&text, |c: &Captures| self.link(&c[1]));
        let text = PRIORITY.replace_all(&text, |c: &Captures| {
            format!("#priority/{}", c[1].to_lowercase())
        });
        let text = text.replace("](../assets/", "](/assets/");
        let text = TIMESTAMP.replace_all(&text, |c: &Captures| match c.get(2) {
            Some(time) => format!("{} {}", &c[1], time.as_str()),
            None => c[1].to_string(),
        });
        self.report.borrow_mut().macros_left += MACRO.find_iter(&text).count();
        text.into_owned()
    }

    /// A block property as text that carries its meaning as references (spec §12).
    fn property(&self, key: &str, value: &str) -> Option<String> {
        if internal_key(key) || value.trim().is_empty() {
            return None;
        }
        let value = value.trim();
        let key_page = base_slug(key);
        let text = if key == "tags" || key == "tag" {
            let tags: Vec<String> = split_list(value)
                .iter()
                .map(|t| format!("#{}", base_slug(t)))
                .collect();
            tags.join(" ")
        } else if !value.contains("[[") && SIMPLE_VALUE.is_match(value) {
            format!("#{key_page}/{}", base_slug(value))
        } else {
            format!("[{key}](/{key_page}.md): {}", self.inline(value, 0))
        };
        self.report.borrow_mut().properties_converted += 1;
        Some(text)
    }

    /// The lines of one block as Markdown text, without its position in the outline.
    fn block_lines(&self, a: &Analyzed) -> Vec<String> {
        let mut in_fence = false;
        let mut lines: Vec<String> = a
            .lines
            .iter()
            .map(|line| {
                let converted = if in_fence {
                    line.clone()
                } else {
                    self.inline(line, 0)
                };
                if line.matches("```").count() % 2 == 1 {
                    in_fence = !in_fence;
                }
                converted
            })
            .collect();
        if let Some(first) = lines.first_mut()
            && !first.trim().is_empty()
        {
            if a.heading {
                // Headings in Tessela scope the blocks below them; a Logseq heading is only formatting.
                *first = format!("**{first}**");
            }
            *first = match a.marker {
                Some(Marker::Todo) => format!("[ ] {first}"),
                Some(Marker::Done) => format!("[x] {first}"),
                Some(Marker::Canceled) => format!("[x] ~~{first}~~"),
                None => first.clone(),
            };
            *first = escape_start(first);
        }
        let props: Vec<String> = a
            .props
            .iter()
            .filter_map(|(k, v)| self.property(k, v))
            .collect();
        if !props.is_empty() {
            lines.push(props.join(" · "));
        }
        lines
    }

    fn body(&self, outline: &Outline) -> String {
        let mut out = String::new();
        // Depths of empty bullets that were dropped; their children move up a level.
        let mut dropped: Vec<usize> = Vec::new();
        let mut previous = 0usize;
        let mut first = true;
        for block in &outline.blocks {
            while dropped.last().is_some_and(|&d| d >= block.depth) {
                dropped.pop();
            }
            let analyzed = analyze(block);
            if analyzed.is_empty() {
                dropped.push(block.depth);
                continue;
            }
            let depth = if first {
                0
            } else {
                (block.depth - dropped.len()).min(previous + 1)
            };
            let lines = self.block_lines(&analyzed);
            self.report.borrow_mut().blocks += 1;
            if depth == 0 {
                if !out.is_empty() {
                    out.push('\n');
                }
                for line in &lines {
                    out.push_str(line);
                    out.push('\n');
                }
            } else {
                let indent = "  ".repeat(depth - 1);
                for (i, line) in lines.iter().enumerate() {
                    match (i, line.is_empty()) {
                        (0, _) => out.push_str(&format!("{indent}- {line}\n")),
                        (_, true) => out.push('\n'),
                        _ => out.push_str(&format!("{indent}  {line}\n")),
                    }
                }
            }
            previous = depth;
            first = false;
        }
        out
    }

    fn frontmatter(&self, source: &Source) -> String {
        let mut lines = vec!["---".to_string()];
        match &source.kind {
            Kind::Journal(day) => {
                lines.push("type: journal".into());
                lines.push(format!("title: {}", yaml_str(day)));
                lines.push(format!("date: {}", yaml_str(day)));
            }
            Kind::Page => {
                lines.push("type: concept".into());
                lines.push(format!("title: {}", yaml_str(&source.title)));
            }
        }
        let mut tags = Vec::new();
        let mut aliases = Vec::new();
        let mut other = Vec::new();
        for (key, value) in &source.outline.props {
            match key.as_str() {
                "title" => {}
                "tags" | "tag" => tags.extend(split_list(value).iter().map(|t| base_slug(t))),
                "alias" | "aliases" => aliases.extend(split_list(value)),
                k if internal_key(k) || value.trim().is_empty() => {}
                k => {
                    self.report.borrow_mut().properties_converted += 1;
                    other.push(format!(
                        "{}: {}",
                        yaml_key(k),
                        yaml_str(&self.inline(value, 0))
                    ));
                }
            }
        }
        let list = |name: &str, items: &[String]| {
            let items: Vec<String> = items.iter().map(|i| yaml_str(i)).collect();
            format!("{name}: [{}]", items.join(", "))
        };
        if !tags.is_empty() {
            lines.push(list("tags", &tags));
        }
        if !aliases.is_empty() {
            lines.push(list("aliases", &aliases));
        }
        lines.extend(other);
        lines.push("---".into());
        lines.join("\n") + "\n"
    }

    fn write(self, graph: &Path, out: &Path) -> io::Result<Report> {
        std::fs::create_dir_all(out)?;
        for source in &self.sources {
            let body = self.body(&source.outline);
            let has_props = source
                .outline
                .props
                .iter()
                .any(|(k, v)| k != "title" && !internal_key(k) && !v.trim().is_empty());
            if body.trim().is_empty() && !has_props {
                self.report.borrow_mut().empty_pages_skipped += 1;
                continue;
            }
            let slug = &self.slugs[&source.title.to_lowercase()];
            let path = out.join(format!("{slug}.md"));
            std::fs::create_dir_all(path.parent().unwrap())?;
            let mut content = self.frontmatter(source);
            if !body.trim().is_empty() {
                content.push('\n');
                content.push_str(&body);
            }
            std::fs::write(path, content)?;
            let mut report = self.report.borrow_mut();
            match source.kind {
                Kind::Journal(_) => report.journals += 1,
                Kind::Page => report.pages += 1,
            }
        }
        let name = graph
            .canonicalize()
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_else(|| "Notes".into());
        std::fs::write(
            out.join("index.md"),
            format!(
                "---\nokf_version: \"0.2\"\n---\n\n# {name}\n\nImported from Logseq with `tessela import-logseq`.\n"
            ),
        )?;
        let assets = graph.join("assets");
        if assets.is_dir() {
            let copied = copy_dir(&assets, &out.join("assets"))?;
            self.report.borrow_mut().assets_copied = copied;
        }
        Ok(self.report.into_inner())
    }
}

fn journal_title_day(name: &str) -> Option<String> {
    if ISO_DAY.is_match(name) {
        return Some(name.to_string());
    }
    let c = JOURNAL_TITLE.captures(name)?;
    let month = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ]
    .iter()
    .position(|m| c[1].len() >= 3 && c[1][..3].eq_ignore_ascii_case(m))?
        + 1;
    let day: u32 = c[2].parse().ok()?;
    (1..=31)
        .contains(&day)
        .then(|| format!("{}-{month:02}-{day:02}", &c[3]))
}

/// Stops a line from turning into a list or a quote by accident.
fn escape_start(line: &str) -> String {
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if digits > 0
        && let Some(rest) = line[digits..].strip_prefix(['.', ')'])
        && rest.starts_with(' ')
    {
        return format!("{}\\{}", &line[..digits], &line[digits..]);
    }
    if line.starts_with(['-', '*', '+']) && line[1..].starts_with(' ') {
        return format!("\\{line}");
    }
    line.to_string()
}

fn copy_dir(from: &Path, to: &Path) -> io::Result<usize> {
    std::fs::create_dir_all(to)?;
    let mut copied = 0;
    for entry in from.read_dir()? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copied += copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
            copied += 1;
        }
    }
    Ok(copied)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn importer(pages: &[(&str, &str)]) -> Importer {
        let sources = pages
            .iter()
            .map(|(title, text)| Source {
                kind: Kind::Page,
                title: title.to_string(),
                outline: parse(text),
            })
            .collect();
        Importer::new(sources, Report::default())
    }

    #[test]
    fn slugs_are_safe_and_avoid_reserved_names() {
        assert_eq!(base_slug("Machine Learning"), "machine-learning");
        assert_eq!(base_slug("Project/Tessela (old)"), "project/tessela-old");
        assert_eq!(base_slug("Index"), "index-page");
        assert_eq!(base_slug("a/log"), "a/log-page");
        assert_eq!(base_slug("🔥"), "untitled");
    }

    #[test]
    fn file_names_are_decoded() {
        assert_eq!(title_from_file("Project___Tessela"), "Project/Tessela");
        assert_eq!(title_from_file("a%2Fb%20c"), "a/b c");
        assert_eq!(title_from_file("100%"), "100%");
        assert_eq!(title_from_file("%é"), "%é");
    }

    #[test]
    fn journal_titles_become_days() {
        assert_eq!(
            journal_title_day("Oct 27th, 2026"),
            Some("2026-10-27".into())
        );
        assert_eq!(
            journal_title_day("March 3rd, 2025"),
            Some("2025-03-03".into())
        );
        assert_eq!(journal_title_day("2026-10-27"), Some("2026-10-27".into()));
        assert_eq!(
            journal_title_day("September 9, 2026"),
            Some("2026-09-09".into())
        );
        assert_eq!(journal_title_day("Octopus 2nd, 2026"), None);
        assert_eq!(journal_title_day("Some page"), None);
    }

    #[test]
    fn links_tags_and_aliases_become_markdown_links() {
        let i = importer(&[
            ("Rust", "alias:: rs, rustlang\n\n- x\n"),
            ("Other", "- y\n"),
        ]);
        assert_eq!(
            i.inline("see [[Rust]] and #[[Machine Learning]]", 0),
            "see [Rust](/rust.md) and [Machine Learning](/machine-learning.md)"
        );
        assert_eq!(i.inline("via [[rs]]", 0), "via [rs](/rust.md)");
        assert_eq!(i.inline("[the lang]([[Rust]])", 0), "[the lang](/rust.md)");
        assert_eq!(
            i.inline("on [[Oct 27th, 2026]]", 0),
            "on [2026-10-27](/journals/2026-10-27.md)"
        );
        assert_eq!(i.inline("plain #tag stays", 0), "plain #tag stays");
    }

    #[test]
    fn code_is_left_alone() {
        let i = importer(&[]);
        assert_eq!(i.inline("`[[x]]` and [[x]]", 0), "`[[x]]` and [x](/x.md)");
    }

    #[test]
    fn block_refs_and_embeds_are_inlined_once() {
        let id = "6500a0b1-0000-4000-8000-000000000001";
        let i = importer(&[(
            "P",
            &format!(
                "- the original [[Idea]]\n  id:: {id}\n- quote: (({id}))\n- {{{{embed (({id}))}}}}\n- gone ((6500a0b1-0000-4000-8000-0000000000ff))\n"
            ),
        )]);
        assert_eq!(
            i.inline(&format!("(({id}))"), 0),
            "the original [Idea](/idea.md)"
        );
        assert_eq!(
            i.inline(&format!("{{{{embed (({id}))}}}}"), 0),
            "the original [Idea](/idea.md)"
        );
        assert_eq!(
            i.inline("((6500a0b1-0000-4000-8000-0000000000ff))", 0),
            "(unresolved block reference)"
        );
        let r = i.report.borrow();
        assert_eq!((r.block_refs_inlined, r.unresolved_block_refs), (2, 1));
    }

    #[test]
    fn a_block_that_quotes_itself_does_not_loop() {
        let id = "6500a0b1-0000-4000-8000-000000000002";
        let i = importer(&[("P", &format!("- loops (({id}))\n  id:: {id}\n"))]);
        let out = i.inline(&format!("(({id}))"), 0);
        assert!(out.contains("(unresolved block reference)"), "{out}");
    }

    #[test]
    fn properties_become_tags_or_links() {
        let i = importer(&[]);
        assert_eq!(i.property("status", "Done").unwrap(), "#status/done");
        assert_eq!(
            i.property("author", "[[Jane Doe]]").unwrap(),
            "[author](/author.md): [Jane Doe](/jane-doe.md)"
        );
        assert_eq!(
            i.property("url", "https://x.org/a").unwrap(),
            "[url](/url.md): https://x.org/a"
        );
        assert_eq!(i.property("tags", "a, [[B c]]").unwrap(), "#a #b-c");
        assert_eq!(i.property("id", "x"), None);
        assert_eq!(i.property("collapsed", "true"), None);
    }

    #[test]
    fn outline_becomes_paragraphs_with_lists_beneath() {
        let i = importer(&[]);
        let o = parse("- top one #a\n\t- child\n\t\t- grandchild\n\t- child two\n- top two\n");
        assert_eq!(
            i.body(&o),
            "top one #a\n- child\n  - grandchild\n- child two\n\ntop two\n"
        );
    }

    #[test]
    fn tasks_headings_and_lookalike_syntax_are_kept_safe() {
        let i = importer(&[]);
        let o = parse(
            "- TODO buy milk\n- DONE [#A] send it\n- ## Section\n- 1. not a list\n- CANCELED nope\n",
        );
        assert_eq!(
            i.body(&o),
            "[ ] buy milk\n\n[x] #priority/a send it\n\n**Section**\n\n1\\. not a list\n\n[x] ~~nope~~\n"
        );
    }

    #[test]
    fn empty_bullets_are_dropped_and_their_children_move_up() {
        let i = importer(&[]);
        let o = parse("- real\n\t-\n\t\t- orphan\n");
        assert_eq!(i.body(&o), "real\n- orphan\n");
    }

    #[test]
    fn colliding_page_names_are_renamed_and_reported() {
        let i = importer(&[("Foo Bar", "- a\n"), ("foo-bar", "- b\n")]);
        assert_eq!(i.slugs["foo bar"], "foo-bar");
        assert_eq!(i.slugs["foo-bar"], "foo-bar-2");
        assert_eq!(i.report.borrow().renamed.len(), 1);
    }
}
