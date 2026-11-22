//! Installing several archives with one rebuild. Every archive is downloaded, verified, staged and
//! checked before the first one replaces anything; then each installed archive's predecessor is
//! kept, the archives are installed, and the supervisor is asked for exactly one rebuild. When an
//! install or the rebuild request fails, the archives already replaced are put back. The side
//! effects sit behind [`Host`], so the order is tested without a panel.

use crate::{catalog, trust::Sha256};
use semver::{Version, VersionReq};

/// Where an archive comes from.
#[derive(Clone, Debug, PartialEq)]
pub enum Source {
    /// A release asset with the SHA-256 it must have.
    Release {
        repo: String,
        tag: String,
        asset: String,
        sha256: Sha256,
    },
    /// The archive the updater kept before the last update (a rollback).
    Kept,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub package_name: String,
    pub version: Version,
    pub source: Source,
    pub accept_license: bool,
}

/// What a staged archive says about itself.
#[derive(Clone, Debug, PartialEq)]
pub struct StagedInfo {
    pub package_name: String,
    pub version: Version,
    pub panel_version: VersionReq,
    pub license: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rebuild {
    Accepted { build_id: u64 },
    /// The supervisor was already building; it builds again after `behind`, with these archives.
    Queued { behind: u64 },
}

#[async_trait::async_trait]
pub trait Host: Send + Sync {
    type Staged: Send;

    /// The panel version the rebuild targets.
    async fn target_version(&self) -> Version;
    /// Fetches the archive for `plan` (checking its SHA-256) and stages it.
    async fn stage(&self, plan: &Plan) -> anyhow::Result<(StagedInfo, Self::Staged)>;
    /// Keeps the archive now installed for `package_name` (or that there was none).
    async fn keep(&self, package_name: &str) -> anyhow::Result<()>;
    async fn install(&self, staged: Self::Staged) -> anyhow::Result<()>;
    /// Puts back what `keep` kept for `package_name`.
    async fn restore(&self, package_name: &str) -> anyhow::Result<()>;
    async fn rebuild(&self, force: bool) -> anyhow::Result<Rebuild>;
}

#[derive(Debug)]
pub enum ApplyError {
    /// Nothing was changed: `package_name` cannot be installed.
    Refused { package_name: String, reason: String },
    /// Nothing was changed: these archives carry a license nobody accepted.
    NeedsLicense(Vec<String>),
    /// Installing or asking for the rebuild failed; what was installed has been put back.
    Failed(anyhow::Error),
}

impl std::fmt::Display for ApplyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused {
                package_name,
                reason,
            } => write!(f, "{package_name}: {reason}"),
            Self::NeedsLicense(packages) => {
                write!(f, "the license of {} must be accepted first", packages.join(", "))
            }
            Self::Failed(err) => write!(f, "{err:#}"),
        }
    }
}

enum Refusal {
    License,
    Other(String),
}

/// The same checks the panel's upload route makes, plus that the archive is the package and
/// version the release promised.
fn check(plan: &Plan, info: &StagedInfo, target: &Version) -> Result<(), Refusal> {
    if info.package_name != plan.package_name {
        return Err(Refusal::Other(format!(
            "the archive holds {}, not {}",
            info.package_name, plan.package_name
        )));
    }
    if info.version != plan.version {
        return Err(Refusal::Other(format!(
            "the archive holds version {}, the release is {}",
            info.version, plan.version
        )));
    }
    if let Err(err) = catalog::fits_panel(&info.panel_version, Some(target)) {
        return Err(Refusal::Other(format!("the extension {err}")));
    }
    if info.license && !plan.accept_license {
        return Err(Refusal::License);
    }
    Ok(())
}

