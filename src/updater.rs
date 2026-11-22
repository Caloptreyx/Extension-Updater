//! The updater: checks GitHub for releases (on a schedule, on demand, cheaply after restarts),
//! builds the admin page's view, installs updates and rollbacks, and runs automatic updates.

use crate::{
    catalog::{self, Listing, Release, ReleaseMeta, Repo, Status},
    github::{self, Github},
    panel::{self, PanelHost},
    pipeline::{self, ApplyError, Plan, Rebuild, Source},
    runs,
    settings::{self, Settings},
    store::{self, Run, RunItem, RunKind, RunState},
    trust,
};
use chrono::{DateTime, Timelike, Utc};
use semver::Version;
use serde::Serialize;
use shared::{
    State,
    models::{
        CreatableModel,
        admin_activity::{AdminActivity, CreateAdminActivityOptions},
    },
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, LazyLock},
    time::Duration,
};
use tokio::sync::{Mutex, RwLock};

const REPOS_KEY: &str = "repos";
const LAST_CHECK_KEY: &str = "state:last-check";
const LAST_AUTO_KEY: &str = "state:last-auto";
/// How often the repository list is read again.
const REPOS_MAX_AGE_HOURS: i64 = 24;
/// Release tags whose `Metadata.toml` is read, newest first per repository.
const TAGS_PER_REPO: usize = 10;
/// The shortest time between two manual checks.
const MANUAL_CHECK_GAP_SECS: i64 = 30;

/// What the last check found.
#[derive(Default)]
pub struct Snapshot {
    pub checked_at: Option<DateTime<Utc>>,
    pub errors: Vec<String>,
    pub packages: BTreeMap<String, Listing>,
    /// Releases by repository.
    pub releases: BTreeMap<String, Vec<Release>>,
    /// `Metadata.toml` by `repo@tag`.
    pub metas: BTreeMap<String, ReleaseMeta>,
    pub allow_prereleases: bool,
}

static SNAPSHOT: LazyLock<RwLock<Arc<Snapshot>>> = LazyLock::new(Default::default);
static CHECKING: Mutex<()> = Mutex::const_new(());
/// One install, rollback or automatic update at a time.
static APPLYING: Mutex<()> = Mutex::const_new(());

