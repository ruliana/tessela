//! The summary: one file in `.tessela/cache/` with what `surface` needs to know about every page,
//! laid out so that a call looks things up in it without reading each page.
//!
//! A page's [`Digest`] is its title and aliases, its units (the page itself, its headings and
//! its blocks, each with the concepts it mentions itself), the days written in its open tasks,
//! and the words it uses. The summary is every page's digest turned inside out: for each
//! concept the units that mention it, for each uncommon word the pages that use it, for each
//! day the tasks that name it. A lookup is a binary search in a sorted table, and only the
//! pages that matter are read afterwards.
//!
//! Like a page's cache entry (see `cache.rs`) it is framed with the build's fingerprint and a
//! checksum, written atomically, and made only from files that have stayed as they are for a
//! moment. A row says which file it was made from (size and modification time): a file that
//! looks otherwise now is not trusted, and its page is read again (see `corpus.rs`). A file that
//! is damaged, or made by another build, is no summary at all: a miss, never an error.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

use crate::blocks::{BlockKind, TaskState};
use crate::cache::{Stamp, frame, unframe};
use crate::page::Page;
use crate::query::dates_in;

const MAGIC: &[u8; 4] = b"TSLs";

/// Where the summary is kept, in the cache folder.
pub(crate) const FILE: &str = "summary.dat";

/// A call may leave this many pages out of the summary (changed since, or new) and read them
/// again each time; with more, the summary is made anew.
pub(crate) const MAX_OVERLAY: usize = 64;

/// A word used by more pages than this tells nothing about a page, and is not looked up.
pub(crate) const WORD_MAX_PAGES: usize = 64;

/// A word is kept in the summary up to this many pages: the ones that may have gone over
/// [`WORD_MAX_PAGES`] only because of pages the summary no longer knows, never fewer.
const WORD_KEEP_PAGES: usize = WORD_MAX_PAGES + MAX_OVERLAY;

/// Shorter words are not looked up.
const MIN_WORD_CHARS: usize = 4;

/// What a unit of a page is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum UnitKind {
    /// The page itself: what its front matter mentions.
    Page = 0,
    Heading = 1,
    Block = 2,
}

/// What the summary keeps of one page, apart from what it mentions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct PageInfo {
    pub path: String,
    pub title: String,
    pub kind: Option<String>,
    /// The other names the page lists in its front matter, as written.
    pub aliases: Vec<String>,
    pub home: bool,
    /// When the file was last changed, in milliseconds since the Unix epoch.
    pub modified: Option<u64>,
}

impl PageInfo {
    fn of(page: &Page) -> PageInfo {
        PageInfo {
            path: page.path.clone(),
            title: page.title(),
            kind: page.kind().map(str::to_string),
            aliases: page.alias_names(),
            home: page.is_home(),
            modified: page.modified,
        }
    }
}

/// A page, a heading or a block, with the concepts it mentions itself.
#[derive(Debug, Clone)]
pub(crate) struct UnitDigest {
    pub kind: UnitKind,
    pub line: u32,
    pub end_line: u32,
    pub refs: Vec<String>,
    /// For an open task: the days its text names, as [`day_number`]s.
    pub days: Vec<u32>,
}

/// Everything the summary keeps of a page.
#[derive(Debug, Clone)]
pub(crate) struct Digest {
    pub info: PageInfo,
    /// The page first, then its headings and blocks by line.
    pub units: Vec<UnitDigest>,
    /// The words the page uses, as [`hash_word`]s, sorted, each once.
    pub words: Vec<u32>,
}

/// The headings and blocks of a page in the order its units have after the page itself: by
/// line, a heading before the block that starts on the same line. A unit's place in it is
/// what tells it apart from the others on its page.
pub(crate) fn unit_order(page: &Page) -> Vec<(UnitKind, usize)> {
    let mut order: Vec<(UnitKind, usize)> = (0..page.headings.len())
        .map(|i| (UnitKind::Heading, i))
        .chain((0..page.blocks.len()).map(|i| (UnitKind::Block, i)))
        .collect();
    order.sort_by_key(|&(kind, i)| {
        let line = match kind {
            UnitKind::Heading => page.headings[i].line,
            _ => page.blocks[i].line,
        };
        (line, kind)
    });
    order
}

