use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use tessela_core::{Bundle, Linter, Severity};

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

#[derive(Subcommand)]
enum Command {
    /// Check a bundle against OKF and the Tessela conventions
    Lint {
        /// The bundle folder
        #[arg(default_value = ".")]
        path: PathBuf,
        /// Print diagnostics as JSON
        #[arg(long)]
        json: bool,
        /// Exit with an error on warnings too
        #[arg(long)]
        strict: bool,
        /// Hide diagnostics below this severity
        #[arg(long, value_parser = ["info", "warning", "error"], default_value = "info")]
        min_severity: String,
    },
}

fn main() -> ExitCode {
    match Cli::parse().command {
        Command::Lint {
            path,
            json,
            strict,
            min_severity,
        } => lint(path, json, strict, &min_severity),
    }
}

fn lint(path: PathBuf, json: bool, strict: bool, min_severity: &str) -> ExitCode {
    let bundle = match Bundle::load(&path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("tessela: {e}");
            return ExitCode::from(2);
        }
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

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&diagnostics).expect("diagnostics serialize")
        );
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
