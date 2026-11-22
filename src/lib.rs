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
    /// last check, without asking GitHub again.
    async fn check_for_updates(
        &self,
        state: State,
        current_version: &semver::Version,
    ) -> Result<Option<ExtensionUpdateInfo>, anyhow::Error> {
        let snapshot = updater::snapshot().await;
        let entries = updater::entries(&state, &snapshot).await;
        let Some(latest) = entries
            .into_iter()
            .find(|entry| entry.package_name == PACKAGE)
            .and_then(|entry| entry.latest)
        else {
            return Ok(None);
        };
        let version = semver::Version::parse(&latest.version)?;
        Ok((version > *current_version).then(|| ExtensionUpdateInfo {
            version,
            changes: latest
                .body
                .lines()
                .filter(|line| !line.trim().is_empty())
                .map(compact_str::CompactString::from)
                .collect(),
        }))
    }
}
