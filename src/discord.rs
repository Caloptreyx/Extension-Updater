//! Discord update notifications. The webhook URL is a secret: only Discord's own HTTPS webhook
//! endpoint is accepted, redirects are never followed, and no error, log line or response ever
//! carries the URL. Cards use Components V2 so they can hold link buttons.

use anyhow::{Context, bail};
use reqwest::{Url, redirect::Policy};
use serde_json::{Value, json};
use shared::State;
use std::{
    sync::LazyLock,
    time::Duration,
};

/// The Components V2 message flag: a message with components must not carry `content` or embeds.
const COMPONENTS_V2: u32 = 1 << 15;

const USER_AGENT: &str = concat!(
    "Caloptreyx-Extension-Updater/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/Caloptreyx/Extension-Updater)"
);

/// A bounded client that never follows a redirect. `None` when it could not be built at all, so
/// no default client (which follows redirects) is ever used.
static SENDER: LazyLock<Option<reqwest::Client>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .redirect(Policy::none())
        .build()
        .ok()
});

fn sender() -> anyhow::Result<&'static reqwest::Client> {
    SENDER
        .as_ref()
        .context("the Discord webhook client could not be built")
}

/// A webhook URL that is exactly `https://discord.com/api/webhooks/<id>/<token>`.
///
/// Deceptive hosts (userinfo, `discord.com.evil`, `evil.discord.com`, custom ports, trailing
/// dots), extra path segments, queries and fragments are refused.
pub fn validate_url(raw: &str) -> anyhow::Result<Url> {
    let raw = raw.trim();
    if raw.is_empty() {
        bail!("a Discord webhook URL is required");
    }
    if raw.len() > 512 {
        bail!("the Discord webhook URL is too long");
    }
    let url = Url::parse(raw).context("the Discord webhook URL is not a valid URL")?;
    if url.scheme() != "https" {
        bail!("the Discord webhook URL must use https");
    }
    if !url.username().is_empty() || url.password().is_some() {
        bail!("the Discord webhook URL must not contain a username or password");
    }
    if url.host_str() != Some("discord.com") {
        bail!("the Discord webhook URL must point to discord.com");
    }
    if url.port().is_some() {
        bail!("the Discord webhook URL must not use a custom port");
    }
    if url.query().is_some() || url.fragment().is_some() {
        bail!("the Discord webhook URL must not carry a query or fragment");
    }
    let segments: Vec<&str> = url
        .path_segments()
        .map(|segments| segments.collect())
        .unwrap_or_default();
    let [id, token] = match segments.as_slice() {
        ["api", "webhooks", id, token] => [*id, *token],
        _ => bail!("the Discord webhook URL must look like https://discord.com/api/webhooks/<id>/<token>"),
    };
    if !(15..=25).contains(&id.len()) || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        bail!("the Discord webhook URL has an invalid webhook id");
    }
    if !(32..=128).contains(&token.len())
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        bail!("the Discord webhook URL has an invalid webhook token");
    }
    Ok(url)
}

/// The panel's Extension Updates page, from the configured public URL (never the request host).
pub async fn updates_page(state: &State) -> anyhow::Result<String> {
    let base = state.settings.get_as(|settings| settings.app.url.clone()).await?;
    Ok(updates_page_from(&base))
}

fn updates_page_from(base: &str) -> String {
    format!("{}/admin/extension-updates", base.trim_end_matches('/'))
}

/// One newly detected compatible update.
pub struct Update<'a> {
    pub extension: &'a str,
    pub version: &'a str,
    pub release_url: &'a str,
    pub updates_url: &'a str,
}

fn escape_markdown(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '*' | '_' | '`' | '~' | '|' | '>' | '[' | ']') {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    escaped
}

/// The stored webhook, when notifications are on and the URL is still valid.
pub fn configured(settings: &crate::settings::Settings) -> Option<Url> {
    if !settings.discord_enabled {
        return None;
    }
    validate_url(&settings.discord_webhook_url).ok()
}

