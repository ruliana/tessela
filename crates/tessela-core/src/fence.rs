//! The text pipes of a live list (a ```` ```tessela ```` fence).
//!
//! A fence holds a read-only `tessela` command, optionally followed by filters:
//!
//! ```text
//! query --ref rust --task open | rg -v draft | sort | head 5
//! ```
//!
//! A fence arrives with a page, and a page can arrive by `git pull` or from an agent, so the
//! line must never reach a shell or a real program (`awk` has `system()`, GNU `sed` has the
//! `e` and `w` commands, `rg` has `--pre`). This module parses the pipe itself. The first
//! stage is handed back as words for the caller to run, and every later stage is one of the
//! filters below, which sees only the lines it is given and has no way to open a file.
//! Regular expressions are the `regex` crate's, which cannot take exponential time and are
//! limited in size.

use std::fmt;

use regex::{Regex, RegexBuilder};

/// A pipe that cannot be read: the message says which stage and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FenceError(pub String);

impl fmt::Display for FenceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for FenceError {}

type Result<T> = std::result::Result<T, FenceError>;

fn err<T>(message: impl Into<String>) -> Result<T> {
    Err(FenceError(message.into()))
}

/// One line flowing through the filters. `from` says which row of the first stage it still
/// stands for, so the caller can tell what survived; filters that build a new line clear it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    pub text: String,
    pub from: Option<usize>,
}

impl Line {
    pub fn new(text: impl Into<String>, from: Option<usize>) -> Line {
        Line {
            text: text.into(),
            from,
        }
    }
}

/// A parsed fence: the words of the first stage, then the filters.
#[derive(Debug)]
pub struct Pipeline {
    pub source: Vec<String>,
    pub filters: Vec<Filter>,
}

impl Pipeline {
    pub fn parse(body: &str) -> Result<Pipeline> {
        let mut stages = split_stages(body)?;
        if stages.iter().all(Vec::is_empty) {
            return err(
                "the fence is empty: it needs a tessela command such as `query --ref rust`",
            );
        }
        let mut first = stages.remove(0);
        if first.first().is_some_and(|w| w == "tessela") {
            first.remove(0);
        }
        if first.is_empty() {
            return err("the first stage must be a tessela command such as `query --ref rust`");
        }
        let filters = stages
            .iter()
            .enumerate()
            .map(|(i, words)| {
                Filter::parse(words).map_err(|e| FenceError(format!("stage {}: {e}", i + 2)))
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Pipeline {
            source: first,
            filters,
        })
    }

    /// Runs the filters over the lines of the first stage.
    pub fn filter(&self, lines: Vec<Line>) -> Vec<Line> {
        self.filters.iter().fold(lines, |lines, f| f.apply(lines))
    }
}

/// Splits a fence body into stages of words. Lines of the body are joined with a space, so a
/// long pipe can be broken after a `|`. Words follow the usual quoting: `'...'` is literal,
/// `"..."` takes `\"` and `\\`, and a backslash outside quotes takes the next character. A
/// `|` outside quotes ends a stage. Nothing is expanded: `$`, `*` and `~` are ordinary.
pub fn split_stages(body: &str) -> Result<Vec<Vec<String>>> {
    let mut stages: Vec<Vec<String>> = vec![Vec::new()];
    let mut word = String::new();
    let mut in_word = false;
    let mut chars = body.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(c) => word.push(c),
                        None => return err("a ' is never closed"),
                    }
                }
            }
            '"' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') if matches!(chars.peek(), Some('"' | '\\')) => {
                            word.push(chars.next().unwrap());
                        }
                        Some(c) => word.push(c),
                        None => return err("a \" is never closed"),
                    }
                }
            }
            '\\' => {
                in_word = true;
                match chars.next() {
                    Some(c) => word.push(c),
                    None => word.push('\\'),
                }
            }
            c if c.is_whitespace() => {
                if in_word {
                    stages.last_mut().unwrap().push(std::mem::take(&mut word));
                    in_word = false;
                }
            }
            '|' => {
                if in_word {
                    stages.last_mut().unwrap().push(std::mem::take(&mut word));
                    in_word = false;
                }
                if stages.last().unwrap().is_empty() {
                    return err("a `|` needs a command before it");
                }
                stages.push(Vec::new());
            }
            c => {
                in_word = true;
                word.push(c);
            }
        }
    }
    if in_word {
        stages.last_mut().unwrap().push(word);
    }
    if stages.len() > 1 && stages.last().unwrap().is_empty() {
        return err("a `|` needs a command after it");
    }
    Ok(stages)
}

