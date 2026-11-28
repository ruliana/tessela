//! Bundles: a folder of OKF files.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use rayon::prelude::*;
use walkdir::{DirEntry, WalkDir};

use crate::cache::{Cache, Stamp};
use crate::page::Page;
use crate::prefilter::{Prefilter, may_define_aliases};
use crate::query::Query;
use crate::refs::normalize_concept;

#[derive(Debug)]
pub struct Bundle {
    pub root: PathBuf,
    /// Concept pages, sorted by path. `index.md` and `log.md` are reserved by OKF and not included.
    pub pages: Vec<Page>,
    /// Files that could not be read, with the reason.
    pub unreadable: Vec<(String, String)>,
}

impl Bundle {
    /// Loads every page of the bundle. The folder tree is walked on one thread (it is cheap);
    /// each file is then looked at on every core. A page whose file has not changed since the
    /// last call comes from the parse cache in `.tessela/cache/` (see [`crate::cache`]); the
    /// others are read and parsed, and put in the cache. A small bundle is read on the calling
    /// thread. The result is the same as [`Bundle::load_sequential`]: pages sorted by path,
    /// files that cannot be read listed in the same order. `TESSELA_NO_CACHE` skips the cache.
    pub fn load(root: impl AsRef<Path>) -> std::io::Result<Bundle> {
        let cache = Cache::open(root.as_ref());
        Self::load_with(root, |files| {
            let cache = cache.as_ref();
            let loaded = if files.len() < PARALLEL_FROM {
                files.iter().map(|f| read_page(f, cache)).collect()
            } else {
                files.par_iter().map(|f| read_page(f, cache)).collect()
            };
            sweep(cache, files);
            loaded
        })
    }

    /// [`Bundle::load`] on the calling thread alone, and without the cache. It is the reference
    /// the parallel, cached load is tested against.
    pub fn load_sequential(root: impl AsRef<Path>) -> std::io::Result<Bundle> {
        Self::load_with(root, |files| {
            files.iter().map(|f| read_page(f, None)).collect()
        })
    }

