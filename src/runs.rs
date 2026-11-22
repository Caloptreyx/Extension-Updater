//! Following a run to its end. The supervisor builds the whole panel, verifies the build and only
//! then installs it and restarts the panel; a failed build leaves the running panel as it was but
//! the new archives in the extensions folder. So: when the panel runs every target version, the
//! run succeeded; when the supervisor reports our build (or a later one) failed, the previous
//! archives are put back, which makes the folder match the running panel again (no restart).

use crate::{
    panel,
    store::{self, Run, RunState},
};
use chrono::{DateTime, Utc};
use shared::{
    State,
    heavy::{Status, SupervisorState},
};
use std::sync::LazyLock;

/// When this panel process started; forced when the extension initializes.
pub static BOOTED: LazyLock<DateTime<Utc>> = LazyLock::new(Utc::now);

/// Runs that did not end after this long are given up on.
const GIVE_UP_HOURS: i64 = 6;

#[derive(Clone, Debug, PartialEq)]
pub enum Verdict {
    Wait,
    Succeeded,
    Failed {
        reason: String,
        failed_extensions: Vec<String>,
    },
    Unknown(String),
}

pub struct Seen<'a> {
    /// The panel runs every target version of the run.
    pub installed: bool,
    pub status: Option<&'a Status>,
    pub booted: DateTime<Utc>,
    pub now: DateTime<Utc>,
}

pub fn judge(run: &Run, seen: &Seen) -> Verdict {
    if seen.installed {
        return Verdict::Succeeded;
    }
    let give_up = seen.now - run.created > chrono::Duration::hours(GIVE_UP_HOURS);
    let Some(status) = seen.status else {
        return if give_up {
            Verdict::Unknown("the supervisor could not be asked how the rebuild ended".into())
        } else {
            Verdict::Wait
        };
    };
    // our build, or a later one (which built our archives too)
    let ours = match (run.build_id, run.after_build_id, status.build_id) {
        (Some(id), _, Some(current)) => current as i64 >= id,
        (None, Some(after), Some(current)) => current as i64 > after,
        _ => false,
    };
    if ours {
        match status.state {
            SupervisorState::Failed => {
                return Verdict::Failed {
                    reason: status
                        .failure_reason
                        .clone()
                        .unwrap_or_else(|| "the rebuild failed".into()),
                    failed_extensions: status.failed_extensions.clone(),
                };
            }
            SupervisorState::Succeeded => {
                // built before this panel started, yet the panel runs other versions: the new
                // build did not come up and the supervisor went back to the previous one
                let finished = status
                    .finished_at
                    .as_deref()
                    .and_then(|at| DateTime::parse_from_rfc3339(at).ok());
                if finished.is_some_and(|finished| finished.with_timezone(&Utc) < seen.booted) {
                    return Verdict::Failed {
                        reason: "the rebuilt panel did not start, so the supervisor kept the previous build".into(),
                        failed_extensions: Vec::new(),
                    };
                }
            }
            _ => {}
        }
    }
    if give_up {
        Verdict::Unknown("the rebuild did not finish within six hours".into())
    } else {
        Verdict::Wait
    }
}

/// Checks every open run once. Cheap when none is open (one query).
pub async fn reconcile(state: &State) -> anyhow::Result<()> {
    let open = store::runs_open(&state.database).await?;
    if open.is_empty() {
        return Ok(());
    }
    let running = panel::running(state).await;
    let status = panel::supervisor(state).await;
    let booted = *BOOTED;
    for run in open {
        let installed = run.items.iter().all(|item| {
            running
                .get(&item.package_name)
                .is_some_and(|r| r.version.to_string() == item.to)
        });
        let verdict = judge(
            &run,
            &Seen {
                installed,
                status: status.as_ref(),
                booted,
                now: Utc::now(),
            },
        );
        match verdict {
            Verdict::Wait => {}
            Verdict::Succeeded => {
                store::run_finish(&state.database, run.id, RunState::Succeeded, None, &[]).await?;
            }
            Verdict::Failed {
                reason,
                failed_extensions,
            } => {
                let restored = put_back(state, &run).await;
                let message = if restored.is_empty() {
                    reason
                } else {
                    format!("{reason} (put back: {})", restored.join(", "))
                };
                store::run_finish(
                    &state.database,
                    run.id,
                    RunState::Failed,
                    Some(&message),
                    &failed_extensions,
                )
                .await?;
                tracing::warn!("extension updater: run {} failed: {message}", run.id);
            }
            Verdict::Unknown(reason) => {
                store::run_finish(&state.database, run.id, RunState::Unknown, Some(&reason), &[])
                    .await?;
            }
        }
    }
    Ok(())
}

