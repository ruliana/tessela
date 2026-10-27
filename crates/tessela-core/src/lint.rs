//! The linter: a list of rules that each look at a whole bundle.
//!
//! Rules are plain trait objects, so more can be added without touching the
//! existing ones, for example semantic rules that need a model or a vocabulary.

use std::collections::{BTreeMap, HashMap};

use regex::Regex;
use serde::Serialize;
use serde_yaml_ng::Value;

use crate::bundle::Bundle;
use crate::page::Page;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Warning,
    Error,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Info => "info",
            Severity::Warning => "warning",
            Severity::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Diagnostic {
    pub rule: &'static str,
    pub severity: Severity,
    /// Path inside the bundle.
    pub path: String,
    pub line: Option<usize>,
    pub message: String,
}

pub trait Rule {
    /// The rule group, e.g. `okf` or `tessela/dates`. Diagnostics may use more specific names.
    fn id(&self) -> &'static str;
    fn check(&self, bundle: &Bundle, out: &mut Vec<Diagnostic>);
}

pub struct Linter {
    rules: Vec<Box<dyn Rule>>,
}

impl Default for Linter {
    fn default() -> Self {
        let mut linter = Linter::empty();
        linter.add_rule(Box::new(OkfConformance));
        linter.add_rule(Box::new(Dates));
        linter.add_rule(Box::new(Journals));
        linter.add_rule(Box::new(Vocabulary));
        linter.add_rule(Box::new(UnwrittenConcepts));
        linter
    }
}

impl Linter {
    pub fn empty() -> Linter {
        Linter { rules: Vec::new() }
    }

    pub fn add_rule(&mut self, rule: Box<dyn Rule>) {
        self.rules.push(rule);
    }

    pub fn rule_ids(&self) -> Vec<&'static str> {
        self.rules.iter().map(|r| r.id()).collect()
    }

    pub fn run(&self, bundle: &Bundle) -> Vec<Diagnostic> {
        let mut out = Vec::new();
        for rule in &self.rules {
            rule.check(bundle, &mut out);
        }
        out.sort_by(|a, b| (&a.path, a.line, a.rule).cmp(&(&b.path, b.line, b.rule)));
        out
    }
}

fn diag(
    rule: &'static str,
    severity: Severity,
    path: &str,
    line: Option<usize>,
    message: String,
) -> Diagnostic {
    Diagnostic {
        rule,
        severity,
        path: path.to_string(),
        line,
        message,
    }
}

/// OKF §9: every concept file has parseable frontmatter and a non-empty `type`.
pub struct OkfConformance;

impl Rule for OkfConformance {
    fn id(&self) -> &'static str {
        "okf"
    }

    fn check(&self, bundle: &Bundle, out: &mut Vec<Diagnostic>) {
        for (path, reason) in &bundle.unreadable {
            out.push(diag(
                "okf/readable",
                Severity::Error,
                path,
                None,
                reason.clone(),
            ));
        }
        for page in &bundle.pages {
            if !page.has_frontmatter {
                out.push(diag(
                    "okf/frontmatter",
                    Severity::Error,
                    &page.path,
                    Some(1),
                    "missing YAML frontmatter".into(),
                ));
            } else if let Some(err) = &page.frontmatter_error {
                out.push(diag(
                    "okf/frontmatter",
                    Severity::Error,
                    &page.path,
                    Some(1),
                    err.clone(),
                ));
            } else if page.kind().is_none() {
                out.push(diag(
                    "okf/type",
                    Severity::Error,
                    &page.path,
                    Some(1),
                    "frontmatter needs a non-empty `type`".into(),
                ));
            }
        }
    }
}

/// Datetimes use a space instead of `T` and carry a UTC offset (spec §7).
pub struct Dates;

impl Rule for Dates {
    fn id(&self) -> &'static str {
        "tessela/dates"
    }

    fn check(&self, bundle: &Bundle, out: &mut Vec<Diagnostic>) {
        let datetime =
            Regex::new(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$")
                .unwrap();
        let inline = Regex::new(r"\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}").unwrap();
        for page in &bundle.pages {
            let mut strings = Vec::new();
            collect_strings(&Value::Mapping(page.frontmatter.clone()), "", &mut strings);
            for (key, s) in strings {
                if !datetime.is_match(&s) {
                    continue;
                }
                if s.as_bytes()[10] == b'T' {
                    out.push(diag(
                        "tessela/dates",
                        Severity::Warning,
                        &page.path,
                        Some(1),
                        format!("`{key}`: write `{s}` with a space instead of `T`"),
                    ));
                }
                if !(s.ends_with('Z') || s[11..].contains(['+', '-'])) {
                    out.push(diag(
                        "tessela/dates",
                        Severity::Warning,
                        &page.path,
                        Some(1),
                        format!("`{key}`: datetime `{s}` needs a UTC offset"),
                    ));
                }
            }
            for block in &page.blocks {
                if let Some(m) = inline.find(&block.text) {
                    out.push(diag(
                        "tessela/dates",
                        Severity::Warning,
                        &page.path,
                        Some(block.line),
                        format!("write `{}` with a space instead of `T`", m.as_str()),
                    ));
                }
            }
        }
    }
}

