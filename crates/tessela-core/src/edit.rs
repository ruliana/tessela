//! Changing a bundle: the one place where pages are written (spec §9).
//!
//! The editor and agents both go through these operations, by way of the `tessela` command
//! line tool, so they all follow the same rules: a write never overwrites a change it has
//! not seen (the caller names the content hash it read), a write is atomic, and moving a page
//! rewrites the tags and links that name it. The files are the source of truth: nothing is
//! cached, every operation reads what is on disk.
//!
//! Operations are written against [`PageStore`], so a bundle that lives somewhere else (a
//! remote service, a database) only needs another store.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::page::Page;
use crate::refs::normalize_concept;
use crate::rewrite::{Rewrite, Where};

/// The version of the contract between callers and the tool: command names, arguments and JSON
/// output. Callers say which one they were written for, and the tool refuses when it differs.
pub const API_VERSION: u32 = 2;

/// A short fingerprint of a page's text. Callers hand it back to say what they based a change on.
pub fn content_hash(text: &str) -> String {
    blake3::hash(text.as_bytes()).to_hex()[..16].to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    /// The page on disk is not the one the caller based its change on.
    Conflict,
    NotFound,
    /// A page is already there.
    Exists,
    InvalidPath,
    InvalidPatch,
    InvalidInput,
    ApiMismatch,
    Io,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::Conflict => "conflict",
            ErrorCode::NotFound => "not-found",
            ErrorCode::Exists => "exists",
            ErrorCode::InvalidPath => "invalid-path",
            ErrorCode::InvalidPatch => "invalid-patch",
            ErrorCode::InvalidInput => "invalid-input",
            ErrorCode::ApiMismatch => "api-mismatch",
            ErrorCode::Io => "io",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct EditError {
    pub code: ErrorCode,
    pub message: String,
    /// For a conflict: the hash of what is on disk now, or `None` when there is no such page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_hash: Option<Option<String>>,
}

impl EditError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> EditError {
        EditError {
            code,
            message: message.into(),
            disk_hash: None,
        }
    }

    fn conflict(path: &str, disk: Option<&str>) -> EditError {
        EditError {
            code: ErrorCode::Conflict,
            message: format!("{path} changed since it was read"),
            disk_hash: Some(disk.map(String::from)),
        }
    }

    fn io(path: &str, e: io::Error) -> EditError {
        EditError::new(ErrorCode::Io, format!("{path}: {e}"))
    }
}

impl fmt::Display for EditError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for EditError {}

pub type Result<T> = std::result::Result<T, EditError>;

/// Refuses callers written for another version of the contract.
pub fn check_api(requested: Option<u32>) -> Result<()> {
    match requested {
        Some(v) if v != API_VERSION => Err(EditError::new(
            ErrorCode::ApiMismatch,
            format!(
                "the caller speaks tessela API {v}, this tessela speaks API {API_VERSION}; \
                 update the older one"
            ),
        )),
        _ => Ok(()),
    }
}

/// What a write is based on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expect {
    /// There must be no such page yet.
    Absent,
    /// The page must still have this content hash.
    Hash(String),
}

impl Expect {
    /// `new` (no page yet) or a hash, as callers write it.
    pub fn parse(s: &str) -> Expect {
        if s == "new" {
            Expect::Absent
        } else {
            Expect::Hash(s.to_string())
        }
    }

    fn matches(&self, disk: Option<&str>) -> bool {
        match (self, disk) {
            (Expect::Absent, None) => true,
            (Expect::Hash(h), Some(d)) => h == d,
            _ => false,
        }
    }
}

