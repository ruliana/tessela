//! `tessela schema`: the whole API as one JSON document, so a client in any language can be
//! generated from it. The commands and their arguments come from the command line parser, and
//! the answers from the types that print them, so what is described is what is there.

use schemars::{Schema, SchemaGenerator};
use serde_json::{Value, json};
use tessela_core::edit::{API_VERSION, Attached, EditError, Moved, PageRead, Removed, Saved};
use tessela_core::{Listing, WriteReport, logseq};

use crate::answers;

/// The answer of a command, or `None` for a command that has none described yet.
/// A new command is not done until it is listed here; a test checks it.
pub fn answer(name: &str, g: &mut SchemaGenerator) -> Option<Schema> {
    let schema = match name {
        "api" => g.subschema_for::<answers::Api>(),
        "pages" => g.subschema_for::<answers::Pages>(),
        "query" => g.subschema_for::<answers::Query>(),
        "vocab" => g.subschema_for::<answers::Vocab>(),
        "lint" => g.subschema_for::<answers::Lint>(),
        "watch" => g.subschema_for::<answers::WatchEvent>(),
        "index" => Schema::try_from(json!({ "oneOf": [
            g.subschema_for::<Listing>(),
            g.subschema_for::<WriteReport>(),
        ] }))
        .expect("an object"),
        "import-logseq" => g.subschema_for::<logseq::Report>(),
        "read" => g.subschema_for::<PageRead>(),
        "add" | "save" => g.subschema_for::<Saved>(),
        "rename" | "move" => g.subschema_for::<Moved>(),
        "attach" => g.subschema_for::<Attached>(),
        "fence" => g.subschema_for::<crate::fence::Output>(),
        "remove" => g.subschema_for::<Removed>(),
        "schema" => Schema::try_from(json!({ "type": "object" })).expect("an object"),
        _ => return None,
    };
    Some(schema)
}

fn flag_or_value(arg: &clap::Arg) -> &'static str {
    if arg.get_action().takes_values() {
        "value"
    } else {
        "flag"
    }
}

fn args_of(command: &clap::Command) -> Vec<Value> {
    command
        .get_arguments()
        .filter(|a| !matches!(a.get_id().as_str(), "help" | "version"))
        .map(|a| {
            let defaults: Vec<_> = a
                .get_default_values()
                .iter()
                .map(|d| d.to_string_lossy().into_owned())
                .collect();
            let choices: Vec<_> = a
                .get_possible_values()
                .iter()
                .map(|p| p.get_name().to_string())
                .collect();
            json!({
                "name": a.get_id().as_str(),
                "long": a.get_long(),
                "short": a.get_short().map(String::from),
                "positional": a.is_positional(),
                "kind": flag_or_value(a),
                "required": a.is_required_set(),
                "repeatable": matches!(a.get_action(), clap::ArgAction::Append),
                "default": defaults.first(),
                "choices": (!choices.is_empty()).then_some(choices),
                "help": a.get_help().map(|h| h.to_string()),
            })
        })
        .collect()
}

/// The envelope every answer is in, and what a failure looks like.
fn envelope(g: &mut SchemaGenerator) {
    let error = g.subschema_for::<EditError>();
    let defs = g.definitions_mut();
    defs.insert(
        "Envelope".into(),
        json!({
            "description": "Every answer carries the API version and ok.",
            "type": "object",
            "required": ["api", "ok"],
            "properties": { "api": { "const": API_VERSION }, "ok": { "const": true } },
        }),
    );
    defs.insert(
        "Failure".into(),
        json!({
            "description": "What a command prints with --json when it fails (exit code 2, or 3 for a conflict).",
            "type": "object",
            "required": ["api", "ok", "error"],
            "properties": { "api": { "const": API_VERSION }, "ok": { "const": false }, "error": error },
        }),
    );
}

pub fn document(cli: &clap::Command) -> Value {
    let mut g = SchemaGenerator::default();
    envelope(&mut g);
    let mut commands = serde_json::Map::new();
    for sub in cli.get_subcommands().filter(|c| c.get_name() != "help") {
        let answer = answer(sub.get_name(), &mut g)
            .map(|a| json!({ "allOf": [{ "$ref": "#/$defs/Envelope" }, a] }));
        commands.insert(
            sub.get_name().to_string(),
            json!({
                "about": sub.get_about().map(|a| a.to_string()),
                "args": args_of(sub),
                "answer": answer,
            }),
        );
    }
    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "The tessela API",
        "api": API_VERSION,
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "description": "Commands take --json for answers described here and --api N for the version the caller was written for. Exit codes: 0 done, 1 findings (lint), 2 failed, 3 conflict.",
        "commands": commands,
        "failure": { "$ref": "#/$defs/Failure" },
        "$defs": g.definitions(),
    })
}

#[cfg(test)]
mod tests {
    use clap::CommandFactory;
    use schemars::SchemaGenerator;

    /// A new command is not done until its answer is described.
    #[test]
    fn every_command_describes_its_answer() {
        let mut g = SchemaGenerator::default();
        let missing: Vec<_> = crate::Cli::command()
            .get_subcommands()
            .map(|c| c.get_name().to_string())
            .filter(|n| n != "help" && super::answer(n, &mut g).is_none())
            .collect();
        assert!(
            missing.is_empty(),
            "add to `answer` in schema.rs: {missing:?}"
        );
    }
}
