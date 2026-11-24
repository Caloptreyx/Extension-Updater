import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Entry, RateLimit, Release, Run, SupervisorStatus } from '../frontend/src/lib/types.ts';
import {
  activeBuildId,
  bannerDismissKey,
  buildStepIndex,
  canForceInstall,
  canInstall,
  entryBadges,
  failedAutoDismissKey,
  filterAvailableEntries,
  filterInstalledEntries,
  formatElapsed,
  heldBack,
  installableEntries,
  isBuilding,
  isLatestSkipped,
  isQuotaLow,
  isRateLimited,
  isSelectable,
  lastFinishedRun,
  matchesSearch,
  offered,
  packagesOf,
  retryPackages,
  runResultDismissKey,
  selectedEntries,
  updatableEntries,
} from '../frontend/src/lib/status.ts';

const release = (version: string, patch: Partial<Release> = {}): Release => ({
  tag: `v${version}`,
  version,
  name: null,
  published_at: null,
  html_url: `https://github.com/Caloptreyx/x/releases/tag/v${version}`,
  body: '',
  prerelease: false,
  panel_version: '>=1.2.10',
  license: null,
  verified: true,
  asset: { name: 'x.c7s.zip', size: 1, download_url: 'https://github.com/Caloptreyx/x/releases/download/x.c7s.zip' },
  ...patch,
});

const entry = (name: string, patch: Partial<Entry> = {}): Entry => ({
  package_name: `dev.caloptreyx.${name}`,
  name,
  description: null,
  repo: name,
  repo_url: `https://github.com/Caloptreyx/${name}`,
  archived: false,
  installed: { version: '1.0.0', disabled: false },
  status: 'update_available',
  latest: release('1.1.0'),
  needs_panel: null,
  notes: [],
  rollback: null,
  is_self: false,
  updates_enabled: true,
  skipped_version: null,
  ...patch,
});

const run = (patch: Partial<Run> = {}): Run => ({
  id: 1,
  user_uuid: null,
  automatic: false,
  kind: 'update',
  items: [{ package_name: 'dev.caloptreyx.a', name: 'a', from: '1.0.0', to: '1.1.0', tag: 'v1.1.0' }],
  build_id: 7,
  after_build_id: null,
  state: 'failed',
  message: null,
  failed_extensions: [],
  created: '2026-11-22T00:00:00Z',
  finished: null,
  ...patch,
});

const supervisor = (state: SupervisorStatus['state'], buildId: number | null = 3): SupervisorStatus => ({
  state,
  panel_version: '1.2.10',
  cache_key: '',
  bin_name: '',
  build_id: buildId,
  started_at: null,
  finished_at: null,
  exit_code: null,
  failure_reason: null,
  failed_extensions: [],
  log_len: 0,
});

describe('update all', () => {
  const entries = [
    entry('plain'),
    entry('licensed', { latest: release('2.0.0', { license: 'MIT-ish terms' }) }),
    entry('unverified', { latest: release('1.1.0', { verified: false }) }),
    entry('noasset', { latest: release('1.1.0', { asset: null }) }),
    entry('needspanel', {
      status: 'needs_panel',
      latest: null,
      needs_panel: release('3.0.0', { panel_version: '>=1.3.0' }),
    }),
    entry('current', { status: 'up_to_date', latest: release('1.0.0') }),
    entry('new', { installed: null, status: 'installable' }),
    entry('archived', { installed: null, status: 'installable', archived: true }),
  ];

  test('selects verified updates of installed extensions, license ones included', () => {
    assert.deepEqual(
      updatableEntries(entries).map((e) => e.name),
      ['plain', 'licensed'],
    );
  });

  test('sends one package list with the offered versions', () => {
    assert.deepEqual(packagesOf(updatableEntries(entries)), [
      { package_name: 'dev.caloptreyx.plain', version: '1.1.0' },
      { package_name: 'dev.caloptreyx.licensed', version: '2.0.0' },
    ]);
  });

  test('install is offered for new, non-archived extensions only', () => {
    assert.deepEqual(
      installableEntries(entries).map((e) => e.name),
      ['new'],
    );
    assert.ok(canInstall(entries[6]));
    assert.ok(!canInstall(entries[7]));
    assert.ok(!canInstall(entries[2]));
    assert.ok(!canInstall(entries[4]));
    assert.ok(!canInstall(entries[5]));
  });
});

