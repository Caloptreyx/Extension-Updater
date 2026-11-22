//! What the updater downloads and how it is checked. Archives come only from
//! `https://github.com/Caloptreyx/<repo>/releases/download/...`, redirects may only lead to
//! GitHub's asset hosts, and every archive must match a SHA-256 published with the release:
//! GitHub's own asset digest, the `<archive>.sha256` asset the release workflow uploads, or both
//! (they must agree). A release without either is refused.

use crate::catalog::ORG;
use reqwest::Url;

pub type Sha256 = [u8; 32];

/// Where github.com sends release downloads.
pub const ASSET_HOSTS: [&str; 2] = [
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
];

#[derive(Debug, PartialEq, Eq)]
pub enum TrustError {
    /// Neither a GitHub digest nor a `.sha256` asset.
    Missing,
    /// A published checksum that is not a SHA-256.
    Malformed(&'static str),
    /// The digest and the `.sha256` asset disagree.
    Conflict,
    Mismatch { expected: String, actual: String },
    BadUrl(String),
}

impl std::fmt::Display for TrustError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing => write!(
                f,
                "the release publishes no SHA-256 for this archive, so it is not installed"
            ),
            Self::Malformed(source) => write!(f, "the release's {source} is not a SHA-256"),
            Self::Conflict => write!(
                f,
                "GitHub's digest and the release's .sha256 file disagree, so the archive is not installed"
            ),
            Self::Mismatch { expected, actual } => write!(
                f,
                "the downloaded archive's SHA-256 {actual} does not match the published {expected}"
            ),
            Self::BadUrl(url) => write!(f, "{url} is not a Caloptreyx release download"),
        }
    }
}

impl std::error::Error for TrustError {}

/// The download URL of a release asset. Segments are percent-encoded, so a tag or asset name
/// cannot change the path.
pub fn release_asset_url(repo: &str, tag: &str, asset: &str) -> Result<Url, TrustError> {
    let mut url = Url::parse("https://github.com/").expect("static url");
    url.path_segments_mut()
        .map_err(|()| TrustError::BadUrl(repo.into()))?
        .pop_if_empty()
        .extend([ORG, repo, "releases", "download", tag, asset]);
    if is_release_download(&url, repo) {
        Ok(url)
    } else {
        Err(TrustError::BadUrl(url.to_string()))
    }
}

fn plain_https(url: &Url, host: &str) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some(host)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

/// `https://github.com/Caloptreyx/<repo>/releases/download/<tag>/<asset>` and nothing else.
pub fn is_release_download(url: &Url, repo: &str) -> bool {
    if !plain_https(url, "github.com") || url.query().is_some() || url.fragment().is_some() {
        return false;
    }
    let Some(segments) = url.path_segments() else {
        return false;
    };
    let segments: Vec<&str> = segments.collect();
    matches!(
        segments.as_slice(),
        [org, name, "releases", "download", tag, asset]
            if org.eq_ignore_ascii_case(ORG)
                && name.eq_ignore_ascii_case(repo)
                && !tag.is_empty()
                && !asset.is_empty()
                && ![*tag, *asset].iter().any(|s| *s == "." || *s == "..")
    )
}

/// Where a download may be redirected: GitHub's asset hosts, or another release download of the
/// organization (a renamed repository). Always HTTPS on the default port.
pub fn is_allowed_redirect(url: &Url) -> bool {
    if ASSET_HOSTS.iter().any(|host| plain_https(url, host)) {
        return true;
    }
    let Some(segments) = url.path_segments() else {
        return false;
    };
    let segments: Vec<&str> = segments.collect();
    match segments.as_slice() {
        [_, repo, ..] => is_release_download(url, repo),
        _ => false,
    }
}

pub fn parse_hex(text: &str) -> Option<Sha256> {
    let text = text.trim();
    if text.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    hex::decode_to_slice(text, &mut out).ok()?;
    Some(out)
}

/// GitHub's asset `digest` field: `sha256:<hex>`.
pub fn parse_digest(digest: &str) -> Option<Sha256> {
    let (algorithm, value) = digest.split_once(':')?;
    if !algorithm.eq_ignore_ascii_case("sha256") {
        return None;
    }
    parse_hex(value)
}

/// A `sha256sum` style file: `<hex>  <name>` lines (`*<name>` in binary mode), or one bare
/// `<hex>`. Only the line for `asset` counts when names are given.
pub fn parse_checksum_file(text: &str, asset: &str) -> Option<Sha256> {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    for line in &lines {
        let mut parts = line.splitn(2, char::is_whitespace);
        let hash = parts.next()?;
        match parts.next().map(str::trim) {
            Some(name) => {
                if name.strip_prefix('*').unwrap_or(name) == asset {
                    return parse_hex(hash);
                }
            }
            None if lines.len() == 1 => return parse_hex(hash),
            None => {}
        }
    }
    None
}

