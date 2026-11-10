mod fence;
mod watch;

use std::fmt::Arguments;
use std::io::{self, ErrorKind, Read as _, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Args, Parser, Subcommand};
use serde::Serialize;
use tessela_core::edit::{self, API_VERSION, EditError, ErrorCode, Expect, FsStore, PageStore};
use tessela_core::{
    Bundle, HitKind, Linter, Query, Severity, TaskFilter, index, logseq, vocabulary,
};

/// `print!` that ends the run quietly when the reader has closed the pipe (`| head`).
macro_rules! out {
    ($($arg:tt)*) => { write_stdout(format_args!($($arg)*)) };
}

macro_rules! outln {
    ($($arg:tt)*) => { write_stdout(format_args!("{}\n", format_args!($($arg)*))) };
}

fn write_stdout(args: Arguments) {
    match io::stdout().lock().write_fmt(args) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::BrokenPipe => std::process::exit(0),
        Err(e) => {
            eprintln!("tessela: cannot write to stdout: {e}");
            std::process::exit(2);
        }
    }
}

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
    /// Print JSON instead of text; errors are JSON too
    #[arg(long)]
    json: bool,
    /// The API version the caller was written for; the command fails when it differs
    #[arg(long)]
    api: Option<u32>,
}

/// What every command that reads or changes pages takes.
#[derive(Args)]
struct EditArgs {
    /// The bundle folder
    #[arg(long, short = 'b', default_value = ".")]
    bundle: PathBuf,
    /// Print JSON instead of text; errors are JSON too
    #[arg(long)]
    json: bool,
    /// The API version the caller was written for; the command fails when it differs
    #[arg(long)]
    api: Option<u32>,
}

/// The filters of `query`, shared with the first stage of a fence.
#[derive(Args)]
struct QueryArgs {
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
    /// First day to include (YYYY-MM-DD): journal days and dates written in blocks
    #[arg(long)]
    from: Option<String>,
    /// Last day to include (YYYY-MM-DD): journal days and dates written in blocks
    #[arg(long)]
    to: Option<String>,
    /// Only checkbox items (`- [ ]`, `- [x]`): `open`, `done` or `any`
    #[arg(long, value_enum)]
    task: Option<TaskArg>,
    /// Show at most this many blocks
    #[arg(long)]
    limit: Option<usize>,
}

#[derive(Clone, Copy, clap::ValueEnum)]
enum TaskArg {
    Open,
    Done,
    Any,
}

impl TaskArg {
    fn filter(self) -> TaskFilter {
        match self {
            TaskArg::Open => TaskFilter::Open,
            TaskArg::Done => TaskFilter::Done,
            TaskArg::Any => TaskFilter::Any,
        }
    }
}