/// What `wc` counts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Count {
    Lines,
    Words,
    Chars,
}

#[derive(Debug)]
pub enum Filter {
    /// `rg [-i] [-v] [-F] [-w] [-e PATTERN]... [PATTERN]`
    Rg { pattern: Regex, invert: bool },
    /// `sed [-e] SCRIPT...` with `s/re/new/[gi]` and `/re/d`
    Sed(Vec<SedCommand>),
    /// `sort [-r] [-n] [-u]`
    Sort {
        reverse: bool,
        numeric: bool,
        unique: bool,
    },
    /// `uniq [-c]`
    Uniq { count: bool },
    /// `head [[-n] N]`
    Head(usize),
    /// `wc [-l|-w|-c]`
    Wc(Count),
}

#[derive(Debug)]
pub enum SedCommand {
    Substitute {
        pattern: Regex,
        replacement: Vec<Part>,
        global: bool,
    },
    Delete(Regex),
}

/// A piece of the replacement in `s/re/new/`.
#[derive(Debug)]
pub enum Part {
    Text(String),
    /// `&` is group 0, `\1` to `\9` the numbered groups.
    Group(usize),
}

const REGEX_SIZE_LIMIT: usize = 1 << 20;

fn build_regex(pattern: &str, case_insensitive: bool) -> Result<Regex> {
    RegexBuilder::new(pattern)
        .case_insensitive(case_insensitive)
        .size_limit(REGEX_SIZE_LIMIT)
        .build()
        .map_err(|e| FenceError(format!("{pattern:?} is not a pattern this tool reads: {e}")))
}

impl Filter {
    pub fn parse(words: &[String]) -> Result<Filter> {
        let (name, args) = words
            .split_first()
            .ok_or_else(|| FenceError("empty stage".into()))?;
        match name.as_str() {
            "rg" | "grep" => parse_rg(args),
            "sed" => parse_sed(args),
            "sort" => parse_sort(args),
            "uniq" => parse_uniq(args),
            "head" => parse_head(args),
            "wc" => parse_wc(args),
            other => err(format!(
                "{other:?} is not a filter; after the first command a pipe takes rg, sed, \
                 sort, uniq, head and wc"
            )),
        }
    }

    pub fn apply(&self, lines: Vec<Line>) -> Vec<Line> {
        match self {
            Filter::Rg { pattern, invert } => lines
                .into_iter()
                .filter(|l| pattern.is_match(&l.text) != *invert)
                .collect(),
            Filter::Sed(commands) => lines
                .into_iter()
                .filter_map(|l| sed_line(commands, l))
                .collect(),
            Filter::Sort {
                reverse,
                numeric,
                unique,
            } => {
                let mut lines = lines;
                if *numeric {
                    lines.sort_by(|a, b| number_of(&a.text).total_cmp(&number_of(&b.text)));
                } else {
                    lines.sort_by(|a, b| a.text.cmp(&b.text));
                }
                if *reverse {
                    lines.reverse();
                }
                if *unique {
                    lines.dedup_by(|b, a| {
                        if *numeric {
                            number_of(&a.text) == number_of(&b.text)
                        } else {
                            a.text == b.text
                        }
                    });
                }
                lines
            }
            Filter::Uniq { count } => {
                let mut out: Vec<(Line, usize)> = Vec::new();
                for line in lines {
                    match out.last_mut() {
                        Some((last, n)) if last.text == line.text => *n += 1,
                        _ => out.push((line, 1)),
                    }
                }
                out.into_iter()
                    .map(|(line, n)| {
                        if *count {
                            Line::new(format!("{n:>7} {}", line.text), None)
                        } else {
                            line
                        }
                    })
                    .collect()
            }
            Filter::Head(n) => lines.into_iter().take(*n).collect(),
            Filter::Wc(what) => {
                let n = match what {
                    Count::Lines => lines.len(),
                    Count::Words => lines
                        .iter()
                        .map(|l| l.text.split_whitespace().count())
                        .sum(),
                    Count::Chars => lines.iter().map(|l| l.text.chars().count() + 1).sum(),
                };
                vec![Line::new(n.to_string(), None)]
            }
        }
    }
}

/// The number a line starts with (after blanks), or 0, as `sort -n` reads it.
fn number_of(text: &str) -> f64 {
    let t = text.trim_start();
    let end = t
        .char_indices()
        .find(|&(i, c)| !(c.is_ascii_digit() || c == '.' || (i == 0 && matches!(c, '-' | '+'))))
        .map_or(t.len(), |(i, _)| i);
    t[..end].parse().unwrap_or(0.0)
}