impl Digest {
    /// A template is not a note: its digest has no units and no words, so that nothing finds it.
    pub fn of(page: &Page) -> Digest {
        let info = PageInfo::of(page);
        if page.is_template() {
            return Digest {
                info,
                units: Vec::new(),
                words: Vec::new(),
            };
        }
        let mut units = vec![UnitDigest {
            kind: UnitKind::Page,
            line: 1,
            end_line: 1,
            refs: page.refs.clone(),
            days: Vec::new(),
        }];
        for (kind, i) in unit_order(page) {
            units.push(match kind {
                UnitKind::Heading => {
                    let h = &page.headings[i];
                    UnitDigest {
                        kind,
                        line: line_no(h.line),
                        end_line: line_no(h.end_line),
                        refs: h.refs.clone(),
                        days: Vec::new(),
                    }
                }
                _ => {
                    let b = &page.blocks[i];
                    let mut days: Vec<u32> = Vec::new();
                    if b.task == Some(TaskState::Open) {
                        days = dates_in(&b.text)
                            .iter()
                            .filter_map(|d| day_number(d))
                            .collect();
                        days.sort_unstable();
                        days.dedup();
                    }
                    UnitDigest {
                        kind,
                        line: line_no(b.line),
                        end_line: line_no(b.end_line),
                        refs: b.refs.clone(),
                        days,
                    }
                }
            });
        }

        let mut words: Vec<u32> = Vec::new();
        let mut add = |text: &str| words.extend(tokens(text).iter().map(|t| hash_word(t)));
        add(&page.title());
        for h in &page.headings {
            add(&h.text);
        }
        for b in page.blocks.iter().filter(|b| b.kind != BlockKind::Code) {
            add(&b.text);
        }
        words.sort_unstable();
        words.dedup();
        Digest { info, units, words }
    }
}

fn line_no(line: usize) -> u32 {
    u32::try_from(line).unwrap_or(u32::MAX)
}

/// The words of a text that are worth looking up, lower case: letters and digits, at least
/// [`MIN_WORD_CHARS`] of them. Link addresses and web addresses are not words.
pub(crate) fn tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for chunk in text.split_whitespace() {
        if chunk.contains("://") {
            continue;
        }
        // `Some Title](../a.md)`: the address after `](` is not text.
        let chunk = chunk.split_once("](").map_or(chunk, |(text, _)| text);
        for word in chunk.split(|c: char| !c.is_alphanumeric()) {
            if word.chars().count() >= MIN_WORD_CHARS {
                out.push(word.to_lowercase());
            }
        }
    }
    out
}

