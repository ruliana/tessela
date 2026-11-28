//! A cache of parsed pages in `<bundle>/.tessela/cache/`, so a call that reads the bundle
//! looks at each file's size and modification time and parses only the ones that changed.
//!
//! One file per page, named after a hash of the page's path. A file holds the page as the
//! parser left it, in a compact binary form, and the size and modification time of the
//! Markdown file it was made from. A cache entry is used only when all of these hold:
//!
//! - it was written by a build with the same parser (see `build.rs`: the fingerprint covers the
//!   sources and the lock file, so nobody bumps a version by hand);
//! - its checksum is right, so a damaged or half-written file is a miss, never a wrong answer;
//! - it is for this path, and the Markdown file has the same size and modification time.
//!
//! Anything else is a miss, and a miss is the same as having no cache: the page is parsed.
//! Nothing here returns an error. A folder that cannot be written to just stays slow.
//!
//! Writes are atomic: a temporary file in the same folder, then a rename, so two calls at once
//! (an editor save and an agent's query) never see half a file. Both write the same bytes.
//!
//! A file changed in the last [`SETTLE`] seconds is not cached: the system's clock is coarse,
//! so a second edit in the same tick would keep the old time and, with luck, the old size.
//! After that window a change always shows in the modification time.
//!
//! Set `TESSELA_NO_CACHE` to read and write nothing, for tests and debugging. Deleting
//! `.tessela/` at any time is fine.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_yaml_ng::{Mapping, Number, Value};

use crate::blocks::{Block, Heading};
use crate::page::Page;

/// A file changed less than this long ago is not cached (see the module docs).
const SETTLE: Duration = Duration::from_secs(2);

/// The start of every cache file.
const MAGIC: &[u8; 4] = b"TSLc";
/// Magic, fingerprint, checksum.
const HEADER: usize = 4 + 8 + 8;
/// Identifies the build that wrote an entry; see `build.rs`.
const FINGERPRINT: &str = env!("TESSELA_CORE_FINGERPRINT");

/// What a page's cache entry is checked against: the Markdown file as the system describes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Stamp {
    size: u64,
    secs: u64,
    nanos: u32,
}

impl Stamp {
    pub fn of(meta: &std::fs::Metadata) -> Option<Stamp> {
        let since = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
        Some(Stamp {
            size: meta.len(),
            secs: since.as_secs(),
            nanos: since.subsec_nanos(),
        })
    }

    /// The modification time in milliseconds since the Unix epoch, as `Page::modified` has it.
    pub fn millis(&self) -> u64 {
        self.secs * 1_000 + u64::from(self.nanos) / 1_000_000
    }

    /// Whether the file has stayed as it is long enough to trust this stamp (see the module docs).
    pub fn settled(&self, now: Duration) -> bool {
        Duration::new(self.secs, self.nanos) + SETTLE <= now
    }
}

pub(crate) struct Cache {
    dir: PathBuf,
    /// The time the load started, to tell a file that is still changing from one that is not.
    now: Duration,
    written: AtomicUsize,
}

impl Cache {
    /// The cache of the bundle at `root`, or `None` when `TESSELA_NO_CACHE` asks for none.
    /// Nothing is created yet: the folder appears with the first entry written.
    pub fn open(root: &Path) -> Option<Cache> {
        if std::env::var_os("TESSELA_NO_CACHE").is_some_and(|v| !v.is_empty() && v != "0") {
            return None;
        }
        Some(Cache {
            dir: root.join(".tessela").join("cache"),
            now: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default(),
            written: AtomicUsize::new(0),
        })
    }

    /// The page for `rel` as it was parsed from a file that looked like `stamp`, if the cache
    /// has it. `modified` is left for the caller to set, like the parser leaves it.
    pub fn read(&self, rel: &str, stamp: &Stamp) -> Option<Page> {
        let bytes = std::fs::read(self.entry(rel)).ok()?;
        let payload = unframe(MAGIC, &bytes)?;
        let (head, rest) = postcard::take_from_bytes::<Head>(payload).ok()?;
        if head.rel != rel || head.stamp() != *stamp {
            return None;
        }
        let body: Body = postcard::from_bytes(rest).ok()?;
        body.into_page(rel)
    }