    fn load_with(
        root: impl AsRef<Path>,
        read: impl FnOnce(&[File]) -> Vec<Loaded>,
    ) -> std::io::Result<Bundle> {
        let root = root.as_ref().to_path_buf();
        if !root.is_dir() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("{} is not a directory", root.display()),
            ));
        }
        let files = walk(&root)?;
        let mut pages = Vec::with_capacity(files.len());
        let mut unreadable = Vec::new();
        for loaded in read(&files) {
            match loaded {
                Loaded::Page(page) => pages.push(page),
                Loaded::Unreadable(path, reason) => unreadable.push((path, reason)),
            }
        }
        Ok(Bundle {
            root,
            pages,
            unreadable,
        })
    }

    /// The pages a query could need, and no others: [`Query::run`] on this gives the hits it
    /// gives on [`Bundle::load`]. Files whose bytes rule the query out are read but not parsed
    /// (see `prefilter.rs`), a file the `page` filter rules out is not even read, and a query
    /// with nothing to rule out (`unlinked`, or no text, concept or page) loads everything.
    /// Pages come in path order, and the work is spread over the cores like `load`'s.
    /// `unreadable` lists only the files that were read.
    pub fn load_for(root: impl AsRef<Path>, query: &Query) -> std::io::Result<Bundle> {
        let Some(mut filter) = Prefilter::new(query) else {
            return Bundle::load(root);
        };
        let root = root.as_ref().to_path_buf();
        if !root.is_dir() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("{} is not a directory", root.display()),
            ));
        }
        let cache = Cache::open(&root);
        let cache = cache.as_ref();
        let files = walk(&root)?;
        let mut pages = Vec::new();
        let mut unreadable = Vec::new();
        if !filter.needs_aliases() {
            let wanted: Vec<&File> = files.iter().filter(|f| filter.path_ok(&f.rel)).collect();
            let loaded = spread(&wanted, |f| {
                let stamp = stamp_of(f);
                match read_text(f) {
                    Ok(text) => filter
                        .admits(&f.rel, &text)
                        .then(|| Loaded::Page(page_of(f, &text, stamp.as_ref(), cache))),
                    Err(reason) => Some(Loaded::Unreadable(f.rel.clone(), reason)),
                }
            });
            for loaded in loaded.into_iter().flatten() {
                match loaded {
                    Loaded::Page(page) => pages.push(page),
                    Loaded::Unreadable(path, reason) => unreadable.push((path, reason)),
                }
            }
        } else {
            // Which names mean the asked concepts depends on the `aliases` of pages that may
            // be anywhere, so every file is read and held until those are known. The pages
            // with `aliases` stay in the answer whatever they say: `Query::run` asks them again.
            let read = spread(&files, |f| {
                let stamp = stamp_of(f);
                (f, stamp, read_text(f))
            });
            let mut aliased = spread(&read, |(file, stamp, text)| {
                let text = text.as_ref().ok()?;
                may_define_aliases(text).then(|| page_of(file, text, stamp.as_ref(), cache))
            });
            let names: Vec<Vec<String>> = query
                .refs
                .iter()
                .map(|r| names_in(aliased.iter().flatten(), &normalize_concept(r)))
                .collect();
            filter.with_names(&names);
            let others = spread(&(0..read.len()).collect::<Vec<_>>(), |&i| {
                let (file, stamp, text) = &read[i];
                let text = text.as_ref().ok()?;
                (aliased[i].is_none() && filter.admits(&file.rel, text))
                    .then(|| page_of(file, text, stamp.as_ref(), cache))
            });
            for ((file, _, text), (aliased, other)) in
                read.iter().zip(aliased.iter_mut().zip(others))
            {
                match text {
                    Ok(_) => pages.extend(aliased.take().or(other)),
                    Err(reason) => unreadable.push((file.rel.clone(), reason.clone())),
                }
            }
        }
        sweep(cache, &files);
        Ok(Bundle {
            root,
            pages,
            unreadable,
        })
    }

    /// The page at `path` (relative to `root`, with `/`), parsed on its own: no walk, no other
    /// file read. `None` for what `load` would not list: no such file, `index.md` and `log.md`,
    /// anything under a hidden name, a symlink, or a file that cannot be read as UTF-8.
    /// For a command about one page; one that needs the others still uses `load`.
    pub fn load_page(root: impl AsRef<Path>, path: &str) -> std::io::Result<Option<Page>> {
        let root = root.as_ref();
        if !root.is_dir() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("{} is not a directory", root.display()),
            ));
        }
        let parts: Vec<&str> = path.split('/').collect();
        let name = parts.last().copied().unwrap_or_default();
        if !name.ends_with(".md")
            || is_reserved(name)
            || parts.iter().any(|p| p.is_empty() || p.starts_with('.'))
        {
            return Ok(None);
        }
        // `load` walks real folders and real files only; a link is not part of the bundle.
        let mut file = root.to_path_buf();
        let mut meta = None;
        for (i, part) in parts.iter().enumerate() {
            file.push(part);
            match std::fs::symlink_metadata(&file) {
                Ok(m) => meta = Some(m),
                Err(_) => return Ok(None),
            }
            let ok = meta.as_ref().is_some_and(|m| {
                if i + 1 == parts.len() {
                    m.is_file()
                } else {
                    m.is_dir()
                }
            });
            if !ok {
                return Ok(None);
            }
        }
        let Ok(Ok(text)) = std::fs::read(&file).map(String::from_utf8) else {
            return Ok(None);
        };
        let mut page = Page::parse(path, &text);
        page.modified = meta
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|d| u64::try_from(d.as_millis()).ok());
        Ok(Some(page))
    }

    pub fn page(&self, id: &str) -> Option<&Page> {
        self.pages.iter().find(|p| p.id.eq_ignore_ascii_case(id))
    }

    /// The concepts that mean `concept`: itself, and the page that lists it in its
    /// frontmatter `aliases`, so a name that is only an alias still finds the page's backlinks.
    pub fn names_for(&self, concept: &str) -> Vec<String> {
        names_in(self.pages.iter(), concept)
    }

    /// IDs of all pages, lowercased, for checking whether a concept has a page.
    pub fn page_ids(&self) -> HashSet<String> {
        self.pages.iter().map(|p| p.id.to_lowercase()).collect()
    }
}

/// Below this many files, starting the worker threads costs more than they save.
const PARALLEL_FROM: usize = 64;

/// A file of the bundle found by the walk, not read yet.
struct File {
    full: PathBuf,
    /// Relative to the root, with `/`.
    rel: String,
}

enum Loaded {
    Page(Page),
    Unreadable(String, String),
}

