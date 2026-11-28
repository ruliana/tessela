//! A cheap look at a file's raw text that says whether a query could find anything in it,
//! so [`Bundle::load_for`](crate::Bundle::load_for) parses only the files that might matter.
//!
//! The check is conservative: it may admit a file the query then finds nothing in, and it never
//! rejects one the query would find something in. That is what keeps the answers identical to
//! a full load. Everything a query matches comes from the file's bytes, but not always as the
//! same letters, so each place where the text a query sees can differ from the raw bytes is
//! handled (or the file is admitted):
//!
//! - **Case.** A query lowercases both sides. The check folds the file the same way, one
//!   character at a time (`str::to_lowercase` looks at the neighbours only for a final sigma,
//!   so `ς` and `σ` are folded to one letter on both sides).
//! - **Line breaks and indentation.** A block's text drops the indentation of its continuation
//!   lines, and YAML folds line breaks into spaces. A search term is cut into runs of letters
//!   and digits ("fragments"); the file must hold every fragment, in any place and order, never
//!   a phrase.
//! - **YAML.** An escape (`"é"`) or a number written another way (`0x10` is `16`) makes a
//!   front matter value differ from its bytes. A backslash in the front matter admits the file;
//!   a fragment made only of digits and `e` is looked for in the front matter's numbers too,
//!   so it admits any file with front matter.
//! - **Entities.** `[t](&#102;oo.md)` links to `foo`. A file with something that looks like
//!   an entity is admitted by a reference query.
//! - **Relative links.** `[t](x.md)` from `a/b.md` names `a/x`, so a reference's words are
//!   also looked for in the file's path.
//! - **Page hits.** With concepts asked, a page that mentions one is a hit whose text is its
//!   title or, with none, its path; so the path is searched for the words too.

use memchr::memmem::Finder;

use crate::page::{Split, split_frontmatter};
use crate::query::Query;

pub(crate) struct Prefilter<'q> {
    query: &'q Query,
    /// What each term of `query.text` needs, as fragments (see the module docs).
    text: Vec<Fragment>,
    /// For each asked concept, the names that mean it (itself and its aliases), each as the
    /// fragments it needs. `None` until [`Prefilter::with_names`] is called.
    refs: Option<Vec<Vec<Vec<Fragment>>>>,
}

/// A run of letters and digits of a folded search term.
struct Fragment {
    finder: Finder<'static>,
    /// Digits and `e` only: the form a YAML number can be shown in without these letters
    /// being in its bytes (`0x10`, `1e3`).
    numeric: bool,
}

impl Fragment {
    fn all(text: &str) -> Vec<Fragment> {
        let folded = fold(text);
        let mut out: Vec<Fragment> = Vec::new();
        for piece in folded.split(|c: char| !c.is_alphanumeric()) {
            if piece.is_empty() || out.iter().any(|f| f.finder.needle() == piece.as_bytes()) {
                continue;
            }
            out.push(Fragment {
                finder: Finder::new(piece.as_bytes()).into_owned(),
                numeric: piece.chars().all(|c| c.is_ascii_digit() || c == 'e'),
            });
        }
        out
    }

    fn is_in(&self, haystack: &[u8]) -> bool {
        self.finder.find(haystack).is_some()
    }
}

impl<'q> Prefilter<'q> {
    /// The check for a query, or `None` when the query holds nothing a file's bytes could rule
    /// out (no words, no concepts, no page), or reads more than the pages it matches (`unlinked`
    /// reads every title).
    pub(crate) fn new(query: &'q Query) -> Option<Self> {
        if query.unlinked.is_some() {
            return None;
        }
        let text: Vec<Fragment> = query.text.iter().flat_map(|t| Fragment::all(t)).collect();
        if text.is_empty() && query.refs.is_empty() && query.page.is_none() {
            return None;
        }
        Some(Prefilter {
            query,
            text,
            refs: None,
        })
    }

    /// Whether the check needs the other names of the asked concepts, which only the front
    /// matter of the pages that have `aliases` can tell (see [`may_define_aliases`]).
    pub(crate) fn needs_aliases(&self) -> bool {
        !self.query.refs.is_empty()
    }

