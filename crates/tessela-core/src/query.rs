//! Retrieval: find the blocks that mention concepts, contain text, or sit in a date range.

use serde::Serialize;

use crate::bundle::Bundle;
use crate::page::Page;
use crate::refs::normalize_concept;

/// All filters that are set must match.
#[derive(Debug, Default, Clone)]
pub struct Query {
    /// Concepts the block must mention. Names are normalized (`#Foo Bar` is `foo-bar`).
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
    /// First day to include, `YYYY-MM-DD`. Pages without a date are left out.
    pub from: Option<String>,
    /// Last day to include, `YYYY-MM-DD`. Pages without a date are left out.
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
    /// Handle of the enclosing list item, if any.
    pub parent: Option<String>,
}

impl Query {
    pub fn run(&self, bundle: &Bundle) -> Vec<Hit> {
        let wanted: Vec<String> = self.refs.iter().map(|r| normalize_concept(r)).collect();
        let text = self.text.as_ref().map(|t| t.to_lowercase());
        let mut hits = Vec::new();
        for page in &bundle.pages {
            if !self.page_matches(page) {
                continue;
            }
            for block in &page.blocks {
                let have = if self.own {
                    &block.refs
                } else {
                    &block.path_refs
                };
                let refs_ok = wanted.is_empty()
                    || if self.any {
                        wanted.iter().any(|w| have.contains(w))
                    } else {
                        wanted.iter().all(|w| have.contains(w))
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
        if self.from.is_some() || self.to.is_some() {
            let Some(date) = page_date(page) else {
                return false;
            };
            if self.from.as_deref().is_some_and(|f| date.as_str() < f)
                || self.to.as_deref().is_some_and(|t| date.as_str() > t)
            {
                return false;
            }
        }
        true
    }
}

/// The day a page belongs to: a journal's `date`, falling back to its file name.
pub fn page_date(page: &Page) -> Option<String> {
    if page.kind() != Some("journal") {
        return None;
    }
    let from_name = page.id.rsplit('/').next().map(str::to_string);
    page.get_str("date").map(str::to_string).or(from_name)
}
