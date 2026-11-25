# Changelog

## 0.2.2

- Discord cards: a backslash in an extension name or version can no longer undo the markdown
  escaping (which reopened bold text and masked links); line breaks, `<…>` tags and headings are
  escaped too, and both are length-capped.
- Discord cards leave out a button whose URL Discord would refuse (a panel URL that is not an
  absolute `http(s)` URL), instead of the whole card being refused at every check. **Send test
  message** now carries the same **Update** button, so a bad panel URL shows up when testing.
- After the first failed Discord card (rate limit, timeout, deleted webhook) the check stops
  sending and the remaining cards wait for the next check, instead of each costing another
  request or timeout while the check holds its lock.
- Webhook URLs copied from the Discord PTB or Canary client and `discordapp.com` URLs are
  accepted and sent to `discord.com`; other hosts are still refused.
- Release notes: GitHub alert markers are matched case-insensitively (`> [!note]`), like on GitHub.

## 0.2.1

- Optional Discord Components V2 notifications for new extension updates.
- Fixed scrolling for long release notes in the update confirmation dialog.
- Render GitHub Markdown alerts in release notes.

## 0.2.0

- Tabbed **Extension Updates** page (**Installed**, **Available**, **History**, **Settings**) with
  search, status filters, grouped updates section, and actionable priority sorting.
- Selective batch updates & installs across Installed and Available tabs ("Apply in 1 rebuild")
  with a pre-update confirmation modal and release notes preview.
- Compact extension cards with clean `⋯` overflow menu for Pause/Resume, Skip version, Install
  anyway, Roll back, and external links; repository descriptions shown for available extensions.
- Per-extension skip version (`PUT /skip`) and manual `force` override for paused/skipped releases.
- Upgraded live build progress card with 6-step phase indicator, elapsed timer, and completion toast;
  dismissible last-run alerts and full run history tab.
- Live building and failed automatic update awareness in the admin banner and Admin › Updates card.
- Grouped Settings with formatted 24-hour selector showing the panel's time zone, live GitHub API
  quota readout, and a **Test token** button (`POST /test-token`), plus ETag caching for `org_repos`.

## 0.1.0

- First version: lists the installed Caloptreyx extensions (and the ones not installed yet) with
  their GitHub releases and release notes.
- Finds extensions from the Caloptreyx organisation's repositories and each repository's
  `Metadata.toml`; no index file to maintain.
- Checks every 6 hours (setting) and on demand; release feed fingerprints and ETags keep it inside
  GitHub's unauthenticated rate limit, results are cached in the database.
- Offers the newest release that fits the running panel; newer releases that need a newer panel are
  shown as such.
- Installs and updates through the heavy image's supervisor, several extensions in one rebuild.
  A failed build keeps the running panel and puts the previous archives back; Retry forces a
  rebuild.
- Archives only from GitHub release assets, with a published SHA-256 (GitHub digest and/or
  `<asset>.sha256`); unverified releases are refused. Licenses need explicit acceptance.
- Rollback to the previously installed version of each extension.
- Per-extension Updates switch (on by default): when off, the extension is not counted as an
  update, not installed by Update all or auto-update, and its card shows "Updates off".
- Optional auto-update at a set hour (off by default), admin banner and Admin › Updates card.
- Optional GitHub token, stored encrypted.
- Notify only on panels without the heavy image or with extension management disabled.