/// Where the pages of a bundle live. Paths are relative to the bundle, with `/` separators,
/// and have been checked by [`check_page_path`].
pub trait PageStore {
    /// Every concept page: no hidden folders, no `index.md` or `log.md`.
    fn list(&self) -> Result<Vec<String>>;
    fn read(&self, path: &str) -> Result<Option<String>>;
    /// Writes the page if what is stored still matches `expect`, atomically; otherwise it
    /// fails with a conflict and writes nothing.
    fn write(&self, path: &str, text: &str, expect: &Expect) -> Result<()>;
    /// Removes the page if it still has this hash.
    fn delete(&self, path: &str, expect_hash: &str) -> Result<()>;
    /// Stores an attachment (a path under `assets/`). Returns whether the file is new: storing
    /// the same bytes again is fine, other bytes under the same name are an `exists` error.
    fn write_asset(&self, path: &str, bytes: &[u8]) -> Result<bool>;
}

/// Pages as Markdown files in a folder.
pub struct FsStore {
    root: PathBuf,
}

impl FsStore {
    pub fn new(root: impl Into<PathBuf>) -> Result<FsStore> {
        let root = root.into();
        if !root.is_dir() {
            return Err(EditError::new(
                ErrorCode::NotFound,
                format!("{} is not a directory", root.display()),
            ));
        }
        Ok(FsStore { root })
    }

    fn file(&self, path: &str) -> Result<PathBuf> {
        check_page_path(path)?;
        Ok(self.root.join(path))
    }
}

fn read_if_exists(file: &Path, path: &str) -> Result<Option<String>> {
    match fs::read(file) {
        Ok(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| EditError::new(ErrorCode::Io, format!("{path}: file is not valid UTF-8"))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(EditError::io(path, e)),
    }
}

impl PageStore for FsStore {
    fn list(&self) -> Result<Vec<String>> {
        let mut found = Vec::new();
        let walker = walkdir::WalkDir::new(&self.root)
            .sort_by_file_name()
            .into_iter()
            .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'));
        for entry in walker {
            let entry = entry.map_err(|e| EditError::new(ErrorCode::Io, e.to_string()))?;
            let name = entry.file_name().to_string_lossy();
            if !entry.file_type().is_file()
                || !name.ends_with(".md")
                || matches!(&*name, "index.md" | "log.md")
            {
                continue;
            }
            if let Ok(rel) = entry.path().strip_prefix(&self.root) {
                found.push(
                    rel.components()
                        .map(|c| c.as_os_str().to_string_lossy())
                        .collect::<Vec<_>>()
                        .join("/"),
                );
            }
        }
        Ok(found)
    }

    fn read(&self, path: &str) -> Result<Option<String>> {
        read_if_exists(&self.file(path)?, path)
    }

    fn write(&self, path: &str, text: &str, expect: &Expect) -> Result<()> {
        let file = self.file(path)?;
        let disk = read_if_exists(&file, path)?.map(|t| content_hash(&t));
        if !expect.matches(disk.as_deref()) {
            return Err(EditError::conflict(path, disk.as_deref()));
        }
        let dir = file.parent().unwrap_or(&self.root);
        fs::create_dir_all(dir).map_err(|e| EditError::io(path, e))?;
        // Write next to the page and move it into place, so a reader never sees half a file.
        let name = file
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let temp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
        let written = (|| {
            fs::write(&temp, text)?;
            if *expect == Expect::Absent {
                // Linking fails when the page appeared meanwhile, which makes "create" atomic.
                match fs::hard_link(&temp, &file) {
                    Ok(()) => return fs::remove_file(&temp),
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                        return Err(e);
                    }
                    Err(_) => {} // a file system without hard links: rename after the check
                }
            }
            fs::rename(&temp, &file)
        })();
        if let Err(e) = written {
            let _ = fs::remove_file(&temp);
            if e.kind() == io::ErrorKind::AlreadyExists {
                let now = read_if_exists(&file, path)?.map(|t| content_hash(&t));
                return Err(EditError::conflict(path, now.as_deref()));
            }
            return Err(EditError::io(path, e));
        }
        Ok(())
    }

    fn delete(&self, path: &str, expect_hash: &str) -> Result<()> {
        let file = self.file(path)?;
        match read_if_exists(&file, path)? {
            None => Err(EditError::new(
                ErrorCode::NotFound,
                format!("{path} does not exist"),
            )),
            Some(text) if content_hash(&text) != expect_hash => {
                Err(EditError::conflict(path, Some(&content_hash(&text))))
            }
            Some(_) => fs::remove_file(&file).map_err(|e| EditError::io(path, e)),
        }
    }

    fn write_asset(&self, path: &str, bytes: &[u8]) -> Result<bool> {
        check_asset_path(path)?;
        let file = self.root.join(path);
        let same = |file: &Path| fs::read(file).map(|disk| disk == bytes);
        match same(&file) {
            Ok(true) => return Ok(false),
            Ok(false) => {
                return Err(EditError::new(
                    ErrorCode::Exists,
                    format!("{path} already exists with other content"),
                ));
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(EditError::io(path, e)),
        }
        let dir = file.parent().unwrap_or(&self.root);
        fs::create_dir_all(dir).map_err(|e| EditError::io(path, e))?;
        let name = file
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let temp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
        let written = (|| {
            fs::write(&temp, bytes)?;
            match fs::hard_link(&temp, &file) {
                Ok(()) => fs::remove_file(&temp),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Err(e),
                Err(_) => fs::rename(&temp, &file),
            }
        })();
        match written {
            Ok(()) => Ok(true),
            Err(e) => {
                let _ = fs::remove_file(&temp);
                if e.kind() == io::ErrorKind::AlreadyExists && same(&file).unwrap_or(false) {
                    // Another writer stored the same picture in the meantime.
                    return Ok(false);
                }
                Err(EditError::io(path, e))
            }
        }
    }
}

/// Whether `path` can name a page: relative to the bundle, ends in `.md`, never leaves it and
/// never goes into a hidden folder or file.
pub fn check_page_path(path: &str) -> Result<()> {
    let bad = |why: &str| {
        Err(EditError::new(
            ErrorCode::InvalidPath,
            format!("{path}: {why}"),
        ))
    };
    if path.is_empty() || !path.ends_with(".md") {
        return bad("a page path ends in .md");
    }
    if path.contains(['\0', '\\']) || path.chars().any(char::is_control) {
        return bad("it has characters a page path cannot have");
    }
    if path.starts_with('/') {
        return bad("it must be relative to the bundle");
    }
    for part in path.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return bad("it must not leave the bundle");
        }
        if part.starts_with('.') {
            return bad("hidden files and folders are not part of the bundle");
        }
    }
    if path.ends_with("/.md") || path == ".md" {
        return bad("a page needs a name");
    }
    Ok(())
}

