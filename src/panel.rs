//! The panel side: whether this panel can install extensions, the versions it runs, and the
//! [`Host`] that installs archives through `shared::heavy`, the same functions the panel's own
//! upload and rebuild routes use.

use crate::{
    github::Github,
    pipeline::{Host, Plan, Rebuild, Source, StagedInfo},
    store,
    trust::{self, Sha256},
};
use anyhow::{Context, bail};
use semver::Version;
use serde::Serialize;
use sha2::{Digest, Sha256 as Hasher};
use shared::{
    State,
    extensions::distr::{ExtensionDistrFile, MetadataToml},
    heavy,
};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

/// Whether this panel can install extensions, mirroring `State::ensure_extension_management`.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Management {
    pub available: bool,
    /// `not_heavy` or `disabled` when not available.
    pub reason: Option<&'static str>,
}

pub fn management(state: &State) -> Management {
    if !state.container_type.is_heavy() {
        Management {
            available: false,
            reason: Some("not_heavy"),
        }
    } else if state.env.app_disable_extension_management {
        Management {
            available: false,
            reason: Some("disabled"),
        }
    } else {
        Management {
            available: true,
            reason: None,
        }
    }
}

static TARGET: LazyLock<Mutex<Option<(Instant, Version)>>> = LazyLock::new(|| Mutex::new(None));

/// The panel version extensions are built into: the supervisor's on heavy panels (asked at
/// most once a minute), else the running one.
pub async fn target_version(state: &State) -> Version {
    if !management(state).available {
        return shared::extensions::distr::running_panel_version();
    }
    let cached = TARGET.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some((at, version)) = cached
        && at.elapsed() < Duration::from_secs(60)
    {
        return version;
    }
    let version = heavy::build_target_version().await;
    *TARGET.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), version.clone()));
    version
}

/// The supervisor's status, `None` when it cannot be asked.
pub async fn supervisor(state: &State) -> Option<heavy::Status> {
    if !management(state).available {
        return None;
    }
    match heavy::ask(&heavy::Request::GetStatus).await {
        Ok(heavy::Response::Status(status)) => Some(status),
        Ok(answer) => {
            tracing::warn!("extension updater: the supervisor answered a status request with {answer:?}");
            None
        }
        Err(err) => {
            tracing::warn!("extension updater: the supervisor could not be reached: {err}");
            None
        }
    }
}

/// A compiled-in extension.
#[derive(Clone, Debug, Serialize)]
pub struct Running {
    pub name: String,
    pub version: Version,
    pub disabled: bool,
}

/// Every extension compiled into the running panel, by package name.
pub async fn running(state: &State) -> BTreeMap<String, Running> {
    state
        .extensions
        .extensions()
        .await
        .iter()
        .map(|extension| {
            (
                extension.metadata_toml.package_name.clone(),
                Running {
                    name: extension.metadata_toml.name.clone(),
                    version: extension.version.clone(),
                    disabled: state.extensions.is_disabled(extension.package_name),
                },
            )
        })
        .collect()
}

fn archive_path(package_name: &str) -> PathBuf {
    PathBuf::from(heavy::EXTENSION_DIR).join(format!(
        "{}.c7s.zip",
        MetadataToml::convert_package_name_to_identifier(package_name)
    ))
}

/// The version in the archive installed for `package_name`, `None` when there is none.
pub async fn installed_archive(package_name: &str) -> anyhow::Result<Option<(Version, Vec<u8>)>> {
    let path = archive_path(package_name);
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err).with_context(|| format!("reading {}", path.display())),
    };
    let file = tokio::fs::File::open(&path).await?.into_std().await;
    let distr = tokio::task::spawn_blocking(move || ExtensionDistrFile::parse_from_reader(file))
        .await??;
    Ok(Some((distr.cargo_toml.package.version, bytes)))
}

async fn temp_file_with(bytes: &[u8]) -> anyhow::Result<tokio::fs::File> {
    let mut file = tokio::fs::File::from_std(tempfile::tempfile()?);
    file.write_all(bytes).await?;
    file.flush().await?;
    file.seek(std::io::SeekFrom::Start(0)).await?;
    Ok(file)
}

fn sha256(bytes: &[u8]) -> Sha256 {
    Hasher::digest(bytes).into()
}

