//! Extension Updater: keeps Caloptreyx extensions up to date from the admin area.

use shared::{
    State,
    extensions::{
        Extension, ExtensionRouteBuilder, ExtensionUpdateInfo,
        background_tasks::BackgroundTaskBuilder, settings::ExtensionSettingsDeserializer,
    },
};
use std::sync::Arc;

pub mod catalog;
pub mod github;
pub mod panel;
pub mod pipeline;
pub mod routes;
pub mod runs;
pub mod settings;
pub mod store;
pub mod trust;
pub mod updater;

pub const PACKAGE: &str = "dev.caloptreyx.updater";

#[derive(Default)]
pub struct ExtensionStruct;

#[async_trait::async_trait]
impl Extension for ExtensionStruct {
    async fn initialize(&mut self, _state: State) {
        let _ = std::sync::LazyLock::force(&runs::BOOTED);
    }

    async fn initialize_router(
        &mut self,
        state: State,
        builder: ExtensionRouteBuilder,
    ) -> ExtensionRouteBuilder {
        builder.add_admin_api_router(|router| {
            router.nest(&format!("/extensions/{PACKAGE}"), routes::router(&state))
        })
    }

    async fn initialize_background_tasks(
        &mut self,
        _state: State,
        builder: BackgroundTaskBuilder,
    ) -> BackgroundTaskBuilder {
        builder
            .add_task("extension-updater", |state| async move {
                updater::background(state).await
            })
            .await;
        builder
    }

    async fn settings_deserializer(&self, _state: State) -> ExtensionSettingsDeserializer {
        Arc::new(settings::SettingsDataDeserializer)
    }

    /// The panel's own update page asks every extension; the updater answers for itself from its
    /// last check, without asking GitHub again. The panel calls this while it holds the read
    /// guard of its extension list and may queue a writer on it during startup, so this must not
    /// touch `state.extensions` (a second read would wait behind that writer: a deadlock) nor
    /// the supervisor: only the snapshot, the running panel version and the updater's own
    /// updates-off row (no update is reported while its updates are off).
    async fn check_for_updates(
        &self,
        state: State,
        current_version: &semver::Version,
    ) -> Result<Option<ExtensionUpdateInfo>, anyhow::Error> {
        if store::is_updates_off(&state.database, PACKAGE).await? {
            return Ok(None);
        }
        let snapshot = updater::snapshot().await;
        let Some(listing) = snapshot.packages.get(PACKAGE) else {
            return Ok(None);
        };
        let releases = snapshot
            .releases
            .get(&listing.repo)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let found = catalog::candidates(
            PACKAGE,
            &listing.repo,
            releases,
            &snapshot.metas,
            snapshot.allow_prereleases,
        );
        let target = shared::extensions::distr::running_panel_version();
        let Some(latest) = catalog::select(&found, &target, Some(current_version)).compatible
        else {
            return Ok(None);
        };
        Ok((latest.version > *current_version).then(|| ExtensionUpdateInfo {
            version: latest.version.clone(),
            changes: latest
                .release
                .body
                .lines()
                .filter(|line| !line.trim().is_empty())
                .map(compact_str::CompactString::from)
                .collect(),
        }))
    }
}