/// Reads and parses one file: the work `load` spreads over the cores. With a cache, a file
/// that looks as it did when its page was cached is not read at all.
fn read_page(file: &File, cache: Option<&Cache>) -> Loaded {
    let stamp = stamp_of(file);
    if let Some(page) = cached(file, cache, stamp.as_ref()) {
        return Loaded::Page(page);
    }
    match read_text(file) {
        Ok(text) => Loaded::Page(parsed(file, &text, stamp.as_ref(), cache)),
        Err(reason) => Loaded::Unreadable(file.rel.clone(), reason),
    }
}

fn is_reserved(file_name: &str) -> bool {
    matches!(file_name, "index.md" | "log.md")
}

fn is_ignored(entry: &DirEntry) -> bool {
    entry.depth() > 0 && entry.file_name().to_string_lossy().starts_with('.')
}

/// [`Bundle::names_for`] over some pages: all the ones with `aliases` have to be among them.
fn names_in<'a>(pages: impl Iterator<Item = &'a Page>, concept: &str) -> Vec<String> {
    let mut names = vec![concept.to_string()];
    for page in pages {
        let id = normalize_concept(&page.id);
        if !names.contains(&id) && page.aliases().iter().any(|a| a == concept) {
            names.push(id);
        }
    }
    names
}

/// Every file of the bundle, in path order, not read yet.
fn walk(root: &Path) -> std::io::Result<Vec<File>> {
    let mut files = Vec::new();
    let walker = WalkDir::new(root)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|e| !is_ignored(e));
    for entry in walker {
        let entry = entry.map_err(std::io::Error::other)?;
        let name = entry.file_name().to_string_lossy();
        if !entry.file_type().is_file() || !name.ends_with(".md") || is_reserved(&name) {
            continue;
        }
        let rel = entry.path().strip_prefix(root).unwrap_or(entry.path());
        let rel = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        files.push(File {
            full: entry.path().to_path_buf(),
            rel,
        });
    }
    Ok(files)
}

/// The text of a file, or why it cannot be read as text.
fn read_text(file: &File) -> Result<String, String> {
    match std::fs::read(&file.full).map(String::from_utf8) {
        Ok(Ok(text)) => Ok(text),
        Ok(Err(_)) => Err("file is not valid UTF-8".into()),
        Err(e) => Err(e.to_string()),
    }
}

/// Removes the cache entries of pages that are gone, after a call that wrote some.
fn sweep(cache: Option<&Cache>, files: &[File]) {
    if let Some(cache) = cache.filter(|c| c.written() > 0) {
        cache.sweep(files.iter().map(|f| f.rel.as_str()));
    }
}

/// What the file looks like now. Taken before the file is read, never after: a change in
/// between then shows as a new stamp on the next call, where the other order would pair old
/// text with a new stamp and keep it.
fn stamp_of(file: &File) -> Option<Stamp> {
    std::fs::metadata(&file.full)
        .ok()
        .as_ref()
        .and_then(Stamp::of)
}

/// The page from the cache, if it has one made from a file that looked like `stamp`.
fn cached(file: &File, cache: Option<&Cache>, stamp: Option<&Stamp>) -> Option<Page> {
    let mut page = cache?.read(&file.rel, stamp?)?;
    page.modified = stamp.map(Stamp::millis);
    Some(page)
}

/// The page `text` makes: from the cache when it has it, else parsed and put in the cache.
/// `stamp` is what the file looked like just before `text` was read.
fn page_of(file: &File, text: &str, stamp: Option<&Stamp>, cache: Option<&Cache>) -> Page {
    cached(file, cache, stamp).unwrap_or_else(|| parsed(file, text, stamp, cache))
}

/// Parses `text` and puts the page in the cache.
fn parsed(file: &File, text: &str, stamp: Option<&Stamp>, cache: Option<&Cache>) -> Page {
    let mut page = Page::parse(&file.rel, text);
    page.modified = stamp.map(Stamp::millis);
    if let (Some(cache), Some(stamp)) = (cache, stamp) {
        cache.write(&file.rel, stamp, &page);
    }
    page
}

/// `f` on every item, in order, on all the cores when there are many.
fn spread<'a, T: Sync, R: Send>(items: &'a [T], f: impl Fn(&'a T) -> R + Sync + Send) -> Vec<R> {
    if items.len() < PARALLEL_FROM {
        items.iter().map(f).collect()
    } else {
        items.par_iter().map(f).collect()
    }
}