impl QueryArgs {
    fn query(&self) -> Query {
        Query {
            refs: self.refs.clone(),
            any: self.any,
            own: self.own,
            text: self.text.clone(),
            kind: self.kind.clone(),
            page: self.page.clone(),
            from: self.from.clone(),
            to: self.to.clone(),
            task: self.task.map(TaskArg::filter),
        }
    }
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
    /// List every concept page with its title and type
    Pages {
        #[command(flatten)]
        common: Common,
    },
    /// Stream the pages that change on disk, one line per burst of changes
    Watch {
        #[command(flatten)]
        common: Common,
        /// Stop when stdin is closed, so a caller that goes away does not leave this running
        #[arg(long)]
        exit_on_stdin_close: bool,
        /// Look at the files every few seconds instead of asking the system, for folders it
        /// cannot watch (network shares)
        #[arg(long)]
        poll: bool,
    },
    /// Find backlinks and blocks: by concept, text, page, type or date
    Query {
        #[command(flatten)]
        common: Common,
        #[command(flatten)]
        filters: QueryArgs,
    },
    /// List what a folder holds, as an OKF `index.md` (computed, nothing is written)
    Index {
        #[command(flatten)]
        common: Common,
        /// The folder to list, relative to the bundle; the root when left out
        #[arg(long, default_value = "", conflicts_with = "write")]
        dir: String,
        /// List every page below the folder, sub-folders included, as one flat list
        #[arg(long, conflicts_with = "write")]
        recursive: bool,
        /// Write an `index.md` into every folder instead, for bundles that are read
        /// by tools that do not compute listings. Files that were not generated are kept.
        #[arg(long)]
        write: bool,
        /// With --write, replace `index.md` files that were not generated too
        #[arg(long, requires = "write")]
        force: bool,
    },
    /// Convert a Logseq graph into a new Tessela bundle
    ImportLogseq {
        /// The Logseq graph folder (the one with `pages` and `journals`)
        graph: PathBuf,
        /// Where to write the bundle; must not exist or must be empty
        out: PathBuf,
        /// Print the report as JSON
        #[arg(long)]
        json: bool,
    },
    /// Print the API version of the edit commands (read, add, save, rename, move, remove)
    Api {
        /// Print JSON instead of text
        #[arg(long)]
        json: bool,
    },
    /// Read a page: its text and the hash to base a change on
    Read {
        #[command(flatten)]
        edit: EditArgs,
        /// The page, e.g. `project/tessela.md`
        page: String,
    },
    /// Create a page from the template (or from the text on stdin)
    Add {
        #[command(flatten)]
        edit: EditArgs,
        /// The page's name or path: `Machine Learning`, `project/tessela`
        name: String,
        /// The title, when it should not be the name
        #[arg(long)]
        title: Option<String>,
        /// The frontmatter `type`, when it should not be `concept` (`journal` in journals/)
        #[arg(long = "type")]
        kind: Option<String>,
        /// Read the whole page from stdin instead of using the template
        #[arg(long)]
        stdin: bool,
    },
    /// Store a file (a picture, a PDF) in assets/, named after the page that uses it
    Attach {
        #[command(flatten)]
        edit: EditArgs,
        /// The page that will link to the file, e.g. `project/tessela.md`; it need not exist yet
        page: String,
        /// Read the file from here instead of stdin
        #[arg(long)]
        file: Option<PathBuf>,
        /// The file's extension, when it is not in the file's name or recognised from its bytes
        #[arg(long)]
        ext: Option<String>,
    },
    /// Replace a page, or change it with a unified diff, based on a hash from `read`
    Save {
        #[command(flatten)]
        edit: EditArgs,
        /// The page, e.g. `project/tessela.md`
        page: String,
        /// The hash `read` gave, or `new` when the page must not exist yet
        #[arg(long)]
        expect: String,
        /// The input is a unified diff of the page, not its new text
        #[arg(long)]
        patch: bool,
        /// Read the input from this file instead of stdin
        #[arg(long)]
        file: Option<PathBuf>,
    },
    /// Give a page a new name, in the same folder; tags and links that name it follow
    Rename {
        #[command(flatten)]
        edit: EditArgs,
        /// The page, e.g. `project/tessela.md`
        page: String,
        /// The new name, without folders
        new_name: String,
        /// Fail unless the page still has this hash
        #[arg(long)]
        expect: Option<String>,
        /// Only report what would change
        #[arg(long)]
        dry_run: bool,
    },
    /// Move a page to another folder (`dest/`) or path; tags and links that name it follow
    Move {
        #[command(flatten)]
        edit: EditArgs,
        /// The page, e.g. `project/tessela.md`
        page: String,
        /// A folder ending in `/`, or the new path
        dest: String,
        /// Fail unless the page still has this hash
        #[arg(long)]
        expect: Option<String>,
        /// Only report what would change
        #[arg(long)]
        dry_run: bool,
    },
    /// Delete a page, based on a hash from `read`; says which pages still mention it
    Remove {
        #[command(flatten)]
        edit: EditArgs,
        /// The page, e.g. `project/tessela.md`
        page: String,
        /// The hash `read` gave
        #[arg(long)]
        expect: String,
    },
    /// Run the body of a ```tessela fence (a live list): a read-only command, then filters
    Fence {
        #[command(flatten)]
        edit: EditArgs,
        /// Read the fence from this file instead of stdin
        #[arg(long)]
        file: Option<PathBuf>,
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
        Command::Query { common, filters } => run_query(common, filters.query(), filters.limit),
        Command::Pages { common } => pages(common),
        Command::Watch {
            common,
            exit_on_stdin_close,
            poll,
        } => run_watch(common, exit_on_stdin_close, poll),
        Command::Index {
            common,
            dir,
            recursive,
            write,
            force,
        } => run_index(common, &dir, recursive, write, force),
        Command::ImportLogseq { graph, out, json } => import_logseq(&graph, &out, json),
        Command::Vocab {
            common,
            unwritten,
            min_count,
            prefix,
        } => vocab(common, unwritten, min_count, prefix),
        Command::Api { json } => api(json),
        Command::Read { edit, page } => run_edit(&edit, |store| {
            let path = edit::existing_path(&page)?;
            let read = edit::read_page(store, &path)?;
            Ok(Done::new(&read, |_| read.text.clone(), true))
        }),
        Command::Add {
            edit,
            name,
            title,
            kind,
            stdin,
        } => run_edit(&edit, |store| {
            let path = edit::path_from_name(&name)?;
            let text = if stdin { Some(read_input(None)?) } else { None };
            let title = title.or_else(|| default_title(&name));
            let saved = edit::add_page(
                store,
                &path,
                title.as_deref(),
                kind.as_deref(),
                text.as_deref(),
            )?;
            Ok(Done::new(
                &saved,
                |s| format!("created {} ({})", s.path, s.hash),
                false,
            ))
        }),
        Command::Attach {
            edit,
            page,
            file,
            ext,
        } => run_edit(&edit, |store| {
            let path = edit::existing_path(&page)?;
            let bytes = read_bytes(file.as_deref())?;
            let ext = ext
                .or_else(|| {
                    file.as_deref()
                        .and_then(|f| f.extension())
                        .map(|e| e.to_string_lossy().into_owned())
                })
                .or_else(|| edit::sniff_extension(&bytes).map(String::from))
                .ok_or_else(|| {
                    EditError::new(
                        ErrorCode::InvalidInput,
                        "cannot tell what kind of file this is: pass --ext, for example --ext png",
                    )
                })?;
            let attached = edit::attach(store, &path, &bytes, &ext)?;
            Ok(Done::new(
                &attached,
                |a| {
                    format!(
                        "{} {}",
                        if a.created {
                            "stored"
                        } else {
                            "already stored"
                        },
                        a.path
                    )
                },
                false,
            ))
        }),
        Command::Save {
            edit,
            page,
            expect,
            patch,
            file,
        } => run_edit(&edit, |store| {
            let path = edit::existing_path(&page)?;
            let input = read_input(file.as_deref())?;
            let expect = Expect::parse(&expect);
            let saved = if patch {
                edit::patch_page(store, &path, &input, &expect)?
            } else {
                edit::save_page(store, &path, &input, &expect)?
            };
            Ok(Done::new(
                &saved,
                |s| format!("saved {} ({})", s.path, s.hash),
                false,
            ))
        }),
        Command::Rename {
            edit,
            page,
            new_name,
            expect,
            dry_run,
        } => run_edit(&edit, |store| {
            let from = edit::existing_path(&page)?;
            let to = edit::rename_target(&from, &new_name)?;
            moved(store, &from, &to, expect.as_deref(), dry_run)
        }),
        Command::Move {
            edit,
            page,
            dest,
            expect,
            dry_run,
        } => run_edit(&edit, |store| {
            let from = edit::existing_path(&page)?;
            let to = edit::move_target(&from, &dest)?;
            moved(store, &from, &to, expect.as_deref(), dry_run)
        }),
        Command::Fence { edit, file } => run_edit(&edit, |_| {
            let input = read_input(file.as_deref())?;
            let bundle = Bundle::load(&edit.bundle)
                .map_err(|e| EditError::new(ErrorCode::Io, e.to_string()))?;
            let out = fence::run(&bundle, &input)?;
            Ok(Done::new(&out, |o| o.text(), true))
        }),
        Command::Remove { edit, page, expect } => run_edit(&edit, |store| {
            let path = edit::existing_path(&page)?;
            let removed = edit::remove_page(store, &path, &expect)?;
            Ok(Done::new(
                &removed,
                |r| {
                    let mut out = format!("removed {}", r.path);
                    for p in &r.mentioned_by {
                        out.push_str(&format!("\nstill mentioned by {p}"));
                    }
                    out
                },
                false,
            ))
        }),
    }
}