/// Puts back the archives a failed run replaced, unless somebody changed them since. Returns
/// the names put back.
async fn put_back(state: &State, run: &Run) -> Vec<String> {
    let mut restored = Vec::new();
    for item in run.items.iter().rev() {
        let current = match panel::installed_archive(&item.package_name).await {
            Ok(current) => current.map(|(version, _)| version.to_string()),
            Err(err) => {
                tracing::error!(
                    "extension updater: reading the archive of {}: {err:#}",
                    item.package_name
                );
                continue;
            }
        };
        if current.as_deref() != Some(item.to.as_str()) {
            continue;
        }
        match panel::restore_kept(state, &item.package_name).await {
            Ok(()) => restored.push(match &item.from {
                Some(from) => format!("{} {from}", item.name),
                None => format!("{} removed", item.name),
            }),
            Err(err) => tracing::error!(
                "extension updater: putting back {}: {err:#}",
                item.package_name
            ),
        }
    }
    restored
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{RunItem, RunKind};
    use shared::heavy::BuildPhase;

    fn run(build_id: Option<i64>, after: Option<i64>) -> Run {
        Run {
            id: 1,
            user_uuid: None,
            automatic: false,
            kind: RunKind::Update,
            items: vec![RunItem {
                package_name: "dev.caloptreyx.worldmap".into(),
                name: "World Map".into(),
                from: Some("0.1.1".into()),
                to: "0.1.2".into(),
                tag: Some("v0.1.2".into()),
            }],
            build_id,
            after_build_id: after,
            state: RunState::Building,
            message: None,
            failed_extensions: Vec::new(),
            created: "2026-11-22T10:00:00Z".parse().unwrap(),
            finished: None,
        }
    }

    fn status(build_id: u64, state: SupervisorState, finished_at: Option<&str>) -> Status {
        Status {
            state,
            panel_version: "1.2.10".into(),
            cache_key: "k".into(),
            bin_name: "panel-rs".into(),
            build_id: Some(build_id),
            started_at: None,
            finished_at: finished_at.map(str::to_string),
            exit_code: Some(101),
            failure_reason: Some("cargo build exited with code 101".into()),
            failed_extensions: vec!["dev.caloptreyx.worldmap".into()],
            log_len: 0,
        }
    }

    fn at(text: &str) -> DateTime<Utc> {
        text.parse().unwrap()
    }

    fn seen<'a>(installed: bool, status: Option<&'a Status>, now: &str) -> Seen<'a> {
        Seen {
            installed,
            status,
            booted: at("2026-11-22T09:00:00Z"),
            now: at(now),
        }
    }

    #[test]
    fn a_run_succeeds_when_the_panel_runs_its_versions() {
        let building = status(5, SupervisorState::Building { phase: BuildPhase::Building }, None);
        assert_eq!(judge(&run(Some(5), None), &seen(true, None, "2026-11-22T10:05:00Z")), Verdict::Succeeded);
        assert_eq!(
            judge(&run(Some(5), None), &seen(false, Some(&building), "2026-11-22T10:05:00Z")),
            Verdict::Wait
        );
        // built and about to restart
        let done = status(5, SupervisorState::Succeeded, Some("2026-11-22T10:06:00Z"));
        assert_eq!(judge(&run(Some(5), None), &seen(false, Some(&done), "2026-11-22T10:06:10Z")), Verdict::Wait);
    }

    #[test]
    fn a_failed_build_fails_the_run_with_the_supervisors_reason() {
        let failed = status(5, SupervisorState::Failed, Some("2026-11-22T10:09:00Z"));
        match judge(&run(Some(5), None), &seen(false, Some(&failed), "2026-11-22T10:10:00Z")) {
            Verdict::Failed { reason, failed_extensions } => {
                assert!(reason.contains("101"));
                assert_eq!(failed_extensions, ["dev.caloptreyx.worldmap"]);
            }
            other => panic!("{other:?}"),
        }
        // an older build's failure is not ours
        assert_eq!(judge(&run(Some(6), None), &seen(false, Some(&failed), "2026-11-22T10:10:00Z")), Verdict::Wait);
        // queued behind build 4: build 5 is ours
        assert!(matches!(
            judge(&run(None, Some(4)), &seen(false, Some(&failed), "2026-11-22T10:10:00Z")),
            Verdict::Failed { .. }
        ));
        assert_eq!(judge(&run(None, Some(5)), &seen(false, Some(&failed), "2026-11-22T10:10:00Z")), Verdict::Wait);
    }

    #[test]
    fn a_build_that_did_not_come_up_and_lost_runs_end() {
        // succeeded before this panel booted, but the panel runs the old versions
        let stale = status(5, SupervisorState::Succeeded, Some("2026-11-22T08:59:00Z"));
        assert!(matches!(
            judge(&run(Some(5), None), &seen(false, Some(&stale), "2026-11-22T10:10:00Z")),
            Verdict::Failed { .. }
        ));
        assert!(matches!(
            judge(&run(Some(5), None), &seen(false, None, "2026-11-22T17:00:00Z")),
            Verdict::Unknown(_)
        ));
        assert_eq!(judge(&run(Some(5), None), &seen(false, None, "2026-11-22T11:00:00Z")), Verdict::Wait);
    }
}
