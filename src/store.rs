//! The updater's tables: cached GitHub answers and scheduling state, the archives kept for
//! rollback, update runs, and the extensions whose updates are off.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use shared::database::Database;
use std::collections::{BTreeMap, BTreeSet};

pub struct Cached {
    pub etag: Option<String>,
    pub fingerprint: Option<String>,
    pub value: String,
    pub updated: DateTime<Utc>,
}

pub async fn cache_get(db: &Database, key: &str) -> Result<Option<Cached>, sqlx::Error> {
    let row: Option<(Option<String>, Option<String>, String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT etag, fingerprint, value, updated FROM dev_caloptreyx_updater_cache WHERE key = $1",
    )
    .bind(key)
    .fetch_optional(db.read())
    .await?;
    Ok(row.map(|(etag, fingerprint, value, updated)| Cached {
        etag,
        fingerprint,
        value,
        updated,
    }))
}

pub async fn cache_put(
    db: &Database,
    key: &str,
    etag: Option<&str>,
    fingerprint: Option<&str>,
    value: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO dev_caloptreyx_updater_cache (key, etag, fingerprint, value, updated)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (key) DO UPDATE SET
             etag = EXCLUDED.etag, fingerprint = EXCLUDED.fingerprint, value = EXCLUDED.value,
             updated = now()",
    )
    .bind(key)
    .bind(etag)
    .bind(fingerprint)
    .bind(value)
    .execute(db.write())
    .await?;
    Ok(())
}

/// Marks a cached answer as confirmed now (an unchanged feed or a 304).
pub async fn cache_touch(
    db: &Database,
    key: &str,
    fingerprint: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE dev_caloptreyx_updater_cache
         SET updated = now(), fingerprint = COALESCE($2, fingerprint) WHERE key = $1",
    )
    .bind(key)
    .bind(fingerprint)
    .execute(db.write())
    .await?;
    Ok(())
}

/// Drops cached GitHub answers nobody confirmed for `days` (deleted repositories, old tags).
pub async fn cache_prune(db: &Database, days: i32) -> Result<u64, sqlx::Error> {
    let done = sqlx::query(
        "DELETE FROM dev_caloptreyx_updater_cache
         WHERE key NOT LIKE 'state:%' AND updated < now() - make_interval(days => $1)",
    )
    .bind(days)
    .execute(db.write())
    .await?;
    Ok(done.rows_affected())
}

pub struct Backup {
    pub version: String,
    pub archive: Vec<u8>,
    pub sha256: String,
}

impl Backup {
    /// The extension was not installed before the update.
    pub fn was_absent(&self) -> bool {
        self.archive.is_empty()
    }
}

pub async fn backup_get(db: &Database, package_name: &str) -> Result<Option<Backup>, sqlx::Error> {
    let row: Option<(String, Vec<u8>, String)> = sqlx::query_as(
        "SELECT version, archive, sha256 FROM dev_caloptreyx_updater_backups WHERE package_name = $1",
    )
    .bind(package_name)
    .fetch_optional(db.read())
    .await?;
    Ok(row.map(|(version, archive, sha256)| Backup {
        version,
        archive,
        sha256,
    }))
}

pub async fn backup_put(
    db: &Database,
    package_name: &str,
    version: &str,
    archive: &[u8],
    sha256: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO dev_caloptreyx_updater_backups (package_name, version, archive, sha256, saved)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (package_name) DO UPDATE SET
             version = EXCLUDED.version, archive = EXCLUDED.archive, sha256 = EXCLUDED.sha256,
             saved = now()",
    )
    .bind(package_name)
    .bind(version)
    .bind(archive)
    .bind(sha256)
    .execute(db.write())
    .await?;
    Ok(())
}

/// Package name and version of every kept archive (not the archives).
pub async fn backup_versions(db: &Database) -> Result<Vec<(String, String)>, sqlx::Error> {
    sqlx::query_as(
        "SELECT package_name, version FROM dev_caloptreyx_updater_backups WHERE length(archive) > 0",
    )
    .fetch_all(db.read())
    .await
}

/// The extensions whose updates are off.
pub async fn updates_off(db: &Database) -> Result<BTreeSet<String>, sqlx::Error> {
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT package_name FROM dev_caloptreyx_updater_updates_off")
            .fetch_all(db.read())
            .await?;
    Ok(rows.into_iter().map(|(package_name,)| package_name).collect())
}

