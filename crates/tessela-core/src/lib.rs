//! Tessela core: reads an OKF bundle, derives blocks and references from it, and lints it.
//!
//! The conventions are in `docs/conventions.md`.

pub mod blocks;
pub mod bundle;
pub mod edit;
pub mod fence;
pub mod index;
pub mod lint;
pub mod logseq;
pub mod page;
pub mod query;
pub mod refs;
pub mod rewrite;
pub mod vocab;

pub use blocks::{Block, Heading, TaskState};
pub use bundle::Bundle;
pub use index::{Listing, WriteReport};
pub use lint::{Diagnostic, Linter, Rule, Severity};
pub use page::Page;
pub use query::{Hit, HitKind, Query, TaskFilter};
pub use vocab::{VocabEntry, vocabulary};