pub async fn snapshot() -> Arc<Snapshot> {
    SNAPSHOT.read().await.clone()
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// After a restart: only what is cached, unless nothing is.
    Startup,
    Scheduled,
    Manual,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct LastCheck {
    at: DateTime<Utc>,
    errors: Vec<String>,
}

pub fn is_checking() -> bool {
    CHECKING.try_lock().is_err()
}

/// When the last check finished, from the database.
async fn last_check(state: &State) -> Option<LastCheck> {
    let cached = store::cache_get(&state.database, LAST_CHECK_KEY).await.ok()??;
    serde_json::from_str(&cached.value).ok()
}

/// Checks GitHub and replaces the snapshot. A check already running is waited for instead.
pub async fn check(state: &State, mode: Mode) -> anyhow::Result<Arc<Snapshot>> {
    let _guard = match CHECKING.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            let _ = CHECKING.lock().await;
            return Ok(snapshot().await);
        }
    };
    if mode == Mode::Manual
        && let Some(at) = snapshot().await.checked_at
        && (Utc::now() - at).num_seconds() < MANUAL_CHECK_GAP_SECS
    {
        return Ok(snapshot().await);
    }
    let settings = settings::load(state).await?;
    let github = Github::new(&settings.github_token);
    let offline = mode == Mode::Startup;
    let mut errors = Vec::new();
    let db = &state.database;

    // the organization's repositories, once a day
    let cached_repos = store::cache_get(db, REPOS_KEY).await?;
    let fresh = cached_repos.as_ref().is_some_and(|c| {
        (Utc::now() - c.updated).num_hours() < REPOS_MAX_AGE_HOURS
            || (offline && !c.value.is_empty())
    });
    let repos: Vec<Repo> = match (&cached_repos, fresh) {
        (Some(cached), true) => serde_json::from_str(&cached.value).unwrap_or_default(),
        _ => match github.org_repos(db).await {
            Ok(repos) => {
                let repos: Vec<Repo> = repos.into_iter().filter(Repo::searched).collect();
                store::cache_put(db, REPOS_KEY, None, None, &serde_json::to_string(&repos)?)
                    .await?;
                repos
            }
            Err(err) => {
                errors.push(format!("{err:#}"));
                cached_repos
                    .as_ref()
                    .and_then(|c| serde_json::from_str(&c.value).ok())
                    .unwrap_or_default()
            }
        },
    };

    // which package each repository holds, from its default branch (refetched after a push)
    let mut listings = Vec::new();
    for repo in &repos {
        let key = format!("head:{}", repo.name);
        let pushed = repo.pushed_at.clone().unwrap_or_default();
        let cached = store::cache_get(db, &key).await?;
        let text = match cached {
            Some(cached) if offline || cached.fingerprint.as_deref() == Some(pushed.as_str()) => {
                cached.value
            }
            cached => match github.metadata_at(&repo.name, &repo.default_branch).await {
                Ok(text) => {
                    let text = text.unwrap_or_default();
                    store::cache_put(db, &key, None, Some(&pushed), &text).await?;
                    text
                }
                Err(err) => {
                    errors.push(format!("{}: {err:#}", repo.name));
                    cached.map(|c| c.value).unwrap_or_default()
                }
            },
        };
        if let Some(listing) = catalog::listing(repo, &text) {
            listings.push(listing);
        }
    }
    let packages = catalog::map_packages(listings);

    // releases and the Metadata.toml of their tags
    let repo_names: BTreeSet<&str> = packages.values().map(|l| l.repo.as_str()).collect();
    let mut releases = BTreeMap::new();
    let mut metas = BTreeMap::new();
    for repo in repo_names {
        let list = match load_releases(db, &github, repo, offline).await {
            Ok(list) => list,
            Err(err) => {
                errors.push(format!("{repo}: {err:#}"));
                cached_releases(db, repo).await.unwrap_or_default()
            }
        };
        let mut tags: Vec<&Release> = list
            .iter()
            .filter(|r| !r.draft && r.version().is_some())
            .collect();
        tags.sort_by_key(|r| std::cmp::Reverse(r.version()));
        for release in tags.into_iter().take(TAGS_PER_REPO) {
            let key = format!("meta:{}", catalog::meta_key(repo, &release.tag_name));
            let text = match store::cache_get(db, &key).await? {
                Some(cached) => Some(cached.value),
                None if offline => None,
                None => match github.metadata_at(repo, &release.tag_name).await {
                    Ok(text) => {
                        let text = text.unwrap_or_default();
                        store::cache_put(db, &key, None, None, &text).await?;
                        Some(text)
                    }
                    Err(err) => {
                        errors.push(format!("{repo} {}: {err:#}", release.tag_name));
                        None
                    }
                },
            };
            if let Some(meta) = text.as_deref().and_then(ReleaseMeta::parse) {
                metas.insert(catalog::meta_key(repo, &release.tag_name), meta);
            }
        }
        releases.insert(repo.to_string(), list);
    }

    let checked_at = if offline {
        last_check(state).await.map(|c| c.at)
    } else {
        Some(Utc::now())
    };
    if !offline {
        let last = LastCheck {
            at: Utc::now(),
            errors: errors.clone(),
        };
        store::cache_put(db, LAST_CHECK_KEY, None, None, &serde_json::to_string(&last)?).await?;
        if let Err(err) = store::cache_prune(db, 30).await {
            tracing::warn!("extension updater: pruning the cache: {err}");
        }
    } else if let Some(last) = last_check(state).await {
        errors = last.errors;
    }
    errors.dedup();
    let snapshot = Arc::new(Snapshot {
        checked_at,
        errors,
        packages,
        releases,
        metas,
        allow_prereleases: settings.allow_prereleases,
    });
    *SNAPSHOT.write().await = snapshot.clone();
    Ok(snapshot)
}

