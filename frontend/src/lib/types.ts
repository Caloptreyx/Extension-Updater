// Payloads of the updater's admin API. The backend serializes with serde and the panel's axios
// instance does not rename keys, so they keep their snake_case names.

export type EntryStatus =
  | 'up_to_date'
  | 'update_available'
  | 'needs_panel'
  | 'installable'
  | 'no_release'
  | 'unpublished';

export interface Asset {
  name: string;
  size: number;
  download_url: string;
}

export interface Release {
  tag: string;
  version: string;
  name: string | null;
  published_at: string | null;
  html_url: string;
  /** GitHub markdown; untrusted, goes through `sanitizeReleaseNotes` before rendering. */
  body: string;
  prerelease: boolean;
  /** The panel version range the release needs, e.g. ">=1.2.10". */
  panel_version: string;
  /** License text that must be accepted before installing, if any. */
  license: string | null;
  /** A SHA-256 is published for the archive; unverified releases are never installed. */
  verified: boolean;
  asset: Asset | null;
}

export interface Entry {
  package_name: string;
  name: string;
  repo: string | null;
  repo_url: string | null;
  archived: boolean;
  installed: { version: string; disabled: boolean } | null;
  status: EntryStatus;
  /** Newest release that fits this panel. */
  latest: Release | null;
  /** Newer release that needs a newer panel. */
  needs_panel: Release | null;
  /** Releases newer than the installed one up to `latest`, newest first. */
  notes: Release[];
  rollback: { version: string } | null;
  is_self: boolean;
  /** Off: no Update or Install button, not counted as an update, skipped by "Update all" and automatic updates. */
  updates_enabled: boolean;
}

export interface RunItem {
  package_name: string;
  name: string;
  from: string | null;
  to: string;
  tag: string | null;
}

export type RunState = 'building' | 'succeeded' | 'failed' | 'unknown';

export interface Run {
  id: number;
  user_uuid: string | null;
  automatic: boolean;
  kind: 'update' | 'rollback';
  items: RunItem[];
  build_id: number | null;
  after_build_id: number | null;
  state: RunState;
  message: string | null;
  failed_extensions: string[];
  created: string;
  finished: string | null;
}

export type BuildPhase =
  | {
      type:
        | 'preparing'
        | 'clearing'
        | 'resync'
        | 'staging_translations'
        | 'building'
        | 'verifying'
        | 'installing'
        | 'restarting';
    }
  | { type: 'adding'; done: number; total: number };

export type SupervisorState =
  | { type: 'idle' | 'queued' | 'succeeded' | 'failed' }
  | { type: 'building'; phase: BuildPhase };

export interface SupervisorStatus {
  state: SupervisorState;
  panel_version: string;
  cache_key: string;
  bin_name: string;
  build_id: number | null;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  failure_reason: string | null;
  failed_extensions: string[];
  log_len: number;
}

export interface Settings {
  check_interval_hours: number;
  allow_prereleases: boolean;
  auto_update: boolean;
  auto_update_hour: number;
  show_banner: boolean;
  github_token: { set: boolean; hint: string | null };
}

export interface SettingsUpdate {
  check_interval_hours: number;
  allow_prereleases: boolean;
  auto_update: boolean;
  auto_update_hour: number;
  show_banner: boolean;
  /** Omitted or null keeps the stored token, "" removes it. */
  github_token?: string | null;
}

export interface RateLimit {
  limit: number;
  remaining: number;
  /** Unix seconds. */
  reset: number;
  authenticated: boolean;
}

export interface Overview {
  management: { available: boolean; reason: 'not_heavy' | 'disabled' | null };
  can_manage: boolean;
  panel_version: string;
  checked_at: string | null;
  checking: boolean;
  check_errors: string[];
  rate_limit: RateLimit | null;
  settings: Settings;
  /** Installed ones first, then not installed; sorted by name. */
  extensions: Entry[];
  supervisor: SupervisorStatus | null;
  /** Newest first, at most 10. */
  runs: Run[];
}

export interface SummaryUpdate {
  package_name: string;
  name: string;
  from: string;
  to: string;
}

export interface Summary {
  show_banner: boolean;
  building: boolean;
  updates: SummaryUpdate[];
}

export interface PackageVersion {
  package_name: string;
  version: string;
}

export interface UpdateRequest {
  packages: PackageVersion[];
  accept_licenses: string[];
  force: boolean;
}

export interface LicenseNeeded {
  package_name: string;
  name: string;
  version: string;
  license: string;
}

export interface RunStarted {
  run: Run;
  build_id: number | null;
}