const kinds = (e: Entry) => entryBadges(e).map((b) => b.kind);

describe('updates off and skipped versions', () => {
  const off = entry('off', { updates_enabled: false });
  const skipped = entry('skipped', { skipped_version: '1.1.0' });
  const newerThanSkipped = entry('newer', { skipped_version: '1.0.5', latest: release('1.1.0') });
  const entries = [
    entry('on'),
    off,
    skipped,
    newerThanSkipped,
    entry('offlicensed', { updates_enabled: false, latest: release('2.0.0', { license: 'x' }) }),
  ];

  test('update all skips paused and skipped releases, but surfaces newer releases', () => {
    assert.deepEqual(
      updatableEntries(entries).map((e) => e.name),
      ['on', 'newer'],
    );
    assert.deepEqual(packagesOf(updatableEntries(entries)), [
      { package_name: 'dev.caloptreyx.on', version: '1.1.0' },
      { package_name: 'dev.caloptreyx.newer', version: '1.1.0' },
    ]);
  });

  test('no normal Update button for paused or skipped, but Install anyway is allowed when verified', () => {
    assert.ok(!canInstall(off));
    assert.ok(!canInstall(skipped));
    assert.ok(canInstall(newerThanSkipped));
    assert.ok(canForceInstall(off));
    assert.ok(canForceInstall(skipped));
    assert.ok(!canForceInstall(entry('on')));
    assert.ok(!canForceInstall(entry('unverifiedOff', { updates_enabled: false, latest: release('1.1.0', { verified: false }) })));
    assert.ok(isLatestSkipped(skipped));
    assert.ok(!isLatestSkipped(newerThanSkipped));
    assert.equal(heldBack(off)?.version, '1.1.0');
    assert.equal(heldBack(skipped)?.version, '1.1.0');
    assert.equal(heldBack(entry('on')), null);
    assert.equal(offered(off), null);
    assert.equal(offered(skipped), null);
  });

  test('badges reflect paused and skipped states clearly', () => {
    assert.deepEqual(kinds(off), ['updates_off']);
    assert.deepEqual(kinds(skipped), ['skipped']);
    assert.deepEqual(kinds(newerThanSkipped), ['update_available']);
    assert.deepEqual(kinds(entry('both', { updates_enabled: false, skipped_version: '1.1.0' })), [
      'updates_off',
      'skipped',
    ]);
    assert.deepEqual(kinds(entry('a', { status: 'up_to_date', updates_enabled: false })), ['up_to_date', 'updates_off']);
  });
});

describe('badges', () => {
  test('status first, then limits', () => {
    assert.deepEqual(kinds(entry('a')), ['update_available']);
    assert.deepEqual(kinds(entry('a', { latest: release('1.1.0', { verified: false }) })), ['unverified']);
    assert.deepEqual(kinds(entry('a', { latest: release('1.1.0', { license: 'x' }) })), [
      'update_available',
      'license',
    ]);
    assert.deepEqual(kinds(entry('a', { status: 'up_to_date', needs_panel: release('2.0.0') })), [
      'up_to_date',
      'needs_panel',
    ]);
    assert.deepEqual(kinds(entry('a', { status: 'needs_panel', latest: null, needs_panel: release('2.0.0') })), [
      'needs_panel',
    ]);
    assert.deepEqual(kinds(entry('a', { status: 'no_release', latest: null })), ['no_release']);
    assert.deepEqual(kinds(entry('a', { status: 'unpublished', latest: null })), ['unpublished']);
    assert.deepEqual(kinds(entry('a', { status: 'up_to_date', installed: { version: '1.1.0', disabled: true } })), [
      'up_to_date',
      'disabled',
    ]);
  });
});

