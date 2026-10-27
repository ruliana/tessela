//! The vocabulary: every concept that exists, so people and agents can pick an
//! existing term instead of inventing a new one (spec §8).

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::bundle::Bundle;
use crate::lint::{mentions, read_vocabulary};
use crate::refs::normalize_concept;

#[derive(Debug, Clone, Serialize)]
pub struct VocabEntry {
    pub concept: String,
    /// A page with this ID exists.
    pub has_page: bool,
    /// Times the concept is mentioned by a tag, a link or frontmatter `tags`.
    pub mentions: usize,
    /// Number of different pages that mention it.
    pub pages: usize,
    pub deprecated: bool,
    /// Preferred concept, when `vocabulary.md` marks this one as an alias.
    pub use_instead: Option<String>,
    pub note: Option<String>,
}

/// Concepts with a page, mentioned anywhere, or declared in `vocabulary.md`.
/// The most mentioned come first, then alphabetical.
pub fn vocabulary(bundle: &Bundle) -> Vec<VocabEntry> {
    let declared = read_vocabulary(bundle);
    let existing = bundle.page_ids();

    let mut counts: BTreeMap<String, (usize, BTreeSet<&str>)> = BTreeMap::new();
    for page in &bundle.pages {
        for (concept, _) in mentions(page) {
            let entry = counts.entry(concept).or_default();
            entry.0 += 1;
            entry.1.insert(&page.path);
        }
    }
    let mut concepts: BTreeSet<String> = counts.keys().cloned().collect();
    concepts.extend(declared.keys().cloned());
    concepts.extend(existing.iter().map(|id| normalize_concept(id)));

    let mut entries: Vec<VocabEntry> = concepts
        .into_iter()
        .map(|concept| {
            let (mentions, pages) = counts.get(&concept).map_or((0, 0), |(n, p)| (*n, p.len()));
            let term = declared.get(&concept);
            VocabEntry {
                has_page: existing.contains(&concept),
                mentions,
                pages,
                deprecated: term.is_some_and(|t| t.deprecated),
                use_instead: term.and_then(|t| t.use_instead.clone()),
                note: term.and_then(|t| t.note.clone()),
                concept,
            }
        })
        .collect();
    entries.sort_by(|a, b| {
        b.mentions
            .cmp(&a.mentions)
            .then_with(|| a.concept.cmp(&b.concept))
    });
    entries
}