/// A page path as a caller wrote it: `project/tessela.md`, or without `.md`.
pub fn existing_path(name: &str) -> Result<String> {
    let path = if name.ends_with(".md") {
        name.to_string()
    } else {
        format!("{name}.md")
    };
    check_page_path(&path)?;
    Ok(path)
}

/// The file for a new page named by a person: `Machine Learning` becomes
/// `machine-learning.md`, a `/` makes folders (spec §4).
pub fn path_from_name(name: &str) -> Result<String> {
    let name = name.trim().trim_start_matches('#');
    let name = name.strip_suffix(".md").unwrap_or(name);
    let parts: Vec<String> = name
        .split('/')
        .map(|p| {
            p.split_whitespace()
                .collect::<Vec<_>>()
                .join("-")
                .to_lowercase()
        })
        .filter(|p| !p.is_empty())
        .collect();
    if parts.is_empty() {
        return Err(EditError::new(
            ErrorCode::InvalidPath,
            "a page needs a name",
        ));
    }
    if let Some(c) = parts
        .iter()
        .flat_map(|p| p.chars())
        .find(|c| c.is_control() || "()[]<>\\%#?\"".contains(*c))
    {
        return Err(EditError::new(
            ErrorCode::InvalidPath,
            format!("{name}: a page name cannot have {c:?}"),
        ));
    }
    let path = format!("{}.md", parts.join("/"));
    check_page_path(&path)?;
    let file = path.rsplit('/').next().unwrap_or("");
    if matches!(file, "index.md" | "log.md") {
        return Err(EditError::new(
            ErrorCode::InvalidPath,
            format!("{file} is reserved by OKF; listings are computed with `tessela index`"),
        ));
    }
    Ok(path)
}