async fn cached_releases(db: &shared::database::Database, repo: &str) -> Option<Vec<Release>> {
    let cached = store::cache_get(db, &github::releases_key(repo)).await.ok()??;
    serde_json::from_str(&cached.value).ok()
}

/// A repository's releases: from the cache when its release feed did not change (or after a
/// restart), else from the API.
async fn load_releases(
    db: &shared::database::Database,
    github: &Github,
    repo: &str,
    offline: bool,
) -> anyhow::Result<Vec<Release>> {
    let key = github::releases_key(repo);
    let cached = store::cache_get(db, &key).await?;
    if offline && let Some(cached) = &cached {
        return Ok(serde_json::from_str(&cached.value)?);
    }
    if github.authenticated() {
        // ETag requests: a 304 costs nothing with a token
        return github.releases(db, repo).await;
    }
    let feed = github.release_feed(repo).await;
    if let (Ok(fingerprint), Some(cached)) = (&feed, &cached)
        && cached.fingerprint.as_deref() == Some(fingerprint.as_str())
    {
        store::cache_touch(db, &key, None).await?;
        return Ok(serde_json::from_str(&cached.value)?);
    }
    if feed.is_err()
        && let Some(cached) = &cached
        && (Utc::now() - cached.updated).num_hours() < 24
    {
        return Ok(serde_json::from_str(&cached.value)?);
    }
    let releases = github.releases(db, repo).await?;
    if let Ok(fingerprint) = &feed {
        store::cache_touch(db, &key, Some(fingerprint)).await?;
    }
    Ok(releases)
}

#[derive(Serialize)]
pub struct ReleaseView {
    pub tag: String,
    pub version: String,
    pub name: Option<String>,
    pub published_at: Option<String>,
    pub html_url: String,
    pub body: String,
    pub prerelease: bool,
    pub panel_version: String,
    pub license: Option<String>,
    pub verified: bool,
    pub asset: Option<AssetView>,
}

#[derive(Serialize)]
pub struct AssetView {
    pub name: String,
    pub size: u64,
    pub download_url: String,
}

#[derive(Serialize)]
pub struct InstalledView {
    pub version: String,
    pub disabled: bool,
}

#[derive(Serialize)]
pub struct RollbackView {
    pub version: String,
}

#[derive(Serialize)]
pub struct Entry {
    pub package_name: String,
    pub name: String,
    pub repo: Option<String>,
    pub repo_url: Option<String>,
    pub archived: bool,
    pub installed: Option<InstalledView>,
    pub status: Status,
    pub latest: Option<ReleaseView>,
    pub needs_panel: Option<ReleaseView>,
    pub notes: Vec<ReleaseView>,
    pub rollback: Option<RollbackView>,
    pub is_self: bool,
}

fn release_view(repo: &str, package_name: &str, candidate: &catalog::Candidate) -> ReleaseView {
    let release = candidate.release;
    let archive = catalog::asset_name(package_name);
    ReleaseView {
        tag: release.tag_name.clone(),
        version: candidate.version.to_string(),
        name: release.name.clone(),
        published_at: release.published_at.clone(),
        html_url: release.html_url.clone(),
        body: release.body.clone(),
        prerelease: release.prerelease || !candidate.version.pre.is_empty(),
        panel_version: candidate.meta.panel_version.to_string(),
        license: candidate.meta.license_text.clone(),
        verified: release.has_checksum(&archive),
        asset: release.asset(&archive).map(|asset| AssetView {
            name: asset.name.clone(),
            size: asset.size,
            download_url: trust::release_asset_url(repo, &release.tag_name, &asset.name)
                .map(|url| url.to_string())
                .unwrap_or_default(),
        }),
    }
}

