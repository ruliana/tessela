//! `tessela watch`: a read-only stream of the pages that change on disk.
//!
//! The operating system's watcher is used when it can be; it can fail (macOS hands out a
//! limited number of folder watchers to the whole machine) and then the folder is looked at
//! every few seconds instead, with the system watcher tried again now and then. Changes that
//! come close together are reported as one.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use walkdir::WalkDir;

pub struct Options {
    /// Use the system watcher when there is one. Off: always look at the files, which is what
    /// folders the system cannot watch (network shares) need.
    pub native: bool,
    /// How long to wait for more changes before reporting the ones seen.
    pub debounce: Duration,
    /// The longest a change waits to be reported, however busy the folder is.
    pub max_wait: Duration,
    /// How often the fallback looks at the files.
    pub poll: Duration,
    /// How long to wait before trying the system watcher again.
    pub retry: Duration,
}

impl Default for Options {
    fn default() -> Options {
        Options {
            native: true,
            debounce: Duration::from_millis(150),
            max_wait: Duration::from_secs(1),
            poll: Duration::from_secs(2),
            retry: Duration::from_secs(60),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// The system tells us.
    Native,
    /// We look at the files every few seconds.
    Polling,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Native => "native",
            Mode::Polling => "polling",
        }
    }
}

pub enum Event {
    /// Watching has started, in this mode.
    Ready(Mode),
    /// The mode changed, and why.
    Mode(Mode, String),
    /// These pages (sorted, relative, with `/`) were created, changed or removed.
    Changed(Vec<String>),
}

/// Reports changes under `root` to `emit` until the process ends.
pub fn watch(root: &Path, options: &Options, mut emit: impl FnMut(Event)) -> Result<(), String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let (send, events) = mpsc::channel();
    // `watcher` is the system's, when there is one; without it the files are looked at.
    let mut watcher = None;
    let mut why = String::from("polling was asked for");
    if options.native {
        match native(&root, &send) {
            Ok(w) => watcher = Some(w),
            Err(e) => why = e.to_string(),
        }
    }
    // Looked at before saying "ready", so a change made right after that is not missed.
    let mut snapshot = watcher.is_none().then(|| stamps(&root));
    let mode_of = |w: &Option<Box<dyn Watcher>>| {
        if w.is_some() {
            Mode::Native
        } else {
            Mode::Polling
        }
    };
    emit(Event::Ready(mode_of(&watcher)));
    if options.native && watcher.is_none() {
        emit(Event::Mode(Mode::Polling, why));
    }

    let mut pending = BTreeSet::new();
    let mut report_at: Option<Instant> = None;
    // When the oldest change that was not reported yet was seen.
    let mut oldest: Option<Instant> = None;
    let mut next_poll = Instant::now() + options.poll;
    let mut retry_at = Instant::now() + options.retry;
    loop {
        let now = Instant::now();
        let mut wake = report_at.unwrap_or(now + options.retry);
        if watcher.is_none() {
            wake = wake.min(next_poll);
            if options.native {
                wake = wake.min(retry_at);
            }
        }
        match events.recv_timeout(wake.saturating_duration_since(now)) {
            Ok(Ok(event)) => {
                if matches!(event.kind, EventKind::Access(_)) {
                    continue;
                }
                for path in &event.paths {
                    if let Some(rel) = page_path(&root, path) {
                        pending.insert(rel);
                        report_at = Some(due(&mut oldest, options));
                    }
                }
            }
            Ok(Err(error)) if watcher.is_some() => {
                // The system watcher gave up: look at the files instead.
                watcher = None;
                snapshot = Some(stamps(&root));
                next_poll = Instant::now() + options.poll;
                retry_at = Instant::now() + options.retry;
                emit(Event::Mode(Mode::Polling, error.to_string()));
            }
            Ok(Err(_)) | Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Ok(()),
        }
        let now = Instant::now();
        if watcher.is_none() && next_poll <= now {
            next_poll = now + options.poll;
            let seen = stamps(&root);
            if let Some(before) = &snapshot {
                let changed = seen
                    .keys()
                    .chain(before.keys())
                    .filter(|rel| seen.get(*rel) != before.get(*rel));
                for rel in changed {
                    pending.insert(rel.clone());
                    report_at = Some(due(&mut oldest, options));
                }
            }
            snapshot = Some(seen);
        }
        if report_at.is_some_and(|at| at <= now) {
            report_at = None;
            oldest = None;
            emit(Event::Changed(
                std::mem::take(&mut pending).into_iter().collect(),
            ));
        }
        if watcher.is_none() && options.native && retry_at <= now {
            retry_at = now + options.retry;
            if let Ok(w) = native(&root, &send) {
                watcher = Some(w);
                snapshot = None;
                emit(Event::Mode(
                    Mode::Native,
                    "the system watcher works again".into(),
                ));
            }
        }
    }
}

/// When to report the changes seen so far: a moment after the last one, but never later than
/// `max_wait` after the first, so a folder that keeps changing still gets reported.
fn due(oldest: &mut Option<Instant>, options: &Options) -> Instant {
    let first = *oldest.get_or_insert_with(Instant::now);
    (Instant::now() + options.debounce).min(first + options.max_wait)
}

type Sender = mpsc::Sender<notify::Result<notify::Event>>;

fn native(root: &Path, send: &Sender) -> notify::Result<Box<dyn Watcher>> {
    let mut watcher = RecommendedWatcher::new(send.clone(), Config::default())?;
    watcher.watch(root, RecursiveMode::Recursive)?;
    Ok(Box::new(watcher))
}

/// What the pages of the bundle look like now: a stamp that changes when a file does.
fn stamps(root: &Path) -> BTreeMap<String, (u128, u64)> {
    let mut found = BTreeMap::new();
    let walker = WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'));
    for entry in walker.filter_map(Result::ok) {
        let Some(rel) = page_path(root, entry.path()) else {
            continue;
        };
        if let Ok(meta) = entry.metadata()
            && meta.is_file()
        {
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos());
            found.insert(rel, (modified, meta.len()));
        }
    }
    found
}

/// The page path (relative, with `/`) of a changed file, or `None` when it is not a page:
/// not Markdown, or inside a hidden folder.
fn page_path(root: &Path, file: &Path) -> Option<String> {
    let rel: PathBuf = file.strip_prefix(root).ok()?.to_path_buf();
    let mut parts = Vec::new();
    for component in rel.components() {
        let Component::Normal(name) = component else {
            return None;
        };
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            return None;
        }
        parts.push(name.into_owned());
    }
    let last = parts.last()?;
    last.ends_with(".md").then(|| parts.join("/"))
}
