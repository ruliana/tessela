//! `tessela fence`: runs the body of a ```` ```tessela ```` fence, the live lists of a page.
//!
//! The first stage is one of the read-only commands, run on the bundle that was named for
//! `fence` (a fence never names a bundle or a path of its own). Every hit becomes one line,
//! `path:line:text` as `rg` prints it, and the filters after the first stage (`rg`, `sed`,
//! `sort`, `uniq`, `head`, `wc`, see `tessela_core::fence`) work on those lines. A line keeps
//! the data it came from, so a client can draw it as the tile of a hit, only while its
//! `path:line:` prefix is still there. After a `sed` that removes the prefix, or a `wc`, a
//! line is plain text.

use clap::Parser;
use serde::Serialize;
use serde_json::Value;
use tessela_core::edit::{EditError, ErrorCode};
use tessela_core::fence::{Line, Pipeline};
use tessela_core::{Bundle, Linter, index, vocabulary};

use crate::{Cli, Command};

/// A row of the first stage: its line, how the line starts while it is still that row, and
/// the data behind it.
struct Source {
    text: String,
    prefix: String,
    data: Value,
}

#[derive(Serialize)]
pub struct Row {
    pub text: String,
    /// What the row stands for: a hit of `query`, a page of `index`, a concept of `vocab`, a
    /// finding of `lint`. `null` once a filter has rewritten the line beyond recognition.
    pub source: Option<Value>,
}

#[derive(Serialize)]
pub struct Output {
    /// The command of the first stage, which says what a `source` is.
    pub command: String,
    pub rows: Vec<Row>,
}

impl Output {
    pub fn text(&self) -> String {
        self.rows.iter().map(|r| format!("{}\n", r.text)).collect()
    }
}

fn invalid(message: impl Into<String>) -> EditError {
    EditError::new(ErrorCode::InvalidInput, message)
}

/// The body of a fence, or the whole fence with its ```` ``` ```` lines.
fn body_of(input: &str) -> &str {
    let t = input.trim();
    let Some(rest) = t.strip_prefix("```") else {
        return t;
    };
    let rest = rest.split_once('\n').map_or("", |(_, r)| r);
    rest.trim_end().strip_suffix("```").unwrap_or(rest).trim()
}

pub fn run(bundle: &Bundle, input: &str) -> Result<Output, EditError> {
    let pipeline = Pipeline::parse(body_of(input)).map_err(|e| invalid(e.to_string()))?;
    let command = pipeline.source[0].clone();
    let sources = first_stage(bundle, &pipeline.source)?;
    let lines = sources
        .iter()
        .enumerate()
        .map(|(i, s)| Line::new(s.text.clone(), Some(i)))
        .collect();
    let rows = pipeline
        .filter(lines)
        .into_iter()
        .map(|line| {
            let source = line
                .from
                .map(|i| &sources[i])
                .filter(|s| line.text.starts_with(&s.prefix))
                .map(|s| s.data.clone());
            Row {
                text: line.text,
                source,
            }
        })
        .collect();
    Ok(Output { command, rows })
}

/// The row text of something found at `path:line`: the text on one line.
fn located(path: &str, line: usize, text: &str) -> (String, String) {
    let prefix = format!("{path}:{line}:");
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (format!("{prefix}{text}"), prefix)
}

fn plain(text: String, data: Value) -> Source {
    Source {
        prefix: text.clone(),
        text,
        data,
    }
}

