//! Extension settings, edited on the updater page and the extension's card. The GitHub token and
//! the Discord webhook URL are stored encrypted with the panel's database key; only ever leaves
//! the backend masked, and never in a settings read.

use crate::discord;
use serde::{Deserialize, Serialize};
use shared::{
    State,
    extensions::settings::{
        ExtensionSettings, SettingsDeserializeExt, SettingsDeserializer, SettingsSerializeExt,
        SettingsSerializer,
    },
};

#[derive(Clone, PartialEq)]
pub struct Settings {
    /// Hours between scheduled checks for new releases.
    pub check_interval_hours: u32,
    /// Offer prereleases (and `-beta` style versions) too.
    pub allow_prereleases: bool,
    /// Install compatible, verified updates without a license on their own, once a day.
    pub auto_update: bool,
    /// The hour (panel time zone) automatic updates run in.
    pub auto_update_hour: u32,
    /// Show the "updates available" banner in the admin area.
    pub show_banner: bool,
    /// A GitHub token, only to raise the API limit (60 requests an hour without one).
    pub github_token: String,
    /// Announce new compatible updates in Discord. Off by default.
    pub discord_enabled: bool,
    /// The Discord webhook URL, a secret that never leaves the backend.
    pub discord_webhook_url: String,
}

impl std::fmt::Debug for Settings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Settings")
            .field("check_interval_hours", &self.check_interval_hours)
            .field("allow_prereleases", &self.allow_prereleases)
            .field("auto_update", &self.auto_update)
            .field("auto_update_hour", &self.auto_update_hour)
            .field("show_banner", &self.show_banner)
            .field("github_token", &SecretView::of(&self.github_token))
            .field("discord_enabled", &self.discord_enabled)
            .field("discord_webhook_configured", &!self.discord_webhook_url.is_empty())
            .finish()
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            check_interval_hours: 6,
            allow_prereleases: false,
            auto_update: false,
            auto_update_hour: 4,
            show_banner: true,
            github_token: String::new(),
            discord_enabled: false,
            discord_webhook_url: String::new(),
        }
    }
}

/// Whether a secret is stored, and its last four characters. Never the secret itself.
#[derive(Serialize, Debug, PartialEq)]
pub struct SecretView {
    pub set: bool,
    pub hint: Option<String>,
}

impl SecretView {
    pub fn of(secret: &str) -> Self {
        let chars: Vec<char> = secret.chars().collect();
        Self {
            set: !secret.is_empty(),
            hint: (chars.len() >= 16).then(|| {
                let tail: String = chars[chars.len() - 4..].iter().collect();
                format!("…{tail}")
            }),
        }
    }
}

#[derive(Serialize)]
pub struct AdminView {
    pub check_interval_hours: u32,
    pub allow_prereleases: bool,
    pub auto_update: bool,
    pub auto_update_hour: u32,
    pub show_banner: bool,
    pub github_token: SecretView,
    pub discord_enabled: bool,
    /// Read-only: whether a webhook URL is stored. The URL itself is never returned.
    pub discord_webhook_configured: bool,
}

impl Settings {
    pub fn admin_view(&self) -> AdminView {
        AdminView {
            check_interval_hours: self.check_interval_hours,
            allow_prereleases: self.allow_prereleases,
            auto_update: self.auto_update,
            auto_update_hour: self.auto_update_hour,
            show_banner: self.show_banner,
            github_token: SecretView::of(&self.github_token),
            discord_enabled: self.discord_enabled,
            discord_webhook_configured: !self.discord_webhook_url.is_empty(),
        }
    }
}

/// A settings change. A secret left out (or `null`) stays as it is, an empty string removes it.
#[derive(Deserialize)]
pub struct Update {
    pub check_interval_hours: u32,
    pub allow_prereleases: bool,
    pub auto_update: bool,
    pub auto_update_hour: u32,
    pub show_banner: bool,
    #[serde(default)]
    pub github_token: Option<String>,
    /// Omitted preserves the stored toggle (for backward compatibility with older callers).
    #[serde(default)]
    pub discord_enabled: Option<bool>,
    /// Omitted or `null` keeps the stored webhook URL, an empty string clears it.
    #[serde(default)]
    pub discord_webhook_url: Option<String>,
}

