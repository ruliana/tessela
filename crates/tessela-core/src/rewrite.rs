//! Rewriting references when a page moves (spec §9).
//!
//! Renaming or moving a page changes its concept, so every tag and link that names it has to
//! follow. This works on the text, with byte ranges, so everything else in a file stays as it is.
//! What counts as a reference is decided by the same code that finds them for queries
//! (`refs`), so a rewritten page no longer mentions the old concept.

use std::ops::Range;

use pulldown_cmark::{Event, LinkType, Parser, Tag, TagEnd};

use crate::page::{Split, split_frontmatter};
use crate::refs::{has_scheme, normalize_concept, tag_spans};

/// A change to a byte range of a text.
type Edit = (Range<usize>, String);

/// Moving the page `old` to the file `new_path`.
pub struct Rewrite {
    /// The concept the page had: its path without `.md`, normalized.
    pub old_concept: String,
    /// The concept it has now.
    pub new_concept: String,
    /// The new file, e.g. `project/tessela.md`.
    pub new_path: String,
}

/// Where the page being rewritten lives.
pub struct Where<'a> {
    /// Its folder before the move, `""` at the root.
    pub dir_before: &'a str,
    /// Its folder after the move; the same unless this is the page that moves.
    pub dir_after: &'a str,
    /// This is the page that moves, so its relative links must be rebased.
    pub is_moved: bool,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Rewritten {
    pub text: String,
    /// Links that were changed.
    pub links: usize,
    /// Tags that were changed.
    pub tags: usize,
    /// 1-based lines of links that name the page but could not be changed (reference-style
    /// links and links written with escapes). They are left as they were.
    pub skipped_lines: Vec<usize>,
}

impl Rewritten {
    pub fn changed(&self) -> bool {
        self.links + self.tags > 0
    }
}

impl Rewrite {
    pub fn new(old_id: &str, new_path: &str) -> Rewrite {
        Rewrite {
            old_concept: normalize_concept(old_id),
            new_concept: normalize_concept(new_path.strip_suffix(".md").unwrap_or(new_path)),
            new_path: new_path.to_string(),
        }
    }

    /// The text of a page with its references to the old concept pointing at the new one.
    pub fn page(&self, text: &str, at: &Where) -> Rewritten {
        let mut edits: Vec<Edit> = Vec::new();
        let mut counts = Counts::default();
        let mut skipped: Vec<usize> = Vec::new();
        let body_offset = match split_frontmatter(text) {
            Split::Found { yaml, body_offset } => {
                let start = yaml.as_ptr() as usize - text.as_ptr() as usize;
                let mut yaml_edits = self.markdown_edits(yaml, at, &mut counts, &mut skipped);
                yaml_edits.extend(self.frontmatter_tag_edits(yaml, &mut counts));
                shift(&mut yaml_edits, start);
                edits.extend(yaml_edits);
                skipped.iter_mut().for_each(|o| *o += start);
                body_offset
            }
            Split::None => 0,
            // A page whose frontmatter is broken is left alone; the linter reports it.
            Split::Unterminated => {
                return Rewritten {
                    text: text.to_string(),
                    ..Rewritten::default()
                };
            }
        };
        let mut skipped_body = Vec::new();
        let mut body_edits =
            self.markdown_edits(&text[body_offset..], at, &mut counts, &mut skipped_body);
        shift(&mut body_edits, body_offset);
        edits.extend(body_edits);
        skipped.extend(skipped_body.into_iter().map(|o| o + body_offset));

        let mut out = text.to_string();
        edits.sort_by_key(|(range, _)| std::cmp::Reverse(range.start));
        for (range, replacement) in edits {
            out.replace_range(range, &replacement);
        }
        Rewritten {
            text: out,
            links: counts.links,
            tags: counts.tags,
            skipped_lines: skipped
                .into_iter()
                .map(|offset| 1 + text[..offset].matches('\n').count())
                .collect(),
        }
    }

