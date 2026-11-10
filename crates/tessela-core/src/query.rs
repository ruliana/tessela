//! Retrieval: find the blocks that mention concepts, contain text, or sit in a date range.

use std::cmp::Reverse;
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

use crate::blocks::{Block, Heading, TaskState};
use crate::bundle::Bundle;
use crate::page::Page;
use crate::refs::normalize_concept;
use crate::unlinked::{self, Mention, Spec};

/// All filters that are set must match.
#[derive(Debug, Default, Clone)]
pub struct Query {
    /// Concepts the block must mention. Names are normalized (`#Foo Bar` is `foo-bar`).
    /// A concept also matches the ones below it: `project` matches `project/tessela`.
    /// A name that a page lists in its frontmatter `aliases` also matches that page's ID.
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
    /// Only checkbox items, open or done. Headings and pages are never tasks.
    pub task: Option<TaskFilter>,
    /// A concept written as plain words, not linked: blocks that name it by its title, an
    /// alias or a `vocabulary.md` term, and do not already reach it through a tag or a
    /// link, their own or inherited. Each hit lists the `mentions`. Only blocks are
    /// returned, newest page first, and the concept's own page is left out.
    pub unlinked: Option<String>,
}

/// Which checkbox items `--task` keeps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskFilter {
    /// `- [ ]`
    Open,
    /// `- [x]`
    Done,
    /// Either
    Any,
}

impl TaskFilter {
    fn accepts(self, task: Option<TaskState>) -> bool {
        match (self, task) {
            (_, None) => false,
            (TaskFilter::Open, Some(state)) => state == TaskState::Open,
            (TaskFilter::Done, Some(state)) => state == TaskState::Done,
            (TaskFilter::Any, Some(_)) => true,
        }
    }
}

/// What kind of thing a hit is. Anything that can hold a reference can be found,
/// so a query for a concept returns its backlinks wherever they are.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HitKind {
    /// A paragraph or list item.
    Block,
    /// A heading that mentions the concept. The blocks below it also match, as they
    /// inherit its refs, but the heading itself is a backlink too.
    Heading,
    /// A page that mentions the concept in its frontmatter (`tags`, or links and tags
    /// in other frontmatter text). Only returned when the query names a concept.
    Page,
}

#[derive(Debug, Clone, Serialize)]
pub struct Hit {
    pub kind: HitKind,
    /// Blocks and headings: page ID plus a hash of the text. Pages: the page ID.
    pub handle: String,
    pub page: String,
    pub path: String,
    pub page_type: Option<String>,
    pub line: usize,
    pub heading_path: Vec<String>,
    /// Blocks: the text. Headings: the heading text. Pages: the title, or the page ID.
    pub text: String,
    pub refs: Vec<String>,
    pub path_refs: Vec<String>,
    /// The dates (`YYYY-MM-DD`) written in `text`, in order.
    pub dates: Vec<String>,
    /// Handle of the enclosing list item, if any.
    pub parent: Option<String>,
    /// Blocks that are checkbox items: `open` or `done`.
    pub task: Option<TaskState>,
    /// With `unlinked`: where the concept is named in this block.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<Mention>,
    /// The hit is on a `home.md` page. A link from a home page marks the target as
    /// important, so these hits come first (spec §5).
    pub home: bool,
    /// When the page's file was last changed, in milliseconds since the Unix epoch.
    /// Backlinks are ordered by it, newest first. Absent when unknown.
    pub modified: Option<u64>,
}

