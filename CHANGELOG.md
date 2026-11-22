# Changelog

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
- Optional auto-update at a set hour (off by default), admin banner and Admin › Updates card.
- Optional GitHub token, stored encrypted.
- Notify only on panels without the heavy image or with extension management disabled.
