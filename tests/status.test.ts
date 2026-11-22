import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Entry, Release, Run, SupervisorStatus } from '../frontend/src/lib/types.ts';
import {
  activeBuildId,
  bannerDismissKey,
  canInstall,
  entryBadges,
  installableEntries,
  isBuilding,
  lastFinishedRun,
  packagesOf,
  retryPackages,
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

describe('badges', () => {
  const kinds = (e: Entry) => entryBadges(e).map((b) => b.kind);

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

describe('banner dismissal', () => {
  const a = { package_name: 'dev.caloptreyx.a', name: 'A', from: '1.0.0', to: '1.1.0' };
  const b = { package_name: 'dev.caloptreyx.b', name: 'B', from: '2.0.0', to: '2.1.0' };

  test('the key does not depend on order or duplicates', () => {
    assert.equal(bannerDismissKey([a, b]), bannerDismissKey([b, a]));
    assert.equal(bannerDismissKey([a, b, a]), bannerDismissKey([a, b]));
    assert.equal(
      bannerDismissKey([a, b]),
      'dev.caloptreyx.updater:banner:dev.caloptreyx.a@1.1.0,dev.caloptreyx.b@2.1.0',
    );
  });

  test('a new version gives a new key', () => {
    assert.notEqual(bannerDismissKey([a]), bannerDismissKey([{ ...a, to: '1.2.0' }]));
    assert.notEqual(bannerDismissKey([a]), bannerDismissKey([a, b]));
  });
});

describe('runs and builds', () => {
  test('building', () => {
    assert.ok(!isBuilding({ runs: [], supervisor: null }));
    assert.ok(!isBuilding({ runs: [run()], supervisor: supervisor({ type: 'idle' }) }));
    assert.ok(isBuilding({ runs: [run({ state: 'building' })], supervisor: null }));
    assert.ok(isBuilding({ runs: [], supervisor: supervisor({ type: 'queued' }) }));
    assert.ok(isBuilding({ runs: [], supervisor: supervisor({ type: 'building', phase: { type: 'verifying' } }) }));
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
