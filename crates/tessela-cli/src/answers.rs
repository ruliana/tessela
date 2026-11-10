//! What the commands print with `--json`, as types. The same types make the answers and the
//! schema that `tessela schema` prints, so the two cannot drift apart.

use schemars::JsonSchema;
use serde::Serialize;
use tessela_core::{Diagnostic, Hit, VocabEntry};

use crate::watch::Mode;

/// `tessela api`.
#[derive(Serialize, JsonSchema)]
pub struct Api {
    /// The version of the tessela tool itself.
    pub version: String,
}

#[derive(Serialize, JsonSchema)]
pub struct PageRow {
    /// The path without `.md`, the way links name the page.
    pub id: String,
    /// The path inside the bundle, with `/` separators.
    pub path: String,
    /// What the page calls itself.
    pub title: String,
    /// The frontmatter `type`.
    #[serde(rename = "type")]
    pub kind: Option<String>,
}

/// `tessela pages`.
#[derive(Serialize, JsonSchema)]
pub struct Pages {
    /// Every concept page, sorted by path.
    pub pages: Vec<PageRow>,
}

/// `tessela query`.
#[derive(Serialize, JsonSchema)]
pub struct Query {
    /// How many hits there were before `--limit` cut the list.
    pub total: usize,
    pub hits: Vec<Hit>,
}

/// `tessela vocab`.
#[derive(Serialize, JsonSchema)]
pub struct Vocab {
    pub concepts: Vec<VocabEntry>,
}

/// `tessela lint`. Findings are not a failure: `ok` stays true and the exit code is 1 on errors.
#[derive(Serialize, JsonSchema)]
pub struct Lint {
    pub diagnostics: Vec<Diagnostic>,
}

/// One line of `tessela watch --json`.
#[derive(Serialize, JsonSchema)]
#[serde(tag = "event", rename_all = "lowercase")]
pub enum WatchEvent {
    /// Watching has started. Changes made after this line are reported.
    Ready { mode: Mode },
    /// Pages were created, changed or removed: relative paths, sorted, a moment after the last change.
    Changed { paths: Vec<String> },
    /// The way of watching changed, and why.
    Mode { mode: Mode, reason: String },
}