    fn markdown_edits(
        &self,
        md: &str,
        at: &Where,
        counts: &mut Counts,
        skipped: &mut Vec<usize>,
    ) -> Vec<Edit> {
        let mut edits = Vec::new();
        let mut run: Option<Range<usize>> = None;
        let mut in_code_block = false;
        let mut parser = Parser::new(md).into_offset_iter();
        for (event, range) in parser.by_ref() {
            if let Event::Text(t) = &event
                && !in_code_block
            {
                // Only text that is in the source as it is can be edited by position.
                if md[range.clone()] == **t {
                    run = match run {
                        Some(r) if r.end == range.start => Some(r.start..range.end),
                        Some(r) => {
                            self.tag_edits(md, r, counts, &mut edits);
                            Some(range)
                        }
                        None => Some(range),
                    };
                } else if let Some(r) = run.take() {
                    self.tag_edits(md, r, counts, &mut edits);
                }
                continue;
            }
            if let Some(r) = run.take() {
                self.tag_edits(md, r, counts, &mut edits);
            }
            match event {
                Event::Start(Tag::CodeBlock(_)) => in_code_block = true,
                Event::End(TagEnd::CodeBlock) => in_code_block = false,
                Event::Start(Tag::Link {
                    link_type,
                    dest_url,
                    ..
                })
                | Event::Start(Tag::Image {
                    link_type,
                    dest_url,
                    ..
                }) => {
                    // Reference-style links take their target from a definition, edited below.
                    if link_type != LinkType::Inline {
                        continue;
                    }
                    let Some(new_dest) = self.map_dest(&dest_url, at) else {
                        continue;
                    };
                    match dest_edit(&md[range.clone()], &dest_url, link_type) {
                        Some(local) => {
                            edits.push((
                                range.start + local.start..range.start + local.end,
                                new_dest,
                            ));
                            counts.links += 1;
                        }
                        None => skipped.push(range.start),
                    }
                }
                _ => {}
            }
        }
        if let Some(r) = run.take() {
            self.tag_edits(md, r, counts, &mut edits);
        }
        for (_, def) in parser.reference_definitions().iter() {
            let Some(new_dest) = self.map_dest(&def.dest, at) else {
                continue;
            };
            match definition_dest(&md[def.span.clone()], &def.dest) {
                Some(local) => {
                    edits.push((
                        def.span.start + local.start..def.span.start + local.end,
                        new_dest,
                    ));
                    counts.links += 1;
                }
                None => skipped.push(def.span.start),
            }
        }
        edits
    }

    fn tag_edits(&self, md: &str, run: Range<usize>, counts: &mut Counts, edits: &mut Vec<Edit>) {
        for (range, concept) in tag_spans(&md[run.clone()]) {
            if concept == self.old_concept {
                edits.push((
                    run.start + range.start..run.start + range.end,
                    self.new_concept.clone(),
                ));
                counts.tags += 1;
            }
        }
    }

    /// The `tags:` list of the frontmatter, in either YAML form, edited in place.
    fn frontmatter_tag_edits(&self, yaml: &str, counts: &mut Counts) -> Vec<Edit> {
        let mut edits = Vec::new();
        let mut offset = 0;
        let mut in_block = false;
        for line in yaml.split_inclusive('\n') {
            let content = line.trim_end_matches(['\n', '\r']);
            let line_start = offset;
            offset += line.len();
            if in_block {
                let trimmed = content.trim_start();
                if let Some(rest) = trimmed.strip_prefix('-')
                    && (rest.is_empty() || rest.starts_with(char::is_whitespace))
                {
                    let start = line_start + (content.len() - rest.len());
                    let value = rest.split(" #").next().unwrap_or(rest);
                    self.tag_item_edit(value, start, counts, &mut edits);
                    continue;
                }
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    continue;
                }
                in_block = false;
            }
            let Some(rest) = content.strip_prefix("tags:") else {
                continue;
            };
            let value = rest.trim_start();
            let value_start = line_start + "tags:".len() + (rest.len() - value.len());
            if let Some(inner) = value.strip_prefix('[') {
                let Some(close) = inner.find(']') else {
                    continue;
                };
                let mut item_start = value_start + 1;
                for item in inner[..close].split(',') {
                    self.tag_item_edit(item, item_start, counts, &mut edits);
                    item_start += item.len() + 1;
                }
            } else if value.is_empty() || value.starts_with('#') {
                in_block = true;
            }
        }
        edits
    }

    fn tag_item_edit(&self, raw: &str, start: usize, counts: &mut Counts, edits: &mut Vec<Edit>) {
        let lead = raw.len() - raw.trim_start().len();
        let value = raw.trim();
        let quote = ['"', '\'']
            .into_iter()
            .find(|q| value.len() >= 2 && value.starts_with(*q) && value.ends_with(*q));
        let inner = if quote.is_some() {
            &value[1..value.len() - 1]
        } else {
            value
        };
        if normalize_concept(inner) != self.old_concept {
            return;
        }
        let q = quote.map(String::from).unwrap_or_default();
        let hash = if inner.starts_with('#') { "#" } else { "" };
        edits.push((
            start + lead..start + lead + value.len(),
            format!("{q}{hash}{}{q}", self.new_concept),
        ));
        counts.tags += 1;
    }

    /// The link target to write instead of `dest`, or `None` when it stays as it is.
    ///
    /// A link changes when it names the moved page, or when it is a relative link written
    /// in the page that moves (it has to reach the same file from the new folder).
    fn map_dest(&self, dest: &str, at: &Where) -> Option<String> {
        if dest.is_empty()
            || dest.starts_with(['#', '?'])
            || has_scheme(dest)
            || dest.starts_with("//")
        {
            return None;
        }
        let split = dest.find(['#', '?']).unwrap_or(dest.len());
        let (path, suffix) = dest.split_at(split);
        let absolute = path.starts_with('/');
        let resolved = resolve(path, if absolute { "" } else { at.dir_before });
        let joined = resolved.join("/");
        let names_old = (joined.ends_with(".md") || joined.ends_with(".MD"))
            && normalize_concept(&joined[..joined.len() - 3]) == self.old_concept;
        let rebase = at.is_moved && !absolute;
        if !names_old && !rebase {
            return None;
        }
        let target: Vec<String> = if names_old {
            self.new_path.split('/').map(String::from).collect()
        } else {
            resolved
        };
        let written = if absolute {
            format!("/{}", target.join("/"))
        } else {
            relative(at.dir_after, &target, path.starts_with("./"))
        };
        let new_dest = format!("{written}{suffix}");
        (new_dest != dest).then_some(new_dest)
    }
}