/// Every one of our extensions: the installed ones and those a repository publishes.
pub async fn entries(state: &State, snapshot: &Snapshot) -> Vec<Entry> {
    let running = panel::running(state).await;
    let target = panel::target_version(state).await;
    let kept: BTreeMap<String, String> = store::backup_versions(&state.database)
        .await
        .unwrap_or_default()
        .into_iter()
        .collect();
    let mut names: BTreeSet<&str> = running
        .keys()
        .map(String::as_str)
        .filter(|p| catalog::is_ours(p))
        .collect();
    names.extend(
        snapshot
            .packages
            .iter()
            .filter(|(_, listing)| !listing.archived)
            .map(|(package, _)| package.as_str()),
    );

    let mut entries: Vec<Entry> = names
        .into_iter()
        .map(|package_name| {
            let installed = running.get(package_name);
            let listing = snapshot.packages.get(package_name);
            let installed_version = installed.map(|r| &r.version);
            let (selection, published) = match listing {
                Some(listing) => {
                    let releases = snapshot
                        .releases
                        .get(&listing.repo)
                        .map(Vec::as_slice)
                        .unwrap_or_default();
                    let found = catalog::candidates(
                        package_name,
                        &listing.repo,
                        releases,
                        &snapshot.metas,
                        snapshot.allow_prereleases,
                    );
                    let selection = catalog::select(&found, &target, installed_version);
                    let views = (
                        selection
                            .compatible
                            .as_ref()
                            .map(|c| release_view(&listing.repo, package_name, c)),
                        selection
                            .needs_panel
                            .as_ref()
                            .map(|c| release_view(&listing.repo, package_name, c)),
                        selection
                            .notes
                            .iter()
                            .map(|c| release_view(&listing.repo, package_name, c))
                            .collect::<Vec<_>>(),
                        catalog::status(installed_version, true, &selection),
                    );
                    (Some(views), true)
                }
                None => (None, false),
            };
            let (latest, needs_panel, notes, status) = selection.unwrap_or_else(|| {
                (
                    None,
                    None,
                    Vec::new(),
                    catalog::status(installed_version, published, &Default::default()),
                )
            });
            Entry {
                package_name: package_name.to_string(),
                name: installed
                    .map(|r| r.name.clone())
                    .or_else(|| listing.map(|l| l.name.clone()))
                    .unwrap_or_else(|| package_name.to_string()),
                repo: listing.map(|l| l.repo.clone()),
                repo_url: listing.map(|l| format!("https://github.com/{}/{}", catalog::ORG, l.repo)),
                archived: listing.is_some_and(|l| l.archived),
                installed: installed.map(|r| InstalledView {
                    version: r.version.to_string(),
                    disabled: r.disabled,
                }),
                status,
                latest,
                needs_panel,
                notes,
                rollback: kept
                    .get(package_name)
                    .filter(|version| {
                        installed.is_none_or(|r| r.version.to_string() != **version)
                    })
                    .map(|version| RollbackView {
                        version: version.clone(),
                    }),
                is_self: package_name == crate::PACKAGE,
            }
        })
        .collect();
    entries.sort_by(|a, b| {
        (a.installed.is_none(), a.name.to_lowercase()).cmp(&(b.installed.is_none(), b.name.to_lowercase()))
    });
    entries
}

#[derive(Serialize)]
pub struct Overview {
    pub management: panel::Management,
    pub can_manage: bool,
    pub panel_version: String,
    pub checked_at: Option<DateTime<Utc>>,
    pub checking: bool,
    pub check_errors: Vec<String>,
    pub rate_limit: Option<github::RateLimit>,
    pub settings: settings::AdminView,
    pub extensions: Vec<Entry>,
    pub supervisor: Option<shared::heavy::Status>,
    pub runs: Vec<Run>,
}

pub async fn overview(state: &State, can_manage: bool) -> anyhow::Result<Overview> {
    if let Err(err) = runs::reconcile(state).await {
        tracing::warn!("extension updater: following runs: {err:#}");
    }
    let snapshot = snapshot().await;
    let settings = settings::load(state).await?;
    Ok(Overview {
        management: panel::management(state),
        can_manage,
        panel_version: panel::target_version(state).await.to_string(),
        checked_at: snapshot.checked_at,
        checking: is_checking(),
        check_errors: snapshot.errors.clone(),
        rate_limit: github::rate_limit(),
        settings: settings.admin_view(),
        extensions: entries(state, &snapshot).await,
        supervisor: if can_manage {
            panel::supervisor(state).await
        } else {
            None
        },
        runs: store::runs_recent(&state.database, 10).await?,
    })
}