/// What a successful edit command prints: the data as JSON, or a line of text.
struct Done {
    json: serde_json::Value,
    text: String,
    /// The text is the page itself: print it as it is, with no added newline.
    raw: bool,
}

impl Done {
    fn new<T: Serialize>(value: &T, text: impl Fn(&T) -> String, raw: bool) -> Done {
        Done {
            json: envelope(serde_json::to_value(value).expect("output serializes")),
            text: text(value),
            raw,
        }
    }
}

fn run_edit(
    args: &EditArgs,
    op: impl FnOnce(&dyn PageStore) -> Result<Done, EditError>,
) -> ExitCode {
    let result = edit::check_api(args.api)
        .and_then(|()| FsStore::new(&args.bundle))
        .and_then(|store| op(&store));
    match result {
        Ok(done) if args.json => {
            print_json(&done.json);
            ExitCode::SUCCESS
        }
        Ok(done) if done.raw => {
            out!("{}", done.text);
            ExitCode::SUCCESS
        }
        Ok(done) => {
            outln!("{}", done.text);
            ExitCode::SUCCESS
        }
        Err(e) => fail(args.json, &e),
    }
}

/// Reports a failed command: JSON when the caller asked for it, a line on stderr otherwise.
/// 1 is for findings (lint), 2 for failures, 3 for a change that lost a race.
fn fail(json: bool, e: &EditError) -> ExitCode {
    if json {
        print_json(&serde_json::json!({ "api": API_VERSION, "ok": false, "error": e }));
    } else {
        eprintln!("tessela: {e}");
    }
    ExitCode::from(if e.code == ErrorCode::Conflict { 3 } else { 2 })
}

