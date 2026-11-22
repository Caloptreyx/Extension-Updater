//! Which Caloptreyx extension lives in which repository, and which release an extension should
//! get on this panel. Pure functions over GitHub data and the panel version, so the rules are
//! unit-tested without a network or a panel.

use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};
use shared::extensions::distr::{MetadataToml, PanelVersionError};
use std::collections::BTreeMap;

/// The GitHub organization every release is taken from.
pub const ORG: &str = "Caloptreyx";

/// Package names the updater looks after. Other extensions are never touched, even when a
/// repository of the organization claims them.
const OUR_PREFIXES: [&str; 2] = ["dev.caloptreyx.", "com.caloptreyx."];

/// Most release notes kept per release; longer notes are cut.
const NOTES_LIMIT: usize = 20_000;

pub fn is_ours(package_name: &str) -> bool {
    OUR_PREFIXES.iter().any(|prefix| {
        package_name
            .strip_prefix(prefix)
            .is_some_and(|rest| !rest.is_empty() && !rest.contains('.'))
    })
}

/// The archive name `panel-rs extensions export` gives a package: `dev_caloptreyx_mint.c7s.zip`.
pub fn asset_name(package_name: &str) -> String {
    format!(
        "{}.c7s.zip",
        MetadataToml::convert_package_name_to_identifier(package_name)
    )
}

/// GitHub repository names: letters, digits, `-`, `_` and `.`, never `.` or `..`. Anything else is
/// not used in a URL.
pub fn valid_repo_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name != "."
        && name != ".."
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// A repository of the organization, as `GET /orgs/{org}/repos` lists it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Repo {
    pub name: String,
    #[serde(default)]
    pub default_branch: String,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub fork: bool,
    #[serde(default)]
    pub private: bool,
    #[serde(default)]
    pub pushed_at: Option<String>,
}

impl Repo {
    /// Forks and private repositories are never searched for extensions.
    pub fn searched(&self) -> bool {
        !self.fork && !self.private && valid_repo_name(&self.name)
    }
}

/// A repository that holds one of our extensions, found by the `Metadata.toml` on its default
/// branch.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Listing {
    pub repo: String,
    pub package_name: String,
    pub name: String,
    pub archived: bool,
}

/// The listing for `repo`, when its default branch's `Metadata.toml` names one of our packages.
pub fn listing(repo: &Repo, metadata_toml: &str) -> Option<Listing> {
    if !repo.searched() {
        return None;
    }
    let metadata = parse_metadata(metadata_toml).ok()?;
    is_ours(&metadata.package_name).then(|| Listing {
        repo: repo.name.clone(),
        package_name: metadata.package_name,
        name: metadata.name,
        archived: repo.archived,
    })
}

/// Package name to repository. When two repositories claim one package, the one that is not
/// archived wins, then the first by name, so the choice does not depend on GitHub's order.
pub fn map_packages(listings: impl IntoIterator<Item = Listing>) -> BTreeMap<String, Listing> {
    let mut map: BTreeMap<String, Listing> = BTreeMap::new();
    for listing in listings {
        if !is_ours(&listing.package_name) {
            continue;
        }
        let keep_existing = map.get(&listing.package_name).is_some_and(|existing| {
            (existing.archived, &existing.repo) <= (listing.archived, &listing.repo)
        });
        if !keep_existing {
            map.insert(listing.package_name.clone(), listing);
        }
    }
    map
}

pub fn parse_metadata(text: &str) -> Result<MetadataToml, toml::de::Error> {
    toml::from_str(text)
}

/// What a release tag's `Metadata.toml` says, kept per tag.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ReleaseMeta {
    pub package_name: String,
    pub name: String,
    pub panel_version: VersionReq,
    /// The license the panel asks admins to accept before installing, if any.
    pub license_text: Option<String>,
}

