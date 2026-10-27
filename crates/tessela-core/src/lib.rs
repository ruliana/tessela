//! Tessela core: reads an OKF bundle, derives blocks and references from it, and lints it.
//!
//! The conventions are in `docs/conventions.md`.

pub mod blocks;
pub mod bundle;
pub mod lint;
pub mod logseq;
pub mod page;
pub mod query;
pub mod refs;
pub mod vocab;

pub use blocks::{Block, Heading};
pub use bundle::Bundle;
pub use lint::{Diagnostic, Linter, Rule, Severity};
pub use page::Page;
pub use query::{Hit, HitKind, Query};
pub use vocab::{VocabEntry, vocabulary};