/// The Components V2 card: extension and version, **View release** and **Update** buttons.
pub fn update_payload(update: &Update<'_>) -> Value {
    let mut buttons = Vec::with_capacity(2);
    // Discord rejects a link button with an empty or non-http(s) URL; an older cached release
    // may have no html_url, and the Update button alone is still useful.
    if update.release_url.starts_with("https://") || update.release_url.starts_with("http://") {
        buttons.push(json!({
            "type": 2, "style": 5, "label": "View release", "url": update.release_url,
        }));
    }
    buttons.push(json!({
        "type": 2, "style": 5, "label": "Update", "url": update.updates_url,
    }));

    json!({
        "flags": COMPONENTS_V2,
        "allowed_mentions": { "parse": [] },
        "components": [{
            "type": 17,
            "components": [
                {
                    "type": 10,
                    "content": format!(
                        "**{}** {} is available.",
                        escape_markdown(update.extension),
                        escape_markdown(update.version),
                    ),
                },
                { "type": 1, "components": buttons },
            ],
        }],
    })
}

fn test_payload() -> Value {
    json!({
        "flags": COMPONENTS_V2,
        "allowed_mentions": { "parse": [] },
        "components": [{
            "type": 17,
            "components": [{
                "type": 10,
                "content": "**Extension Updater** is connected. New compatible updates will be announced here.",
            }],
        }],
    })
}

/// A failure that is safe to show and log: no request URL, no webhook token.
fn describe(err: &reqwest::Error) -> String {
    if err.is_timeout() {
        "Discord did not answer in time".into()
    } else if err.is_connect() {
        "Discord could not be reached".into()
    } else if err.is_body() || err.is_decode() {
        "Discord's answer could not be read".into()
    } else if err.is_redirect() {
        "Discord answered with a redirect, which is not followed".into()
    } else {
        "the request to Discord failed".into()
    }
}

fn status_error(status: reqwest::StatusCode) -> anyhow::Error {
    let message = match status.as_u16() {
        300..=399 => "Discord answered with a redirect, which is not followed".to_string(),
        401 | 403 => "Discord refused the webhook (it is invalid or revoked)".to_string(),
        404 => "Discord does not know this webhook (it is invalid or deleted)".to_string(),
        429 => "Discord is rate limiting this webhook; try again later".to_string(),
        other => format!("Discord answered {other}"),
    };
    anyhow::anyhow!(message)
}

async fn post(webhook: &Url, body: &Value) -> anyhow::Result<()> {
    let mut target = webhook.clone();
    target.set_query(Some("with_components=true"));
    let response = sender()?
        .post(target)
        .json(body)
        .send()
        .await
        .map_err(|err| anyhow::anyhow!(describe(&err)))?;
    let status = response.status();
    if !status.is_success() {
        return Err(status_error(status));
    }
    Ok(())
}

/// Sends one update card. Errors never carry the webhook URL.
pub async fn send_update(webhook: &Url, update: &Update<'_>) -> anyhow::Result<()> {
    post(webhook, &update_payload(update)).await
}

