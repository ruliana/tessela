//! The corpus `surface` looks at: the pages of a bundle as a [`Summary`] and the pages that
//! differ from it.
//!
//! A call walks the folder and looks at each file's size and modification time, like a call
//! that loads the bundle. Pages whose files look as the summary says are taken from it without
//! being read. The others (changed, new) are read and put in a [`Digest`] of their own, and the
//! summary's rows for changed and deleted files are ignored. The answer is the same as if the
//! summary were made again from the files: a test checks it. When many pages differ, or there
//! is no summary, a new one is made and kept, which reads every page (from the parse cache,
//! where it has them) once.
//!
//! With no cache (`TESSELA_NO_CACHE`) there is no summary and every page is read and digested.

use std::cell::OnceCell;
use std::collections::HashMap;
use std::io;
use std::path::Path;

use crate::bundle::{File, Loaded, read_page, spread, stamp_of, sweep, walk};
use crate::cache::{Cache, Stamp};
use crate::page::Page;
use crate::query::mentions_concept;
use crate::summary::{Digest, FILE, MAX_OVERLAY, PageInfo, Summary, UnitKind, WORD_MAX_PAGES};

/// A page of the corpus: a row of the summary, or after all of them, a page that differs from it.
pub(crate) type PageId = usize;

/// A page, a heading or a block of some page.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Unit {
    pub page: PageId,
    /// Its place among the units of the page (see [`crate::summary::unit_order`]).
    pub ord: u32,
    pub kind: UnitKind,
    pub line: u32,
    pub end_line: u32,
}

pub(crate) struct Corpus {
    cache: Option<Cache>,
    files: Vec<File>,
    by_path: OnceCell<HashMap<String, usize>>,
    summary: Option<Summary>,
    /// For each row of the summary: its page changed or is gone, so the row is not used.
    stale: Vec<bool>,
    /// The pages that differ from the summary (all of them with no summary), by path.
    fresh: Vec<Digest>,
    /// Pages read so far, so that none is read twice.
    pages: HashMap<String, Page>,
}