#[derive(Serialize)]
pub struct SummaryItem {
    pub package_name: String,
    pub name: String,
    pub from: String,
    pub to: String,
}

#[derive(Serialize)]
pub struct Summary {
    pub show_banner: bool,
    pub building: bool,
    pub updates: Vec<SummaryItem>,
}

pub async fn summary(state: &State) -> anyhow::Result<Summary> {
    let snapshot = snapshot().await;
    let settings = settings::load(state).await?;
    let updates = entries(state, &snapshot)
        .await
        .into_iter()
        .filter(|entry| entry.status == Status::UpdateAvailable)
        .filter_map(|entry| {
            Some(SummaryItem {
                from: entry.installed?.version,
                to: entry.latest?.version,
                package_name: entry.package_name,
                name: entry.name,
            })
        })
        .collect();
    Ok(Summary {
        show_banner: settings.show_banner,
        building: !store::runs_open(&state.database).await?.is_empty(),
        updates,
    })
}

/// Who asked for a run, for the activity log.
pub struct Actor {
    pub user_uuid: Option<uuid::Uuid>,
    pub impersonator_uuid: Option<uuid::Uuid>,
    pub api_key_uuid: Option<uuid::Uuid>,
    pub ip: Option<std::net::IpAddr>,
}

impl Actor {
    pub const AUTOMATIC: Actor = Actor {
        user_uuid: None,
        impersonator_uuid: None,
        api_key_uuid: None,
        ip: None,
    };

    async fn log(&self, state: &State, event: &str, data: serde_json::Value) {
        let options = CreateAdminActivityOptions {
            user_uuid: self.user_uuid,
            impersonator_uuid: self.impersonator_uuid,
            api_key_uuid: self.api_key_uuid,
            event: event.into(),
            ip: self.ip.map(Into::into),
            data,
            created: None,
        };
        if let Err(err) = AdminActivity::create(state, options).await {
            tracing::warn!("extension updater: logging {event}: {err:?}");
        }
    }
}

/// A requested package and version.
#[derive(serde::Deserialize, Clone)]
pub struct Wanted {
    pub package_name: String,
    pub version: String,
}

#[derive(Debug)]
pub enum RunError {
    /// 409: something is already being installed or built.
    Busy(String),
    /// 400: the request cannot be installed as asked.
    Invalid(String),
    /// 409 with the license texts to accept.
    NeedsLicense(Vec<LicenseViewOwned>),
    /// 500/503
    Failed(String),
}

#[derive(Debug, Serialize)]
pub struct LicenseViewOwned {
    pub package_name: String,
    pub name: String,
    pub version: String,
    pub license: String,
}

impl From<anyhow::Error> for RunError {
    fn from(err: anyhow::Error) -> Self {
        Self::Failed(format!("{err:#}"))
    }
}

impl From<sqlx::Error> for RunError {
    fn from(err: sqlx::Error) -> Self {
        Self::Failed(err.to_string())
    }
}

#[derive(Serialize)]
pub struct Started {
    pub run: Run,
    pub build_id: Option<u64>,
}

async fn ensure_idle(state: &State) -> Result<(), RunError> {
    if !store::runs_open(&state.database).await?.is_empty() {
        return Err(RunError::Busy("an update is still being built".into()));
    }
    if let Some(status) = panel::supervisor(state).await
        && matches!(
            status.state,
            shared::heavy::SupervisorState::Queued | shared::heavy::SupervisorState::Building { .. }
        )
    {
        return Err(RunError::Busy(format!(
            "extension build {} is already in progress",
            status.build_id.unwrap_or_default()
        )));
    }
    Ok(())
}

/// Where the SHA-256 of a planned archive is published: GitHub's digest and the name of the
/// `.sha256` asset.
struct Published {
    digest: Option<String>,
    checksum_file: Option<String>,
}