fn first_stage(bundle: &Bundle, words: &[String]) -> Result<Vec<Source>, EditError> {
    let parsed =
        Cli::try_parse_from(std::iter::once("tessela".to_string()).chain(words.iter().cloned()))
            .map_err(|e| {
                let message = e.to_string();
                let first = message
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim_start_matches("error: ");
                invalid(format!(
                    "cannot read the command {:?}: {first}",
                    words.join(" ")
                ))
            })?;
    let not_a_fence_command = |name: &str| {
        invalid(format!(
            "{name} cannot start a fence; a fence runs one of the read-only commands: \
             query, index, vocab or lint"
        ))
    };
    let check_path = |path: &std::path::Path| {
        if path == std::path::Path::new(".") {
            Ok(())
        } else {
            Err(invalid(
                "a fence reads the bundle it is in: leave the folder out of the command",
            ))
        }
    };
    match parsed.command {
        Command::Query { common, filters } => {
            check_path(&common.path)?;
            let query = filters.query();
            let mut hits = query.run(bundle);
            hits.truncate(filters.limit.unwrap_or(usize::MAX));
            Ok(hits
                .into_iter()
                .map(|hit| {
                    let (text, prefix) = located(&hit.path, hit.line, &hit.text);
                    Source {
                        text,
                        prefix,
                        data: serde_json::to_value(&hit).expect("hits serialize"),
                    }
                })
                .collect())
        }
        Command::Index {
            common,
            dir,
            recursive,
            write,
            force,
        } => {
            check_path(&common.path)?;
            if write || force {
                return Err(not_a_fence_command("index --write"));
            }
            let listing = if recursive {
                index::recursive_listing(bundle, &dir)
            } else {
                index::listing(bundle, &dir)
            };
            let mut rows = Vec::new();
            for folder in &listing.folders {
                let unit = if folder.pages == 1 { "page" } else { "pages" };
                rows.push(plain(
                    format!("{}/  ({} {unit})", folder.path, folder.pages),
                    serde_json::to_value(folder).expect("folders serialize"),
                ));
            }
            for entry in listing.pages.iter().chain(&listing.journal) {
                let text = match &entry.description {
                    Some(d) => format!("{} - {d}", entry.title),
                    None => entry.title.clone(),
                };
                let (text, prefix) = located(&entry.path, 1, &text);
                rows.push(Source {
                    text,
                    prefix,
                    data: serde_json::to_value(entry).expect("entries serialize"),
                });
            }
            Ok(rows)
        }
        Command::Vocab {
            common,
            unwritten,
            min_count,
            prefix,
        } => {
            check_path(&common.path)?;
            let prefix = prefix.map(|p| p.trim_start_matches('#').to_lowercase());
            Ok(vocabulary(bundle)
                .into_iter()
                .filter(|e| !unwritten || (!e.has_page && e.mentions > 0))
                .filter(|e| e.mentions >= min_count)
                .filter(|e| prefix.as_ref().is_none_or(|p| e.concept.starts_with(p)))
                .map(|e| {
                    let pages = if e.pages == 1 { "page" } else { "pages" };
                    plain(
                        format!("{:>4}  {}  {} {pages}", e.mentions, e.concept, e.pages),
                        serde_json::to_value(&e).expect("entries serialize"),
                    )
                })
                .collect())
        }
        Command::Lint {
            common,
            strict: _,
            min_severity,
        } => {
            check_path(&common.path)?;
            let min = match min_severity.as_str() {
                "error" => tessela_core::Severity::Error,
                "warning" => tessela_core::Severity::Warning,
                _ => tessela_core::Severity::Info,
            };
            Ok(Linter::default()
                .run(bundle)
                .into_iter()
                .filter(|d| d.severity >= min)
                .map(|d| {
                    let line = d.line.unwrap_or(1);
                    let (text, prefix) = located(
                        &d.path,
                        line,
                        &format!("{} [{}] {}", d.severity.as_str(), d.rule, d.message),
                    );
                    Source {
                        text,
                        prefix,
                        data: serde_json::to_value(&d).expect("findings serialize"),
                    }
                })
                .collect())
        }
        Command::ImportLogseq { .. } => Err(not_a_fence_command("import-logseq")),
        Command::Api { .. } => Err(not_a_fence_command("api")),
        Command::Read { .. } => Err(not_a_fence_command("read")),
        Command::Add { .. } => Err(not_a_fence_command("add")),
        Command::Attach { .. } => Err(not_a_fence_command("attach")),
        Command::Changes { .. } => Err(not_a_fence_command("changes")),
        Command::Related { .. } => Err(not_a_fence_command("related")),
        Command::Save { .. } => Err(not_a_fence_command("save")),
        Command::Rename { .. } => Err(not_a_fence_command("rename")),
        Command::Move { .. } => Err(not_a_fence_command("move")),
        Command::Remove { .. } => Err(not_a_fence_command("remove")),
        Command::Fence { .. } => Err(not_a_fence_command("fence")),
        Command::Pages { .. } => Err(not_a_fence_command("pages")),
        Command::Watch { .. } => Err(not_a_fence_command("watch")),
    }
}