/// The SHA-256 the archive must have. `digest` is GitHub's asset digest, `checksum_file` the
/// text of the `.sha256` asset; whichever are published must be valid and agree.
pub fn expected(
    digest: Option<&str>,
    checksum_file: Option<&str>,
    asset: &str,
) -> Result<Sha256, TrustError> {
    let from_digest = digest
        .map(|d| parse_digest(d).ok_or(TrustError::Malformed("GitHub digest")))
        .transpose()?;
    let from_file = checksum_file
        .map(|text| {
            parse_checksum_file(text, asset).ok_or(TrustError::Malformed(".sha256 file"))
        })
        .transpose()?;
    match (from_digest, from_file) {
        (Some(a), Some(b)) if a != b => Err(TrustError::Conflict),
        (Some(hash), _) | (None, Some(hash)) => Ok(hash),
        (None, None) => Err(TrustError::Missing),
    }
}

pub fn verify(actual: &Sha256, expected: &Sha256) -> Result<(), TrustError> {
    if actual == expected {
        Ok(())
    } else {
        Err(TrustError::Mismatch {
            expected: hex::encode(expected),
            actual: hex::encode(actual),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256 as Hasher};

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn only_organization_release_downloads_are_fetched() {
        let built = release_asset_url("World-Map", "v0.1.2", "dev_caloptreyx_worldmap.c7s.zip").unwrap();
        assert_eq!(
            built.as_str(),
            "https://github.com/Caloptreyx/World-Map/releases/download/v0.1.2/dev_caloptreyx_worldmap.c7s.zip"
        );
        // a tag or name cannot add path segments
        let odd = release_asset_url("World-Map", "v1/../../x", "a b.zip").unwrap();
        assert!(odd.as_str().contains("v1%2F..%2F..%2Fx"));
        assert!(release_asset_url("World-Map", "..", "a.zip").is_err());

        assert!(is_release_download(&built, "World-Map"));
        for bad in [
            "http://github.com/Caloptreyx/World-Map/releases/download/v1/a.zip",
            "https://github.com:8443/Caloptreyx/World-Map/releases/download/v1/a.zip",
            "https://user@github.com/Caloptreyx/World-Map/releases/download/v1/a.zip",
            "https://github.com.evil.io/Caloptreyx/World-Map/releases/download/v1/a.zip",
            "https://github.com/Someone/World-Map/releases/download/v1/a.zip",
            "https://github.com/Caloptreyx/Other/releases/download/v1/a.zip",
            "https://github.com/Caloptreyx/World-Map/archive/v1/a.zip",
            "https://github.com/Caloptreyx/World-Map/releases/download/v1/a.zip?x=1",
            "https://api.github.com/repos/Caloptreyx/World-Map/releases/assets/1",
        ] {
            assert!(!is_release_download(&url(bad), "World-Map"), "{bad}");
        }
    }

    #[test]
    fn redirects_only_reach_github_asset_hosts() {
        assert!(is_allowed_redirect(&url(
            "https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sp=r&sig=x"
        )));
        assert!(is_allowed_redirect(&url("https://objects.githubusercontent.com/x/y")));
        // a renamed repository of the organization
        assert!(is_allowed_redirect(&url(
            "https://github.com/Caloptreyx/Reverse-Proxy/releases/download/v1/a.c7s.zip"
        )));
        for bad in [
            "http://release-assets.githubusercontent.com/x",
            "https://release-assets.githubusercontent.com.evil.io/x",
            "https://evil.io/release-assets.githubusercontent.com/x",
            "https://raw.githubusercontent.com/Caloptreyx/World-Map/main/x",
            "https://github.com/Other/World-Map/releases/download/v1/a.zip",
            "https://github.com/login?return_to=x",
            "file:///etc/passwd",
        ] {
            assert!(!is_allowed_redirect(&url(bad)), "{bad}");
        }
    }

    #[test]
    fn checksums_must_be_published_valid_and_agree() {
        let archive = b"PK\x03\x04 an archive";
        let actual: Sha256 = Hasher::digest(archive).into();
        let hex = hex::encode(actual);
        let digest = format!("sha256:{hex}");
        let file = format!("{hex}  dev_caloptreyx_mint.c7s.zip\n");
        let asset = "dev_caloptreyx_mint.c7s.zip";

        assert_eq!(expected(Some(&digest), None, asset), Ok(actual));
        assert_eq!(expected(None, Some(&file), asset), Ok(actual));
        assert_eq!(expected(Some(&digest), Some(&file), asset), Ok(actual));
        assert_eq!(expected(None, Some(&format!("{hex}\n")), asset), Ok(actual));
        assert_eq!(expected(None, Some(&format!("{hex} *{asset}")), asset), Ok(actual));
        // two archives in one file: the line for this one
        let both = format!("{}  dev_s4way_nebula.c7s.zip\n{hex}  {asset}\n", "0".repeat(64));
        assert_eq!(expected(None, Some(&both), asset), Ok(actual));

        assert_eq!(expected(None, None, asset), Err(TrustError::Missing));
        assert_eq!(
            expected(Some("md5:abc"), None, asset),
            Err(TrustError::Malformed("GitHub digest"))
        );
        assert_eq!(
            expected(None, Some(&format!("{hex}  other.zip")), asset),
            Err(TrustError::Malformed(".sha256 file"))
        );
        let other = format!("sha256:{}", "0".repeat(64));
        assert_eq!(expected(Some(&other), Some(&file), asset), Err(TrustError::Conflict));

        assert!(verify(&actual, &actual).is_ok());
        let tampered: Sha256 = Hasher::digest(b"PK\x03\x04 tampered").into();
        assert!(matches!(verify(&tampered, &actual), Err(TrustError::Mismatch { .. })));
    }
}