/// Plans for `wanted`, from the snapshot: each must be the release currently offered. The plans'
/// SHA-256 is filled in by [`update`] from what [`Published`] names.
fn plans_for(
    snapshot: &Snapshot,
    entries: &[Entry],
    wanted: &[Wanted],
    accept: &BTreeSet<String>,
) -> Result<(Vec<Plan>, Vec<RunItem>, Vec<Published>), RunError> {
    let mut plans = Vec::new();
    let mut items = Vec::new();
    let mut published = Vec::new();
    let mut licenses = Vec::new();
    for want in wanted {
        let entry = entries
            .iter()
            .find(|e| e.package_name == want.package_name)
            .ok_or_else(|| RunError::Invalid(format!("{} is not a Caloptreyx extension", want.package_name)))?;
        let (Some(latest), Some(repo)) = (&entry.latest, &entry.repo) else {
            return Err(RunError::Invalid(format!("{} has no release for this panel", entry.name)));
        };
        if latest.version != want.version {
            return Err(RunError::Invalid(format!(
                "{} {} is not the release offered (that is {}); check again",
                entry.name, want.version, latest.version
            )));
        }
        if !matches!(entry.status, Status::UpdateAvailable | Status::Installable) {
            return Err(RunError::Invalid(format!("{} is already up to date", entry.name)));
        }
        let release = snapshot
            .releases
            .get(repo)
            .and_then(|list| list.iter().find(|r| r.tag_name == latest.tag))
            .ok_or_else(|| RunError::Invalid(format!("{} {} is gone; check again", entry.name, latest.version)))?;
        let archive = catalog::asset_name(&entry.package_name);
        let asset = release
            .asset(&archive)
            .ok_or_else(|| RunError::Invalid(format!("{} {} has no {archive}", entry.name, latest.version)))?;
        let checksum_file = release.checksum_asset(&archive).map(|file| file.name.clone());
        if asset.digest.is_none() && checksum_file.is_none() {
            return Err(RunError::Invalid(format!(
                "{} {}: {}",
                entry.name,
                latest.version,
                trust::TrustError::Missing
            )));
        }
        published.push(Published {
            digest: asset.digest.clone(),
            checksum_file,
        });
        if let Some(license) = &latest.license
            && !accept.contains(&entry.package_name)
        {
            licenses.push(LicenseViewOwned {
                package_name: entry.package_name.clone(),
                name: entry.name.clone(),
                version: latest.version.clone(),
                license: license.clone(),
            });
        }
        let version = Version::parse(&latest.version).map_err(|e| RunError::Invalid(e.to_string()))?;
        plans.push(Plan {
            package_name: entry.package_name.clone(),
            version,
            source: Source::Release {
                repo: repo.clone(),
                tag: release.tag_name.clone(),
                asset: archive,
                sha256: [0; 32],
            },
            accept_license: accept.contains(&entry.package_name),
        });
        items.push(RunItem {
            package_name: entry.package_name.clone(),
            name: entry.name.clone(),
            from: entry.installed.as_ref().map(|i| i.version.clone()),
            to: latest.version.clone(),
            tag: Some(release.tag_name.clone()),
        });
    }
    if !licenses.is_empty() {
        return Err(RunError::NeedsLicense(licenses));
    }
    Ok((plans, items, published))
}

/// Installs the offered releases of `wanted` in one rebuild.
pub async fn update(
    state: &State,
    actor: &Actor,
    wanted: &[Wanted],
    accept_licenses: &[String],
    force: bool,
    automatic: bool,
) -> Result<Started, RunError> {
    if !panel::management(state).available {
        return Err(RunError::Invalid("this panel cannot install extensions".into()));
    }
    if wanted.is_empty() {
        return Err(RunError::Invalid("no extension selected".into()));
    }
    let Ok(_guard) = APPLYING.try_lock() else {
        return Err(RunError::Busy("another update is being installed".into()));
    };
    ensure_idle(state).await?;
    let snapshot = snapshot().await;
    let entries = entries(state, &snapshot).await;
    let accept: BTreeSet<String> = accept_licenses.iter().cloned().collect();
    let (mut plans, items, published) = plans_for(&snapshot, &entries, wanted, &accept)?;

    let settings = settings::load(state).await?;
    let host = PanelHost {
        state,
        github: Github::new(&settings.github_token),
    };
    // the digest and the .sha256 asset must both be valid and agree (trust::expected)
    for (plan, published) in plans.iter_mut().zip(&published) {
        let Source::Release {
            repo,
            tag,
            asset,
            sha256,
        } = &mut plan.source
        else {
            continue;
        };
        let text = match &published.checksum_file {
            Some(file) => Some(host.github.download_text(repo, tag, file).await?),
            None => None,
        };
        *sha256 = trust::expected(published.digest.as_deref(), text.as_deref(), asset)
            .map_err(|err| RunError::Invalid(format!("{}: {err}", plan.package_name)))?;
    }

    start(state, actor, &host, &plans, items, RunKind::Update, force, automatic).await
}