describe('filtering, search and cross-tab batch selection', () => {
  const list = [
    entry('Webhooks', { description: 'Discord webhook notifications' }),
    entry('World Map', { status: 'up_to_date', latest: release('1.0.0'), description: 'Live interactive map' }),
    entry('Paused', { updates_enabled: false }),
    entry('Skipped', { skipped_version: '1.1.0' }),
    entry('Future', { status: 'needs_panel', latest: null, needs_panel: release('2.0.0') }),
    entry('Hytale Auth', {
      installed: null,
      status: 'installable',
      description: 'Authenticate Hytale accounts',
    }),
  ];

  test('matchesSearch checks name, package_name, description, and repo', () => {
    assert.ok(matchesSearch(list[0], 'discord'));
    assert.ok(matchesSearch(list[5], 'hytale'));
    assert.ok(matchesSearch(list[1], 'world'));
    assert.ok(!matchesSearch(list[0], 'minecraft'));
  });

  test('filterInstalledEntries supports all filter buckets and search', () => {
    assert.equal(filterInstalledEntries(list, 'all', '').length, 5);
    assert.deepEqual(
      filterInstalledEntries(list, 'updates', '').map((e) => e.name),
      ['Webhooks'],
    );
    assert.deepEqual(
      filterInstalledEntries(list, 'paused_skipped', '').map((e) => e.name),
      ['Paused', 'Skipped'],
    );
    assert.deepEqual(
      filterInstalledEntries(list, 'needs_panel', '').map((e) => e.name),
      ['Future'],
    );
    assert.deepEqual(
      filterInstalledEntries(list, 'all', 'map').map((e) => e.name),
      ['World Map'],
    );
  });

  test('filterAvailableEntries filters installable extensions by search', () => {
    assert.deepEqual(
      filterAvailableEntries(list, '').map((e) => e.name),
      ['Hytale Auth'],
    );
    assert.deepEqual(
      filterAvailableEntries(list, 'authenticate').map((e) => e.name),
      ['Hytale Auth'],
    );
    assert.deepEqual(filterAvailableEntries(list, 'nonexistent'), []);
  });

  test('selectedEntries spans installed and available tabs and ignores non-selectable items', () => {
    assert.ok(isSelectable(list[0]));
    assert.ok(!isSelectable(list[1]));
    assert.ok(!isSelectable(list[2]));
    assert.ok(isSelectable(list[5]));

    const picked = new Set([
      list[0].package_name,
      list[1].package_name,
      list[2].package_name,
      list[5].package_name,
    ]);
    assert.deepEqual(
      selectedEntries(list, picked).map((e) => e.name),
      ['Webhooks', 'Hytale Auth'],
    );
  });
});

describe('dismissal keys', () => {
  const a = { package_name: 'dev.caloptreyx.a', name: 'A', from: '1.0.0', to: '1.1.0' };
  const b = { package_name: 'dev.caloptreyx.b', name: 'B', from: '2.0.0', to: '2.1.0' };

  test('banner key does not depend on order or duplicates', () => {
    assert.equal(bannerDismissKey([a, b]), bannerDismissKey([b, a]));
    assert.equal(bannerDismissKey([a, b, a]), bannerDismissKey([a, b]));
    assert.equal(
      bannerDismissKey([a, b]),
      'dev.caloptreyx.updater:banner:dev.caloptreyx.a@1.1.0,dev.caloptreyx.b@2.1.0',
    );
  });

  test('a new version gives a new banner key', () => {
    assert.notEqual(bannerDismissKey([a]), bannerDismissKey([{ ...a, to: '1.2.0' }]));
    assert.notEqual(bannerDismissKey([a]), bannerDismissKey([a, b]));
  });

  test('failed auto and run result dismiss keys are keyed by run id', () => {
    assert.equal(failedAutoDismissKey(42), 'dev.caloptreyx.updater:failed-auto:42');
    assert.equal(runResultDismissKey(42), 'dev.caloptreyx.updater:run-result:42');
    assert.notEqual(runResultDismissKey(42), runResultDismissKey(43));
  });
});