    /// Gives the check the names that mean each asked concept: what
    /// [`Bundle::names_for`](crate::Bundle::names_for) answers for each of `query.refs`.
    pub(crate) fn with_names(&mut self, names: &[Vec<String>]) {
        self.refs = Some(
            names
                .iter()
                .map(|alternatives| alternatives.iter().map(|n| Fragment::all(n)).collect())
                .collect(),
        );
    }

    /// Whether a page at `path` can be what the query asks for, from its path alone.
    pub(crate) fn path_ok(&self, path: &str) -> bool {
        let id = path.strip_suffix(".md").unwrap_or(path);
        self.query.page_id_matches(id)
    }

    /// Whether the file might hold something the query matches.
    pub(crate) fn admits(&self, path: &str, text: &str) -> bool {
        if !self.path_ok(path) {
            return false;
        }
        let asks_refs = self.refs.as_ref().is_some_and(|r| !r.is_empty());
        if self.text.is_empty() && !asks_refs {
            return true;
        }
        let front = Front::of(text);
        let folded = fold(text);
        let content = folded.as_bytes();
        let path = fold(path);
        self.text_ok(path.as_bytes(), content, &front)
            && self.refs_ok(path.as_bytes(), text, content, &front)
    }

    fn text_ok(&self, path: &[u8], content: &[u8], front: &Front) -> bool {
        // Page hits exist when concepts are asked or `meta` is on. A page hit's text is its
        // front matter values with `meta`, else its title, else its path.
        let meta = self.query.meta;
        let page_hits = meta || !self.query.refs.is_empty();
        if page_hits && front.escapes {
            return true;
        }
        let by_path = page_hits && !meta;
        self.text.iter().all(|f| {
            f.is_in(content) || (by_path && f.is_in(path)) || (meta && f.numeric && front.present)
        })
    }

    fn refs_ok(&self, path: &[u8], raw: &str, content: &[u8], front: &Front) -> bool {
        let Some(asked) = &self.refs else {
            return true;
        };
        if asked.is_empty() || front.escapes || has_entity(raw.as_bytes()) {
            return true;
        }
        // A name is there when all its fragments are, in the file or its path.
        let named = |names: &Vec<Vec<Fragment>>| {
            names
                .iter()
                .any(|n| n.iter().all(|f| f.is_in(content) || f.is_in(path)))
        };
        if self.query.any {
            asked.iter().any(named)
        } else {
            asked.iter().all(named)
        }
    }
}

/// Whether a file's front matter could define aliases, whatever the key is written like: it
/// says `aliases` in its bytes, or has an escape that could spell it.
pub(crate) fn may_define_aliases(text: &str) -> bool {
    Finder::new("aliases").find(text.as_bytes()).is_some() || Front::of(text).escapes
}

/// What the front matter of a file does to the text its values give.
struct Front {
    /// The file has front matter.
    present: bool,
    /// A backslash: a YAML escape can write any character.
    escapes: bool,
}

impl Front {
    fn of(text: &str) -> Front {
        match split_frontmatter(text) {
            Split::Found { yaml, .. } => Front {
                present: true,
                escapes: memchr::memchr(b'\\', yaml.as_bytes()).is_some(),
            },
            _ => Front {
                present: false,
                escapes: false,
            },
        }
    }
}

/// Lowercases like a query does, with no look at the neighbours: final `ς` and `σ` are one.
fn fold(text: &str) -> String {
    if text.is_ascii() {
        return text.to_ascii_lowercase();
    }
    text.chars()
        .flat_map(char::to_lowercase)
        .map(|c| if c == 'ς' { 'σ' } else { c })
        .collect()
}

/// Whether the bytes have something that reads as a character reference: `&#102;` or `&amp;`.
/// A link target can be written with one, so its letters are not in the file.
fn has_entity(bytes: &[u8]) -> bool {
    memchr::memchr_iter(b'&', bytes).any(|at| {
        let rest = &bytes[at + 1..];
        if rest.first() == Some(&b'#') {
            return true;
        }
        let name = rest
            .iter()
            .take_while(|b| b.is_ascii_alphanumeric())
            .count();
        name > 0 && rest.get(name) == Some(&b';')
    })
}
