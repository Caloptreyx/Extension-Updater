import type { Entry, Overview, PackageVersion, RateLimit, Run, SupervisorStatus, SummaryUpdate } from './types.ts';

export type BadgeKind =
  | 'up_to_date'
  | 'update_available'
  | 'installable'
  | 'needs_panel'
  | 'unverified'
  | 'license'
  | 'no_release'
  | 'unpublished'
  | 'disabled'
  | 'archived'
  | 'updates_off'
  | 'skipped';

export interface StatusBadge {
  kind: BadgeKind;
  color: string;
}

const COLORS: Record<BadgeKind, string> = {
  up_to_date: 'green',
  update_available: 'blue',
  installable: 'blue',
  needs_panel: 'yellow',
  unverified: 'orange',
  license: 'violet',
  no_release: 'gray',
  unpublished: 'gray',
  disabled: 'gray',
  archived: 'gray',
  updates_off: 'gray',
  skipped: 'gray',
};

const badge = (kind: BadgeKind): StatusBadge => ({ kind, color: COLORS[kind] });

/** A newer release exists for this panel: installable when updates are on and not skipped. */
const hasNewer = (entry: Entry) => entry.status === 'update_available' || entry.status === 'installable';

/** True when the entry's current `latest` release matches its `skipped_version`. */
export const isLatestSkipped = (entry: Entry): boolean =>
  Boolean(entry.skipped_version && entry.latest && entry.skipped_version === entry.latest.version);

/** The release an Update or Install button would install; none while paused or skipped. */
export const offered = (entry: Entry) =>
  entry.updates_enabled && !isLatestSkipped(entry) && hasNewer(entry) ? entry.latest : null;

/** The newer release an entry has while paused or skipped: shown as information, not offered. */
export const heldBack = (entry: Entry) =>
  (!entry.updates_enabled || isLatestSkipped(entry)) && hasNewer(entry) ? entry.latest : null;

/** The badges of an entry: its status first, then what else limits it. */
export function entryBadges(entry: Entry): StatusBadge[] {
  const badges: StatusBadge[] = [];
  const release = offered(entry);
  const skipped = isLatestSkipped(entry);

  if (heldBack(entry)) {
    badges.push(badge(!entry.updates_enabled ? 'updates_off' : 'skipped'));
  } else if (release && !release.verified) {
    badges.push(badge('unverified'));
  } else if (entry.status === 'needs_panel') {
    badges.push(badge('needs_panel'));
  } else {
    badges.push(badge(entry.status));
  }

  const has = (kind: BadgeKind) => badges.some((b) => b.kind === kind);
  if (!entry.updates_enabled && !has('updates_off')) badges.push(badge('updates_off'));
  if (skipped && !has('skipped')) badges.push(badge('skipped'));
  if (entry.status !== 'needs_panel' && entry.needs_panel) badges.push(badge('needs_panel'));
  if (release?.license) badges.push(badge('license'));
  if (entry.installed?.disabled) badges.push(badge('disabled'));
  if (entry.archived) badges.push(badge('archived'));

  return badges;
}

/** Whether the offered release can be installed normally: updates on, not skipped, verified, with an archive, and not archived when new. */
export function canInstall(entry: Entry): boolean {
  const release = offered(entry);
  if (!release?.verified || !release.asset) return false;
  if (entry.status === 'installable') return !entry.installed && !entry.archived;
  return !!entry.installed;
}

/** Whether a paused or skipped release can be manually installed anyway (passes `force: true`). */
export function canForceInstall(entry: Entry): boolean {
  const release = heldBack(entry);
  if (!release?.verified || !release.asset) return false;
  if (entry.status === 'installable') return !entry.installed && !entry.archived;
  return !!entry.installed;
}

/** Installed extensions "Update all" sends: not paused or skipped. License ones stay in: the license modal asks for them. */
export function updatableEntries(entries: Entry[]): Entry[] {
  return entries.filter((entry) => entry.status === 'update_available' && canInstall(entry));
}

/** Not installed extensions offered for install. */
export function installableEntries(entries: Entry[]): Entry[] {
  return entries.filter((entry) => !entry.installed && entry.status === 'installable' && !entry.archived);
}

export type InstalledFilter = 'all' | 'updates' | 'paused_skipped' | 'needs_panel';

/** Case-insensitive search across name, package name, description and repo. */
export function matchesSearch(entry: Entry, query: string): boolean {
  const term = query.trim().toLowerCase();
  if (!term) return true;
  return [entry.name, entry.package_name, entry.description, entry.repo].some((value) =>
    value?.toLowerCase().includes(term),
  );
}

