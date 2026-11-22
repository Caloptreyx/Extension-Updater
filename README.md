# Extension Updater

A [Calagopus Panel](https://calagopus.com) extension that lists the installed Caloptreyx
extensions with their GitHub releases and installs updates through the heavy image's supervisor,
several extensions in one rebuild. It also installs Caloptreyx extensions that are not installed
yet, rolls back to the previous version, and can update on a schedule.

Package name: `dev.caloptreyx.updater` · Requires panel `>=1.2.10`

## Features

- **Admin › Extension Updates** (sidebar, System; `/admin/extension-updates`): every Caloptreyx
  extension, installed ones first, with installed and latest version, status, release notes since
  the installed version and links to the release, the archive and the repository.
- **Install and update** one or several extensions in a single rebuild, with build progress and
  the build log.
- **Roll back** to the previously installed version.
- **Check now** besides the scheduled check.
- **Auto-update** at a set hour (off by default).
- **Notices**: a banner on admin pages and a card on Admin › Updates when updates are available.

## Requirements

Installing needs the heavy image (`ghcr.io/calagopus/panel:heavy`): its supervisor builds the
panel with the extensions. On other panels, or with `APP_DISABLE_EXTENSION_MANAGEMENT` set, the
updater only notifies: list, release notes and download links, no install buttons.

## How it finds our extensions

- One API request lists the repositories of the Caloptreyx organisation (`GET /orgs/Caloptreyx/repos`,
  refreshed daily).
- For each public repository that is not a fork, `Metadata.toml` on the default branch is read from
  raw.githubusercontent.com (outside the API quota). A repository whose package name is
  `dev.caloptreyx.*` or `com.caloptreyx.*` maps to that package; other packages are ignored.
- There is no index file: a new extension repository shows up without an updater release or an
  index edit.
- Forks and private repositories are skipped. Archived repositories are still followed for
  installed extensions, but not offered for install.

## Checking for updates & rate limits

- A background task checks every `check interval` hours (default 6); **Check now** runs a check on
  demand (throttled).
- Releases come from `GET /repos/Caloptreyx/<repo>/releases`. Without a token GitHub allows 60 API
  requests per hour and a `304` still costs one, so the updater first reads the repository's
  `releases.atom` feed (not counted) and calls the API only when the feed's fingerprint changed.
- With a token, ETags are used instead: `304` answers to authenticated requests are free.
- Rate-limit headers are tracked; when the budget is used up, no API calls are made until it resets.
- Everything is cached in the database, so restarts cost nothing.
- The 60 per hour budget covers the daily repository list and one release request per repository
  whose feed changed. `Metadata.toml` files (default branch and per release tag, the latter cached
  for good) and release feeds do not count.

## Which release is offered

- Drafts are skipped; prereleases (GitHub flag or a semver pre-release) only with **Allow
  prereleases**.
- The tag must be `vX.Y.Z` or `X.Y.Z`, and the release must have the asset `<identifier>.c7s.zip`
  (for example `dev_caloptreyx_updater.c7s.zip`).
- `Metadata.toml` at the tag must name the same package and pass the panel's own panel version
  check against the version the supervisor builds.
- The newest release that fits is offered. A newer one that needs a newer panel is shown as
  **needs a newer panel** with its `panel_version`, never offered.

## Installing & updating

- Select one or several extensions: they go into **one rebuild**.
- All archives are downloaded, verified and staged first; if any fails, nothing changes.
- Then the archives are installed and one rebuild is requested from the supervisor. It builds the
  panel, verifies the build and only then installs it and restarts.
- A failed build keeps the running panel; the updater puts the previous archives back, so the
  extensions folder matches the running panel, and shows the supervisor's failure reason and the
  failing extensions. **Retry** runs again with force (the supervisor otherwise skips inputs that
  already failed).
- Progress and the build log come from the panel's supervisor, as on the panel's own extension
  page.

## Trust model

- Archives are only downloaded over HTTPS from
  `https://github.com/Caloptreyx/<repo>/releases/download/<tag>/<asset>`; redirects are only
  followed to `release-assets.githubusercontent.com` and `objects.githubusercontent.com`.
- The SHA-256 must be published: GitHub's asset `digest` and/or a `<asset>.sha256` asset uploaded by
  the release workflow (`Caloptreyx/.github` `extension-release.yml`). When both exist they must
  agree.
- Releases without either are refused and shown as **unverified**, without an install button. A
  warning would be ignored, and refusing costs nothing: every asset uploaded since mid-2025 has a
  GitHub digest.
- The archive's package name and version must match the release; the panel version requirement is
  checked again on the real archive.
- Extensions with a license need its explicit acceptance; never automatic.

## Auto-update

Off by default. When on, once a day at the set hour (panel time zone) every available update is
installed in one batch. Never included: releases with a license, releases that need a newer panel,
unverified releases. A version whose run failed is not tried again automatically.

## Rollback

Before an update, the installed archive is kept in the database, one per extension. **Roll back to
<version>** swaps it back in with one rebuild; the newer archive is kept in turn, so you can roll
forward again. It is cheap: one archive per extension, no download, and the supervisor keeps the
last three builds, so going back to the build that ran before usually only restarts the panel.
When a rebuild fails, the kept archives are put back on their own (no rebuild, no restart needed:
the running panel never changed).

## Self-update

The updater is one of the packages: it updates itself like any other extension.

## Settings

| Setting | Default | |
|---|---|---|
| Check interval | 6 hours | 1 to 168 |
| Allow prereleases | off | |
| Auto-update | off | |
| Auto-update hour | 4 | 0 to 23, panel time zone |
| Show banner | on | Banner on admin pages |
| GitHub token | none | Stored encrypted, shown masked; empty removes it |

For the token, use a fine-grained token with public repository read access only.

## Permissions

| Action | Needs |
|---|---|
| View the list, **Check now** | `extensions.read` |
| Install, update, roll back, change settings | `extensions.manage` |

The same permissions as the panel's own extension upload. Activity log: `extension:upload` per
archive (with `via: dev.caloptreyx.updater` and the release tag) and `extension:rebuild`.

## Notices

When updates are available, a banner shows on every admin page (setting) and a card on
**Admin › Updates**.

## Limits

- One heavy container: the supervisor builds the panel it runs in.
- Build time is the supervisor's: a rebuild takes as long as a manual one.
- Release notes are GitHub markdown, rendered sanitized.
- `Metadata.toml` must be at the repository root.
- A renamed package is not followed: the new name is a new extension.
- During GitHub outages the cached data is shown.

## Development

Crate at the repository root (`src/`), frontend in `frontend/`, migrations in `migrations/`, node
tests in `tests/`.

- Light checks: symlink the repository into `/root/calagopus-dev` (the panel source) as an
  extension, then run `tsc`, `oxlint` and `oxfmt` in its `frontend/`, and `node --test tests/` here.
- CI (`.github/workflows/check.yml`) builds the extension inside the newest panel release:
  typecheck, oxlint/oxfmt, `pnpm build`, the node tests and `cargo test`.
- Install by hand: `python3 scripts/package.py` builds `dist/dev_caloptreyx_updater.c7s.zip`.

## Releasing

Keep `Cargo.toml`'s version in sync with the tag. Tag `v0.1.0` and publish a release:

```sh
gh release create v0.1.0 --repo Caloptreyx/Extension-Updater --target main \
  --title "v0.1.0" --notes-file <notes>
```

`release.yml` (via `Caloptreyx/.github` `extension-release.yml`) attaches the export
`dev_caloptreyx_updater.c7s.zip` and its `.sha256`.

## License

MIT
