//! GitHub access. All repositories are public, so no token is needed, but an unauthenticated
//! panel gets 60 API requests an hour (and a 304 counts as one). So the API is asked as little as
//! possible: the repository list once a day, a release list only when the repository's release
//! feed (github.com, outside the API quota) changed, `Metadata.toml` from
//! raw.githubusercontent.com (outside the quota, once per tag). With a token the release lists
//! are asked with their ETag instead, where a 304 is free.

use crate::{
    catalog::{self, ORG},
    store,
    trust::{self, Sha256},
};
use anyhow::{Context, bail};
use futures_util::StreamExt;
use reqwest::{StatusCode, Url, header};
use serde::Serialize;
use sha2::{Digest, Sha256 as Hasher};
use shared::database::Database;
use std::{
    sync::{LazyLock, Mutex},
    time::Duration,
};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

const USER_AGENT: &str = concat!(
    "Caloptreyx-Extension-Updater/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/Caloptreyx/Extension-Updater)"
);

/// The largest archive downloaded. Our biggest is a few MiB.
pub const MAX_ARCHIVE: u64 = 128 * 1024 * 1024;
const MAX_TEXT: u64 = 4 * 1024 * 1024;
const MAX_METADATA: u64 = 256 * 1024;

fn github_host(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && matches!(
            url.host_str(),
            Some("api.github.com" | "github.com" | "raw.githubusercontent.com")
        )
}

/// API, feed and raw requests. Redirects (a renamed repository) stay on GitHub.
static API: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 3 || !github_host(attempt.url()) {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .unwrap_or_default()
});

/// Archive downloads: from an organization release download, redirected only to GitHub's asset
/// hosts ([`trust::is_allowed_redirect`]).
static DOWNLOAD: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(600))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                attempt.error("too many redirects")
            } else if trust::is_allowed_redirect(attempt.url()) {
                attempt.follow()
            } else {
                let refused = format!(
                    "refusing a redirect to {}",
                    attempt.url().host_str().unwrap_or("an unknown host")
                );
                attempt.error(refused)
            }
        }))
        .build()
        .unwrap_or_default()
});

/// What GitHub said about the API quota in its last answer.
#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
pub struct RateLimit {
    pub limit: u32,
    pub remaining: u32,
    /// Unix seconds when the quota refills.
    pub reset: i64,
    pub authenticated: bool,
}

static RATE: Mutex<Option<RateLimit>> = Mutex::new(None);

pub fn rate_limit() -> Option<RateLimit> {
    *RATE.lock().unwrap_or_else(|err| err.into_inner())
}

fn header_value<T: std::str::FromStr>(headers: &header::HeaderMap, name: &str) -> Option<T> {
    headers.get(name)?.to_str().ok()?.trim().parse().ok()
}

fn parse_rate_headers(headers: &header::HeaderMap, authenticated: bool) -> Option<RateLimit> {
    Some(RateLimit {
        limit: header_value::<u32>(headers, "x-ratelimit-limit")?,
        remaining: header_value::<u32>(headers, "x-ratelimit-remaining")?,
        reset: header_value::<i64>(headers, "x-ratelimit-reset")?,
        authenticated,
    })
}

fn note_rate(headers: &header::HeaderMap, authenticated: bool) {
    let Some(rate) = parse_rate_headers(headers, authenticated) else {
        return;
    };
    *RATE.lock().unwrap_or_else(|err| err.into_inner()) = Some(rate);
}

/// Result of testing a GitHub token against `GET /rate_limit`. Never contains the token itself.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct TokenTest {
    pub valid: bool,
    pub rate_limit: Option<RateLimit>,
    pub error: Option<String>,
}

#[derive(serde::Deserialize)]
struct RateLimitBody {
    resources: RateLimitResources,
}

#[derive(serde::Deserialize)]
struct RateLimitResources {
    core: RateLimitCore,
}

#[derive(serde::Deserialize)]
struct RateLimitCore {
    limit: u32,
    remaining: u32,
    reset: i64,
}

/// The API quota is used up: no request is made until `reset`.
#[derive(Debug)]
pub struct RateLimited {
    pub reset: i64,
}