/** Installed entries filtered by status bucket and search query. */
export function filterInstalledEntries(entries: Entry[], filter: InstalledFilter, query: string): Entry[] {
  return entries.filter((entry) => {
    if (!entry.installed || !matchesSearch(entry, query)) return false;
    switch (filter) {
      case 'all':
        return true;
      case 'updates':
        return entry.status === 'update_available' && entry.updates_enabled && !isLatestSkipped(entry);
      case 'paused_skipped':
        return !entry.updates_enabled || isLatestSkipped(entry);
      case 'needs_panel':
        return entry.status === 'needs_panel' || entry.needs_panel !== null;
    }
  });
}

/** Available (not installed) entries filtered by search query. */
export function filterAvailableEntries(entries: Entry[], query: string): Entry[] {
  return installableEntries(entries).filter((entry) => matchesSearch(entry, query));
}

/** Whether an entry can be checked for batch selection ("Apply selected in 1 rebuild"). */
export function isSelectable(entry: Entry): boolean {
  return canInstall(entry);
}

/** Resolves selected package names to current selectable entries. */
export function selectedEntries(entries: Entry[], selected: ReadonlySet<string>): Entry[] {
  return entries.filter((entry) => selected.has(entry.package_name) && isSelectable(entry));
}

export function packagesOf(entries: Entry[]): PackageVersion[] {
  return entries.flatMap((entry) =>
    entry.latest ? [{ package_name: entry.package_name, version: entry.latest.version }] : [],
  );
}

/** The packages of a run, to send again with `force` ("Retry"). */
export function retryPackages(run: Run): PackageVersion[] {
  return run.items.map((item) => ({ package_name: item.package_name, version: item.to }));
}

/** localStorage key of a dismissed banner; a new version set shows the banner again. */
export function bannerDismissKey(updates: SummaryUpdate[]): string {
  const versions = [...new Set(updates.map((update) => `${update.package_name}@${update.to}`))].sort();
  return `dev.caloptreyx.updater:banner:${versions.join(',')}`;
}

/** localStorage key of a dismissed failed-auto-update banner for a specific run id. */
export function failedAutoDismissKey(runId: number): string {
  return `dev.caloptreyx.updater:failed-auto:${runId}`;
}

/** localStorage key of a dismissed RunResult alert on the updater page. */
export function runResultDismissKey(runId: number): string {
  return `dev.caloptreyx.updater:run-result:${runId}`;
}

/** A run or the supervisor is busy with a build. */
export function isBuilding(overview: Pick<Overview, 'runs' | 'supervisor'>): boolean {
  const state = overview.supervisor?.state.type;
  return overview.runs.some((run) => run.state === 'building') || state === 'queued' || state === 'building';
}

/** The build whose log the build card links to. */
export function activeBuildId(overview: Pick<Overview, 'runs' | 'supervisor'>): number | null {
  return overview.runs.find((run) => run.state === 'building')?.build_id ?? overview.supervisor?.build_id ?? null;
}

/** The newest run, when it has finished. */
export function lastFinishedRun(runs: Run[]): Run | null {
  const [newest] = runs;
  return newest && newest.state !== 'building' ? newest : null;
}

export type BuildStep = 'preparing' | 'adding' | 'compiling' | 'verifying' | 'installing' | 'restarting';

export const BUILD_STEPS: readonly BuildStep[] = [
  'preparing',
  'adding',
  'compiling',
  'verifying',
  'installing',
  'restarting',
];

/** Maps supervisor status + restarting flag to the active index in `BUILD_STEPS` (0..5). */
export function buildStepIndex(supervisor: SupervisorStatus | null, restarting: boolean): number {
  if (restarting || supervisor?.state.type === 'succeeded') return 5;
  if (!supervisor || supervisor.state.type !== 'building') return 0;
  switch (supervisor.state.phase.type) {
    case 'preparing':
    case 'clearing':
      return 0;
    case 'adding':
    case 'resync':
    case 'staging_translations':
      return 1;
    case 'building':
      return 2;
    case 'verifying':
      return 3;
    case 'installing':
      return 4;
    case 'restarting':
      return 5;
  }
}

/** Formats elapsed seconds as `m:ss` or `h:mm:ss`. */
export function formatElapsed(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = clamped % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export const LOW_QUOTA_THRESHOLD = 15;

/** True when GitHub API quota is completely exhausted and has not yet reset. */
export function isRateLimited(rateLimit: RateLimit | null, nowMs: number = Date.now()): boolean {
  return Boolean(rateLimit && rateLimit.remaining === 0 && rateLimit.reset * 1000 > nowMs);
}

/** True when GitHub API quota is low (< 15 remaining) and has not yet reset. */
export function isQuotaLow(rateLimit: RateLimit | null, nowMs: number = Date.now()): boolean {
  return Boolean(rateLimit && rateLimit.remaining < LOW_QUOTA_THRESHOLD && rateLimit.reset * 1000 > nowMs);
}