fn yaml_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn is_journal_path(path: &str) -> bool {
    let b = path.as_bytes();
    path.len() == "journals/2026-10-27.md".len()
        && path.starts_with("journals/")
        && path.ends_with(".md")
        && b[9..13].iter().all(u8::is_ascii_digit)
        && b[13] == b'-'
        && b[14..16].iter().all(u8::is_ascii_digit)
        && b[16] == b'-'
        && b[17..19].iter().all(u8::is_ascii_digit)
}

/// The text a new page starts with: frontmatter that already passes `tessela lint`.
pub fn new_page_text(path: &str, title: Option<&str>, kind: Option<&str>) -> Result<String> {
    let id = path.strip_suffix(".md").unwrap_or(path);
    let file = id.rsplit('/').next().unwrap_or(id);
    if let Some(k) = kind
        && (k.is_empty()
            || !k
                .chars()
                .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_')))
    {
        return Err(EditError::new(
            ErrorCode::InvalidInput,
            format!("{k:?} is not a page type"),
        ));
    }
    if is_journal_path(path) {
        return Ok(format!(
            "---\ntype: {}\ntitle: {day}\ndate: {day}\n---\n\n",
            kind.unwrap_or("journal"),
            day = yaml_string(file),
        ));
    }
    let default_kind = if file == "home" { "home" } else { "concept" };
    let default_title = if file == "home" {
        "Home".to_string()
    } else {
        file.replace('-', " ")
    };
    Ok(format!(
        "---\ntype: {}\ntitle: {}\n---\n\n",
        kind.unwrap_or(default_kind),
        yaml_string(title.unwrap_or(&default_title)),
    ))
}

#[derive(Debug, Serialize)]
pub struct PageRead {
    pub path: String,
    pub exists: bool,
    /// The page, or the template a new page would start with when there is none yet.
    pub text: String,
    /// `None` when there is no such page.
    pub hash: Option<String>,
}

pub fn read_page(store: &dyn PageStore, path: &str) -> Result<PageRead> {
    check_page_path(path)?;
    Ok(match store.read(path)? {
        Some(text) => PageRead {
            path: path.to_string(),
            exists: true,
            hash: Some(content_hash(&text)),
            text,
        },
        None => PageRead {
            path: path.to_string(),
            exists: false,
            text: new_page_text(path, None, None)?,
            hash: None,
        },
    })
}

#[derive(Debug, Serialize)]
pub struct Saved {
    pub path: String,
    pub hash: String,
    pub created: bool,
}

/// Replaces the whole text of a page, based on what the caller last read.
pub fn save_page(store: &dyn PageStore, path: &str, text: &str, expect: &Expect) -> Result<Saved> {
    check_page_path(path)?;
    let disk = store.read(path)?;
    let disk_hash = disk.as_deref().map(content_hash);
    if !expect.matches(disk_hash.as_deref()) {
        return Err(EditError::conflict(path, disk_hash.as_deref()));
    }
    if disk.as_deref() != Some(text) {
        store.write(path, text, expect)?;
    }
    Ok(Saved {
        path: path.to_string(),
        hash: content_hash(text),
        created: disk.is_none(),
    })
}

/// Changes a page with a unified diff, based on what the caller last read. The diff must apply
/// exactly: the hash already says what the text is, so there is no fuzzy matching.
pub fn patch_page(
    store: &dyn PageStore,
    path: &str,
    patch: &str,
    expect: &Expect,
) -> Result<Saved> {
    check_page_path(path)?;
    let disk = store.read(path)?;
    let disk_hash = disk.as_deref().map(content_hash);
    if !expect.matches(disk_hash.as_deref()) {
        return Err(EditError::conflict(path, disk_hash.as_deref()));
    }
    // `git diff` output starts with lines the diff parser does not want.
    let start = patch
        .match_indices("--- ")
        .map(|(i, _)| i)
        .chain(patch.match_indices("@@").map(|(i, _)| i))
        .filter(|&i| i == 0 || patch.as_bytes()[i - 1] == b'\n')
        .min()
        .unwrap_or(0);
    let parsed = diffy::Patch::from_str(&patch[start..]).map_err(|e| {
        EditError::new(
            ErrorCode::InvalidPatch,
            format!("cannot read the patch: {e}"),
        )
    })?;
    let base = disk.as_deref().unwrap_or("");
    let text = diffy::apply(base, &parsed).map_err(|e| {
        EditError::new(
            ErrorCode::InvalidPatch,
            format!(
                "the patch does not apply to {path} as it is (hash {}): {e}",
                content_hash(base)
            ),
        )
    })?;
    save_page(store, path, &text, expect)
}

/// Creates a page from the template, or from `text` when given. Fails when it exists.
pub fn add_page(
    store: &dyn PageStore,
    path: &str,
    title: Option<&str>,
    kind: Option<&str>,
    text: Option<&str>,
) -> Result<Saved> {
    check_page_path(path)?;
    let file = path.rsplit('/').next().unwrap_or("");
    if matches!(file, "index.md" | "log.md") {
        return Err(EditError::new(
            ErrorCode::InvalidPath,
            format!("{file} is reserved by OKF; listings are computed with `tessela index`"),
        ));
    }
    let exists = || EditError::new(ErrorCode::Exists, format!("{path} already exists"));
    if store.read(path)?.is_some() {
        return Err(exists());
    }
    let text = match text {
        Some(t) => t.to_string(),
        None => new_page_text(path, title, kind)?,
    };
    store.write(path, &text, &Expect::Absent).map_err(|e| {
        if e.code == ErrorCode::Conflict {
            exists()
        } else {
            e
        }
    })?;
    Ok(Saved {
        path: path.to_string(),
        hash: content_hash(&text),
        created: true,
    })
}

/// Pages that mention the concept of `path` through a tag or a link.
pub fn pages_mentioning(store: &dyn PageStore, path: &str) -> Result<Vec<String>> {
    let concept = normalize_concept(path.strip_suffix(".md").unwrap_or(path));
    let mut found = Vec::new();
    for other in store.list()? {
        if other == path {
            continue;
        }
        let Some(text) = store.read(&other)? else {
            continue;
        };
        let page = Page::parse(&other, &text);
        let mentions = page.refs.contains(&concept)
            || page.blocks.iter().any(|b| b.refs.contains(&concept))
            || page.headings.iter().any(|h| h.refs.contains(&concept));
        if mentions {
            found.push(other);
        }
    }
    Ok(found)
}

#[derive(Debug, Serialize)]
pub struct Removed {
    pub path: String,
    /// Pages that still mention it. Links to a missing page are allowed, but you may want to know.
    pub mentioned_by: Vec<String>,
}

pub fn remove_page(store: &dyn PageStore, path: &str, expect_hash: &str) -> Result<Removed> {
    check_page_path(path)?;
    let mentioned_by = pages_mentioning(store, path)?;
    store.delete(path, expect_hash)?;
    Ok(Removed {
        path: path.to_string(),
        mentioned_by,
    })
}

/// What `attach` stored.
#[derive(Debug, Serialize)]
pub struct Attached {
    /// Where the file is, relative to the bundle: `assets/notes-idea-9f2c41d0a1b2.png`.
    pub path: String,
    /// How a page links to it: `/assets/notes-idea-9f2c41d0a1b2.png`.
    pub link: String,
    /// The hash in the name: the first 12 hex characters of the BLAKE3 hash of the content.
    pub hash: String,
    pub size: usize,
    /// False when the same file was stored before.
    pub created: bool,
}

/// The file name a page gives its attachments: its path without `.md`, folders joined by `-`.
fn attachment_stem(page_path: &str) -> String {
    let id = page_path.strip_suffix(".md").unwrap_or(page_path);
    let mut stem = String::new();
    for c in id.chars() {
        let c = if c.is_alphanumeric() || matches!(c, '_' | '.') {
            c.to_lowercase().next().unwrap_or(c)
        } else {
            '-'
        };
        if c == '-' && (stem.is_empty() || stem.ends_with('-')) {
            continue;
        }
        stem.push(c);
    }
    let stem = stem.trim_matches(['-', '.']).to_string();
    if stem.is_empty() {
        "attachment".into()
    } else {
        stem
    }
}

/// Whether `ext` can end an attachment's name: letters and digits, and not `md`, which
/// would make the file a page.
pub fn check_extension(ext: &str) -> Result<String> {
    let ext = ext.trim_start_matches('.').to_lowercase();
    if ext.is_empty() || ext.len() > 10 || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(EditError::new(
            ErrorCode::InvalidInput,
            format!("{ext:?} is not a file extension"),
        ));
    }
    if ext == "md" {
        return Err(EditError::new(
            ErrorCode::InvalidInput,
            "an attachment cannot be a .md file: that would be a page; use `add` or `save`",
        ));
    }
    Ok(ext)
}