/// Puts back the archive kept for `package_name`, in one rebuild.
pub async fn rollback(state: &State, actor: &Actor, package_name: &str) -> Result<Started, RunError> {
    if !panel::management(state).available {
        return Err(RunError::Invalid("this panel cannot install extensions".into()));
    }
    let Ok(_guard) = APPLYING.try_lock() else {
        return Err(RunError::Busy("another update is being installed".into()));
    };
    ensure_idle(state).await?;
    let kept = store::backup_get(&state.database, package_name)
        .await
        .map_err(anyhow::Error::from)?
        .filter(|kept| !kept.was_absent())
        .ok_or_else(|| RunError::Invalid(format!("no earlier archive of {package_name} was kept")))?;
    let version = Version::parse(&kept.version).map_err(|e| RunError::Invalid(e.to_string()))?;
    let running = panel::running(state).await;
    let current = running.get(package_name);
    let items = vec![RunItem {
        package_name: package_name.to_string(),
        name: current.map_or_else(|| package_name.to_string(), |r| r.name.clone()),
        from: current.map(|r| r.version.to_string()),
        to: kept.version.clone(),
        tag: None,
    }];
    let plans = vec![Plan {
        package_name: package_name.to_string(),
        version,
        source: Source::Kept,
        // it was installed here before, its license accepted then
        accept_license: true,
    }];
    let settings = settings::load(state).await?;
    let host = PanelHost {
        state,
        github: Github::new(&settings.github_token),
    };
    start(state, actor, &host, &plans, items, RunKind::Rollback, false, false).await
}

#[allow(clippy::too_many_arguments)]
async fn start(
    state: &State,
    actor: &Actor,
    host: &PanelHost<'_>,
    plans: &[Plan],
    items: Vec<RunItem>,
    kind: RunKind,
    force: bool,
    automatic: bool,
) -> Result<Started, RunError> {
    let id = store::run_insert(&state.database, actor.user_uuid, automatic, kind, &items).await?;
    let outcome = pipeline::apply(host, plans, force).await;
    let rebuild = match outcome {
        Ok(rebuild) => rebuild,
        Err(err) => {
            let message = err.to_string();
            store::run_finish(&state.database, id, RunState::Failed, Some(&message), &[]).await?;
            return Err(match err {
                ApplyError::NeedsLicense(packages) => RunError::NeedsLicense(
                    packages
                        .into_iter()
                        .map(|package_name| LicenseViewOwned {
                            name: package_name.clone(),
                            package_name,
                            version: String::new(),
                            license: "The archive carries a license; accept it to install.".into(),
                        })
                        .collect(),
                ),
                ApplyError::Refused { .. } => RunError::Invalid(message),
                ApplyError::Failed(_) => RunError::Failed(message),
            });
        }
    };
    let (build_id, after) = match rebuild {
        Rebuild::Accepted { build_id } => (Some(build_id), None),
        Rebuild::Queued { behind } => (None, Some(behind)),
    };
    store::run_set_build(&state.database, id, build_id, after).await?;

    for item in &items {
        actor
            .log(
                state,
                "extension:upload",
                serde_json::json!({
                    "package_name": item.package_name,
                    "name": item.name,
                    "version": item.to,
                    "previous_version": item.from,
                    "release": item.tag,
                    "rollback": kind == RunKind::Rollback,
                    "automatic": automatic,
                    "via": crate::PACKAGE,
                }),
            )
            .await;
    }
    if let Some(build_id) = build_id {
        actor
            .log(
                state,
                "extension:rebuild",
                serde_json::json!({ "build_id": build_id, "force": force, "via": crate::PACKAGE }),
            )
            .await;
    }

    let run = store::runs_recent(&state.database, 10)
        .await
        .map_err(anyhow::Error::from)?
        .into_iter()
        .find(|run| run.id == id)
        .ok_or_else(|| RunError::Failed("the run disappeared".into()))?;
    Ok(Started { run, build_id })
}