#[derive(Default)]
struct Counts {
    links: usize,
    tags: usize,
}

fn shift(edits: &mut [Edit], by: usize) {
    for (range, _) in edits {
        range.start += by;
        range.end += by;
    }
}

/// The parts of the path a link points at, from the bundle root. Case is kept.
fn resolve(path: &str, dir: &str) -> Vec<String> {
    let mut parts: Vec<String> = dir
        .split('/')
        .filter(|p| !p.is_empty())
        .map(String::from)
        .collect();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            p => parts.push(p.to_string()),
        }
    }
    parts
}

/// A relative path from `dir` to `target`.
fn relative(dir: &str, target: &[String], dot: bool) -> String {
    let from: Vec<&str> = dir.split('/').filter(|p| !p.is_empty()).collect();
    let common = from
        .iter()
        .zip(target)
        .take_while(|(a, b)| **a == b.as_str())
        .count()
        .min(target.len().saturating_sub(1));
    let ups = from.len() - common;
    let mut parts: Vec<&str> = vec![".."; ups];
    parts.extend(target[common..].iter().map(String::as_str));
    let joined = parts.join("/");
    if ups == 0 && dot {
        format!("./{joined}")
    } else {
        joined
    }
}

/// Where the target of an inline link sits inside the link's source, or `None` when it cannot
/// be found as written (reference-style links, escapes).
fn dest_edit(raw: &str, dest: &str, link_type: LinkType) -> Option<Range<usize>> {
    if link_type != LinkType::Inline || dest.is_empty() {
        return None;
    }
    for opener in [format!("]({dest}"), format!("](<{dest}")] {
        if let Some(at) = raw.rfind(&opener) {
            let start = at + opener.len() - dest.len();
            let end = start + dest.len();
            let after = raw[end..].chars().next();
            if after.is_some_and(|c| c == ')' || c == '>' || c.is_whitespace()) {
                return Some(start..end);
            }
        }
    }
    None
}