/// Every `--json` answer carries `api` and `ok`. An object keeps its fields; a list goes
/// under the name the caller reads it by.
fn envelope(mut json: serde_json::Value) -> serde_json::Value {
    if let Some(map) = json.as_object_mut() {
        map.insert("api".into(), API_VERSION.into());
        map.insert("ok".into(), true.into());
    }
    json
}

fn print_ok(json: serde_json::Value) {
    print_json(&envelope(json));
}

fn moved(
    store: &dyn PageStore,
    from: &str,
    to: &str,
    expect: Option<&str>,
    dry_run: bool,
) -> Result<Done, EditError> {
    let moved = edit::move_page(store, from, to, expect, dry_run)?;
    Ok(Done::new(
        &moved,
        |m| {
            let verb = if m.dry_run { "would move" } else { "moved" };
            let mut out = format!("{verb} {} to {}", m.from, m.to);
            for u in &m.updated {
                out.push_str(&format!(
                    "\n  {}: {} links, {} tags",
                    u.path, u.links, u.tags
                ));
            }
            for w in &m.warnings {
                out.push_str(&format!("\n  check: {w}"));
            }
            out
        },
        false,
    ))
}

fn default_title(name: &str) -> Option<String> {
    let last = name.trim().trim_start_matches('#').rsplit('/').next()?;
    let last = last.strip_suffix(".md").unwrap_or(last).trim();
    // A plain lowercase name gets the title the template derives from the path.
    (last != last.to_lowercase() || last.contains(char::is_whitespace)).then(|| last.to_string())
}

fn read_input(file: Option<&Path>) -> Result<String, EditError> {
    let mut text = String::new();
    let read = match file {
        Some(f) => std::fs::read_to_string(f).map(|t| text = t),
        None => std::io::stdin().read_to_string(&mut text).map(|_| ()),
    };
    read.map_err(|e| {
        EditError::new(
            ErrorCode::InvalidInput,
            format!("cannot read the input: {e}"),
        )
    })?;
    Ok(text)
}

