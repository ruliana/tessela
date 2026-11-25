//! `tessela update`: checks GitHub releases and replaces the installed binary with the
//! tarball for this platform. A small local server plays GitHub.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{Arc, Mutex};

use flate2::{Compression, write::GzEncoder};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const TARGETS: [&str; 3] = [
    "x86_64-unknown-linux-musl",
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
];

/// The target this test is running on, written independently of the tool.
fn host() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => TARGETS[0],
        ("macos", "aarch64") => TARGETS[1],
        ("macos", "x86_64") => TARGETS[2],
        other => panic!("no release for {other:?}"),
    }
}

fn tarball(tag: &str, target: &str) -> Vec<u8> {
    let dir = format!("tessela-{tag}-{target}");
    let mut tar = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::default()));
    for (name, body) in [
        ("tessela", format!("new tessela for {target}")),
        ("README.md", "readme".into()),
    ] {
        let mut header = tar::Header::new_gnu();
        header.set_size(body.len() as u64);
        header.set_mode(0o755);
        tar.append_data(&mut header, format!("{dir}/{name}"), body.as_bytes())
            .unwrap();
    }
    tar.into_inner().unwrap().finish().unwrap()
}

/// GitHub's `releases/latest` plus the downloads of one release, on a local port.
struct Releases {
    api: String,
    downloads: Arc<Mutex<Vec<String>>>,
}

fn serve(tag: &str, corrupt_checksum: bool) -> Releases {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let mut routes: HashMap<String, Vec<u8>> = HashMap::new();
    let mut assets = vec![];
    for target in TARGETS {
        let name = format!("tessela-{tag}-{target}.tar.gz");
        let bytes = tarball(tag, target);
        let mut sum = format!("{:x}", Sha256::digest(&bytes));
        if corrupt_checksum {
            sum = "0".repeat(64);
        }
        routes.insert(
            format!("/dl/{name}.sha256"),
            format!("{sum}  {name}\n").into(),
        );
        routes.insert(format!("/dl/{name}"), bytes);
        for file in [name.clone(), format!("{name}.sha256")] {
            assets
                .push(json!({ "name": file, "browser_download_url": format!("{base}/dl/{file}") }));
        }
    }
    routes.insert(
        "/releases/latest".into(),
        json!({ "tag_name": tag, "assets": assets })
            .to_string()
            .into(),
    );
    let downloads = Arc::new(Mutex::new(vec![]));
    let log = downloads.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap();
            let request = String::from_utf8_lossy(&buf[..n]);
            let path = request.split_whitespace().nth(1).unwrap_or("").to_string();
            if path.starts_with("/dl/") {
                log.lock().unwrap().push(path.clone());
            }
            let (status, body) = match routes.get(&path) {
                Some(body) => ("200 OK", body.as_slice()),
                None => ("404 Not Found", &b"not found"[..]),
            };
            let head = format!(
                "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(body);
        }
    });
    Releases {
        api: base,
        downloads,
    }
}

/// A copy of the tool in its own folder, the way an installed one sits on a machine.
fn installed(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tessela-update-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let bin = dir.join("tessela");
    std::fs::copy(env!("CARGO_BIN_EXE_tessela"), &bin).unwrap();
    bin
}

fn run(bin: &Path, releases: &Releases, args: &[&str]) -> Output {
    Command::new(bin)
        .arg("update")
        .args(args)
        .args(["--json", "--api", "2"])
        .env("TESSELA_UPDATE_API", &releases.api)
        .output()
        .unwrap()
}

fn json(out: &Output) -> Value {
    serde_json::from_slice(&out.stdout)
        .unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&out.stdout)))
}

#[test]
fn check_says_what_is_new_and_changes_nothing() {
    let releases = serve("v99.0.0", false);
    let bin = installed("check");
    let before = std::fs::read(&bin).unwrap();

    let out = run(&bin, &releases, &["--check"]);
    assert!(out.status.success());
    let answer = json(&out);
    assert_eq!(answer["api"], 2);
    assert_eq!(answer["ok"], true);
    assert_eq!(answer["current"], env!("CARGO_PKG_VERSION"));
    assert_eq!(answer["latest"], "99.0.0");
    assert_eq!(answer["update_available"], true);
    assert_eq!(answer["updated"], false);
    assert_eq!(std::fs::read(&bin).unwrap(), before);
    assert!(releases.downloads.lock().unwrap().is_empty());
}

#[test]
fn update_replaces_the_binary_with_the_one_for_this_platform() {
    let releases = serve("v99.0.0", false);
    let bin = installed("replace");

    let out = run(&bin, &releases, &[]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let answer = json(&out);
    assert_eq!(
        (answer["latest"].clone(), answer["updated"].clone()),
        ("99.0.0".into(), true.into())
    );

    assert_eq!(
        std::fs::read_to_string(&bin).unwrap(),
        format!("new tessela for {}", host())
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&bin).unwrap().permissions().mode() & 0o111,
            0o111
        );
    }
    let left: Vec<_> = std::fs::read_dir(bin.parent().unwrap()).unwrap().collect();
    assert_eq!(left.len(), 1, "no temporary files are left: {left:?}");
}

#[test]
fn nothing_is_downloaded_when_the_tool_is_up_to_date() {
    let releases = serve(&format!("v{}", env!("CARGO_PKG_VERSION")), false);
    let bin = installed("current");
    let before = std::fs::read(&bin).unwrap();

    let answer = json(&run(&bin, &releases, &[]));
    assert_eq!(answer["update_available"], false);
    assert_eq!(answer["updated"], false);
    assert_eq!(std::fs::read(&bin).unwrap(), before);
    assert!(releases.downloads.lock().unwrap().is_empty());
}

#[test]
fn a_download_that_does_not_match_its_checksum_is_not_installed() {
    let releases = serve("v99.0.0", true);
    let bin = installed("checksum");
    let before = std::fs::read(&bin).unwrap();

    let out = run(&bin, &releases, &[]);
    assert_eq!(out.status.code(), Some(2));
    let answer = json(&out);
    assert_eq!(answer["ok"], false);
    assert!(
        answer["error"]["message"]
            .as_str()
            .unwrap()
            .contains("checksum")
    );
    assert_eq!(std::fs::read(&bin).unwrap(), before);
}
