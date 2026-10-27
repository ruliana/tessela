use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Args, Parser, Subcommand};
use serde::Serialize;
use tessela_core::{Bundle, Linter, Query, Severity, vocabulary};

#[derive(Parser)]
#[command(
    name = "tessela",
    version,
    about = "Tools for Tessela knowledge bundles"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Args)]
struct Common {
    /// The bundle folder
    #[arg(default_value = ".")]
    path: PathBuf,
    /// Print JSON instead of text
    #[arg(long)]
    json: bool,
}

#[derive(Subcommand)]
enum Command {
    /// Check a bundle against OKF and the Tessela conventions
    Lint {
        #[command(flatten)]
        common: Common,
        /// Exit with an error on warnings too
        #[arg(long)]
        strict: bool,
        /// Hide diagnostics below this severity
        #[arg(long, value_parser = ["info", "warning", "error"], default_value = "info")]
        min_severity: String,
    },
    /// Find blocks by the concepts they mention, their text, page or date
    Query {
        #[command(flatten)]
        common: Common,
        /// A concept the block must mention (repeatable); `#tag` or a name
        #[arg(long = "ref", short = 'r')]
        refs: Vec<String>,
        /// Match blocks that mention any of the --ref concepts, not all
        #[arg(long)]
        any: bool,
        /// Ignore refs inherited from parent items and headings
        #[arg(long)]
        own: bool,
        /// Text the block contains (case-insensitive)
        #[arg(long, short = 't')]
        text: Option<String>,
        /// Only pages with this frontmatter `type`
        #[arg(long = "type")]
        kind: Option<String>,
        /// Only this page ID, or a folder when it ends with `/`
        #[arg(long)]
        page: Option<String>,
        /// First day to include (YYYY-MM-DD); only journals have a day
        #[arg(long)]
        from: Option<String>,
        /// Last day to include (YYYY-MM-DD); only journals have a day
        #[arg(long)]
        to: Option<String>,
        /// Show at most this many blocks
        #[arg(long)]
        limit: Option<usize>,
    },
    /// List the concepts that exist: tags, links and pages
    Vocab {
        #[command(flatten)]
        common: Common,
        /// Only concepts mentioned but without a page yet
        #[arg(long)]
        unwritten: bool,
        /// Only concepts mentioned at least this many times
        #[arg(long, default_value_t = 0)]
        min_count: usize,
        /// Only concepts starting with this prefix, e.g. `project/`
        #[arg(long)]
        prefix: Option<String>,
    },
}

fn main() -> ExitCode {
    match Cli::parse().command {
        Command::Lint {
            common,
            strict,
            min_severity,
        } => lint(common, strict, &min_severity),
        Command::Query {
            common,
            refs,
            any,
            own,
            text,
            kind,
            page,
            from,
            to,
            limit,
        } => {
            let query = Query {
                refs,
                any,
                own,
                text,
                kind,
                page,
                from,
                to,
            };
            run_query(common, query, limit)
        }
        Command::Vocab {
            common,
            unwritten,
            min_count,
            prefix,
        } => vocab(common, unwritten, min_count, prefix),
    }
}

fn load(common: &Common) -> Result<Bundle, ExitCode> {
    Bundle::load(&common.path).map_err(|e| {
        eprintln!("tessela: {e}");
        ExitCode::from(2)
    })
}

fn print_json<T: Serialize>(value: &T) {
    println!(
        "{}",
        serde_json::to_string_pretty(value).expect("output serializes")
    );
}

fn lint(common: Common, strict: bool, min_severity: &str) -> ExitCode {
    let bundle = match load(&common) {
        Ok(b) => b,
        Err(code) => return code,
    };
    let min = match min_severity {
        "error" => Severity::Error,
        "warning" => Severity::Warning,
        _ => Severity::Info,
    };
    let diagnostics: Vec<_> = Linter::default()
        .run(&bundle)
        .into_iter()
        .filter(|d| d.severity >= min)
        .collect();
    let count = |s: Severity| diagnostics.iter().filter(|d| d.severity == s).count();
    let (errors, warnings, infos) = (
        count(Severity::Error),
        count(Severity::Warning),
        count(Severity::Info),
    );

    if common.json {
        print_json(&diagnostics);
    } else {
        for d in &diagnostics {
            let line = d.line.map_or(String::new(), |l| format!(":{l}"));
            println!(
                "{}{line}: {} [{}] {}",
                d.path,
                d.severity.as_str(),
                d.rule,
                d.message
            );
        }
        eprintln!(
            "{} pages, {errors} errors, {warnings} warnings, {infos} notes",
            bundle.pages.len()
        );
    }

    if errors > 0 || (strict && warnings > 0) {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

fn run_query(common: Common, query: Query, limit: Option<usize>) -> ExitCode {
    let bundle = match load(&common) {
        Ok(b) => b,
        Err(code) => return code,
    };
    let mut hits = query.run(&bundle);
    let total = hits.len();
    hits.truncate(limit.unwrap_or(usize::MAX));

    if common.json {
        print_json(&hits);
    } else {
        for hit in &hits {
            println!("{}:{}  {}", hit.path, hit.line, hit.handle);
            if !hit.heading_path.is_empty() {
                println!("  under: {}", hit.heading_path.join(" > "));
            }
            for line in hit.text.lines() {
                println!("  {line}");
            }
        }
        if hits.len() < total {
            eprintln!("{} of {total} blocks", hits.len());
        } else {
            eprintln!("{total} blocks");
        }
    }
    ExitCode::SUCCESS
}

fn vocab(common: Common, unwritten: bool, min_count: usize, prefix: Option<String>) -> ExitCode {
    let bundle = match load(&common) {
        Ok(b) => b,
        Err(code) => return code,
    };
    let prefix = prefix.map(|p| p.trim_start_matches('#').to_lowercase());
    let entries: Vec<_> = vocabulary(&bundle)
        .into_iter()
        .filter(|e| !unwritten || (!e.has_page && e.mentions > 0))
        .filter(|e| e.mentions >= min_count)
        .filter(|e| prefix.as_ref().is_none_or(|p| e.concept.starts_with(p)))
        .collect();

    if common.json {
        print_json(&entries);
    } else {
        let width = entries.iter().map(|e| e.concept.len()).max().unwrap_or(0);
        for e in &entries {
            let mut notes = Vec::new();
            if !e.has_page {
                notes.push("no page".to_string());
            }
            if let Some(u) = &e.use_instead {
                notes.push(format!("alias, use {u}"));
            }
            if e.deprecated {
                notes.push("deprecated".to_string());
            }
            if let Some(n) = &e.note {
                notes.push(n.clone());
            }
            let notes = if notes.is_empty() {
                String::new()
            } else {
                format!("  ({})", notes.join("; "))
            };
            let pages = if e.pages == 1 { "page" } else { "pages" };
            println!(
                "{:>4}  {:<width$}  {} {pages}{notes}",
                e.mentions, e.concept, e.pages
            );
        }
        eprintln!("{} concepts", entries.len());
    }
    ExitCode::SUCCESS
}