/// Sends the test card. Touches no settings and no update-detection state.
pub async fn send_test(webhook: &Url) -> anyhow::Result<()> {
    post(webhook, &test_payload()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "123456789012345678";
    const TOKEN: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
    fn webhook() -> String {
        format!("https://discord.com/api/webhooks/{ID}/{TOKEN}")
    }

    #[test]
    fn accepts_only_the_canonical_webhook_endpoint() {
        assert_eq!(validate_url(&webhook()).unwrap().as_str(), webhook());

        for bad in [
            // not Discord's endpoint
            format!("https://discordapp.com/api/webhooks/{ID}/{TOKEN}"),
            format!("https://ptb.discord.com/api/webhooks/{ID}/{TOKEN}"),
            format!("https://discord.com.evil.example/api/webhooks/{ID}/{TOKEN}"),
            format!("https://evil.example/discord.com/api/webhooks/{ID}/{TOKEN}"),
            format!("https://discord.com./api/webhooks/{ID}/{TOKEN}"),
            format!("http://discord.com/api/webhooks/{ID}/{TOKEN}"),
            format!("https://discord.com:8443/api/webhooks/{ID}/{TOKEN}"),
            // userinfo hides the real host
            format!("https://user:pass@discord.com/api/webhooks/{ID}/{TOKEN}"),
            format!("https://discord.com@evil.example/api/webhooks/{ID}/{TOKEN}"),
            // extra path, query or fragment
            format!("https://discord.com/api/webhooks/{ID}/{TOKEN}/extra"),
            format!("https://discord.com/api/webhooks/{ID}/{TOKEN}/"),
            format!("https://discord.com/api/webhooks/{ID}/{TOKEN}?wait=true"),
            format!("https://discord.com/api/webhooks/{ID}/{TOKEN}#fragment"),
            format!("https://discord.com/api/webhooks/{ID}"),
            format!("https://discord.com/api/v10/webhooks/{ID}/{TOKEN}"),
            // malformed ids and tokens
            format!("https://discord.com/api/webhooks/abc/{TOKEN}"),
            format!("https://discord.com/api/webhooks/{ID}/short"),
            format!("https://discord.com/api/webhooks/{ID}/{TOKEN}!"),
        ] {
            assert!(validate_url(&bad).is_err(), "accepted {bad}");
        }
        assert!(validate_url("   ").is_err());
        assert!(validate_url("not a url").is_err());
    }

    #[test]
    fn errors_never_echo_the_url() {
        let err = validate_url(&format!(
            "https://evil.example/api/webhooks/{ID}/{TOKEN}"
        ))
        .unwrap_err()
        .to_string();
        assert!(!err.contains(TOKEN) && !err.contains(ID), "{err}");
        assert!(!err.contains("evil.example"), "{err}");
    }

    #[test]
    fn update_card_is_components_v2_with_both_buttons() {
        let payload = update_payload(&Update {
            extension: "Example Extension",
            version: "1.2.3",
            release_url: "https://github.com/Caloptreyx/Example/releases/tag/v1.2.3",
            updates_url: "https://panel.example.com/admin/extension-updates",
        });

        assert_eq!(payload["flags"], 32768);
        assert!(payload.get("content").is_none());
        assert!(payload.get("embeds").is_none());
        assert_eq!(payload["components"][0]["type"], 17);

        let text = payload["components"][0]["components"][0]["content"]
            .as_str()
            .unwrap();
        assert!(text.contains("Example Extension") && text.contains("1.2.3"), "{text}");

        let buttons = payload["components"][0]["components"][1]["components"]
            .as_array()
            .unwrap();
        assert_eq!(buttons.len(), 2);
        assert_eq!(buttons[0]["label"], "View release");
        assert_eq!(
            buttons[0]["url"],
            "https://github.com/Caloptreyx/Example/releases/tag/v1.2.3"
        );
        assert_eq!(buttons[1]["label"], "Update");
        assert_eq!(
            buttons[1]["url"],
            "https://panel.example.com/admin/extension-updates"
        );
        for button in buttons {
            assert_eq!(button["type"], 2);
            assert_eq!(button["style"], 5);
        }
    }

    #[test]
    fn card_escapes_markdown_from_the_extension_name() {
        let payload = update_payload(&Update {
            extension: "@everyone **bold**",
            version: "1.0.0",
            release_url: "https://example.com/r",
            updates_url: "https://example.com/u",
        });
        let text = payload["components"][0]["components"][0]["content"]
            .as_str()
            .unwrap();
        assert!(text.contains("\\*\\*bold\\*\\*"), "{text}");
        // and pings are always suppressed
        assert_eq!(payload["allowed_mentions"]["parse"], json!([]));
    }

    #[test]
    fn test_card_is_components_v2_without_buttons() {
        let payload = test_payload();
        assert_eq!(payload["flags"], 32768);
        assert!(payload.get("content").is_none());
        assert_eq!(payload["components"][0]["components"][0]["type"], 10);
        assert!(
            payload["components"][0]["components"]
                .as_array()
                .unwrap()
                .iter()
                .all(|component| component["type"] != 1)
        );
    }

    #[test]
    fn card_without_a_release_url_keeps_only_the_update_button() {
        let payload = update_payload(&Update {
            extension: "Example",
            version: "1.0.0",
            release_url: "",
            updates_url: "https://panel.example.com/admin/extension-updates",
        });
        let buttons = payload["components"][0]["components"][1]["components"]
            .as_array()
            .unwrap();
        assert_eq!(buttons.len(), 1);
        assert_eq!(buttons[0]["label"], "Update");
    }

    #[test]
    fn configured_requires_the_switch_and_a_valid_url() {
        let mut settings = crate::settings::Settings::default();
        assert!(configured(&settings).is_none());

        settings.discord_webhook_url = webhook();
        assert!(configured(&settings).is_none(), "off by default");

        settings.discord_enabled = true;
        assert!(configured(&settings).is_some());

        settings.discord_webhook_url = "https://evil.example/api/webhooks/1/x".into();
        assert!(configured(&settings).is_none());
    }

    #[test]
    fn the_update_button_opens_the_extension_updates_page() {
        assert_eq!(
            updates_page_from("https://panel.example.com"),
            "https://panel.example.com/admin/extension-updates"
        );
        assert_eq!(
            updates_page_from("https://panel.example.com/"),
            "https://panel.example.com/admin/extension-updates"
        );
    }

    #[tokio::test]
    async fn outbound_post_appends_with_components_query() {
        let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let server_addr = server.local_addr().unwrap();

        let receiver = tokio::spawn(async move {
            let (mut socket, _) = server.accept().await.unwrap();
            let mut buffer = [0u8; 2048];
            let read = tokio::io::AsyncReadExt::read(&mut socket, &mut buffer).await.unwrap();
            let request_text = String::from_utf8_lossy(&buffer[..read]).into_owned();
            let answer = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            let _ = tokio::io::AsyncWriteExt::write_all(&mut socket, answer.as_bytes()).await;
            let _ = tokio::io::AsyncWriteExt::shutdown(&mut socket).await;
            request_text
        });

        let webhook = Url::parse(&format!("http://{server_addr}/api/webhooks/{ID}/{TOKEN}")).unwrap();
        post(&webhook, &test_payload()).await.unwrap();
        let request = receiver.await.unwrap();
        assert!(
            request.starts_with("POST /api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_?with_components=true HTTP/1.1"),
            "unexpected request line: {}",
            request.lines().next().unwrap_or("")
        );
    }

    /// A local origin: answers every request with `302` to `elsewhere`, recording the paths it is
    /// asked for. The sender must never ask `elsewhere`.
    #[tokio::test]
    async fn redirects_are_not_followed() {
        let target = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_addr = target.local_addr().unwrap();

        let origin = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin_addr = origin.local_addr().unwrap();
        let redirector = tokio::spawn(async move {
            let (mut socket, _) = origin.accept().await.unwrap();
            let mut buffer = [0u8; 2048];
            let _ = tokio::io::AsyncReadExt::read(&mut socket, &mut buffer).await;
            let answer = format!(
                "HTTP/1.1 302 Found\r\nLocation: http://{target_addr}/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            let _ = tokio::io::AsyncWriteExt::write_all(&mut socket, answer.as_bytes()).await;
            let _ = tokio::io::AsyncWriteExt::shutdown(&mut socket).await;
        });

        let webhook = Url::parse(&format!("http://{origin_addr}/api/webhooks")).unwrap();
        let error = post(&webhook, &test_payload()).await.unwrap_err().to_string();
        assert!(
            error.contains("redirect") && !error.contains(&origin_addr.to_string()),
            "{error}"
        );
        redirector.await.unwrap();

        let followed = tokio::time::timeout(Duration::from_millis(300), target.accept()).await;
        assert!(followed.is_err(), "the redirect target was contacted");
    }

    #[tokio::test]
    async fn transport_errors_never_echo_the_webhook_url() {
        // Port 1 is not listening locally: a connection error, without touching the network.
        let webhook = Url::parse(&format!(
            "http://127.0.0.1:1/api/webhooks/{ID}/{TOKEN}"
        ))
        .unwrap();
        let error = post(&webhook, &test_payload()).await.unwrap_err().to_string();
        assert!(!error.contains(TOKEN), "{error}");
        assert!(!error.contains("127.0.0.1"), "{error}");
    }
}
