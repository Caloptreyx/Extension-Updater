//! Extension settings, edited on the updater page and the extension's card. The GitHub token is
//! stored encrypted with the panel's database key and only ever leaves the backend masked.

use serde::{Deserialize, Serialize};
use shared::{
    State,
    extensions::settings::{
        ExtensionSettings, SettingsDeserializeExt, SettingsDeserializer, SettingsSerializeExt,
        SettingsSerializer,
    },
};

#[derive(Clone, Debug, PartialEq)]
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
        }
    }
}

/// A settings change. A token left out (or `null`) stays as it is, an empty string removes it.
#[derive(Deserialize)]
pub struct Update {
    pub check_interval_hours: u32,
    pub allow_prereleases: bool,
    pub auto_update: bool,
    pub auto_update_hour: u32,
    pub show_banner: bool,
    #[serde(default)]
    pub github_token: Option<String>,
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
            .write_raw_encrypted_setting("github_token", self.github_token.as_str())
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
        Ok(Box::new(Settings {
            check_interval_hours: serde_or!("check_interval_hours", d.check_interval_hours),
            allow_prereleases: serde_or!("allow_prereleases", d.allow_prereleases),
            auto_update: serde_or!("auto_update", d.auto_update),
            auto_update_hour: serde_or!("auto_update_hour", d.auto_update_hour),
            show_banner: serde_or!("show_banner", d.show_banner),
            github_token,
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
        }
    }

    #[test]
    fn auto_update_is_off_by_default_and_the_token_is_masked() {
        let defaults = Settings::default();
        assert!(!defaults.auto_update);
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
    }
}
