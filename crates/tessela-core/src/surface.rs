//! Surfacing: what the notes have to say about the thought being written.
//!
//! Given a page and a line, [`surface`] takes the block there (its parents and heading path
//! come with it) and returns a short list of notes that may be worth showing: pages that point at
//! this page, blocks that mention the same things, pages named in the block without a link, blocks
//! that use the same uncommon words, and open tasks due near a date the block mentions. Each
//! candidate says where it is and why it is listed. Nothing decides whether to show one: that is
//! for the client, which knows what the writer is doing.
//!
//! One call looks things up in the summary (see `summary.rs`) and reads only the pages it
//! returns, so it stays fast at thousands of pages.

use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::Serialize;

use crate::blocks::{BlockKind, TaskState};
use crate::corpus::{Corpus, PageId, Unit};
use crate::index::entry_of;
use crate::lint::terms_of;
use crate::page::Page;
use crate::query::{HitKind, dates_in, mentions_concept};
use crate::refs::{extract_refs, normalize_concept};
use crate::summary::{UnitKind, day_name, day_number, hash_word, tokens, unit_order};
use crate::unlinked::{Names, fold, plain_text};

/// Where a candidate comes from.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, schemars::JsonSchema,
)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// A page that mentions this page.
    Backlink,
    /// A block or page that mentions concepts this block mentions.
    Related,
    /// A page whose name is written in the block without a link.
    Unlinked,
    /// A block that uses uncommon words this block uses.
    Words,
    /// An open task due near a date written in the block.
    Agenda,
}

/// What the call took as the thought.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum FocusKind {
    /// The block at the line.
    Block,
    /// A heading: the line is its own, or no block is between it and the line.
    Heading,
    /// The page: nothing above the line to take.
    Page,
}

/// The thought: the block (or heading) at the line, or the text given in its place.
#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct Focus {
    pub kind: FocusKind,
    pub line: usize,
    /// The last line of the block and what it owns; for a heading, of its section.
    pub end_line: usize,
    pub text: String,
    /// The headings above it.
    pub heading_path: Vec<String>,
    /// The concepts it mentions, those of its parent items and headings included.
    pub refs: Vec<String>,
    /// The handle of the block or heading on disk.
    pub handle: Option<String>,
}

/// Where a page's name is written in the focus text.
#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct Mentioned {
    /// The words as written.
    pub text: String,
    /// Where they are in `at.text`, in bytes.
    pub from: usize,
    pub to: usize,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct Candidate {
    pub source: Source,
    /// Why it is listed, for a person: `also mentions #rust and #cache`.
    pub reason: String,
    /// From 0 to 1, how strong the signal is for its source. Only candidates of one source
    /// compare; the list is ordered by it all the same.
    pub score: f64,
    /// A block, a heading, or a page (its first line, or its description).
    pub kind: HitKind,
    /// The page's ID.
    pub page: String,
    pub path: String,
    pub title: String,
    pub page_type: Option<String>,
    pub line: usize,
    pub end_line: usize,
    /// Blocks and headings: page ID plus a hash of the text. Pages: the page ID.
    pub handle: String,
    pub heading_path: Vec<String>,
    /// The text, cut to a few lines.
    pub excerpt: String,
    /// What to write to link to the page: `[Title](/path/to/page.md)`.
    pub link: String,
    /// `unlinked`: where the page's name is written in the focus.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mention: Option<Mentioned>,
    /// Blocks that are checkbox items: `open` or `done`.
    pub task: Option<TaskState>,
}

#[derive(Debug, Clone, Serialize, schemars::JsonSchema)]
pub struct Surface {
    /// The page asked about.
    pub page: String,
    pub at: Focus,
    /// How many candidates there were before `limit` cut the list.
    pub total: usize,
    pub candidates: Vec<Candidate>,
}

pub struct Request<'a> {
    /// The page, with its `.md`: `project/tessela.md`.
    pub page: &'a str,
    /// The line (1-based) the writer is on. Not read when `whole` is set.
    pub line: usize,
    /// Take the whole page as the thought, and offer nothing of the page itself.
    pub whole: bool,
    /// The text of the block as the writer has it, when the file is behind.
    pub text: Option<&'a str>,
    pub limit: usize,
}

