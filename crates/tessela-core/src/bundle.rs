//! Bundles: a folder of OKF files.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use walkdir::{DirEntry, WalkDir};

use crate::page::Page;

#[derive(Debug)]
pub struct Bundle {
    pub root: PathBuf,
    /// Concept pages, sorted by path. `index.md` and `log.md` are reserved by OKF and not included.
    pub pages: Vec<Page>,
    /// Files that could not be read, with the reason.
    pub unreadable: Vec<(String, String)>,
}

impl Bundle {
    pub fn load(root: impl AsRef<Path>) -> std::io::Result<Bundle> {
        let root = root.as_ref().to_path_buf();
        if !root.is_dir() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("{} is not a directory", root.display()),
            ));
        }
        let mut pages = Vec::new();
        let mut unreadable = Vec::new();
        let walker = WalkDir::new(&root)
            .sort_by_file_name()
            .into_iter()
            .filter_entry(|e| !is_ignored(e));
        for entry in walker {
            let entry = entry.map_err(std::io::Error::other)?;
            let name = entry.file_name().to_string_lossy();
            if !entry.file_type().is_file() || !name.ends_with(".md") || is_reserved(&name) {
                continue;
            }
            let rel = entry.path().strip_prefix(&root).unwrap_or(entry.path());
            let rel = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            match std::fs::read(entry.path()).map(String::from_utf8) {
                Ok(Ok(text)) => pages.push(Page::parse(&rel, &text)),
                Ok(Err(_)) => unreadable.push((rel, "file is not valid UTF-8".into())),
                Err(e) => unreadable.push((rel, e.to_string())),
            }
        }
        Ok(Bundle {
            root,
            pages,
            unreadable,
        })
    }

    pub fn page(&self, id: &str) -> Option<&Page> {
        self.pages.iter().find(|p| p.id.eq_ignore_ascii_case(id))
    }

    /// IDs of all pages, lowercased, for checking whether a concept has a page.
    pub fn page_ids(&self) -> HashSet<String> {
        self.pages.iter().map(|p| p.id.to_lowercase()).collect()
    }
}

fn is_reserved(file_name: &str) -> bool {
    matches!(file_name, "index.md" | "log.md")
}

fn is_ignored(entry: &DirEntry) -> bool {
    entry.depth() > 0 && entry.file_name().to_string_lossy().starts_with('.')
}