/// A word as a number (FNV-1a). Two words may share one: it only decides which pages are
/// looked at, and the words themselves are compared there.
pub(crate) fn hash_word(word: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for b in word.bytes() {
        hash ^= u32::from(b);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// Days from `0000-03-01` for a date written `YYYY-MM-DD`: a number that grows by one a day,
/// so a range of days is a range of numbers. `None` for what is not a date.
pub(crate) fn day_number(date: &str) -> Option<u32> {
    let mut parts = date.split('-');
    let y: i64 = parts.next()?.parse().ok()?;
    let m: i64 = parts.next()?.parse().ok()?;
    let d: i64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    u32::try_from(era * 146_097 + doe).ok()
}

/// The date a [`day_number`] stands for, as `YYYY-MM-DD` (what `day_number` took, unless the
/// day does not exist, like February 31st, which is the day after the 28th or 29th).
pub(crate) fn day_name(day: u32) -> String {
    let z = i64::from(day);
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// One page of the summary: what it says, which file it was made from, and how many units
/// it has (so that the number of units in a bundle is known without counting them).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Row {
    pub info: PageInfo,
    pub stamp: Stamp,
    /// The number of its first unit among the units of all rows, and how many it has.
    pub first: u32,
    pub units: u32,
}

#[derive(Serialize, Deserialize)]
struct ConceptRow {
    name: String,
    /// Where its units start in the list of units of all concepts, and how many there are.
    start: u32,
    len: u32,
}

/// The sizes of the tables that follow the head, which says what the rest is made of.
#[derive(Serialize, Deserialize)]
struct Head {
    rows: Vec<Row>,
    concepts: Vec<ConceptRow>,
    units: u32,
    concept_units: u32,
    words: u32,
    word_pages: u32,
    heavy: u32,
    agenda: u32,
}

/// A unit as the summary holds it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct UnitRef {
    /// The row of the page.
    pub page: usize,
    /// Its place among the units of the page: 0 is the page itself, then see [`unit_order`].
    pub ord: u32,
    pub kind: UnitKind,
    pub line: u32,
    pub end_line: u32,
}

/// The summary of a bundle, as read from its file.
pub(crate) struct Summary {
    pub rows: Vec<Row>,
    concepts: Vec<ConceptRow>,
    /// The file, and where the tables start in it.
    file: Vec<u8>,
    base: usize,
    units_at: usize,
    concept_units_at: usize,
    words: usize,
    word_hashes_at: usize,
    word_starts_at: usize,
    word_pages_at: usize,
    heavy: usize,
    heavy_at: usize,
    agenda: usize,
    agenda_at: usize,
    /// How many units the pages of all rows have together.
    pub total_units: usize,
}

impl Summary {
    /// The summary file for these pages, which must be in path order: the rows and tables, framed.
    pub fn encode(pages: &[(Stamp, Digest)]) -> Vec<u8> {
        let mut units: Vec<u8> = Vec::new();
        let mut concepts: BTreeMap<&str, Vec<u32>> = BTreeMap::new();
        let mut words: HashMap<u32, Vec<u32>> = HashMap::new();
        let mut agenda: Vec<(u32, u32)> = Vec::new();
        let mut rows = Vec::with_capacity(pages.len());
        let mut unit = 0u32;
        for (page, (stamp, digest)) in pages.iter().enumerate() {
            for u in &digest.units {
                let first = u32::try_from(page).unwrap_or(0) | ((u.kind as u32) << 30);
                units.extend_from_slice(&first.to_le_bytes());
                units.extend_from_slice(&u.line.to_le_bytes());
                units.extend_from_slice(&u.end_line.to_le_bytes());
                let mut seen: Vec<&str> = Vec::new();
                for r in &u.refs {
                    if !seen.contains(&r.as_str()) {
                        seen.push(r);
                        concepts.entry(r).or_default().push(unit);
                    }
                }
                agenda.extend(u.days.iter().map(|&d| (d, unit)));
                unit += 1;
            }
            let page_id = u32::try_from(page).unwrap_or(0);
            for &w in &digest.words {
                words.entry(w).or_default().push(page_id);
            }
            rows.push(Row {
                info: digest.info.clone(),
                stamp: *stamp,
                first: unit - u32::try_from(digest.units.len()).unwrap_or(0),
                units: u32::try_from(digest.units.len()).unwrap_or(0),
            });
        }
        let mut concept_rows = Vec::with_capacity(concepts.len());
        let mut concept_units: Vec<u8> = Vec::new();
        let mut at = 0u32;
        for (name, list) in concepts {
            let len = u32::try_from(list.len()).unwrap_or(0);
            concept_rows.push(ConceptRow {
                name: name.to_string(),
                start: at,
                len,
            });
            at += len;
            for u in list {
                concept_units.extend_from_slice(&u.to_le_bytes());
            }
        }
        let mut hashes: Vec<u32> = words.keys().copied().collect();
        hashes.sort_unstable();
        let (mut kept, mut heavy) = (Vec::new(), Vec::new());
        for h in hashes {
            if words[&h].len() <= WORD_KEEP_PAGES {
                kept.push(h);
            } else {
                heavy.push(h);
            }
        }
        let (mut word_hashes, mut word_starts, mut word_pages) =
            (Vec::new(), Vec::new(), Vec::new());
        let mut start = 0u32;
        for h in &kept {
            word_hashes.extend_from_slice(&h.to_le_bytes());
            word_starts.extend_from_slice(&start.to_le_bytes());
            for p in &words[h] {
                word_pages.extend_from_slice(&p.to_le_bytes());
                start += 1;
            }
        }
        word_starts.extend_from_slice(&start.to_le_bytes());
        agenda.sort_unstable();
        let head = Head {
            rows,
            concepts: concept_rows,
            units: unit,
            concept_units: at,
            words: u32::try_from(kept.len()).unwrap_or(0),
            word_pages: start,
            heavy: u32::try_from(heavy.len()).unwrap_or(0),
            agenda: u32::try_from(agenda.len()).unwrap_or(0),
        };
        let mut payload = postcard::to_stdvec(&head).unwrap_or_default();
        payload.extend_from_slice(&units);
        payload.extend_from_slice(&concept_units);
        payload.extend_from_slice(&word_hashes);
        payload.extend_from_slice(&word_starts);
        payload.extend_from_slice(&word_pages);
        for h in heavy {
            payload.extend_from_slice(&h.to_le_bytes());
        }
        for (day, unit) in agenda {
            payload.extend_from_slice(&day.to_le_bytes());
            payload.extend_from_slice(&unit.to_le_bytes());
        }
        frame(MAGIC, &payload)
    }

    /// The summary in a file, if it is a whole one made by this build.
    pub fn decode(file: Vec<u8>) -> Option<Summary> {
        let payload = unframe(MAGIC, &file)?;
        let (head, tables) = postcard::take_from_bytes::<Head>(payload).ok()?;
        let base = file.len() - tables.len();
        let n = |x: u32| x as usize;
        let units_at = 0;
        let concept_units_at = units_at + 12 * n(head.units);
        let word_hashes_at = concept_units_at + 4 * n(head.concept_units);
        let word_starts_at = word_hashes_at + 4 * n(head.words);
        let word_pages_at = word_starts_at + 4 * (n(head.words) + 1);
        let heavy_at = word_pages_at + 4 * n(head.word_pages);
        let agenda_at = heavy_at + 4 * n(head.heavy);
        if tables.len() != agenda_at + 8 * n(head.agenda) {
            return None;
        }
        let total_units = head.rows.iter().map(|r| r.units as usize).sum();
        Some(Summary {
            rows: head.rows,
            concepts: head.concepts,
            file,
            base,
            units_at,
            concept_units_at,
            words: n(head.words),
            word_hashes_at,
            word_starts_at,
            word_pages_at,
            heavy: n(head.heavy),
            heavy_at,
            agenda: n(head.agenda),
            agenda_at,
            total_units,
        })
    }

    /// The number at this position of the tables. A file that is not what it says it is, which
    /// the checksum rules out, reads as zeros, never as a panic.
    fn at(&self, offset: usize) -> u32 {
        self.file
            .get(self.base + offset..self.base + offset + 4)
            .and_then(|b| b.try_into().ok())
            .map_or(0, u32::from_le_bytes)
    }

    fn unit(&self, unit: u32) -> UnitRef {
        let at = self.units_at + 12 * unit as usize;
        let first = self.at(at);
        let page = (first & 0x3fff_ffff) as usize;
        UnitRef {
            page,
            ord: unit.saturating_sub(self.rows.get(page).map_or(0, |r| r.first)),
            kind: match first >> 30 {
                0 => UnitKind::Page,
                1 => UnitKind::Heading,
                _ => UnitKind::Block,
            },
            line: self.at(at + 4),
            end_line: self.at(at + 8),
        }
    }

    /// The units that mention the concept itself, or one nested under it (`project` finds
    /// `project/tessela`), by page and line.
    pub fn concept_units(&self, concept: &str) -> Vec<UnitRef> {
        let mut found = Vec::new();
        let mut take = |row: &ConceptRow| {
            for i in 0..row.len {
                let unit = self.at(self.concept_units_at + 4 * (row.start + i) as usize);
                found.push(self.unit(unit));
            }
        };
        if let Ok(i) = self
            .concepts
            .binary_search_by(|r| r.name.as_str().cmp(concept))
        {
            take(&self.concepts[i]);
        }
        let prefix = format!("{concept}/");
        let from = self.concepts.partition_point(|r| r.name < prefix);
        for row in self.concepts[from..]
            .iter()
            .take_while(|r| r.name.starts_with(&prefix))
        {
            take(row);
        }
        found
    }

    /// The pages (rows) that use the word, `None` when it is used by too many to tell anything.
    pub fn word_pages(&self, hash: u32) -> Option<Vec<usize>> {
        let (mut lo, mut hi) = (0, self.words);
        while lo < hi {
            let mid = (lo + hi) / 2;
            if self.at(self.word_hashes_at + 4 * mid) < hash {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if lo < self.words && self.at(self.word_hashes_at + 4 * lo) == hash {
            let from = self.at(self.word_starts_at + 4 * lo) as usize;
            let to = self.at(self.word_starts_at + 4 * (lo + 1)) as usize;
            return Some(
                (from..to)
                    .map(|i| self.at(self.word_pages_at + 4 * i) as usize)
                    .collect(),
            );
        }
        // Not kept: either nobody uses it, or too many do.
        let (mut lo, mut hi) = (0, self.heavy);
        while lo < hi {
            let mid = (lo + hi) / 2;
            if self.at(self.heavy_at + 4 * mid) < hash {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if lo < self.heavy && self.at(self.heavy_at + 4 * lo) == hash {
            None
        } else {
            Some(Vec::new())
        }
    }

    /// The open tasks that name a day from `from` to `to`, as (that day, the task).
    pub fn tasks_between(&self, from: u32, to: u32) -> Vec<(u32, UnitRef)> {
        let (mut lo, mut hi) = (0, self.agenda);
        while lo < hi {
            let mid = (lo + hi) / 2;
            if self.at(self.agenda_at + 8 * mid) < from {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        let mut found = Vec::new();
        for i in lo..self.agenda {
            let day = self.at(self.agenda_at + 8 * i);
            if day > to {
                break;
            }
            found.push((day, self.unit(self.at(self.agenda_at + 8 * i + 4))));
        }
        found
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_count_up_by_one_and_name_themselves() {
        let a = day_number("2026-02-28").unwrap();
        assert_eq!(day_number("2026-03-01"), Some(a + 1));
        assert_eq!(
            day_number("2028-02-29"),
            Some(day_number("2028-02-28").unwrap() + 1)
        );
        assert_eq!(
            day_number("2027-01-01"),
            Some(day_number("2026-12-31").unwrap() + 1)
        );
        assert_eq!(day_name(a), "2026-02-28");
        assert_eq!(day_number("2026-13-01"), None);
        assert_eq!(day_number("nope"), None);
    }

    fn digest(path: &str, words: &[&str]) -> (Stamp, Digest) {
        let mut page = Page::parse(path, "");
        page.modified = Some(0);
        let mut digest = Digest::of(&page);
        digest.words = words.iter().map(|w| hash_word(w)).collect();
        digest.words.sort_unstable();
        (Stamp::of(&std::fs::metadata(".").unwrap()).unwrap(), digest)
    }

    #[test]
    fn a_word_too_many_pages_use_is_not_looked_up_and_one_that_few_use_is() {
        // `common` is in 130 pages (over what is kept), `some` in 100 (kept, and still too many to
        // tell anything), `rare` in two.
        let pages: Vec<(Stamp, Digest)> = (0..130)
            .map(|i| {
                let mut words = vec!["common"];
                if i < 100 {
                    words.push("some");
                }
                if i < 2 {
                    words.push("rare");
                }
                digest(&format!("p{i:03}.md"), &words)
            })
            .collect();
        let summary = Summary::decode(Summary::encode(&pages)).expect("a whole file");
        assert_eq!(summary.word_pages(hash_word("common")), None);
        assert_eq!(
            summary.word_pages(hash_word("some")).map(|p| p.len()),
            Some(100)
        );
        assert_eq!(summary.word_pages(hash_word("rare")), Some(vec![0, 1]));
        assert_eq!(summary.word_pages(hash_word("unused")), Some(vec![]));
    }

    #[test]
    fn a_damaged_file_is_no_summary() {
        let pages = vec![digest("a.md", &["word"])];
        let mut file = Summary::encode(&pages);
        assert!(Summary::decode(file.clone()).is_some());
        let at = file.len() - 1;
        file[at] ^= 1;
        assert!(Summary::decode(file.clone()).is_none());
        file.truncate(10);
        assert!(Summary::decode(file).is_none());
    }

    #[test]
    fn words_are_lower_case_whole_and_leave_addresses_out() {
        assert_eq!(
            tokens(
                "Some Title](../topics/other-page.md) and https://example.org/zebra Zebrafish, a b #Tagged"
            ),
            ["some", "title", "zebrafish", "tagged"]
        );
    }
}