#[derive(Debug)]
pub enum Error {
    /// The page does not exist, and no text was given.
    NotFound(String),
    Io(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::NotFound(m) | Error::Io(m) => f.write_str(m),
        }
    }
}

const BACKLINKS: usize = 5;
const RELATED: usize = 6;
const UNLINKED: usize = 4;
const WORDS: usize = 6;
const AGENDA: usize = 4;

/// A concept that more than this share of units mention says nothing about a block.
const COMMON_CONCEPT: usize = 5;
/// A block that shares concepts with this much weight (see `related`) is related.
const MIN_RELATED: f64 = 1.5;
/// Words of a block or page must weigh this much together (see `words`).
const MIN_WORDS: f64 = 6.0;
/// Pages read to find the block that uses the words.
const WORD_PAGES: usize = 10;
/// Tasks due this many days from a day written in the block are near it.
const NEAR_DAYS: u32 = 3;
const EXCERPT_CHARS: usize = 240;

/// Surfaces notes for the thought at `req.line` of `req.page`, using the summary kept in
/// `.tessela/cache/` (made now if there is none).
pub fn surface(root: &Path, req: &Request) -> Result<Surface, Error> {
    run(root, req, true)
}

/// [`surface`] with no cache and no summary: every page is read and digested. The answer is the
/// same, only slower; it is what the real call is tested against.
pub fn surface_uncached(root: &Path, req: &Request) -> Result<Surface, Error> {
    run(root, req, false)
}

fn run(root: &Path, req: &Request, use_cache: bool) -> Result<Surface, Error> {
    let mut corpus = Corpus::open(root, use_cache).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => Error::NotFound(e.to_string()),
        _ => Error::Io(e.to_string()),
    })?;
    corpus.prefetch(&[req.page]);
    let page = corpus.page(req.page);
    if page.is_none() && req.text.is_none() {
        return Err(Error::NotFound(format!("no page {}", req.page)));
    }
    let focus = if req.whole {
        whole_focus(page, req.page, req.text)
    } else {
        focus_of(page, req.page, req.line, req.text)
    };
    let mut names = vec![normalize_concept(
        req.page.strip_suffix(".md").unwrap_or(req.page),
    )];
    if let Some(page) = page {
        names.extend(page.aliases());
    }
    let ctx = Ctx {
        focus: &focus,
        page_id: corpus.id_of(req.page),
        names,
        whole: req.whole,
        units: corpus.unit_count(),
        pages: corpus.page_count(),
    };

    // The vocabulary page says which words stand for which page.
    corpus.prefetch(&["vocabulary.md"]);
    let mut picks = backlinks(&corpus, &ctx);
    picks.extend(related(&corpus, &ctx));
    picks.extend(unlinked(&corpus, &ctx));
    picks.extend(agenda(&corpus, &ctx));
    let (page_weights, word_weights) = word_weights(&corpus, &ctx);
    let word_pages = best_pages(&corpus, page_weights);
    let paths: Vec<String> = word_pages
        .iter()
        .map(|&p| corpus.info(p).path.clone())
        .collect();
    corpus.prefetch(&paths.iter().map(String::as_str).collect::<Vec<_>>());
    picks.extend(words(&corpus, &ctx, &word_weights, &word_pages));

    let mut picks = merge(&corpus, picks);
    let total = picks.len();
    picks.truncate(req.limit);
    let paths: Vec<String> = picks
        .iter()
        .map(|p| corpus.info(p.page).path.clone())
        .collect();
    corpus.prefetch(&paths.iter().map(String::as_str).collect::<Vec<_>>());
    let candidates = picks
        .into_iter()
        .filter_map(|p| candidate(&corpus, p))
        .collect();
    Ok(Surface {
        page: req.page.to_string(),
        at: focus,
        total,
        candidates,
    })
}