impl std::fmt::Display for RateLimited {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let at = chrono::DateTime::from_timestamp(self.reset, 0)
            .map(|time| time.format("%H:%M UTC").to_string())
            .unwrap_or_else(|| "later".into());
        write!(
            f,
            "GitHub's API limit for this panel is used up until {at}; a GitHub token in the updater settings raises it"
        )
    }
}

impl std::error::Error for RateLimited {}

fn exhausted(authenticated: bool) -> Option<i64> {
    let rate = rate_limit()?;
    let now = chrono::Utc::now().timestamp();
    (rate.authenticated == authenticated && rate.remaining == 0 && rate.reset > now)
        .then_some(rate.reset)
}

/// A fingerprint of a release feed (`releases.atom`): the id and update time of every entry. It
/// changes when a release is published, edited or deleted.
pub fn feed_fingerprint(feed: &str) -> String {
    fn element<'a>(block: &'a str, name: &str) -> &'a str {
        let open = format!("<{name}>");
        let close = format!("</{name}>");
        block
            .find(&open)
            .and_then(|start| {
                let rest = &block[start + open.len()..];
                rest.find(&close).map(|end| rest[..end].trim())
            })
            .unwrap_or("")
    }
    let mut hasher = Hasher::new();
    for entry in feed.split("<entry>").skip(1) {
        let entry = entry.split("</entry>").next().unwrap_or("");
        hasher.update(element(entry, "id").as_bytes());
        hasher.update(b"\n");
        hasher.update(element(entry, "updated").as_bytes());
        hasher.update(b"\n");
    }
    hex::encode(hasher.finalize().as_slice())
}

async fn read_limited(response: reqwest::Response, max: u64) -> anyhow::Result<Vec<u8>> {
    if response.content_length().is_some_and(|len| len > max) {
        bail!("GitHub's answer is larger than {max} bytes");
    }
    let mut data = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if data.len() as u64 + chunk.len() as u64 > max {
            bail!("GitHub's answer is larger than {max} bytes");
        }
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}

pub fn releases_key(repo: &str) -> String {
    format!("releases:{repo}")
}

pub struct Github {
    token: Option<String>,
}

impl Github {
    pub fn new(token: &str) -> Self {
        let token = token.trim();
        Self {
            token: (!token.is_empty()).then(|| token.to_string()),
        }
    }

    pub fn authenticated(&self) -> bool {
        self.token.is_some()
    }