pub async fn is_updates_off(db: &Database, package_name: &str) -> Result<bool, sqlx::Error> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT package_name FROM dev_caloptreyx_updater_updates_off WHERE package_name = $1",
    )
    .bind(package_name)
    .fetch_optional(db.read())
    .await?;
    Ok(row.is_some())
}

/// Turns the updates of `package_name` on or off.
pub async fn set_updates(
    db: &Database,
    package_name: &str,
    enabled: bool,
    user_uuid: Option<uuid::Uuid>,
) -> Result<(), sqlx::Error> {
    if enabled {
        sqlx::query("DELETE FROM dev_caloptreyx_updater_updates_off WHERE package_name = $1")
            .bind(package_name)
            .execute(db.write())
            .await?;
    } else {
        sqlx::query(
            "INSERT INTO dev_caloptreyx_updater_updates_off (package_name, user_uuid)
             VALUES ($1, $2) ON CONFLICT (package_name) DO NOTHING",
        )
        .bind(package_name)
        .bind(user_uuid)
        .execute(db.write())
        .await?;
    }
    Ok(())
}

/// Specific release versions skipped per extension.
pub async fn skipped_versions(db: &Database) -> Result<BTreeMap<String, String>, sqlx::Error> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT package_name, version FROM dev_caloptreyx_updater_skipped")
            .fetch_all(db.read())
            .await?;
    Ok(rows.into_iter().collect())
}

pub async fn is_version_skipped(
    db: &Database,
    package_name: &str,
    version: &str,
) -> Result<bool, sqlx::Error> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT version FROM dev_caloptreyx_updater_skipped WHERE package_name = $1 AND version = $2",
    )
    .bind(package_name)
    .bind(version)
    .fetch_optional(db.read())
    .await?;
    Ok(row.is_some())
}

/// Sets or clears the skipped release version of `package_name`.
pub async fn set_skipped_version(
    db: &Database,
    package_name: &str,
    version: Option<&str>,
    user_uuid: Option<uuid::Uuid>,
) -> Result<(), sqlx::Error> {
    match version {
        Some(version) => {
            sqlx::query(
                "INSERT INTO dev_caloptreyx_updater_skipped (package_name, version, user_uuid, updated)
                 VALUES ($1, $2, $3, now())
                 ON CONFLICT (package_name) DO UPDATE SET
                     version = EXCLUDED.version, user_uuid = EXCLUDED.user_uuid, updated = now()",
            )
            .bind(package_name)
            .bind(version)
            .bind(user_uuid)
            .execute(db.write())
            .await?;
        }
        None => {
            sqlx::query("DELETE FROM dev_caloptreyx_updater_skipped WHERE package_name = $1")
                .bind(package_name)
                .execute(db.write())
                .await?;
        }
    }
    Ok(())
}

/// Clears the skip row for `package_name` if it matches `version` (e.g. after manually installing it).
pub async fn clear_skipped_version_if(
    db: &Database,
    package_name: &str,
    version: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "DELETE FROM dev_caloptreyx_updater_skipped WHERE package_name = $1 AND version = $2",
    )
    .bind(package_name)
    .bind(version)
    .execute(db.write())
    .await?;
    Ok(())
}

/// One extension in a run.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RunItem {
    pub package_name: String,
    pub name: String,
    /// The version installed before, `None` for a new install.
    pub from: Option<String>,
    pub to: String,
    /// The release tag, `None` when a kept archive was put back.
    pub tag: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunKind {
    Update,
    Rollback,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    /// Archives installed, the rebuild runs (or the restart onto it is pending).
    Building,
    Succeeded,
    /// Refused before anything changed, or the rebuild failed and the previous archives were
    /// put back.
    Failed,
    /// Nothing could tell how it ended (the supervisor went away, or six hours passed).
    Unknown,
}