/// The most an attachment may weigh, so a stray pipe cannot fill the disk.
const MAX_ATTACHMENT: u64 = 64 * 1024 * 1024;

fn read_bytes(file: Option<&Path>) -> Result<Vec<u8>, EditError> {
    let mut bytes = Vec::new();
    let read = match file {
        Some(f) => {
            std::fs::File::open(f).and_then(|f| f.take(MAX_ATTACHMENT + 1).read_to_end(&mut bytes))
        }
        None => std::io::stdin()
            .take(MAX_ATTACHMENT + 1)
            .read_to_end(&mut bytes),
    };
    read.map_err(|e| {
        EditError::new(
            ErrorCode::InvalidInput,
            format!("cannot read the input: {e}"),
        )
    })?;
    if bytes.len() as u64 > MAX_ATTACHMENT {
        return Err(EditError::new(
            ErrorCode::InvalidInput,
            "the file is larger than 64 MiB",
        ));
    }
    Ok(bytes)
}

fn api(json: bool) -> ExitCode {
    if json {
        print_json(&serde_json::json!({
            "api": API_VERSION,
            "version": env!("CARGO_PKG_VERSION"),
        }));
    } else {
        outln!("{API_VERSION}");
    }
    ExitCode::SUCCESS
}

fn load(common: &Common) -> Result<Bundle, ExitCode> {
    edit::check_api(common.api)
        .and_then(|()| {
            Bundle::load(&common.path).map_err(|e| {
                let code = if e.kind() == ErrorKind::NotFound {
                    ErrorCode::NotFound
                } else {
                    ErrorCode::Io
                };
                EditError::new(code, e.to_string())
            })
        })
        .map_err(|e| fail(common.json, &e))
}