/// What the sources know about the thought.
struct Ctx<'a> {
    focus: &'a Focus,
    /// The page in the corpus, when it is there (a new page, or a template, is not).
    page_id: Option<PageId>,
    /// The concepts that name the page: its own, and its aliases.
    names: Vec<String>,
    /// The thought is the whole page: none of its units is a candidate.
    whole: bool,
    units: usize,
    pages: usize,
}

impl Ctx<'_> {
    /// The thought itself, what contains it and what it contains, and the page as a whole, are
    /// not candidates for it.
    fn excluded(&self, u: &Unit) -> bool {
        Some(u.page) == self.page_id
            && (self.whole
                || u.kind == UnitKind::Page
                || (u.line as usize <= self.focus.end_line
                    && self.focus.line <= u.end_line as usize))
    }
}

/// A candidate before the pages are read.
#[derive(Debug, Clone)]
struct Pick {
    source: Source,
    reason: String,
    score: f64,
    page: PageId,
    ord: u32,
    kind: UnitKind,
    line: u32,
    mention: Option<Mentioned>,
}

impl Pick {
    fn of(source: Source, reason: String, score: f64, u: &Unit) -> Pick {
        Pick {
            source,
            reason,
            score: (score * 1000.0).round() / 1000.0,
            page: u.page,
            ord: u.ord,
            kind: u.kind,
            line: u.line,
            mention: None,
        }
    }
}

/// The concepts or words that gave a unit its weight, strongest first once sorted.
type Why = Vec<(f64, String)>;

/// How much a concept or word that `df` of `n` use tells about a text: more for the rare.
fn idf(n: usize, df: usize) -> f64 {
    ((n + 1) as f64 / (df + 1) as f64).ln()
}

/// `a`, `a and b`, `a, b and c`.
fn list(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [init @ .., last] => format!("{} and {last}", init.join(", ")),
    }
}

/// The page as the thought: its text (or the text given in its place) and every concept it
/// mentions, in any block or heading.
fn whole_focus(page: Option<&Page>, path: &str, text: Option<&str>) -> Focus {
    let dir = path.rsplit_once('/').map_or("", |(dir, _)| dir);
    let mut refs = Vec::new();
    let mut end_line = 1;
    let mut parts: Vec<(usize, &str)> = Vec::new();
    if let Some(page) = page {
        extend_unique(&mut refs, &page.refs);
        for h in &page.headings {
            extend_unique(&mut refs, &h.refs);
            end_line = end_line.max(h.end_line);
            parts.push((h.line, &h.text));
        }
        for b in &page.blocks {
            extend_unique(&mut refs, &b.refs);
            end_line = end_line.max(b.end_line);
            if b.kind != BlockKind::Code {
                parts.push((b.line, &b.text));
            }
        }
    }
    parts.sort_by_key(|(line, _)| *line);
    let text = match text {
        Some(t) => {
            extend_unique(&mut refs, &extract_refs(t, dir));
            t.to_string()
        }
        None => parts.iter().map(|(_, t)| *t).collect::<Vec<_>>().join("\n"),
    };
    Focus {
        kind: FocusKind::Page,
        line: 1,
        end_line,
        text,
        heading_path: Vec::new(),
        refs,
        handle: None,
    }
}