/// Writes `bytes` as the archive of `package_name`: a temporary name first, then a rename, so the
/// supervisor never sees half an archive.
async fn write_archive(package_name: &str, bytes: &[u8]) -> anyhow::Result<()> {
    let path = archive_path(package_name);
    let temp = PathBuf::from(heavy::EXTENSION_DIR).join(format!(
        ".updater-{}.tmp",
        MetadataToml::convert_package_name_to_identifier(package_name)
    ));
    tokio::fs::write(&temp, bytes)
        .await
        .with_context(|| format!("writing {}", temp.display()))?;
    tokio::fs::rename(&temp, &path)
        .await
        .with_context(|| format!("replacing {}", path.display()))?;
    Ok(())
}

/// Puts back the archive kept for `package_name`, or removes the archive when the extension was
/// not installed before.
pub async fn restore_kept(state: &State, package_name: &str) -> anyhow::Result<()> {
    let kept = store::backup_get(&state.database, package_name)
        .await?
        .with_context(|| format!("no archive of {package_name} was kept"))?;
    if kept.was_absent() {
        match heavy::remove_extension(package_name).await {
            Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err.into()),
            _ => Ok(()),
        }
    } else {
        if hex::encode(sha256(&kept.archive)) != kept.sha256 {
            bail!("the kept archive of {package_name} is damaged");
        }
        write_archive(package_name, &kept.archive).await
    }
}

pub struct PanelHost<'a> {
    pub state: &'a State,
    pub github: Github,
}

impl PanelHost<'_> {
    async fn fetch(&self, plan: &Plan) -> anyhow::Result<tokio::fs::File> {
        match &plan.source {
            Source::Release {
                repo,
                tag,
                asset,
                sha256,
            } => {
                let (file, actual) = self.github.download(repo, tag, asset).await?;
                trust::verify(&actual, sha256)?;
                Ok(file)
            }
            Source::Kept => {
                let kept = store::backup_get(&self.state.database, &plan.package_name)
                    .await?
                    .filter(|kept| !kept.was_absent())
                    .context("no earlier archive was kept")?;
                if hex::encode(sha256(&kept.archive)) != kept.sha256 {
                    bail!("the kept archive is damaged");
                }
                temp_file_with(&kept.archive).await
            }
        }
    }
}

#[async_trait::async_trait]
impl Host for PanelHost<'_> {
    type Staged = heavy::StagedExtension;

    async fn target_version(&self) -> Version {
        target_version(self.state).await
    }

    async fn stage(&self, plan: &Plan) -> anyhow::Result<(StagedInfo, heavy::StagedExtension)> {
        let mut file = self.fetch(plan).await?;
        let staged = heavy::stage_extension(&mut file)
            .await
            .context("reading the extension archive")?;
        let metadata = &staged.distr.metadata_toml;
        let info = StagedInfo {
            package_name: metadata.package_name.clone(),
            version: staged.distr.cargo_toml.package.version.clone(),
            panel_version: metadata.panel_version.clone(),
            license: metadata.license_text.is_some(),
        };
        Ok((info, staged))
    }

    async fn keep(&self, package_name: &str) -> anyhow::Result<()> {
        match installed_archive(package_name).await? {
            Some((version, bytes)) => {
                store::backup_put(
                    &self.state.database,
                    package_name,
                    &version.to_string(),
                    &bytes,
                    &hex::encode(sha256(&bytes)),
                )
                .await?
            }
            None => {
                store::backup_put(
                    &self.state.database,
                    package_name,
                    "",
                    &[],
                    &hex::encode(sha256(&[])),
                )
                .await?
            }
        }
        Ok(())
    }

    async fn install(&self, staged: heavy::StagedExtension) -> anyhow::Result<()> {
        staged.install().await?;
        Ok(())
    }

    async fn restore(&self, package_name: &str) -> anyhow::Result<()> {
        restore_kept(self.state, package_name).await
    }

    async fn rebuild(&self, force: bool) -> anyhow::Result<Rebuild> {
        match heavy::ask(&heavy::Request::RequestRebuild { force })
            .await
            .context("the extension supervisor could not be reached")?
        {
            heavy::Response::RebuildAccepted { build_id } => Ok(Rebuild::Accepted { build_id }),
            heavy::Response::RebuildAlreadyRunning { build_id } => {
                Ok(Rebuild::Queued { behind: build_id })
            }
            answer => bail!("the extension supervisor answered the rebuild request with {answer:?}"),
        }
    }
}