impl Query {
    pub fn run(&self, bundle: &Bundle) -> Vec<Hit> {
        // Each asked concept with the other names that mean it (page aliases).
        let wanted: Vec<Vec<String>> = self
            .refs
            .iter()
            .map(|r| bundle.names_for(&normalize_concept(r)))
            .collect();
        let text = self.text.as_ref().map(|t| t.to_lowercase());
        let unlinked = self.unlinked.as_ref().map(|name| Spec::new(bundle, name));
        let by_date = self.from.is_some() || self.to.is_some();
        let mut hits = Vec::new();
        for page in &bundle.pages {
            if !self.page_matches(page) {
                continue;
            }
            let page_in_range = by_date && page_date(page).is_some_and(|d| self.in_range(&d));
            let accepts = |hit: &Hit| {
                let have = if self.own { &hit.refs } else { &hit.path_refs };
                let refs_ok = wanted.is_empty()
                    || if self.any {
                        wanted.iter().any(|w| mentions_any(have, w))
                    } else {
                        wanted.iter().all(|w| mentions_any(have, w))
                    };
                refs_ok
                    && self.task.is_none_or(|t| t.accepts(hit.task))
                    && text
                        .as_ref()
                        .is_none_or(|t| hit.text.to_lowercase().contains(t))
                    && (!by_date || page_in_range || hit.dates.iter().any(|d| self.in_range(d)))
            };

            if let Some(spec) = &unlinked {
                hits.extend(
                    unlinked_hits(bundle, page, spec)
                        .into_iter()
                        .filter(accepts),
                );
                continue;
            }
            let mut found = Vec::new();
            // Pages and headings only exist to hold references, so they are only
            // returned when a concept is asked for.
            if !wanted.is_empty() {
                found.push(page_hit(page));
                found.extend(page.headings.iter().map(|h| heading_hit(page, h)));
            }
            found.extend(page.blocks.iter().map(|b| block_hit(page, b)));
            // Document order; the page itself first.
            found.sort_by_key(|h| h.line);
            hits.extend(found.into_iter().filter(accepts));
        }
        if unlinked.is_some() {
            // Newest page first, like backlinks; a page's blocks stay in document order.
            hits.sort_by_key(|h| Reverse(h.modified));
        }
        // Backlinks from home pages first, the most specific folder's first, then the
        // most recently changed page's. Hits of one page share a time and the sort is
        // stable, so a page's hits stay together in document order, and pages changed at
        // the same time (or at an unknown time) keep their path order.
        if !wanted.is_empty() {
            hits.sort_by_key(|h| {
                let rank = match h.home {
                    true => (0, Reverse(h.path.matches('/').count())),
                    false => (1, Reverse(0)),
                };
                (rank, Reverse(h.modified))
            });
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

/// The blocks of a page that name the concept in plain words and do not reach it yet.
fn unlinked_hits(bundle: &Bundle, page: &Page, spec: &Spec) -> Vec<Hit> {
    if spec.is_page(page) {
        return Vec::new();
    }
    let file = unlinked::read_file(&bundle.root, page);
    page.blocks
        .iter()
        .filter(|b| !mentions_concept(&b.path_refs, &spec.concept))
        .filter_map(|b| {
            let mentions = spec.mentions(page, b, file.as_deref());
            (!mentions.is_empty()).then(|| Hit {
                mentions,
                ..block_hit(page, b)
            })
        })
        .collect()
}

fn block_hit(page: &Page, block: &Block) -> Hit {
    Hit {
        kind: HitKind::Block,
        handle: block.handle.clone(),
        page: page.id.clone(),
        path: page.path.clone(),
        page_type: page.kind().map(str::to_string),
        line: block.line,
        heading_path: block.heading_path.clone(),
        dates: dates_in(&block.text),
        text: block.text.clone(),
        refs: block.refs.clone(),
        path_refs: block.path_refs.clone(),
        parent: block.parent.map(|p| page.blocks[p].handle.clone()),
        task: block.task,
        mentions: Vec::new(),
        home: page.is_home(),
        modified: page.modified,
    }
}

fn heading_hit(page: &Page, heading: &Heading) -> Hit {
    Hit {
        kind: HitKind::Heading,
        handle: heading.handle.clone(),
        page: page.id.clone(),
        path: page.path.clone(),
        page_type: page.kind().map(str::to_string),
        line: heading.line,
        heading_path: heading.heading_path.clone(),
        dates: dates_in(&heading.text),
        text: heading.text.clone(),
        refs: heading.refs.clone(),
        path_refs: heading.path_refs.clone(),
        parent: None,
        task: None,
        mentions: Vec::new(),
        home: page.is_home(),
        modified: page.modified,
    }
}

fn page_hit(page: &Page) -> Hit {
    let text = page.get_str("title").unwrap_or(&page.id).to_string();
    Hit {
        kind: HitKind::Page,
        handle: page.id.clone(),
        page: page.id.clone(),
        path: page.path.clone(),
        page_type: page.kind().map(str::to_string),
        line: 1,
        heading_path: Vec::new(),
        dates: dates_in(&text),
        text,
        refs: page.refs.clone(),
        path_refs: page.refs.clone(),
        parent: None,
        task: None,
        mentions: Vec::new(),
        home: page.is_home(),
        modified: page.modified,
    }
}

pub(crate) fn mentions_any(refs: &[String], concepts: &[String]) -> bool {
    concepts.iter().any(|c| mentions_concept(refs, c))
}

/// Whether `refs` has the concept or one nested under it (`project/tessela` is under `project`).
pub(crate) fn mentions_concept(refs: &[String], concept: &str) -> bool {
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