impl Corpus {
    /// Opens the corpus of the bundle at `root`. With `use_cache` false no cache is read or
    /// written, and every page is read from its file.
    pub fn open(root: &Path, use_cache: bool) -> io::Result<Corpus> {
        if !root.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("{} is not a directory", root.display()),
            ));
        }
        let files = walk(root)?;
        let cache = if use_cache { Cache::open(root) } else { None };
        let mut corpus = Corpus {
            cache,
            files,
            by_path: OnceCell::new(),
            summary: None,
            stale: Vec::new(),
            fresh: Vec::new(),
            pages: HashMap::new(),
        };
        if corpus.cache.is_none() {
            let all: Vec<usize> = (0..corpus.files.len()).collect();
            corpus.read_fresh(&all);
            return Ok(corpus);
        }
        // What every file looks like now, taken before anything is read.
        let stamps: Vec<Option<Stamp>> = spread(&corpus.files, stamp_of);
        let summary = corpus
            .cache
            .as_ref()
            .and_then(|c| c.get_named(FILE))
            .and_then(Summary::decode);
        if let Some(summary) = summary {
            let row_of: HashMap<&str, usize> = summary
                .rows
                .iter()
                .enumerate()
                .map(|(i, r)| (r.info.path.as_str(), i))
                .collect();
            let mut stale = vec![true; summary.rows.len()];
            let mut changed = Vec::new();
            for (i, file) in corpus.files.iter().enumerate() {
                match row_of.get(file.rel.as_str()) {
                    Some(&r) if stamps[i] == Some(summary.rows[r].stamp) => stale[r] = false,
                    _ => changed.push(i),
                }
            }
            let gone = stale.iter().filter(|&&s| s).count();
            if gone + changed.len() <= MAX_OVERLAY {
                corpus.stale = stale;
                corpus.summary = Some(summary);
                corpus.read_fresh(&changed);
                return Ok(corpus);
            }
        }
        corpus.rebuild(&stamps);
        Ok(corpus)
    }

    /// Reads the pages of these files and digests them as the pages that differ from the summary.
    fn read_fresh(&mut self, indexes: &[usize]) {
        let cache = self.cache.as_ref();
        let files = &self.files;
        let loaded = spread(indexes, |&i| match read_page(&files[i], cache) {
            Loaded::Page(page) => Some((Digest::of(&page), page)),
            Loaded::Unreadable(..) => None,
        });
        for (digest, page) in loaded.into_iter().flatten() {
            self.pages.insert(page.path.clone(), page);
            self.fresh.push(digest);
        }
    }

    /// Makes the summary from every page and keeps it. A page whose file changed a moment ago
    /// stays out of it, like out of the parse cache, and is looked at on every call until a
    /// later summary has it.
    fn rebuild(&mut self, stamps: &[Option<Stamp>]) {
        let Some(cache) = &self.cache else { return };
        let now = cache.now();
        let files = &self.files;
        let digests = spread(&(0..files.len()).collect::<Vec<_>>(), |&i| match read_page(
            &files[i],
            Some(cache),
        ) {
            Loaded::Page(page) => Some(Digest::of(&page)),
            Loaded::Unreadable(..) => None,
        });
        let mut kept = Vec::with_capacity(digests.len());
        for (digest, stamp) in digests.into_iter().zip(stamps) {
            match (digest, stamp) {
                (Some(digest), Some(stamp)) if stamp.settled(now) => kept.push((*stamp, digest)),
                (Some(digest), _) => self.fresh.push(digest),
                (None, _) => {}
            }
        }
        let bytes = Summary::encode(&kept);
        cache.put_named(FILE, &bytes);
        sweep(Some(cache), &self.files);
        self.summary = Summary::decode(bytes);
        self.stale = vec![false; self.summary.as_ref().map_or(0, |s| s.rows.len())];
    }

    fn rows(&self) -> usize {
        self.summary.as_ref().map_or(0, |s| s.rows.len())
    }

    pub fn info(&self, id: PageId) -> &PageInfo {
        match &self.summary {
            Some(s) if id < s.rows.len() => &s.rows[id].info,
            _ => &self.fresh[id - self.rows()].info,
        }
    }

    /// A page that counts: not one the summary has a stale row for, and not a template.
    fn alive(&self, id: PageId) -> bool {
        (id >= self.rows() || !self.stale[id]) && self.info(id).kind.as_deref() != Some("template")
    }

    /// Every page, in no particular order.
    pub fn pages(&self) -> impl Iterator<Item = PageId> + '_ {
        (0..self.rows() + self.fresh.len()).filter(|&id| self.alive(id))
    }

    pub fn page_count(&self) -> usize {
        (0..self.rows() + self.fresh.len())
            .filter(|&id| self.alive(id))
            .count()
    }

    /// The pages, headings and blocks of all pages together.
    pub fn unit_count(&self) -> usize {
        let Some(summary) = &self.summary else {
            return self.fresh.iter().map(|d| d.units.len()).sum();
        };
        let stale: usize = summary
            .rows
            .iter()
            .zip(&self.stale)
            .filter(|(_, s)| **s)
            .map(|(r, _)| r.units as usize)
            .sum();
        summary.total_units - stale + self.fresh.iter().map(|d| d.units.len()).sum::<usize>()
    }

    /// The page with this path.
    pub fn id_of(&self, path: &str) -> Option<PageId> {
        self.pages().find(|&id| self.info(id).path == path)
    }

    /// The units that mention the concept itself, or one nested under it.
    pub fn concept_units(&self, concept: &str) -> Vec<Unit> {
        let mut found: Vec<Unit> = Vec::new();
        if let Some(summary) = &self.summary {
            found.extend(
                summary
                    .concept_units(concept)
                    .into_iter()
                    .filter(|u| self.alive(u.page))
                    .map(|u| Unit {
                        page: u.page,
                        ord: u.ord,
                        kind: u.kind,
                        line: u.line,
                        end_line: u.end_line,
                    }),
            );
        }
        let rows = self.rows();
        for (i, digest) in self.fresh.iter().enumerate() {
            for (ord, u) in digest.units.iter().enumerate() {
                if mentions_concept(&u.refs, concept) {
                    found.push(Unit {
                        page: rows + i,
                        ord: ord as u32,
                        kind: u.kind,
                        line: u.line,
                        end_line: u.end_line,
                    });
                }
            }
        }
        // A unit that mentions several concepts nested under this one is listed once.
        found.sort_unstable_by_key(|u| (u.page, u.ord));
        found.dedup_by_key(|u| (u.page, u.ord));
        found
    }

    /// The pages that use a word, or `None` when no page does, or so many that it says nothing.
    pub fn word_pages(&self, hash: u32) -> Option<Vec<PageId>> {
        let mut found: Vec<PageId> = Vec::new();
        if let Some(summary) = &self.summary {
            found.extend(
                summary
                    .word_pages(hash)?
                    .into_iter()
                    .filter(|&p| self.alive(p)),
            );
        }
        let rows = self.rows();
        for (i, digest) in self.fresh.iter().enumerate() {
            if digest.words.binary_search(&hash).is_ok() {
                found.push(rows + i);
            }
        }
        (!found.is_empty() && found.len() <= WORD_MAX_PAGES).then_some(found)
    }

    /// The open tasks that name a day from `from` to `to`, as (that day, the task).
    pub fn tasks_between(&self, from: u32, to: u32) -> Vec<(u32, Unit)> {
        let mut found: Vec<(u32, Unit)> = Vec::new();
        if let Some(summary) = &self.summary {
            found.extend(
                summary
                    .tasks_between(from, to)
                    .into_iter()
                    .filter(|(_, u)| self.alive(u.page))
                    .map(|(day, u)| {
                        (
                            day,
                            Unit {
                                page: u.page,
                                ord: u.ord,
                                kind: u.kind,
                                line: u.line,
                                end_line: u.end_line,
                            },
                        )
                    }),
            );
        }
        let rows = self.rows();
        for (i, digest) in self.fresh.iter().enumerate() {
            for (ord, u) in digest.units.iter().enumerate() {
                for &day in u.days.iter().filter(|&&d| (from..=to).contains(&d)) {
                    found.push((
                        day,
                        Unit {
                            page: rows + i,
                            ord: ord as u32,
                            kind: u.kind,
                            line: u.line,
                            end_line: u.end_line,
                        },
                    ));
                }
            }
        }
        found
    }

    /// Reads the pages with these paths (the ones not read yet), on all cores when many.
    pub fn prefetch(&mut self, paths: &[&str]) {
        let by_path = self.by_path.get_or_init(|| {
            let mut index = HashMap::with_capacity(self.files.len());
            for (i, f) in self.files.iter().enumerate() {
                index.insert(f.rel.clone(), i);
            }
            index
        });
        let mut wanted: Vec<usize> = paths
            .iter()
            .filter(|p| !self.pages.contains_key(**p))
            .filter_map(|p| by_path.get(*p).copied())
            .collect();
        wanted.sort_unstable();
        wanted.dedup();
        let cache = self.cache.as_ref();
        let files = &self.files;
        let loaded = spread(&wanted, |&i| match read_page(&files[i], cache) {
            Loaded::Page(page) => Some(page),
            Loaded::Unreadable(..) => None,
        });
        for page in loaded.into_iter().flatten() {
            self.pages.insert(page.path.clone(), page);
        }
    }

    /// A page that `prefetch` read.
    pub fn page(&self, path: &str) -> Option<&Page> {
        self.pages.get(path)
    }
}
