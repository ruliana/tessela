//! Retrieval: find the blocks that mention concepts, contain text, or sit in a date range.

use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

use crate::bundle::Bundle;
use crate::page::Page;
use crate::refs::normalize_concept;

/// All filters that are set must match.
#[derive(Debug, Default, Clone)]
pub struct Query {
    /// Concepts the block must mention. Names are normalized (`#Foo Bar` is `foo-bar`).
    /// A concept also matches the ones below it: `project` matches `project/tessela`.
    pub refs: Vec<String>,
    /// Match blocks that mention any of `refs` instead of all of them.
    pub any: bool,
    /// Match only a block's own refs, not those inherited from parent items and headings.
    pub own: bool,
    /// Case-insensitive substring of the block text.
    pub text: Option<String>,
    /// The page's frontmatter `type`.
    pub kind: Option<String>,
    /// A page ID, or a folder prefix when it ends with `/`.
    pub page: Option<String>,
    /// First day to include, `YYYY-MM-DD`. A block is in range when its journal page
    /// is, or when its text contains a date in range.
    pub from: Option<String>,
    /// Last day to include, `YYYY-MM-DD`. See `from`.
    pub to: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Hit {
    pub handle: String,
    pub page: String,
    pub path: String,
    pub page_type: Option<String>,
    pub line: usize,
    pub heading_path: Vec<String>,
    pub text: String,
    pub refs: Vec<String>,
    pub path_refs: Vec<String>,
    /// The dates (`YYYY-MM-DD`) written in the block text, in order.
    pub dates: Vec<String>,
    /// Handle of the enclosing list item, if any.
    pub parent: Option<String>,
}

impl Query {
    pub fn run(&self, bundle: &Bundle) -> Vec<Hit> {
        let wanted: Vec<String> = self.refs.iter().map(|r| normalize_concept(r)).collect();
        let text = self.text.as_ref().map(|t| t.to_lowercase());
        let by_date = self.from.is_some() || self.to.is_some();
        let mut hits = Vec::new();
        for page in &bundle.pages {
            if !self.page_matches(page) {
                continue;
            }
            let page_in_range = by_date && page_date(page).is_some_and(|d| self.in_range(&d));
            for block in &page.blocks {
                let dates = dates_in(&block.text);
                if by_date && !page_in_range && !dates.iter().any(|d| self.in_range(d)) {
                    continue;
                }
                let have = if self.own {
                    &block.refs
                } else {
                    &block.path_refs
                };
                let refs_ok = wanted.is_empty()
                    || if self.any {
                        wanted.iter().any(|w| mentions_concept(have, w))
                    } else {
                        wanted.iter().all(|w| mentions_concept(have, w))
                    };
                if !refs_ok
                    || text
                        .as_ref()
                        .is_some_and(|t| !block.text.to_lowercase().contains(t))
                {
                    continue;
                }
                hits.push(Hit {
                    handle: block.handle.clone(),
                    page: page.id.clone(),
                    path: page.path.clone(),
                    page_type: page.kind().map(str::to_string),
                    line: block.line,
                    heading_path: block.heading_path.clone(),
                    text: block.text.clone(),
                    refs: block.refs.clone(),
                    path_refs: block.path_refs.clone(),
                    dates,
                    parent: block.parent.map(|p| page.blocks[p].handle.clone()),
                });
            }
        }
        hits
    }

    fn page_matches(&self, page: &Page) -> bool {
        if self.kind.as_deref().is_some_and(|k| page.kind() != Some(k)) {
            return false;
        }
        if let Some(wanted) = &self.page {
            let id = page.id.to_lowercase();
            let wanted = wanted.trim_end_matches(".md").to_lowercase();
            let ok = if wanted.ends_with('/') {
                id.starts_with(&wanted)
            } else {
                id == wanted
            };
            if !ok {
                return false;
            }
        }
        true
    }

    fn in_range(&self, date: &str) -> bool {
        self.from.as_deref().is_none_or(|f| date >= f)
            && self.to.as_deref().is_none_or(|t| date <= t)
    }
}

/// The dates (`YYYY-MM-DD`) written in a text, including the day of a datetime.
pub fn dates_in(text: &str) -> Vec<String> {
    static DATE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?:^|[^\d])(\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))(?:[^\d]|$)")
            .unwrap()
    });
    // Matches are found one at a time so that two dates separated by one character are both seen.
    let mut found = Vec::new();
    let mut rest = text;
    while let Some(caps) = DATE.captures(rest) {
        let m = caps.get(1).unwrap();
        found.push(m.as_str().to_string());
        rest = &rest[m.end()..];
    }
    found
}

/// Whether `refs` has the concept or one nested under it (`project/tessela` is under `project`).
fn mentions_concept(refs: &[String], concept: &str) -> bool {
    refs.iter().any(|r| {
        r == concept
            || r.strip_prefix(concept)
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

/// The day a page belongs to: a journal's `date`, falling back to its file name.
pub fn page_date(page: &Page) -> Option<String> {
    if page.kind() != Some("journal") {
        return None;
    }
    let from_name = page.id.rsplit('/').next().map(str::to_string);
    page.get_str("date").map(str::to_string).or(from_name)
}
