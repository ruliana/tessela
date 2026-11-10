//! Related pages, in place of a graph: what is mentioned together with a page, and which
//! home pages lead to it. Both are computed from the notes when asked and explain
//! themselves with a reason, so a short list is enough where a drawing would not answer.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use serde::Serialize;

use crate::bundle::Bundle;
use crate::index::{PageEntry, entry_of, linked_from};
use crate::query::{mentions_any, mentions_concept};
use crate::refs::normalize_concept;

/// A concept that is mentioned together with the asked one.
#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct Together {
    pub concept: String,
    /// The page of the concept, when there is one.
    pub page: Option<PageEntry>,
    /// Blocks that mention both, each counted once, inherited references included.
    pub blocks: usize,
    /// Different pages those blocks are on.
    pub pages: usize,
    /// Pages whose properties (front matter) mention both.
    pub properties: usize,
    /// Why it is listed: `together in 7 blocks on 3 pages`.
    pub reason: String,
}

/// How the chain of home pages was found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ChainBy {
    /// Each home page links to the next, starting at the root `home.md`.
    Links,
    /// No such path of links: the home pages of the folders around the page.
    Folders,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct Related {
    pub concept: String,
    pub page: Option<PageEntry>,
    /// Most often together first.
    pub together: Vec<Together>,
    /// Home pages that lead to the page, the root's first; the page itself is not in it.
    pub chain: Vec<PageEntry>,
    pub chain_by: ChainBy,
}

pub fn related(bundle: &Bundle, name: &str, limit: usize) -> Related {
    let concept = normalize_concept(name.strip_suffix(".md").unwrap_or(name));
    let page = bundle.page(&concept);
    // The concept and the other names that mean it (the aliases of its page).
    let names = bundle.names_for(&concept);

    #[derive(Default)]
    struct Count<'a> {
        blocks: usize,
        pages: BTreeSet<&'a str>,
        properties: usize,
    }
    let mut counts: BTreeMap<String, Count> = BTreeMap::new();
    let others = |refs: &[String]| -> Vec<String> {
        refs.iter()
            .filter(|r| {
                !names.iter().any(|n| {
                    *r == n
                        || mentions_concept(&[(*r).clone()], n)
                        || mentions_concept(std::slice::from_ref(n), r)
                })
            })
            .cloned()
            .collect()
    };
    for p in bundle.pages.iter().filter(|p| !p.is_template()) {
        if mentions_any(&p.refs, &names) {
            // A page tagged with the concept is related to it, so its own concept counts.
            let mut together = others(&p.refs);
            together.extend(others(&[normalize_concept(&p.id)]));
            together.sort();
            together.dedup();
            for d in together {
                counts.entry(d).or_default().properties += 1;
            }
        }
        for b in &p.blocks {
            if mentions_any(&b.path_refs, &names) {
                for d in others(&b.path_refs) {
                    let c = counts.entry(d).or_default();
                    c.blocks += 1;
                    c.pages.insert(&p.path);
                }
            }
        }
    }
    let mut together: Vec<Together> = counts
        .into_iter()
        .filter(|(_, c)| c.blocks + c.properties > 0)
        .map(|(concept, c)| {
            let mut reason = match c.blocks {
                0 => String::new(),
                1 => "together in 1 block".to_string(),
                n => format!("together in {n} blocks"),
            };
            if c.pages.len() > 1 {
                reason.push_str(&format!(" on {} pages", c.pages.len()));
            }
            if c.properties > 0 {
                let props = format!(
                    "in the properties of {} page{}",
                    c.properties,
                    if c.properties == 1 { "" } else { "s" }
                );
                reason = if reason.is_empty() {
                    format!("together {props}")
                } else {
                    format!("{reason} and {props}")
                };
            }
            Together {
                page: bundle.page(&concept).map(entry_of),
                blocks: c.blocks,
                pages: c.pages.len(),
                properties: c.properties,
                reason,
                concept,
            }
        })
        .collect();
    together.sort_by(|a, b| {
        (b.blocks, b.pages, b.properties)
            .cmp(&(a.blocks, a.pages, a.properties))
            .then_with(|| a.concept.cmp(&b.concept))
    });
    together.truncate(limit);

    let (chain, chain_by) = match page {
        Some(p) => home_chain(bundle, &p.path),
        None => (Vec::new(), ChainBy::Folders),
    };
    Related {
        page: page.map(entry_of),
        concept,
        together,
        chain,
        chain_by,
    }
}

/// The home pages that lead to `target`: a shortest path of links from the root `home.md`
/// through home pages, else the home pages of the folders around it.
fn home_chain(bundle: &Bundle, target: &str) -> (Vec<PageEntry>, ChainBy) {
    let is_home = |path: &str| bundle.pages.iter().any(|p| p.path == path && p.is_home());
    let mut previous: BTreeMap<String, String> = BTreeMap::new();
    let mut queue = VecDeque::new();
    if is_home("home.md") {
        previous.insert("home.md".into(), String::new());
        queue.push_back("home.md".to_string());
    }
    while let Some(path) = queue.pop_front() {
        let Some(home) = bundle.pages.iter().find(|p| p.path == path) else {
            continue;
        };
        for link in linked_from(bundle, home) {
            if link.path == target {
                let mut chain = vec![path.clone()];
                while let Some(before) = previous
                    .get(chain.last().unwrap())
                    .filter(|b| !b.is_empty())
                {
                    chain.push(before.clone());
                }
                chain.reverse();
                return (entries(bundle, &chain), ChainBy::Links);
            }
            if is_home(&link.path) && !previous.contains_key(&link.path) {
                previous.insert(link.path.clone(), path.clone());
                queue.push_back(link.path);
            }
        }
    }
    // The homes of the folders around the page, the root's first.
    let mut folders = Vec::new();
    let mut dir = target;
    while let Some((parent, _)) = dir.rsplit_once('/') {
        folders.push(format!("{parent}/home.md"));
        dir = parent;
    }
    folders.push("home.md".to_string());
    folders.reverse();
    folders.retain(|h| h != target && is_home(h));
    (entries(bundle, &folders), ChainBy::Folders)
}

fn entries(bundle: &Bundle, paths: &[String]) -> Vec<PageEntry> {
    paths
        .iter()
        .filter_map(|p| bundle.pages.iter().find(|page| &page.path == p))
        .map(entry_of)
        .collect()
}
