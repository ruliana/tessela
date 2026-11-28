//! Gives the parse cache (`src/cache.rs`) a fingerprint of the code that produces what it
//! stores: every source file of this crate and the lock file. A change to the parser, to the
//! shape of a page, or to a dependency changes the fingerprint, so a cache written by another
//! build is rebuilt instead of read. Nobody has to remember to bump a version.

use std::path::Path;

fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets the manifest dir");
    let manifest = Path::new(&manifest);
    let mut hash = Fnv::default();
    hash.bytes(
        std::env::var("CARGO_PKG_VERSION")
            .unwrap_or_default()
            .as_bytes(),
    );
    let mut files = Vec::new();
    collect(&manifest.join("src"), &mut files);
    files.sort();
    for file in &files {
        hash.bytes(file.to_string_lossy().as_bytes());
        hash.bytes(&std::fs::read(file).unwrap_or_default());
    }
    // The workspace lock file pins the Markdown and YAML parsers. A crate built outside the
    // workspace has none, and then only the sources count.
    let lock = manifest.join("../../Cargo.lock");
    if let Ok(bytes) = std::fs::read(&lock) {
        hash.bytes(&bytes);
        println!("cargo:rerun-if-changed={}", lock.display());
    }
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rustc-env=TESSELA_CORE_FINGERPRINT={:016x}", hash.0);
}

fn collect(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, out);
        } else {
            out.push(path);
        }
    }
}

/// FNV-1a, 64 bits: no dependency, and the same on every machine.
struct Fnv(u64);

impl Default for Fnv {
    fn default() -> Fnv {
        Fnv(0xcbf2_9ce4_8422_2325)
    }
}

impl Fnv {
    fn bytes(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 = (self.0 ^ u64::from(*b)).wrapping_mul(0x0000_0100_0000_01b3);
        }
        // Separates what comes next, so moving a byte between files changes the hash.
        self.0 = (self.0 ^ 0xff).wrapping_mul(0x0000_0100_0000_01b3);
    }
}
