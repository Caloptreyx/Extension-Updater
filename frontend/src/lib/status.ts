import type { Entry, Overview, PackageVersion, Run, SummaryUpdate } from './types.ts';

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
  | 'updates_off';

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
};

const badge = (kind: BadgeKind): StatusBadge => ({ kind, color: COLORS[kind] });

/** A newer release exists for this panel: installable when updates are on. */
const hasNewer = (entry: Entry) => entry.status === 'update_available' || entry.status === 'installable';

/** The release an Update or Install button would install; none while the entry's updates are off. */
export const offered = (entry: Entry) => (entry.updates_enabled && hasNewer(entry) ? entry.latest : null);

/** The newer release an entry has while its updates are off: shown as information, not offered. */
export const heldBack = (entry: Entry) => (!entry.updates_enabled && hasNewer(entry) ? entry.latest : null);

/** The badges of an entry: its status first, then what else limits it. */
export function entryBadges(entry: Entry): StatusBadge[] {
  const badges: StatusBadge[] = [];
  const release = offered(entry);

  if (heldBack(entry)) {
    badges.push(badge('updates_off'));
  } else if (release && !release.verified) {
    badges.push(badge('unverified'));
  } else if (entry.status === 'needs_panel') {
    badges.push(badge('needs_panel'));
  } else {
    badges.push(badge(entry.status));
  }

  if (!entry.updates_enabled && badges[0].kind !== 'updates_off') badges.push(badge('updates_off'));
  if (entry.status !== 'needs_panel' && entry.needs_panel) badges.push(badge('needs_panel'));
  if (release?.license) badges.push(badge('license'));
  if (entry.installed?.disabled) badges.push(badge('disabled'));
  if (entry.archived) badges.push(badge('archived'));

  return badges;
}

/** Whether the offered release can be installed: updates on, verified, with an archive, and not from an archived repo when new. */
export function canInstall(entry: Entry): boolean {
  const release = offered(entry);
  if (!release?.verified || !release.asset) return false;
  if (entry.status === 'installable') return !entry.installed && !entry.archived;
  return !!entry.installed;
}

/** Installed extensions "Update all" sends: not those with updates off. License ones stay in: the license modal asks for them. */
export function updatableEntries(entries: Entry[]): Entry[] {
  return entries.filter((entry) => entry.status === 'update_available' && canInstall(entry));
}

/** Not installed extensions offered for install. */
export function installableEntries(entries: Entry[]): Entry[] {
  return entries.filter((entry) => !entry.installed && entry.status === 'installable' && !entry.archived);
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