describe('runs, builds and quota', () => {
  test('building', () => {
    assert.ok(!isBuilding({ runs: [], supervisor: null }));
    assert.ok(!isBuilding({ runs: [run()], supervisor: supervisor({ type: 'idle' }) }));
    assert.ok(isBuilding({ runs: [run({ state: 'building' })], supervisor: null }));
    assert.ok(isBuilding({ runs: [], supervisor: supervisor({ type: 'queued' }) }));
    assert.ok(isBuilding({ runs: [], supervisor: supervisor({ type: 'building', phase: { type: 'verifying' } }) }));
  });

  test('buildStepIndex maps supervisor phases to step indices', () => {
    assert.equal(buildStepIndex(null, false), 0);
    assert.equal(buildStepIndex(supervisor({ type: 'queued' }), false), 0);
    assert.equal(buildStepIndex(supervisor({ type: 'building', phase: { type: 'adding', done: 1, total: 2 } }), false), 1);
    assert.equal(buildStepIndex(supervisor({ type: 'building', phase: { type: 'building' } }), false), 2);
    assert.equal(buildStepIndex(supervisor({ type: 'building', phase: { type: 'verifying' } }), false), 3);
    assert.equal(buildStepIndex(supervisor({ type: 'building', phase: { type: 'installing' } }), false), 4);
    assert.equal(buildStepIndex(supervisor({ type: 'succeeded' }), false), 5);
    assert.equal(buildStepIndex(null, true), 5);
  });

  test('formatElapsed formats seconds cleanly', () => {
    assert.equal(formatElapsed(0), '0:00');
    assert.equal(formatElapsed(5), '0:05');
    assert.equal(formatElapsed(83), '1:23');
    assert.equal(formatElapsed(3725), '1:02:05');
    assert.equal(formatElapsed(-10), '0:00');
  });

  test('quota helpers detect exhausted and low quota', () => {
    const future = Math.floor(Date.now() / 1000) + 600;
    const past = Math.floor(Date.now() / 1000) - 60;
    const ok: RateLimit = { limit: 60, remaining: 50, reset: future, authenticated: false };
    const low: RateLimit = { limit: 60, remaining: 10, reset: future, authenticated: false };
    const zero: RateLimit = { limit: 60, remaining: 0, reset: future, authenticated: false };
    const expired: RateLimit = { limit: 60, remaining: 0, reset: past, authenticated: false };

    assert.ok(!isRateLimited(ok) && !isQuotaLow(ok));
    assert.ok(!isRateLimited(low) && isQuotaLow(low));
    assert.ok(isRateLimited(zero) && isQuotaLow(zero));
    assert.ok(!isRateLimited(expired) && !isQuotaLow(expired));
  });

  test('the build log of the running run, else the supervisor build', () => {
    assert.equal(
      activeBuildId({ runs: [run({ state: 'building', build_id: 9 })], supervisor: supervisor({ type: 'queued' }) }),
      9,
    );
    assert.equal(activeBuildId({ runs: [], supervisor: supervisor({ type: 'queued' }, 4) }), 4);
    assert.equal(activeBuildId({ runs: [], supervisor: null }), null);
  });

  test('only the newest run, once finished', () => {
    assert.equal(lastFinishedRun([]), null);
    assert.equal(lastFinishedRun([run({ state: 'building' }), run({ id: 0 })]), null);
    assert.equal(lastFinishedRun([run({ id: 5, state: 'succeeded' }), run()])?.id, 5);
  });

  test('retry sends the same packages', () => {
    assert.deepEqual(retryPackages(run()), [{ package_name: 'dev.caloptreyx.a', version: '1.1.0' }]);
  });
});
