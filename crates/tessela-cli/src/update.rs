//! `tessela update`: looks for a newer release on GitHub and replaces this binary with the
//! tarball built for this platform, after checking it against the published checksum.

use std::io::Read;
use std::path::Path;

use serde::Deserialize;
use sha2::{Digest, Sha256};
use tessela_core::edit::{EditError, ErrorCode};

use crate::answers::Update;

/// Where releases are asked for; `TESSELA_UPDATE_API` replaces it (the tests do).
const RELEASES_API: &str = "https://api.github.com/repos/ruliana/tessela";

/// The largest download accepted, so a wrong address cannot fill the disk.
const MAX_DOWNLOAD: u64 = 200 * 1024 * 1024;

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

fn io(message: impl Into<String>) -> EditError {
    EditError::new(ErrorCode::Io, message)
}

/// The target triple the release workflow builds for the machine this runs on.
fn target() -> Result<&'static str, EditError> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Ok("x86_64-unknown-linux-musl"),
        ("macos", "aarch64") => Ok("aarch64-apple-darwin"),
        ("macos", "x86_64") => Ok("x86_64-apple-darwin"),
        (os, arch) => Err(EditError::new(
            ErrorCode::NotFound,
            format!("there is no release for {os} on {arch}"),
        )),
    }
}

/// `1.2.3` or `v1.2.3` as numbers, so that 0.10.0 is newer than 0.9.0.
fn version(text: &str) -> Option<(u64, u64, u64)> {
    let mut parts = text.trim_start_matches('v').split('.');
    let mut next = || parts.next()?.parse().ok();
    let v = (next()?, next()?, next()?);
    parts.next().is_none().then_some(v)
}

fn get(url: &str) -> Result<ureq::Body, EditError> {
    let agent_name = concat!("tessela/", env!("CARGO_PKG_VERSION"));
    // The system's certificates, so a company proxy that re-signs traffic works.
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                .build(),
        )
        .build()
        .into();
    agent
        .get(url)
        .header("User-Agent", agent_name)
        .header("Accept", "application/vnd.github+json")
        .call()
        .map(|r| r.into_body())
        .map_err(|e| io(format!("cannot reach {url}: {e}")))
}

fn download(url: &str) -> Result<Vec<u8>, EditError> {
    let mut bytes = Vec::new();
    get(url)?
        .into_reader()
        .take(MAX_DOWNLOAD)
        .read_to_end(&mut bytes)
        .map_err(|e| io(format!("download of {url} failed: {e}")))?;
    Ok(bytes)
}

/// The `tessela` file inside the release tarball, whatever the folder around it is called.
fn binary_in(tarball: &[u8]) -> Result<Vec<u8>, EditError> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(tarball));
    let entries = archive
        .entries()
        .map_err(|e| io(format!("the download is not a tarball: {e}")))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| io(format!("the download is not a tarball: {e}")))?;
        let is_binary = entry
            .path()
            .is_ok_and(|p| p.file_name().is_some_and(|n| n == "tessela"));
        if is_binary {
            let mut bytes = Vec::new();
            entry
                .read_to_end(&mut bytes)
                .map_err(|e| io(format!("the download is damaged: {e}")))?;
            return Ok(bytes);
        }
    }
    Err(io("the release tarball has no tessela binary"))
}

/// Writes the new binary next to the old one and renames it over, so a failure half way
/// leaves the old binary alone. A running program can be replaced this way on Linux and macOS.
fn replace(exe: &Path, bytes: &[u8]) -> Result<(), EditError> {
    let temp = exe.with_extension("new");
    let result = (|| {
        std::fs::write(&temp, bytes)?;
        std::fs::set_permissions(&temp, std::fs::metadata(exe)?.permissions())?;
        std::fs::rename(&temp, exe)
    })();
    result.map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        io(format!(
            "cannot replace {}: {e} (a tool installed by a package manager, or inside an app, \
             has to be updated the way it was installed)",
            exe.display()
        ))
    })
}

pub fn run(check_only: bool) -> Result<Update, EditError> {
    let api = std::env::var("TESSELA_UPDATE_API").unwrap_or_else(|_| RELEASES_API.into());
    let release: Release = get(&format!("{api}/releases/latest"))?
        .read_json()
        .map_err(|e| io(format!("GitHub did not answer with a release: {e}")))?;
    let current = env!("CARGO_PKG_VERSION");
    let latest = release.tag_name.trim_start_matches('v').to_string();
    let newer = match (version(&latest), version(current)) {
        (Some(l), Some(c)) => l > c,
        _ => {
            return Err(io(format!(
                "cannot compare version {latest} with {current}"
            )));
        }
    };
    let mut answer = Update {
        current: current.into(),
        latest: latest.clone(),
        update_available: newer,
        updated: false,
    };
    if !newer || check_only {
        return Ok(answer);
    }

    let name = format!("tessela-{}-{}.tar.gz", release.tag_name, target()?);
    let url_of = |file: &str| {
        release
            .assets
            .iter()
            .find(|a| a.name == file)
            .map(|a| a.browser_download_url.clone())
            .ok_or_else(|| {
                EditError::new(
                    ErrorCode::NotFound,
                    format!("release {latest} has no {file}"),
                )
            })
    };
    let tarball = download(&url_of(&name)?)?;
    let published = String::from_utf8_lossy(&download(&url_of(&format!("{name}.sha256"))?)?)
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    let actual = format!("{:x}", Sha256::digest(&tarball));
    if actual != published {
        return Err(io(format!(
            "the checksum of {name} is {actual}, not the published {published}; nothing was installed"
        )));
    }
    let exe = std::env::current_exe().map_err(|e| io(format!("cannot find this program: {e}")))?;
    replace(&exe, &binary_in(&tarball)?)?;
    answer.updated = true;
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::version;

    #[test]
    fn versions_compare_as_numbers() {
        assert!(version("0.10.0") > version("0.9.3"));
        assert_eq!(version("v1.2.3"), Some((1, 2, 3)));
        assert_eq!(version("1.2.3-rc1"), None);
    }
}