/// The extension of a picture or document, read from its first bytes.
pub fn sniff_extension(bytes: &[u8]) -> Option<&'static str> {
    let starts = |magic: &[u8]| bytes.starts_with(magic);
    if starts(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if starts(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if starts(b"GIF87a") || starts(b"GIF89a") {
        Some("gif")
    } else if starts(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("webp")
    } else if starts(b"%PDF-") {
        Some("pdf")
    } else if bytes[..bytes.len().min(512)]
        .windows(4)
        .any(|w| w == b"<svg")
    {
        Some("svg")
    } else {
        None
    }
}

/// Stores a file in `assets/`, named after the page that uses it plus a short hash of its
/// content, so the same file stored for the same page twice is one file.
pub fn attach(store: &dyn PageStore, page_path: &str, bytes: &[u8], ext: &str) -> Result<Attached> {
    check_page_path(page_path)?;
    let ext = check_extension(ext)?;
    let hash = blake3::hash(bytes).to_hex()[..12].to_string();
    let path = format!("assets/{}-{hash}.{ext}", attachment_stem(page_path));
    let created = store.write_asset(&path, bytes)?;
    Ok(Attached {
        link: format!("/{path}"),
        path,
        hash,
        size: bytes.len(),
        created,
    })
}

/// A path under the root `assets/` folder that never leaves it or goes into a hidden one.
fn check_asset_path(path: &str) -> Result<()> {
    let ok = path.starts_with("assets/")
        && !path.contains(['\0', '\\'])
        && path
            .split('/')
            .all(|p| !p.is_empty() && !p.starts_with('.') && !p.chars().any(char::is_control));
    if ok {
        Ok(())
    } else {
        Err(EditError::new(
            ErrorCode::InvalidPath,
            format!("{path}: an attachment lives under assets/"),
        ))
    }
}

/// A page whose text changed because of a move.
#[derive(Debug, Serialize)]
pub struct Updated {
    pub path: String,
    pub links: usize,
    pub tags: usize,
}

#[derive(Debug, Serialize)]
pub struct Moved {
    pub from: String,
    pub to: String,
    /// The hash of the page at its new path.
    pub hash: String,
    /// Every page that was (or, in a dry run, would be) rewritten; the moved page is among them
    /// when its relative links had to change.
    pub updated: Vec<Updated>,
    /// What could not be changed automatically, to check by hand.
    pub warnings: Vec<String>,
    pub dry_run: bool,
}

/// Where `rename` puts a page: same folder, new name.
pub fn rename_target(from: &str, new_name: &str) -> Result<String> {
    if new_name.contains('/') {
        return Err(EditError::new(
            ErrorCode::InvalidInput,
            "a new name has no `/`; use `move` to change the folder",
        ));
    }
    let name = path_from_name(new_name)?;
    Ok(match from.rsplit_once('/') {
        Some((dir, _)) => format!("{dir}/{name}"),
        None => name,
    })
}

/// Where `move` puts a page: into the folder `dest/` (keeping its name), or at the path `dest`.
pub fn move_target(from: &str, dest: &str) -> Result<String> {
    if let Some(folder) = dest.strip_suffix('/') {
        let file = from.rsplit('/').next().unwrap_or(from);
        let folder = path_from_name(&format!("{folder}/x"))?;
        return Ok(format!("{}{file}", &folder[..folder.len() - "x.md".len()]));
    }
    path_from_name(dest)
}

/// Moves a page to a new path and makes every tag and link that names it follow, in all
/// pages. The other pages are changed first and the old file is removed last, so a run that
/// is interrupted or refused can be repeated.
pub fn move_page(
    store: &dyn PageStore,
    from: &str,
    to: &str,
    expect: Option<&str>,
    dry_run: bool,
) -> Result<Moved> {
    check_page_path(from)?;
    check_page_path(to)?;
    if from == to {
        return Err(EditError::new(
            ErrorCode::InvalidInput,
            format!("{from} is already there"),
        ));
    }
    let moving = store
        .read(from)?
        .ok_or_else(|| EditError::new(ErrorCode::NotFound, format!("{from} does not exist")))?;
    let moving_hash = content_hash(&moving);
    if let Some(expected) = expect
        && expected != moving_hash
    {
        return Err(EditError::conflict(from, Some(&moving_hash)));
    }
    let taken = normalize_concept(to.strip_suffix(".md").unwrap_or(to));
    for other in store.list()? {
        if other != from && normalize_concept(other.strip_suffix(".md").unwrap_or(&other)) == taken
        {
            return Err(EditError::new(
                ErrorCode::Exists,
                format!("{other} already exists"),
            ));
        }
    }
    if store.read(to)?.is_some() {
        return Err(EditError::new(
            ErrorCode::Exists,
            format!("{to} already exists"),
        ));
    }

    let from_id = from.strip_suffix(".md").unwrap_or(from);
    let rewrite = Rewrite::new(from_id, to);
    let dir_of = |p: &str| p.rsplit_once('/').map_or("", |(d, _)| d).to_string();
    let to_dir = dir_of(to);

    let mut warnings = Vec::new();
    let mut updated = Vec::new();
    // (path, hash it was read with, new text)
    let mut others: Vec<(String, String, String)> = Vec::new();
    let mut moved_text = moving.clone();
    for path in store.list()? {
        let is_moved = path == from;
        let text = if is_moved {
            moving.clone()
        } else {
            match store.read(&path)? {
                Some(t) => t,
                None => continue,
            }
        };
        let at = Where {
            dir_before: &dir_of(&path),
            dir_after: if is_moved { &to_dir } else { &dir_of(&path) },
            is_moved,
        };
        let result = rewrite.page(&text, &at);
        for line in &result.skipped_lines {
            warnings.push(format!(
                "{path}:{line}: a link here could not be rewritten automatically"
            ));
        }
        if !result.changed() {
            continue;
        }
        // The page must not still mention the old concept; if it does, say so.
        let after = Page::parse(&path, &result.text);
        let still = after.refs.contains(&rewrite.old_concept)
            || after
                .blocks
                .iter()
                .any(|b| b.refs.contains(&rewrite.old_concept))
            || after
                .headings
                .iter()
                .any(|h| h.refs.contains(&rewrite.old_concept));
        if still {
            warnings.push(format!(
                "{path}: still mentions the old name after the rewrite"
            ));
        }
        updated.push(Updated {
            path: if is_moved {
                to.to_string()
            } else {
                path.clone()
            },
            links: result.links,
            tags: result.tags,
        });
        if is_moved {
            moved_text = result.text;
        } else {
            others.push((path, content_hash(&text), result.text));
        }
    }
    let moved_hash = content_hash(&moved_text);
    if !dry_run {
        for (path, hash, text) in &others {
            store
                .write(path, text, &Expect::Hash(hash.clone()))
                .map_err(|mut e| {
                    e.message = format!(
                        "{}; the page was not moved yet, and the pages already updated stay valid: \
                     run the same command again",
                        e.message
                    );
                    e
                })?;
        }
        store.write(to, &moved_text, &Expect::Absent).map_err(|e| {
            if e.code == ErrorCode::Conflict {
                EditError::new(ErrorCode::Exists, format!("{to} already exists"))
            } else {
                e
            }
        })?;
        if let Err(e) = store.delete(from, &moving_hash) {
            // The page changed while we worked: keep the old one and undo the new one.
            let _ = store.delete(to, &moved_hash);
            return Err(e);
        }
    }
    Ok(Moved {
        from: from.to_string(),
        to: to.to_string(),
        hash: moved_hash,
        updated,
        warnings,
        dry_run,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_paths_are_checked() {
        for ok in ["a.md", "a/b.md", "journals/2026-10-27.md", "Ünï/ç.md"] {
            assert!(check_page_path(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "a",
            "a.txt",
            "/a.md",
            "../a.md",
            "a/../b.md",
            "a//b.md",
            ".hidden/a.md",
            "a/.b.md",
            ".md",
            "a\\b.md",
            "a\0.md",
            "./a.md",
        ] {
            assert!(check_page_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn names_become_paths() {
        assert_eq!(
            path_from_name("Machine  Learning").unwrap(),
            "machine-learning.md"
        );
        assert_eq!(
            path_from_name("#Project/Tessela").unwrap(),
            "project/tessela.md"
        );
        assert_eq!(path_from_name("a/b.md").unwrap(), "a/b.md");
        for bad in ["", "  ", "../x", ".x", "a/(b)", "index", "a/log"] {
            assert!(path_from_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn rename_and_move_targets() {
        assert_eq!(
            rename_target("a/b.md", "New Name").unwrap(),
            "a/new-name.md"
        );
        assert_eq!(rename_target("b.md", "c").unwrap(), "c.md");
        assert!(rename_target("a/b.md", "x/y").is_err());
        assert_eq!(move_target("a/b.md", "c/d/").unwrap(), "c/d/b.md");
        assert_eq!(move_target("a/b.md", "c/e").unwrap(), "c/e.md");
        assert_eq!(move_target("a/b.md", "x/").unwrap(), "x/b.md");
    }

    #[test]
    fn templates() {
        assert_eq!(
            new_page_text("project/tessela.md", None, None).unwrap(),
            "---\ntype: concept\ntitle: \"tessela\"\n---\n\n"
        );
        assert_eq!(
            new_page_text("journals/2026-10-27.md", None, None).unwrap(),
            "---\ntype: journal\ntitle: \"2026-10-27\"\ndate: \"2026-10-27\"\n---\n\n"
        );
        assert!(
            new_page_text("a.md", Some("A \"quoted\" one"), Some("howto"))
                .unwrap()
                .contains(r#"title: "A \"quoted\" one""#)
        );
        assert!(new_page_text("a.md", None, Some("bad type")).is_err());
        assert!(
            new_page_text("home.md", None, None)
                .unwrap()
                .contains("type: home")
        );
    }

    #[test]
    fn api_versions() {
        assert!(check_api(None).is_ok());
        assert!(check_api(Some(API_VERSION)).is_ok());
        assert_eq!(
            check_api(Some(API_VERSION + 1)).unwrap_err().code,
            ErrorCode::ApiMismatch
        );
    }
}
