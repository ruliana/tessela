//! `tessela changes`: what differs between the notes on disk and an earlier state in git.
//!
//! The bundle is in a git repository (sync is git), so "what changed since I last looked"
//! has an exact answer. This reads git with `diff`, `show` and `ls-files` and never writes
//! to it; the block-by-block comparison is `tessela_core::changes`.

use std::path::Path;
use std::process::Command;

use serde::Serialize;
use tessela_core::changes::{Change, diff};
use tessela_core::edit::{EditError, ErrorCode, check_page_path, content_hash};

#[derive(Clone, Copy, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Added,
    Modified,
    Deleted,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct PageChange {
    pub path: String,
    pub status: Status,
    /// The hash of the page as it is now, to base a patch on; absent for a deleted page.
    pub hash: Option<String>,
    pub changes: Vec<Change>,
}

#[derive(Serialize, schemars::JsonSchema)]
pub struct Output {
    /// What the notes were compared with, as asked.
    pub since: String,
    /// The commit that is, or `None` when the repository has no commit yet.
    pub commit: Option<String>,
    pub pages: Vec<PageChange>,
}

impl Output {
    pub fn text(&self) -> String {
        let mut out = String::new();
        for page in &self.pages {
            let status = match page.status {
                Status::Added => "added",
                Status::Modified => "modified",
                Status::Deleted => "deleted",
            };
            out.push_str(&format!("{status} {}\n", page.path));
            for c in &page.changes {
                let mark = match c.kind {
                    tessela_core::changes::ChangeKind::Added => "+",
                    tessela_core::changes::ChangeKind::Removed => "-",
                    tessela_core::changes::ChangeKind::Changed => "~",
                };
                let first = c.text.lines().next().unwrap_or("");
                out.push_str(&format!("  {mark} {}: {first}\n", c.line));
            }
        }
        out
    }
}

fn invalid(message: impl Into<String>) -> EditError {
    EditError::new(ErrorCode::InvalidInput, message)
}

/// Runs git in the bundle folder. `Ok(None)` is a git that ran and said no.
fn git(dir: &Path, args: &[&str]) -> Result<Option<Vec<u8>>, EditError> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| {
            EditError::new(
                ErrorCode::Io,
                format!("cannot run git, which `changes` needs: {e}"),
            )
        })?;
    Ok(out.status.success().then_some(out.stdout))
}

fn git_text(dir: &Path, args: &[&str]) -> Result<Option<String>, EditError> {
    Ok(git(dir, args)?.map(|b| String::from_utf8_lossy(&b).trim().to_string()))
}

/// The path of a page in the bundle, or `None` for what is not one (an attachment, a
/// reserved file, something hidden).
fn page_path(path: &str) -> Option<&str> {
    let file = path.rsplit('/').next()?;
    (check_page_path(path).is_ok()
        && !path.starts_with("assets/")
        && !matches!(file, "index.md" | "log.md"))
    .then_some(path)
}

pub fn run(bundle: &Path, since: &str) -> Result<Output, EditError> {
    if since.starts_with('-') {
        return Err(invalid(format!("{since:?} is not a git revision")));
    }
    if !bundle.is_dir() {
        return Err(EditError::new(
            ErrorCode::NotFound,
            format!("{} is not a directory", bundle.display()),
        ));
    }
    let prefix = git_text(bundle, &["rev-parse", "--show-prefix"])?.ok_or_else(|| {
        invalid(format!(
            "{} is not in a git repository; `changes` compares the notes with git",
            bundle.display()
        ))
    })?;
    let commit = git_text(
        bundle,
        &[
            "rev-parse",
            "--verify",
            "-q",
            &format!("{since}^{{commit}}"),
        ],
    )?;
    if commit.is_none() && since != "HEAD" {
        return Err(invalid(format!("git does not know the revision {since:?}")));
    }

    // (path, was in the old state)
    let mut files: Vec<(String, bool)> = Vec::new();
    let mut paths = |args: &[&str], known: bool| -> Result<(), EditError> {
        if let Some(out) = git(bundle, args)? {
            files.extend(
                String::from_utf8_lossy(&out)
                    .split('\0')
                    .filter(|p| !p.is_empty())
                    .map(|p| (p.to_string(), known)),
            );
        }
        Ok(())
    };
    if commit.is_some() {
        // Tracked files that differ from `since` (status letters are dropped: the old text
        // tells whether the page existed).
        paths(
            &[
                "diff",
                "--name-only",
                "-z",
                "--no-renames",
                "--relative",
                since,
                "--",
                ".",
            ],
            true,
        )?;
    } else {
        // No commit yet: everything that is tracked is new.
        paths(&["ls-files", "-z", "--cached"], false)?;
    }
    paths(&["ls-files", "-z", "--others", "--exclude-standard"], false)?;
    files.sort();
    files.dedup_by(|a, b| a.0 == b.0);

    let mut pages = Vec::new();
    for (path, known) in files {
        if page_path(&path).is_none() {
            continue;
        }
        let old = match (&commit, known) {
            (Some(_), true) => git(bundle, &["show", &format!("{since}:{prefix}{path}")])?
                .map(|b| String::from_utf8_lossy(&b).into_owned()),
            _ => None,
        };
        let new = std::fs::read_to_string(bundle.join(&path)).ok();
        if old == new {
            continue;
        }
        let status = match (&old, &new) {
            (None, _) => Status::Added,
            (_, None) => Status::Deleted,
            _ => Status::Modified,
        };
        pages.push(PageChange {
            changes: diff(&path, old.as_deref(), new.as_deref()),
            hash: new.as_deref().map(content_hash),
            path,
            status,
        });
    }
    Ok(Output {
        since: since.to_string(),
        commit,
        pages,
    })
}