/// Where the target of a link reference definition (`[label]: target "title"`) sits in its source.
fn definition_dest(raw: &str, dest: &str) -> Option<Range<usize>> {
    let after_label = raw.find("]:")? + 2;
    let rest = &raw[after_label..];
    let skipped = rest.len() - rest.trim_start().len();
    let mut start = after_label + skipped;
    if raw[start..].starts_with('<') {
        start += 1;
    }
    raw[start..]
        .starts_with(dest)
        .then_some(start..start + dest.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn moved(old: &str, new_path: &str) -> Rewrite {
        Rewrite::new(old, new_path)
    }

    fn elsewhere<'a>(dir: &'a str) -> Where<'a> {
        Where {
            dir_before: dir,
            dir_after: dir,
            is_moved: false,
        }
    }

    #[test]
    fn rewrites_tags_and_links_but_not_code_or_other_concepts() {
        let r = moved("ai/llm", "ai/models.md");
        let text = "---\ntype: note\n---\n\nSee #ai/llm and #ai/llm-x and [LLMs](/ai/llm.md#top) and [x](/ai/other.md).\n\n`#ai/llm` and `[c](/ai/llm.md)`\n\n```\n#ai/llm\n```\n";
        let out = r.page(text, &elsewhere(""));
        assert_eq!(
            out.text,
            "---\ntype: note\n---\n\nSee #ai/models and #ai/llm-x and [LLMs](/ai/models.md#top) and [x](/ai/other.md).\n\n`#ai/llm` and `[c](/ai/llm.md)`\n\n```\n#ai/llm\n```\n"
        );
        assert_eq!((out.links, out.tags), (1, 1));
    }

    #[test]
    fn keeps_relative_links_relative() {
        let r = moved("a/x", "b/y.md");
        let out = r.page(
            "[1](./x.md) [2](x.md) [3](../a/x.md) [4](/a/x.md)",
            &elsewhere("a"),
        );
        assert_eq!(
            out.text,
            "[1](../b/y.md) [2](../b/y.md) [3](../b/y.md) [4](/b/y.md)"
        );
        let out = r.page("[1](../a/x.md) [2](./x.md)", &elsewhere("b"));
        assert_eq!(out.text, "[1](y.md) [2](./x.md)");
    }

    #[test]
    fn rewrites_frontmatter_tags_in_both_forms_and_text() {
        let r = moved("old", "new.md");
        let flow = "---\ntype: x\ntags: [Old, \"old\", keep]\ndescription: \"see [o](/old.md) and #old\"\n---\n";
        let out = r.page(flow, &elsewhere(""));
        assert_eq!(
            out.text,
            "---\ntype: x\ntags: [new, \"new\", keep]\ndescription: \"see [o](/new.md) and #new\"\n---\n"
        );
        let block = "---\ntype: x\ntags:\n  - Old\n  - 'old'\n  - keep # not me\n---\n";
        let out = r.page(block, &elsewhere(""));
        assert_eq!(
            out.text,
            "---\ntype: x\ntags:\n  - new\n  - 'new'\n  - keep # not me\n---\n"
        );
    }

    #[test]
    fn the_moved_page_keeps_reaching_what_it_linked_to() {
        let r = moved("a/x", "b/c/x.md");
        let at = Where {
            dir_before: "a",
            dir_after: "b/c",
            is_moved: true,
        };
        let out = r.page(
            "[s](./y.md) [t](../z.md) [img](pics/p.png) [abs](/z.md) [me](x.md) [web](https://a.org/x.md) [top](#top)",
            &at,
        );
        assert_eq!(
            out.text,
            "[s](../../a/y.md) [t](../../z.md) [img](../../a/pics/p.png) [abs](/z.md) [me](x.md) [web](https://a.org/x.md) [top](#top)"
        );
    }

    #[test]
    fn rewrites_reference_style_links_at_their_definition() {
        let r = moved("old", "new.md");
        let out = r.page(
            "[ref][1] and [two]\n\n[1]: /old.md\n[two]: <old.md> \"T\"\n",
            &elsewhere(""),
        );
        assert_eq!(
            out.text,
            "[ref][1] and [two]\n\n[1]: /new.md\n[two]: <new.md> \"T\"\n"
        );
        assert_eq!(out.links, 2);
        assert!(out.skipped_lines.is_empty());
    }

    #[test]
    fn leaves_what_it_cannot_edit_alone_and_says_where() {
        let r = moved("old_x", "new.md");
        let text = "line\n[esc](/old\\_x.md) and [ok](/old_x.md)\n";
        let out = r.page(text, &elsewhere(""));
        assert_eq!(out.text, "line\n[esc](/old\\_x.md) and [ok](/new.md)\n");
        assert_eq!(out.skipped_lines, [2]);
    }

    #[test]
    fn nothing_to_do_is_no_change() {
        let r = moved("old", "new.md");
        let text = "---\ntype: x\n---\n\nplain #other [l](/other.md)\n";
        let out = r.page(text, &elsewhere(""));
        assert!(!out.changed());
        assert_eq!(out.text, text);
    }
}