    /// Keeps `page`, parsed from a file that looked like `stamp`. Does nothing for a file that
    /// changed a moment ago, and does not say when it fails.
    pub fn write(&self, rel: &str, stamp: &Stamp, page: &Page) {
        if !stamp.settled(self.now) {
            return;
        }
        let head = Head {
            rel,
            size: stamp.size,
            secs: stamp.secs,
            nanos: stamp.nanos,
        };
        let body = BodyRef {
            has_frontmatter: page.has_frontmatter,
            frontmatter: page
                .frontmatter
                .iter()
                .map(|(k, v)| (Yaml::of(k), Yaml::of(v)))
                .collect(),
            frontmatter_error: page.frontmatter_error.as_deref(),
            refs: &page.refs,
            blocks: &page.blocks,
            headings: &page.headings,
        };
        let Ok(payload) =
            postcard::to_extend(&body, postcard::to_stdvec(&head).unwrap_or_default())
        else {
            return;
        };
        if self.store_as(&entry_name(rel), &frame(MAGIC, &payload)) {
            self.written.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// The time the load started, for [`Stamp::settled`].
    pub fn now(&self) -> Duration {
        self.now
    }

    /// A file of this folder that is not a page's entry, such as the summary: its bytes, whole
    /// or `None`. `name` must not end in `.bin`, which `sweep` keeps for entries only.
    pub fn get_named(&self, name: &str) -> Option<Vec<u8>> {
        std::fs::read(self.dir.join(name)).ok()
    }

    /// Writes a file of this folder that is not a page's entry, atomically. Whether it worked.
    pub fn put_named(&self, name: &str, bytes: &[u8]) -> bool {
        self.store_as(name, bytes)
    }

    /// How many entries this call wrote.
    pub fn written(&self) -> usize {
        self.written.load(Ordering::Relaxed)
    }

    /// Removes the entries of pages that are gone (deleted, renamed, moved) and temporary files
    /// that a call that died left behind. `live` are the paths of the pages in the bundle now.
    /// A call that wrote nothing has no reason to look; the folder is only as big as the bundle
    /// was at the last change.
    pub fn sweep<'a>(&self, live: impl Iterator<Item = &'a str>) {
        let keep: std::collections::HashSet<String> = live.map(entry_name).collect();
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let stale = if name.ends_with(".tmp") {
                // Another call may be writing it right now: only an old one is garbage.
                entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|age| age > Duration::from_secs(60))
            } else {
                name.ends_with(".bin") && !keep.contains(&name)
            };
            if stale {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    fn entry(&self, rel: &str) -> PathBuf {
        self.dir.join(entry_name(rel))
    }

    /// Writes `bytes` as the file `name` of this folder, atomically. Whether it worked.
    fn store_as(&self, name: &str, bytes: &[u8]) -> bool {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let target = self.dir.join(name);
        let tmp = self.dir.join(format!(
            "{}.{}.{}.tmp",
            name.rsplit_once('.').map_or(name, |(stem, _)| stem),
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let mut result = std::fs::write(&tmp, bytes);
        if result.is_err() {
            // First write into this bundle, or the folder was deleted under us. Another thread
            // may have made the folder since this write failed, so try again either way.
            if self.make_dir().is_ok() {
                result = std::fs::write(&tmp, bytes);
            }
        }
        if result.is_ok() && std::fs::rename(&tmp, &target).is_ok() {
            return true;
        }
        let _ = std::fs::remove_file(&tmp);
        false
    }

    /// Creates the cache folder, with a `.gitignore` inside that ignores everything in it,
    /// so a bundle under git needs no entry in its own `.gitignore` for it.
    fn make_dir(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let ignore = self.dir.join(".gitignore");
        if !ignore.exists() {
            std::fs::write(ignore, "*\n")?;
        }
        Ok(())
    }
}

/// The file name of a page's entry: a hash of its path, so any path fits in a file name.
/// Two paths that share a name just take turns; the path inside the entry is checked.
fn entry_name(rel: &str) -> String {
    let hash = blake3::hash(rel.as_bytes());
    let mut name = String::with_capacity(20);
    for b in &hash.as_bytes()[..8] {
        name.push_str(&format!("{b:02x}"));
    }
    name.push_str(".bin");
    name
}

fn fingerprint() -> u64 {
    u64::from_str_radix(FINGERPRINT, 16).unwrap_or(0)
}

fn checksum(payload: &[u8]) -> u64 {
    let hash = blake3::hash(payload);
    u64::from_le_bytes(
        hash.as_bytes()[..8]
            .try_into()
            .expect("a hash has 32 bytes"),
    )
}

/// A cache file: the magic that says what it holds, the build's fingerprint, the payload's
/// checksum, and the payload.
pub(crate) fn frame(magic: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut file = Vec::with_capacity(HEADER + payload.len());
    file.extend_from_slice(magic);
    file.extend_from_slice(&fingerprint().to_le_bytes());
    file.extend_from_slice(&checksum(payload).to_le_bytes());
    file.extend_from_slice(payload);
    file
}

/// The payload of a cache file, when it is a whole one written by this build.
pub(crate) fn unframe<'a>(magic: &[u8; 4], bytes: &'a [u8]) -> Option<&'a [u8]> {
    if bytes.len() < HEADER || &bytes[..4] != magic {
        return None;
    }
    let fp = u64::from_le_bytes(bytes[4..12].try_into().ok()?);
    let sum = u64::from_le_bytes(bytes[12..20].try_into().ok()?);
    let payload = &bytes[HEADER..];
    (fp == fingerprint() && sum == checksum(payload)).then_some(payload)
}

/// Which file an entry is for, and what it looked like.
#[derive(Serialize, Deserialize)]
struct Head<'a> {
    #[serde(borrow)]
    rel: &'a str,
    size: u64,
    secs: u64,
    nanos: u32,
}

impl Head<'_> {
    fn stamp(&self) -> Stamp {
        Stamp {
            size: self.size,
            secs: self.secs,
            nanos: self.nanos,
        }
    }
}