/// The block at the line, or what stands in for it (see [`FocusKind`]).
fn focus_of(page: Option<&Page>, path: &str, line: usize, text: Option<&str>) -> Focus {
    let dir = path.rsplit_once('/').map_or("", |(dir, _)| dir);
    let own = |text: &str| extract_refs(text, dir);
    let Some(page) = page else {
        let text = text.unwrap_or_default().to_string();
        return Focus {
            kind: FocusKind::Block,
            line,
            end_line: line,
            refs: own(&text),
            text,
            heading_path: Vec::new(),
            handle: None,
        };
    };
    let block = page
        .blocks
        .iter()
        .filter(|b| b.line <= line && line <= b.end_line)
        .min_by_key(|b| (b.end_line - b.line, Reverse(b.line)));
    if let Some(b) = block {
        return block_focus(page, b, text, &own);
    }
    // Between blocks: what is nearest above, a block that has ended or a heading.
    let above_block = page
        .blocks
        .iter()
        .enumerate()
        .filter(|(_, b)| b.end_line < line)
        .max_by_key(|(_, b)| (b.end_line, b.line));
    let above_heading = page
        .headings
        .iter()
        .enumerate()
        .filter(|(_, h)| h.line <= line)
        .max_by_key(|(_, h)| h.line);
    match (above_block, above_heading) {
        // The block is nearer than the heading above it.
        (Some((_, b)), Some((_, h))) if h.line <= b.end_line => block_focus(page, b, text, &own),
        (Some((_, b)), None) => block_focus(page, b, text, &own),
        (_, Some((_, h))) => {
            let (text, refs) = match text {
                Some(t) => {
                    let mut refs = h
                        .parent
                        .map_or_else(Vec::new, |p| page.headings[p].path_refs.clone());
                    extend_unique(&mut refs, &own(t));
                    (t.to_string(), refs)
                }
                None => (h.text.clone(), h.path_refs.clone()),
            };
            Focus {
                kind: FocusKind::Heading,
                line: h.line,
                end_line: h.end_line,
                text,
                heading_path: h.heading_path.clone(),
                refs,
                handle: Some(h.handle.clone()),
            }
        }
        (None, None) => {
            let text = text.map_or_else(|| page.title(), str::to_string);
            let mut refs = page.refs.clone();
            extend_unique(&mut refs, &own(&text));
            Focus {
                kind: FocusKind::Page,
                line: 1,
                end_line: 1,
                text,
                heading_path: Vec::new(),
                refs,
                handle: None,
            }
        }
    }
}

fn block_focus(
    page: &Page,
    b: &crate::blocks::Block,
    text: Option<&str>,
    own: &dyn Fn(&str) -> Vec<String>,
) -> Focus {
    // The text given, if any, is what the writer has now, in place of what is on disk.
    let (text, refs) = match text {
        Some(t) => {
            let mut refs = b
                .parent
                .map_or_else(Vec::new, |p| page.blocks[p].path_refs.clone());
            if let Some(s) = b.section {
                extend_unique(&mut refs, &page.headings[s].path_refs);
            }
            extend_unique(&mut refs, &own(t));
            (t.to_string(), refs)
        }
        None => (b.text.clone(), b.path_refs.clone()),
    };
    Focus {
        kind: FocusKind::Block,
        line: b.line,
        end_line: b.end_line,
        text,
        heading_path: b.heading_path.clone(),
        refs,
        handle: Some(b.handle.clone()),
    }
}

fn extend_unique(into: &mut Vec<String>, from: &[String]) {
    for r in from {
        if !into.contains(r) {
            into.push(r.clone());
        }
    }
}

/// Pages that mention this page, a home page's first, then the newest.
fn backlinks(corpus: &Corpus, ctx: &Ctx) -> Vec<Pick> {
    let mut best: HashMap<PageId, Unit> = HashMap::new();
    for name in &ctx.names {
        for u in corpus.concept_units(name) {
            if Some(u.page) == ctx.page_id {
                continue;
            }
            // The block that says it, else the heading, else the page's own front matter.
            let key = |u: &Unit| (Reverse(u.kind), u.line, u.ord);
            best.entry(u.page)
                .and_modify(|b| {
                    if key(&u) < key(b) {
                        *b = u;
                    }
                })
                .or_insert(u);
        }
    }
    let mut ranked: Vec<(PageId, Unit)> = best.into_iter().collect();
    ranked.sort_by_cached_key(|(p, _)| {
        let info = corpus.info(*p);
        let depth = info.path.matches('/').count();
        (
            !info.home,
            Reverse(if info.home { depth } else { 0 }),
            Reverse(info.modified),
            info.path.clone(),
        )
    });
    ranked
        .into_iter()
        .take(BACKLINKS)
        .enumerate()
        .map(|(i, (p, u))| {
            let (reason, score) = if corpus.info(p).home {
                ("a home page points to this page", 0.9)
            } else {
                ("mentions this page", (0.8 - 0.05 * i as f64).max(0.3))
            };
            Pick::of(Source::Backlink, reason.to_string(), score, &u)
        })
        .collect()
}