impl Update {
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();
        if !(1..=168).contains(&self.check_interval_hours) {
            errors.push("check_interval_hours must be between 1 and 168".into());
        }
        if self.auto_update_hour > 23 {
            errors.push("auto_update_hour must be between 0 and 23".into());
        }
        if let Some(token) = &self.github_token {
            let token = token.trim();
            if token.len() > 255 || token.chars().any(|c| !c.is_ascii_graphic()) {
                errors.push("github_token must be a GitHub token (printable ASCII, at most 255 characters)".into());
            }
        }
        if let Some(webhook) = &self.discord_webhook_url
            && !webhook.trim().is_empty()
            && let Err(err) = discord::validate_url(webhook)
        {
            errors.push(err.to_string());
        }
        if errors.is_empty() { Ok(()) } else { Err(errors) }
    }

    pub fn apply(self, settings: &mut Settings) {
        settings.check_interval_hours = self.check_interval_hours;
        settings.allow_prereleases = self.allow_prereleases;
        settings.auto_update = self.auto_update;
        settings.auto_update_hour = self.auto_update_hour;
        settings.show_banner = self.show_banner;
        if let Some(token) = self.github_token {
            settings.github_token = token.trim().to_string();
        }
        if let Some(enabled) = self.discord_enabled {
            settings.discord_enabled = enabled;
        }
        if let Some(webhook) = self.discord_webhook_url {
            settings.discord_webhook_url = webhook.trim().to_string();
        }
    }
}

#[async_trait::async_trait]
impl SettingsSerializeExt for Settings {
    async fn serialize(
        &self,
        serializer: SettingsSerializer,
    ) -> Result<SettingsSerializer, anyhow::Error> {
        Ok(serializer
            .write_serde_setting("check_interval_hours", &self.check_interval_hours)?
            .write_serde_setting("allow_prereleases", &self.allow_prereleases)?
            .write_serde_setting("auto_update", &self.auto_update)?
            .write_serde_setting("auto_update_hour", &self.auto_update_hour)?
            .write_serde_setting("show_banner", &self.show_banner)?
            .write_serde_setting("discord_enabled", &self.discord_enabled)?
            .write_raw_encrypted_setting("github_token", self.github_token.as_str())
            .await?
            .write_raw_encrypted_setting("discord_webhook_url", self.discord_webhook_url.as_str())
            .await?)
    }
}

pub struct SettingsDataDeserializer;

#[async_trait::async_trait]
impl SettingsDeserializeExt for SettingsDataDeserializer {
    async fn deserialize_boxed(
        &self,
        deserializer: SettingsDeserializer<'_>,
    ) -> Result<ExtensionSettings, anyhow::Error> {
        let d = Settings::default();
        macro_rules! serde_or {
            ($key:literal, $default:expr) => {
                deserializer.read_serde_setting($key).unwrap_or($default)
            };
        }
        // A token that cannot be decrypted (the panel's encryption key changed) reads as unset
        // instead of breaking every settings load.
        let github_token = match deserializer.read_raw_encrypted_setting("github_token").await {
            Ok(Some(token)) => token.to_string(),
            _ => String::new(),
        };
        let discord_webhook_url = match deserializer
            .read_raw_encrypted_setting("discord_webhook_url")
            .await
        {
            Ok(Some(webhook)) => webhook.trim().to_string(),
            _ => String::new(),
        };
        Ok(Box::new(Settings {
            check_interval_hours: serde_or!("check_interval_hours", d.check_interval_hours),
            allow_prereleases: serde_or!("allow_prereleases", d.allow_prereleases),
            auto_update: serde_or!("auto_update", d.auto_update),
            auto_update_hour: serde_or!("auto_update_hour", d.auto_update_hour),
            show_banner: serde_or!("show_banner", d.show_banner),
            github_token,
            discord_enabled: serde_or!("discord_enabled", d.discord_enabled),
            discord_webhook_url,
        }))
    }
}

