//! Tessela core: reads an OKF bundle, derives blocks and references from it, and lints it.
//!
//! The conventions are in `docs/conventions.md`.

pub mod blocks;
pub mod bundle;
mod cache;
pub mod changes;
mod corpus;
pub mod edit;
pub mod fence;
pub mod index;
pub mod lint;
pub mod logseq;
pub mod page;
mod prefilter;
pub mod query;
pub mod refs;
pub mod related;
pub mod rewrite;
mod summary;
pub mod surface;
pub mod unlinked;
pub mod vocab;

pub use blocks::{Block, BlockKind, Heading, Structure, TaskState};
pub use bundle::Bundle;
pub use index::{Listing, WriteReport};
pub use lint::{Diagnostic, Linter, Rule, Severity};
pub use page::Page;
pub use query::{Hit, HitKind, Query, TaskFilter};
pub use unlinked::Mention;
pub use vocab::{VocabEntry, vocabulary};