impl ReleaseMeta {
    pub fn parse(text: &str) -> Option<Self> {
        let metadata = parse_metadata(text).ok()?;
        Some(Self {
            package_name: metadata.package_name,
            name: metadata.name,
            panel_version: metadata.panel_version,
            license_text: metadata.license_text,
        })
    }

    /// The panel's own rule (`MetadataToml::check_panel_version`, used by the upload route):
    /// `None` checks only that the floor is not older than the panel allows.
    pub fn check_panel(&self, target: Option<&Version>) -> Result<(), PanelVersionError> {
        fits_panel(&self.panel_version, target)
    }
}

pub fn fits_panel(
    requirement: &VersionReq,
    target: Option<&Version>,
) -> Result<(), PanelVersionError> {
    MetadataToml {
        package_name: String::new(),
        name: String::new(),
        panel_version: requirement.clone(),
        license_text: None,
    }
    .check_panel_version(target)
}

/// A release as `GET /repos/{owner}/{repo}/releases` lists it (the fields the updater needs).
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Release {
    pub tag_name: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub prerelease: bool,
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub html_url: String,
    #[serde(default, deserialize_with = "notes")]
    pub body: String,
    #[serde(default)]
    pub assets: Vec<Asset>,
}

fn notes<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let mut body = Option::<String>::deserialize(deserializer)?.unwrap_or_default();
    if body.len() > NOTES_LIMIT {
        let mut end = NOTES_LIMIT;
        while !body.is_char_boundary(end) {
            end -= 1;
        }
        body.truncate(end);
        body.push_str("\n\n…");
    }
    Ok(body)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Asset {
    pub name: String,
    #[serde(default)]
    pub size: u64,
    /// GitHub's own checksum of the uploaded file, `sha256:<hex>`.
    #[serde(default)]
    pub digest: Option<String>,
}

impl Release {
    pub fn version(&self) -> Option<Version> {
        release_version(&self.tag_name)
    }

    pub fn asset(&self, name: &str) -> Option<&Asset> {
        self.assets.iter().find(|asset| asset.name == name)
    }

    /// The checksum file the release workflow uploads beside the archive.
    pub fn checksum_asset(&self, archive: &str) -> Option<&Asset> {
        self.asset(&format!("{archive}.sha256"))
    }

    /// Whether the archive can be verified: GitHub's digest or a `.sha256` asset.
    pub fn has_checksum(&self, archive: &str) -> bool {
        self.asset(archive).is_some_and(|asset| asset.digest.is_some())
            || self.checksum_asset(archive).is_some()
    }

    fn is_prerelease(&self, version: &Version) -> bool {
        self.prerelease || !version.pre.is_empty()
    }
}

/// `v1.2.3` and `1.2.3` are versions; other tags are not releases of an extension.
pub fn release_version(tag: &str) -> Option<Version> {
    Version::parse(tag.strip_prefix('v').unwrap_or(tag)).ok()
}

/// The key a release tag's metadata is kept under.
pub fn meta_key(repo: &str, tag: &str) -> String {
    format!("{repo}@{tag}")
}

/// A release that can be installed: not a draft, allowed by the prerelease setting, a version
/// tag, the package's archive attached and a `Metadata.toml` at the tag for the same package
/// whose panel floor the panel accepts at all.
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate<'a> {
    pub release: &'a Release,
    pub version: Version,
    pub meta: &'a ReleaseMeta,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Selection<'a> {
    /// The newest release this panel can run.
    pub compatible: Option<Candidate<'a>>,
    /// The newest release, when it is newer than `compatible` and needs a newer panel.
    pub needs_panel: Option<Candidate<'a>>,
    /// Releases newer than the installed version up to `compatible`, newest first: the notes
    /// an update brings.
    pub notes: Vec<Candidate<'a>>,
}