/// An option parser for the little the filters take: `-x` flags (which may be grouped,
/// `-iv`), and the words that are not flags. `-e` takes a value, the next word.
struct Args<'a> {
    name: &'a str,
    flags: Vec<char>,
    values: Vec<String>,
    rest: Vec<String>,
}

fn read_args<'a>(name: &'a str, args: &[String], flags: &str, valued: &str) -> Result<Args<'a>> {
    let mut out = Args {
        name,
        flags: Vec::new(),
        values: Vec::new(),
        rest: Vec::new(),
    };
    let mut it = args.iter();
    let mut flags_done = false;
    while let Some(arg) = it.next() {
        if flags_done || !arg.starts_with('-') || arg.len() == 1 || arg[1..].parse::<f64>().is_ok()
        {
            out.rest.push(arg.clone());
        } else if arg == "--" {
            flags_done = true;
        } else if arg.starts_with("--") {
            return err(format!("{name} does not take {arg}"));
        } else {
            let mut chars = arg[1..].chars();
            while let Some(c) = chars.next() {
                if valued.contains(c) {
                    let attached: String = chars.by_ref().collect();
                    let value = if attached.is_empty() {
                        it.next()
                            .cloned()
                            .ok_or_else(|| FenceError(format!("{name} -{c} needs a value")))?
                    } else {
                        attached
                    };
                    out.values.push(value);
                } else if flags.contains(c) {
                    out.flags.push(c);
                } else {
                    return err(format!("{name} does not take -{c}"));
                }
            }
        }
    }
    Ok(out)
}

impl Args<'_> {
    fn has(&self, flag: char) -> bool {
        self.flags.contains(&flag)
    }

    fn no_rest(&self) -> Result<()> {
        match self.rest.first() {
            Some(extra) => err(format!("{} does not take {extra:?}", self.name)),
            None => Ok(()),
        }
    }
}

fn parse_rg(args: &[String]) -> Result<Filter> {
    let mut a = read_args("rg", args, "ivFw", "e")?;
    let mut patterns = std::mem::take(&mut a.values);
    if patterns.is_empty() {
        if a.rest.is_empty() {
            return err("rg needs a pattern");
        }
        patterns.push(a.rest.remove(0));
    }
    a.no_rest()?;
    let alternatives: Vec<String> = patterns
        .iter()
        .map(|p| {
            let p = if a.has('F') {
                regex::escape(p)
            } else {
                p.clone()
            };
            if a.has('w') {
                format!(r"\b(?:{p})\b")
            } else {
                p
            }
        })
        .collect();
    let pattern = match alternatives.as_slice() {
        [one] => one.clone(),
        many => many
            .iter()
            .map(|p| format!("(?:{p})"))
            .collect::<Vec<_>>()
            .join("|"),
    };
    Ok(Filter::Rg {
        pattern: build_regex(&pattern, a.has('i'))?,
        invert: a.has('v'),
    })
}

fn parse_sort(args: &[String]) -> Result<Filter> {
    let a = read_args("sort", args, "rnu", "")?;
    a.no_rest()?;
    Ok(Filter::Sort {
        reverse: a.has('r'),
        numeric: a.has('n'),
        unique: a.has('u'),
    })
}

fn parse_uniq(args: &[String]) -> Result<Filter> {
    let a = read_args("uniq", args, "c", "")?;
    a.no_rest()?;
    Ok(Filter::Uniq { count: a.has('c') })
}

fn parse_head(args: &[String]) -> Result<Filter> {
    // `head 5`, `head -5`, `head -n 5` and `head -n5`.
    let a = read_args("head", args, "", "n")?;
    let mut counts: Vec<String> = a.values.clone();
    counts.extend(a.rest.iter().map(|r| r.trim_start_matches('-').to_string()));
    match counts.as_slice() {
        [] => Ok(Filter::Head(10)),
        [n] => n
            .parse()
            .map(Filter::Head)
            .map_err(|_| FenceError(format!("head needs a number of lines, not {n:?}"))),
        _ => err("head takes one number"),
    }
}

fn parse_wc(args: &[String]) -> Result<Filter> {
    let a = read_args("wc", args, "lwc", "")?;
    a.no_rest()?;
    Ok(Filter::Wc(match a.flags.as_slice() {
        [] | ['l'] => Count::Lines,
        ['w'] => Count::Words,
        ['c'] => Count::Chars,
        _ => return err("wc takes one of -l, -w or -c"),
    }))
}