impl RunState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Building => "building",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Unknown => "unknown",
        }
    }

    fn parse(text: &str) -> Self {
        match text {
            "building" => Self::Building,
            "succeeded" => Self::Succeeded,
            "failed" => Self::Failed,
            _ => Self::Unknown,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Run {
    pub id: i64,
    pub user_uuid: Option<uuid::Uuid>,
    pub automatic: bool,
    pub kind: RunKind,
    pub items: Vec<RunItem>,
    pub build_id: Option<i64>,
    /// When the supervisor was busy: the build after this one installs the run.
    pub after_build_id: Option<i64>,
    pub state: RunState,
    pub message: Option<String>,
    pub failed_extensions: Vec<String>,
    pub created: DateTime<Utc>,
    pub finished: Option<DateTime<Utc>>,
}

type RunRow = (
    i64,
    Option<uuid::Uuid>,
    bool,
    String,
    String,
    Option<i64>,
    Option<i64>,
    String,
    Option<String>,
    String,
    DateTime<Utc>,
    Option<DateTime<Utc>>,
);

// A macro, not a const: sqlx 0.9 takes only `&'static str` queries, and `concat!` takes literals.
macro_rules! run_columns {
    () => {
        "id, user_uuid, automatic, kind, items, build_id, after_build_id, state, message, \
         failed_extensions, created, finished"
    };
}

fn run_from_row(row: RunRow) -> Run {
    let (
        id,
        user_uuid,
        automatic,
        kind,
        items,
        build_id,
        after_build_id,
        state,
        message,
        failed_extensions,
        created,
        finished,
    ) = row;
    Run {
        id,
        user_uuid,
        automatic,
        kind: if kind == "rollback" {
            RunKind::Rollback
        } else {
            RunKind::Update
        },
        items: serde_json::from_str(&items).unwrap_or_default(),
        build_id,
        after_build_id,
        state: RunState::parse(&state),
        message,
        failed_extensions: serde_json::from_str(&failed_extensions).unwrap_or_default(),
        created,
        finished,
    }
}

pub async fn run_insert(
    db: &Database,
    user_uuid: Option<uuid::Uuid>,
    automatic: bool,
    kind: RunKind,
    items: &[RunItem],
) -> Result<i64, anyhow::Error> {
    let (id,): (i64,) = sqlx::query_as(
        "INSERT INTO dev_caloptreyx_updater_runs (user_uuid, automatic, kind, items, state)
         VALUES ($1, $2, $3, $4, 'building') RETURNING id",
    )
    .bind(user_uuid)
    .bind(automatic)
    .bind(match kind {
        RunKind::Update => "update",
        RunKind::Rollback => "rollback",
    })
    .bind(serde_json::to_string(items)?)
    .fetch_one(db.write())
    .await?;
    Ok(id)
}

pub async fn run_set_build(
    db: &Database,
    id: i64,
    build_id: Option<u64>,
    after_build_id: Option<u64>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE dev_caloptreyx_updater_runs SET build_id = $2, after_build_id = $3 WHERE id = $1",
    )
    .bind(id)
    .bind(build_id.map(|b| b as i64))
    .bind(after_build_id.map(|b| b as i64))
    .execute(db.write())
    .await?;
    Ok(())
}

pub async fn run_finish(
    db: &Database,
    id: i64,
    state: RunState,
    message: Option<&str>,
    failed_extensions: &[String],
) -> Result<(), anyhow::Error> {
    sqlx::query(
        "UPDATE dev_caloptreyx_updater_runs
         SET state = $2, message = $3, failed_extensions = $4, finished = now()
         WHERE id = $1 AND state = 'building'",
    )
    .bind(id)
    .bind(state.as_str())
    .bind(message)
    .bind(serde_json::to_string(failed_extensions)?)
    .execute(db.write())
    .await?;
    Ok(())
}

pub async fn runs_open(db: &Database) -> Result<Vec<Run>, sqlx::Error> {
    let rows: Vec<RunRow> = sqlx::query_as(concat!(
        "SELECT ",
        run_columns!(),
        " FROM dev_caloptreyx_updater_runs WHERE state = 'building' ORDER BY id"
    ))
    .fetch_all(db.read())
    .await?;
    Ok(rows.into_iter().map(run_from_row).collect())
}

pub async fn runs_recent(db: &Database, limit: i64) -> Result<Vec<Run>, sqlx::Error> {
    let rows: Vec<RunRow> = sqlx::query_as(concat!(
        "SELECT ",
        run_columns!(),
        " FROM dev_caloptreyx_updater_runs ORDER BY id DESC LIMIT $1"
    ))
    .bind(limit)
    .fetch_all(db.read())
    .await?;
    Ok(rows.into_iter().map(run_from_row).collect())
}

/// Keeps the newest 200 runs.
pub async fn runs_prune(db: &Database) -> Result<(), sqlx::Error> {
    sqlx::query(
        "DELETE FROM dev_caloptreyx_updater_runs WHERE state <> 'building' AND id <
             (SELECT COALESCE(MIN(id), 0) FROM
                 (SELECT id FROM dev_caloptreyx_updater_runs ORDER BY id DESC LIMIT 200) newest)",
    )
    .execute(db.write())
    .await?;
    Ok(())
}