pub fn candidates<'a>(
    package_name: &str,
    repo: &str,
    releases: &'a [Release],
    metas: &'a BTreeMap<String, ReleaseMeta>,
    allow_prereleases: bool,
) -> Vec<Candidate<'a>> {
    let archive = asset_name(package_name);
    let mut found: Vec<Candidate<'a>> = releases
        .iter()
        .filter(|release| !release.draft)
        .filter_map(|release| {
            let version = release.version()?;
            if release.is_prerelease(&version) && !allow_prereleases {
                return None;
            }
            release.asset(&archive)?;
            let meta = metas.get(&meta_key(repo, &release.tag_name))?;
            if meta.package_name != package_name || meta.check_panel(None).is_err() {
                return None;
            }
            Some(Candidate {
                release,
                version,
                meta,
            })
        })
        .collect();
    found.sort_by(|a, b| b.version.cmp(&a.version));
    found.dedup_by(|a, b| a.version == b.version);
    found
}

pub fn select<'a>(
    candidates: &[Candidate<'a>],
    target: &Version,
    installed: Option<&Version>,
) -> Selection<'a> {
    let compatible = candidates
        .iter()
        .find(|candidate| candidate.meta.check_panel(Some(target)).is_ok())
        .cloned();
    let needs_panel = candidates
        .first()
        .filter(|newest| {
            compatible
                .as_ref()
                .is_none_or(|compatible| newest.version > compatible.version)
        })
        .cloned();
    let notes = match &compatible {
        Some(compatible) => candidates
            .iter()
            .filter(|candidate| candidate.version <= compatible.version)
            .filter(|candidate| installed.is_none_or(|installed| candidate.version > *installed))
            .cloned()
            .collect(),
        None => Vec::new(),
    };
    Selection {
        compatible,
        needs_panel,
        notes,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    UpToDate,
    UpdateAvailable,
    /// A newer release exists, but needs a newer panel than this one.
    NeedsPanel,
    /// Not installed, and a release fits this panel.
    Installable,
    /// No release fits: none published, none with the archive, or none for this package.
    NoRelease,
    /// Installed, but no repository of the organization publishes it.
    Unpublished,
}