fn parse_sed(args: &[String]) -> Result<Filter> {
    let mut a = read_args("sed", args, "Er", "e")?;
    let mut scripts = std::mem::take(&mut a.values);
    if scripts.is_empty() {
        if a.rest.is_empty() {
            return err("sed needs a script such as 's/old/new/g' or '/text/d'");
        }
        scripts.push(a.rest.remove(0));
    }
    a.no_rest()?;
    let commands = scripts
        .iter()
        .map(|s| parse_sed_script(s))
        .collect::<Result<Vec<_>>>()?;
    Ok(Filter::Sed(commands))
}

/// Reads up to the next unescaped `delim`. `\delim` is the delimiter itself, and when that
/// is a character a pattern gives a meaning to, it stays escaped so it still matches itself.
fn until_delim(chars: &mut std::str::Chars<'_>, delim: char, what: &str) -> Result<String> {
    let mut out = String::new();
    loop {
        match chars.next() {
            Some(c) if c == delim => return Ok(out),
            Some('\\') => match chars.next() {
                Some(c) if c == delim => {
                    if "\\.+*?()|[]{}^$".contains(c) {
                        out.push('\\');
                    }
                    out.push(c);
                }
                Some(c) => {
                    out.push('\\');
                    out.push(c);
                }
                None => return err(format!("the {what} of the sed script ends in a backslash")),
            },
            Some(c) => out.push(c),
            None => return err(format!("the {what} of the sed script is not closed")),
        }
    }
}

fn parse_sed_script(script: &str) -> Result<SedCommand> {
    let mut chars = script.trim().chars();
    match chars.next() {
        Some('s') => {
            let delim = chars
                .next()
                .filter(|c| !c.is_alphanumeric() && !c.is_whitespace() && *c != '\\')
                .ok_or_else(|| FenceError("s needs a delimiter, as in s/old/new/".into()))?;
            let pattern = until_delim(&mut chars, delim, "pattern")?;
            let replacement = until_delim(&mut chars, delim, "replacement")?;
            let (mut global, mut ignore_case) = (false, false);
            for flag in chars {
                match flag {
                    'g' => global = true,
                    'i' | 'I' => ignore_case = true,
                    other => {
                        return err(format!("s takes the flags g and i, not {other:?}"));
                    }
                }
            }
            let pattern = build_regex(&pattern, ignore_case)?;
            let replacement = parse_replacement(&replacement, pattern.captures_len() - 1)?;
            Ok(SedCommand::Substitute {
                pattern,
                replacement,
                global,
            })
        }
        Some('/') => {
            let pattern = until_delim(&mut chars, '/', "pattern")?;
            if chars.as_str().trim() != "d" {
                return err("with an address, sed takes only d (delete), as in '/text/d'");
            }
            Ok(SedCommand::Delete(build_regex(&pattern, false)?))
        }
        _ => err("sed reads s/old/new/[gi] and /text/d; for anything else use rg, sort or uniq"),
    }
}

/// `&` and `\0`-`\9` are groups, `\&` and `\\` are themselves, any other `\x` is `x`.
fn parse_replacement(text: &str, groups: usize) -> Result<Vec<Part>> {
    let mut parts = Vec::new();
    let mut literal = String::new();
    let flush = |literal: &mut String, parts: &mut Vec<Part>| {
        if !literal.is_empty() {
            parts.push(Part::Text(std::mem::take(literal)));
        }
    };
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        match c {
            '&' => {
                flush(&mut literal, &mut parts);
                parts.push(Part::Group(0));
            }
            '\\' => match chars.next() {
                Some(d) if d.is_ascii_digit() => {
                    let n = d.to_digit(10).unwrap() as usize;
                    if n > groups {
                        return err(format!(
                            "the replacement uses \\{n} but the pattern has {groups} group(s)"
                        ));
                    }
                    flush(&mut literal, &mut parts);
                    parts.push(Part::Group(n));
                }
                Some(other) => literal.push(other),
                None => literal.push('\\'),
            },
            c => literal.push(c),
        }
    }
    flush(&mut literal, &mut parts);
    Ok(parts)
}