    /// GETs an API resource. With a `key`, the answer and its ETag are kept, and a 304 is
    /// answered from the cache.
    async fn api_get(&self, db: &Database, key: Option<&str>, url: &str) -> anyhow::Result<String> {
        let authenticated = self.authenticated();
        if let Some(reset) = exhausted(authenticated) {
            return Err(RateLimited { reset }.into());
        }
        let cached = match key {
            Some(key) => store::cache_get(db, key).await?,
            None => None,
        };
        let mut request = API
            .get(url)
            .header(header::ACCEPT, "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28");
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        if let Some(etag) = cached.as_ref().and_then(|c| c.etag.as_deref()) {
            request = request.header(header::IF_NONE_MATCH, etag);
        }
        let response = request
            .send()
            .await
            .with_context(|| format!("asking GitHub for {url}"))?;
        note_rate(response.headers(), authenticated);
        let status = response.status();
        if status == StatusCode::NOT_MODIFIED
            && let (Some(key), Some(cached)) = (key, cached)
        {
            store::cache_touch(db, key, None).await?;
            return Ok(cached.value);
        }
        if status == StatusCode::UNAUTHORIZED {
            bail!("GitHub refused the token in the updater settings (401)");
        }
        if status == StatusCode::FORBIDDEN || status == StatusCode::TOO_MANY_REQUESTS {
            let headers = response.headers();
            let reset = if header_value::<u32>(headers, "x-ratelimit-remaining") == Some(0) {
                header_value::<i64>(headers, "x-ratelimit-reset")
            } else {
                header_value::<i64>(headers, "retry-after")
                    .map(|after| chrono::Utc::now().timestamp() + after)
            };
            if let Some(reset) = reset {
                let mut rate = RATE.lock().unwrap_or_else(|err| err.into_inner());
                *rate = Some(RateLimit {
                    limit: (*rate).map_or(60, |r| r.limit),
                    remaining: 0,
                    reset,
                    authenticated,
                });
                return Err(RateLimited { reset }.into());
            }
        }
        if !status.is_success() {
            bail!("GitHub answered {status} for {url}");
        }
        let etag = response
            .headers()
            .get(header::ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let body = String::from_utf8(read_limited(response, MAX_TEXT).await?)
            .context("GitHub's answer is not UTF-8")?;
        if let Some(key) = key {
            store::cache_put(db, key, etag.as_deref(), None, &body).await?;
        }
        Ok(body)
    }

    /// The organization's public repositories.
    pub async fn org_repos(&self, db: &Database) -> anyhow::Result<Vec<catalog::Repo>> {
        let mut repos = Vec::new();
        for page in 1..=5 {
            let url =
                format!("https://api.github.com/orgs/{ORG}/repos?type=public&per_page=100&page={page}");
            let key = format!("org_repos:page:{page}");
            let batch: Vec<catalog::Repo> =
                serde_json::from_str(&self.api_get(db, Some(&key), &url).await?)
                    .context("reading GitHub's repository list")?;
            let full = batch.len() == 100;
            repos.extend(batch);
            if !full {
                break;
            }
        }
        Ok(repos)
    }

    /// Verifies a GitHub token against `GET /rate_limit` (works with fine-grained tokens that have
    /// zero scopes and does not consume API quota). When `update_global` is true and the token is
    /// valid, refreshes the cached rate-limit readout too.
    pub async fn test_token(&self, update_global: bool) -> TokenTest {
        let Some(token) = &self.token else {
            return TokenTest {
                valid: false,
                rate_limit: None,
                error: Some("No GitHub token provided.".into()),
            };
        };
        let response = match API
            .get("https://api.github.com/rate_limit")
            .header(header::ACCEPT, "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .bearer_auth(token)
            .send()
            .await
        {
            Ok(response) => response,
            Err(err) => {
                return TokenTest {
                    valid: false,
                    rate_limit: None,
                    error: Some(format!("Could not reach GitHub: {err}")),
                };
            }
        };
        let status = response.status();
        let from_headers = parse_rate_headers(response.headers(), true);
        if status == StatusCode::UNAUTHORIZED {
            return TokenTest {
                valid: false,
                rate_limit: None,
                error: Some("GitHub rejected this token (401 Unauthorized).".into()),
            };
        }
        if status == StatusCode::FORBIDDEN {
            return TokenTest {
                valid: false,
                rate_limit: from_headers,
                error: Some("GitHub refused this token (403 Forbidden).".into()),
            };
        }
        if !status.is_success() {
            return TokenTest {
                valid: false,
                rate_limit: from_headers,
                error: Some(format!("GitHub answered {status} while verifying the token.")),
            };
        }
        let body = read_limited(response, MAX_METADATA).await.ok();
        let from_body = body
            .and_then(|bytes| serde_json::from_slice::<RateLimitBody>(&bytes).ok())
            .map(|parsed| RateLimit {
                limit: parsed.resources.core.limit,
                remaining: parsed.resources.core.remaining,
                reset: parsed.resources.core.reset,
                authenticated: true,
            });
        let rate_limit = from_body.or(from_headers);
        if update_global && let Some(rate) = rate_limit {
            *RATE.lock().unwrap_or_else(|err| err.into_inner()) = Some(rate);
        }
        TokenTest {
            valid: true,
            rate_limit,
            error: None,
        }
    }

    /// The newest releases of `repo` (drafts are only listed for tokens with push access).
    pub async fn releases(&self, db: &Database, repo: &str) -> anyhow::Result<Vec<catalog::Release>> {
        let url = format!("https://api.github.com/repos/{ORG}/{repo}/releases?per_page=20");
        let body = self.api_get(db, Some(&releases_key(repo)), &url).await?;
        serde_json::from_str(&body).with_context(|| format!("reading the releases of {repo}"))
    }

    /// The fingerprint of `repo`'s release feed, outside the API quota.
    pub async fn release_feed(&self, repo: &str) -> anyhow::Result<String> {
        let url = format!("https://github.com/{ORG}/{repo}/releases.atom");
        let response = API
            .get(&url)
            .header(header::ACCEPT, "application/atom+xml")
            .send()
            .await
            .with_context(|| format!("reading {url}"))?;
        if !response.status().is_success() {
            bail!("{url} answered {}", response.status());
        }
        let feed = String::from_utf8_lossy(&read_limited(response, MAX_TEXT).await?).into_owned();
        if !feed.contains("<feed") {
            bail!("{url} is not a release feed");
        }
        Ok(feed_fingerprint(&feed))
    }

    /// `Metadata.toml` of `repo` at a tag or branch; `None` when there is none.
    pub async fn metadata_at(&self, repo: &str, git_ref: &str) -> anyhow::Result<Option<String>> {
        let mut url = Url::parse("https://raw.githubusercontent.com/")?;
        url.path_segments_mut()
            .map_err(|()| anyhow::anyhow!("cannot build a raw URL"))?
            .pop_if_empty()
            .extend([ORG, repo, git_ref, "Metadata.toml"]);
        let response = API
            .get(url.clone())
            .send()
            .await
            .with_context(|| format!("reading {url}"))?;
        match response.status() {
            StatusCode::NOT_FOUND => Ok(None),
            status if status.is_success() => Ok(Some(
                String::from_utf8_lossy(&read_limited(response, MAX_METADATA).await?).into_owned(),
            )),
            status => bail!("{url} answered {status}"),
        }
    }

    /// Downloads a release asset to a temporary file, returning it rewound and its SHA-256.
    pub async fn download(
        &self,
        repo: &str,
        tag: &str,
        asset: &str,
    ) -> anyhow::Result<(tokio::fs::File, Sha256)> {
        let url = trust::release_asset_url(repo, tag, asset)?;
        let response = DOWNLOAD
            .get(url.clone())
            .send()
            .await
            .with_context(|| format!("downloading {url}"))?;
        if !response.status().is_success() {
            bail!("downloading {url} answered {}", response.status());
        }
        if response.content_length().is_some_and(|len| len > MAX_ARCHIVE) {
            bail!("{asset} is larger than {MAX_ARCHIVE} bytes");
        }
        let mut file = tokio::fs::File::from_std(tempfile::tempfile()?);
        let mut hasher = Hasher::new();
        let mut total = 0u64;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.with_context(|| format!("downloading {url}"))?;
            total += chunk.len() as u64;
            if total > MAX_ARCHIVE {
                bail!("{asset} is larger than {MAX_ARCHIVE} bytes");
            }
            hasher.update(&chunk);
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        file.seek(std::io::SeekFrom::Start(0)).await?;
        Ok((file, hasher.finalize().into()))
    }

    /// A small text asset (the `.sha256` file), from the same place and with the same rules as
    /// archives.
    pub async fn download_text(&self, repo: &str, tag: &str, asset: &str) -> anyhow::Result<String> {
        let url = trust::release_asset_url(repo, tag, asset)?;
        let response = DOWNLOAD
            .get(url.clone())
            .send()
            .await
            .with_context(|| format!("downloading {url}"))?;
        if !response.status().is_success() {
            bail!("downloading {url} answered {}", response.status());
        }
        Ok(String::from_utf8_lossy(&read_limited(response, 64 * 1024).await?).into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feed_fingerprints_follow_entries_only() {
        let feed = |entries: &str, generated: &str| {
            format!(
                "<?xml version=\"1.0\"?><feed xmlns=\"http://www.w3.org/2005/Atom\"><updated>{generated}</updated>{entries}</feed>"
            )
        };
        let one = "<entry><id>tag:github.com,2008:Repository/1/v0.1.0</id><updated>2026-11-21T18:39:22Z</updated><title>v0.1.0</title></entry>";
        let edited = "<entry><id>tag:github.com,2008:Repository/1/v0.1.0</id><updated>2026-11-22T10:00:00Z</updated><title>v0.1.0</title></entry>";
        let two = "<entry><id>tag:github.com,2008:Repository/1/v0.1.1</id><updated>2026-11-22T00:41:32Z</updated></entry>";

        // the feed's own update time does not count
        assert_eq!(
            feed_fingerprint(&feed(one, "2026-11-21T00:00:00Z")),
            feed_fingerprint(&feed(one, "2026-11-22T00:00:00Z"))
        );
        assert_ne!(feed_fingerprint(&feed(one, "x")), feed_fingerprint(&feed(edited, "x")));
        assert_ne!(
            feed_fingerprint(&feed(one, "x")),
            feed_fingerprint(&feed(&format!("{two}{one}"), "x"))
        );
        assert_ne!(feed_fingerprint(&feed("", "x")), feed_fingerprint(&feed(one, "x")));
    }
}