/// Blocks that mention what this block mentions, the rarer the concept the stronger.
fn related(corpus: &Corpus, ctx: &Ctx) -> Vec<Pick> {
    // Per unit: its weight so far, and the concepts that gave it.
    let mut found: HashMap<(PageId, u32), (Unit, f64, Why)> = HashMap::new();
    for concept in &ctx.focus.refs {
        let units = corpus.concept_units(concept);
        let df = units.len();
        if df == 0 || df * COMMON_CONCEPT > ctx.units {
            continue;
        }
        let weight = idf(ctx.units, df);
        for u in units {
            if ctx.excluded(&u) {
                continue;
            }
            let entry = found
                .entry((u.page, u.ord))
                .or_insert_with(|| (u, 0.0, Vec::new()));
            entry.1 += weight;
            entry.2.push((weight, concept.clone()));
        }
    }
    // One unit per page: the one with the most weight.
    let mut per_page: HashMap<PageId, (Unit, f64, Why)> = HashMap::new();
    for (_, (u, weight, why)) in found {
        if weight < MIN_RELATED {
            continue;
        }
        let key = |u: &Unit, w: f64| (Reverse((w * 1e6) as u64), Reverse(u.kind), u.line, u.ord);
        match per_page.get(&u.page) {
            Some((b, bw, _)) if key(b, *bw) <= key(&u, weight) => {}
            _ => {
                per_page.insert(u.page, (u, weight, why));
            }
        }
    }
    let mut picks: Vec<Pick> = per_page
        .into_values()
        .map(|(u, weight, mut why)| {
            why.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
            let named: Vec<String> = why.iter().take(3).map(|(_, c)| format!("#{c}")).collect();
            Pick::of(
                Source::Related,
                format!("also mentions {}", list(&named)),
                1.0 - (-weight / 4.0).exp(),
                &u,
            )
        })
        .collect();
    sort_picks(corpus, &mut picks);
    picks.truncate(RELATED);
    picks
}

