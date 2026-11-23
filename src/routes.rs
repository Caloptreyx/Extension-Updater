//! The admin API, mounted at `/api/admin/extensions/dev.caloptreyx.updater`. Viewing and
//! "Check now" need `extensions.read`; installing, rolling back, turning an extension's updates
//! on or off and changing settings need `extensions.manage`, like the panel's own extension upload.

use crate::{
    settings::{self, Settings, Update},
    updater::{self, Actor, Mode, RunError, Wanted},
};
use axum::{
    http::StatusCode,
    routing::{get, post, put},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use shared::{
    ApiError, GetState, Payload, State,
    models::{admin_activity::GetAdminActivityLogger, user::GetPermissionManager},
    response::{ApiResponse, ApiResponseResult},
};
use utoipa_axum::router::OpenApiRouter;

fn actor(logger: &GetAdminActivityLogger) -> Actor {
    Actor {
        user_uuid: Some(logger.user_uuid),
        impersonator_uuid: logger.impersonator_uuid,
        api_key_uuid: logger.api_key_uuid,
        ip: Some(logger.ip),
    }
}

fn respond(result: Result<impl Serialize, RunError>) -> ApiResponseResult {
    match result {
        Ok(body) => ApiResponse::new_serialized(body).ok(),
        Err(RunError::Busy(message)) => ApiResponse::error(message)
            .with_status(StatusCode::CONFLICT)
            .ok(),
        Err(RunError::Invalid(message)) => ApiResponse::error(message)
            .with_status(StatusCode::BAD_REQUEST)
            .ok(),
        Err(RunError::NeedsLicense(licenses)) => {
            ApiResponse::new_serialized(json!({ "needs_license": licenses }))
                .with_status(StatusCode::CONFLICT)
                .ok()
        }
        Err(RunError::Failed(message)) => ApiResponse::error(message)
            .with_status(StatusCode::INTERNAL_SERVER_ERROR)
            .ok(),
    }
}

async fn overview(state: GetState, permissions: GetPermissionManager) -> ApiResponseResult {
    permissions.has_admin_permission("extensions.read")?;
    let can_manage = permissions.has_admin_permission("extensions.manage").is_ok();
    ApiResponse::new_serialized(updater::overview(&state, can_manage).await?).ok()
}

async fn summary(state: GetState, permissions: GetPermissionManager) -> ApiResponseResult {
    permissions.has_admin_permission("extensions.read")?;
    ApiResponse::new_serialized(updater::summary(&state).await?).ok()
}

async fn check(state: GetState, permissions: GetPermissionManager) -> ApiResponseResult {
    permissions.has_admin_permission("extensions.read")?;
    let can_manage = permissions.has_admin_permission("extensions.manage").is_ok();
    updater::check(&state, Mode::Manual).await?;
    ApiResponse::new_serialized(updater::overview(&state, can_manage).await?).ok()
}

#[derive(Deserialize)]
struct UpdateRequest {
    packages: Vec<Wanted>,
    #[serde(default)]
    accept_licenses: Vec<String>,
    /// Build even inputs the supervisor saw fail before ("Retry").
    #[serde(default)]
    force: bool,
}

async fn update(
    state: GetState,
    permissions: GetPermissionManager,
    activity_logger: GetAdminActivityLogger,
    Payload(data): Payload<UpdateRequest>,
) -> ApiResponseResult {
    state.ensure_extension_management()?;
    permissions.has_admin_permission("extensions.manage")?;
    respond(
        updater::update(
            &state,
            &actor(&activity_logger),
            &data.packages,
            &data.accept_licenses,
            data.force,
            false,
        )
        .await,
    )
}

#[derive(Deserialize)]
struct RollbackRequest {
    package_name: String,
}

async fn rollback(
    state: GetState,
    permissions: GetPermissionManager,
    activity_logger: GetAdminActivityLogger,
    Payload(data): Payload<RollbackRequest>,
) -> ApiResponseResult {
    state.ensure_extension_management()?;
    permissions.has_admin_permission("extensions.manage")?;
    respond(updater::rollback(&state, &actor(&activity_logger), &data.package_name).await)
}

#[derive(Deserialize)]
struct UpdatesRequest {
    package_name: String,
    enabled: bool,
}

/// Turns an extension's updates on or off. No heavy image needed: on notify-only panels it
/// still decides what the banner counts.
async fn set_updates(
    state: GetState,
    permissions: GetPermissionManager,
    activity_logger: GetAdminActivityLogger,
    Payload(data): Payload<UpdatesRequest>,
) -> ApiResponseResult {
    permissions.has_admin_permission("extensions.manage")?;
    let result =
        updater::set_updates(&state, &actor(&activity_logger), &data.package_name, data.enabled)
            .await
            .map(|()| json!({ "package_name": data.package_name, "updates_enabled": data.enabled }));
    respond(result)
}

async fn get_settings(state: GetState, permissions: GetPermissionManager) -> ApiResponseResult {
    permissions.has_admin_permission("extensions.read")?;
    let settings = settings::load(&state).await?;
    ApiResponse::new_serialized(json!({ "settings": settings.admin_view() })).ok()
}

async fn put_settings(
    state: GetState,
    permissions: GetPermissionManager,
    activity_logger: GetAdminActivityLogger,
    Payload(data): Payload<Update>,
) -> ApiResponseResult {
    permissions.has_admin_permission("extensions.manage")?;
    if let Err(errors) = data.validate() {
        return ApiResponse::new_serialized(ApiError::new_strings_value(errors))
            .with_status(StatusCode::BAD_REQUEST)
            .ok();
    }
    let token_changed = data.github_token.is_some();
    let view = {
        let mut panel_settings = state.settings.get_mut().await?;
        let stored: &mut Settings = panel_settings.get_mut_extension_settings(crate::PACKAGE)?;
        data.apply(stored);
        let view = stored.admin_view();
        panel_settings.save().await?;
        view
    };
    activity_logger
        .log(
            "settings:extensions:update",
            json!({
                "extension": crate::PACKAGE,
                "settings": {
                    "check_interval_hours": view.check_interval_hours,
                    "allow_prereleases": view.allow_prereleases,
                    "auto_update": view.auto_update,
                    "auto_update_hour": view.auto_update_hour,
                    "show_banner": view.show_banner,
                    "github_token_changed": token_changed,
                },
            }),
        )
        .await;
    ApiResponse::new_serialized(json!({ "settings": view })).ok()
}

pub fn router(state: &State) -> OpenApiRouter<State> {
    OpenApiRouter::new()
        .route("/overview", get(overview))
        .route("/summary", get(summary))
        .route("/check", post(check))
        .route("/update", post(update))
        .route("/rollback", post(rollback))
        .route("/updates", put(set_updates))
        .route("/settings", get(get_settings).put(put_settings))
        .with_state(state.clone())
}