fn collect_strings(value: &Value, key: &str, out: &mut Vec<(String, String)>) {
    match value {
        Value::String(s) => out.push((key.to_string(), s.clone())),
        Value::Sequence(items) => items.iter().for_each(|v| collect_strings(v, key, out)),
        Value::Mapping(m) => {
            for (k, v) in m {
                let name = k.as_str().unwrap_or("?");
                let key = if key.is_empty() {
                    name.to_string()
                } else {
                    format!("{key}.{name}")
                };
                collect_strings(v, &key, out);
            }
        }
        _ => {}
    }
}

/// Journals live at `journals/YYYY-MM-DD.md` and carry the same `date` (spec §6).
pub struct Journals;

impl Rule for Journals {
    fn id(&self) -> &'static str {
        "tessela/journal"
    }

    fn check(&self, bundle: &Bundle, out: &mut Vec<Diagnostic>) {
        let path_re = Regex::new(r"^journals/(\d{4}-\d{2}-\d{2})\.md$").unwrap();
        for page in bundle.pages.iter().filter(|p| p.kind() == Some("journal")) {
            let Some(caps) = path_re.captures(&page.path) else {
                out.push(diag(
                    "tessela/journal",
                    Severity::Warning,
                    &page.path,
                    Some(1),
                    "journal pages belong at `journals/YYYY-MM-DD.md`".into(),
                ));
                continue;
            };
            match page.get_str("date") {
                Some(date) if date == &caps[1] => {}
                Some(date) => out.push(diag(
                    "tessela/journal",
                    Severity::Warning,
                    &page.path,
                    Some(1),
                    format!("`date` is {date} but the file name says {}", &caps[1]),
                )),
                None => out.push(diag(
                    "tessela/journal",
                    Severity::Warning,
                    &page.path,
                    Some(1),
                    format!("journal needs `date: \"{}\"`", &caps[1]),
                )),
            }
        }
    }
}

/// A term in the optional `vocabulary.md` (spec §8).
#[derive(Debug, Default, Clone)]
pub struct Term {
    pub use_instead: Option<String>,
    pub deprecated: bool,
    pub note: Option<String>,
}

pub fn read_vocabulary(bundle: &Bundle) -> HashMap<String, Term> {
    let mut terms = HashMap::new();
    let Some(Value::Mapping(entries)) = bundle.page("vocabulary").and_then(|p| p.get("terms"))
    else {
        return terms;
    };
    for (name, spec) in entries {
        let Some(name) = name.as_str() else { continue };
        let field = |k: &str| spec.get(k).and_then(Value::as_str).map(str::to_string);
        terms.insert(
            crate::refs::normalize_concept(name),
            Term {
                use_instead: field("use").map(|u| crate::refs::normalize_concept(&u)),
                deprecated: field("status").as_deref() == Some("deprecated"),
                note: field("note"),
            },
        );
    }
    terms
}

/// Every concept a page mentions, with the line of the mention.
pub fn mentions(page: &Page) -> Vec<(String, Option<usize>)> {
    let mut found = Vec::new();
    found.extend(page.frontmatter_tags().into_iter().map(|t| (t, Some(1))));
    for h in &page.headings {
        found.extend(h.refs.iter().map(|r| (r.clone(), Some(h.line))));
    }
    for b in &page.blocks {
        found.extend(b.refs.iter().map(|r| (r.clone(), Some(b.line))));
    }
    found
}

/// Warns about deprecated terms and aliases declared in `vocabulary.md`.
pub struct Vocabulary;

impl Rule for Vocabulary {
    fn id(&self) -> &'static str {
        "tessela/vocabulary"
    }

    fn check(&self, bundle: &Bundle, out: &mut Vec<Diagnostic>) {
        let terms = read_vocabulary(bundle);
        if terms.is_empty() {
            return;
        }
        for page in bundle.pages.iter().filter(|p| p.id != "vocabulary") {
            for (concept, line) in mentions(page) {
                let Some(term) = terms.get(&concept) else {
                    continue;
                };
                let mut message = match (&term.use_instead, term.deprecated) {
                    (Some(u), _) => format!("`{concept}` is an alias, use `{u}`"),
                    (None, true) => format!("`{concept}` is deprecated"),
                    (None, false) => continue,
                };
                if let Some(note) = &term.note {
                    message.push_str(": ");
                    message.push_str(note);
                }
                out.push(diag(
                    "tessela/vocabulary",
                    Severity::Warning,
                    &page.path,
                    line,
                    message,
                ));
            }
        }
    }
}

/// Concepts that are mentioned but have no page yet. Informational: this is
/// allowed on purpose and works as a to-do list (spec §4).
pub struct UnwrittenConcepts;

impl Rule for UnwrittenConcepts {
    fn id(&self) -> &'static str {
        "tessela/unwritten-concept"
    }

    fn check(&self, bundle: &Bundle, out: &mut Vec<Diagnostic>) {
        let existing = bundle.page_ids();
        let mut missing: BTreeMap<String, (&str, Option<usize>, usize)> = BTreeMap::new();
        for page in &bundle.pages {
            for (concept, line) in mentions(page) {
                if existing.contains(&concept) {
                    continue;
                }
                missing
                    .entry(concept)
                    .and_modify(|m| m.2 += 1)
                    .or_insert((&page.path, line, 1));
            }
        }
        for (concept, (path, line, count)) in missing {
            let times = if count == 1 {
                "once".to_string()
            } else {
                format!("{count} times")
            };
            out.push(diag(
                "tessela/unwritten-concept",
                Severity::Info,
                path,
                line,
                format!("`{concept}` is mentioned {times} but has no page yet"),
            ));
        }
    }
}