/// Pages whose name is written in this block without a link.
fn unlinked(corpus: &Corpus, ctx: &Ctx) -> Vec<Pick> {
    if ctx.focus.text.is_empty() {
        return Vec::new();
    }
    // Most names are not in the text at all, so only the ones that are go in the matcher: one
    // look at the text for each name is far less than building a matcher of every name.
    let (text, _) = fold(&ctx.focus.text);
    let spaced = |id: &str| id.replace(['-', '_'], " ");
    // (where it comes from, the name, the page); where two pages have a name, the first source wins.
    let mut found: Vec<((u8, String, usize), String, PageId)> = Vec::new();
    let mut consider = |source: (u8, String, usize), name: &str, page: PageId| {
        let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
        if name.chars().count() >= 2 && text.contains(&fold(&name).0) {
            found.push((source, name, page));
        }
    };
    for p in corpus.pages() {
        let info = corpus.info(p);
        let id = info.path.strip_suffix(".md").unwrap_or(&info.path);
        consider((0, info.path.clone(), 0), &info.title, p);
        for (i, alias) in info.aliases.iter().enumerate() {
            consider((0, info.path.clone(), 1 + i), alias, p);
        }
        consider(
            (0, info.path.clone(), usize::MAX),
            &spaced(id.rsplit('/').next().unwrap_or(id)),
            p,
        );
    }
    // Words that `vocabulary.md` says to write as a page's name stand for that page.
    let mut terms: Vec<_> = terms_of(corpus.page("vocabulary.md")).into_iter().collect();
    terms.sort_by(|a, b| a.0.cmp(&b.0));
    let wanted: Vec<_> = terms
        .iter()
        .filter(|(_, t)| t.use_instead.is_some())
        .collect();
    if !wanted.is_empty() {
        let by_concept: HashMap<String, PageId> = corpus
            .pages()
            .map(|p| {
                let path = &corpus.info(p).path;
                (
                    normalize_concept(path.strip_suffix(".md").unwrap_or(path)),
                    p,
                )
            })
            .collect();
        for (i, (term, spec)) in wanted.into_iter().enumerate() {
            if let Some(&p) = spec.use_instead.as_ref().and_then(|u| by_concept.get(u)) {
                consider((1, String::new(), 2 * i), term, p);
                consider((1, String::new(), 2 * i + 1), &spaced(term), p);
            }
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    let mut seen: HashSet<String> = HashSet::new();
    found.retain(|(_, name, _)| seen.insert(name.to_lowercase()));
    let Some(matcher) = Names::new(found.into_iter().map(|(_, n, p)| (n, p)).collect()) else {
        return Vec::new();
    };
    let mut mentions: HashMap<PageId, Mentioned> = HashMap::new();
    for (start, masked) in plain_text(&ctx.focus.text) {
        for (from, to, page) in matcher.find(&masked) {
            let (from, to) = (start + from, start + to);
            let mention = Mentioned {
                text: ctx.focus.text[from..to].to_string(),
                from,
                to,
            };
            mentions
                .entry(page)
                .and_modify(|m| {
                    if (mention.from, mention.to) < (m.from, m.to) {
                        *m = mention.clone();
                    }
                })
                .or_insert(mention);
        }
    }
    let mut picks: Vec<Pick> = mentions
        .into_iter()
        .filter(|(p, _)| {
            let info = corpus.info(*p);
            let concept = normalize_concept(info.path.strip_suffix(".md").unwrap_or(&info.path));
            Some(*p) != ctx.page_id && !mentions_concept(&ctx.focus.refs, &concept)
        })
        .map(|(p, mention)| {
            let length = mention.text.chars().count().min(24) as f64;
            let unit = Unit {
                page: p,
                ord: 0,
                kind: UnitKind::Page,
                line: 1,
                end_line: 1,
            };
            let mut pick = Pick::of(
                Source::Unlinked,
                format!("writes \"{}\" without linking it", mention.text),
                0.5 + length / 48.0,
                &unit,
            );
            pick.mention = Some(mention);
            pick
        })
        .collect();
    sort_picks(corpus, &mut picks);
    picks.truncate(UNLINKED);
    picks
}

/// The pages whose words weigh enough, the best first.
fn best_pages(corpus: &Corpus, weights: HashMap<PageId, f64>) -> Vec<PageId> {
    let mut pages: Vec<(PageId, f64)> = weights.into_iter().collect();
    pages.retain(|(_, w)| *w >= MIN_WORDS);
    pages.sort_by(|a, b| {
        b.1.total_cmp(&a.1)
            .then_with(|| corpus.info(a.0).path.cmp(&corpus.info(b.0).path))
    });
    pages.truncate(WORD_PAGES);
    pages.into_iter().map(|(p, _)| p).collect()
}

/// For each page that uses some word of the block that is worth looking up, the weights of
/// those words added; and the weight of each such word, by its number.
fn word_weights(corpus: &Corpus, ctx: &Ctx) -> (HashMap<PageId, f64>, HashMap<u32, f64>) {
    let mut by_page: HashMap<PageId, f64> = HashMap::new();
    let mut by_word: HashMap<u32, f64> = HashMap::new();
    let mut seen: HashSet<u32> = HashSet::new();
    for word in tokens(&ctx.focus.text) {
        let hash = hash_word(&word);
        if !seen.insert(hash) {
            continue;
        }
        let Some(pages) = corpus.word_pages(hash) else {
            continue;
        };
        let weight = idf(ctx.pages, pages.len());
        by_word.insert(hash, weight);
        for p in pages {
            *by_page.entry(p).or_default() += weight;
        }
    }
    (by_page, by_word)
}

/// In the best pages for the words, the block that uses the most of them.
fn words(corpus: &Corpus, ctx: &Ctx, weights: &HashMap<u32, f64>, pages: &[PageId]) -> Vec<Pick> {
    let mut picks = Vec::new();
    for &p in pages {
        let Some(page) = corpus.page(&corpus.info(p).path) else {
            continue;
        };
        // (weight, the unit, the words that gave it)
        let mut best: Option<(f64, Unit, Why)> = None;
        for (i, (kind, idx)) in unit_order(page).into_iter().enumerate() {
            let (text, line, end_line) = match kind {
                UnitKind::Heading => {
                    let h = &page.headings[idx];
                    (h.text.as_str(), h.line, h.end_line)
                }
                _ => {
                    let b = &page.blocks[idx];
                    if b.kind == BlockKind::Code {
                        continue;
                    }
                    (b.text.as_str(), b.line, b.end_line)
                }
            };
            let unit = Unit {
                page: p,
                ord: i as u32 + 1,
                kind,
                line: line as u32,
                end_line: end_line as u32,
            };
            if ctx.excluded(&unit) {
                continue;
            }
            let mut shared: Vec<(f64, String)> = Vec::new();
            let mut seen: HashSet<u32> = HashSet::new();
            for word in tokens(text) {
                let hash = hash_word(&word);
                if let Some(&w) = weights.get(&hash)
                    && seen.insert(hash)
                {
                    shared.push((w, word));
                }
            }
            let total: f64 = shared.iter().map(|(w, _)| w).sum();
            if total >= MIN_WORDS && best.as_ref().is_none_or(|(b, ..)| total > *b) {
                best = Some((total, unit, shared));
            }
        }
        if let Some((total, unit, mut shared)) = best {
            shared.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
            let named: Vec<String> = shared
                .iter()
                .take(3)
                .map(|(_, w)| format!("\"{w}\""))
                .collect();
            picks.push(Pick::of(
                Source::Words,
                format!("uses {}", list(&named)),
                1.0 - (-total / 12.0).exp(),
                &unit,
            ));
        }
    }
    sort_picks(corpus, &mut picks);
    picks.truncate(WORDS);
    picks
}

/// Open tasks due within [`NEAR_DAYS`] of a day the block writes, the nearest first.
fn agenda(corpus: &Corpus, ctx: &Ctx) -> Vec<Pick> {
    let mut days: Vec<u32> = dates_in(&ctx.focus.text)
        .iter()
        .filter_map(|d| day_number(d))
        .collect();
    days.sort_unstable();
    days.dedup();
    // Per task: how far it is from a day of the block, which day it is due, and which day of
    // the block that is.
    let mut found: HashMap<(PageId, u32), (u32, u32, u32, Unit)> = HashMap::new();
    for &mentioned in &days {
        let near = mentioned.saturating_sub(NEAR_DAYS)..=mentioned + NEAR_DAYS;
        for (due, u) in corpus.tasks_between(*near.start(), *near.end()) {
            if ctx.excluded(&u) {
                continue;
            }
            let entry = (due.abs_diff(mentioned), due, mentioned, u);
            match found.get(&(u.page, u.ord)) {
                Some(b) if (b.0, b.1, b.2) <= (entry.0, entry.1, entry.2) => {}
                _ => {
                    found.insert((u.page, u.ord), entry);
                }
            }
        }
    }
    let mut picks: Vec<Pick> = found
        .into_values()
        .map(|(dist, due, mentioned, u)| {
            let reason = match (dist, due.cmp(&mentioned)) {
                (0, _) => format!("open task due {}, a day this block writes", day_name(due)),
                (n, std::cmp::Ordering::Less) => format!(
                    "open task due {}, {n} day{} before {}",
                    day_name(due),
                    if n == 1 { "" } else { "s" },
                    day_name(mentioned)
                ),
                (n, _) => format!(
                    "open task due {}, {n} day{} after {}",
                    day_name(due),
                    if n == 1 { "" } else { "s" },
                    day_name(mentioned)
                ),
            };
            let score = f64::from(NEAR_DAYS + 1 - dist) / f64::from(NEAR_DAYS + 1);
            Pick::of(Source::Agenda, reason, score, &u)
        })
        .collect();
    sort_picks(corpus, &mut picks);
    picks.truncate(AGENDA);
    picks
}

/// The strongest first; equal ones by path and place, so the order never depends on how the
/// summary happens to be laid out.
fn sort_picks(corpus: &Corpus, picks: &mut [Pick]) {
    picks.sort_by_cached_key(|p| {
        (
            Reverse((p.score * 1000.0).round() as u64),
            p.source,
            corpus.info(p.page).path.clone(),
            p.ord,
        )
    });
}

/// One candidate per place: where several sources find the same one, the strongest says what
/// it is and the reasons add up. Sorted by strength.
fn merge(corpus: &Corpus, picks: Vec<Pick>) -> Vec<Pick> {
    let mut order: Vec<(PageId, u32)> = Vec::new();
    let mut by_place: HashMap<(PageId, u32), Pick> = HashMap::new();
    for pick in picks {
        let key = (pick.page, pick.ord);
        match by_place.get_mut(&key) {
            None => {
                order.push(key);
                by_place.insert(key, pick);
            }
            Some(have) => {
                let (mut strong, weak) = if (Reverse((pick.score * 1000.0) as u64), pick.source)
                    < (Reverse((have.score * 1000.0) as u64), have.source)
                {
                    (pick, have.clone())
                } else {
                    (have.clone(), pick)
                };
                strong.reason = format!("{}; {}", strong.reason, weak.reason);
                if strong.mention.is_none() {
                    strong.mention = weak.mention;
                }
                *have = strong;
            }
        }
    }
    let mut merged: Vec<Pick> = order
        .into_iter()
        .filter_map(|k| by_place.remove(&k))
        .collect();
    sort_picks(corpus, &mut merged);
    merged
}

/// The candidate for a pick, from the page it is on. `None` when the page does not say what
/// the summary did (it changed in between).
fn candidate(corpus: &Corpus, pick: Pick) -> Option<Candidate> {
    let info = corpus.info(pick.page);
    let page = corpus.page(&info.path)?;
    let link = format!("[{}](/{})", info.title.replace(['[', ']'], ""), info.path);
    let mut c = Candidate {
        source: pick.source,
        reason: pick.reason,
        score: pick.score,
        kind: HitKind::Page,
        page: page.id.clone(),
        path: page.path.clone(),
        title: info.title.clone(),
        page_type: info.kind.clone(),
        line: 1,
        end_line: 1,
        handle: page.id.clone(),
        heading_path: Vec::new(),
        excerpt: String::new(),
        link,
        mention: pick.mention,
        task: None,
    };
    match pick.kind {
        UnitKind::Page => {
            let entry = entry_of(page);
            c.excerpt = excerpt(&entry.description.unwrap_or_else(|| info.title.clone()));
        }
        UnitKind::Heading => {
            let (kind, i) = *unit_order(page).get((pick.ord as usize).checked_sub(1)?)?;
            let h = page
                .headings
                .get(i)
                .filter(|h| kind == UnitKind::Heading && h.line == pick.line as usize)?;
            c.kind = HitKind::Heading;
            c.line = h.line;
            c.end_line = h.end_line;
            c.handle = h.handle.clone();
            c.heading_path = h.heading_path.clone();
            c.excerpt = excerpt(&h.text);
        }
        UnitKind::Block => {
            let (kind, i) = *unit_order(page).get((pick.ord as usize).checked_sub(1)?)?;
            let b = page
                .blocks
                .get(i)
                .filter(|b| kind == UnitKind::Block && b.line == pick.line as usize)?;
            c.kind = HitKind::Block;
            c.line = b.line;
            c.end_line = b.end_line;
            c.handle = b.handle.clone();
            c.heading_path = b.heading_path.clone();
            c.excerpt = excerpt(&b.text);
            c.task = b.task;
        }
    }
    Some(c)
}

/// The text on one line, cut short.
fn excerpt(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= EXCERPT_CHARS {
        return flat;
    }
    let cut: String = flat.chars().take(EXCERPT_CHARS).collect();
    format!("{}…", cut.trim_end())
}