/// A page without its path (the entry's name and head say which it is) and its modification
/// time (the stamp). The two structs have the same fields in the same order, so what one
/// writes the other reads; `BodyRef` borrows so a write copies nothing but the frontmatter.
#[derive(Serialize)]
struct BodyRef<'a> {
    has_frontmatter: bool,
    frontmatter: Vec<(Yaml, Yaml)>,
    frontmatter_error: Option<&'a str>,
    refs: &'a [String],
    blocks: &'a [Block],
    headings: &'a [Heading],
}

#[derive(Deserialize)]
struct Body {
    has_frontmatter: bool,
    frontmatter: Vec<(Yaml, Yaml)>,
    frontmatter_error: Option<String>,
    refs: Vec<String>,
    blocks: Vec<Block>,
    headings: Vec<Heading>,
}

impl Body {
    fn into_page(self, rel: &str) -> Option<Page> {
        let mut frontmatter = Mapping::with_capacity(self.frontmatter.len());
        for (k, v) in self.frontmatter {
            frontmatter.insert(k.into_value()?, v.into_value()?);
        }
        Some(Page {
            id: rel.strip_suffix(".md").unwrap_or(rel).to_string(),
            path: rel.to_string(),
            has_frontmatter: self.has_frontmatter,
            frontmatter,
            frontmatter_error: self.frontmatter_error,
            refs: self.refs,
            blocks: self.blocks,
            headings: self.headings,
            modified: None,
        })
    }
}

/// A YAML value in a form a compact binary format can write and read back. `serde_yaml_ng`'s
/// own `Value` can only be read by a format that describes its own data.
#[derive(Serialize, Deserialize)]
enum Yaml {
    Null,
    Bool(bool),
    Int(i64),
    Uint(u64),
    Float(f64),
    Str(String),
    Seq(Vec<Yaml>),
    Map(Vec<(Yaml, Yaml)>),
    Tagged(String, Box<Yaml>),
}

impl Yaml {
    fn of(value: &Value) -> Yaml {
        match value {
            Value::Null => Yaml::Null,
            Value::Bool(b) => Yaml::Bool(*b),
            Value::Number(n) => match (n.as_i64(), n.as_u64()) {
                (Some(i), _) => Yaml::Int(i),
                (None, Some(u)) => Yaml::Uint(u),
                (None, None) => Yaml::Float(n.as_f64().unwrap_or(f64::NAN)),
            },
            Value::String(s) => Yaml::Str(s.clone()),
            Value::Sequence(items) => Yaml::Seq(items.iter().map(Yaml::of).collect()),
            Value::Mapping(map) => Yaml::Map(
                map.iter()
                    .map(|(k, v)| (Yaml::of(k), Yaml::of(v)))
                    .collect(),
            ),
            Value::Tagged(t) => Yaml::Tagged(t.tag.to_string(), Box::new(Yaml::of(&t.value))),
        }
    }

    /// `None` for what no YAML reader could have made (an entry that is not ours).
    fn into_value(self) -> Option<Value> {
        Some(match self {
            Yaml::Null => Value::Null,
            Yaml::Bool(b) => Value::Bool(b),
            Yaml::Int(i) => Value::Number(Number::from(i)),
            Yaml::Uint(u) => Value::Number(Number::from(u)),
            Yaml::Float(f) => Value::Number(Number::from(f)),
            Yaml::Str(s) => Value::String(s),
            Yaml::Seq(items) => Value::Sequence(
                items
                    .into_iter()
                    .map(Yaml::into_value)
                    .collect::<Option<_>>()?,
            ),
            Yaml::Map(pairs) => {
                let mut map = Mapping::with_capacity(pairs.len());
                for (k, v) in pairs {
                    map.insert(k.into_value()?, v.into_value()?);
                }
                Value::Mapping(map)
            }
            Yaml::Tagged(tag, value) => {
                if tag.is_empty() {
                    return None;
                }
                Value::Tagged(Box::new(serde_yaml_ng::value::TaggedValue {
                    tag: serde_yaml_ng::value::Tag::new(tag),
                    value: value.into_value()?,
                }))
            }
        })
    }
}