/// Installs what automatic updates may install: offered updates that are verified, carry no
/// license and fit this panel, except versions whose run failed before.
async fn auto_update(state: &State) -> anyhow::Result<()> {
    let snapshot = check(state, Mode::Scheduled).await?;
    let failed: BTreeSet<(String, String)> = store::runs_recent(&state.database, 50)
        .await?
        .into_iter()
        .filter(|run| matches!(run.state, RunState::Failed | RunState::Unknown))
        .flat_map(|run| run.items.into_iter().map(|item| (item.package_name, item.to)))
        .collect();
    let wanted: Vec<Wanted> = entries(state, &snapshot)
        .await
        .into_iter()
        .filter(|entry| entry.status == Status::UpdateAvailable)
        .filter_map(|entry| {
            let latest = entry.latest?;
            (latest.verified
                && latest.license.is_none()
                && !failed.contains(&(entry.package_name.clone(), latest.version.clone())))
            .then(|| Wanted {
                package_name: entry.package_name,
                version: latest.version,
            })
        })
        .collect();
    if wanted.is_empty() {
        return Ok(());
    }
    let names: Vec<String> = wanted
        .iter()
        .map(|w| format!("{} {}", w.package_name, w.version))
        .collect();
    tracing::info!("extension updater: installing {} automatically", names.join(", "));
    match update(state, &Actor::AUTOMATIC, &wanted, &[], false, true).await {
        Ok(_) => Ok(()),
        Err(err) => anyhow::bail!("automatic update: {err:?}"),
    }
}

async fn due(state: &State, key: &str) -> Option<DateTime<Utc>> {
    store::cache_get(&state.database, key)
        .await
        .ok()
        .flatten()
        .map(|cached| cached.updated)
}

/// One pass of the background task: follow runs, check on schedule, update automatically.
pub async fn tick(state: &State, first: bool) -> anyhow::Result<()> {
    if first {
        let _ = LazyLock::force(&runs::BOOTED);
        let has_cache = store::cache_get(&state.database, REPOS_KEY).await?.is_some();
        check(state, if has_cache { Mode::Startup } else { Mode::Scheduled }).await?;
    }
    runs::reconcile(state).await?;

    let settings: Settings = settings::load(state).await?;
    let last = last_check(state).await.map(|c| c.at);
    if last.is_none_or(|at| (Utc::now() - at).num_hours() >= i64::from(settings.check_interval_hours)) {
        if let Err(err) = check(state, Mode::Scheduled).await {
            tracing::warn!("extension updater: scheduled check: {err:#}");
        }
    }

    if settings.auto_update && panel::management(state).available {
        let now = chrono::Local::now();
        let today = now.date_naive();
        let last_auto = due(state, LAST_AUTO_KEY)
            .await
            .map(|at| at.with_timezone(&chrono::Local).date_naive());
        if now.hour() == settings.auto_update_hour && last_auto != Some(today) {
            store::cache_put(&state.database, LAST_AUTO_KEY, None, None, &today.to_string()).await?;
            if let Err(err) = auto_update(state).await {
                tracing::warn!("extension updater: {err:#}");
            }
        }
    }
    let _ = store::runs_prune(&state.database).await;
    Ok(())
}

/// The background task: a pass every minute.
pub async fn background(state: State) -> anyhow::Result<()> {
    static FIRST: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);
    let first = FIRST.swap(false, std::sync::atomic::Ordering::Relaxed);
    let result = tick(&state, first).await;
    tokio::time::sleep(Duration::from_secs(60)).await;
    result
}