pub async fn apply<H: Host>(host: &H, plans: &[Plan], force: bool) -> Result<Rebuild, ApplyError> {
    if plans.is_empty() {
        return Err(ApplyError::Failed(anyhow::anyhow!("nothing to install")));
    }
    for (index, plan) in plans.iter().enumerate() {
        if plans[..index]
            .iter()
            .any(|other| other.package_name == plan.package_name)
        {
            return Err(ApplyError::Refused {
                package_name: plan.package_name.clone(),
                reason: "listed twice".into(),
            });
        }
    }

    let target = host.target_version().await;
    let mut staged = Vec::with_capacity(plans.len());
    let mut needs_license = Vec::new();
    for plan in plans {
        let (info, handle) = host.stage(plan).await.map_err(|err| ApplyError::Refused {
            package_name: plan.package_name.clone(),
            reason: format!("{err:#}"),
        })?;
        match check(plan, &info, &target) {
            Ok(()) => staged.push((plan, handle)),
            Err(Refusal::License) => needs_license.push(plan.package_name.clone()),
            Err(Refusal::Other(reason)) => {
                return Err(ApplyError::Refused {
                    package_name: plan.package_name.clone(),
                    reason,
                });
            }
        }
    }
    if !needs_license.is_empty() {
        return Err(ApplyError::NeedsLicense(needs_license));
    }

    let mut kept: Vec<&str> = Vec::with_capacity(staged.len());
    for (plan, handle) in staged {
        let installed = match host.keep(&plan.package_name).await {
            Ok(()) => {
                kept.push(&plan.package_name);
                host.install(handle).await
            }
            Err(err) => Err(err),
        };
        if let Err(err) = installed {
            put_back(host, &kept).await;
            return Err(ApplyError::Failed(
                err.context(format!("installing {}", plan.package_name)),
            ));
        }
    }

    match host.rebuild(force).await {
        Ok(rebuild) => Ok(rebuild),
        Err(err) => {
            put_back(host, &kept).await;
            Err(ApplyError::Failed(err.context("asking the supervisor to rebuild")))
        }
    }
}