fn print_json<T: Serialize>(value: &T) {
    outln!(
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
        print_ok(serde_json::json!({ "diagnostics": diagnostics }));
    } else {
        for d in &diagnostics {
            let line = d.line.map_or(String::new(), |l| format!(":{l}"));
            outln!(
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

fn run_watch(common: Common, exit_on_stdin_close: bool, poll: bool) -> ExitCode {
    let bundle = match load(&common) {
        Ok(b) => b,
        Err(code) => return code,
    };
    if exit_on_stdin_close {
        std::thread::spawn(|| {
            let _ = io::copy(&mut io::stdin(), &mut io::sink());
            std::process::exit(0);
        });
    }
    let json = common.json;
    let line = |event: &str, fields: serde_json::Value| {
        if json {
            let mut value = envelope(serde_json::json!({ "event": event }));
            value
                .as_object_mut()
                .expect("an object")
                .extend(fields.as_object().cloned().unwrap_or_default());
            outln!(
                "{}",
                serde_json::to_string(&value).expect("output serializes")
            );
        }
    };
    let result = watch::watch(
        &bundle.root,
        &watch::Options {
            native: !poll,
            ..Default::default()
        },
        |event| match event {
            watch::Event::Ready(mode) => {
                line("ready", serde_json::json!({ "mode": mode.as_str() }))
            }
            watch::Event::Mode(mode, reason) => {
                line(
                    "mode",
                    serde_json::json!({ "mode": mode.as_str(), "reason": reason }),
                );
                if !json {
                    eprintln!("tessela: watching in {} mode: {reason}", mode.as_str());
                }
            }
            watch::Event::Changed(paths) => {
                if json {
                    line("changed", serde_json::json!({ "paths": paths }));
                } else {
                    for path in &paths {
                        outln!("changed {path}");
                    }
                }
            }
        },
    );
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => fail(json, &EditError::new(ErrorCode::Io, message)),
    }
}

fn pages(common: Common) -> ExitCode {
    let bundle = match load(&common) {
        Ok(b) => b,
        Err(code) => return code,
    };
    let mut pages: Vec<_> = bundle.pages.iter().collect();
    pages.sort_by(|a, b| a.path.cmp(&b.path));
    if common.json {
        let rows: Vec<_> = pages
            .iter()
            .map(|p| {
                serde_json::json!({
                    "id": p.id,
                    "path": p.path,
                    "title": p.title(),
                    "type": p.kind(),
                })
            })
            .collect();
        print_ok(serde_json::json!({ "pages": rows }));
    } else {
        for p in &pages {
            outln!("{}  {}", p.path, p.title());
        }
        eprintln!("{} pages", pages.len());
    }
    ExitCode::SUCCESS
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
        print_ok(serde_json::json!({ "total": total, "hits": hits }));
    } else {
        for hit in &hits {
            let label = match hit.kind {
                HitKind::Block => "",
                HitKind::Heading => "  [heading]",
                HitKind::Page => "  [page]",
            };
            let home = if hit.home { "  [home]" } else { "" };
            outln!("{}:{}  {}{label}{home}", hit.path, hit.line, hit.handle);
            if !hit.heading_path.is_empty() {
                outln!("  under: {}", hit.heading_path.join(" > "));
            }
            for line in hit.text.lines() {
                outln!("  {line}");
            }
        }
        if hits.len() < total {
            eprintln!("{} of {total} hits", hits.len());
        } else {
            eprintln!("{total} hits");
        }
    }
    ExitCode::SUCCESS
}

fn run_index(common: Common, dir: &str, recursive: bool, write: bool, force: bool) -> ExitCode {
    let bundle = match load(&common) {
        Ok(b) => b,
        Err(code) => return code,
    };
    if write {
        let report = match index::write_indexes(&bundle, force) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("tessela: {e}");
                return ExitCode::from(2);
            }
        };
        if common.json {
            print_ok(serde_json::to_value(&report).expect("output serializes"));
        } else {
            for path in &report.written {
                outln!("wrote {path}");
            }
            for path in &report.kept {
                outln!("kept {path}: not generated by tessela (use --force to replace it)");
            }
        }
        return ExitCode::SUCCESS;
    }
    let listing = if recursive {
        index::recursive_listing(&bundle, dir)
    } else {
        index::listing(&bundle, dir)
    };
    if common.json {
        print_ok(serde_json::to_value(&listing).expect("output serializes"));
    } else {
        let name = bundle
            .root
            .canonicalize()
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_else(|| "Notes".into());
        out!("{}", listing.to_markdown(&name));
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
        print_ok(serde_json::json!({ "concepts": entries }));
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
            outln!(
                "{:>4}  {:<width$}  {} {pages}{notes}",
                e.mentions,
                e.concept,
                e.pages
            );
        }
        eprintln!("{} concepts", entries.len());
    }
    ExitCode::SUCCESS
}

fn import_logseq(graph: &Path, out: &Path, json: bool) -> ExitCode {
    let report = match logseq::import(graph, out) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("tessela: {e}");
            return ExitCode::from(2);
        }
    };
    if json {
        print_ok(serde_json::to_value(&report).expect("output serializes"));
        return ExitCode::SUCCESS;
    }
    outln!(
        "Imported {} pages and {} journals ({} blocks) into {}",
        report.pages,
        report.journals,
        report.blocks,
        out.display()
    );
    let lines = [
        (
            report.properties_converted,
            "properties turned into tags and links",
        ),
        (
            report.block_refs_inlined,
            "block references and embeds inlined",
        ),
        (report.assets_copied, "assets copied"),
        (report.empty_pages_skipped, "empty pages skipped"),
        (
            report.unresolved_block_refs,
            "block references could not be found",
        ),
        (report.macros_left, "Logseq macros left as they were"),
    ];
    for (count, what) in lines {
        if count > 0 {
            outln!("  {count} {what}");
        }
    }
    for (page, file) in &report.renamed {
        outln!("  page \"{page}\" was written as {file} because of a name clash");
    }
    for skipped in &report.skipped {
        outln!("  skipped {}: {}", skipped.path, skipped.reason);
    }
    outln!("Next: tessela lint {}", out.display());
    ExitCode::SUCCESS
}