fn sed_line(commands: &[SedCommand], mut line: Line) -> Option<Line> {
    for command in commands {
        match command {
            SedCommand::Delete(pattern) => {
                if pattern.is_match(&line.text) {
                    return None;
                }
            }
            SedCommand::Substitute {
                pattern,
                replacement,
                global,
            } => {
                let expand = |caps: &regex::Captures<'_>| {
                    let mut out = String::new();
                    for part in replacement {
                        match part {
                            Part::Text(t) => out.push_str(t),
                            Part::Group(n) => {
                                out.push_str(caps.get(*n).map_or("", |m| m.as_str()));
                            }
                        }
                    }
                    out
                };
                line.text = if *global {
                    pattern.replace_all(&line.text, expand).into_owned()
                } else {
                    pattern.replace(&line.text, expand).into_owned()
                };
            }
        }
    }
    Some(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(body: &str, lines: &[&str]) -> Vec<String> {
        let p = Pipeline::parse(body).unwrap();
        let lines = lines
            .iter()
            .enumerate()
            .map(|(i, t)| Line::new(*t, Some(i)))
            .collect();
        p.filter(lines).into_iter().map(|l| l.text).collect()
    }

    #[test]
    fn words_follow_shell_quoting_without_expanding_anything() {
        let stages = split_stages(r#"query --text "a \"b\" | c" | rg 'x|y' $HOME"#).unwrap();
        assert_eq!(stages[0], ["query", "--text", r#"a "b" | c"#]);
        assert_eq!(stages[1], ["rg", "x|y", "$HOME"]);
        assert!(split_stages("query |").is_err());
        assert!(split_stages("| head").is_err());
        assert!(split_stages("query 'open").is_err());
    }

    #[test]
    fn a_pipe_can_be_broken_over_lines_and_may_name_the_tool() {
        let p = Pipeline::parse("tessela query --ref rust |\n  head 3\n").unwrap();
        assert_eq!(p.source, ["query", "--ref", "rust"]);
        assert_eq!(p.filters.len(), 1);
    }

    #[test]
    fn only_the_built_in_filters_exist() {
        for bad in [
            "query | awk '{print}'",
            "query | sh -c ls",
            "query | sed -i s/a/b/",
            "query | rg --pre cat x",
            "query | sed 'e ls'",
            "query | sed 'w /tmp/x'",
        ] {
            assert!(Pipeline::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn rg_matches_inverts_and_takes_literals() {
        let l = ["a.md:1:Rust", "b.md:2:rust and c++", "c.md:3:other"];
        assert_eq!(run("q | rg rust", &l), ["b.md:2:rust and c++"]);
        assert_eq!(
            run("q | rg -i rust", &l),
            ["a.md:1:Rust", "b.md:2:rust and c++"]
        );
        assert_eq!(run("q | rg -v -i rust", &l), ["c.md:3:other"]);
        assert_eq!(run("q | rg -F c++", &l), ["b.md:2:rust and c++"]);
        assert_eq!(run("q | rg -w ther", &l), Vec::<String>::new());
        assert_eq!(
            run("q | rg -e Rust -e other", &l),
            ["a.md:1:Rust", "c.md:3:other"]
        );
    }

    #[test]
    fn sed_substitutes_and_deletes() {
        let l = ["a.md:1:foo foo", "b.md:2:bar"];
        assert_eq!(
            run("q | sed 's/foo/X/'", &l),
            ["a.md:1:X foo", "b.md:2:bar"]
        );
        assert_eq!(run("q | sed 's/foo/X/g'", &l), ["a.md:1:X X", "b.md:2:bar"]);
        assert_eq!(run("q | sed 's|^[^:]*:[0-9]*:||'", &l), ["foo foo", "bar"]);
        assert_eq!(
            run(r"q | sed -E 's/(f)(o+)/\2\1 [&]/'", &l),
            ["a.md:1:oof [foo] foo", "b.md:2:bar"]
        );
        assert_eq!(run("q | sed '/bar/d'", &l), ["a.md:1:foo foo"]);
        assert_eq!(
            run("q | sed -e 's/foo/x/g' -e '/x x/d'", &l),
            ["b.md:2:bar"]
        );
        assert!(Pipeline::parse(r"q | sed 's/(a)/\2/'").is_err());
    }

    #[test]
    fn sort_uniq_head_wc() {
        let l = ["b", "a", "b", "10 c", "9 d"];
        assert_eq!(run("q | sort", &l), ["10 c", "9 d", "a", "b", "b"]);
        assert_eq!(run("q | sort -u -r", &l), ["b", "a", "9 d", "10 c"]);
        assert_eq!(run("q | sort -n", &l), ["b", "a", "b", "9 d", "10 c"]);
        assert_eq!(run("q | head 2", &l), ["b", "a"]);
        assert_eq!(run("q | head -n 1", &l), ["b"]);
        assert_eq!(run("q | head -3", &l), ["b", "a", "b"]);
        assert_eq!(
            run("q | sort | uniq -c | head 1", &["x", "x"]),
            ["      2 x"]
        );
        assert_eq!(run("q | wc -l", &l), ["5"]);
        assert_eq!(run("q | wc -w", &l), ["7"]);
    }
}