/// Puts back the kept archives, newest change first. Errors are logged: the caller already
/// reports the failure that led here.
pub async fn put_back<H: Host>(host: &H, packages: &[&str]) {
    for package_name in packages.iter().rev() {
        if let Err(err) = host.restore(package_name).await {
            tracing::error!("extension updater: could not put back {package_name}: {err:#}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Records every side effect; `fail` names steps that fail, like `stage:b` or `rebuild`.
    struct FakeHost {
        infos: Vec<StagedInfo>,
        fail: Vec<String>,
        events: Mutex<Vec<String>>,
    }

    impl FakeHost {
        fn new(infos: Vec<StagedInfo>, fail: &[&str]) -> Self {
            Self {
                infos,
                fail: fail.iter().map(|s| s.to_string()).collect(),
                events: Mutex::new(Vec::new()),
            }
        }

        fn step(&self, step: String) -> anyhow::Result<()> {
            self.events.lock().unwrap().push(step.clone());
            if self.fail.contains(&step) {
                anyhow::bail!("{step} failed");
            }
            Ok(())
        }

        fn events(&self) -> Vec<String> {
            self.events.lock().unwrap().clone()
        }
    }

    #[async_trait::async_trait]
    impl Host for FakeHost {
        type Staged = String;

        async fn target_version(&self) -> Version {
            Version::new(1, 2, 10)
        }

        async fn stage(&self, plan: &Plan) -> anyhow::Result<(StagedInfo, String)> {
            self.step(format!("stage:{}", plan.package_name))?;
            // archives are staged in plan order
            let index = self.events().iter().filter(|e| e.starts_with("stage:")).count() - 1;
            let info = self.infos[index].clone();
            Ok((info, plan.package_name.clone()))
        }

        async fn keep(&self, package_name: &str) -> anyhow::Result<()> {
            self.step(format!("keep:{package_name}"))
        }

        async fn install(&self, staged: String) -> anyhow::Result<()> {
            self.step(format!("install:{staged}"))
        }

        async fn restore(&self, package_name: &str) -> anyhow::Result<()> {
            self.step(format!("restore:{package_name}"))
        }

        async fn rebuild(&self, force: bool) -> anyhow::Result<Rebuild> {
            self.step(format!("rebuild:{force}"))?;
            Ok(Rebuild::Accepted { build_id: 7 })
        }
    }

    fn info(package: &str, version: &str) -> StagedInfo {
        StagedInfo {
            package_name: package.into(),
            version: Version::parse(version).unwrap(),
            panel_version: VersionReq::parse(">=1.2.10").unwrap(),
            license: false,
        }
    }

    fn plan(package: &str, version: &str) -> Plan {
        Plan {
            package_name: package.into(),
            version: Version::parse(version).unwrap(),
            source: Source::Release {
                repo: "Repo".into(),
                tag: format!("v{version}"),
                asset: catalog::asset_name(package),
                sha256: [0; 32],
            },
            accept_license: false,
        }
    }

    const A: &str = "dev.caloptreyx.a";
    const B: &str = "dev.caloptreyx.b";

    #[tokio::test]
    async fn several_updates_share_one_rebuild_after_all_are_staged() {
        let host = FakeHost::new(vec![info(A, "1.1.0"), info(B, "2.0.0")], &[]);
        let result = apply(&host, &[plan(A, "1.1.0"), plan(B, "2.0.0")], false).await;
        assert_eq!(result.unwrap(), Rebuild::Accepted { build_id: 7 });
        assert_eq!(
            host.events(),
            [
                "stage:dev.caloptreyx.a",
                "stage:dev.caloptreyx.b",
                "keep:dev.caloptreyx.a",
                "install:dev.caloptreyx.a",
                "keep:dev.caloptreyx.b",
                "install:dev.caloptreyx.b",
                "rebuild:false",
            ]
        );
    }

    #[tokio::test]
    async fn a_bad_archive_changes_nothing() {
        // the second download fails its checksum
        let host = FakeHost::new(vec![info(A, "1.1.0"), info(B, "2.0.0")], &["stage:dev.caloptreyx.b"]);
        let result = apply(&host, &[plan(A, "1.1.0"), plan(B, "2.0.0")], false).await;
        assert!(matches!(&result, Err(ApplyError::Refused { package_name, .. }) if package_name == B));
        assert_eq!(host.events(), ["stage:dev.caloptreyx.a", "stage:dev.caloptreyx.b"]);

        // an archive of another package, another version, or for a newer panel
        for (staged, reason) in [
            (info("dev.caloptreyx.xb", "2.0.0"), "holds dev.caloptreyx.xb"),
            (info(B, "2.0.1"), "holds version 2.0.1"),
            (
                StagedInfo {
                    panel_version: VersionReq::parse(">=1.3.0").unwrap(),
                    ..info(B, "2.0.0")
                },
                "requires panel version",
            ),
        ] {
            let host = FakeHost::new(vec![info(A, "1.1.0"), staged], &[]);
            let result = apply(&host, &[plan(A, "1.1.0"), plan(B, "2.0.0")], false).await;
            match result {
                Err(ApplyError::Refused { reason: got, .. }) => assert!(got.contains(reason), "{got}"),
                other => panic!("{other:?}"),
            }
            assert!(host.events().iter().all(|event| event.starts_with("stage:")));
        }
    }

    #[tokio::test]
    async fn licenses_must_be_accepted_before_anything_installs() {
        let licensed = StagedInfo {
            license: true,
            ..info(B, "2.0.0")
        };
        let host = FakeHost::new(vec![info(A, "1.1.0"), licensed.clone()], &[]);
        let result = apply(&host, &[plan(A, "1.1.0"), plan(B, "2.0.0")], false).await;
        assert!(matches!(&result, Err(ApplyError::NeedsLicense(p)) if p == &[B.to_string()]));
        assert!(!host.events().iter().any(|event| event.starts_with("install:")));

        let host = FakeHost::new(vec![info(A, "1.1.0"), licensed], &[]);
        let accepted = Plan {
            accept_license: true,
            ..plan(B, "2.0.0")
        };
        assert!(apply(&host, &[plan(A, "1.1.0"), accepted], true).await.is_ok());
        assert_eq!(host.events().last().unwrap(), "rebuild:true");
    }

    #[tokio::test]
    async fn a_failed_install_or_rebuild_request_puts_everything_back() {
        let host = FakeHost::new(vec![info(A, "1.1.0"), info(B, "2.0.0")], &["install:dev.caloptreyx.b"]);
        let result = apply(&host, &[plan(A, "1.1.0"), plan(B, "2.0.0")], false).await;
        assert!(matches!(result, Err(ApplyError::Failed(_))));
        let events = host.events();
        assert_eq!(
            &events[events.len() - 2..],
            ["restore:dev.caloptreyx.b", "restore:dev.caloptreyx.a"]
        );
        assert!(!events.iter().any(|event| event.starts_with("rebuild")));

        let host = FakeHost::new(vec![info(A, "1.1.0"), info(B, "2.0.0")], &["rebuild:false"]);
        let result = apply(&host, &[plan(A, "1.1.0"), plan(B, "2.0.0")], false).await;
        assert!(matches!(result, Err(ApplyError::Failed(_))));
        let events = host.events();
        assert_eq!(
            &events[events.len() - 2..],
            ["restore:dev.caloptreyx.b", "restore:dev.caloptreyx.a"]
        );
    }

    #[tokio::test]
    async fn a_package_twice_is_refused() {
        let host = FakeHost::new(vec![info(A, "1.1.0")], &[]);
        let result = apply(&host, &[plan(A, "1.1.0"), plan(A, "1.1.0")], false).await;
        assert!(matches!(result, Err(ApplyError::Refused { .. })));
        assert!(host.events().is_empty());
    }
}