pub async fn load(state: &State) -> Result<Settings, anyhow::Error> {
    let settings = state.settings.get().await?;
    Ok(settings
        .get_extension_settings::<Settings>(crate::PACKAGE)
        .cloned()
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn update(token: Option<&str>) -> Update {
        Update {
            check_interval_hours: 6,
            allow_prereleases: false,
            auto_update: true,
            auto_update_hour: 3,
            show_banner: true,
            github_token: token.map(str::to_string),
            discord_enabled: None,
            discord_webhook_url: None,
        }
    }

    const WEBHOOK: &str = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";

    #[test]
    fn auto_update_is_off_by_default_and_the_token_is_masked() {
        let defaults = Settings::default();
        assert!(!defaults.auto_update);
        assert!(!defaults.discord_enabled);
        let mut settings = Settings {
            github_token: "github_pat_0123456789abcdef".into(),
            ..defaults
        };
        let view = settings.admin_view();
        assert_eq!(view.github_token, SecretView { set: true, hint: Some("…cdef".into()) });

        // left out keeps the token, empty removes it
        update(None).apply(&mut settings);
        assert_eq!(settings.github_token, "github_pat_0123456789abcdef");
        assert!(settings.auto_update);
        update(Some("")).apply(&mut settings);
        assert_eq!(settings.github_token, "");
    }

    #[test]
    fn limits_are_checked() {
        assert!(update(Some("ghp_x")).validate().is_ok());
        let wrong = Update {
            check_interval_hours: 0,
            auto_update_hour: 24,
            ..update(Some("has space"))
        };
        assert_eq!(wrong.validate().unwrap_err().len(), 3);

        let bad_webhook = Update {
            discord_webhook_url: Some("https://evil.example/api/webhooks/1/x".into()),
            ..update(None)
        };
        assert_eq!(bad_webhook.validate().unwrap_err().len(), 1);
    }

    #[test]
    fn the_webhook_is_write_only_and_kept_unless_cleared() {
        let mut settings = Settings {
            discord_webhook_url: WEBHOOK.into(),
            ..Settings::default()
        };
        let view = settings.admin_view();
        assert!(view.discord_webhook_configured);
        let json = serde_json::to_value(&view).unwrap();
        assert_eq!(json["discord_webhook_configured"], true);
        assert!(!json.to_string().contains("abcdefghijklmnop"));

        // omitted keeps it
        update(None).apply(&mut settings);
        assert_eq!(settings.discord_webhook_url, WEBHOOK);
        // legacy caller without discord_enabled keeps existing toggle
        settings.discord_enabled = true;
        update(None).apply(&mut settings);
        assert!(settings.discord_enabled);
        // explicit toggle overrides
        Update {
            discord_enabled: Some(false),
            ..update(None)
        }
        .apply(&mut settings);
        assert!(!settings.discord_enabled);

        // trimmed when provided
        Update {
            discord_enabled: Some(true),
            discord_webhook_url: Some(format!("  {WEBHOOK}  ")),
            ..update(None)
        }
        .apply(&mut settings);
        assert!(settings.discord_enabled);
        assert_eq!(settings.discord_webhook_url, WEBHOOK);
        // empty clears it
        Update {
            discord_webhook_url: Some(String::new()),
            ..update(None)
        }
        .apply(&mut settings);
        assert!(settings.discord_webhook_url.is_empty());
        assert!(!settings.admin_view().discord_webhook_configured);
    }

    #[test]
    fn debug_does_not_leak_webhook_url_or_token() {
        let settings = Settings {
            github_token: "ghp_supersecretkey123456789".into(),
            discord_webhook_url: WEBHOOK.into(),
            ..Settings::default()
        };
        let debug = format!("{settings:?}");
        assert!(!debug.contains("supersecretkey"), "{debug}");
        assert!(!debug.contains("abcdefghijklmnopqrstuvwxyz"), "{debug}");
        assert!(debug.contains("discord_webhook_configured: true"), "{debug}");
    }
}