pub fn status(installed: Option<&Version>, published: bool, selection: &Selection) -> Status {
    if !published {
        return if installed.is_some() {
            Status::Unpublished
        } else {
            Status::NoRelease
        };
    }
    let compatible = selection.compatible.as_ref().map(|c| &c.version);
    let needs_panel = selection.needs_panel.as_ref().map(|c| &c.version);
    match installed {
        Some(installed) => {
            if compatible.is_some_and(|v| v > installed) {
                Status::UpdateAvailable
            } else if needs_panel.is_some_and(|v| v > installed) {
                Status::NeedsPanel
            } else if compatible.is_some() || needs_panel.is_some() {
                Status::UpToDate
            } else {
                Status::NoRelease
            }
        }
        None => {
            if compatible.is_some() {
                Status::Installable
            } else if needs_panel.is_some() {
                Status::NeedsPanel
            } else {
                Status::NoRelease
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, assets: &[&str]) -> Release {
        Release {
            tag_name: tag.into(),
            name: None,
            draft: false,
            prerelease: false,
            published_at: None,
            html_url: format!("https://github.com/Caloptreyx/World-Map/releases/tag/{tag}"),
            body: String::new(),
            assets: assets
                .iter()
                .map(|name| Asset {
                    name: (*name).into(),
                    size: 1,
                    digest: Some(format!("sha256:{}", "a".repeat(64))),
                })
                .collect(),
        }
    }

    fn meta(package: &str, floor: &str) -> ReleaseMeta {
        ReleaseMeta {
            package_name: package.into(),
            name: "World Map".into(),
            panel_version: VersionReq::parse(floor).unwrap(),
            license_text: None,
        }
    }

    const PKG: &str = "dev.caloptreyx.worldmap";
    const ZIP: &str = "dev_caloptreyx_worldmap.c7s.zip";

    fn v(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    #[test]
    fn only_caloptreyx_packages_are_ours() {
        assert!(is_ours("dev.caloptreyx.worldmap"));
        assert!(is_ours("com.caloptreyx.serversplitter"));
        assert!(!is_ours("dev.qunix.theme"));
        assert!(!is_ours("dev.caloptreyx."));
        assert!(!is_ours("dev.caloptreyx.a.b"));
        assert!(!is_ours("dev.caloptreyxx.mint"));
        assert_eq!(asset_name("com.caloptreyx.serversplitter"), "com_caloptreyx_serversplitter.c7s.zip");
    }

    #[test]
    fn repositories_map_to_packages_by_their_metadata() {
        let repo = |name: &str, archived: bool, fork: bool| Repo {
            name: name.into(),
            default_branch: "main".into(),
            archived,
            fork,
            private: false,
            pushed_at: None,
        };
        let toml = |package: &str| {
            format!("package_name = \"{package}\"\nname = \"X\"\npanel_version = \">=1.2.10\"\n")
        };
        let found: Vec<Listing> = [
            (repo("World-Map", false, false), toml(PKG)),
            (repo("serversplitter", false, false), toml("com.caloptreyx.serversplitter")),
            // not ours, a fork, no Metadata.toml, an invalid name
            (repo("qunix_theme", false, false), toml("dev.qunix.theme")),
            (repo("Fork-Of-Mint", false, true), toml("dev.caloptreyx.mint")),
            (repo("yolks", false, false), String::new()),
            (repo("../etc", false, false), toml("dev.caloptreyx.evil")),
            // an archived copy loses to the live repository whatever the order
            (repo("Mint-Old", true, false), toml("dev.caloptreyx.mint")),
            (repo("Mint-Theme", false, false), toml("dev.caloptreyx.mint")),
        ]
        .iter()
        .filter_map(|(repo, text)| listing(repo, text))
        .collect();
        let map = map_packages(found.clone());
        assert_eq!(map.len(), 3);
        assert_eq!(map[PKG].repo, "World-Map");
        assert_eq!(map["com.caloptreyx.serversplitter"].repo, "serversplitter");
        assert_eq!(map["dev.caloptreyx.mint"].repo, "Mint-Theme");
        let reversed = map_packages(found.into_iter().rev());
        assert_eq!(reversed["dev.caloptreyx.mint"].repo, "Mint-Theme");
    }

    #[test]
    fn the_newest_release_that_fits_the_panel_is_offered() {
        let releases = vec![
            release("v0.3.0", &[ZIP]),
            release("v0.2.0", &[ZIP, &format!("{ZIP}.sha256")]),
            release("v0.1.1", &[ZIP]),
            release("v0.1.0", &[ZIP]),
        ];
        let metas = BTreeMap::from([
            (meta_key("World-Map", "v0.3.0"), meta(PKG, ">=1.3.0")),
            (meta_key("World-Map", "v0.2.0"), meta(PKG, ">=1.2.10")),
            (meta_key("World-Map", "v0.1.1"), meta(PKG, ">=1.2.10")),
            (meta_key("World-Map", "v0.1.0"), meta(PKG, ">=1.2.2")),
        ]);
        let found = candidates(PKG, "World-Map", &releases, &metas, false);
        let installed = v("0.1.0");
        let selection = select(&found, &v("1.2.10"), Some(&installed));
        assert_eq!(selection.compatible.as_ref().unwrap().version, v("0.2.0"));
        assert_eq!(selection.needs_panel.as_ref().unwrap().version, v("0.3.0"));
        let notes: Vec<_> = selection.notes.iter().map(|c| c.version.to_string()).collect();
        assert_eq!(notes, ["0.2.0", "0.1.1"]);
        assert_eq!(status(Some(&installed), true, &selection), Status::UpdateAvailable);

        // on the newer panel the newest is offered and nothing is held back
        let selection = select(&found, &v("1.3.0"), Some(&installed));
        assert_eq!(selection.compatible.as_ref().unwrap().version, v("0.3.0"));
        assert!(selection.needs_panel.is_none());

        // installed at the newest compatible one: only the newer panel is missing
        let current = v("0.2.0");
        let selection = select(&found, &v("1.2.10"), Some(&current));
        assert!(selection.notes.is_empty());
        assert_eq!(status(Some(&current), true, &selection), Status::NeedsPanel);
    }

    #[test]
    fn drafts_prereleases_and_unusable_releases_are_skipped() {
        let mut draft = release("v0.5.0", &[ZIP]);
        draft.draft = true;
        let mut pre = release("v0.4.0", &[ZIP]);
        pre.prerelease = true;
        let releases = vec![
            draft,
            pre,
            release("v0.3.5-beta.1", &[ZIP]),
            release("v0.3.4", &["other.c7s.zip"]),
            release("v0.3.3", &[ZIP]),
            release("v0.3.2", &[ZIP]),
            release("nightly", &[ZIP]),
            release("v0.3.1", &[ZIP]),
        ];
        let metas = BTreeMap::from([
            (meta_key("World-Map", "v0.5.0"), meta(PKG, ">=1.2.10")),
            (meta_key("World-Map", "v0.4.0"), meta(PKG, ">=1.2.10")),
            (meta_key("World-Map", "v0.3.5-beta.1"), meta(PKG, ">=1.2.10")),
            (meta_key("World-Map", "v0.3.4"), meta(PKG, ">=1.2.10")),
            // another package's metadata at the tag, a floor the panel refuses
            (meta_key("World-Map", "v0.3.3"), meta("dev.caloptreyx.mint", ">=1.2.10")),
            (meta_key("World-Map", "v0.3.2"), meta(PKG, ">=1.0.0")),
            (meta_key("World-Map", "nightly"), meta(PKG, ">=1.2.10")),
            (meta_key("World-Map", "v0.3.1"), meta(PKG, ">=1.2.10")),
        ]);
        let target = v("1.2.10");
        let stable = candidates(PKG, "World-Map", &releases, &metas, false);
        let picked = select(&stable, &target, None);
        assert_eq!(picked.compatible.unwrap().version, v("0.3.1"));
        assert_eq!(status(None, true, &select(&stable, &target, None)), Status::Installable);

        let with_pre = candidates(PKG, "World-Map", &releases, &metas, true);
        assert_eq!(select(&with_pre, &target, None).compatible.unwrap().version, v("0.4.0"));
    }

    #[test]
    fn statuses_without_releases() {
        let none = Selection::default();
        assert_eq!(status(Some(&v("1.0.0")), false, &none), Status::Unpublished);
        assert_eq!(status(Some(&v("1.0.0")), true, &none), Status::NoRelease);
        assert_eq!(status(None, true, &none), Status::NoRelease);
    }

    #[test]
    fn release_payloads_parse_and_long_notes_are_cut() {
        let body = "é".repeat(NOTES_LIMIT);
        let json = serde_json::json!({
            "tag_name": "v1.5.2",
            "draft": false,
            "prerelease": false,
            "html_url": "https://github.com/Caloptreyx/serversplitter/releases/tag/v1.5.2",
            "body": body,
            "assets": [{
                "name": "com_caloptreyx_serversplitter.c7s.zip",
                "size": 46466,
                "digest": "sha256:a06377be49f25a150063ad82745889f6afef8ca08ddc337caf584868dc9a1a9c",
                "browser_download_url": "https://github.com/x"
            }]
        });
        let parsed: Release = serde_json::from_value(json).unwrap();
        assert_eq!(parsed.version(), Some(v("1.5.2")));
        assert!(parsed.has_checksum("com_caloptreyx_serversplitter.c7s.zip"));
        assert!(parsed.body.len() <= NOTES_LIMIT + 5);
        let null_body: Release =
            serde_json::from_value(serde_json::json!({"tag_name": "v1.0.0", "body": null})).unwrap();
        assert_eq!(null_body.body, "");
        assert!(!null_body.has_checksum("x.c7s.zip"));
    }
}
